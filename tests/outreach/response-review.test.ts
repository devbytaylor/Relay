import { strict as assert } from "node:assert";
import { test } from "node:test";
import { formatResponseReview, getResponseReview, parseResponseReviewArgs } from "../../src/outreach/response-review.js";

const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const args = ["--prospect", id, "--draft", id, "--request", id, "--reply", "gmail-reply"];

test("response review requires four exact identities", () => {
  assert.deepEqual(parseResponseReviewArgs(args), {
    prospectId: id, draftId: id, requestId: id, replyId: "gmail-reply",
  });
  for (const invalid of [args.slice(0, -2), [...args, "--send"],
    ["--prospect", "bad", ...args.slice(2)],
    [...args.slice(0, 7), "--send"]])
    assert.throws(() => parseResponseReviewArgs(invalid));
});

test("response review issues one SELECT and rejects missing records", async () => {
  const identity = parseResponseReviewArgs(args);
  let calls = 0;
  const database = { query: async (sql: string, values: unknown[]) => {
    calls++;
    assert.match(sql, /^SELECT /);
    assert.match(sql, /d\.draft_type = 'response'/);
    assert.match(sql, /'missing'.*\n.*'recorded' END AS "replyParentIdentityStatus"/);
    assert.deepEqual(values, [id, id, id, "gmail-reply"]);
    return { rows: [{ body: "Full body", reviewStatus: "needs_review" }] };
  } };
  assert.equal((await getResponseReview(database as never, identity)).body, "Full body");
  assert.equal(calls, 1);
  await assert.rejects(getResponseReview({ query: async () => ({ rows: [] }) } as never, identity));
});

test("response review output includes a full permitted body and signature", () => {
  const body = `${"a".repeat(10_000)} Signature`;
  assert.ok(formatResponseReview({ body }).includes(body));
  assert.match(formatResponseReview({ replyParentRfcMessageId: null, replyParentIdentityStatus: "missing" }), /replyParentIdentityStatus: 'missing'/);
});
