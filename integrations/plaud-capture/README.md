# Plaud Capture — a curator webhook for ambient voice capture

Turn an ambient voice-capture device (e.g. [Plaud](https://plaud.ai), or any
source that produces transcripts) into **review-gated Open Brain captures**, with
an LLM **curator** that decides — per entry — whether to ignore it, update an
existing thought, or capture a new one.

This is a **build-it-yourself pattern**, not a drop-in script: your capture
device, your decider model, and your correction rules are all specific to you.
This doc describes the architecture and the contract so you can build your own
webhook. (A device like Plaud is the example; the shape works for any transcript
feed.)

> **Why a curator, not a blind capturer?** Ambient capture is noisy: the same
> meeting gets mentioned three times, speech-to-text mangles names, and half of
> it isn't worth keeping. A curator applies *judgment* — dedup against what's
> already in the brain, fix transcription errors, and drop noise — so your brain
> stays clean instead of accumulating near-duplicates.

---

## Flow

```
capture device ──transcript──▶ your webhook ──per entry──▶ curator decision ──▶ Open Brain
                                    │                          (IGNORE /            (review-gated
                                    │                           UPDATE /             via /capture-pending)
                                    ▼                           CAPTURE)
                        corrections + OB search + wiki anchors
```

1. **The device produces a transcript** and fires an event at your webhook
   (poll its API, or receive a `transcript_ready` webhook — whatever your device
   supports).
2. **Extract structured entries.** Have the device's summarizer (or a first LLM
   pass) emit delimited blocks with a small header, e.g.:
   ```
   ---ENTRY---
   TYPE: <task|idea|note|…>
   CONTEXT: <work|personal>
   ENTITIES: <comma-separated canonical names>
   SEARCH_HINTS: <phrase | phrase | phrase>
   <the body>
   ACTIONS: <optional follow-ups>
   ---END---
   ```
3. **Apply speech-to-text corrections.** Keep a small `corrections.json` of
   `{ wrong, canonical, context, flag_only? }` rules (whole-word, case-aware).
   `flag_only` entries are raised as open questions instead of auto-replaced —
   use that for ambiguous names.
4. **Assemble context for the decider.** For each entry:
   - search Open Brain (`GET /search?q=<hint>&classification=<context>`) per
     `SEARCH_HINTS`, dedup by id;
   - look up canonical wiki anchors for each named entity
     (`GET /wiki-pages/<slug>`, probing `person-`, `organization-`, `project-`,
     `tool-`, `topic-`, `place-` prefixes).
5. **Ask the decider.** Hand the assembled context (entry + candidates + anchors
   + any pending items) to your **curator** and get back a single JSON object:
   ```json
   { "decision": "IGNORE|UPDATE|CAPTURE",
     "target_id": 123,
     "merged_content": "…",
     "confidence": 0.0,
     "reasoning": "…",
     "open_question": "…" }
   ```
   The decider is **pluggable** — see below.
6. **Act on the decision:**
   - `IGNORE` → log and skip.
   - `UPDATE` → `POST /capture-pending` with the merged body, `update_target_id`,
     and the original content.
   - `CAPTURE` → `POST /capture-pending` with the new thought.
7. **Everything goes through `/capture-pending` (review-gated) — never
   `/capture`.** A human triages every write in the dashboard review queue. The
   curator proposes; the human disposes.
8. **Open questions.** When a `flag_only` correction fires, or the curator's
   confidence is low, append a question to an `OPEN_QUESTIONS.md` file rather than
   polluting the thought body. On later runs, scan it for answered questions and
   apply them as updates.

---

## The decider interface (pluggable)

The curator is the one component you'll most want to swap. It takes the assembled
context and returns the JSON verdict above. Two common backends:

- **An agent over HTTP** — POST the context to an agent endpoint (a local
  assistant, a small orchestrator) and let a capable model make the call. Best
  quality; give it a strict output contract and a timeout, and **hold** the entry
  (never drop it) if the agent errors or times out.
- **A local LLM** — call a local model (via an OpenAI-compatible endpoint) with a
  curator prompt. Cheaper/offline; use greedy decoding and JSON-mode for reliable
  structured output, and keep a repair/fallback path for malformed JSON.

Keep the decider behind an env var so you can switch backends without touching
the pipeline (e.g. `CURATOR_URL` for the HTTP agent; fall back to the local model
if unset). **Never hardcode a model name** — read it from the environment.

---

## State

Keep run state in a small JSON file (atomic write-temp + rename):
- `processed_ids[]` — dedup so the same recording isn't ingested twice.
- `skip_rules` — min duration, title keywords to skip, etc.
- a capped `run_log[]` for observability.

---

## Building blocks / checklist

- [ ] A webhook server (or poller) that receives/pulls transcript-ready events.
- [ ] A structured-entry format your summarizer emits (the `---ENTRY---` block).
- [ ] `corrections.json` — your speech-to-text fixes (gitignore it; it names
      real people/places).
- [ ] A decider (agent HTTP endpoint and/or local LLM) behind an env var.
- [ ] Open Brain reachable for `GET /search`, `GET /wiki-pages/:slug`, and
      `POST /capture-pending`.
- [ ] `OPEN_QUESTIONS.md` handling for low-confidence entries.
- [ ] A cursor/state file for dedup + run log.

## Privacy note

Your corrections file, transcripts, and state contain **real personal data**
(colleague names, places, device IDs). Keep all of it gitignored / local — only
the *pattern* (this doc) is shareable.
