import type { PoolClient } from "pg";

// Caller holds the prospect lock. Never rewrite in-flight or confirmed sends.
export async function invalidateStaleResponseDrafts(
  client: PoolClient,
  prospectId: string,
  latestReplyId: string,
) {
  await client.query(
    `UPDATE message_drafts SET review_status = 'rejected',
    review_notes = 'Superseded by a newer inbound reply; do not send.', updated_at = now()
    WHERE prospect_id = $1 AND draft_type = 'response'
      AND source_reply_message_id IS DISTINCT FROM $2
      AND send_status = 'pending' AND sent_at IS NULL AND sent_message_id IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM response_send_attempts a WHERE a.draft_id = message_drafts.id
          AND a.status IN ('invoking', 'needs_reconciliation', 'sent')
      )`,
    [prospectId, latestReplyId],
  );
  await client.query(
    `UPDATE reply_processing_requests r SET
    status = CASE WHEN status = 'creating' THEN 'needs_reconciliation' ELSE 'stale' END,
    last_error = 'Superseded by a newer inbound reply.', updated_at = now()
    WHERE prospect_id = $1 AND source_reply_message_id <> $2
      AND status IN ('classifying','creating','created','no_draft')
      AND NOT EXISTS (
        SELECT 1 FROM message_drafts d
        LEFT JOIN response_send_attempts a ON a.draft_id = d.id
        WHERE d.prospect_id = r.prospect_id AND d.draft_type = 'response'
          AND d.source_reply_message_id = r.source_reply_message_id
          AND (d.send_status IN ('sending', 'needs_reconciliation', 'sent')
            OR a.status IN ('invoking', 'needs_reconciliation', 'sent'))
      )`,
    [prospectId, latestReplyId],
  );
}
