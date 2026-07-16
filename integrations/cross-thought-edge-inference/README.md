# Cross-Thought Edge Inference — relationships no single thought states

A **build-it-yourself pattern** for inferring entity relationships that are
implied *across multiple thoughts* but never stated in any single one.

The per-thought entity extractor only sees one thought at a time, so it forms
edges only from relationships co-stated in the same capture. That misses a lot:
if entity A is mentioned in one thought and entity B in another, both in the same
context, no single thought puts them together — so no edge forms, and the graph
becomes hub-centric (everything routes through the user). This pattern adds the
cross-thought layer.

Pattern, not a drop-in script — your entity types, model chain, and thresholds
are yours. This doc describes the approach.

---

## How it works

For each target entity (default: people / places / organizations with at least a
few linked thoughts):

1. **Pull the entity's linked thoughts** (cap the count and per-snippet length).
2. **Ask an LLM**: "What HIGH-CONFIDENCE relationships does this entity have to
   OTHER entities, based on these thoughts?" Output a JSON array of
   `{ related_entity_name, relation, direction, confidence, evidence_thought_id,
   reason }`.
3. **Resolve each suggestion** to an entity id via an alias-aware search.
4. **Skip if an edge already exists** in either direction for the pair —
   extracted edges always win over inferred ones.
5. **Respect an edge blocklist** (relationships a human has explicitly rejected).
6. **Write inferred edges** directly to the `edges` table with
   `metadata.source = 'inferred'`, so they're visually and logically distinct
   from thought-derived edges (render them dashed/different colour in your graph).

---

## Building blocks / checklist

- [ ] A **target selector**: which entities to process (by type + min linked
      thought count).
- [ ] **Thought fetch** per entity (capped count + snippet length to bound the
      prompt).
- [ ] An **LLM call** with a strict JSON-array output contract. Read model + key
      from env; a **fallback model chain** helps (if the primary returns
      unparseable JSON or loops, try the next).
- [ ] **Entity resolution** (alias-aware search) + **dedup** against existing
      edges + a **blocklist** check.
- [ ] **Write-back** to `edges` with `metadata.source='inferred'`.
- [ ] A **pre-apply snapshot** of the `edges` table for rollback, and a
      `--dry-run` mode that prints suggestions without writing.

## Vocabulary note

Inference can emit relationship types the single-thought extractor can't trigger
(e.g. `lives_in` for a person→place, `is_part_of` for place→place) because those
are only evident across captures. Keep a shared relation vocabulary and add the
inference-only relations to it.

## Notes

- Inferred edges are **lower-trust** than extracted ones — keep them
  distinguishable (the `metadata.source` tag), never let them overwrite an
  extracted edge, and honour the human blocklist.
- Model + key come from `.env` (gitignored). Never hardcode a model name.
