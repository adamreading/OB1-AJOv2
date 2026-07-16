-- OB1 Agent Memory — add an authority subtype to agent_memories.
--
-- Separates "what kind of memory is this?" from "what is it allowed to do?".
-- The local-model curator assigns one of five epistemic grades; the Edge
-- Function uses it to gate can_use_as_instruction and to rank recall. This
-- prevents "interpretation laundering" — a one-moment inference becoming a
-- binding rule.
--
--   instruction             — a binding standing rule / decision / constraint
--   stable_preference       — a durable preference (strong context, not binding)
--   observed_pattern        — a recurring observed behaviour (evidence)
--   episodic_fact           — a specific thing that happened (evidence)
--   interpretive_hypothesis — an inference / emotional read (evidence, low rank)
--
-- Additive only: ONLY public.agent_memories is altered. public.thoughts and the
-- rest of the Open Brain project are NOT touched. Safe to run more than once.

SET search_path TO public, extensions;

BEGIN;

ALTER TABLE public.agent_memories
  ADD COLUMN IF NOT EXISTS authority_subtype TEXT
    CHECK (
      authority_subtype IS NULL
      OR authority_subtype IN (
        'instruction',
        'stable_preference',
        'observed_pattern',
        'episodic_fact',
        'interpretive_hypothesis'
      )
    );

COMMENT ON COLUMN public.agent_memories.authority_subtype IS
  'Epistemic/authority grade assigned by the curator: instruction | stable_preference | observed_pattern | episodic_fact | interpretive_hypothesis. NULL = unclassified (legacy / pending). Gates can_use_as_instruction and recall ranking.';

CREATE INDEX IF NOT EXISTS idx_agent_memories_authority_subtype
  ON public.agent_memories (authority_subtype, review_status);

NOTIFY pgrst, 'reload schema';

COMMIT;
