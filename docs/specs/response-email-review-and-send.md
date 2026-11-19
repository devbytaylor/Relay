# Response email review and guarded sending

## Current state

The reply path reserves one processing request per prospect and reply, checks the live thread, and creates a `needs_review` response draft. It stops there. The existing outreach operator and worker reject response drafts. Follow-up sending supplies patterns for content-bound approval, a durable send attempt, Gmail MIME inspection, and reconciliation.

This specification defines a locally verifiable response send capability. Live mailbox acceptance and activation are separate work.

## Problem Statement

An operator can review a proposed reply in Gmail, but Relay cannot approve and send that response through a managed workflow. Sending outside Relay loses its exact-reply checks, durable duplicate prevention, and uncertain-send hold.

## Solution

Provide explicit, separate **review**, **approve**, and **send** actions for a response draft. Approval binds the exact reviewed destination, content, Gmail draft, thread, and parent reply. Sending rechecks current database and live Gmail state, sends the inspected MIME snapshot once, and records either a confirmed result or a hold requiring human reconciliation.

## User Stories

1. As an operator, I want to inspect the exact response draft and its source reply, so that I know what I am reviewing.
2. As an operator, I want to see the recipient, subject, full plain-text body, thread, and reply identity, so that I can catch a wrong destination or stale response.
3. As an operator, I want approval to be a separate, explicitly confirmed action, so that reviewing cannot send mail.
4. As an operator, I want approval tied to the content I reviewed, so that later edits require new review.
5. As an operator, I want sending to require a separate confirmation and disabled-by-default live gate, so that an approved draft cannot send accidentally.
6. As an operator, I want a newer reply or opt-out to stop sending, so that Relay does not answer stale or unwanted mail.
7. As an operator, I want a changed contact, Gmail draft, thread, or reply parent to stop sending, so that Relay does not redirect the response.
8. As an operator, I want a clear blocked state when preflight fails before Gmail send, so that I can inspect and correct the draft.
9. As an operator, I want an uncertain Gmail result held with its identities and error category, so that I can reconcile it without risking a duplicate.
10. As an operator, I want a confirmed send recorded even if a reply arrives during the external call, so that Relay retains what actually happened.
11. As an operator, I want repeated or concurrent send commands to be rejected, so that one approval cannot produce two attempts.
12. As an operator, I want read-only inspection of the draft and attempt after any failure, so that recovery decisions use durable evidence.
13. As a maintainer, I want fake-Gmail tests through the same response workflow used by the operator command, so that safety checks cover their ordering and interaction.
14. As a maintainer, I want response sending to remain separate from cold follow-up scheduling, so that reply-specific eligibility stays explicit.

## Acceptance Criteria

- Review reads a response draft, its processing request, source reply, and current status by exact identity. It makes no provider mutation.
- Approval requires a `created` processing request and a matching, unsent `needs_review` response draft. It stores an approval fingerprint covering the reviewed content and source identities. No Gmail send occurs.
- Send requires an explicit confirmation, a response-specific disabled-by-default live gate, and the existing general live-send guard **before** loading database or Gmail dependencies.
- A transaction locks the prospect and relevant draft records in a consistent order, checks approval and eligibility, and reserves **one** durable response send attempt before Gmail send can be invoked.
- Preflight verifies the exact latest recorded and live inbound reply; current contact and opt-out state; matching Gmail draft, thread and plain-text MIME; and exact `In-Reply-To` and `References` parent. Unavailable or ambiguous evidence blocks sending.
- The final send supplies the inspected raw MIME and thread ID. Automatic transport retries are disabled.
- A complete, valid Gmail result records the sent message and thread IDs on the draft and attempt atomically. It preserves reply and suppression state rather than moving the prospect back to a cold-outreach stage.
- Once send invocation begins, a thrown call, incomplete result, wrong thread, reused message ID, or failed finalization remains held for reconciliation. Neither a second command nor a new request ID may bypass the hold.
- A pre-send failure records a review block without claiming that Gmail sent. An inability to persist the block remains fail-closed and is reported for inspection.
- Operator output and routine logs expose status and IDs without printing private message bodies or approved snapshots, except in the intentional review view.

