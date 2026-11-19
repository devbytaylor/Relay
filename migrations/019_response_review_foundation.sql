-- The draft owns review state; the processing request remains creation history.
ALTER TABLE reply_processing_requests DROP COLUMN review_status;

ALTER TABLE message_drafts
  ADD COLUMN response_parent_rfc_message_id TEXT,
  ADD COLUMN response_approval_hash TEXT,
  ADD COLUMN response_approved_snapshot JSONB;

ALTER TABLE message_drafts ADD CONSTRAINT response_approval_identity_check CHECK (
  (response_approval_hash IS NULL) = (response_approved_snapshot IS NULL)
  AND (
  (response_approval_hash IS NULL AND response_approved_snapshot IS NULL)
  OR (draft_type = 'response' AND response_approval_hash ~ '^[0-9a-f]{64}$'
      AND jsonb_typeof(response_approved_snapshot) = 'object')
  )
);
ALTER TABLE message_drafts ADD CONSTRAINT response_approved_state_check CHECK (
  draft_type <> 'response' OR review_status <> 'approved'
  OR (response_approval_hash IS NOT NULL AND response_approved_snapshot IS NOT NULL
      AND response_parent_rfc_message_id IS NOT NULL)
);
ALTER TABLE message_drafts ADD CONSTRAINT response_parent_identity_check CHECK (
  response_parent_rfc_message_id IS NULL OR
  (draft_type = 'response' AND response_parent_rfc_message_id ~ '^<[^<>[:space:]]+@[^<>[:space:]]+>$')
);
ALTER TABLE message_drafts ADD CONSTRAINT response_send_state_check CHECK (
  draft_type <> 'response' OR (
    (send_status <> 'sent' AND review_status <> 'sent'
      AND sent_message_id IS NULL AND sent_at IS NULL)
    OR (send_status = 'sent' AND review_status = 'sent'
      AND NULLIF(btrim(sent_message_id), '') IS NOT NULL AND sent_at IS NOT NULL)
  )
);

-- The composite foreign key prevents an attempt from attaching to another draft type.
ALTER TABLE message_drafts ADD CONSTRAINT message_drafts_id_type_unique UNIQUE (id, draft_type);
CREATE TABLE response_send_attempts (
  draft_id UUID PRIMARY KEY,
  draft_type TEXT NOT NULL DEFAULT 'response' CHECK (draft_type = 'response'),
  status TEXT NOT NULL CHECK (status IN
    ('preflight', 'invoking', 'sent', 'blocked', 'needs_reconciliation')),
  approved_content_hash TEXT NOT NULL CHECK (approved_content_hash ~ '^[0-9a-f]{64}$'),
  approved_snapshot JSONB NOT NULL CHECK (jsonb_typeof(approved_snapshot) = 'object'),
  sent_message_id TEXT,
  gmail_thread_id TEXT,
  last_error TEXT,
  invocation_started_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (draft_id, draft_type) REFERENCES message_drafts (id, draft_type) ON DELETE RESTRICT,
  CHECK (status <> 'sent' OR
    (NULLIF(btrim(sent_message_id), '') IS NOT NULL AND
     NULLIF(btrim(gmail_thread_id), '') IS NOT NULL)),
  CHECK (status NOT IN ('preflight', 'blocked') OR
    (sent_message_id IS NULL AND gmail_thread_id IS NULL)),
  CHECK (status <> 'needs_reconciliation' OR NULLIF(btrim(last_error), '') IS NOT NULL)
);
CREATE UNIQUE INDEX response_send_attempt_message_unique
  ON response_send_attempts (sent_message_id) WHERE sent_message_id IS NOT NULL;

-- Later sender releases must retain every durable state change, including
-- partial provider results and the timestamp recorded before invocation.
CREATE TABLE response_send_attempt_transitions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  draft_id UUID NOT NULL REFERENCES response_send_attempts(draft_id) ON DELETE RESTRICT,
  from_status TEXT,
  to_status TEXT NOT NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  invocation_started_at TIMESTAMPTZ,
  sent_message_id TEXT,
  gmail_thread_id TEXT,
  last_error TEXT
);

CREATE FUNCTION guard_response_transition_history() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Response send transition history is immutable';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER response_transition_immutable_rows
  BEFORE UPDATE OR DELETE ON response_send_attempt_transitions FOR EACH STATEMENT
  EXECUTE FUNCTION guard_response_transition_history();
