-- OPEN ENGINE v1 — shared agent work-queue for Open Brain.
-- A protocol (adapted from Nate B Jones's Linear-based agent workflow onto
-- Supabase Postgres) that lets multiple AI agents find assigned work, claim
-- exactly one task at a time (claim-lock), do scoped work, leave standardized
-- receipts, pause cleanly (blocked-on-task vs human-hold), resume correctly, and
-- keep a shared status ledger current.
--
-- Deliberately SEPARATE from the `thoughts` table / Kanban: this tracks agent
-- WORK, not brain content.
--
-- Apply with:  supabase db push   (or run this file against your database)

create table if not exists public.agent_tasks (
  id                    bigserial primary key,
  agent_code            text not null,           -- assignee; 'all' = any agent may claim
  title                 text not null,
  body                  text,
  task_kind             text not null default 'task'
                        check (task_kind in ('standing','task','standing_skill')),
  status                text not null default 'todo'
                        check (status in ('standing','todo','working','needs_input','review','done')),
  claimed_by            text,
  claimed_at            timestamptz,
  priority              int not null default 0,  -- higher = more urgent
  parent_id             bigint references public.agent_tasks(id) on delete set null,  -- delegation
  blocked_reason        text,                    -- blocked ON-TASK (answer arrives on the task)
  hold_reason           text,                    -- HUMAN_HOLD (answer arrives in the operator's thread)
  local_context_version text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  status_updated_at     timestamptz not null default now()
);
create index if not exists agent_tasks_code_status_idx on public.agent_tasks (agent_code, status);
create index if not exists agent_tasks_todo_idx on public.agent_tasks (status, priority desc, created_at asc);

create table if not exists public.agent_task_receipts (
  id           bigserial primary key,
  task_id      bigint not null references public.agent_tasks(id) on delete cascade,
  agent_code   text not null,
  receipt_type text not null
               check (receipt_type in ('CLAIMED','DONE','BLOCKED','UNBLOCKED','HUMAN_HOLD',
                                       'HUMAN_ANSWERED','RESUMED','FAILED','APPLIED','FOLLOW_UP')),
  body         text,
  created_at   timestamptz not null default now()
);
create index if not exists agent_task_receipts_task_idx on public.agent_task_receipts (task_id, created_at);

create table if not exists public.agent_status_ledger (
  agent_code            text primary key,
  human_operator        text,
  runtime               text,
  automation            text,
  automation_state      text,
  last_heartbeat        timestamptz,
  last_queue_result     text,
  last_successful_run   timestamptz,
  local_context_version text,
  optional_skills       jsonb not null default '[]'::jsonb,
  notes                 text,
  updated_at            timestamptz not null default now()
);

-- Atomic claim-lock. Empty return = the task was already claimed (someone else won).
create or replace function public.claim_agent_task(
  p_id bigint,
  p_agent_code text
) returns setof public.agent_tasks
language sql
security definer
set search_path = public
as $$
  update public.agent_tasks
     set status = 'working', claimed_by = p_agent_code, claimed_at = now(),
         updated_at = now(), status_updated_at = now()
   where id = p_id and status = 'todo'
   returning *;
$$;

-- Claim-next: oldest eligible todo for this agent_code (or 'all'), priority-first,
-- atomically — closes the pick-then-claim race for runner loops. FOR UPDATE SKIP
-- LOCKED so concurrent runners never collide on the same row.
create or replace function public.claim_next_agent_task(
  p_agent_code text
) returns setof public.agent_tasks
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id bigint;
begin
  select id into v_id
    from public.agent_tasks
   where status = 'todo' and (agent_code = p_agent_code or agent_code = 'all')
   order by priority desc, created_at asc
   limit 1
     for update skip locked;
  if v_id is null then return; end if;
  return query
  update public.agent_tasks
     set status = 'working', claimed_by = p_agent_code, claimed_at = now(),
         updated_at = now(), status_updated_at = now()
   where id = v_id
   returning *;
end;
$$;

revoke all on function public.claim_agent_task(bigint, text) from public;
revoke all on function public.claim_next_agent_task(text) from public;
grant execute on function public.claim_agent_task(bigint, text) to service_role;
grant execute on function public.claim_next_agent_task(text) to service_role;

-- Seed the ledger with your agent registry. Example (edit to match your fleet):
insert into public.agent_status_ledger (agent_code, human_operator, runtime, automation)
values
  ('orchestrator', 'operator', 'always-on daemon',              'cron-capable'),
  ('worker-a',     'operator', 'Claude Code (host A)',          'poll+run'),
  ('worker-b',     'operator', 'Claude Code (host B)',          'poll+run'),
  ('assistant',    'operator', 'MCP client',                    'human-driven')
on conflict (agent_code) do nothing;