## Implementation Decisions and Safety Invariants

- **Reuse:** Keep the existing Gmail draft snapshot verifier and thread reader. Reuse the follow-up pattern of content-bound approval and a durable attempt, while retaining response-specific reply, consent, and journal checks.
- **Test seam:** Prefer one high-level response send operation with injected database and Gmail readers/sender. Tests call that operation as the operator command does. Existing Gmail fakes sit behind its provider seam; no new general email framework is required.
- **Authority:** The response draft is the authoritative review/send record. The processing request remains the durable creation journal. Its current fixed `needs_review` field must not become a second, contradictory approval authority; the migration must resolve that representation explicitly.
- **Schema:** Add a response-specific approval identity and a unique send-attempt journal linked to the draft. Retain the approved snapshot and returned Gmail identities for audit. Define constrained preflight, invoking, sent, blocked, and reconciliation states. Preserve existing records and uniqueness guarantees.
- **Eligibility:** Require the draft's source reply to be the latest recorded inbound on its thread and still the latest relevant inbound in Gmail. Recheck the inbound MIME parent identity and contact routing. Reject opt-outs, automatic or no-draft decisions, changed contacts, unavailable threads, conflicting unresolved sends, and untracked newer outbound mail.
- **State transitions:** Approval never queues or sends. A send claim happens once. Preflight failures cannot be mistaken for post-send uncertainty. A confirmed Gmail send is recorded even if approval or reply state changed during the external call; that change must not clear suppression.
- **Cross-system limit:** A new reply can arrive after the final Gmail read. Relay cannot make Gmail and Postgres atomic. The workflow narrows that interval and preserves the actual outcome; it does not promise zero race time.
- **Durability:** Preserve transaction boundaries, prospect-first lock ordering, duplicate prevention, reconciliation history, and the existing fail-closed behavior of response draft creation and reply monitoring. Do not clear an uncertain attempt automatically or create a replacement attempt to regain liveness.

## Response state machine

The state of a response is the tuple `message_drafts.review_status` / `message_drafts.send_status` / `response_send_attempts.status`. `none` means no attempt row. The draft is the review and send authority; `reply_processing_requests.status` describes creation or staleness, not approval. A `created` request is necessary for approval, but never sufficient to send. Only the transitions below are authorized. A database value being in an allowed enum does not authorize a transition into that value.

| Event | From | To | Required condition and durable effect | Owner |
| --- | --- | --- | --- | --- |
| Create response draft | No response draft | `needs_review / pending / none` | The creation request reaches `created`; the draft retains the exact prospect, source reply, Gmail draft/thread, and verified RFC reply parent. Creation still performs no approval or send. | #52 foundation; existing reply creation path |
| Exact review | Any existing tuple | Unchanged | Read the draft, creation request, source reply, and current attempt by exact identity. Missing or mismatched identity fails closed. | #52 |
| Explicit approval | `needs_review / pending / none` | `approved / pending / none` | Require a matching `created` request, verified parent, exact reviewed snapshot and fingerprint, and separate operator confirmation. This neither claims an attempt nor contacts Gmail. | #53 |
| Newer inbound before claim | `needs_review / pending / none` or `approved / pending / none` | `rejected / pending / none` | Revoke pending approval and mark the older request `stale`. Keep prior approval evidence. | #53; #52 may preserve existing invalidation behavior |
| Changed reviewed field before claim | `approved / pending / none` | `needs_edit / pending / none` | Changed content, recipient, contact, Gmail identity, or reply parent cannot inherit approval. Retain the prior snapshot and require a new explicit review design before any later approval. | #53 |
| Readiness inspection | Any existing tuple | Unchanged | Read current database and, when separately authorized, Gmail evidence; report blockers. A positive result is neither approval nor durable send authorization. | #54 |
| Claim once | `approved / pending / none` | `approved / pending / preflight` | Under prospect-first locks, recheck identity, approval fingerprint, eligibility, consent, and unresolved sends; insert the unique attempt with the approved snapshot before any Gmail send invocation. | #55 |
| Pre-invocation block | `approved / pending / preflight` | `needs_edit / pending / blocked`, or `rejected / pending / blocked` if stale | Only when it is known that Gmail send was not invoked. Record the blocker without a sent claim. A failed block write leaves the existing preflight reservation in place and requires inspection. | #55 |
| Newer reply during preflight | `approved / pending / preflight` | `rejected / pending / blocked` | With the prospect lock, revoke the pending approval and close the uninvoked attempt. Do not proceed to invocation. | #55 integration with #53 invalidation |
| Begin invocation | `approved / pending / preflight` | `approved / sending / invoking` | Recheck current database eligibility after Gmail inspection, durably mark invocation, then issue at most one send of the inspected raw MIME and thread with transport retries disabled. A crash after this mark is an uncertain hold. | #55 |
| Confirmed Gmail result | `approved` or subsequently revoked `/ sending / invoking` | `sent / sent / sent` | Validate complete, non-reused message and matching thread IDs; atomically persist the same IDs and sent time on draft and attempt. Record the actual send even if a newer reply or review change occurred during the external call; preserve reply and opt-out suppression. | #55 |
| Uncertain invocation | `approved` or subsequently revoked `/ sending / invoking` | Current review status `/ needs_reconciliation / needs_reconciliation` | A thrown or timed-out call, incomplete/wrong/reused result, or failed finalization retains available returned IDs and the error category. If the hold cannot be finalized, the durable `invoking` row remains a hold. | #55 |

