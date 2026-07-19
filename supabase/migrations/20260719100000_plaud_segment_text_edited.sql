-- Plaud speaker pipeline — persistent per-segment "transcript text was hand-edited" flag.
-- ADDITIVE: one nullable-with-default boolean on plaud_speaker_segments. Core
-- `thoughts` untouched; no other table changes.
--
-- Why: the operator can now correct a transcript line's TEXT in /speakers (pencil →
-- textarea → save, PATCH …/segments/:idx {text}). `text_edited` marks rows whose
-- prose is the human's, not the machine's, so (a) the WSL pipeline's re-ingest carry
-- preserves the corrected text on a span match instead of clobbering it, and (b) the
-- GUI shows a subtle "edited" mark. Orthogonal to identity: renaming / re-speaker-ing
-- a line must NOT clear text_edited (unlike `excluded`), so a text PATCH is the only
-- writer of this flag and a rename PATCH leaves it alone.

ALTER TABLE public.plaud_speaker_segments
  ADD COLUMN IF NOT EXISTS text_edited BOOLEAN NOT NULL DEFAULT FALSE;

-- PostgREST picks up the new column on the next schema reload.
NOTIFY pgrst, 'reload schema';