CREATE TRIGGER response_transition_no_truncate
  BEFORE TRUNCATE ON response_send_attempt_transitions FOR EACH STATEMENT
  EXECUTE FUNCTION guard_response_transition_history();

CREATE FUNCTION record_response_attempt_transition() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' OR ROW(NEW.status, NEW.invocation_started_at,
      NEW.sent_message_id, NEW.gmail_thread_id, NEW.last_error)
      IS DISTINCT FROM ROW(OLD.status, OLD.invocation_started_at,
      OLD.sent_message_id, OLD.gmail_thread_id, OLD.last_error) THEN
    INSERT INTO response_send_attempt_transitions
      (draft_id, from_status, to_status, invocation_started_at,
       sent_message_id, gmail_thread_id, last_error)
    VALUES (NEW.draft_id, CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.status END,
      NEW.status, NEW.invocation_started_at, NEW.sent_message_id,
      NEW.gmail_thread_id, NEW.last_error);
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER response_attempt_transition_journal
  AFTER INSERT OR UPDATE ON response_send_attempts FOR EACH ROW
  EXECUTE FUNCTION record_response_attempt_transition();

-- Audit identity and observations cannot be removed or rewritten. A result may
-- fill previously empty provider fields; it cannot replace an observed value.
CREATE FUNCTION guard_response_attempt_history() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'Response send attempt history cannot be truncated';
  END IF;
  IF TG_OP = 'INSERT' THEN
    RAISE EXCEPTION 'Response attempt claim is reserved for Issue 55';
    IF NEW.status <> 'preflight' THEN
      RAISE EXCEPTION 'Response send attempt must start in preflight';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM message_drafts
      WHERE id = NEW.draft_id AND draft_type = 'response'
        AND review_status = 'approved' AND send_status = 'pending'
    ) THEN
      RAISE EXCEPTION 'Response preflight requires an approved pending draft';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Response send attempt history cannot be deleted';
  END IF;
  IF NEW.draft_id IS DISTINCT FROM OLD.draft_id
      OR NEW.draft_type IS DISTINCT FROM OLD.draft_type
      OR NEW.approved_content_hash IS DISTINCT FROM OLD.approved_content_hash
      OR NEW.approved_snapshot IS DISTINCT FROM OLD.approved_snapshot
      OR NEW.created_at IS DISTINCT FROM OLD.created_at
      OR (OLD.invocation_started_at IS NOT NULL AND NEW.invocation_started_at IS DISTINCT FROM OLD.invocation_started_at)
      OR (OLD.sent_message_id IS NOT NULL AND NEW.sent_message_id IS DISTINCT FROM OLD.sent_message_id)
      OR (OLD.gmail_thread_id IS NOT NULL AND NEW.gmail_thread_id IS DISTINCT FROM OLD.gmail_thread_id)
      OR (OLD.last_error IS NOT NULL AND NEW.last_error IS DISTINCT FROM OLD.last_error) THEN
    RAISE EXCEPTION 'Response send attempt evidence cannot be rewritten';
  END IF;
  IF NOT (
    (OLD.status = NEW.status)
    OR (OLD.status = 'preflight' AND NEW.status IN ('invoking', 'blocked'))
    OR (OLD.status = 'invoking' AND NEW.status IN ('sent', 'needs_reconciliation'))
  ) THEN
    RAISE EXCEPTION 'Invalid response send attempt transition';
  END IF;
  IF OLD.status = 'preflight' AND NEW.status = 'invoking' AND NOT EXISTS (
    SELECT 1 FROM message_drafts WHERE id = OLD.draft_id AND review_status = 'approved'
  ) THEN
    RAISE EXCEPTION 'Response invocation requires current approval';
  END IF;
  IF NEW.status IN ('invoking', 'sent', 'needs_reconciliation')
      AND NEW.invocation_started_at IS NULL THEN
    RAISE EXCEPTION 'Response invocation requires durable start time';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER response_attempt_history
  BEFORE INSERT OR UPDATE OR DELETE ON response_send_attempts FOR EACH ROW
  EXECUTE FUNCTION guard_response_attempt_history();
CREATE TRIGGER response_attempt_no_truncate
  BEFORE TRUNCATE ON response_send_attempts FOR EACH STATEMENT
  EXECUTE FUNCTION guard_response_attempt_history();

