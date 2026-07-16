-- A3 gap G1: consumer-side claim semantics for entity_extraction_queue.
--
-- The queue + its thought-write trigger are the system's universal intake
-- ledger; the worker consumed it via direct DB access. For the Hermes agent (REST-only)
-- to take over as the extraction/enrichment consumer, the queue needs an
-- atomic batch-claim with crash-recovery leases. Shape agreed with WSL
-- (2026-07-02): batch claim, 15-min lease, attempts cap 3 (poison guard,
-- explicit reset only), work-context embedded in the claim response,
-- curator_note rows first then FIFO, claimed_by persisted for observability
-- (future Open Engine consumers use the same pattern).

alter table public.entity_extraction_queue
  add column if not exists claimed_by text,
  add column if not exists lease_expires_at timestamptz;

create or replace function public.claim_extraction_batch(
  p_claimed_by text,
  p_limit int default 1,
  p_lease_minutes int default 15,
  p_max_attempts int default 3
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_reclaimed int := 0;
  v_rows jsonb;
begin
  -- 1) Reclaim expired leases: a crashed consumer turn must not hold a row
  --    forever. Back to pending with attempts++; 'failed' at the cap so a
  --    poison thought can't burn tokens indefinitely (explicit reset only).
  with expired as (
    select thought_id
      from entity_extraction_queue
     where status = 'processing'
       and lease_expires_at is not null
       and lease_expires_at < now()
       for update skip locked
  ), bumped as (
    update entity_extraction_queue q
       set attempt_count    = coalesce(q.attempt_count, 0) + 1,
           status           = case when coalesce(q.attempt_count, 0) + 1 >= p_max_attempts
                                   then 'failed' else 'pending' end,
           last_error       = left(coalesce(q.last_error, '') || ' [lease expired: ' || coalesce(q.claimed_by,'?') || ']', 500),
           claimed_by       = null,
           lease_expires_at = null
      from expired e
     where q.thought_id = e.thought_id
     returning 1
  )
  select count(*) into v_reclaimed from bumped;

  -- 2) Atomically claim up to p_limit pending rows. Curator notes first
  --    (explicit human action), then FIFO. SKIP LOCKED = concurrent claimers
  --    never double-claim.
  with picked as (
    select q.thought_id
      from entity_extraction_queue q
      join thoughts t on t.id = q.thought_id
     where q.status = 'pending'
     order by (t.source_type = 'curator_note') desc, q.queued_at asc nulls last
     limit greatest(coalesce(p_limit, 1), 1)
       for update of q skip locked
  ), claimed as (
    update entity_extraction_queue q
       set status           = 'processing',
           claimed_by       = p_claimed_by,
           started_at       = now(),
           lease_expires_at = now() + make_interval(mins => greatest(coalesce(p_lease_minutes, 15), 1))
      from picked p
     where q.thought_id = p.thought_id
     returning q.thought_id, q.attempt_count, q.queued_at, q.lease_expires_at
  )
  -- Embed the full work context so a consumer turn needs zero extra GETs
  -- (source_type visible for the curator_note aggressive-mode switch).
  select coalesce(jsonb_agg(jsonb_build_object(
           'thought_id',       c.thought_id,
           'attempt_count',    c.attempt_count,
           'queued_at',        c.queued_at,
           'lease_expires_at', c.lease_expires_at,
           'thought', jsonb_build_object(
             'serial_id',      t.serial_id,
             'content',        t.content,
             'type',           t.type,
             'classification', t.classification,
             'source_type',    t.source_type,
             'created_at',     t.created_at,
             'metadata',       t.metadata
           )
         )), '[]'::jsonb)
    into v_rows
    from claimed c
    join thoughts t on t.id = c.thought_id;

  return jsonb_build_object('claimed', v_rows, 'reclaimed_expired', v_reclaimed);
end;
$$;

revoke all on function public.claim_extraction_batch(text, int, int, int) from public;
grant execute on function public.claim_extraction_batch(text, int, int, int) to service_role;
