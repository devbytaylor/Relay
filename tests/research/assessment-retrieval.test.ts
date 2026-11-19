import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { Pool } from "pg";
import {
  ASSESSMENT_CATEGORIES,
  ASSESSMENT_RETRIEVAL_LIMITS,
  distinctCandidates,
  mergeAssessmentEvidence,
  retrieveAssessmentSources,
  type AssessmentRetrievalLimits,
  type EvidenceCandidate,
} from "../../src/research/lead-intake-assessment.js";
import { searchResearchChunksByKeyword } from "../../src/data/research-embeddings.js";
import { fakeEmbedder } from "../helpers/assessment-fixtures.js";
import {
  RAFA_FAQ_REQUEST_CHUNK,
  RAFA_FAQ_REQUEST_CHUNK_ID,
  RAFA_FORMS_KEYWORD_RANKING,
} from "../helpers/rafa-request-fixture.js";

const chunk = (
  id: string,
  url: string,
  content: string,
): EvidenceCandidate => ({
  id,
  sourceUrl: `https://example.com/${url}`,
  content,
});
const limits = (
  overrides: Partial<AssessmentRetrievalLimits> = {},
): AssessmentRetrievalLimits => ({
  ...ASSESSMENT_RETRIEVAL_LIMITS,
  ...overrides,
});
const ids = (merged: { candidate: EvidenceCandidate }[]) =>
  merged.map((item) => item.candidate.id);

test("keyword matches are taken first, the vector fills the rest, and the per-category budget holds", () => {
  const vector = ["v1", "v2", "v3", "v4", "v5", "v6", "v7"].map((id, i) =>
    chunk(id, `p${i}`, `vector text ${id}`),
  );
  const keyword = ["k1", "k2", "k3"].map((id, i) =>
    chunk(id, `k${i}`, `keyword text ${id}`),
  );
  const merged = mergeAssessmentEvidence([{ vector, keyword }], limits());
  // 2 keyword slots by default, then vector up to perCategory (5) in total.
  assert.deepEqual(ids(merged), ["k1", "k2", "v1", "v2", "v3"]);
  assert.deepEqual(
    merged.map((item) => item.via),
    ["keyword", "keyword", "vector", "vector", "vector"],
  );
  // keywordSlots overrides the default for a category.
  assert.deepEqual(
    ids(
      mergeAssessmentEvidence([{ vector, keyword, keywordSlots: 3 }], limits()),
    ),
    ["k1", "k2", "k3", "v1", "v2"],
  );
  // Zero keyword slots is the vector-only behavior.
  assert.deepEqual(
    ids(
      mergeAssessmentEvidence(
        [{ vector, keyword, keywordSlots: 0 }],
        limits({ keywordPerCategory: 0 }),
      ),
    ),
    ["v1", "v2", "v3", "v4", "v5"],
  );
});

test("a chunk found by both searches is labeled both, and a chunk already chosen by another category still counts toward it", () => {
  const shared = chunk("shared", "a", "found by both searches");
  const other = chunk("other", "b", "only the vector found this");
  const merged = mergeAssessmentEvidence(
    [
      { vector: [shared, other], keyword: [shared] },
      {
        vector: [
          shared,
          chunk("x1", "c", "x one"),
          chunk("x2", "d", "x two"),
          chunk("x3", "e", "x three"),
          chunk("x4", "f", "x four"),
          chunk("x5", "g", "x five"),
        ],
        keyword: [],
      },
    ],
    limits(),
  );
  assert.equal(
    merged.filter((item) => item.candidate.id === "shared").length,
    1,
  );
  assert.equal(
    merged.find((item) => item.candidate.id === "shared")!.via,
    "both",
  );
  // The second category counted `shared` as one of its five, so it added only four more.
  assert.deepEqual(ids(merged), ["shared", "other", "x1", "x2", "x3", "x4"]);
});

