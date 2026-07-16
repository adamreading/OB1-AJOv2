-- GK+ #34 (the operator-greenlit 2026-07-06): first-class person-memory for the Hermes agent.
-- Adds two memory_type values so facts ABOUT people type accurately instead of
-- being shoehorned into lesson/output:
--   episodic_fact   — a discrete fact about a person/thing ("H4 prefers X")
--   observed_pattern — a recurring behaviour/preference inferred over time
-- Widening an enum CHECK is additive + reversible (drop the two values back out).
-- Companion edge changes (agent-memory-api): new facts/patterns payload buckets,
-- persist memory_payload.entities into metadata, entity/channel hard-filter on
-- /recall. Safety: person-facts still land observed / can_use_as_instruction=false
-- (the Q4 evidence-only pattern) — no authority-model change here.

alter table public.agent_memories
  drop constraint if exists agent_memories_memory_type_check;

alter table public.agent_memories
  add constraint agent_memories_memory_type_check check (
    memory_type in (
      'decision',
      'output',
      'lesson',
      'constraint',
      'open_question',
      'failure',
      'artifact_reference',
      'work_log',
      'episodic_fact',
      'observed_pattern'
    )
  );
