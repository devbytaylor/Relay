import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { test } from "node:test";
import { Pool } from "pg";
import { getResponseReview } from "../../src/outreach/response-review.js";

test("response foundation migrates existing drafts and creation requests without changing identity", {
  skip: !process.env.RELAY_DRAFT_TEST_DATABASE_URL,
}, async (t) => {
  const connectionString = process.env.RELAY_DRAFT_TEST_DATABASE_URL!;
  const schema = `response_migration_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString });
  const database = new Pool({ connectionString, options: `-c search_path=${schema}` });
  await admin.query(`CREATE SCHEMA ${schema}`);
  t.after(async () => {
    await database.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });
  const directory = new URL("../../migrations/", import.meta.url);
  const files = (await readdir(directory)).filter((file) => file.endsWith(".sql")).sort();
  for (const file of files.filter((file) => file < "019_response_review_foundation.sql"))
    await database.query(await readFile(new URL(file, directory), "utf8"));

  const prospectId = randomUUID();
  const requestId = randomUUID();
  await database.query("INSERT INTO prospects (id,company_name,contact_email,stage) VALUES ($1,'Existing','person@example.com','replied')", [prospectId]);
  await database.query("INSERT INTO prospect_replies (prospect_id,gmail_message_id,gmail_thread_id,received_at,sender,subject,snippet) VALUES ($1,'reply','thread',now(),'person@example.com','Re: Hello','snippet')", [prospectId]);
  await database.query("INSERT INTO reply_processing_requests (id,prospect_id,source_reply_message_id,status,gmail_draft_id,gmail_thread_id) VALUES ($1,$2,'reply','created','gmail-draft','thread')", [requestId, prospectId]);
  await database.query("INSERT INTO message_drafts (id,prospect_id,draft_type,recipient_email,subject,body,gmail_draft_id,gmail_thread_id,source_reply_message_id) VALUES ($1,$2,'response','person@example.com','Re: Hello','Original full body','gmail-draft','thread','reply')", [requestId, prospectId]);
  await database.query(await readFile(new URL("019_response_review_foundation.sql", directory), "utf8"));

  const draft = (await database.query("SELECT * FROM message_drafts WHERE id=$1", [requestId])).rows[0];
  const request = (await database.query("SELECT * FROM reply_processing_requests WHERE id=$1", [requestId])).rows[0];
  assert.equal(draft.body, "Original full body");
  assert.equal(draft.review_status, "needs_review");
  assert.equal(draft.response_parent_rfc_message_id, null);
  assert.equal(request.status, "created");
  assert.equal(request.source_reply_message_id, "reply");
  assert.equal("review_status" in request, false);
  await assert.rejects(database.query("INSERT INTO message_drafts (prospect_id,draft_type,recipient_email,subject,body,source_reply_message_id) VALUES ($1,'response','person@example.com','x','x','reply')", [prospectId]));

  const hash = "a".repeat(64);
  const snapshot = { recipientEmail: "person@example.com", body: "Approved response" };
  const review = await getResponseReview(database, { prospectId, draftId: requestId, requestId, replyId: "reply" });
  assert.equal(review.body, "Original full body");
  assert.equal(review.replyParentRfcMessageId, null);
  assert.equal(review.replyParentIdentityStatus, "missing");
  await assert.rejects(database.query("UPDATE message_drafts SET review_status='approved',response_approval_hash=$2,response_approved_snapshot=$3 WHERE id=$1", [requestId, hash, JSON.stringify(snapshot)]));
  await assert.rejects(database.query("INSERT INTO response_send_attempts (draft_id,status,approved_content_hash,approved_snapshot) VALUES ($1,'preflight',$2,$3)", [requestId, hash, JSON.stringify(snapshot)]));
  assert.equal((await database.query("SELECT response_parent_rfc_message_id FROM message_drafts WHERE id=$1", [requestId])).rows[0].response_parent_rfc_message_id, null);
  assert.equal((await database.query("SELECT count(*) FROM response_send_attempts WHERE draft_id=$1", [requestId])).rows[0].count, "0");

  const currentDraft = async () => {
    const id = randomUUID();
    const draftId = randomUUID();
    const replyId = `reply-${draftId}`;
    await database.query("INSERT INTO prospects (id,company_name,contact_email,stage) VALUES ($1,'Current','person@example.com','replied')", [id]);
    await database.query("INSERT INTO prospect_replies (prospect_id,gmail_message_id,gmail_thread_id,received_at,sender,subject,snippet) VALUES ($1,$2,'thread',now(),'person@example.com','Re: Hello','snippet')", [id, replyId]);
    await database.query("INSERT INTO reply_processing_requests (id,prospect_id,source_reply_message_id,status,gmail_draft_id,gmail_thread_id) VALUES ($1,$2,$3,'created',$4,'thread')", [draftId, id, replyId, `gmail-${draftId}`]);
    await database.query("INSERT INTO message_drafts (id,prospect_id,draft_type,recipient_email,subject,body,gmail_draft_id,gmail_thread_id,source_reply_message_id,response_parent_rfc_message_id) VALUES ($1,$2,'response','person@example.com','Re: Hello','Full body',$3,'thread',$4,$5)", [draftId, id, `gmail-${draftId}`, replyId, `<${draftId}@example.com>`]);
    return draftId;
  };
  const draftId = await currentDraft();
  await assert.rejects(database.query("UPDATE message_drafts SET review_status='approved',response_approval_hash=$2,response_approved_snapshot=$3 WHERE id=$1", [draftId, hash, JSON.stringify(snapshot)]));
  await assert.rejects(database.query("INSERT INTO message_drafts (prospect_id,draft_type,recipient_email,subject,body,review_status,response_approval_hash,response_approved_snapshot,response_parent_rfc_message_id) VALUES ($1,'response','person@example.com','x','x','approved',$2,$3,'<parent@example.com>')", [prospectId, hash, JSON.stringify(snapshot)]));
  await assert.rejects(database.query("INSERT INTO response_send_attempts (draft_id,status,approved_content_hash,approved_snapshot) VALUES ($1,'preflight',$2,$3)", [draftId, hash, JSON.stringify(snapshot)]));
  await assert.rejects(database.query("UPDATE message_drafts SET send_status='sending' WHERE id=$1", [draftId]));
  await assert.rejects(database.query("UPDATE message_drafts SET send_status='needs_reconciliation' WHERE id=$1", [draftId]));
  await assert.rejects(database.query("UPDATE message_drafts SET send_status='sent',review_status='sent',sent_message_id='orphan',sent_at=now() WHERE id=$1", [draftId]));
  await assert.rejects(database.query("INSERT INTO response_send_attempts (draft_id,status,approved_content_hash,approved_snapshot,invocation_started_at) VALUES ($1,'invoking',$2,$3,now())", [draftId, hash, JSON.stringify(snapshot)]));
  assert.equal((await database.query("SELECT review_status,send_status FROM message_drafts WHERE id=$1", [draftId])).rows[0].send_status, "pending");
  assert.equal((await database.query("SELECT count(*) FROM response_send_attempts WHERE draft_id=$1", [draftId])).rows[0].count, "0");
  assert.equal((await database.query("SELECT count(*) FROM response_send_attempt_transitions WHERE draft_id=$1", [draftId])).rows[0].count, "0");

  const transitionColumns = (await database.query(`SELECT column_name FROM information_schema.columns
    WHERE table_schema=$1 AND table_name='response_send_attempt_transitions'`, [schema])).rows.map((row) => row.column_name);
  for (const column of ["draft_id", "from_status", "to_status", "changed_at", "invocation_started_at", "sent_message_id", "gmail_thread_id", "last_error"])
    assert.ok(transitionColumns.includes(column), `Missing immutable transition evidence: ${column}`);
  assert.ok((await database.query(`SELECT 1 FROM pg_trigger WHERE tgrelid='response_send_attempt_transitions'::regclass
    AND tgname='response_transition_immutable_rows' AND NOT tgisinternal`)).rowCount);
  await assert.rejects(database.query("UPDATE response_send_attempt_transitions SET to_status='sent'"));
  await assert.rejects(database.query("DELETE FROM response_send_attempt_transitions"));
  await assert.rejects(database.query("TRUNCATE response_send_attempt_transitions"));
  await assert.rejects(database.query("TRUNCATE response_send_attempts"));

  const identityGuard = (await database.query(`SELECT pg_get_functiondef('assert_response_gmail_message_id_available(text,uuid)'::regprocedure) AS definition`)).rows[0].definition;
  for (const table of ["message_drafts", "follow_up_send_attempts", "communications"])
    assert.match(identityGuard, new RegExp(table));
  for (const trigger of ["response_attempt_gmail_identity", "response_draft_gmail_identity", "response_follow_up_gmail_identity", "response_communication_gmail_identity"])
    assert.ok((await database.query("SELECT 1 FROM pg_trigger WHERE tgname=$1 AND NOT tgisinternal", [trigger])).rowCount, `Missing Gmail ID guard: ${trigger}`);

  const outboundDraftId = randomUUID();
  const followUpDraftId = randomUUID();
  await database.query(`INSERT INTO message_drafts
    (id,prospect_id,draft_type,recipient_email,subject,body,review_status,send_status,sent_message_id,sent_at)
    VALUES ($1,$2,'outreach','person@example.com','Hello','Body','sent','sent','outbound-id',now())`, [outboundDraftId, prospectId]);
  await database.query(`INSERT INTO message_drafts
    (id,prospect_id,draft_type,recipient_email,subject,body)
    VALUES ($1,$2,'follow_up','person@example.com','Hello','Body')`, [followUpDraftId, prospectId]);
  await database.query(`INSERT INTO follow_up_send_attempts
    (draft_id,status,approved_snapshot,sent_message_id)
    VALUES ($1,'needs_reconciliation','{}','partial-follow-up-id')`, [followUpDraftId]);
  await database.query(`INSERT INTO communications
    (prospect_id,direction,channel,gmail_message_id,subject,body,sent_at,status)
    VALUES ($1,'outbound','email','communication-id','Hello','Body',now(),'sent')`, [prospectId]);
  for (const reusedId of ["outbound-id", "partial-follow-up-id", "communication-id"])
    await assert.rejects(database.query("SELECT assert_response_gmail_message_id_available($1,$2)", [reusedId, draftId]));
  await database.query("SELECT assert_response_gmail_message_id_available($1,$2)", ["unused-id", draftId]);
});