test("exact duplicates and chunks contained in an earlier choice are dropped, so a site-wide widget cannot fill the budget", () => {
  const widget =
    "### How soon do you need service?\n\nUrgent / call todaySame-day if availableThis weekFlexible / planning ahead";
  const vector = [
    chunk("w1", "home", widget),
    chunk("w2", "contact", widget),
    chunk("w3", "about", `  ${widget.toUpperCase()}\n`),
    chunk("inside", "x", "Same-day if availableThis weekFlexible"),
    ...["d1", "d2", "d3", "d4"].map((id, i) =>
      chunk(id, `d${i}`, `distinct text ${id}`),
    ),
  ];
  const merged = mergeAssessmentEvidence([{ vector, keyword: [] }], limits());
  assert.deepEqual(ids(merged), ["w1", "d1", "d2", "d3", "d4"]);
  // A near-copy that only adds a little to an earlier choice is dropped too ...
  const nearCopy = mergeAssessmentEvidence(
    [
      {
        vector: [
          chunk("a", "a", "emergency repair team on duty today"),
          chunk("b", "b", "Emergency repair team on duty today!"),
        ],
        keyword: [],
      },
    ],
    limits(),
  );
  assert.deepEqual(ids(nearCopy), ["a"]);
  // ... but a larger chunk that merely contains a short earlier one (a page title) is new information and is kept.
  const grown = mergeAssessmentEvidence(
    [
      {
        vector: [
          chunk("title", "a", "Emergency HVAC Repair • Linden, NJ"),
          chunk(
            "body",
            "b",
            "Emergency HVAC Repair • Linden, NJ. When a heating or cooling system stops working at the worst time, you need a clear plan and a technician who explains each step.",
          ),
        ],
        keyword: [],
      },
    ],
    limits(),
  );
  assert.deepEqual(ids(grown), ["title", "body"]);
});

test("keyword evidence comes best-first from distinct pages, with at most two chunks per page", () => {
  const keyword = [
    chunk("e1", "emergency", "emergency page chunk one"),
    chunk("e2", "emergency", "emergency page chunk two"),
    chunk("e3", "emergency", "emergency page chunk three"),
    chunk("h1", "home", "home page emergency call to action"),
    chunk("c1", "contact", "contact page mention"),
  ];
  const merged = mergeAssessmentEvidence(
    [{ vector: [], keyword, keywordSlots: 4 }],
    limits(),
  );
  assert.deepEqual(ids(merged), ["e1", "e2", "h1", "c1"]);
  assert.equal(
    merged.filter((item) => item.candidate.sourceUrl.endsWith("/emergency"))
      .length,
    2,
  );
  assert.deepEqual(
    ids(
      mergeAssessmentEvidence(
        [{ vector: [], keyword, keywordSlots: 4 }],
        limits({ maxKeywordPerPage: 1 }),
      ),
    ),
    ["e1", "h1", "c1"],
  );
});

test("the chunk and byte budgets are hard limits, whatever the categories ask for", () => {
  const many = (prefix: string, count: number, size = 500) =>
    Array.from({ length: count }, (_, i) =>
      chunk(
        `${prefix}${i}`,
        `${prefix}${i}`,
        `${prefix} ${i} `.padEnd(size, "x"),
      ),
    );
  const categories = ASSESSMENT_CATEGORIES.map((category, index) => ({
    vector: many(`${category.id}-v`, 12),
    keyword: many(`${category.id}-k`, 6),
    keywordSlots: index === 3 ? 3 : 2,
  }));
  const capped = mergeAssessmentEvidence(categories, limits({ maxChunks: 11 }));
  assert.equal(capped.length, 11);
  const bytes = (merged: { candidate: EvidenceCandidate }[]) =>
    merged.reduce(
      (total, item) => total + Buffer.byteLength(item.candidate.content),
      0,
    );
  const tight = mergeAssessmentEvidence(
    categories,
    limits({ maxBytes: 2_600 }),
  );
  assert.ok(
    bytes(tight) <= 2_600 && tight.length === 5,
    `${tight.length} chunks, ${bytes(tight)} bytes`,
  );
  // The defaults hold the assessment to the same ceiling as before: 6 categories x 5.
  const normal = mergeAssessmentEvidence(categories, limits());
  assert.ok(normal.length <= ASSESSMENT_RETRIEVAL_LIMITS.maxChunks);
  assert.ok(bytes(normal) <= ASSESSMENT_RETRIEVAL_LIMITS.maxBytes);
  assert.equal(normal.length, 30);
  assert.equal(
    ASSESSMENT_RETRIEVAL_LIMITS.perCategory * ASSESSMENT_CATEGORIES.length,
    30,
  );
});

