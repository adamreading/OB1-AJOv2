-- Approve-audit trail for /review/approve.
-- ADDITIVE: new table only; core `thoughts` untouched.
--
-- Why: /review/approve applies UPDATEs (overwrites the target) and DELETES the pending
-- vessel, but recorded NO actor/timestamp — so after the fact we could not answer
-- "who approved this?" (the #426 08:01 clobber was actorless; the forensic dead-ended
-- because there was no log). This table captures one row per item processed by an
-- approve call: what action was taken, on which serial_id, the UPDATE target if any,
-- the caller-supplied actor label, and whether the call was human-directed.
--
-- Not a security boundary — it's an audit record. Writes are best-effort from the
-- endpoint (a log failure must never fail an approve).

CREATE TABLE IF NOT EXISTS public.review_actions (
  id               BIGSERIAL PRIMARY KEY,
  serial_id        INTEGER,            -- the vessel/thought the action was taken on
  action           TEXT NOT NULL,      -- approved | update_applied | stale | refused | error
  target_id        INTEGER,            -- for update_applied: the UPDATE target's serial_id
  actor            TEXT,               -- caller-supplied label (dashboard session / api / cron); NULL if unknown
  human_authorized BOOLEAN,            -- whether the approve call was human-directed
  meta             JSONB,              -- extra context (archived_prior_version, refusal message, …)
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS review_actions_serial_idx ON public.review_actions (serial_id);
CREATE INDEX IF NOT EXISTS review_actions_target_idx ON public.review_actions (target_id);
CREATE INDEX IF NOT EXISTS review_actions_created_idx ON public.review_actions (created_at DESC);

-- PostgREST picks up the new table on the next schema reload.
NOTIFY pgrst, 'reload schema';
