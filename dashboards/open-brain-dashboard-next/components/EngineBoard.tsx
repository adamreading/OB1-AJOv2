"use client";

// Open Engine control centre — the dashboard surface for the shared agent
// work-queue (agent_tasks / agent_task_receipts / agent_status_ledger).
// Read-mostly: agents run the queue via RUNNER.md; this board is the operator's
// window into it plus light controls (file a task, re-queue, close, answer
// a blocked task via receipt). Polls every 15s.

import { useCallback, useEffect, useRef, useState } from "react";

interface AgentTask {
  id: number;
  agent_code: string;
  title: string;
  body: string | null;
  task_kind: string;
  status: string;
  claimed_by: string | null;
  claimed_at: string | null;
  priority: number;
  parent_id: number | null;
  blocked_reason: string | null;
  hold_reason: string | null;
  created_at: string;
  updated_at: string;
  status_updated_at: string;
}

interface Receipt {
  id: number;
  task_id: number;
  agent_code: string;
  receipt_type: string;
  body: string | null;
  created_at: string;
}

interface LedgerRow {
  agent_code: string;
  human_operator: string | null;
  runtime: string | null;
  automation: string | null;
  automation_state: string | null;
  last_heartbeat: string | null;
  last_queue_result: string | null;
}

const COLUMNS: { key: string; label: string; accent: string }[] = [
  { key: "todo", label: "Todo", accent: "var(--fg-3)" },
  { key: "working", label: "Working", accent: "var(--violet-300)" },
  { key: "needs_input", label: "Needs input", accent: "var(--warn)" },
  { key: "review", label: "Review", accent: "#6ab7ff" },
  { key: "done", label: "Done", accent: "var(--ok)" },
];

const RECEIPT_COLORS: Record<string, string> = {
  CLAIMED: "var(--violet-300)",
  DONE: "var(--ok)",
  APPLIED: "var(--ok)",
  RESUMED: "var(--ok)",
  UNBLOCKED: "var(--ok)",
  HUMAN_ANSWERED: "#6ab7ff",
  FOLLOW_UP: "#6ab7ff",
  BLOCKED: "var(--warn)",
  HUMAN_HOLD: "var(--warn)",
  FAILED: "var(--crit)",
};

const AGENT_COLORS: Record<string, string> = {
  "hermes-agent": "#5ad1a5",
  "wsl-claude": "#e8a04c",
  "ob-claude": "#9d83ff",
  "copilot-work": "#6ab7ff",
  perplexity: "#5ac8d1",
  all: "var(--fg-4)",
};

function agentColor(code: string) {
  return AGENT_COLORS[code] ?? "var(--fg-3)";
}

function relTime(iso: string | null): string {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0 || isNaN(ms)) return "—";
  const m = Math.floor(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function AgentChip({ code, dim }: { code: string; dim?: boolean }) {
  const c = agentColor(code);
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        padding: "1px 8px",
        borderRadius: 999,
        fontSize: 10.5,
        fontFamily: "var(--font-mono)",
        color: dim ? "var(--fg-3)" : c,
        border: `1px solid color-mix(in srgb, ${c} ${dim ? 25 : 45}%, transparent)`,
        background: `color-mix(in srgb, ${c} ${dim ? 5 : 10}%, transparent)`,
        whiteSpace: "nowrap",
      }}
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: "50%",
          background: c,
          opacity: dim ? 0.5 : 1,
        }}
      />
      {code}
    </span>
  );
}