-- Serialize a candidate Gmail ID across the response journal and existing
-- outbound records. Matching draft/attempt rows represent the same send.
CREATE FUNCTION assert_response_gmail_message_id_available(candidate TEXT, owner_draft_id UUID)
RETURNS void AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM message_drafts
      WHERE sent_message_id = candidate AND id <> owner_draft_id)
      OR EXISTS (SELECT 1 FROM follow_up_send_attempts
      WHERE sent_message_id = candidate)
      OR EXISTS (SELECT 1 FROM communications
      WHERE direction = 'outbound' AND gmail_message_id = candidate) THEN
    RAISE EXCEPTION 'Response Gmail message ID already belongs to an outbound record';
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION guard_response_gmail_message_identity() RETURNS trigger AS $$
DECLARE
  candidate TEXT;
  owner_draft_id UUID;
BEGIN
  IF TG_TABLE_NAME = 'communications' THEN
    IF NEW.direction <> 'outbound' THEN RETURN NEW; END IF;
    candidate := NEW.gmail_message_id;
    IF TG_OP = 'UPDATE' AND NEW.gmail_message_id IS NOT DISTINCT FROM OLD.gmail_message_id
        AND NEW.direction IS NOT DISTINCT FROM OLD.direction THEN RETURN NEW; END IF;
  ELSE
    candidate := NEW.sent_message_id;
    IF TG_OP = 'UPDATE' AND NEW.sent_message_id IS NOT DISTINCT FROM OLD.sent_message_id
        THEN RETURN NEW; END IF;
  END IF;
  IF candidate IS NULL THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('response-gmail-id:' || candidate, 0));

  IF TG_TABLE_NAME = 'response_send_attempts' THEN
    PERFORM assert_response_gmail_message_id_available(candidate, NEW.draft_id);
  ELSE
    IF TG_TABLE_NAME = 'message_drafts' THEN owner_draft_id := NEW.id; END IF;
    IF EXISTS (SELECT 1 FROM response_send_attempts
        WHERE sent_message_id = candidate
          AND (owner_draft_id IS NULL OR draft_id <> owner_draft_id)) THEN
      RAISE EXCEPTION 'Outbound Gmail message ID already belongs to a response attempt';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER response_attempt_gmail_identity
  BEFORE INSERT OR UPDATE OF sent_message_id ON response_send_attempts FOR EACH ROW
  EXECUTE FUNCTION guard_response_gmail_message_identity();
CREATE TRIGGER response_draft_gmail_identity
  BEFORE INSERT OR UPDATE OF sent_message_id ON message_drafts FOR EACH ROW
  EXECUTE FUNCTION guard_response_gmail_message_identity();
CREATE TRIGGER response_follow_up_gmail_identity
  BEFORE INSERT OR UPDATE OF sent_message_id ON follow_up_send_attempts FOR EACH ROW
  EXECUTE FUNCTION guard_response_gmail_message_identity();
CREATE TRIGGER response_communication_gmail_identity
  BEFORE INSERT OR UPDATE OF gmail_message_id, direction ON communications FOR EACH ROW
  EXECUTE FUNCTION guard_response_gmail_message_identity();

