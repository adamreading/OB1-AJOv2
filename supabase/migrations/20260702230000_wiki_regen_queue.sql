-- A3 G3 / build-order #4b: wiki regen requests become the Hermes agent queue-work.
--
-- The old POST /wiki-pages/:slug/regen re-queued a thought for the WORKER to
-- pick up and recompile the page on drain. The worker's wiki step is now gated
-- off (the Hermes agent authors pages), so regen requests need a home the Hermes agent drains like any
-- other work. The operator's ruling: simple, same-priority queue work — standalone
-- table now, folds into Open Engine's agent_tasks later.
--
-- Same consumer semantics as entity_extraction_queue: atomic SKIP LOCKED
-- batch claim, crash-recovery lease, attempts cap, explicit reset. One active
-- request per entity (dashboard button mashing dedupes).

create table if not exists public.wiki_regen_queue (
  id               bigserial primary key,
  entity_id        bigint not null,
  slug             text,
  requested_by     text,                 -- 'dashboard' | 'hermes-agent' | 'agent_api' | ...
  reason           text,
  status           text not null default 'pending',  -- pending|processing|complete|failed
  claimed_by       text,
  lease_expires_at timestamptz,
  attempt_count    int not null default 0,
  last_error       text,
  queued_at        timestamptz not null default now(),
  processed_at     timestamptz
);

create unique index if not exists wiki_regen_active_uq
  on public.wiki_regen_queue (entity_id) where status in ('pending', 'processing');
create index if not exists wiki_regen_status_idx on public.wiki_regen_queue (status, queued_at);

create or replace function public.claim_wiki_regen_batch(
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
  -- Reclaim expired leases (crashed consumer): attempts++, failed at cap.
  with expired as (
    select id from wiki_regen_queue
     where status = 'processing' and lease_expires_at is not null and lease_expires_at < now()
       for update skip locked
  ), bumped as (
    update wiki_regen_queue q
       set attempt_count    = q.attempt_count + 1,
           status           = case when q.attempt_count + 1 >= p_max_attempts then 'failed' else 'pending' end,
           last_error       = left(coalesce(q.last_error, '') || ' [lease expired: ' || coalesce(q.claimed_by, '?') || ']', 500),
           claimed_by       = null,
           lease_expires_at = null
      from expired e where q.id = e.id
      returning 1
  )
  select count(*) into v_reclaimed from bumped;

  -- FIFO claim with work context (entity + current page state) embedded.
  with picked as (
    select q.id from wiki_regen_queue q
     where q.status = 'pending'
     order by q.queued_at asc
     limit greatest(coalesce(p_limit, 1), 1)
       for update skip locked
  ), claimed as (
    update wiki_regen_queue q
       set status = 'processing', claimed_by = p_claimed_by,
           lease_expires_at = now() + make_interval(mins => greatest(coalesce(p_lease_minutes, 15), 1))
      from picked p where q.id = p.id
      returning q.id, q.entity_id, q.slug, q.requested_by, q.reason, q.attempt_count, q.queued_at, q.lease_expires_at
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id',               c.id,
           'entity_id',        c.entity_id,
           'slug',             coalesce(c.slug, w.slug),
           'requested_by',     c.requested_by,
           'reason',           c.reason,
           'attempt_count',    c.attempt_count,
           'queued_at',        c.queued_at,
           'lease_expires_at', c.lease_expires_at,
           'entity', case when e.id is null then null else jsonb_build_object(
             'canonical_name', e.canonical_name, 'entity_type', e.entity_type, 'aliases', e.aliases) end,
           'page_exists',      (w.slug is not null),
           'page_generated_at', w.generated_at
         )), '[]'::jsonb)
    into v_rows
    from claimed c
    left join entities  e on e.id = c.entity_id
    left join wiki_pages w on w.entity_id = c.entity_id;

  return jsonb_build_object('claimed', v_rows, 'reclaimed_expired', v_reclaimed);
end;
$$;

revoke all on function public.claim_wiki_regen_batch(text, int, int, int) from public;
grant execute on function public.claim_wiki_regen_batch(text, int, int, int) to service_role;
