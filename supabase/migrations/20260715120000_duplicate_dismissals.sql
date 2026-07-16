-- Duplicate-dismissal ("not a duplicate") mechanism.
--
-- brain_duplicates_find recomputes pgvector cosine similarity over ALL thought
-- pairs on every call and returns everything >= threshold. It has no memory, so
-- a pair that is genuinely distinct but semantically near-identical (e.g.
-- #400/#401 — two separate write-ups of "How FCA Consumer Duty Shapes AI Work
-- at the company") resurfaces in the dashboard /duplicates view and the
-- daily hygiene glance FOREVER. This adds a persistent dismissal list and
-- teaches the RPC to exclude dismissed pairs, silencing them across BOTH
-- consumers at once (rest-api /duplicates -> dashboard, and MCP find_duplicates
-- -> curator report), since both call this one RPC.

CREATE TABLE IF NOT EXISTS public.duplicate_dismissals (
  serial_lo    BIGINT NOT NULL,          -- always the smaller serial_id of the pair
  serial_hi    BIGINT NOT NULL,          -- always the larger serial_id of the pair
  dismissed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  dismissed_by TEXT,                      -- who marked it (dashboard | agent | the operator | ...)
  reason       TEXT,                      -- optional free-text note
  PRIMARY KEY (serial_lo, serial_hi),
  CONSTRAINT duplicate_dismissals_ordered CHECK (serial_lo < serial_hi)
);

GRANT SELECT, INSERT, DELETE ON public.duplicate_dismissals
  TO authenticated, anon, service_role;

-- Patch the finder to exclude dismissed pairs. Identical signature + return
-- shape to 20260606010300 (bigint serials, content_a/content_b) — the only new
-- clause is the NOT EXISTS against duplicate_dismissals. The join guarantees
-- a.serial_id < b.serial_id, so (a=serial_lo, b=serial_hi) matches directly.
DROP FUNCTION IF EXISTS brain_duplicates_find(DOUBLE PRECISION, INTEGER, TEXT);

CREATE OR REPLACE FUNCTION brain_duplicates_find(
  p_threshold DOUBLE PRECISION DEFAULT 0.85,
  p_limit INTEGER DEFAULT 50,
  p_classification TEXT DEFAULT NULL
)
RETURNS TABLE (
  thought_a_id UUID,
  thought_b_id UUID,
  thought_a_serial BIGINT,
  thought_b_serial BIGINT,
  content_a TEXT,
  content_b TEXT,
  similarity DOUBLE PRECISION,
  thought_a_created TIMESTAMPTZ,
  thought_b_created TIMESTAMPTZ
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, extensions
AS $$
BEGIN
  RETURN QUERY
  WITH candidates AS (
    SELECT id, serial_id, content, embedding, created_at, classification, sensitivity_tier
    FROM public.thoughts
    WHERE embedding IS NOT NULL
      AND sensitivity_tier IS DISTINCT FROM 'restricted'
      AND (p_classification IS NULL OR classification = p_classification)
  )
  SELECT
    a.id AS thought_a_id,
    b.id AS thought_b_id,
    a.serial_id AS thought_a_serial,
    b.serial_id AS thought_b_serial,
    left(a.content, 200) AS content_a,
    left(b.content, 200) AS content_b,
    (1 - (a.embedding <=> b.embedding))::double precision AS similarity,
    a.created_at AS thought_a_created,
    b.created_at AS thought_b_created
  FROM candidates a
  JOIN candidates b ON a.serial_id < b.serial_id
  WHERE (1 - (a.embedding <=> b.embedding)) >= p_threshold
    AND NOT EXISTS (
      SELECT 1 FROM public.duplicate_dismissals d
      WHERE d.serial_lo = a.serial_id AND d.serial_hi = b.serial_id
    )
  ORDER BY similarity DESC
  LIMIT p_limit;
END;
$$;

GRANT EXECUTE ON FUNCTION brain_duplicates_find(DOUBLE PRECISION, INTEGER, TEXT)
  TO authenticated, anon, service_role;

NOTIFY pgrst, 'reload schema';