CREATE FUNCTION guard_response_draft_history() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.draft_type = 'response' AND
        (NEW.review_status IN ('approved', 'sent') OR NEW.send_status <> 'pending') THEN
      RAISE EXCEPTION 'Response approval and sending are not enabled by Issue 52';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.draft_type <> 'response' AND NEW.draft_type <> 'response' THEN RETURN NEW; END IF;
  IF NEW.draft_type IS DISTINCT FROM OLD.draft_type THEN
    RAISE EXCEPTION 'Response draft type cannot change';
  END IF;
  IF (NEW.review_status IN ('approved', 'sent')
        AND NEW.review_status IS DISTINCT FROM OLD.review_status)
      OR (NEW.send_status <> 'pending'
        AND NEW.send_status IS DISTINCT FROM OLD.send_status) THEN
    RAISE EXCEPTION 'Response approval and sending are not enabled by Issue 52';
  END IF;
  IF NOT (
    OLD.send_status = NEW.send_status
    OR (OLD.send_status = 'pending' AND NEW.send_status = 'sending')
    OR (OLD.send_status = 'sending' AND NEW.send_status IN ('sent', 'needs_reconciliation'))
  ) THEN
    RAISE EXCEPTION 'Invalid response draft send transition';
  END IF;
  IF (OLD.sent_message_id IS NOT NULL AND NEW.sent_message_id IS DISTINCT FROM OLD.sent_message_id)
      OR (OLD.sent_at IS NOT NULL AND NEW.sent_at IS DISTINCT FROM OLD.sent_at) THEN
    RAISE EXCEPTION 'Response draft send evidence cannot be rewritten';
  END IF;
  IF EXISTS (SELECT 1 FROM response_send_attempts WHERE draft_id = OLD.id) AND (
      NEW.response_approval_hash IS DISTINCT FROM OLD.response_approval_hash
      OR NEW.response_approved_snapshot IS DISTINCT FROM OLD.response_approved_snapshot
      OR NEW.response_parent_rfc_message_id IS DISTINCT FROM OLD.response_parent_rfc_message_id
      OR NEW.source_reply_message_id IS DISTINCT FROM OLD.source_reply_message_id
      OR NEW.recipient_email IS DISTINCT FROM OLD.recipient_email
      OR NEW.subject IS DISTINCT FROM OLD.subject OR NEW.body IS DISTINCT FROM OLD.body
      OR NEW.gmail_draft_id IS DISTINCT FROM OLD.gmail_draft_id
      OR NEW.gmail_thread_id IS DISTINCT FROM OLD.gmail_thread_id) THEN
    RAISE EXCEPTION 'Claimed response draft evidence cannot be rewritten';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER response_draft_history
  BEFORE INSERT OR UPDATE ON message_drafts FOR EACH ROW
  EXECUTE FUNCTION guard_response_draft_history();

-- Historical drafts may lack a verified parent, but they cannot be approved or
-- acquire a send attempt. Check the final transaction state so a future sender
-- can update the draft and attempt in either order within one transaction.
CREATE FUNCTION check_response_send_attempt_draft() RETURNS trigger AS $$
DECLARE
  draft_row message_drafts%ROWTYPE;
  attempt_row response_send_attempts%ROWTYPE;
  target_draft_id UUID;
BEGIN
  IF TG_TABLE_NAME = 'response_send_attempts' THEN
    target_draft_id := NEW.draft_id;
  ELSE
    target_draft_id := NEW.id;
  END IF;
  SELECT * INTO attempt_row FROM response_send_attempts WHERE draft_id = target_draft_id;
  SELECT * INTO draft_row FROM message_drafts WHERE id = target_draft_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF attempt_row.draft_id IS NULL THEN
    IF draft_row.draft_type = 'response' AND draft_row.send_status <> 'pending' THEN
      RAISE EXCEPTION 'Response send state requires a send attempt';
    END IF;
    RETURN NULL;
  END IF;
  IF draft_row.response_parent_rfc_message_id IS NULL
      OR draft_row.response_approval_hash IS NULL
      OR draft_row.response_approved_snapshot IS NULL
      OR draft_row.response_approval_hash <> attempt_row.approved_content_hash
      OR draft_row.response_approved_snapshot IS DISTINCT FROM attempt_row.approved_snapshot THEN
    RAISE EXCEPTION 'Response send attempt requires a parent and matching draft approval';
  END IF;
  IF (attempt_row.status IN ('preflight', 'blocked') AND draft_row.send_status <> 'pending')
      OR (attempt_row.status = 'invoking' AND draft_row.send_status <> 'sending')
      OR (attempt_row.status = 'needs_reconciliation' AND draft_row.send_status <> 'needs_reconciliation')
      OR (attempt_row.status = 'sent' AND draft_row.send_status <> 'sent') THEN
    RAISE EXCEPTION 'Response send attempt and draft send statuses disagree';
  END IF;
  IF attempt_row.status = 'sent' AND (
      draft_row.sent_message_id IS DISTINCT FROM attempt_row.sent_message_id
      OR draft_row.gmail_thread_id IS DISTINCT FROM attempt_row.gmail_thread_id) THEN
    RAISE EXCEPTION 'Response sent identities disagree';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER response_attempt_draft_state
  AFTER INSERT OR UPDATE ON response_send_attempts
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION check_response_send_attempt_draft();
CREATE CONSTRAINT TRIGGER response_draft_attempt_state
  AFTER INSERT OR UPDATE ON message_drafts
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION check_response_send_attempt_draft();
