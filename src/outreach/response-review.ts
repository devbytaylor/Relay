import { inspect } from "node:util";
import type { Pool } from "pg";

export type ResponseReviewIdentity = {
  prospectId: string;
  draftId: string;
  requestId: string;
  replyId: string;
};

export function formatResponseReview(review: object): string {
  return inspect(review, { depth: null, maxStringLength: null });
}

export function parseResponseReviewArgs(args: string[]): ResponseReviewIdentity {
  const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
  const flags = ["--prospect", "--draft", "--request", "--reply"];
  if (args.length !== 8 || flags.some((flag, i) => args[i * 2] !== flag))
    throw new Error("Usage: --prospect <UUID> --draft <UUID> --request <UUID> --reply <Gmail message ID>");
  const [prospectId, draftId, requestId, replyId] = [args[1], args[3], args[5], args[7]];
  if (!prospectId || !draftId || !requestId || !replyId ||
      !uuid.test(prospectId) || !uuid.test(draftId) || !uuid.test(requestId) ||
      replyId.startsWith("--") || replyId.trim() !== replyId || replyId.length > 512)
    throw new Error("Invalid response review identity.");
  return { prospectId, draftId, requestId, replyId };
}

export async function getResponseReview(
  database: Pick<Pool, "query">,
  identity: ResponseReviewIdentity,
) {
  const result = await database.query(
    `SELECT d.id AS "draftId", d.prospect_id AS "prospectId",
      d.recipient_email AS "recipientEmail", d.subject, d.body,
      d.gmail_draft_id AS "gmailDraftId", d.gmail_thread_id AS "gmailThreadId",
      d.source_reply_message_id AS "sourceReplyMessageId",
      d.response_parent_rfc_message_id AS "replyParentRfcMessageId",
      CASE WHEN d.response_parent_rfc_message_id IS NULL THEN 'missing'
        ELSE 'recorded' END AS "replyParentIdentityStatus",
      d.review_status AS "reviewStatus", d.send_status AS "sendStatus",
      d.sent_message_id AS "sentMessageId", d.sent_at AS "sentAt",
      r.id AS "requestId", r.status AS "requestStatus",
      r.last_error AS "requestError",
      p.gmail_message_id AS "replyId", p.gmail_thread_id AS "replyThreadId",
      p.sender AS "replySender", p.subject AS "replySubject",
      p.snippet AS "replySnippet", p.received_at AS "replyReceivedAt",
      a.status AS "attemptStatus", a.sent_message_id AS "attemptSentMessageId",
      a.gmail_thread_id AS "attemptThreadId", a.last_error AS "attemptError",
      a.invocation_started_at AS "attemptInvocationStartedAt"
    FROM message_drafts d
    JOIN reply_processing_requests r ON r.id = $3 AND r.prospect_id = d.prospect_id
      AND r.source_reply_message_id = d.source_reply_message_id
      AND r.gmail_draft_id = d.gmail_draft_id AND r.gmail_thread_id = d.gmail_thread_id
    JOIN prospect_replies p ON p.prospect_id = d.prospect_id
      AND p.gmail_message_id = d.source_reply_message_id
      AND p.gmail_thread_id = d.gmail_thread_id
    LEFT JOIN response_send_attempts a ON a.draft_id = d.id
    WHERE d.id = $2 AND d.prospect_id = $1 AND d.source_reply_message_id = $4
      AND d.draft_type = 'response'`,
    [identity.prospectId, identity.draftId, identity.requestId, identity.replyId],
  );
  if (result.rows.length !== 1)
    throw new Error("Exact response draft, request, and reply identity not found or mismatched.");
  return result.rows[0];
}
