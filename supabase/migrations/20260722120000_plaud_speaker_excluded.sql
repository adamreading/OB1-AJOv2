-- Plaud speaker pipeline — persistent whole-speaker "excluded from analysis" flag.
-- ADDITIVE: adds one nullable-with-default boolean to plaud_recording_speakers. Core
-- `thoughts` untouched; no other table changes.
--
-- Why: the operator wants to "ignore a whole speaker" during review — mark the speaker,
-- badge every line they spoke, and have the transcript-review LLM DISREGARD their content
-- (never attribute anything to them). This is the speaker-level twin of the existing
-- per-segment plaud_speaker_segments.excluded (migration 20260719080000): that one is
-- "exclude THIS turn", this one is "exclude EVERY turn of this speaker". The WSL pipeline
-- (fetch_reviewed) already reads speakers[].excluded and tags those lines [EXCLUDED] for
-- terra-extraction + the released summary — this column is the OB side of that contract.
--
-- Orthogonal to identity: it does not clear resolved_name (a named speaker can still be
-- excluded, and un-excluding is naming them / the UI toggling it back). The voiceprint
-- side (strip the print on "ignore") stays owned by the WSL box's /relabel.

ALTER TABLE public.plaud_recording_speakers
  ADD COLUMN IF NOT EXISTS excluded BOOLEAN NOT NULL DEFAULT FALSE;

-- PostgREST picks up the new column on the next schema reload.
NOTIFY pgrst, 'reload schema';
