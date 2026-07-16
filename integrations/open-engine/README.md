# Open Engine — a shared agent work-queue for Open Brain

**Open Engine** is a small, durable work-queue that lets multiple AI agents
coordinate work against one Open Brain instance: find assigned tasks, claim
exactly one at a time, do scoped work, leave standardized receipts, pause cleanly
(and resume correctly), and keep a shared status ledger current.

It is deliberately **separate from the `thoughts` table and the Kanban** — Open
Engine tracks *agent work*, not brain content. Think of it as the coordination
layer a fleet of agents (an always-on orchestrator, one or more Claude Code
sessions, an MCP client, etc.) uses to hand work around without stepping on each
other.

> Protocol lineage: adapted from Nate B Jones's Linear-based agent workflow onto
> Supabase Postgres, so the queue lives in the same database as the brain and is
> reachable over the same REST/MCP surfaces every client already uses.

---

## When to use it

- You run **more than one agent** against a single Open Brain and want them to
  share a work list without a second system.
- You want **auditable, resumable** agent work: every claim, block, answer, and
  completion is a receipt row you can read back.
- You want a **human-in-the-loop** seam: an agent can pause and ask a question,
  and a person answers on the task thread.

If you only ever run one agent interactively, you don't need this.

---

## Architecture

Three tables (full DDL in [`schema.sql`](./schema.sql)):

| Table | Purpose |
|---|---|
| `agent_tasks` | the work items — assignee (`agent_code`), `title`, `body`, `status`, `priority`, `parent_id` (delegation), `blocked_reason` / `hold_reason` |
| `agent_task_receipts` | the append-only audit thread per task — one row per lifecycle event |
| `agent_status_ledger` | one row per agent: runtime, automation mode, last heartbeat, last result |

**Task statuses:** `standing · todo · working · needs_input · review · done`
**Task kinds:** `standing · task · standing_skill`
**Receipt types:** `CLAIMED · DONE · BLOCKED · UNBLOCKED · HUMAN_HOLD · HUMAN_ANSWERED · RESUMED · FAILED · APPLIED · FOLLOW_UP`

Assignment is by `agent_code`. The special assignee **`all`** means *any* agent
may claim the task.

### Claim-locking (the important bit)

Two `security definer` RPCs make claiming race-free:

- `claim_agent_task(p_id, p_agent_code)` — atomic single-row claim. An **empty
  return means someone else already claimed it** (you lost the race — move on).
- `claim_next_agent_task(p_agent_code)` — picks the oldest eligible `todo`
  (priority-first) for this agent or for `all`, and claims it in one statement
  using `FOR UPDATE SKIP LOCKED`, so concurrent runners never collide.

---

## Install

1. Apply the schema to your Open Brain database:
   ```bash
   supabase db push          # if you add schema.sql as a migration
   # or run schema.sql directly against your Postgres
   ```
2. Edit the ledger seed at the bottom of `schema.sql` to match your fleet
   (one row per agent; `human_operator` / `runtime` / `automation` are free-text
   describing how each agent runs).
3. Expose the queue over whichever surface your agents already use — REST and/or
   MCP (below). Both are thin wrappers over the tables + the two claim RPCs.

The RPCs are granted to `service_role` only, so all access goes through your
authenticated REST/MCP layer — never expose them to `anon`.

---

## REST surface

Wire these into your Open Brain REST gateway (they map 1:1 to the tables + RPCs):

| Method + path | Does |
|---|---|
| `GET /agent-tasks` | list tasks (filter by `agent_code`, `status`) |
| `POST /agent-tasks` | file a new task `{ agent_code, title, body, priority?, parent_id? }` |
| `GET /agent-tasks/:id` | one task **plus its full receipt thread** |
| `POST /agent-tasks/claim-next` | `claim_next_agent_task` for the caller — returns the claimed task or empty |
| `POST /agent-tasks/:id/claim` | `claim_agent_task` a specific task |
| `PATCH /agent-tasks/:id` | update status / reassign / append a receipt in one call |
| `POST /agent-tasks/:id/receipts` | append a receipt `{ receipt_type, body }` |
| `GET /agent-ledger` | read the agent status ledger |
| `PUT /agent-ledger/:agent_code` | upsert an agent's ledger row (heartbeat, last result) |

The claim-next response returns the **full task row** (id + body), so a runner
gets the task and its instructions in one round-trip.

---

## MCP surface

For MCP clients, mirror the same operations as tools:

`list_agent_tasks` · `create_agent_task` · `claim_agent_task` · `get_agent_task`
· `update_agent_task` · `post_agent_receipt` · `get_agent_ledger` ·
`update_agent_ledger`

