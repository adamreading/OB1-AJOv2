-- Plaud speaker pipeline — polished per-recording transcript summary.
-- ADDITIVE: one nullable TEXT column on plaud_recordings. Core `thoughts` untouched.
--
-- Why: on RELEASE, terra generates a well-written markdown summary of the reviewed
-- transcript; it's stored here (PATCH /plaud-recordings/:rid {summary_md}) and shown
-- in the /speakers UI behind a "Summary" button (reviewed recordings) with a
-- copy-to-clipboard. Storage only — generation is the WSL/terra side.

ALTER TABLE public.plaud_recordings
  ADD COLUMN IF NOT EXISTS summary_md TEXT;

-- PostgREST picks up the new column on the next schema reload.
NOTIFY pgrst, 'reload schema';