test("every category has bounded, fixed keyword terms, with extra slots only where the exact words carry the signal", () => {
  for (const category of ASSESSMENT_CATEGORIES) {
    assert.ok(
      category.keywords.length > 10 && category.keywords.length < 200,
      category.id,
    );
    assert.doesNotMatch(category.keywords, /[;()\\]/, category.id);
  }
  assert.deepEqual(
    ASSESSMENT_CATEGORIES.filter(
      (category) => category.keywordSlots !== undefined,
    ).map((category) => [category.id, category.keywordSlots]),
    [["after_hours", 3]],
  );
  assert.match(
    ASSESSMENT_CATEGORIES.find((category) => category.id === "after_hours")!
      .keywords,
    /emergency/,
  );
});

test("categories share a tight budget fairly: multibyte text cannot let the first categories take it all", () => {
  // 1,200 three-byte characters is 3,600 bytes, so a 36,000-byte budget holds only ten of these.
  const big = (id: string, url: string) =>
    chunk(id, url, `${id} `.padEnd(1_200, "語"));
  const categories = ASSESSMENT_CATEGORIES.map((category) => ({
    vector: Array.from({ length: 10 }, (_, i) =>
      big(`${category.id}-v${i}`, `${category.id}${i}`),
    ),
    keyword: [],
  }));
  const merged = mergeAssessmentEvidence(categories, limits());
  const bytes = merged.reduce(
    (total, item) => total + Buffer.byteLength(item.candidate.content),
    0,
  );
  assert.ok(bytes <= ASSESSMENT_RETRIEVAL_LIMITS.maxBytes);
  const perCategory = ASSESSMENT_CATEGORIES.map(
    (category) =>
      merged.filter((item) => item.candidate.id.startsWith(`${category.id}-`))
        .length,
  );
  assert.ok(
    perCategory.every((count) => count >= 1),
    `chunks per category: ${perCategory.join(", ")}`,
  );
  assert.ok(
    Math.max(...perCategory) - Math.min(...perCategory) <= 1,
    `chunks per category: ${perCategory.join(", ")}`,
  );
  // Keyword picks are shared fairly too.
  const withKeywords = ASSESSMENT_CATEGORIES.map((category) => ({
    vector: [],
    keyword: Array.from({ length: 6 }, (_, i) =>
      big(`${category.id}-k${i}`, `${category.id}k${i}`),
    ),
  }));
  const keywordMerge = mergeAssessmentEvidence(withKeywords, limits());
  const keywordCounts = ASSESSMENT_CATEGORIES.map(
    (category) =>
      keywordMerge.filter((item) =>
        item.candidate.id.startsWith(`${category.id}-`),
      ).length,
  );
  assert.ok(
    keywordCounts.every((count) => count >= 1),
    keywordCounts.join(", "),
  );
});

test("a chunk found by both searches uses one slot in its category, not two", () => {
  const both = chunk("both", "a", "found by both searches");
  const merged = mergeAssessmentEvidence(
    [
      {
        vector: [
          both,
          ...["v1", "v2", "v3", "v4", "v5"].map((id) =>
            chunk(id, id, `vector ${id}`),
          ),
        ],
        keyword: [both],
      },
    ],
    limits(),
  );
  assert.deepEqual(ids(merged), ["both", "v1", "v2", "v3", "v4"]);
  assert.equal(merged[0]!.via, "both");
  // via reflects the searches that found the chunk for the categories that picked it.
  assert.deepEqual(
    merged.slice(1).map((item) => item.via),
    ["vector", "vector", "vector", "vector"],
  );
});

// Rafa's Auto Repair: the forms-category keyword search ranked the FAQ sentence "Send a service request through
// this site or call the shop directly" 7th, behind five chunks of which four are the same call to action
// repeated on four pages. The candidate window is 6 (2 keyword slots x 3).
const FORMS_WINDOW = 6;
const FAQ_ID = RAFA_FAQ_REQUEST_CHUNK_ID;
const rankedIds = RAFA_FORMS_KEYWORD_RANKING.map((row) => row.id);

