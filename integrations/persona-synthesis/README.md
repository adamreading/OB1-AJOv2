# Persona Synthesis — conceptual wiki pages from semantic clusters

A **build-it-yourself pattern** for generating higher-level "persona" or "theme"
wiki pages that synthesize *across* many thoughts, rather than documenting a
single entity. Where the normal entity-wiki compiler writes one page per entity,
persona synthesis clusters the brain by meaning and writes a page per *lens*
(e.g. "how the operator thinks about X", "recurring themes in Y").

This is a pattern, not a drop-in script — your lenses, your clustering, and your
model are yours. This doc describes the approach so you can build your own.

---

## Idea

1. **Pick lenses.** A lens is a conceptual grouping you want a synthesized page
   for (a theme, a mode of working, a recurring topic). Keep a small list.
2. **Gather material per lens.** Use semantic search over `thoughts.embedding`
   (pgvector cosine similarity) to pull the top-N thoughts related to the lens's
   seed query — this is the cluster.
3. **Synthesize.** Send the clustered snippets to an LLM with a prompt that asks
   for a *narrative synthesis* across them (not a list), landing shorter rather
   than padding. Output is markdown.
4. **Store as a wiki page.** Write the result to your `wiki_pages` table under a
   conceptual slug (e.g. `topic-<lens>`), with `entity_id = NULL` (these pages
   aren't backed by a single entity).

---

## Building blocks / checklist

- [ ] A **lens list** (config): each lens has a name, a seed query, and optional
      filters (classification, type, date window).
- [ ] **Semantic recall**: a match RPC over `thoughts.embedding` returning the
      top-N by cosine similarity for the lens's seed.
- [ ] An **LLM call** (any provider — read the model + key from env; never
      hardcode). Use a synthesis prompt with a word ceiling and a "do not
      fabricate" rule.
- [ ] **Write-back** to `wiki_pages` under a conceptual slug (`entity_id NULL`).
      Mark generated pages so they're distinguishable from entity pages.
- [ ] CLI ergonomics: `--list` (show lenses), `--lens <name>` (one lens),
      `--dry-run` (synthesize + print, don't write).

## Notes

- Persona pages are **derived, regenerable artifacts** — safe to wipe and
  rebuild. Don't hand-edit them.
- Keep your lens seeds and any generated output **local** if they encode
  personal themes; only the pattern is shareable.
- Model + API key come from the environment (e.g. an OpenRouter key, or a local
  Ollama endpoint). Read them from `.env`; keep `.env` gitignored.
