-- Plaud local transcription/diarization/speaker-ID pipeline — OB storage layer.
-- (Section B of the OB-takeover plan. Maintainer-approved 2026-07-17.)
--
-- The WSL pipeline transcribes + diarizes + speaker-IDs a recording LOCALLY, then
-- POSTs the NON-BIOMETRIC result here for the /speakers review GUI. This schema is
-- purely additive (three new tables, the core `thoughts` table is untouched) and
-- reversible (DROP the three tables to remove it entirely).
--
-- GUARDIAN INVARIANT (ratified 2026-07-17): voiceprint VECTORS never come to OB.
-- Biometric embeddings stay in the WSL box's local pgvector. These tables hold
-- only the reviewable artifacts — transcript text, segment timestamps, stable
-- speaker keys, and human-assigned names. No embedding/vector column exists here
-- by design; do NOT add one.

-- ── Recordings ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.plaud_recordings (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recording_id  TEXT NOT NULL UNIQUE,          -- Applaud recording id (stable external key)
  title         TEXT,
  started_at    TIMESTAMPTZ,
  duration_ms   BIGINT,
  audio_ref     TEXT,                           -- on-box path/route to audio.ogg (served locally; never cloud-copied)
  transcript_text TEXT,                          -- full named transcript (convenience; segments are source of truth)
  review_status TEXT NOT NULL DEFAULT 'pending_review',  -- pending_review | reviewed
  metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Per-recording speakers (the bulk label + enrolment state) ───────────────────
-- One row per distinct diarized speaker in a recording. `speaker_key` is stable
-- within a recording ('S1','S2',…). `resolved_name` is the human-assigned name
-- ("all instances of Speaker X" rename); `enrolled` flips true once that name's
-- turns have been sent to the WSL voiceprint library (enrolment). No vectors here.
CREATE TABLE IF NOT EXISTS public.plaud_recording_speakers (
  recording_id     TEXT NOT NULL REFERENCES public.plaud_recordings(recording_id) ON DELETE CASCADE,
  speaker_key      TEXT NOT NULL,               -- stable within a recording: 'S1','S2',...
  resolved_name    TEXT,                         -- null = unknown (shows as "Speaker N")
  match_confidence REAL,                          -- pipeline's voiceprint-match confidence (0..1), null if none
  enrolled         BOOLEAN NOT NULL DEFAULT false,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (recording_id, speaker_key)
);

-- ── Segments (diarization turns; transcript↔audio time-sync) ────────────────────
-- One row per diarized turn. `resolved_name_override` is the per-segment
-- "just this instance" correction; when null the segment inherits its speaker's
-- bulk `resolved_name`. Effective label = override ?? speaker.resolved_name ?? key.
CREATE TABLE IF NOT EXISTS public.plaud_speaker_segments (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recording_id   TEXT NOT NULL REFERENCES public.plaud_recordings(recording_id) ON DELETE CASCADE,
  idx            INTEGER NOT NULL,               -- 0-based segment order within the recording
  start_ms       BIGINT NOT NULL,
  end_ms         BIGINT NOT NULL,
  speaker_key    TEXT NOT NULL,                  -- ties to plaud_recording_speakers.speaker_key
  resolved_name_override TEXT,                    -- per-segment "just this instance" relabel; null = inherit
  match_confidence REAL,
  text           TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (recording_id, idx)
);

CREATE INDEX IF NOT EXISTS idx_plaud_recordings_status
  ON public.plaud_recordings (review_status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_plaud_segments_recording
  ON public.plaud_speaker_segments (recording_id, idx);
CREATE INDEX IF NOT EXISTS idx_plaud_segments_speaker
  ON public.plaud_speaker_segments (recording_id, speaker_key);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.plaud_recordings          TO authenticated, anon, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.plaud_recording_speakers  TO authenticated, anon, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.plaud_speaker_segments    TO authenticated, anon, service_role;

NOTIFY pgrst, 'reload schema';