test("repeated site-wide copy no longer crowds a distinct relevant passage out of the candidate window", () => {
  // The fixture is the real ranking: the FAQ chunk is 7th, and four of the first five are identical text.
  assert.equal(rankedIds.indexOf(FAQ_ID), 6);
  const first = RAFA_FORMS_KEYWORD_RANKING.slice(1, 5);
  assert.equal(new Set(first.map((row) => row.content)).size, 1);
  assert.deepEqual(
    first.map((row) => new URL(row.sourceUrl).pathname),
    [
      "/about",
      "/honda-acura-repair-santa-fe",
      "/subaru-repair-santa-fe",
      "/toyota-repair-santa-fe",
    ],
  );

  // Before: the first six rows, so the FAQ passage never became a candidate.
  assert.ok(!rankedIds.slice(0, FORMS_WINDOW).includes(FAQ_ID));

  // After: the same ranking with exact repeats removed, cut to the same window. Eight rows hold five distinct
  // passages, and the FAQ chunk is now the fourth candidate.
  const window = distinctCandidates(RAFA_FORMS_KEYWORD_RANKING, FORMS_WINDOW);
  assert.deepEqual(
    window.map((row) => row.id),
    [rankedIds[0], rankedIds[1], rankedIds[5], FAQ_ID, rankedIds[7]],
  );
  assert.equal(new Set(window.map((row) => row.content)).size, window.length);
  // Deterministic: the same input gives the same window, and the first occurrence of the repeated text
  // (best rank, then page order: /about) stays with its own page and chunk identity.
  assert.deepEqual(
    distinctCandidates(RAFA_FORMS_KEYWORD_RANKING, FORMS_WINDOW),
    window,
  );
  assert.equal(window[1]!.sourceUrl, "https://rafasautorepair.com/about");
});

test("the deduplicated window lets the merge reach the FAQ chunk, which the old window could not", () => {
  const limits = {
    ...ASSESSMENT_RETRIEVAL_LIMITS,
    keywordPerCategory: 5,
    maxKeywordPerPage: 5,
  };
  const pick = (keyword: EvidenceCandidate[]) =>
    mergeAssessmentEvidence(
      [{ vector: [], keyword, keywordSlots: 5 }],
      limits,
    ).map((item) => item.candidate.id);
  assert.ok(
    !pick(RAFA_FORMS_KEYWORD_RANKING.slice(0, FORMS_WINDOW)).includes(FAQ_ID),
  );
  assert.ok(
    pick(distinctCandidates(RAFA_FORMS_KEYWORD_RANKING, FORMS_WINDOW)).includes(
      FAQ_ID,
    ),
  );
});

test("distinctCandidates drops only exact repeats and never exceeds its limit", () => {
  const row = (id: string, content: string): EvidenceCandidate => ({
    id,
    sourceUrl: `https://example.com/${id}`,
    content,
  });
  const rows = [
    row("a", "Request Service"),
    row("b", "  request   SERVICE\n"),
    row("c", "Request Service today"),
    row("d", "\u00a0 "),
    row("e", "Call us"),
    row("f", "Call us"),
    row("g", "Another passage"),
  ];
  // Whitespace and case differences are repeats; a longer text containing the same words is not.
  assert.deepEqual(
    distinctCandidates(rows, 10).map((item) => item.id),
    ["a", "c", "e", "g"],
  );
  assert.deepEqual(
    distinctCandidates(rows, 2).map((item) => item.id),
    ["a", "c"],
  );
  assert.deepEqual(distinctCandidates([], 5), []);
  assert.deepEqual(distinctCandidates(rows, 0), []);
});

// A database that answers the two retrieval queries from fixed rows, honouring SQL LIMIT, and records them.
function fakeDatabase() {
  const keywordQueries: { query: string; limit: number }[] = [];
  const vectorLimits: number[] = [];
  const toRow = (
    row: (typeof RAFA_FORMS_KEYWORD_RANKING)[number],
    index: number,
  ) => ({
    id: row.id,
    research_document_id: `doc-${new URL(row.sourceUrl).pathname}`,
    source_url: row.sourceUrl,
    chunk_index: index,
    content: row.content,
    rank: 1 - index / 100,
    distance: index / 100,
  });
  const database = {
    query: async (sql: string, params: unknown[]) => {
      if (sql.includes("websearch_to_tsquery")) {
        const [, query, , limit] = params as [string, string, string, number];
        keywordQueries.push({ query, limit });
        // Only the forms query matches anything in this fixture.
        return {
          rows: query.startsWith("form or quote")
            ? RAFA_FORMS_KEYWORD_RANKING.map(toRow).slice(0, limit)
            : [],
        };
      }
      vectorLimits.push((params as unknown[])[3] as number);
      return { rows: [] };
    },
  } as unknown as Pool;
  return { database, keywordQueries, vectorLimits };
}
const PROSPECT = "aafb94ca-80bc-4e5f-9932-eeb8e61188f0";

