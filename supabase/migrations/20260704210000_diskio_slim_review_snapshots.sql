-- Disk-IO remediation (task #18/#19, the operator-authorized 2026-07-04):
-- agent_memory_review_actions stored the FULL agent_memories row — including
-- the ~19KB embedding vector — in both `before` and `after` on every review
-- action. 8,172 rows × 2 vectors ≈ 204MB (55% of the DB) and the dominant
-- WAL/autovacuum disk-IO consumer. The agent-memory-api handler now strips
-- the vector at insert (stripEmbedding, deployed same day); this migration
-- retro-slims the existing rows and rebuilds the churn-bloated vector
-- indexes (thoughts_embedding_idx was at 43.7x bloat).
--
-- NOTE: heap space freed here becomes reusable immediately but is only
-- returned to disk by VACUUM FULL, which cannot run inside a migration
-- transaction — run `VACUUM FULL public.agent_memory_review_actions;`
-- separately (dashboard SQL editor or psql) after this lands.

update public.agent_memory_review_actions
   set "before" = "before" - 'embedding',
       "after"  = "after"  - 'embedding'
 where ("before" ? 'embedding') or ("after" ? 'embedding');

-- Rebuild the re-embedding-churn-bloated vector indexes (plain REINDEX is
-- transaction-safe; CONCURRENTLY is not needed at these sizes — seconds).
reindex index public.thoughts_embedding_idx;
reindex index public.idx_agent_memories_embedding;
