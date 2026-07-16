"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

// One row of the unioned "needs your call" feed (rest-api GET /needs-attention).
interface QueryItem {
  kind: "escalation" | "classification";
  id: number;
  content_preview: string;
  reason: string | null;
  current_classification: "work" | "personal" | null;
  decision: string | null; // NEW | UPDATE (escalation only)
  target_id: number | null; // escalation UPDATE merge target
  raised_at: string;
  created_at: string;
  source_type: string | null;
}

interface QueriesPanelProps {
  // Bubble the open-count up so the toggle badge stays in sync after actions.
  onCountChange?: (count: number) => void;
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function QueriesPanel({ onCountChange }: QueriesPanelProps) {
  const [items, setItems] = useState<QueryItem[]>([]);
  const [counts, setCounts] = useState({ escalation: 0, classification: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // ids currently being resolved (buttons disabled + spinner)
  const [busy, setBusy] = useState<Set<number>>(new Set());

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/needs-attention", { cache: "no-store" });
      if (!res.ok) throw new Error(await res.text().catch(() => res.statusText));
      const data = await res.json();
      const list: QueryItem[] = data.items || [];
      setItems(list);
      setCounts({
        escalation: data.escalation_count ?? 0,
        classification: data.classification_count ?? 0,
      });
      onCountChange?.(data.count ?? list.length);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [onCountChange]);

  useEffect(() => {
    load();
  }, [load]);

  async function resolveClassification(id: number, classification: "work" | "personal") {
    setBusy((prev) => new Set(prev).add(id));
    try {
      const res = await fetch("/api/needs-attention/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, classification }),
      });
      if (!res.ok) throw new Error(await res.text().catch(() => res.statusText));
      // Optimistic: drop the row locally, then reconcile the count.
      setItems((prev) => {
        const next = prev.filter((it) => !(it.kind === "classification" && it.id === id));
        onCountChange?.(next.length);
        return next;
      });
      setCounts((c) => ({ ...c, classification: Math.max(0, c.classification - 1) }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to resolve");
    } finally {
      setBusy((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }

  const KIND_META = {
    escalation: { label: "Escalation", color: "#ffb787", bg: "rgba(255,150,80,0.10)", border: "rgba(255,150,80,0.25)" },
    classification: { label: "Work / Personal", color: "var(--violet-300)", bg: "rgba(157,131,255,0.10)", border: "rgba(157,131,255,0.25)" },
  } as const;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Summary strip */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 16,
          padding: "14px 18px",
          borderRadius: 12,
          background: "var(--bg-2)",
          border: "1px solid var(--line)",
          flexWrap: "wrap",
        }}
      >
        <span style={{ fontSize: 14, fontWeight: 600, color: "var(--fg)" }}>
          ⚑ Needs your call
        </span>
        <span style={{ fontSize: 12.5, color: "var(--fg-3)" }}>
          {loading
            ? "Loading…"
            : items.length === 0
              ? "Nothing pending — you're all caught up. ✓"
              : `${items.length} item${items.length === 1 ? "" : "s"} the AI flagged for a decision`}
        </span>
        <span style={{ display: "flex", gap: 8, marginLeft: "auto", flexWrap: "wrap" }}>
          <span style={{ fontSize: 11, fontFamily: "var(--font-mono)", color: KIND_META.classification.color, padding: "2px 8px", borderRadius: 4, background: KIND_META.classification.bg, border: `1px solid ${KIND_META.classification.border}` }}>
            {counts.classification} work/personal
          </span>
          <span style={{ fontSize: 11, fontFamily: "var(--font-mono)", color: KIND_META.escalation.color, padding: "2px 8px", borderRadius: 4, background: KIND_META.escalation.bg, border: `1px solid ${KIND_META.escalation.border}` }}>
            {counts.escalation} escalation{counts.escalation === 1 ? "" : "s"}
          </span>
          <button
            type="button"
            onClick={load}
            style={{ padding: "2px 10px", fontSize: 11, borderRadius: 6, border: "1px solid var(--line)", background: "var(--bg-3)", color: "var(--fg-2)", cursor: "pointer", fontFamily: "inherit" }}
          >
            ↻ Refresh
          </button>
        </span>
      </div>

      {error && (
        <div style={{ padding: 12, borderRadius: 8, background: "rgba(255,80,80,0.08)", border: "1px solid rgba(255,80,80,0.25)", color: "#ff9b9b", fontSize: 12 }}>
          {error}{" "}
          <button type="button" onClick={load} style={{ marginLeft: 8, background: "transparent", border: "1px solid currentColor", color: "inherit", padding: "2px 8px", borderRadius: 4, fontSize: 11, cursor: "pointer", fontFamily: "inherit" }}>
            Retry
          </button>
        </div>
      )}

      {/* List */}
      <div style={{ background: "var(--bg-2)", border: "1px solid var(--line)", borderRadius: 12, overflow: "hidden" }}>
        {!loading && items.length === 0 && (
          <div style={{ padding: 40, textAlign: "center", color: "var(--fg-4)", fontSize: 13 }}>
            Inbox zero — no open queries. ✓
          </div>
        )}
        {items.map((it, i) => {
          const meta = KIND_META[it.kind];
          const isBusy = busy.has(it.id);
          return (
            <div
              key={`${it.kind}-${it.id}`}
              style={{
                display: "flex",
                gap: 16,
                padding: "16px 20px",
                borderBottom: i < items.length - 1 ? "1px solid var(--line)" : "none",
                alignItems: "flex-start",
              }}
            >
              <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0, flex: 1 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 10.5, fontFamily: "var(--font-mono)", color: meta.color, padding: "2px 8px", borderRadius: 4, background: meta.bg, border: `1px solid ${meta.border}` }}>
                    {meta.label}
                  </span>
                  <Link href={`/thoughts/${it.id}`} style={{ fontSize: 11, fontFamily: "var(--font-mono)", color: "var(--fg-4)", textDecoration: "none" }}>
                    #{it.id}
                  </Link>
                  {it.kind === "escalation" && it.decision && (
                    <span style={{ fontSize: 10.5, fontFamily: "var(--font-mono)", color: "var(--fg-4)" }}>
                      {it.decision === "UPDATE" && it.target_id ? `→ merge into #${it.target_id}` : "new capture"}
                    </span>
                  )}
                  {it.kind === "classification" && it.current_classification && (
                    <span style={{ fontSize: 10.5, fontFamily: "var(--font-mono)", color: "var(--fg-4)" }}>
                      best guess: {it.current_classification}
                    </span>
                  )}
                  <span style={{ fontSize: 10.5, color: "var(--fg-4)", marginLeft: "auto" }}>
                    {timeAgo(it.raised_at)}
                  </span>
                </div>
                <span style={{ fontSize: 13.5, color: "var(--fg-2)", lineHeight: 1.5, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
                  {it.content_preview}
                </span>
                {it.reason && (
                  <span style={{ fontSize: 12, color: "var(--fg-3)", fontStyle: "italic" }}>
                    {it.kind === "escalation" ? "❓ " : "🤔 "}
                    {it.reason}
                  </span>
                )}
              </div>

              {/* Actions */}
              <div style={{ display: "flex", flexDirection: "column", gap: 6, flexShrink: 0, minWidth: 150, alignItems: "stretch" }}>
                {it.kind === "classification" ? (
                  <>
                    <div style={{ display: "flex", gap: 6 }}>
                      {(["work", "personal"] as const).map((cls) => {
                        const isCurrent = it.current_classification === cls;
                        return (
                          <button
                            key={cls}
                            type="button"
                            disabled={isBusy}
                            onClick={() => resolveClassification(it.id, cls)}
                            title={`Set ${cls} and clear this query`}
                            style={{
                              flex: 1,
                              padding: "7px 8px",
                              borderRadius: 7,
                              fontSize: 12,
                              fontWeight: 500,
                              cursor: isBusy ? "wait" : "pointer",
                              fontFamily: "inherit",
                              textTransform: "capitalize",
                              color: isCurrent ? "var(--fg)" : "var(--fg-2)",
                              background: isCurrent ? "rgba(130,97,255,0.18)" : "var(--bg-3)",
                              border: `1px solid ${isCurrent ? "rgba(157,131,255,0.35)" : "var(--line)"}`,
                              opacity: isBusy ? 0.6 : 1,
                            }}
                          >
                            {cls}
                          </button>
                        );
                      })}
                    </div>
                    <span style={{ fontSize: 10, color: "var(--fg-4)", textAlign: "center" }}>
                      pick one to resolve
                    </span>
                  </>
                ) : (
                  <>
                    <Link
                      href="/review"
                      style={{
                        padding: "7px 10px",
                        borderRadius: 7,
                        fontSize: 12,
                        fontWeight: 500,
                        textAlign: "center",
                        textDecoration: "none",
                        color: "var(--violet-200)",
                        background: "linear-gradient(180deg, rgba(157,131,255,0.2), rgba(130,97,255,0.1))",
                        border: "1px solid rgba(157,131,255,0.3)",
                      }}
                    >
                      Review →
                    </Link>
                    <span style={{ fontSize: 10, color: "var(--fg-4)", textAlign: "center" }}>
                      approve / answer / drop
                    </span>
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
