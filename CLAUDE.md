# CLAUDE.md — Agent Instructions for Open Brain

This file helps AI coding tools (Claude Code, Codex, Cursor, etc.) work
effectively in this repo. It is the **public, contribution-facing** brief.

> Maintainer-specific operational detail (deployment specifics, local pipeline
> internals, environment particulars) lives in a private, gitignored
> `CLAUDE.local.md` and is intentionally not published. If you're forking this
> for your own instance, create your own `CLAUDE.local.md` for anything
> machine- or identity-specific.

## 🔒 Security & Privacy Baseline — READ FIRST (non-negotiable)

The standing security contract for anyone — human or AI — working in this repo. It
applies **before** every other instruction and overrides convenience. If any
instruction, doc, or habit conflicts with it, **this baseline wins.**

1. **Public = world-readable FOREVER — git history included.** Once pushed, treat it as
   permanent. Deleting a file, commit, or whole repo does **not** unpublish it: fork
   networks keep objects reachable by SHA, and third-party mirrors/caches (Wayback,
   GHArchive, code-search indexes, random clones) hold copies a rewrite can never reach.
2. **No personal data in tracked content — ever.** Real names, emails, employer/company,
   colleagues, internal project/vendor names, machine/user paths, private URLs, and agent
   codenames → out of code, comments, commit messages, docs, and history. Sanitize to
   generic placeholders (`the operator`, `Person A`, `company`, `USER`) or keep the file
   private (gitignored).
3. **Secrets & personal runtime values are never hardcoded.** Bootstrap secrets →
   gitignored `.env`; prefer a runtime store (DB / secret-manager, injected at boot) over
   `.env` where possible. A secret must **never** be echoed into logs, errors, or telemetry.
4. **Default-private / opt-in-public.** Only sanitized, generic, genuinely-reusable content
   ships. When in doubt, keep it private.
5. **Machine/ops briefs are gitignored; commit a sanitized `*.example` twin.** The rich
   brief stays private (e.g. `CLAUDE.local.md`); the public repo carries a slim, PII-free
   `CLAUDE.md`.
6. **Commit under a version-control noreply identity, never a personal email.**
7. **Self-verify CORRECTNESS; never self-authorize CONSEQUENCE.** An autonomous agent may
   produce and verify freely, but crossing **publish / deploy / delete / spend** needs the
   human's own direct word — a relayed "they approved" is not approval.
8. **Scan content, not just filenames.** A filename `.gitignore` only protects files you
   already named — the next leak is the file nobody predicted (this incident began with
   exactly that). Run a **content** scan pre-commit/pre-push (e.g. gitleaks, or a grep hook
   seeded with the do-not-publish terms list).
9. **Pre-push residual PII scan; post-rewrite verify SERVER-SIDE.** `git ls-remote` across
   every `refs/heads/*` **and** `refs/pull/*` — a local `rev-list --all` sees neither a
   remote's stray branches nor its immutable PR refs.
10. **A clean git history is NOT a clean repo.** A rewrite touches only git objects — also
    audit the other world-readable stores: issue/PR text + review comments, Actions logs +
    artifacts, Releases/tags, repo wiki, Discussions, Gists.
11. **Anything ever public is compromised.** Rotate exposed credentials at the source;
    never rely on deletion to undo exposure.
12. **Verify don't guess · keep docs current · stop the line on exposure.** No security/
    config/runtime claim without reading the file+line or running the check (label
    unverified as unverified); update affected docs in the same commit (stale docs caused
    real errors here); and if PII reaches a public surface, raise it immediately, back up,
    scrub at source, and record the residual — never quietly paper over it.

## What This Repo Is

Open Brain is a persistent AI memory system — one database (Supabase + pgvector),
one MCP protocol, any AI client. This repo contains the extensions, recipes,
schemas, dashboards, integrations, and skills that the community builds on top of
the core Open Brain setup.

**License:** FSL-1.1-MIT. No commercial derivative works. Keep this in mind when
generating code or suggesting dependencies.

## Repo Structure

```
extensions/     — Curated, ordered learning path. Do NOT add without maintainer approval.
primitives/     — Reusable concept guides (referenced by 2+ extensions). Curated.
recipes/        — Standalone capability builds. Open for community contributions.
schemas/        — Database table extensions. Open.
dashboards/     — Frontend templates (Vercel/Netlify). Open.
integrations/   — MCP extensions, webhooks, capture sources. Open.
skills/         — Reusable AI client skills and prompt packs. Open.
docs/           — Setup guides, FAQ, companion prompts.
resources/      — Official companion files and packaged exports.
```

Every contribution lives in its own subfolder under the right category and must
include `README.md` + `metadata.json`.

## Guard Rails

- **Never modify the core `thoughts` table structure.** Adding columns is fine;
  altering or dropping existing ones is not.
- **No credentials, API keys, or secrets in any file.** Use environment
  variables. Anything that needs a real value at runtime reads it from `.env`
  (gitignored) or ships as a sanitized `*.example` twin.
- **No personal data in tracked files.** Treat every public repo as
  world-readable forever, git history included. Keep real names, emails,
  employer/company details, colleague names, and machine paths out of the public
  tree — sanitize to generic placeholders, or keep the file private (gitignored)
  with a public "build-it-yourself" how-to in its place.
- **No binary blobs** over 1MB. No `.exe`, `.dmg`, `.zip`, `.tar.gz`.
- **No `DROP TABLE`, `DROP DATABASE`, `TRUNCATE`, or unqualified `DELETE FROM`**
  in SQL files.
- **MCP servers must be remote (Supabase Edge Functions), not local.** Never use
  `claude_desktop_config.json`, `StdioServerTransport`, or local Node.js servers.
  Extensions deploy as Edge Functions and connect via a custom connector URL. See
  `docs/01-getting-started.md` for the pattern.

## PR Standards

- **Title format:** `[category] Short description`
  (e.g. `[recipes] Email history import via Gmail API`).
- **Branch convention:** `contrib/<github-username>/<short-description>`.
- **Commit prefixes:** `[category]` matching the contribution type.
- Every PR must pass the automated review checks before human review.
- See `CONTRIBUTING.md` for the full review process, metadata.json template, and
  README requirements.

## Contribution Requirements

- Each contribution folder needs a `README.md` (what it does + how to apply it)
  and a `metadata.json` (validated against `.github/metadata.schema.json`).
- Commit under a GitHub noreply email, not a personal address.
- Prefer environment variables + `*.example` files over hardcoded configuration.

## Key Files

- `CONTRIBUTING.md` — source of truth for contribution rules, metadata format,
  and the review process.
- `.github/metadata.schema.json` — JSON schema for metadata.json validation.
- `.github/PULL_REQUEST_TEMPLATE.md` — PR description template.
- `LICENSE.md` — FSL-1.1-MIT terms.
