-- Plaud speaker pipeline — persistent per-segment "excluded from identification" flag.
-- ADDITIVE: adds one nullable-with-default boolean to plaud_speaker_segments. Core
-- `thoughts` untouched; no other table changes.
--
-- Why: the operator wants a line-level "exclude from identification" that STICKS — a visible
-- flag on the row whether the exclusion was manual (he hit "Exclude this line") or
-- automatic (the >=0.10 crosstalk teaching gate). The 0.10 auto-flag already renders
-- from the stored `overlap`; this column persists the MANUAL exclude so a hand-excluded
-- low-overlap line keeps its mark across reloads. The WSL voiceprint DB still owns the
-- biometric side (the /relabel ignore strips the print) — this is OB's non-biometric
-- record of "the human said don't identify from this turn".

ALTER TABLE public.plaud_speaker_segments
  ADD COLUMN IF NOT EXISTS excluded BOOLEAN NOT NULL DEFAULT FALSE;

-- PostgREST picks up the new column on the next schema reload.
NOTIFY pgrst, 'reload schema';