`needs_edit` and `rejected` with `pending / none` are review-required, unsent states; they do not authorize a send. A `blocked` attempt also remains a permanent duplicate guard even though its draft send status is `pending`. Once an attempt exists, approval status alone can never authorize another claim. An `invoking` or reconciliation-held attempt remains protected even if its draft review status changes; finalization of a confirmed external send must use the attempt evidence rather than require approval to remain current. Any other draft/attempt combination is invalid or held for inspection, not a new path through this matrix.

### Prohibited transitions

- Review, approval, and readiness inspection must never queue or send a response. Issue #52 may define future columns, enums, and constraints but must not enable runtime approval, attempt insertion, `sending`/`sent`, or a response send entry point. Database guards must block these future transitions until their owning issue deliberately enables them; merely defining an enum value is not permission to use it. Issue #53 enables only approval and pending invalidation; Issue #54 enables only read-only readiness. Attempt claim, invocation, and outcome recording belong to Issue #55.
- Do not jump from `preflight` directly to `sent` or `needs_reconciliation`, classify an invoked or possibly invoked call as `blocked`, or move `blocked`, `invoking`, `needs_reconciliation`, or `sent` back to `preflight`/`pending`. An unresolved reservation is not permission to retry.
- Do not delete an attempt, clear its snapshot or returned identities, replace it with a new attempt or request ID, or use a second command to bypass the one-attempt guard. Do not change a confirmed `sent` record into an unsent or held record.
- Do not approve a missing-parent historical draft, an automatic or no-draft decision, a stale request, or an identity/content mismatch. A changed field cannot inherit an earlier approval. A revoked or blocked draft cannot be silently reapproved; a future explicit re-review or recovery design must retain earlier approval evidence.
- Do not make the processing request a second approval authority or move a response into a cold-outreach stage after sending. No automatic recovery, replacement attempt, or reconciliation reset is part of Issues #52–#55.

### Immutable evidence and database invariants

