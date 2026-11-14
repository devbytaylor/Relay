import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { test } from "node:test";
import { Pool } from "pg";
import "../../scripts/check-test-database.js";
import { createResearchDocument } from "../../src/data/canonical-data.js";
import { searchResearchChunksByKeyword } from "../../src/data/research-embeddings.js";
import {
  ASSESSMENT_CATEGORIES,
  ASSESSMENT_RETRIEVAL_LIMITS,
  retrieveAssessmentSources,
} from "../../src/research/lead-intake-assessment.js";
import { RESEARCH_EMBEDDING_MODEL } from "../../src/research/openai-embeddings.js";
import { fakeEmbedder, fakeVector } from "../helpers/assessment-fixtures.js";
import { RAFA_FAQ_REQUEST_CHUNK, RAFA_FORMS_KEYWORD_RANKING } from "../helpers/rafa-request-fixture.js";

// Rafa's Auto Repair: the forms-category keyword search matched the cost FAQ on the single words "quote" and
// "estimate" and the FAQ sentence "Send a service request through this site or call the shop directly" on the
// exact phrase "service request". ts_rank_cd alone put the cost FAQ ahead, so the sentence never reached the
// assessor. These chunks are Rafa's saved text, inserted so each one is exactly that text.
const FORMS = ASSESSMENT_CATEGORIES.find((item) => item.id === "website_forms")!;
const phraseMatch = (text: string) => /service request|request service/i.test(text);

test("Assessment retrieval: an exact phrase outranks single-word matches, and the evidence budget is unchanged", async (t) => {
  const connectionString = process.env.RELAY_DRAFT_TEST_DATABASE_URL!;
  const schema = `relay_phrase_ranking_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString });
  const database = new Pool({ connectionString, options: `-c search_path=${schema},public` });
  await admin.query(`CREATE SCHEMA ${schema}`);
  t.after(async () => {
    await database.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });
  const directory = new URL("../../migrations/", import.meta.url);
  for (const name of (await readdir(directory)).filter((file) => /^\d+.*\.sql$/.test(file)).sort())
    await database.query(await readFile(new URL(name, directory), "utf8"));

  const prospectId = randomUUID();
  const requestId = randomUUID();
  await database.query("INSERT INTO prospects (id, company_name, website) VALUES ($1,$2,$3)", [prospectId, "Rafa's Auto Repair", "https://rafasautorepair.com/"]);
  await database.query(
    `INSERT INTO prospect_research_requests (id, prospect_id, status, owner_token, input_snapshot, drive_parent_id, website_index_status)
    VALUES ($1,$2,'completed',$3,$4,'','ready')`,
    [requestId, prospectId, randomUUID(), JSON.stringify({ website: "https://rafasautorepair.com/" })],
  );
  const byPage = new Map<string, { id: string; content: string }[]>();
  for (const row of RAFA_FORMS_KEYWORD_RANKING) byPage.set(row.sourceUrl, [...(byPage.get(row.sourceUrl) ?? []), row]);
  const stored = new Map<string, string>();
  for (const [url, rows] of byPage) {
    const document = await createResearchDocument(
      { prospectId, researchRequestId: requestId, sourceUrl: url, pageType: "other", title: null, content: rows.map((row) => row.content).join("\n\n"), scrapedAt: new Date("2026-11-14T16:44:27.000Z") },
      database,
    );
    for (const [index, row] of rows.entries()) {
      const id = randomUUID();
      stored.set(id, row.content);
      await database.query(
        `INSERT INTO research_chunks (id, prospect_id, research_document_id, content, embedding, embedding_model, source_url, chunk_index)
        VALUES ($1,$2,$3,$4,$5::public.vector,$6,$7,$8)`,
        [id, prospectId, document.id, row.content, JSON.stringify(fakeVector(row.content)), RESEARCH_EMBEDDING_MODEL, url, index],
      );
    }
  }

  await t.test("chunks matching an exact phrase come before chunks matching only single words, and the rest are kept", async () => {
    const hits = await searchResearchChunksByKeyword({ prospectId, query: FORMS.keywords, limit: 20 }, database);
    const matches = hits.map((hit) => phraseMatch(hit.content));
    // Every phrase match precedes every single-word-only match.
    assert.ok(matches.includes(true) && matches.includes(false), "the fixture has both kinds");
    assert.equal(matches.lastIndexOf(true) < matches.indexOf(false), true, JSON.stringify(matches));
    const faq = hits.findIndex((hit) => hit.content === RAFA_FAQ_REQUEST_CHUNK);
    const costFaq = hits.findIndex((hit) => !phraseMatch(hit.content) && /estimate/i.test(hit.content));
    assert.ok(faq >= 0 && costFaq >= 0);
    assert.ok(faq < costFaq, "the FAQ sentence outranks the cost FAQ it used to trail");
    // Nothing that matched before is dropped: the same rows are returned as an unordered set.
    assert.equal(hits.length, new Set(hits.map((hit) => hit.id)).size);
    assert.equal(hits.length, RAFA_FORMS_KEYWORD_RANKING.length);
  });

  await t.test("a query without quoted phrases keeps its ts_rank_cd order", async () => {
    const query = "quote or estimate";
    const hits = await searchResearchChunksByKeyword({ prospectId, query, limit: 20 }, database);
    const direct = await database.query<{ id: string }>(
      `SELECT c.id FROM research_chunks c, websearch_to_tsquery('english', $2) q(query)
      WHERE c.prospect_id = $1 AND to_tsvector('english', c.content) @@ q.query
      ORDER BY ts_rank_cd(to_tsvector('english', c.content), q.query) DESC, c.source_url, c.chunk_index`,
      [prospectId, query],
    );
    assert.deepEqual(hits.map((hit) => hit.id), direct.rows.map((row) => row.id));
  });

  await t.test("the FAQ sentence reaches the assessor's final context through its keyword slot, within the same bounds", async () => {
    const embedder = fakeEmbedder();
    const sources = await retrieveAssessmentSources(prospectId, { database, embed: embedder.embed });
    const faq = sources.find((item) => item.text === RAFA_FAQ_REQUEST_CHUNK);
    assert.ok(faq, "the FAQ sentence is in the final context");
    assert.ok(faq!.via === "keyword" || faq!.via === "both", `found by ${faq!.via}`);
    // Provenance is the stored chunk and page.
    assert.equal(stored.get(faq!.chunkId), RAFA_FAQ_REQUEST_CHUNK);
    assert.equal(faq!.sourceUrl, "https://rafasautorepair.com/");
    // One embedding request for all categories; no other provider call exists on this path.
    assert.equal(embedder.calls.length, 1);
    // The repeated call to action is present once, and the total budget is unchanged.
    assert.equal(new Set(sources.map((item) => item.text)).size, sources.length);
    assert.ok(sources.length <= ASSESSMENT_RETRIEVAL_LIMITS.maxChunks);
    assert.ok(sources.reduce((total, item) => total + Buffer.byteLength(item.text), 0) <= ASSESSMENT_RETRIEVAL_LIMITS.maxBytes);
    assert.ok(sources.every((item) => stored.has(item.chunkId)), "every source is a stored chunk of this prospect");
  });
});
