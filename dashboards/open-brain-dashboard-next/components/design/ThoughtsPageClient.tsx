"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { Thought } from "@/lib/types";
import { THOUGHT_TYPES } from "@/lib/types";
import { ImpDots, ScoreBar, SegBar, TypeChip, importanceToFiveScale } from "./Atoms";
import { AddToBrain } from "@/components/AddToBrain";
import { QueriesPanel } from "./QueriesPanel";

type Context = "All" | "Work" | "Personal";
type SearchMode = "Semantic" | "Full-text";

interface InitialState {
  total: number;
  sources: { source_type: string; count: number }[];
  lowScoreCount: number;
  duplicatesCount: number;
}

interface ThoughtsPageClientProps {
  initial: InitialState;
  initialQuery: string;
  initialMode: SearchMode;
  initialContext: Context;
  initialType: string;
  initialSource: string;
  initialMaxScore: number;
  initialDuplicatesOnly: boolean;
  initialCompose: boolean;
  initialQueriesOnly: boolean;
}

// No hardcoded source list — real values come from /api/sources at mount time.

export function ThoughtsPageClient({
  initial,
  initialQuery,
  initialMode,
  initialContext,
  initialType,
  initialSource,
  initialMaxScore,
  initialDuplicatesOnly,
  initialCompose,
  initialQueriesOnly,
}: ThoughtsPageClientProps) {
  const router = useRouter();

  const [searchQuery, setSearchQuery] = useState(initialQuery);
  const [searchMode, setSearchMode] = useState<SearchMode>(initialMode);
  const [contextFilter, setContextFilter] = useState<Context>(initialContext);
  const [typeFilter, setTypeFilter] = useState<string>(initialType);
  const [sourceFilter, setSourceFilter] = useState<string>(initialSource);
  const [maxScore, setMaxScore] = useState<number>(initialMaxScore);
  const [duplicatesOnly, setDuplicatesOnly] = useState<boolean>(
    initialDuplicatesOnly
  );
  const [composeOpen, setComposeOpen] = useState<boolean>(initialCompose);
  const [queriesOnly, setQueriesOnly] = useState<boolean>(initialQueriesOnly);
  const [queryCount, setQueryCount] = useState<number | null>(null);

  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<Thought[]>([]);
  const [total, setTotal] = useState(initial.total);
  const [loading, setLoading] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);

  const PER_PAGE = 25;
  const isAuditMode = maxScore < 100;
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Sync state to URL so deep links + back/forward work. Lightweight filters
  // (search, type, source, score, duplicates) only update the URL — the table
  // refetches client-side. Context changes additionally trigger a server
  // re-render via router.replace so the KPI strip recomputes against the new
  // classification.
  useEffect(() => {
    const sp = new URLSearchParams();
    if (searchQuery) sp.set("q", searchQuery);
    if (searchMode === "Full-text") sp.set("mode", "text");
    if (contextFilter !== "All")
      sp.set("classification", contextFilter.toLowerCase());
    if (typeFilter) sp.set("type", typeFilter);
    if (sourceFilter) sp.set("source_type", sourceFilter);
    if (maxScore < 100) sp.set("score_max", String(maxScore));
    if (duplicatesOnly) sp.set("duplicates", "1");
    if (queriesOnly) sp.set("queries", "1");
    const qs = sp.toString();
    const target = `/thoughts${qs ? `?${qs}` : ""}`;
    if (
      typeof window !== "undefined" &&
      window.location.pathname + window.location.search !== target
    ) {
      window.history.replaceState(null, "", target);
    }
  }, [searchQuery, searchMode, contextFilter, typeFilter, sourceFilter, maxScore, duplicatesOnly, queriesOnly]);

  // Context changes hit the server so the KPI strip reflows. Skip the first
  // mount — initialContext already came from the URL, so re-issuing the same
  // navigation would be a wasted round-trip.
  const firstContextSync = useRef(true);
  useEffect(() => {
    if (firstContextSync.current) {
      firstContextSync.current = false;
      return;
    }
    const sp = new URLSearchParams(
      typeof window !== "undefined" ? window.location.search : ""
    );
    if (contextFilter === "All") sp.delete("classification");
    else sp.set("classification", contextFilter.toLowerCase());
    const qs = sp.toString();
    router.replace(`/thoughts${qs ? `?${qs}` : ""}`, { scroll: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contextFilter]);

  // Open-query count for the "Queries" toggle badge. Fetched on mount and kept
  // in sync by QueriesPanel's onCountChange while the panel is open.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/needs-attention", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled && d) setQueryCount(d.count ?? 0);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Fetch handler
  const fetchData = useCallback(async () => {
    if (queriesOnly) return; // Queries mode renders QueriesPanel, not the table
    setLoading(true);
    setErrorText(null);
    try {
      let endpoint = "";
      const params = new URLSearchParams();

      if (duplicatesOnly) {
        // Show all thoughts that are part of any duplicate pair
        endpoint = "/api/duplicates";
        params.set("threshold", "0.85");
        params.set("limit", "100");
        params.set("offset", String((page - 1) * 50));
        if (contextFilter !== "All")
          params.set("classification", contextFilter.toLowerCase());
        const res = await fetch(`${endpoint}?${params}`);
        if (!res.ok) throw new Error(await res.text().catch(() => res.statusText));
        const data = await res.json();
        const pairs: Array<{
          thought_a_serial: number;
          thought_b_serial: number;
          content_a: string;
          content_b: string;
          thought_a_created: string;
          thought_b_created: string;
          similarity: number;
        }> = data.pairs || [];
        // Flatten pairs into a list of thought rows. Both members of each pair
        // are shown (deduped by serial_id across overlapping pairs). The RPC
        // doesn't return type/quality, so those default safely — the useful
        // dedup signals here are content, similarity, and the link to each row.
        const seen = new Set<number>();
        const flat: Thought[] = [];
        for (const p of pairs) {
          const sides = [
            { id: p.thought_a_serial, content: p.content_a, created: p.thought_a_created, other: p.thought_b_serial },
            { id: p.thought_b_serial, content: p.content_b, created: p.thought_b_created, other: p.thought_a_serial },
          ];
          for (const s of sides) {
            if (s.id == null || seen.has(s.id)) continue;
            seen.add(s.id);
            flat.push({
              id: s.id,
              content: s.content ?? "",
              type: "",
              source_type: "",
              importance: 0,
              quality_score: 0,
              metadata: { _duplicate_of: s.other, _similarity: p.similarity },
              created_at: s.created ?? "",
              updated_at: s.created ?? "",
              status: null,
              status_updated_at: null,
            });
          }
        }
        setRows(flat);
        setTotal(flat.length);
        return;
      }

      if (searchQuery.trim()) {
        endpoint = "/api/search";
        params.set("q", searchQuery.trim());
        params.set("mode", searchMode === "Semantic" ? "semantic" : "text");
        params.set("page", String(page));
        if (contextFilter !== "All")
          params.set("classification", contextFilter.toLowerCase());
        const res = await fetch(`${endpoint}?${params}`);
        if (!res.ok) throw new Error(await res.text().catch(() => res.statusText));
        const data = await res.json();
        // Apply remaining filters client-side because the search endpoint
        // doesn't accept type/source/score filters.
        let results: Thought[] = data.results || [];
        if (typeFilter) results = results.filter((r) => r.type === typeFilter);
        if (sourceFilter)
          results = results.filter((r) => r.source_type === sourceFilter);
        if (isAuditMode)
          results = results.filter((r) => (r.quality_score ?? 0) <= maxScore);
        setRows(results);
        setTotal(data.total || results.length);
        return;
      }

      // Default browse
      params.set("page", String(page));
      params.set("per_page", String(PER_PAGE));
      if (contextFilter !== "All")
        params.set("classification", contextFilter.toLowerCase());
      if (typeFilter) params.set("type", typeFilter);
      if (sourceFilter) params.set("source_type", sourceFilter);
      if (isAuditMode) {
        params.set("quality_score_max", String(maxScore));
        params.set("sort", "quality_score");
        params.set("order", "asc");
      } else {
        params.set("sort", "created_at");
        params.set("order", "desc");
      }
      const res = await fetch(`/api/thoughts/list?${params}`);
      if (!res.ok) throw new Error(await res.text().catch(() => res.statusText));
      const data = await res.json();
      setRows(data.data || []);
      setTotal(data.total || 0);
    } catch (err) {
      setErrorText(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [searchQuery, searchMode, contextFilter, typeFilter, sourceFilter, maxScore, duplicatesOnly, page, isAuditMode, queriesOnly]);

  // Debounce search; refetch immediately on filter changes
  useEffect(() => {
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(fetchData, searchQuery.trim() ? 250 : 0);
    return () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
    };
  }, [fetchData]);

  // Reset page when any filter changes
  useEffect(() => {
    setPage(1);
  }, [searchQuery, searchMode, contextFilter, typeFilter, sourceFilter, maxScore, duplicatesOnly]);

  // Mark a surfaced pair as "not a duplicate" — persists server-side so the pair
  // never resurfaces (dashboard + MCP report alike). Optimistically drop both
  // sides from the current view, then reconcile against the RPC via a refetch.
  const [dismissing, setDismissing] = useState<Set<number>>(new Set());
  const dismissDuplicatePair = useCallback(
    async (a: number, b: number) => {
      setDismissing((prev) => new Set(prev).add(a));
      try {
        const res = await fetch("/api/duplicates/dismiss", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ a, b }),
        });
        if (!res.ok) throw new Error(await res.text().catch(() => res.statusText));
        setRows((prev) => prev.filter((r) => r.id !== a && r.id !== b));
        setTotal((t) => Math.max(0, t - 2));
        fetchData();
      } catch (err) {
        setErrorText(err instanceof Error ? err.message : "Failed to dismiss");
      } finally {
        setDismissing((prev) => {
          const next = new Set(prev);
          next.delete(a);
          return next;
        });
      }
    },
    [fetchData]
  );

  const totalPages = Math.max(1, Math.ceil(total / PER_PAGE));

  const sources = useMemo(
    () => initial.sources.map((s) => s.source_type),
    [initial.sources]
  );

  return (
    <div
      className="ob1-fullbleed from-legacy"
      style={{
        background: "var(--bg-0)",
        fontFamily: "var(--font-sans)",
        minHeight: "100vh",
      }}
    >
      <div
        className="mobile-pad"
        style={{
          padding: "32px 40px 56px",
          display: "flex",
          flexDirection: "column",
          gap: 22,
        }}
      >
        {/* Header */}
        <div
          className="mobile-wrap"
          style={{
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: 24,
            flexWrap: "wrap",
          }}
        >
          <div>
            <div className="eyebrow" style={{ marginBottom: 8 }}>
              Brain · Thoughts
            </div>
            <h1
              className="mobile-h1"
              style={{
                margin: 0,
                fontSize: 30,
                fontWeight: 600,
                letterSpacing: "-0.025em",
                color: "var(--fg)",
              }}
            >
              {initial.total.toLocaleString()} thoughts in your memory
            </h1>
            <p
              style={{
                margin: "6px 0 0",
                color: "var(--fg-3)",
                fontSize: 14,
                maxWidth: 640,
              }}
            >
              One unified view: search, filter, audit low-quality captures, and
              spot duplicates — without leaving the page.
            </p>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              onClick={() => setQueriesOnly((v) => !v)}
              title="Items the AI has flagged for your decision (work/personal calls + escalations)"
              style={{
                padding: "8px 12px",
                borderRadius: 8,
                border: `1px solid ${queriesOnly ? "rgba(157,131,255,0.45)" : "var(--line-strong)"}`,
                background: queriesOnly
                  ? "rgba(130,97,255,0.18)"
                  : "var(--bg-2)",
                color: queriesOnly ? "var(--violet-200)" : "var(--fg-2)",
                fontSize: 12,
                cursor: "pointer",
                fontFamily: "inherit",
                display: "flex",
                alignItems: "center",
                gap: 6,
              }}
            >
              ⚑ Queries
              {queryCount != null && queryCount > 0 && (
                <span
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: 10.5,
                    padding: "0 6px",
                    borderRadius: 20,
                    background: queriesOnly
                      ? "rgba(157,131,255,0.3)"
                      : "rgba(255,150,80,0.18)",
                    color: queriesOnly ? "var(--violet-100)" : "#ffb787",
                    border: `1px solid ${queriesOnly ? "rgba(157,131,255,0.4)" : "rgba(255,150,80,0.3)"}`,
                  }}
                >
                  {queryCount}
                </span>
              )}
            </button>
            <button
              type="button"
              onClick={() => router.push("/ingest")}
              style={{
                padding: "8px 12px",
                borderRadius: 8,
                border: "1px solid var(--line-strong)",
                background: "var(--bg-2)",
                color: "var(--fg-2)",
                fontSize: 12,
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              Job history
            </button>
            <button
              type="button"
              onClick={() => setComposeOpen((v) => !v)}
              style={{
                padding: "8px 12px",
                borderRadius: 8,
                border: "1px solid rgba(157,131,255,0.3)",
                background:
                  "linear-gradient(180deg, rgba(157,131,255,0.2), rgba(130,97,255,0.1))",
                color: "var(--violet-200)",
                fontSize: 12.5,
                fontWeight: 500,
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                gap: 6,
                fontFamily: "inherit",
              }}
            >
              {composeOpen ? "× Close" : "+ New thought"}
            </button>
          </div>
        </div>

        {/* Compose */}
        {composeOpen && (
          <div
            style={{
              padding: 16,
              borderRadius: 12,
              background: "var(--bg-2)",
              border: "1px solid var(--line)",
            }}
          >
            <AddToBrain
              rows={3}
              onSuccess={() => {
                setComposeOpen(false);
                fetchData();
              }}
            />
          </div>
        )}

        {queriesOnly ? (
          <QueriesPanel onCountChange={setQueryCount} />
        ) : (
          <>
        {/* Inline KPIs */}
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            background: "var(--bg-2)",
            border: "1px solid var(--line)",
            borderRadius: 12,
          }}
        >
          {[
            {
              eb: "Total",
              n: initial.total.toLocaleString(),
              sub: total !== initial.total ? `${total.toLocaleString()} match filters` : "all captured thoughts",
              c: "var(--ok)",
            },
            {
              eb: "Sources",
              n: String(sources.length),
              sub:
                sources.slice(0, 3).join(", ") +
                (sources.length > 3 ? ", …" : ""),
              c: "var(--fg-3)",
            },
            {
              eb: "Low score",
              n: String(initial.lowScoreCount),
              sub: "score ≤ 15 — audit candidates",
              c: "#ffb787",
            },
            {
              eb: "Likely duplicates",
              n: String(initial.duplicatesCount),
              sub: "fingerprint match",
              c: "#ffb787",
            },
            {
              eb: "Filtered",
              n: String(rows.length),
              sub: "on this page",
              c: "var(--violet-300)",
            },
          ].map((k, i, arr) => (
            <div
              key={k.eb}
              style={{
                flex: "1 1 180px",
                padding: "16px 20px",
                borderRight:
                  i < arr.length - 1 ? "1px solid var(--line)" : "none",
                display: "flex",
                flexDirection: "column",
                gap: 4,
              }}
            >
              <span className="eyebrow">{k.eb}</span>
              <span
                className="num"
                style={{
                  fontSize: 22,
                  fontWeight: 600,
                  lineHeight: 1.1,
                  color: "var(--fg)",
                }}
              >
                {k.n}
              </span>
              <span style={{ fontSize: 11, color: k.c }}>{k.sub}</span>
            </div>
          ))}
        </div>

        {/* Filter rail */}
        <div
          style={{
            padding: 16,
            borderRadius: 12,
            background: "var(--bg-2)",
            border: "1px solid var(--line)",
            display: "flex",
            gap: 14,
            alignItems: "flex-end",
            flexWrap: "wrap",
          }}
        >
          <div
            style={{
              flex: "2 1 280px",
              minWidth: 280,
              display: "flex",
              flexDirection: "column",
              gap: 6,
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <span className="eyebrow">Search</span>
              <SegBar
                options={["Semantic", "Full-text"] as const}
                active={searchMode}
                onChange={setSearchMode}
                size="sm"
              />
            </div>
            <div
              style={{
                padding: "8px 10px",
                borderRadius: 8,
                background: "var(--bg-3)",
                border: "1px solid var(--line)",
                display: "flex",
                alignItems: "center",
                gap: 8,
                color: "var(--fg-2)",
                fontSize: 13,
              }}
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="var(--fg-4)"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="11" cy="11" r="6" />
                <path d="m20 20-4-4" />
              </svg>
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search by meaning, or @entity, #tag, type:task imp:>50…"
                style={{
                  flex: 1,
                  background: "transparent",
                  border: "none",
                  outline: "none",
                  color: "var(--fg)",
                  fontSize: 13,
                  fontFamily: "inherit",
                }}
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery("")}
                  style={{
                    background: "transparent",
                    border: "none",
                    color: "var(--fg-4)",
                    cursor: "pointer",
                    fontSize: 12,
                  }}
                >
                  ×
                </button>
              )}
            </div>
          </div>

          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 6,
            }}
          >
            <span className="eyebrow">Context</span>
            <SegBar
              options={["All", "Work", "Personal"] as const}
              active={contextFilter}
              onChange={setContextFilter}
            />
          </div>

          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 6,
              minWidth: 130,
            }}
          >
            <span className="eyebrow">Type</span>
            <select
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value)}
              style={{
                padding: "7px 10px",
                borderRadius: 8,
                fontSize: 13,
                background: "var(--bg-3)",
                border: "1px solid var(--line)",
                color: "var(--fg-2)",
                fontFamily: "inherit",
                outline: "none",
              }}
            >
              <option value="">All types</option>
              {THOUGHT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>

          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 6,
              minWidth: 150,
            }}
          >
            <span className="eyebrow">Source</span>
            <select
              value={sourceFilter}
              onChange={(e) => setSourceFilter(e.target.value)}
              style={{
                padding: "7px 10px",
                borderRadius: 8,
                fontSize: 13,
                background: "var(--bg-3)",
                border: "1px solid var(--line)",
                color: "var(--fg-2)",
                fontFamily: "inherit",
                outline: "none",
              }}
            >
              <option value="">All sources</option>
              {sources.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>

          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              fontSize: 12,
              color: "var(--fg-3)",
              cursor: "pointer",
              padding: "0 4px 4px",
            }}
          >
            <input
              type="checkbox"
              checked={duplicatesOnly}
              onChange={(e) => setDuplicatesOnly(e.target.checked)}
              style={{ accentColor: "var(--violet-400)" }}
            />
            Duplicates only
          </label>
        </div>

        {/* Score range */}
        <div
          style={{
            padding: "14px 18px",
            borderRadius: 12,
            background: "var(--bg-2)",
            border: "1px solid var(--line)",
            display: "flex",
            gap: 32,
            alignItems: "center",
            flexWrap: "wrap",
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <span className="eyebrow">Score range</span>
            <span style={{ fontSize: 10.5, color: "var(--fg-4)" }}>
              heuristic · worker.js
            </span>
          </div>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 4,
              flex: 1,
              minWidth: 240,
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                fontSize: 11,
                color: "var(--fg-3)",
              }}
            >
              <span>
                Min{" "}
                <span
                  style={{ fontFamily: "var(--font-mono)", color: "var(--fg-2)" }}
                >
                  0
                </span>
              </span>
              <span>
                Max{" "}
                <span
                  style={{
                    fontFamily: "var(--font-mono)",
                    color: isAuditMode ? "#ffb787" : "var(--fg-2)",
                  }}
                >
                  {maxScore}
                </span>
                {isAuditMode && " · audit low-quality captures"}
              </span>
            </div>
            <input
              type="range"
              min={5}
              max={100}
              value={maxScore}
              onChange={(e) => setMaxScore(parseInt(e.target.value, 10))}
              style={{
                width: "100%",
                accentColor: isAuditMode ? "#ff9650" : "var(--violet-400)",
              }}
            />
          </div>
          <button
            type="button"
            onClick={() => setMaxScore(maxScore === 100 ? 15 : 100)}
            style={{
              padding: "6px 10px",
              borderRadius: 6,
              border: "1px solid var(--line)",
              background: "var(--bg-3)",
              color: "var(--fg-2)",
              fontSize: 11,
              cursor: "pointer",
              fontFamily: "inherit",
            }}
          >
            {maxScore === 100 ? "Audit mode" : "Reset"}
          </button>
        </div>

        {/* Active-filters summary */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            fontSize: 12,
            color: "var(--fg-3)",
            flexWrap: "wrap",
          }}
        >
          <span>
            Showing{" "}
            <span style={{ color: "var(--fg-2)", fontWeight: 500 }}>
              {rows.length}
            </span>{" "}
            of {total.toLocaleString()} thoughts
          </span>
          {isAuditMode && (
            <>
              <span style={{ color: "var(--fg-4)" }}>·</span>
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: 10.5,
                  padding: "2px 8px",
                  borderRadius: 4,
                  background: "rgba(255,150,80,0.10)",
                  color: "#ffb787",
                  border: "1px solid rgba(255,150,80,0.2)",
                }}
              >
                AUDIT MODE · score ≤ {maxScore}
              </span>
            </>
          )}
          {duplicatesOnly && (
            <>
              <span style={{ color: "var(--fg-4)" }}>·</span>
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: 10.5,
                  padding: "2px 8px",
                  borderRadius: 4,
                  background: "rgba(255,150,80,0.10)",
                  color: "#ffb787",
                  border: "1px solid rgba(255,150,80,0.2)",
                }}
              >
                DUPLICATES ONLY
              </span>
            </>
          )}
          {(typeFilter || sourceFilter || contextFilter !== "All" || searchQuery) && (
            <button
              type="button"
              onClick={() => {
                setSearchQuery("");
                setTypeFilter("");
                setSourceFilter("");
                setContextFilter("All");
                setMaxScore(100);
                setDuplicatesOnly(false);
              }}
              style={{
                marginLeft: "auto",
                padding: "2px 8px",
                fontSize: 11,
                color: "var(--violet-300)",
                background: "transparent",
                border: "1px solid var(--line)",
                borderRadius: 4,
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              Reset filters
            </button>
          )}
        </div>

        {/* Error */}
        {errorText && (
          <div
            style={{
              padding: 12,
              borderRadius: 8,
              background: "rgba(255,80,80,0.08)",
              border: "1px solid rgba(255,80,80,0.25)",
              color: "#ff9b9b",
              fontSize: 12,
            }}
          >
            {errorText}{" "}
            <button
              type="button"
              onClick={fetchData}
              style={{
                marginLeft: 8,
                background: "transparent",
                border: "1px solid currentColor",
                color: "inherit",
                padding: "2px 8px",
                borderRadius: 4,
                fontSize: 11,
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              Retry
            </button>
          </div>
        )}

        {/* Table */}
        <div
          style={{
            background: "var(--bg-2)",
            border: "1px solid var(--line)",
            borderRadius: 12,
            overflow: "hidden",
            position: "relative",
          }}
        >
          <div
            className="mobile-hide"
            style={{
              display: "grid",
              gridTemplateColumns:
                "minmax(0,1fr) 130px 150px 70px 70px 110px 60px",
              padding: "11px 20px",
              borderBottom: "1px solid var(--line)",
              background: "var(--bg-3)",
              gap: 16,
            }}
          >
            {[
              "Content",
              "Entity",
              "Type · Source",
              "Imp.",
              "Score",
              "Captured",
              "",
            ].map((h, i) => (
              <span key={i} className="eyebrow">
                {h}
              </span>
            ))}
          </div>
          {loading && rows.length === 0 && (
            <div
              style={{
                padding: 32,
                textAlign: "center",
                color: "var(--fg-4)",
                fontSize: 13,
              }}
            >
              Loading thoughts…
            </div>
          )}
          {!loading && rows.length === 0 && (
            <div
              style={{
                padding: 32,
                textAlign: "center",
                color: "var(--fg-4)",
                fontSize: 13,
              }}
            >
              {isAuditMode
                ? "Inbox zero — no low-score captures. ✓"
                : duplicatesOnly
                  ? "No likely duplicates found above threshold."
                  : "No thoughts match these filters."}
            </div>
          )}
          {rows.map((r, i) => {
            const isLow = (r.quality_score ?? 0) <= 15;
            const tags = ((r.metadata?.topics as string[]) ?? []).slice(0, 4);
            const entities = (r.metadata?.entities as Record<string, unknown>) ?? {};
            const entityNames = Object.keys(entities).filter(
              (e) => typeof entities[e] === "object" || typeof entities[e] === "string"
            );
            const who =
              entityNames[0] || tags[0] || (r.metadata?.who as string) || "—";
            const importance5 = importanceToFiveScale(r.importance ?? 0);
            const captured = formatDate(r.created_at);
            return (
              <Link
                key={r.id}
                href={`/thoughts/${r.id}`}
                className="mobile-stack"
                style={{
                  display: "grid",
                  gridTemplateColumns:
                    "minmax(0,1fr) 130px 150px 70px 70px 110px 60px",
                  padding: "14px 20px",
                  borderBottom:
                    i < rows.length - 1 ? "1px solid var(--line)" : "none",
                  alignItems: "flex-start",
                  gap: 16,
                  background: isLow
                    ? "rgba(255,150,80,0.04)"
                    : "transparent",
                  position: "relative",
                  textDecoration: "none",
                  color: "inherit",
                }}
              >
                {isLow && (
                  <span
                    style={{
                      position: "absolute",
                      left: 0,
                      top: 0,
                      bottom: 0,
                      width: 2,
                      background: "#ff9650",
                    }}
                  />
                )}
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: 6,
                    paddingRight: 8,
                    minWidth: 0,
                  }}
                >
                  <span
                    style={{
                      fontSize: 13.5,
                      color: "var(--fg-2)",
                      lineHeight: 1.5,
                      display: "-webkit-box",
                      WebkitLineClamp: 3,
                      WebkitBoxOrient: "vertical",
                      overflow: "hidden",
                    }}
                  >
                    {r.content}
                  </span>
                  {tags.length > 0 && (
                    <div
                      style={{
                        display: "flex",
                        gap: 8,
                        flexWrap: "wrap",
                      }}
                    >
                      {tags.map((t) => (
                        <span
                          key={t}
                          style={{
                            fontFamily: "var(--font-mono)",
                            fontSize: 10,
                            color: "var(--fg-4)",
                            padding: "1px 6px",
                            borderRadius: 3,
                            background: "rgba(255,255,255,0.03)",
                            border: "1px solid var(--line)",
                          }}
                        >
                          #{t}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                <span
                  style={{
                    fontSize: 12,
                    color: who === "—" ? "var(--fg-4)" : "var(--fg-2)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                  title={who}
                >
                  {who}
                </span>
                <TypeChip type={r.type} source={r.source_type} />
                <ImpDots value={importance5} />
                <ScoreBar value={r.quality_score ?? 0} />
                <span
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: 11,
                    color: "var(--fg-3)",
                  }}
                >
                  {captured}
                </span>
                <span
                  style={{
                    display: "flex",
                    gap: 6,
                    justifyContent: "flex-end",
                    alignItems: "center",
                    color: "var(--fg-4)",
                    fontSize: 12,
                  }}
                >
                  {duplicatesOnly && r.metadata?._duplicate_of != null ? (
                    <button
                      type="button"
                      title="Not a duplicate — stop surfacing this pair"
                      disabled={dismissing.has(r.id)}
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        dismissDuplicatePair(
                          r.id,
                          Number(r.metadata!._duplicate_of)
                        );
                      }}
                      style={{
                        fontSize: 10.5,
                        padding: "3px 7px",
                        borderRadius: 5,
                        whiteSpace: "nowrap",
                        cursor: dismissing.has(r.id) ? "default" : "pointer",
                        opacity: dismissing.has(r.id) ? 0.5 : 1,
                        color: "var(--fg-3)",
                        background: "var(--bg-3)",
                        border: "1px solid var(--line)",
                        fontFamily: "inherit",
                      }}
                    >
                      {dismissing.has(r.id) ? "…" : "Not a dup"}
                    </button>
                  ) : (
                    <span>→</span>
                  )}
                </span>
              </Link>
            );
          })}
          {loading && rows.length > 0 && (
            <div
              style={{
                position: "absolute",
                top: 0,
                right: 0,
                padding: "11px 20px",
                fontSize: 11,
                color: "var(--fg-4)",
              }}
            >
              Loading…
            </div>
          )}
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              fontSize: 12,
              color: "var(--fg-4)",
              padding: "0 4px",
            }}
          >
            <span>
              Page {page} of {totalPages}
            </span>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                type="button"
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1}
                style={{
                  padding: "4px 10px",
                  border: "1px solid var(--line)",
                  borderRadius: 6,
                  background: "transparent",
                  color: page <= 1 ? "var(--fg-4)" : "var(--fg-2)",
                  cursor: page <= 1 ? "not-allowed" : "pointer",
                  fontFamily: "inherit",
                  fontSize: 12,
                }}
              >
                ← Prev
              </button>
              <button
                type="button"
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page >= totalPages}
                style={{
                  padding: "4px 10px",
                  border: "1px solid var(--line)",
                  borderRadius: 6,
                  background: "transparent",
                  color: page >= totalPages ? "var(--fg-4)" : "var(--fg-2)",
                  cursor: page >= totalPages ? "not-allowed" : "pointer",
                  fontFamily: "inherit",
                  fontSize: 12,
                }}
              >
                Next →
              </button>
            </div>
          </div>
        )}
          </>
        )}
      </div>
    </div>
  );
}

function formatDate(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${mm}/${dd} ${hh}:${mi}`;
}