- Preserve the creation request's durable identity, prospect and source reply; the draft's source reply, verified RFC parent, Gmail draft/thread identity, recipient, subject, and full body used for approval; and the approval fingerprint and exact snapshot. A later revocation changes current eligibility, not the historical approval evidence. If multiple approvals are ever supported, each needs a separate immutable revision; overwriting the sole earlier snapshot is insufficient.
- The one attempt row retains its draft identity, approved fingerprint and snapshot, creation and invocation evidence, returned Gmail message/thread IDs (including partial results), error category, and terminal outcome. Record state changes in append-only evidence or equivalent immutable transition history; a mutable `last_error` alone does not preserve prior outcomes. Routine logs and output must not print bodies or snapshots outside intentional review.
- Enforce one attempt per response draft with a response-only foreign key and deletion protection. An attempt cannot be deleted and recreated. A response draft in `sending`, `needs_reconciliation`, or `sent` must have the corresponding attempt; an attempt's status must agree with the draft's send status. `sent` requires matching, nonblank message/thread IDs on both records and a sent timestamp. `preflight` and `blocked` cannot carry a sent claim; partial IDs after invocation remain available for reconciliation. Prevent duplicate returned message IDs, including a reused ID from an earlier outbound record.
- Enforce forward-only attempt transitions: insert as `preflight`; then `blocked` or `invoking`; then `sent` or `needs_reconciliation` from `invoking`. A terminal state cannot regress. Check the approved draft identity and snapshot at claim time, but do not let a later review change prevent recording a real Gmail result. Database checks on final row values alone are insufficient; transition and immutability checks must inspect old and new values.
- Preserve prospect-first lock order, transaction rechecks, and the existing uniqueness of one processing request and response draft per prospect/source reply. Application preflight still must verify current consent, contact, source-reply recency, processing decision, exact Gmail draft MIME and parent, live thread, and conflicting sends; database constraints cannot prove external Gmail facts.

### Historical drafts and recovery boundary

Existing response drafts may have no verified RFC parent. Keep them readable by exact identity and display the missing-parent condition; do not invent or backfill a Message-ID from a snippet, request, or unverified Gmail data. Missing-parent drafts cannot be approved, acquire an attempt, or enter a send state. Preserve existing rows and uniqueness guarantees when adding constraints. Any historical row with an unexpected state or contradictory evidence is inspection-only until separately reconciled; migration must not normalize it into send eligibility.

A failed pre-invocation block and an uncertain post-invocation result are different durable outcomes. If persistence fails, retain the last durable reservation and require human inspection. For an ambiguous Gmail call or lost commit acknowledgement, read back durable state without issuing another send; never downgrade an observed confirmed send. Any later human-verified resolution of a held attempt requires a separately scoped recovery workflow that reuses the existing records and audit evidence. The one-attempt rule remains in force throughout Issues #52–#55.

## Testing Decisions

Good tests assert visible state transitions, provider calls, and durable evidence through the response operation. They should avoid testing private helper structure.

- Extend the existing response-processing and reply-monitor integration coverage to verify newer replies revoke pending approval without rewriting an in-flight or confirmed send.
- Add guarded disposable-database tests for approval, changed reviewed content, wrong prospect or draft type, duplicate and concurrent claims, opt-out, changed contact, stale reply, unresolved send, and lost commit acknowledgement.
- Use fake Gmail to cover MIME changes, extra recipients, HTML or attachments, wrong parent/thread, unreadable thread, untracked outbound, one exact send request with retries disabled, incomplete results, transport errors, and finalization failure.
- Test command parsing and both live gates before dependency loading. Existing follow-up and Gmail preflight tests provide prior art.
- Run typecheck and the repository-owned disposable `npm run verify` for implementation verification. No live provider call is part of automated tests.

## Dependencies

The response draft creation and reply-monitor migrations must already be present in the target environment. Implementation needs a reviewed migration for approval and attempt state, a response-specific operator entry point, the existing Gmail read/send capabilities, and updated operations documentation. Deployed schema and mailbox behavior must be checked during a later, separately authorized acceptance step.

## Out of Scope

Live sends or flag activation during implementation; production migrations; schedules or a response worker; automatic recovery or retries; Gmail label updates; Airtable parity; HTML, multipart or attachment sending; changes to initial outreach or cold follow-up behavior; a general communication timeline; and automatic approval of model-generated copy.

## Further Notes

The n8n inventory describes response approval and sending, but it predates the newer local reply implementation. Current code and the migration plan govern this specification. A future recovery issue should define human-verified outcomes for held response attempts before any reset or resend operation.
