-- A3 gap G8 / build-order #3: graph audit trail — gates the Hermes agent auto-merge.
--
-- thought_versions gives thoughts reversibility; the GRAPH (entities/edges)
-- had none: a bad merge/rename/type-change/delete was invisible after the
-- fact, and the only undo was the coarse alias remove_and_resplit. Before
-- the Hermes agent is allowed to auto-merge entities, every semantic graph mutation must
-- be reviewable with full before/after state.
--
-- Design: AFTER triggers on entities + edges (NOT app-code instrumentation)
-- so every writer is covered — rest-api, the worker (direct DB), future the Hermes agent
-- routines, manual SQL. Noise is filtered in the trigger:
--   * entities UPDATE that only touches last_seen_at/updated_at (worker bumps
--     these on every extraction) → skipped
--   * edges UPDATE that only touches support_count/confidence (the
--     maintain_edge_support_count trigger churns these constantly) → skipped
--   * entity INSERTs → skipped (additive, high volume, visible in the row)
-- What lands: entity rename / type change / alias change (incl. absorbs) /
-- metadata change / pin / DELETE; edge INSERT / relation-metadata UPDATE /
-- DELETE. thought_entities is deliberately not audited (pure link churn,
-- reconstructable from provenance).

create table if not exists public.graph_audit (
  id          bigserial primary key,
  created_at  timestamptz not null default now(),
  table_name  text not null,          -- 'entities' | 'edges'
  op          text not null,          -- 'INSERT' | 'UPDATE' | 'DELETE'
  row_id      bigint,                 -- entities.id or edges.id
  actor       text,                   -- best-effort: current_setting('app.actor'), else null
  before      jsonb,
  after       jsonb,
  details     jsonb                   -- quick-filter fields (names, endpoints, relation)
);

create index if not exists graph_audit_created_idx on public.graph_audit (created_at desc);
create index if not exists graph_audit_row_idx     on public.graph_audit (table_name, row_id);

create or replace function public.audit_graph_row()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_before jsonb := case when tg_op = 'INSERT' then null else to_jsonb(old) end;
  v_after  jsonb := case when tg_op = 'DELETE' then null else to_jsonb(new) end;
  v_row_id bigint := coalesce((case when tg_op = 'DELETE' then old.id else new.id end), null);
  v_details jsonb := '{}'::jsonb;
begin
  if tg_table_name = 'entities' then
    if tg_op = 'UPDATE' then
      -- Skip churn-only updates (last_seen_at / updated_at bumps).
      if (v_before - 'last_seen_at' - 'updated_at') = (v_after - 'last_seen_at' - 'updated_at') then
        return null;
      end if;
    end if;
    v_details := jsonb_build_object(
      'canonical_name', coalesce(v_after->>'canonical_name', v_before->>'canonical_name'),
      'entity_type',    coalesce(v_after->>'entity_type',    v_before->>'entity_type')
    );
  elsif tg_table_name = 'edges' then
    if tg_op = 'UPDATE' then
      -- Skip support-count/confidence churn from the provenance roll-up trigger.
      if (v_before - 'support_count' - 'confidence' - 'updated_at') = (v_after - 'support_count' - 'confidence' - 'updated_at') then
        return null;
      end if;
    end if;
    v_details := jsonb_build_object(
      'from_entity_id', coalesce(v_after->'from_entity_id', v_before->'from_entity_id'),
      'to_entity_id',   coalesce(v_after->'to_entity_id',   v_before->'to_entity_id'),
      'relation',       coalesce(v_after->>'relation',      v_before->>'relation')
    );
  end if;

  insert into public.graph_audit (table_name, op, row_id, actor, before, after, details)
  values (tg_table_name, tg_op, v_row_id, nullif(current_setting('app.actor', true), ''), v_before, v_after, v_details);
  return null;
end;
$$;

-- entities: semantic updates + deletes (inserts are additive noise).
drop trigger if exists trg_audit_entities on public.entities;
create trigger trg_audit_entities
  after update or delete on public.entities
  for each row execute function public.audit_graph_row();

-- edges: full lifecycle (inserts matter — manual/inferred assertions).
drop trigger if exists trg_audit_edges on public.edges;
create trigger trg_audit_edges
  after insert or update or delete on public.edges
  for each row execute function public.audit_graph_row();
