import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { evidenceFingerprint } from "../../src/data/lead-assessments.js";
import {
  ASSESSMENT_PIPELINE_VERSION,
  BASELINE_ASSESSMENT_PIPELINE_VERSION,
  requirePipelineVersion,
} from "../../src/research/assessment-pipeline.js";
import { FIT_RUBRIC_VERSION } from "../../src/research/fit-rubric.js";

const sha = (value: string) =>
  createHash("sha256").update(value, "utf8").digest("hex");
const REQUEST = "11111111-1111-4111-8111-111111111111";
const documents = [
  { source_url: "https://example.com/", content: "Home page" },
  { source_url: "https://example.com/about", content: "About page" },
];
const chunks = [
  {
    source_url: "https://example.com/",
    chunk_index: 0,
    content: "Home page",
    embedding_model: "text-embedding-3-small",
  },
  {
    source_url: "https://example.com/about",
    chunk_index: 0,
    content: "About page",
    embedding_model: "text-embedding-3-small",
  },
];
const input = (
  overrides: Partial<Parameters<typeof evidenceFingerprint>[0]> = {},
) => ({
  rubricVersion: FIT_RUBRIC_VERSION,
  pipelineVersion: BASELINE_ASSESSMENT_PIPELINE_VERSION,
  researchRequestId: REQUEST,
  documents,
  chunks,
  ...overrides,
});
// The fingerprint exactly as it was computed before the pipeline version existed.
const originalFormula = (rubric: string) =>
  sha(
    JSON.stringify([
      rubric,
      REQUEST,
      documents.map((row) => [row.source_url, sha(row.content)]),
      chunks.map((row) => [
        row.source_url,
        row.chunk_index,
        sha(row.content),
        row.embedding_model,
      ]),
    ]),
  );

test("the baseline pipeline version leaves every earlier fingerprint unchanged", () => {
  assert.equal(BASELINE_ASSESSMENT_PIPELINE_VERSION, 1);
  assert.equal(
    evidenceFingerprint(input()),
    originalFormula(FIT_RUBRIC_VERSION),
  );
  // Pinned literal for n8n-prospecting-fit-v5, computed with the formula before this change. If this fails,
  // the fingerprint of every saved assessment has changed and all of them would become outdated.
  assert.equal(FIT_RUBRIC_VERSION, "n8n-prospecting-fit-v5");
  assert.equal(
    evidenceFingerprint(input()),
    "9f7d7929f4c6a7f4ba07e2504673f390d3132d4ed1e7bf3e1f6c0f745a34629f",
  );
});

test("raising the pipeline version changes the fingerprint, so earlier assessments become outdated", () => {
  const baseline = evidenceFingerprint(input());
  const two = evidenceFingerprint(input({ pipelineVersion: 2 }));
  const three = evidenceFingerprint(input({ pipelineVersion: 3 }));
  assert.match(two, /^[0-9a-f]{64}$/);
  assert.notEqual(two, baseline);
  assert.notEqual(three, baseline);
  assert.notEqual(three, two);
  // Deterministic.
  assert.equal(evidenceFingerprint(input({ pipelineVersion: 2 })), two);
});

test("the pipeline version and the rubric version are separate inputs, and each changes the fingerprint", () => {
  const baseline = evidenceFingerprint(input());
  // A rubric change alone still outdates, with the pipeline untouched...
  const rubricOnly = evidenceFingerprint(
    input({ rubricVersion: `${FIT_RUBRIC_VERSION}-next` }),
  );
  assert.notEqual(rubricOnly, baseline);
  assert.equal(rubricOnly, originalFormula(`${FIT_RUBRIC_VERSION}-next`));
  // ...a pipeline change alone does not read as a rubric change...
  const pipelineOnly = evidenceFingerprint(input({ pipelineVersion: 2 }));
  assert.notEqual(pipelineOnly, rubricOnly);
  // ...and the same pair of versions cannot collide with the other pairing.
  assert.notEqual(
    evidenceFingerprint(
      input({
        rubricVersion: `${FIT_RUBRIC_VERSION}-next`,
        pipelineVersion: 2,
      }),
    ),
    pipelineOnly,
  );
  // Research changes still outdate at any pipeline version.
  assert.notEqual(
    evidenceFingerprint(
      input({
        pipelineVersion: 2,
        chunks: [...chunks, { ...chunks[0]!, chunk_index: 1, content: "More" }],
      }),
    ),
    pipelineOnly,
  );
  assert.notEqual(
    evidenceFingerprint(
      input({
        pipelineVersion: 2,
        researchRequestId: "22222222-2222-4222-8222-222222222222",
      }),
    ),
    pipelineOnly,
  );
});

test("an invalid pipeline version fails closed instead of producing a fingerprint", () => {
  for (const bad of [
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    "2",
    null,
    undefined,
  ])
    assert.throws(
      () => requirePipelineVersion(bad),
      /integer of at least 1/,
      String(bad),
    );
  assert.throws(
    () => evidenceFingerprint(input({ pipelineVersion: 0 })),
    /integer of at least 1/,
  );
  assert.equal(requirePipelineVersion(1), 1);
  assert.equal(requirePipelineVersion(7), 7);
});

test("activation guard: the shipped pipeline version is the baseline, so no saved assessment is invalidated", () => {
  // Raising ASSESSMENT_PIPELINE_VERSION marks every earlier completed assessment outdated for every
  // prospect (each stays visible as history and can be regenerated only on a person's confirmation).
  // Raise it in its own reviewed change and update this assertion with it.
  assert.equal(ASSESSMENT_PIPELINE_VERSION, 1);
  assert.equal(
    ASSESSMENT_PIPELINE_VERSION,
    BASELINE_ASSESSMENT_PIPELINE_VERSION,
  );
});
