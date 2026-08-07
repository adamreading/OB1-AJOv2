-- Plaud review-table hardening + transcript search (one deploy, maintainer-approved 2026-08-07).
-- Cross-reviewed before ship.
-- ADDITIVE — core `thoughts` untouched; the three plaud_* tables from
-- 20260717140000 are unchanged except that ingress/delete now route through the
-- atomic functions below. Reversible: DROP the objects created here.
--
-- Closes, in one migration:
--   #4  ingress partial-wipe   — delete-then-insert with no txn could leave a
--       recording with zero segments if the insert 500s → atomic fn.
--   #5  purge = delete-everything — a partition holding 100% of the corpus made
--       the review_status rail a one-call corpus-zeroer → in-fn ceiling + confirm token.
--   tombstone — deletion left no record + ingress had no already-deleted guard, so
--       the operator's "deleted stays deleted" expectation was false → plaud_deleted_recordings +
--       an ingress lookup (in rest-api) + an un-delete route.
--   search — q= over segment text was silently ignored → pg_trgm word_similarity RPC.
--
-- Design notes banked from review:
--  [A] delete+tombstone as ONE data-modifying CTE so tombstoned-set == deleted-set.
--  [B] tombstone table has NO FK to plaud_recordings (a self-referencing FK would
--      cascade the tombstone away or roll the delete back). Standalone, PK = recording_id.
--  [C] tombstone insert is ON CONFLICT DO UPDATE (un-delete → re-drain → re-delete must
--      not unique_violation and roll the delete back = a permanently-undeletable row).
--  [D] purge ceiling enforced INSIDE the fn on the RETURNING count (GET DIAGNOSTICS),
--      RAISE over ceiling → whole txn rolls back; no client-side TOCTOU count-then-delete.

-- ── Tombstone table [B] ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.plaud_deleted_recordings (
  recording_id            TEXT PRIMARY KEY,                 -- NO FK by design [B]; PK btree serves the ingress lookup
  deleted_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  review_status_at_delete TEXT,
  deleted_via             TEXT NOT NULL DEFAULT 'single'    -- 'single' | 'purge'
);
-- Secure-by-design: RLS on, no policy ⇒ anon/authenticated denied; service_role (rest-api) bypasses.
ALTER TABLE public.plaud_deleted_recordings ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.plaud_deleted_recordings TO service_role;

-- ── Transcript search index (pg_trgm; trusted=TRUE on this server, verified live) ─
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS idx_plaud_segments_text_trgm
  ON public.plaud_speaker_segments USING gin (text gin_trgm_ops);