export function EngineBoard() {
  const [tasks, setTasks] = useState<AgentTask[]>([]);
  const [ledger, setLedger] = useState<LedgerRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [lastFetch, setLastFetch] = useState<Date | null>(null);
  const [selected, setSelected] = useState<AgentTask | null>(null);
  const [receipts, setReceipts] = useState<Receipt[] | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [busy, setBusy] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    try {
      const [tRes, lRes] = await Promise.all([
        fetch("/api/engine/tasks?limit=200"),
        fetch("/api/engine/ledger"),
      ]);
      if (tRes.ok) {
        const d = await tRes.json();
        setTasks(d.tasks ?? []);
        setError(null);
      } else {
        setError(`tasks fetch failed (${tRes.status})`);
      }
      if (lRes.ok) {
        const d = await lRes.json();
        setLedger(d.ledger ?? []);
      }
      setLastFetch(new Date());
    } catch (e) {
      setError(e instanceof Error ? e.message : "fetch failed");
    }
  }, []);

  useEffect(() => {
    load();
    pollRef.current = setInterval(load, 15000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [load]);

  // Load receipt thread when a task is selected
  useEffect(() => {
    if (!selected) {
      setReceipts(null);
      return;
    }
    let cancelled = false;
    fetch(`/api/engine/tasks/${selected.id}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled && d) {
          setReceipts(d.receipts ?? []);
          if (d.task) setSelected(d.task);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id]);

  async function patchTask(id: number, body: Record<string, unknown>) {
    setBusy(true);
    try {
      const res = await fetch(`/api/engine/tasks/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        const d = await res.json();
        if (d.task) setSelected(d.task);
        await load();
        // refresh receipts too
        const r2 = await fetch(`/api/engine/tasks/${id}`);
        if (r2.ok) setReceipts((await r2.json()).receipts ?? []);
      }
    } finally {
      setBusy(false);
    }
  }

  const standing = tasks.filter((t) => t.status === "standing");
  const byCol = (key: string) => {
    const rows = tasks.filter((t) => t.status === key);
    if (key === "done") {
      return rows
        .sort(
          (a, b) =>
            new Date(b.status_updated_at).getTime() -
            new Date(a.status_updated_at).getTime()
        )
        .slice(0, 15);
    }
    return rows;
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {/* ── Agent ledger strip ─────────────────────────────── */}
      <div
        className="mobile-scroll-x"
        style={{ display: "flex", gap: 10, flexWrap: "wrap" }}
      >
        {ledger.map((a) => {
          const hbMs = a.last_heartbeat
            ? Date.now() - new Date(a.last_heartbeat).getTime()
            : Infinity;
          const alive = hbMs < 1000 * 60 * 30; // heartbeat within 30 min
          return (
            <div
              key={a.agent_code}
              style={{
                flex: "1 1 170px",
                minWidth: 170,
                padding: "10px 12px",
                borderRadius: "var(--r-md, 10px)",
                border: "1px solid var(--line)",
                background: "var(--bg-1)",
                display: "flex",
                flexDirection: "column",
                gap: 5,
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 8,
                }}
              >
                <AgentChip code={a.agent_code} />
                <span
                  title={
                    alive
                      ? `heartbeat ${relTime(a.last_heartbeat)}`
                      : a.last_heartbeat
                        ? `last seen ${relTime(a.last_heartbeat)}`
                        : "never checked in"
                  }
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: "50%",
                    background: alive ? "var(--ok)" : "var(--fg-4)",
                    boxShadow: alive
                      ? "0 0 6px color-mix(in srgb, var(--ok) 70%, transparent)"
                      : "none",
                    flexShrink: 0,
                  }}
                />
              </div>
              <div
                style={{
                  fontSize: 10.5,
                  color: "var(--fg-4)",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
                title={a.runtime ?? undefined}
              >
                {a.runtime ?? "—"}
              </div>
              <div
                style={{
                  fontSize: 11,
                  color: "var(--fg-3)",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
                title={a.last_queue_result ?? undefined}
              >
                {a.last_queue_result ?? "no runs yet"}
              </div>
              <div style={{ fontSize: 10, color: "var(--fg-4)" }}>
                {a.last_heartbeat
                  ? `❤ ${relTime(a.last_heartbeat)}`
                  : "no heartbeat"}
              </div>
            </div>
          );
        })}
      </div>

      {/* ── Toolbar ────────────────────────────────────────── */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <button
            type="button"
            onClick={() => setShowCreate(true)}
            style={{
              padding: "7px 14px",
              borderRadius: 8,
              border: "1px solid rgba(157,131,255,0.35)",
              background:
                "linear-gradient(180deg, rgba(130,97,255,0.25), rgba(130,97,255,0.12))",
              color: "var(--fg)",
              fontSize: 12.5,
              fontWeight: 500,
              cursor: "pointer",
              fontFamily: "inherit",
            }}
          >
            + New task
          </button>
          {standing.length > 0 && (
            <span style={{ fontSize: 11.5, color: "var(--fg-4)" }}>
              {standing.length} standing task{standing.length > 1 ? "s" : ""}
            </span>
          )}
        </div>
        <div
          style={{
            fontSize: 10.5,
            color: "var(--fg-4)",
            fontFamily: "var(--font-mono)",
          }}
        >
          {error
            ? `⚠ ${error}`
            : lastFetch
              ? `refreshed ${lastFetch.toLocaleTimeString()} · auto 15s`
              : "loading…"}
        </div>
      </div>

      {/* ── Kanban columns ─────────────────────────────────── */}
      <div
        className="mobile-stack kanban-scroll-mobile"
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${COLUMNS.length}, minmax(200px, 1fr))`,
          gap: 12,
          alignItems: "start",
        }}
      >
        {COLUMNS.map((col) => {
          const rows = byCol(col.key);
          return (
            <div
              key={col.key}
              className="kanban-col-mobile"
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 8,
                borderRadius: "var(--r-lg, 12px)",
                border: "1px solid var(--line)",
                background: "var(--bg-1)",
                padding: 10,
                minHeight: 120,
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "2px 4px 6px",
                }}
              >
                <span
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: "50%",
                    background: col.accent,
                  }}
                />
                <span
                  style={{
                    fontSize: 11.5,
                    fontWeight: 600,
                    color: "var(--fg-2)",
                    letterSpacing: "0.02em",
                    textTransform: "uppercase",
                  }}
                >
                  {col.label}
                </span>
                <span
                  style={{
                    marginLeft: "auto",
                    fontSize: 10.5,
                    fontFamily: "var(--font-mono)",
                    color: "var(--fg-4)",
                  }}
                >
                  {rows.length}
                  {col.key === "done" && rows.length === 15 ? "+" : ""}
                </span>
              </div>
              {rows.length === 0 && (
                <div
                  style={{
                    fontSize: 11.5,
                    color: "var(--fg-4)",
                    padding: "10px 6px",
                    textAlign: "center",
                  }}
                >
                  empty
                </div>
              )}
              {rows.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setSelected(t)}
                  className="mobile-touch"
                  style={{
                    textAlign: "left",
                    padding: "9px 10px",
                    borderRadius: 9,
                    border:
                      t.blocked_reason || t.hold_reason
                        ? "1px solid color-mix(in srgb, var(--warn) 40%, transparent)"
                        : "1px solid var(--line)",
                    background: "var(--bg-2)",
                    cursor: "pointer",
                    fontFamily: "inherit",
                    display: "flex",
                    flexDirection: "column",
                    gap: 6,
                    color: "var(--fg-2)",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "baseline",
                      gap: 6,
                    }}
                  >
                    <span
                      style={{
                        fontFamily: "var(--font-mono)",
                        fontSize: 10,
                        color: "var(--fg-4)",
                        flexShrink: 0,
                      }}
                    >
                      #{t.id}
                    </span>
                    <span
                      style={{
                        fontSize: 12.5,
                        color: "var(--fg)",
                        lineHeight: 1.35,
                      }}
                    >
                      {t.title}
                    </span>
                  </div>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      flexWrap: "wrap",
                    }}
                  >
                    <AgentChip code={t.agent_code} dim />
                    {t.claimed_by && t.claimed_by !== t.agent_code && (
                      <span style={{ fontSize: 10, color: "var(--fg-4)" }}>
                        ⟶ {t.claimed_by}
                      </span>
                    )}
                    {t.priority > 0 && (
                      <span
                        style={{
                          fontSize: 9.5,
                          fontFamily: "var(--font-mono)",
                          padding: "0 5px",
                          borderRadius: 4,
                          color: "var(--warn)",
                          border:
                            "1px solid color-mix(in srgb, var(--warn) 40%, transparent)",
                        }}
                      >
                        P{t.priority}
                      </span>
                    )}
                    {(t.blocked_reason || t.hold_reason) && (
                      <span style={{ fontSize: 10, color: "var(--warn)" }}>
                        {t.hold_reason ? "⏸ human hold" : "⛔ blocked"}
                      </span>
                    )}
                    <span
                      style={{
                        marginLeft: "auto",
                        fontSize: 9.5,
                        color: "var(--fg-4)",
                      }}
                    >
                      {relTime(t.status_updated_at)}
                    </span>
                  </div>
                </button>
              ))}
            </div>
          );
        })}
      </div>

      {/* ── Standing tasks rail ────────────────────────────── */}
      {standing.length > 0 && (
        <div
          style={{
            borderRadius: "var(--r-lg, 12px)",
            border: "1px solid var(--line)",
            background: "var(--bg-1)",
            padding: 12,
          }}
        >
          <div className="eyebrow" style={{ marginBottom: 8 }}>
            Standing tasks (persistent context / skills)
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {standing.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setSelected(t)}
                style={{
                  padding: "6px 10px",
                  borderRadius: 8,
                  border: "1px solid var(--line)",
                  background: "var(--bg-2)",
                  color: "var(--fg-2)",
                  fontSize: 11.5,
                  cursor: "pointer",
                  fontFamily: "inherit",
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                }}
              >
                <span
                  style={{ fontFamily: "var(--font-mono)", fontSize: 9.5 }}
                >
                  #{t.id}
                </span>
                {t.title}
                <AgentChip code={t.agent_code} dim />
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ── Task detail drawer ─────────────────────────────── */}
      {selected && (
        <TaskModal
          task={selected}
          receipts={receipts}
          busy={busy}
          onClose={() => setSelected(null)}
          onPatch={(body) => patchTask(selected.id, body)}
        />
      )}

      {/* ── Create modal ───────────────────────────────────── */}
      {showCreate && (
        <CreateModal
          agents={[...ledger.map((l) => l.agent_code), "all"]}
          onClose={() => setShowCreate(false)}
          onCreated={() => {
            setShowCreate(false);
            load();
          }}
        />
      )}
    </div>
  );
}

function ModalShell({
  children,
  onClose,
  width = 560,
}: {
  children: React.ReactNode;
  onClose: () => void;
  width?: number;
}) {
  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.55)",
        zIndex: 100,
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        padding: "8vh 16px 16px",
        overflowY: "auto",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "100%",
          maxWidth: width,
          background: "var(--bg-1)",
          border: "1px solid var(--line-strong)",
          borderRadius: 14,
          boxShadow: "0 16px 48px rgba(0,0,0,0.55)",
          padding: 18,
          display: "flex",
          flexDirection: "column",
          gap: 14,
        }}
      >
        {children}
      </div>
    </div>
  );
}

function TaskModal({
  task,
  receipts,
  busy,
  onClose,
  onPatch,
}: {
  task: AgentTask;
  receipts: Receipt[] | null;
  busy: boolean;
  onClose: () => void;
  onPatch: (body: Record<string, unknown>) => void;
}) {
  const [answer, setAnswer] = useState("");

  const actionBtn = (label: string, body: Record<string, unknown>) => (
    <button
      type="button"
      disabled={busy}
      onClick={() => onPatch(body)}
      style={{
        padding: "6px 12px",
        borderRadius: 7,
        border: "1px solid var(--line-strong)",
        background: "var(--bg-2)",
        color: "var(--fg-2)",
        fontSize: 11.5,
        cursor: busy ? "wait" : "pointer",
        fontFamily: "inherit",
        opacity: busy ? 0.6 : 1,
      }}
    >
      {label}
    </button>
  );

  return (
    <ModalShell onClose={onClose} width={620}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 10.5,
              color: "var(--fg-4)",
              marginBottom: 4,
            }}
          >
            task #{task.id} · {task.task_kind} · created{" "}
            {relTime(task.created_at)}
            {task.parent_id ? ` · child of #${task.parent_id}` : ""}
          </div>
          <div
            style={{ fontSize: 16, fontWeight: 600, color: "var(--fg)" }}
          >
            {task.title}
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              marginTop: 8,
              flexWrap: "wrap",
            }}
          >
            <AgentChip code={task.agent_code} />
            <span
              style={{
                fontSize: 10.5,
                fontFamily: "var(--font-mono)",
                padding: "1px 8px",
                borderRadius: 999,
                border: "1px solid var(--line-strong)",
                color: "var(--fg-2)",
              }}
            >
              {task.status}
            </span>
            {task.claimed_by && (
              <span style={{ fontSize: 11, color: "var(--fg-3)" }}>
                claimed by <b>{task.claimed_by}</b> {relTime(task.claimed_at)}
              </span>
            )}
            {task.priority > 0 && (
              <span style={{ fontSize: 11, color: "var(--warn)" }}>
                priority {task.priority}
              </span>
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          style={{
            background: "transparent",
            border: "none",
            color: "var(--fg-3)",
            fontSize: 18,
            cursor: "pointer",
            padding: 4,
            fontFamily: "inherit",
          }}
        >
          ×
        </button>
      </div>

      {(task.blocked_reason || task.hold_reason) && (
        <div
          style={{
            padding: "10px 12px",
            borderRadius: 9,
            border: "1px solid color-mix(in srgb, var(--warn) 45%, transparent)",
            background: "color-mix(in srgb, var(--warn) 8%, transparent)",
            fontSize: 12.5,
            color: "var(--fg-2)",
          }}
        >
          <b>{task.hold_reason ? "Human hold:" : "Blocked:"}</b>{" "}
          {task.hold_reason ?? task.blocked_reason}
        </div>
      )}

      {task.body && (
        <div
          style={{
            fontSize: 13,
            color: "var(--fg-2)",
            lineHeight: 1.55,
            whiteSpace: "pre-wrap",
            padding: "10px 12px",
            borderRadius: 9,
            background: "var(--bg-2)",
            border: "1px solid var(--line)",
            maxHeight: 220,
            overflowY: "auto",
          }}
        >
          {task.body}
        </div>
      )}

      {/* Receipt thread */}
      <div>
        <div className="eyebrow" style={{ marginBottom: 8 }}>
          Receipts
        </div>
        {receipts === null ? (
          <div style={{ fontSize: 12, color: "var(--fg-4)" }}>loading…</div>
        ) : receipts.length === 0 ? (
          <div style={{ fontSize: 12, color: "var(--fg-4)" }}>
            no receipts yet
          </div>
        ) : (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 6,
              maxHeight: 260,
              overflowY: "auto",
            }}
          >
            {receipts.map((r) => (
              <div
                key={r.id}
                style={{
                  display: "flex",
                  gap: 10,
                  padding: "7px 10px",
                  borderRadius: 8,
                  background: "var(--bg-2)",
                  border: "1px solid var(--line)",
                  alignItems: "baseline",
                }}
              >
                <span
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: 9.5,
                    fontWeight: 600,
                    color: RECEIPT_COLORS[r.receipt_type] ?? "var(--fg-3)",
                    flexShrink: 0,
                    minWidth: 92,
                  }}
                >
                  {r.receipt_type}
                </span>
                <span
                  style={{
                    fontSize: 12,
                    color: "var(--fg-2)",
                    flex: 1,
                    lineHeight: 1.45,
                    whiteSpace: "pre-wrap",
                  }}
                >
                  {r.body ?? ""}
                </span>
                <span
                  style={{
                    fontSize: 9.5,
                    color: "var(--fg-4)",
                    flexShrink: 0,
                  }}
                >
                  {r.agent_code} · {relTime(r.created_at)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Answer a blocked task — lands as a receipt the agent reads on resume */}
      {task.status === "needs_input" && (
        <div style={{ display: "flex", gap: 8 }}>
          <input
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            placeholder="Answer / unblock note — posts an UNBLOCKED receipt and re-queues"
            style={{
              flex: 1,
              padding: "8px 10px",
              borderRadius: 8,
              border: "1px solid var(--line-strong)",
              background: "var(--bg-2)",
              color: "var(--fg)",
              fontSize: 12.5,
              fontFamily: "inherit",
            }}
          />
          <button
            type="button"
            disabled={busy || !answer.trim()}
            onClick={() =>
              onPatch({
                status: "todo",
                blocked_reason: null,
                hold_reason: null,
                receipt_type: "UNBLOCKED",
                receipt_body: answer.trim(),
                agent_code: "operator",
              })
            }
            style={{
              padding: "8px 14px",
              borderRadius: 8,
              border: "1px solid rgba(157,131,255,0.35)",
              background: "rgba(130,97,255,0.18)",
              color: "var(--fg)",
              fontSize: 12,
              cursor: busy || !answer.trim() ? "default" : "pointer",
              fontFamily: "inherit",
              opacity: busy || !answer.trim() ? 0.5 : 1,
            }}
          >
            Answer
          </button>
        </div>
      )}

      {/* Light controls */}
      <div
        style={{
          display: "flex",
          gap: 8,
          flexWrap: "wrap",
          borderTop: "1px solid var(--line)",
          paddingTop: 12,
        }}
      >
        {task.status !== "todo" &&
          task.status !== "standing" &&
          actionBtn("↺ Re-queue (todo)", { status: "todo" })}
        {task.status !== "done" &&
          task.status !== "standing" &&
          actionBtn("✓ Mark done", { status: "done" })}
        {task.status === "review" && actionBtn("Approve → done", { status: "done" })}
        {actionBtn(task.priority > 0 ? "Priority → 0" : "Priority → 1", {
          priority: task.priority > 0 ? 0 : 1,
        })}
      </div>
    </ModalShell>
  );
}

function CreateModal({
  agents,
  onClose,
  onCreated,
}: {
  agents: string[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [agentCode, setAgentCode] = useState(agents[0] ?? "all");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [priority, setPriority] = useState(0);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    if (!title.trim()) return;
    setSaving(true);
    setErr(null);
    try {
      const res = await fetch("/api/engine/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agent_code: agentCode,
          title: title.trim(),
          body: body.trim() || undefined,
          priority,
        }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setErr(d.error ?? `create failed (${res.status})`);
        return;
      }
      onCreated();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "create failed");
    } finally {
      setSaving(false);
    }
  }

  const inputStyle: React.CSSProperties = {
    width: "100%",
    padding: "8px 10px",
    borderRadius: 8,
    border: "1px solid var(--line-strong)",
    background: "var(--bg-2)",
    color: "var(--fg)",
    fontSize: 13,
    fontFamily: "inherit",
  };

  return (
    <ModalShell onClose={onClose}>
      <div style={{ fontSize: 15, fontWeight: 600, color: "var(--fg)" }}>
        File a task on the queue
      </div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <label style={{ fontSize: 11.5, color: "var(--fg-3)", flex: 1 }}>
          Assignee
          <select
            value={agentCode}
            onChange={(e) => setAgentCode(e.target.value)}
            style={{ ...inputStyle, marginTop: 4 }}
          >
            {agents.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </label>
        <label style={{ fontSize: 11.5, color: "var(--fg-3)", width: 110 }}>
          Priority
          <select
            value={priority}
            onChange={(e) => setPriority(Number(e.target.value))}
            style={{ ...inputStyle, marginTop: 4 }}
          >
            <option value={0}>0 — normal</option>
            <option value={1}>1 — soon</option>
            <option value={2}>2 — urgent</option>
          </select>
        </label>
      </div>
      <label style={{ fontSize: 11.5, color: "var(--fg-3)" }}>
        Title
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="What needs doing"
          style={{ ...inputStyle, marginTop: 4 }}
          autoFocus
        />
      </label>
      <label style={{ fontSize: 11.5, color: "var(--fg-3)" }}>
        Body (scope, context, acceptance)
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={5}
          style={{ ...inputStyle, marginTop: 4, resize: "vertical" }}
        />
      </label>
      {err && (
        <div style={{ fontSize: 12, color: "var(--crit)" }}>⚠ {err}</div>
      )}
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
        <button
          type="button"
          onClick={onClose}
          style={{
            padding: "7px 14px",
            borderRadius: 8,
            border: "1px solid var(--line-strong)",
            background: "transparent",
            color: "var(--fg-3)",
            fontSize: 12.5,
            cursor: "pointer",
            fontFamily: "inherit",
          }}
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={saving || !title.trim()}
          onClick={submit}
          style={{
            padding: "7px 16px",
            borderRadius: 8,
            border: "1px solid rgba(157,131,255,0.35)",
            background:
              "linear-gradient(180deg, rgba(130,97,255,0.3), rgba(130,97,255,0.15))",
            color: "var(--fg)",
            fontSize: 12.5,
            fontWeight: 500,
            cursor: saving || !title.trim() ? "default" : "pointer",
            fontFamily: "inherit",
            opacity: saving || !title.trim() ? 0.5 : 1,
          }}
        >
          {saving ? "Filing…" : "File task"}
        </button>
      </div>
    </ModalShell>
  );
}