test("retrieval reads the full candidate window, dedupes it, and keeps the evidence budget", async () => {
  const { database, keywordQueries, vectorLimits } = fakeDatabase();
  const embedder = fakeEmbedder();
  const sources = await retrieveAssessmentSources(PROSPECT, {
    database,
    embed: embedder.embed,
  });

  // One embedding request for all categories, as before: no additional paid calls.
  assert.equal(embedder.calls.length, 1);
  assert.equal(embedder.calls[0]!.length, ASSESSMENT_CATEGORIES.length);
  // One keyword and one vector search per category, each reading at most the search maximum (20) rows.
  assert.equal(keywordQueries.length, ASSESSMENT_CATEGORIES.length);
  assert.equal(vectorLimits.length, ASSESSMENT_CATEGORIES.length);
  assert.ok(keywordQueries.every((item) => item.limit === 20));
  assert.ok(vectorLimits.every((limit) => limit === 20));

  // The repeated call to action reaches the model once, with its first page and chunk identity.
  const cta = RAFA_FORMS_KEYWORD_RANKING[1]!;
  const sameText = sources.filter((item) => item.text === cta.content);
  assert.equal(sameText.length, 1);
  assert.equal(sameText[0]!.chunkId, cta.id);
  assert.equal(sameText[0]!.sourceUrl, cta.sourceUrl);
  assert.equal(new Set(sources.map((item) => item.text)).size, sources.length);
  // Context limits are unchanged and still hard limits.
  assert.ok(sources.length <= ASSESSMENT_RETRIEVAL_LIMITS.maxChunks);
  assert.ok(
    sources.reduce((total, item) => total + Buffer.byteLength(item.text), 0) <=
      ASSESSMENT_RETRIEVAL_LIMITS.maxBytes,
  );
  // Default keyword slots (2) are unchanged: the forms category still takes its two best distinct passages.
  assert.deepEqual(
    sources.map((item) => item.chunkId),
    [rankedIds[0], rankedIds[1]],
  );
});

test("the keyword search ranks chunks matching an exact phrase ahead of chunks matching only single words", async () => {
  const calls: { sql: string; params: unknown[] }[] = [];
  const database = {
    query: async (sql: string, params: unknown[]) => (
      calls.push({ sql, params }),
      { rows: [] }
    ),
  } as unknown as Pool;
  const forms = ASSESSMENT_CATEGORIES.find(
    (item) => item.id === "website_forms",
  )!;
  await searchResearchChunksByKeyword(
    { prospectId: PROSPECT, query: forms.keywords, limit: 20 },
    database,
  );
  const [call] = calls;
  // Phrase matches sort first, then ts_rank_cd, then page and chunk order: all deterministic.
  assert.match(
    call!.sql,
    /ORDER BY \(to_tsvector\('english', c\.content\) @@ p\.query\) DESC, rank DESC, c\.source_url, c\.chunk_index/,
  );
  // The priority query is exactly the category's quoted phrases, never the single words.
  assert.equal(call!.params[1], forms.keywords);
  assert.equal(call!.params[4], '"request service" or "service request"');
  assert.equal(call!.params[3], 20);

  // Every category's priority query is made only of its own quoted phrases, or is the whole query when it has none.
  for (const category of ASSESSMENT_CATEGORIES) {
    calls.length = 0;
    await searchResearchChunksByKeyword(
      { prospectId: PROSPECT, query: category.keywords, limit: 3 },
      database,
    );
    const quoted = category.keywords.match(/"[^"]+"/g);
    assert.equal(
      calls[0]!.params[4],
      quoted ? quoted.join(" or ") : category.keywords,
      category.id,
    );
  }
  // No phrases: the priority query is the query itself, so ordering reduces to ts_rank_cd alone.
  calls.length = 0;
  await searchResearchChunksByKeyword(
    { prospectId: PROSPECT, query: "emergency or weekend", limit: 3 },
    database,
  );
  assert.equal(calls[0]!.params[4], "emergency or weekend");
});
