-- Add per-turn crosstalk overlap to Plaud speaker segments (Lever A).
-- overlap = fraction (0..1) of the turn where 2+ people speak (pyannote-
-- segmentation-3.0, computed host-side in the WSL pipeline). NULL = unscored
-- (treated as "allowed"). The /speakers GUI shows a "⚠ mixed voices — won't teach"
-- hint at overlap >= 0.40; the voiceprint gate itself runs WSL-side. Additive,
-- reversible (DROP COLUMN), does not touch any existing column.
ALTER TABLE public.plaud_speaker_segments
  ADD COLUMN IF NOT EXISTS overlap REAL;

NOTIFY pgrst, 'reload schema';
