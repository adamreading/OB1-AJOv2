-- Gatekeeper GK T8 (the operator-signed-off 2026-07-05): direct-write curation queue.
--
-- Under the gatekeeper model the Hermes agent curates EVERYTHING inbound. Two paths already
-- flow through him: Plaud/MCP captures land review_status='pending_review' and
-- are curated on approve → ob_drain. But writes that land LIVE on arrival —
-- external GPTs (Copilot etc.) writing straight to Supabase, and bare /capture
-- — skip that gate entirely: no type/status/classification/action_items, never
-- curated. This queue catches them so a the Hermes agent runner re-curates ASAP.
--
-- Mechanism: an AFTER INSERT trigger on thoughts enqueues any row that is
-- live-on-arrival (review_status <> 'pending_review') and not an internal
-- synthetic (curator_note). ob_drain does NOT trip it — approved thoughts were
-- INSERTed earlier as pending_review (excluded), and ob_drain only UPDATEs.
-- Re-curation UPDATEs the thought, so the INSERT-only trigger can't loop.
-- The core thoughts write path is untouched (no column added, no row mutated)
-- per the "never modify thoughts structure" guard + the disk-IO lesson.
--
-- Consumer semantics mirror wiki_regen_queue exactly: atomic SKIP LOCKED batch
-- claim, crash-recovery lease, attempts cap, explicit reset. IDLE-GUARD: the
-- the Hermes agent-side drainer must yield to his live conversation (ob_lib.may_run_heavy)
-- — enforced in the runner, not here; this queue is passive (the Hermes agent pulls).

create table if not exists public.curation_queue (
  id               bigserial primary key,
  thought_id       uuid not null references public.thoughts(id) on delete cascade,
  source_type      text,                 -- captured at enqueue for triage/priority
  reason           text,                 -- 'direct_external_write' | ...
  status           text not null default 'pending',  -- pending|processing|complete|failed
  claimed_by       text,
  lease_expires_at timestamptz,
  attempt_count    int not null default 0,
  last_error       text,
  queued_at        timestamptz not null default now(),
  processed_at     timestamptz
);

-- One active curation request per thought (re-inserts / retries dedupe).
create unique index if not exists curation_queue_active_uq
  on public.curation_queue (thought_id) where status in ('pending', 'processing');
create index if not exists curation_queue_status_idx on public.curation_queue (status, queued_at);

-- AFTER INSERT trigger: enqueue live-on-arrival thoughts for the Hermes agent curation.
create or replace function public.enqueue_curation_on_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Skip the already-curated path: pending-review captures get curated on approve.
  if coalesce(new.metadata->>'review_status', '') = 'pending_review' then
    return new;
  end if;
  -- Skip internal synthetics that are curated by definition.
  if coalesce(new.source_type, '') = 'curator_note' then
    return new;
  end if;
  -- Skip system-generated artifacts (consolidation outputs, bios) — same
  -- exclusion as trg_queue_entity_extraction; these are not user captures.
  if (new.metadata->>'generated_by') is not null then
    return new;
  end if;
  -- Skip if the enrichment pipeline already stamped it (defensive; ob_drain
  -- UPDATEs so this rarely applies at INSERT, but a backfilled insert might).
  if (new.metadata ? 'entity_extracted_at') then
    return new;
  end if;
  -- NOTE (reconciled w/ WSL 2026-07-05): rows caught here ALSO hit
  -- entity_extraction_queue via trg_queue_entity_extraction, so ob_drain WILL
  -- enrich them (type/status/classification/importance/entities) — that trigger
  -- does not gate on review_status. curation_queue is therefore NOT a parallel
  -- enricher: its drainer (the Hermes agent) does the CURATION JUDGMENT ob_drain never does
  -- (ignore junk / dedup against existing / update-vs-new), reusing ob_drain's
  -- enrichment as the single source of truth for type/class. This queue just
  -- guarantees a direct-write that skipped the A2 intake judge still gets one.

  insert into public.curation_queue (thought_id, source_type, reason)
  values (new.id, new.source_type, 'direct_external_write')
  on conflict (thought_id) where status in ('pending', 'processing') do nothing;

  return new;
end;
$$;

drop trigger if exists trg_enqueue_curation on public.thoughts;
create trigger trg_enqueue_curation
  after insert on public.thoughts
  for each row execute function public.enqueue_curation_on_insert();

-- Atomic batch claim — identical shape to claim_wiki_regen_batch, embeds the
-- thought's current content/type/status/classification so the Hermes agent curates in one
-- round-trip.
create or replace function public.claim_curation_batch(
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
  with expired as (
    select id from curation_queue
     where status = 'processing' and lease_expires_at is not null and lease_expires_at < now()
       for update skip locked
  ), bumped as (
    update curation_queue q
       set attempt_count    = q.attempt_count + 1,
           status           = case when q.attempt_count + 1 >= p_max_attempts then 'failed' else 'pending' end,
           last_error       = left(coalesce(q.last_error, '') || ' [lease expired: ' || coalesce(q.claimed_by, '?') || ']', 500),
           claimed_by       = null,
           lease_expires_at = null
      from expired e where q.id = e.id
      returning 1
  )
  select count(*) into v_reclaimed from bumped;

  with picked as (
    select q.id from curation_queue q
     where q.status = 'pending'
     order by q.queued_at asc
     limit greatest(coalesce(p_limit, 1), 1)
       for update skip locked
  ), claimed as (
    update curation_queue q
       set status = 'processing', claimed_by = p_claimed_by,
           lease_expires_at = now() + make_interval(mins => greatest(coalesce(p_lease_minutes, 15), 1))
      from picked p where q.id = p.id
      returning q.id, q.thought_id, q.source_type, q.reason, q.attempt_count, q.queued_at, q.lease_expires_at
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id',               c.id,
           'thought_id',       c.thought_id,
           'serial_id',        t.serial_id,
           'source_type',      c.source_type,
           'reason',           c.reason,
           'attempt_count',    c.attempt_count,
           'queued_at',        c.queued_at,
           'lease_expires_at', c.lease_expires_at,
           'content',          t.content,
           'current_type',     t.type,
           'current_status',   t.status,
           'current_classification', t.classification,
           'metadata',         t.metadata
         )), '[]'::jsonb)
    into v_rows
    from claimed c
    left join thoughts t on t.id = c.thought_id;

  return jsonb_build_object('claimed', v_rows, 'reclaimed_expired', v_reclaimed);
end;
$$;

revoke all on function public.claim_curation_batch(text, int, int, int) from public;
grant execute on function public.claim_curation_batch(text, int, int, int) to service_role;