-- ── Atomic ingress replace [#4] ───────────────────────────────────────────────
-- rest-api builds recRow/segRows/speakerRows exactly as before (all defaulting/
-- validation unchanged) and passes them as jsonb; the DML moves here so the
-- delete-segments + insert-segments pair is ONE transaction. If any insert fails,
-- the deletes roll back and the recording keeps its existing segments.
CREATE OR REPLACE FUNCTION public.plaud_ingest_replace(
  p_recording jsonb, p_segments jsonb, p_speakers jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_rid text := p_recording->>'recording_id';
        v_seg int; v_spk int;
BEGIN
  IF v_rid IS NULL OR v_rid = '' THEN
    RAISE EXCEPTION 'recording_id is required' USING errcode = 'check_violation';
  END IF;

  INSERT INTO plaud_recordings
    (recording_id, title, started_at, duration_ms, audio_ref, review_status, metadata, updated_at)
  VALUES (
    v_rid,
    p_recording->>'title',
    NULLIF(p_recording->>'started_at','')::timestamptz,
    NULLIF(p_recording->>'duration_ms','')::bigint,
    p_recording->>'audio_ref',
    COALESCE(p_recording->>'review_status','pending_review'),
    COALESCE(p_recording->'metadata','{}'::jsonb),
    COALESCE(NULLIF(p_recording->>'updated_at','')::timestamptz, now())
  )
  ON CONFLICT (recording_id) DO UPDATE SET
    title=excluded.title, started_at=excluded.started_at, duration_ms=excluded.duration_ms,
    audio_ref=excluded.audio_ref, review_status=excluded.review_status,
    metadata=excluded.metadata, updated_at=excluded.updated_at;

  DELETE FROM plaud_speaker_segments  WHERE recording_id = v_rid;
  DELETE FROM plaud_recording_speakers WHERE recording_id = v_rid;

  INSERT INTO plaud_speaker_segments
    (recording_id, idx, start_ms, end_ms, speaker_key, resolved_name_override,
     match_confidence, overlap, excluded, text_edited, text)
  SELECT recording_id, idx, start_ms, end_ms, speaker_key, resolved_name_override,
         match_confidence, overlap, COALESCE(excluded,false), COALESCE(text_edited,false), text
  FROM jsonb_to_recordset(COALESCE(p_segments,'[]'::jsonb)) AS x(
    recording_id text, idx int, start_ms bigint, end_ms bigint, speaker_key text,
    resolved_name_override text, match_confidence real, overlap real,
    excluded boolean, text_edited boolean, text text);
  GET DIAGNOSTICS v_seg = ROW_COUNT;

  INSERT INTO plaud_recording_speakers
    (recording_id, speaker_key, resolved_name, match_confidence, enrolled, updated_at)
  SELECT recording_id, speaker_key, resolved_name, match_confidence,
         COALESCE(enrolled,false), COALESCE(updated_at, now())
  FROM jsonb_to_recordset(COALESCE(p_speakers,'[]'::jsonb)) AS x(
    recording_id text, speaker_key text, resolved_name text,
    match_confidence real, enrolled boolean, updated_at timestamptz);
  GET DIAGNOSTICS v_spk = ROW_COUNT;

  RETURN jsonb_build_object('recording_id', v_rid, 'segments', v_seg, 'speakers', v_spk);
END $$;

-- ── Atomic single delete + tombstone [A][C] ──────────────────────────────────
CREATE OR REPLACE FUNCTION public.plaud_delete_recording(
  p_recording_id text, p_deleted_via text DEFAULT 'single'
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_status text;
BEGIN
  WITH gone AS (
    DELETE FROM plaud_recordings WHERE recording_id = p_recording_id
    RETURNING recording_id, review_status
  )
  INSERT INTO plaud_deleted_recordings (recording_id, deleted_at, review_status_at_delete, deleted_via)
  SELECT recording_id, now(), review_status, p_deleted_via FROM gone
  ON CONFLICT (recording_id) DO UPDATE SET
    deleted_at = excluded.deleted_at,
    review_status_at_delete = excluded.review_status_at_delete,
    deleted_via = excluded.deleted_via
  RETURNING review_status_at_delete INTO v_status;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('deleted', false);
  END IF;
  RETURN jsonb_build_object('deleted', true, 'review_status_at_delete', v_status);
END $$;

-- ── Atomic bulk purge + tombstone, with in-fn ceiling + confirm token [A][C][D] ─
-- confirm_token must equal the review_status being purged (explicit intent), and the
-- deleted count must not exceed max_delete or the whole txn rolls back (nothing deleted).
CREATE OR REPLACE FUNCTION public.plaud_purge_recordings(
  p_review_status text, p_max_delete int DEFAULT 25, p_confirm_token text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_ids text[]; v_count int;
BEGIN
  IF p_confirm_token IS DISTINCT FROM p_review_status THEN
    RAISE EXCEPTION 'purge confirm_token must equal review_status (got %)', p_confirm_token
      USING errcode = 'check_violation';
  END IF;

  WITH gone AS (
    DELETE FROM plaud_recordings WHERE review_status = p_review_status
    RETURNING recording_id, review_status
  ), ins AS (
    INSERT INTO plaud_deleted_recordings (recording_id, deleted_at, review_status_at_delete, deleted_via)
    SELECT recording_id, now(), review_status, 'purge' FROM gone
    ON CONFLICT (recording_id) DO UPDATE SET
      deleted_at = excluded.deleted_at,
      review_status_at_delete = excluded.review_status_at_delete,
      deleted_via = excluded.deleted_via
    RETURNING recording_id
  )
  SELECT array_agg(recording_id), count(*) INTO v_ids, v_count FROM ins;
  v_count := COALESCE(v_count, 0);

  IF v_count > p_max_delete THEN
    RAISE EXCEPTION 'purge ceiling exceeded: % rows > max_delete %', v_count, p_max_delete
      USING errcode = 'check_violation';
  END IF;

  RETURN jsonb_build_object(
    'deleted', v_count,
    'recording_ids', COALESCE(to_jsonb(v_ids), '[]'::jsonb),
    'review_status', p_review_status);
END $$;

-- ── Transcript search over segments.text (word_similarity, short-needle-in-long) ─
-- Operator direction is load-bearing: `p_q <% s.text` == word_similarity(p_q, s.text) >=
-- threshold == "the QUERY needle appears within the SEGMENT haystack" — the same metric
-- the ORDER BY / returned column use. (The commutator `%>` would test the reverse — whole
-- segment inside the short query — and would only match unusually SHORT segments.)
CREATE OR REPLACE FUNCTION public.plaud_search_transcripts(
  p_q text, p_limit int DEFAULT 50
) RETURNS TABLE(
  recording_id text, idx int, start_ms bigint, speaker_key text,
  resolved_name text, snippet text, similarity real, title text, started_at timestamptz
) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  -- Lower the word_similarity floor from the 0.6 default so a half-remembered /
  -- mistyped phrase still matches; local to this txn only.
  PERFORM set_config('pg_trgm.word_similarity_threshold', '0.3', true);
  RETURN QUERY
    SELECT s.recording_id, s.idx, s.start_ms, s.speaker_key,
           COALESCE(s.resolved_name_override, sp.resolved_name) AS resolved_name,
           s.text AS snippet,
           word_similarity(p_q, s.text) AS similarity,
           r.title, r.started_at
    FROM plaud_speaker_segments s
    JOIN plaud_recordings r ON r.recording_id = s.recording_id
    LEFT JOIN plaud_recording_speakers sp
      ON sp.recording_id = s.recording_id AND sp.speaker_key = s.speaker_key
    WHERE s.text IS NOT NULL AND p_q <% s.text
    ORDER BY word_similarity(p_q, s.text) DESC, s.recording_id, s.idx
    LIMIT GREATEST(1, LEAST(500, p_limit));
END $$;

-- Secure-by-design: lock EXECUTE to service_role (rest-api), deny the public roles.
REVOKE EXECUTE ON FUNCTION public.plaud_ingest_replace(jsonb, jsonb, jsonb)  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.plaud_delete_recording(text, text)         FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.plaud_purge_recordings(text, int, text)    FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.plaud_search_transcripts(text, int)        FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.plaud_ingest_replace(jsonb, jsonb, jsonb)  TO service_role;
GRANT  EXECUTE ON FUNCTION public.plaud_delete_recording(text, text)         TO service_role;
GRANT  EXECUTE ON FUNCTION public.plaud_purge_recordings(text, int, text)    TO service_role;
GRANT  EXECUTE ON FUNCTION public.plaud_search_transcripts(text, int)        TO service_role;

NOTIFY pgrst, 'reload schema';
