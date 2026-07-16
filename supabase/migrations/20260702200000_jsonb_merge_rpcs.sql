-- A3 gap-review G8: server-side JSONB merge for metadata writes.
--
-- Problem: every writer (rest-api approve/escalation paths, the worker, the
-- webhook, future the Hermes agent routines) updated `metadata` by read-modify-write of
-- the WHOLE object. Two concurrent writers lost-update each other — the
-- 2026-07-01 #5676 incident: /review/approve set review_status=approved while
-- the worker wrote entity_extracted_at; one clobbered the other and a live
-- thought stayed stuck "pending_review".
--
-- Fix: one atomic UPDATE per patch, computed in Postgres:
--     metadata = (coalesce(metadata,'{}') - p_remove_keys) || p_patch
-- Concurrent patches serialize on the row lock and BOTH survive (unless they
-- write the same key, where last-wins is the correct semantic).
--
-- p_patch:       keys to set/overwrite (top-level merge, jsonb || semantics)
-- p_remove_keys: keys to delete (applied BEFORE the patch)
-- Returns the resulting metadata so callers can read-back without a second query.

create or replace function public.merge_thought_metadata(
  p_thought_id uuid,
  p_patch jsonb default '{}'::jsonb,
  p_remove_keys text[] default '{}'::text[]
) returns jsonb
language sql
security definer
set search_path = public
as $$
  update public.thoughts
     set metadata = (coalesce(metadata, '{}'::jsonb) - p_remove_keys) || coalesce(p_patch, '{}'::jsonb),
         updated_at = now()
   where id = p_thought_id
   returning metadata;
$$;

create or replace function public.merge_entity_metadata(
  p_entity_id bigint,
  p_patch jsonb default '{}'::jsonb,
  p_remove_keys text[] default '{}'::text[]
) returns jsonb
language sql
security definer
set search_path = public
as $$
  update public.entities
     set metadata = (coalesce(metadata, '{}'::jsonb) - p_remove_keys) || coalesce(p_patch, '{}'::jsonb),
         updated_at = now()
   where id = p_entity_id
   returning metadata;
$$;

create or replace function public.merge_edge_metadata(
  p_edge_id bigint,
  p_patch jsonb default '{}'::jsonb,
  p_remove_keys text[] default '{}'::text[]
) returns jsonb
language sql
security definer
set search_path = public
as $$
  update public.edges
     set metadata = (coalesce(metadata, '{}'::jsonb) - p_remove_keys) || coalesce(p_patch, '{}'::jsonb)
   where id = p_edge_id
   returning metadata;
$$;

-- Edge Functions call with the service key; keep execution tight anyway.
revoke all on function public.merge_thought_metadata(uuid, jsonb, text[]) from public;
revoke all on function public.merge_entity_metadata(bigint, jsonb, text[]) from public;
revoke all on function public.merge_edge_metadata(bigint, jsonb, text[]) from public;
grant execute on function public.merge_thought_metadata(uuid, jsonb, text[]) to service_role;
grant execute on function public.merge_entity_metadata(bigint, jsonb, text[]) to service_role;
grant execute on function public.merge_edge_metadata(bigint, jsonb, text[]) to service_role;