This lets any MCP-connected assistant (desktop client, browser assistant, etc.)
participate in the same queue as your headless runners.

---

## The runner protocol (one task per pass)

Each agent runs a simple, bounded loop — **one task per pass**, never a
long-running drain:

1. **Update your ledger heartbeat** (`PUT /agent-ledger/:you`).
2. **Claim one task** (`POST /agent-tasks/claim-next`). Empty → post an `idle`
   heartbeat and stop.
3. **Post a `CLAIMED` receipt**, do the scoped work.
4. **Finish one of three ways:**
   - **Done** → `PATCH status=done` + `DONE` receipt (or `status=review` to force
     a human to look before it's considered complete).
   - **Blocked on missing info** → `PATCH status=needs_input`, set
     `blocked_reason`, post a `BLOCKED` receipt with the exact question. Stop.
   - **Failed** → `PATCH status=review`/`done` as appropriate + `FAILED` receipt
     with the error. Never silently retry a broken task.
5. **Stop.** One task per pass keeps runs cheap, interruptible, and legible.

A lightweight watcher (poll the queue on an interval, or a push wake — see below)
triggers the next pass when new work appears. A reference poller
(`task-watch`-style) simply calls `claim-next` on a timer and runs one pass when
it gets a task.

### Wake options

- **Poll:** a timer (e.g. every 15–120 s) that runs one pass when `claim-next`
  returns a task. Simplest; costs ~nothing while idle because only the *poll* is
  cheap infra, not an LLM turn.
- **Push:** the filer fires a local wake (e.g. an HTTP ping to the runner's
  host) right after `POST /agent-tasks`, so the runner reacts in ~1 s. Keep a
  slow poll as a backstop so a missed wake never strands a task.

---

## Human-in-the-loop: needs_input → answer → resume

When an agent needs a decision it can't make, it parks the task and a human
answers on the thread:

1. Agent: `PATCH { status: 'needs_input', blocked_reason: '<the question>' }`
   + a `BLOCKED` receipt. The claim clears so the task is visible as waiting.
2. Human answers by re-queuing it:
   `PATCH { status: 'todo', blocked_reason: null, receipt_type: 'UNBLOCKED',
   receipt_body: '<the answer>' }`.
3. The agent re-claims the now-`todo` task, reads the `UNBLOCKED` receipt, and
   resumes — posting a `RESUMED` receipt.

`blocked_reason` (answer arrives **on the task**) is distinct from `hold_reason`
(a `HUMAN_HOLD` where the answer arrives in the operator's own thread) — use
whichever matches where the human is looking.

---

## Dashboard (optional but recommended)

A board view over the queue turns it into a live control centre:

- an **agent-ledger strip** (a heartbeat dot = agent seen within N minutes),
- **Kanban columns by task status** (todo / working / needs_input / review /
  done),
- a **task modal** with the full receipt thread and light controls (re-queue,
  mark done, toggle priority, and an **Answer box** on `needs_input` tasks that
  posts an `UNBLOCKED` receipt and re-queues),
- a **create-task** modal.

Design the board as **read-mostly**: agents run the queue via the runner
protocol; the board is the human's window + light steering, **not** a second
write path that agents depend on.

---

## The human consequence-gate

Open Engine carries agent work, some of which has real-world consequences
(publishing, deploying, deleting, spending). The governing principle:

> **Produce + verify = an agent may act autonomously. Apply-to-the-world =
> human-directed only.**

An autonomous runner pass must never self-authorize a consequential step. The
safe pattern is to require an explicit human-directed signal at the queue
transition that would trigger the consequence (e.g. a task can be *prepared*
autonomously but only *applied* when a human-authorized flag is present).

---

## Known gaps (honest limitations of v1)

Two things v1 does **not** do — worth adding before you rely on it for
unattended, autonomous operation:

1. **No lease / attempt-cap.** A task claimed by an agent that then dies stays
   `working` forever — nothing reclaims it. Add a visibility-timeout lease (re-open
   a `working` task whose `claimed_at` is older than N minutes) and an attempt
   cap so a poison task can't loop.
2. **The consequence-gate is advisory.** In v1 it lives in the runner
   *instructions*, not in code. For real autonomy, enforce it at the queue
   transition (reject an autonomous agent's attempt to move a task into a
   consequential state without a human-authorized marker) rather than trusting
   the prompt.

Both are additive and don't change the table shapes above.

---

## Files

- [`schema.sql`](./schema.sql) — the three tables, the two claim RPCs, grants, and
  an example ledger seed.
- This README — the protocol and how to wire it up.
