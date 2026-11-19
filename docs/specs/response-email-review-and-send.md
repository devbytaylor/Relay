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
