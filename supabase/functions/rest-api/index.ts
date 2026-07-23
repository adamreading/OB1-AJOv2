import { Hono } from "hono";
import { cors } from "hono/cors";
import { createClient } from "@supabase/supabase-js";

const app = new Hono();

// CORS config - allow everything
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-brain-key, accept",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
};

app.use("*", cors());

const supabase = createClient(
  Deno.env.get("SUPABASE_URL") ?? "",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
);

// Fallback chain for the access key
const API_ACCESS_KEY = Deno.env.get("MCP_ACCESS_KEY") ||
                       Deno.env.get("BRAIN_KEY") ||
                       Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

// --- MIDDLEWARE ---

app.use("*", async (c, next) => {
  if (c.req.method === "OPTIONS") return c.text("ok", 200, corsHeaders);

  const provided = c.req.header("x-brain-key") ||
                   c.req.header("Authorization")?.replace("Bearer ", "") ||
                   new URL(c.req.url).searchParams.get("key");

  if (!provided || provided !== API_ACCESS_KEY) {
    return c.json({ error: "Unauthorized: Invalid or missing access key" }, 401, corsHeaders);
  }
  await next();
});

// Returns null instead of throwing so search gracefully falls back to text
async function getEmbedding(text: string): Promise<number[] | null> {
  const apiKey = Deno.env.get("OPENROUTER_API_KEY");
  if (!apiKey) return null;
  try {
    const r = await fetch("https://openrouter.ai/api/v1/embeddings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "openai/text-embedding-3-small",
        input: text,
      }),
    });
    if (!r.ok) return null;
    const d = await r.json();
    return d.data[0].embedding;
  } catch {
    return null;
  }
}

// Flatten an embedded thought_entities[] (each with a nested entities row) into
// the compact shape curators/agents need: one element per linked entity. Used
// by GET /thoughts, GET /thought/:id, and GET /thought/:id/entities so an agent
// (the Hermes agent) can satisfy a "has >=1 linked entity" check without a second call.
const flattenEntities = (te: any): Array<Record<string, unknown>> =>
  (Array.isArray(te) ? te : [])
    .map((r: any) => ({
      entity_id: r.entity_id,
      canonical_name: r.entities?.canonical_name ?? null,
      entity_type: r.entities?.entity_type ?? null,
      mention_role: r.mention_role ?? null,
      confidence: r.confidence ?? null,
    }))
    .filter((e: any) => e.canonical_name != null);

// Explicit thoughts column list EXCLUDING `embedding`. Selecting "*" ships the
// 1536-dim pgvector embedding (~19KB/row as JSON — ~87% of a row's bytes, vs
// ~2.8KB content) on EVERY row of a list/browse response. rest-api runs its
// supabase client against the PUBLIC /rest/v1 URL, so that DB->function hop is
// billed as PostgREST egress — a per_page=30000 browse shipped ~12MB of unused
// embeddings per call and drove a free-tier egress overage (2026-07-14). No
// list/browse/search/detail consumer needs the vector, so we never select it.
// (Semantic search uses the embedding server-side via the match RPC, not here.)
const THOUGHT_COLS =
  "id, content, metadata, created_at, updated_at, version, content_fingerprint, serial_id, type, importance, quality_score, source_type, enriched, status, status_updated_at, classification, blocklist_hits, derived_from, derivation_method, derivation_layer, supersedes, sensitivity_tier";

// Map database thoughts to Dashboard-expected format (swapping serial_id -> id)
const mapThought = (t: any) => {
  if (!t) return null;
  return {
    ...t,
    id: t.serial_id,
    uuid: t.id
  };
};

const getIdentityFilter = (id: string) => {
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
  return isUuid ? { id } : { serial_id: parseInt(id, 10) };
};

async function fingerprint(text: string): Promise<string> {
  const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalized));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
}

// --- ROUTES ---

// Health
app.get("/health", (c) => c.json({ status: "ok", version: "2.9.0-pro" }));

// Quotas — for each cap-bound endpoint, report current row count vs cap so
// the dashboard can show a tripwire banner before any silent ceiling bites.
// Anything over 0.8 utilization is "near_cap"; anything over 1.0 means data
// is being silently truncated and an immediate fix is required.
app.get("/health/quotas", async (c) => {
  // Caps the rest-api currently enforces. Aggregation endpoints (/sources,
  // /entity-types) and /constellation use SQL GROUP BY now and have no
  // intrinsic cap — they're absent here intentionally.
  const checks: Array<{
    name: string;
    table: string;
    cap: number;
    note: string;
    countQuery: () => Promise<{ count: number | null; error: string | null }>;
  }> = [
    {
      name: "entities (/entities default per page)",
      table: "entities",
      cap: 5000, // search_entities() max p_limit
      note: "Default /entities returns 200 rows; ?limit=N up to 5000. Past 5000 the modal needs server pagination.",
      countQuery: async () => {
        const { count, error } = await supabase
          .from("entities")
          .select("id", { count: "exact", head: true });
        return { count: count ?? null, error: error?.message ?? null };
      },
    },
    {
      name: "wiki_pages (/wiki-pages per page)",
      table: "wiki_pages",
      cap: 10000, // /wiki-pages max per_page
      note: "Single page caps at 10000. Pagination via ?page= for larger sets.",
      countQuery: async () => {
        const { count, error } = await supabase
          .from("wiki_pages")
          .select("id", { count: "exact", head: true });
        return { count: count ?? null, error: error?.message ?? null };
      },
    },
    {
      name: "search_entities (alias-aware search)",
      table: "entities",
      cap: 5000, // search_entities p_limit max
      note: "Single-call cap — typically narrowed by ?search= so the actual returned set is much smaller.",
      countQuery: async () => {
        const { count, error } = await supabase
          .from("entities")
          .select("id", { count: "exact", head: true });
        return { count: count ?? null, error: error?.message ?? null };
      },
    },
    {
      name: "thoughts (browse pagination)",
      table: "thoughts",
      cap: 30000, // Single-call per_page cap on /thoughts (enforced server-side).
      note: "Browse uses ?page=&per_page= with a 30000 per-call ceiling. Total row count grows indefinitely without truncation — the dashboard pages through any size. Aggregation endpoints (/stats type counts) use RPCs so they're never row-capped.",
      countQuery: async () => {
        // Report 0 so the quota banner never fires for /thoughts — total
        // thoughts is unbounded by design (paginated browse + RPC aggregations).
        return { count: 0, error: null };
      },
    },
    {
      name: "thought_entities (constellation source)",
      table: "thought_entities",
      cap: Number.POSITIVE_INFINITY, // RPC-backed — no cap
      note: "Aggregated via RPC GROUP BY in SQL. No row cap; reported for trend monitoring only.",
      countQuery: async () => {
        // thought_entities has a composite PK; count any non-null column.
        const { count, error } = await supabase
          .from("thought_entities")
          .select("thought_id", { count: "exact", head: true });
        return { count: count ?? null, error: error?.message ?? null };
      },
    },
    {
      name: "edges (max per entity)",
      table: "edges",
      cap: 5000, // Per-side cap of /entities/:id/edges
      note: "The truncation risk for /entities/:id/edges is per-entity, not total. We report the max edges connected to any single entity here so the warning fires only when a real entity is approaching the per-query cap (5000 per side).",
      countQuery: async () => {
        // Fetch from/to ids and compute the worst-case per-entity count.
        // For ~1000-edges-total brain this is fast; if the graph grows past
        // ~50k edges this should move to a Postgres RPC for efficiency.
        const { data, error } = await supabase
          .from("edges")
          .select("from_entity_id, to_entity_id");
        if (error || !data) return { count: null, error: error?.message ?? "edges fetch failed" };
        const counts = new Map<number, number>();
        for (const e of data) {
          counts.set(e.from_entity_id, (counts.get(e.from_entity_id) ?? 0) + 1);
          counts.set(e.to_entity_id, (counts.get(e.to_entity_id) ?? 0) + 1);
        }
        let maxPerEntity = 0;
        for (const v of counts.values()) if (v > maxPerEntity) maxPerEntity = v;
        return { count: maxPerEntity, error: null };
      },
    },
  ];

  const results = await Promise.all(
    checks.map(async (chk) => {
      const { count, error } = await chk.countQuery();
      const utilization =
        count !== null && Number.isFinite(chk.cap)
          ? count / chk.cap
          : null;
      return {
        name: chk.name,
        table: chk.table,
        current: count,
        cap: Number.isFinite(chk.cap) ? chk.cap : null,
        utilization,
        near_cap: utilization !== null && utilization >= 0.8,
        over_cap: utilization !== null && utilization >= 1.0,
        note: chk.note,
        error,
      };
    })
  );

  const anyNearCap = results.some((r) => r.near_cap);
  const anyOverCap = results.some((r) => r.over_cap);

  return c.json(
    { checks: results, near_cap: anyNearCap, over_cap: anyOverCap },
    200,
    corsHeaders
  );
});

// Stats — server-side aggregation via the thought_stats_summary RPC so
// the type breakdown stays correct as the brain grows past PostgREST's
// 1000-row response limit. Replaces the previous "fetch all rows +
// aggregate in JS" pattern, which silently truncated above 1000 rows.
app.get("/stats", async (c) => {
  const days = Number(c.req.query("days") ?? 30);
  const classification = c.req.query("classification");

  try {
    const { data, error } = await supabase.rpc("thought_stats_summary", {
      p_classification: classification || null,
    });
    if (error) throw error;

    const row = Array.isArray(data) ? data[0] : data;
    const total = Number(row?.total ?? 0);
    const types = (row?.types as Record<string, number>) || {};

    // top_topics from metadata.topics via brain_stats_aggregate (GROUP BY in
    // SQL — never a client-side slab aggregation). Hermes/ajo_curate OWNS
    // writing metadata.topics; this stays [] until those rows exist, then
    // populates automatically with no further Windows-side change. Best-effort:
    // a topics failure must not take down total/types. p_since_days=0 => all-
    // time, matching the all-time total/types above.
    let topTopics: unknown[] = [];
    try {
      const { data: agg } = await supabase.rpc("brain_stats_aggregate", {
        p_since_days: 0,
        p_classification: classification || null,
        p_exclude_restricted: true,
      });
      const a: any = Array.isArray(agg) ? agg[0] : agg;
      if (a && Array.isArray(a.top_topics)) topTopics = a.top_topics;
    } catch { /* leave [] — topics are a non-critical add-on to stats */ }

    return c.json({
      total_thoughts: total,
      window_days: days,
      types,
      top_topics: topTopics,
    }, 200, corsHeaders);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500, corsHeaders);
  }
});

// Thoughts
app.get("/thoughts", async (c) => {
  const page = Number(c.req.query("page") ?? 1);
  // Cap per_page so a runaway client can't pull every row in one call. The
  // dashboard's default is 20, the audit views ask for up to a few hundred,
  // export/audit scripts may want everything — 30000 covers the brain at
  // its current ~4k post-Perplexity-import size with 7x headroom.
  const perPage = Math.min(30000, Math.max(1, Number(c.req.query("per_page") ?? 20)));

  const type = c.req.query("type");
  const classification = c.req.query("classification");
  const qualityScoreMax = c.req.query("quality_score_max");
  const importanceMin = c.req.query("importance_min");
  const status = c.req.query("status");
  const reviewStatus = c.req.query("review_status");
  const sourceType = c.req.query("source_type");
  // Unswept filter (added 2026-07-14): return only thoughts NOT yet stamped
  // metadata.curated_sweep, so ob_curate_sweep fetches ~per_page rows instead of
  // the whole corpus. Its old `/thoughts?per_page=30000` full-fetch (then filter
  // client-side) drove a free-tier egress overage. Pair with per_page=8 +
  // sort=serial_id&order=asc for a source-side kill of that driver.
  const unswept = c.req.query("unswept");
  const resweepDays = Number(c.req.query("resweep_days"));
  const hasResweep = Number.isFinite(resweepDays) && resweepDays > 0;
  // Optional whitelisted sort. Default is created_at desc (unchanged), so no
  // existing caller's ordering changes unless it explicitly passes sort/order.
  // Special case sort=curated_sweep orders by the JSON sweep timestamp (for the
  // rolling re-sweep: never-swept + most-overdue first when order=asc).
  const SORTABLE = new Set(["created_at", "serial_id", "updated_at", "quality_score", "importance"]);
  const sortParam = c.req.query("sort");
  const jsonSweepSort = sortParam === "curated_sweep";
  const sortCol = sortParam && SORTABLE.has(sortParam) ? sortParam : "created_at";
  const ascending = c.req.query("order") === "asc"; // default desc (preserves prior behavior)

  let query = supabase
    .from("thoughts")
    .select(`${THOUGHT_COLS}, thought_entities(entity_id, mention_role, confidence, entities(canonical_name, entity_type))`, { count: "exact" })
    .range((page - 1) * perPage, page * perPage - 1);
  query = jsonSweepSort
    ? query.order("metadata->>curated_sweep", { ascending, nullsFirst: ascending })
    : query.order(sortCol, { ascending });


  if (type) query = query.eq("type", type);
  if (qualityScoreMax) query = query.lt("quality_score", parseInt(qualityScoreMax, 10));
  if (importanceMin) query = query.gte("importance", parseInt(importanceMin, 10));
  if (status) query = query.in("status", status.split(",").map((s: string) => s.trim()));
  if (classification) {
    query = query.filter("metadata->>classification", "eq", classification);
  }
  if (reviewStatus) {
    query = query.filter("metadata->>review_status", "eq", reviewStatus);
  }
  // Default-EXCLUDE held escalations from a pending_review pull (regression 2026-07-16:
  // ajo_curate_pending's GET /thoughts?review_status=pending_review returned OPEN
  // escalation #6102 to an autonomous curate turn, which merged its content into #29 then
  // deleted the vessel). FAIL-SAFE: any caller pulling pending items gets held escalations
  // (escalate=true + escalation_status=open) excluded UNLESS it explicitly opts in with
  // ?include_escalations=true — which the logged-in human dashboard /review proxy sets, so
  // the operator still sees + approves escalations there. Null-safe .or so live/ordinary
  // rows (escalation_status null or != 'open') always stay in.
  const includeEscalations = c.req.query("include_escalations") === "true";
  if (reviewStatus === "pending_review" && !includeEscalations) {
    query = query.or("metadata->>escalation_status.is.null,metadata->>escalation_status.neq.open");
  }
  if (sourceType) query = query.eq("source_type", sourceType);
  // Sweep selectors for ob_curate_sweep (2026-07-14). resweep_days=N returns
  // never-swept OR last-swept-more-than-N-days-ago (rolling re-sweep); plain
  // unswept=1 returns never-swept only. Both pair with a small per_page so the
  // sweeper pulls ~8 rows, never the whole corpus (the egress-overage footgun).
  const sweepSelector = hasResweep || unswept === "1" || unswept === "true";
  if (hasResweep) {
    const cutoff = new Date(Date.now() - resweepDays * 86400000).toISOString();
    query = query.or(`metadata->>curated_sweep.is.null,metadata->>curated_sweep.lt.${cutoff}`);
  } else if (unswept === "1" || unswept === "true") {
    query = query.filter("metadata->>curated_sweep", "is", null);
  }
  // For sweep selectors only, exclude review-gated rows (pending_review /
  // rejected) server-side. They're never stamped curated_sweep, so under the
  // nulls-first order they'd sit at the top of the window forever and, as real
  // thoughts age past the resweep window, eventually starve the sweep. Null-safe
  // (live/approved rows have null-or-other review_status and stay in). Does NOT
  // affect normal browse. (2026-07-14, WSL correctness request.)
  if (sweepSelector) {
    query = query.or("metadata->>review_status.is.null,metadata->>review_status.not.in.(pending_review,rejected)");
  }

  const { data, error, count } = await query;
  // Paging past the end of the (filtered) result set makes PostgREST throw
  // PGRST103 "Requested range not satisfiable". That's a normal end-of-list
  // condition for any client iterating pages until exhaustion — return an
  // empty page, not a 500. (This was the "intermittent" /thoughts 500: the
  // failing page number moved with the active filter's total.)
  if (error) {
    const rangeErr = (error as any).code === "PGRST103" || /range not satisfiable/i.test(error.message);
    if (rangeErr) return c.json({ data: [], total: 0, page, per_page: perPage, note: "page beyond end of results" });
    return c.json({ error: error.message }, 500);
  }

  return c.json({
    data: (data || []).map((t: any) => {
      const m: any = mapThought(t);
      m.entities = flattenEntities(t.thought_entities);
      delete m.thought_entities;
      return m;
    }),
    total: count ?? 0,
    page,
    per_page: perPage
  });
});

// Search — semantic with text fallback
app.get("/search", async (c) => {
  const q = c.req.query("q");
  const mode = c.req.query("mode") ?? "semantic";
  const limit = Number(c.req.query("limit") ?? 20);

  const classification = c.req.query("classification");

  if (!q) return c.json({ error: "Query required" }, 400);

  try {
    if (mode === "semantic") {
      const embedding = await getEmbedding(q);
      if (embedding) {
        const rpcParams: Record<string, unknown> = {
          query_embedding: embedding,
          match_threshold: 0.15,
          match_count: limit,

        };
        if (classification) rpcParams.filter = { classification };
        const { data, error } = await supabase.rpc("match_thoughts", rpcParams);
        if (!error) {
          return c.json({
            results: (data || []).map(mapThought),
            count: data?.length || 0,
            total: data?.length || 0,
            mode: "semantic"
          }, 200, corsHeaders);
        }
        console.error("Semantic RPC failed, falling back to text:", error.message);
        // Fall through to text search
      }
      // Fall through to text search if embedding unavailable or RPC failed
    }

    // Text search fallback
    let query = supabase.from("thoughts").select(THOUGHT_COLS).ilike("content", `%${q}%`).limit(limit);

    if (classification) query = query.filter("metadata->>classification", "eq", classification);

    const { data, error } = await query;
    if (error) throw error;
    return c.json({
      results: (data || []).map(mapThought),
      count: data?.length || 0,
      total: data?.length || 0,
      mode: "text"
    }, 200, corsHeaders);
  } catch (err) {
    const msg = err instanceof Error ? err.message
      : typeof (err as any)?.message === "string" ? (err as any).message
      : JSON.stringify(err);
    console.error("Search error:", msg);
    return c.json({ error: msg }, 500);
  }
});

// Action items — thoughts with non-empty metadata.action_items
app.get("/action-items", async (c) => {
  const classification = c.req.query("classification");
  const sinceHoursRaw = c.req.query("since_hours");
  const sinceHours = sinceHoursRaw ? Number(sinceHoursRaw) : 0;
  const limit = Number(c.req.query("limit") ?? 50);
  const withEntities = c.req.query("with_entities") === "true";

  try {
    let q = supabase
      .from("thoughts")
      .select("id, serial_id, content, type, metadata, source_type, created_at, importance")
      .not("metadata->action_items", "is", null)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (sinceHours > 0) {
      const since = new Date(Date.now() - sinceHours * 60 * 60 * 1000).toISOString();
      q = q.gte("created_at", since);
    }
    if (classification) q = q.filter("metadata->>classification", "eq", classification);

    const { data, error } = await q;
    if (error) return c.json({ error: error.message }, 500, corsHeaders);

    const withActions = (data || []).filter((t: any) =>
      Array.isArray(t.metadata?.action_items) && t.metadata.action_items.length > 0
    );

    // Optional: pull linked entity canonical_names + aliases for each thought so
    // the dashboard can aggregate by kanban-card @entity tag client-side.
    if (withEntities && withActions.length > 0) {
      const ids = withActions.map((t: any) => t.id);
      const { data: links } = await supabase
        .from("thought_entities")
        .select("thought_id, entity_id")
        .in("thought_id", ids);
      const entityIds = [...new Set((links || []).map((l: any) => l.entity_id))];
      const { data: ents } = await supabase
        .from("entities")
        .select("id, canonical_name, aliases, entity_type")
        .in("id", entityIds);
      const entById = new Map<number, any>((ents || []).map((e: any) => [e.id, e]));
      const linkedByThought = new Map<string, any[]>();
      for (const l of links || []) {
        const e = entById.get((l as any).entity_id);
        if (!e) continue;
        if (!linkedByThought.has((l as any).thought_id)) linkedByThought.set((l as any).thought_id, []);
        linkedByThought.get((l as any).thought_id)!.push({
          canonical_name: e.canonical_name,
          aliases: e.aliases || [],
          entity_type: e.entity_type,
        });
      }
      for (const t of withActions) {
        (t as any).linked_entities = linkedByThought.get((t as any).id) || [];
      }
    }

    return c.json({ thoughts: withActions, total: withActions.length, since_hours: sinceHours }, 200, corsHeaders);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500, corsHeaders);
  }
});

// Duplicates
app.get("/duplicates", async (c) => {
  const threshold = Number(c.req.query("threshold") ?? 0.85);
  const limit = Number(c.req.query("limit") ?? 50);
  const classification = c.req.query("classification");

  try {
    const { data, error } = await supabase.rpc("brain_duplicates_find", {
      p_threshold: threshold,
      p_limit: limit,
      p_classification: classification || null
    });

    if (error) {
      console.error("Duplicates RPC error:", error.message);
      return c.json({ pairs: [], threshold, limit, error: "Deduplication temporarily unavailable" }, 200, corsHeaders);
    }
    return c.json({ pairs: data || [], threshold, limit }, 200, corsHeaders);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500, corsHeaders);
  }
});

// Dismiss a duplicate pair ("not a duplicate"). Persists to duplicate_dismissals
// so brain_duplicates_find excludes it on every future run — silences the pair
// in BOTH the dashboard /duplicates view AND the MCP find_duplicates report at
// once (both call the same RPC). Idempotent; pair is order-normalized (lo<hi).
app.post("/duplicates/dismiss", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({} as Record<string, unknown>));
    const a = Number((body as any).a);
    const b = Number((body as any).b);
    if (!Number.isFinite(a) || !Number.isFinite(b) || a === b) {
      return c.json({ error: "Provide two distinct serial_ids: { a, b }" }, 400, corsHeaders);
    }
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    const { error } = await supabase
      .from("duplicate_dismissals")
      .upsert(
        {
          serial_lo: lo,
          serial_hi: hi,
          dismissed_by: (body as any).dismissed_by ?? "dashboard",
          reason: (body as any).reason ?? null,
        },
        { onConflict: "serial_lo,serial_hi", ignoreDuplicates: true },
      );
    if (error) return c.json({ error: error.message }, 500, corsHeaders);
    return c.json({ dismissed: true, serial_lo: lo, serial_hi: hi }, 200, corsHeaders);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500, corsHeaders);
  }
});

// Un-dismiss (restore) a previously-dismissed pair — makes it eligible to
// resurface again. Order-normalized to match the stored (lo, hi) key.
app.delete("/duplicates/dismiss", async (c) => {
  try {
    const a = Number(c.req.query("a"));
    const b = Number(c.req.query("b"));
    if (!Number.isFinite(a) || !Number.isFinite(b) || a === b) {
      return c.json({ error: "Provide two distinct serial_ids: ?a=&b=" }, 400, corsHeaders);
    }
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    const { error } = await supabase
      .from("duplicate_dismissals")
      .delete()
      .match({ serial_lo: lo, serial_hi: hi });
    if (error) return c.json({ error: error.message }, 500, corsHeaders);
    return c.json({ restored: true, serial_lo: lo, serial_hi: hi }, 200, corsHeaders);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500, corsHeaders);
  }
});

// List dismissed pairs (visibility + un-dismiss UI). Newest first.
app.get("/duplicates/dismissed", async (c) => {
  const { data, error } = await supabase
    .from("duplicate_dismissals")
    .select("serial_lo, serial_hi, dismissed_at, dismissed_by, reason")
    .order("dismissed_at", { ascending: false });
  if (error) return c.json({ error: error.message }, 500, corsHeaders);
  return c.json({ dismissed: data ?? [] }, 200, corsHeaders);
});

// Single thought
app.get("/thought/:id", async (c) => {
  const id = c.req.param("id");
  const { data, error } = await supabase
    .from("thoughts")
    .select(`${THOUGHT_COLS}, thought_entities(entity_id, mention_role, confidence, entities(canonical_name, entity_type))`)
    .match(getIdentityFilter(id))
    .maybeSingle();
  if (error) return c.json({ error: error.message }, 500);
  if (!data) return c.json({ error: "not found", id }, 404);
  const m: any = mapThought(data);
  if (m) {
    m.entities = flattenEntities((data as any)?.thought_entities);
    delete m.thought_entities;
  }
  return c.json(m);
});

// Entities linked to a thought — compact list so an agent/curator can check a
// thought's graph bindings (e.g. The Hermes agent's "has >=1 linked entity" auto-approve
// rule) without a second round-trip. Returns [] for an unknown id.
app.get("/thought/:id/entities", async (c) => {
  const uuid = await resolveThoughtUuid(c.req.param("id"));
  if (!uuid) return c.json({ entities: [] }, 200, corsHeaders);
  const { data, error } = await supabase
    .from("thought_entities")
    .select("entity_id, mention_role, confidence, entities(canonical_name, entity_type)")
    .eq("thought_id", uuid);
  if (error) return c.json({ error: error.message }, 500, corsHeaders);
  return c.json({ entities: flattenEntities(data) }, 200, corsHeaders);
});

// Agent-write quality signal (added 2026-07-11) — the OB-side downstream-quality
// feed for the fleet's realtime model-perf scoring. For agent-authored thoughts
// (the Hermes agent's ajo_capture writes) it reports whether the operator later CORRECTED the write
// (edited), how many extracted entities SURVIVED curation, whether the write was
// DELETED as noise, and (v2) the human REVIEW OUTCOME (approved_new / dropped /
// pending / … — see deriveReviewOutcome; the cleaner signal for review-gated
// captures). Keyed by serial_id: OB deliberately does NOT know which MODEL wrote
// a thought — attribution is the caller's join. The caller (Hermes) already holds
// {thought_id -> resolved_model} from capture time, joins this by serial_id,
// derives a 0..1 quality_score, and POSTs it to feeder's /api/model-perf/sample.
// READ-ONLY, zero-token.
//
//   GET /agent-write-quality?ids=101,102,103   (PRIMARY: quality for specific writes;
//                                                a requested id now missing = deleted)
//   GET /agent-write-quality?since=<ISO>[&source=plaud][&limit=500]
//                                               (SCAN: surviving agent thoughts since ts;
//                                                cannot report deletions — gone rows leave
//                                                no row + there is no deletion tombstone)
app.get("/agent-write-quality", async (c) => {
  const idsParam = c.req.query("ids");
  const since = c.req.query("since");
  const limit = Math.min(2000, Math.max(1, Number(c.req.query("limit") ?? 500)));
  const SELECT = "serial_id, version, source_type, created_at, updated_at, metadata, thought_entities(count)";

  // v2 (2026-07-11): the review OUTCOME is a cleaner quality signal than raw
  // edit/delete for review-gated captures. Derived purely from a SURVIVING row's
  // metadata:
  //   live               — no review gate (captured straight in via /capture)
  //   pending            — awaiting normal review
  //   pending_escalation — flagged escalate=true, awaiting the operator's escalation call
  //   approved_new       — approved into the brain (survivors of approval are NEW;
  //                        approved-UPDATE vessels are DELETED, so not observable here —
  //                        the caller joins those on update_target_id)
  //   resolved_answered  — escalation answered without capture (neutral)
  //   dropped            — rejected/dropped by the human (bad write)
  // NOTE: ollama_decision is stripped on approval, so NEW-vs-UPDATE is inferred by
  // survival, not by that field. A deleted vessel can't carry an outcome (row gone) —
  // it's marked "deleted_or_merged" and the caller disambiguates via its capture log.
  const deriveReviewOutcome = (meta: Record<string, unknown>): string => {
    const rs = String(meta?.review_status ?? "");
    const es = String(meta?.escalation_status ?? "");
    const escalate = meta?.escalate === true || meta?.escalate === "true";
    if (!rs) return "live";
    if (rs === "pending_review") return escalate && es === "open" ? "pending_escalation" : "pending";
    if (rs === "approved") return "approved_new";
    if (rs === "rejected") return es === "resolved" ? "resolved_answered" : "dropped";
    return "unknown";
  };

  const mapRow = (t: any) => {
    const version = Number(t.version ?? 1);
    // PostgREST count-embed returns thought_entities as [{count: N}] (or [] for none).
    const entitiesKept = Array.isArray(t.thought_entities) ? Number(t.thought_entities[0]?.count ?? 0) : 0;
    const meta = (t.metadata ?? {}) as Record<string, unknown>;
    return {
      serial_id: t.serial_id,
      exists: true,
      was_deleted: false,
      was_edited: version > 1,   // v1 = untouched since the agent wrote it; v>1 = corrected/merged
      version,
      entities_kept: entitiesKept,
      review_outcome: deriveReviewOutcome(meta),            // v2 — cleaner signal for gated captures
      review_status: meta.review_status ?? null,            // raw, so the caller can map its own way
      escalation_status: meta.escalation_status ?? null,
      source_type: t.source_type ?? null,
      created_at: t.created_at,
      updated_at: t.updated_at,
      resolved_at: t.updated_at,
    };
  };

  if (idsParam) {
    const ids = idsParam.split(",").map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isFinite(n));
    if (ids.length === 0) return c.json({ error: "ids must be a comma-separated list of serial_ids" }, 400, corsHeaders);
    if (ids.length > 2000) return c.json({ error: "max 2000 ids per request" }, 400, corsHeaders);
    const { data, error } = await supabase.from("thoughts").select(SELECT).in("serial_id", ids);
    if (error) return c.json({ error: error.message }, 500, corsHeaders);
    const rows = (data ?? []).map(mapRow);
    const foundIds = new Set(rows.map((r) => r.serial_id));
    const deleted = ids.filter((id) => !foundIds.has(id));
    // One row per requested id — a not-found id the caller created = deleted-as-noise.
    for (const id of deleted) {
      rows.push({
        serial_id: id, exists: false, was_deleted: true, was_edited: false,
        version: 0, entities_kept: 0,
        review_outcome: "deleted_or_merged",  // gone row: real-delete OR approved-UPDATE merge — caller disambiguates via its capture log
        review_status: null, escalation_status: null, source_type: null,
        created_at: null, updated_at: null, resolved_at: null,
      });
    }
    return c.json({ mode: "ids", requested: ids.length, found: foundIds.size, deleted, results: rows }, 200, corsHeaders);
  }

  if (since) {
    let q = supabase.from("thoughts").select(SELECT).gte("created_at", since)
      .order("created_at", { ascending: true }).limit(limit);
    const source = c.req.query("source");
    if (source) q = q.eq("source_type", source);
    const { data, error } = await q;
    if (error) return c.json({ error: error.message }, 500, corsHeaders);
    const rows = (data ?? []).map(mapRow);
    return c.json({
      mode: "since", since, source: source ?? null, limit, count: rows.length,
      note: "surviving rows only — deletions are not reportable in since-mode; use ?ids= for was_deleted",
      results: rows,
    }, 200, corsHeaders);
  }

  return c.json({ error: "provide ?ids=<serial_ids> (primary) or ?since=<ISO timestamp>" }, 400, corsHeaders);
});

// Version history for a thought — the archived snapshots (newest first). Powers
// the rollback UX and lets an agent confirm reversibility before an UPDATE.
app.get("/thought/:id/versions", async (c) => {
  const uuid = await resolveThoughtUuid(c.req.param("id"));
  if (!uuid) return c.json({ versions: [] }, 200, corsHeaders);
  const { data, error } = await supabase
    .from("thought_versions")
    .select("id, version, content, metadata, archived_at, created_at")
    .eq("thought_id", uuid)
    .order("archived_at", { ascending: false, nullsFirst: false })
    .limit(50);
  if (error) return c.json({ error: error.message }, 500, corsHeaders);
  return c.json({ versions: data ?? [] }, 200, corsHeaders);
});

// Revert a thought's content to a prior archived version — the undo for a bad
// UPDATE merge. Body: { version?: N } to target a specific snapshot; default is
// the most recently archived one. Snapshots the CURRENT content first, so the
// revert is itself reversible, then re-queues extraction + re-embeds.
app.post("/thought/:id/revert", async (c) => {
  const uuid = await resolveThoughtUuid(c.req.param("id"));
  if (!uuid) return c.json({ error: "thought not found" }, 404, corsHeaders);
  const { data: cur } = await supabase
    .from("thoughts").select("id, serial_id, content, metadata, version").eq("id", uuid).maybeSingle();
  if (!cur) return c.json({ error: "thought not found" }, 404, corsHeaders);

  const body = await c.req.json().catch(() => ({}));
  let q = supabase.from("thought_versions").select("id, version, content").eq("thought_id", uuid);
  q = (body && Number.isFinite(Number(body.version)))
    ? q.eq("version", Number(body.version)).limit(1)
    : q.order("archived_at", { ascending: false, nullsFirst: false }).limit(1);
  const { data: snap } = await q.maybeSingle();
  if (!snap) return c.json({ error: "no archived version to revert to" }, 404, corsHeaders);

  // Snapshot current (post-merge) content first so revert is itself reversible.
  await supabase.from("thought_versions").insert({
    thought_id: uuid, version: cur.version ?? 1, content: cur.content,
    metadata: cur.metadata ?? {}, archived_at: new Date().toISOString(),
  });

  const newVersion = (cur.version ?? 1) + 1;
  const { error: updErr } = await supabase
    .from("thoughts")
    .update({ content: snap.content, updated_at: new Date().toISOString(), version: newVersion })
    .eq("id", uuid);
  if (updErr) return c.json({ error: updErr.message }, 500, corsHeaders);

  await supabase.from("entity_extraction_queue").upsert(
    { thought_id: uuid, status: "pending", attempt_count: 0, last_error: null, queued_at: new Date().toISOString() },
    { onConflict: "thought_id" },
  );
  getEmbedding(snap.content).then((emb) => { if (emb) supabase.from("thoughts").update({ embedding: emb }).eq("id", uuid); });

  return c.json({ reverted: true, id: cur.serial_id, restored_from_version: snap.version, new_version: newVersion }, 200, corsHeaders);
});

// Update thought
app.put("/thought/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json();
  const filter = getIdentityFilter(id);
  // Guard: a missing thought must 404, not 500. Without this, the final
  // .update(...).select().single() below matches 0 rows and PostgREST throws
  // "cannot coerce the result to a single JSON object" -> a confusing 500
  // (hit by WSL 2026-07-11 PUT-ing a since-deleted id). Mirrors DELETE /thought.
  const { data: existsRow } = await supabase.from("thoughts").select("id").match(filter).maybeSingle();
  if (!existsRow) return c.json({ error: "thought not found", id }, 404, corsHeaders);
  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (body.status !== undefined) {
    updates.status = body.status;
    updates.status_updated_at = new Date().toISOString();
  }
  if (body.type !== undefined) updates.type = body.type;
  if (body.importance !== undefined) updates.importance = body.importance;
  // quality_score was missing from the update whitelist, so the Hermes agent's (ob_drain)
  // computed scores were silently dropped on write — every thought stayed at the
  // capture default (50) after the local gemma-worker retirement. Persist it,
  // clamped to 1..100. (2026-07-13)
  if (body.quality_score !== undefined) {
    const q = Number(body.quality_score);
    if (!Number.isNaN(q)) updates.quality_score = Math.max(1, Math.min(100, Math.round(q)));
  }

  // Content edits need to flow through the same downstream pipeline as a fresh
  // capture: recompute the fingerprint, re-embed, archive the old version into
  // thought_versions, and force-requeue entity extraction. The DB trigger only
  // requeues when content_fingerprint changes — without an explicit recompute
  // here, the worker would skip the edited thought.
  let triggerRequeue = false;
  let updatedThoughtId: string | null = null;
  if (body.content !== undefined && typeof body.content === "string") {
    const newContent = body.content;
    updates.content = newContent;

    // Pull the current row so we can archive + know the old fingerprint
    const { data: existing } = await supabase
      .from("thoughts")
      .select("id, content, content_fingerprint, metadata, version")
      .match(filter)
      .single();

    if (existing) {
      updatedThoughtId = existing.id;
      const newFp = await fingerprint(newContent);
      if (newFp !== existing.content_fingerprint) {
        updates.content_fingerprint = newFp;
        triggerRequeue = true;
      }
      updates.version = (existing.version || 1) + 1;

      // Archive previous version (best-effort — table may not exist)
      try {
        await supabase.from("thought_versions").insert({
          thought_id: existing.id,
          version: existing.version || 1,
          content: existing.content,
          metadata: existing.metadata,
          archived_at: new Date().toISOString(),
        });
      } catch {
        // ignore — best-effort archival
      }
    }
  }

  if (body.classification) {
    updates.classification = body.classification;
    body.metadata = { ...(body.metadata || {}), classification: body.classification };
  }
  if (body.metadata) {
    const { data: existingMeta } = await supabase
      .from("thoughts")
      .select("metadata")
      .match(filter)
      .single();
    updates.metadata = {
      ...((existingMeta?.metadata as Record<string, unknown>) || {}),
      ...body.metadata,
    };
  }

  const { data, error } = await supabase
    .from("thoughts")
    .update(updates)
    .match(filter)
    .select()
    .single();
  if (error) return c.json({ error: error.message }, 500);

  // Force-requeue extraction so the worker re-runs entity extraction + edge
  // graph + wiki regen on the edited content. Belt-and-braces: the trigger
  // SHOULD have done this when content_fingerprint changed, but the upsert
  // here also covers the case where the trigger's WHERE guard considered the
  // change a no-op (rare but possible after manual DB tinkering).
  if (triggerRequeue && updatedThoughtId) {
    await supabase.from("entity_extraction_queue").upsert({
      thought_id: updatedThoughtId,
      status: "pending",
      attempt_count: 0,
      last_error: null,
      queued_at: new Date().toISOString(),
      source_fingerprint: updates.content_fingerprint as string,
      source_updated_at: updates.updated_at as string,
    }, { onConflict: "thought_id" });

    // Re-embed in the background — don't block the PUT response
    getEmbedding(body.content as string)
      .then((emb) => {
        if (emb) {
          return supabase.from("thoughts").update({ embedding: emb }).match(filter);
        }
      })
      .catch(() => {});
  }

  return c.json({
    id: data.serial_id,
    action: "updated",
    requeued: triggerRequeue,
    message: "Saved",
  });
});

// Delete thought
// Snapshot-first: the full deleted row (and its entity links) comes back in
// the response so the caller's receipt/audit trail carries everything needed
// to reverse the delete. FK cascades clean thought_entities / reflections /
// thought_entity_edges (whose trigger shrinks edge support counts).
app.delete("/thought/:id", async (c) => {
  const id = c.req.param("id");
  const filter = getIdentityFilter(id);
  const { data: row } = await supabase.from("thoughts").select("*").match(filter).maybeSingle();
  if (!row) return c.json({ error: "thought not found" }, 404, corsHeaders);

  // Escalation guard on the DELETE path (added 2026-07-16 after an AUTONOMOUS curate cron
  // deleted held-open escalation #6102 via this route — bypassing the /review/approve
  // human_authorized guard, which only covered approve. Same regression class the escalation
  // guard exists for, through a second door). A HELD escalation (escalate=true +
  // escalation_status=open) is waiting for the operator; it MUST NOT be deletable by an
  // autonomous turn. Same HUMAN-DIRECTED vs AUTONOMOUS line as /review/approve: require
  // human_authorized (accepted from a JSON body OR ?human_authorized=true). Fail-CLOSED.
  const dmeta = (row.metadata ?? {}) as Record<string, unknown>;
  const isHeldEscalation =
    (dmeta.escalate === true || dmeta.escalate === "true") &&
    String(dmeta.escalation_status ?? "") === "open";
  if (isHeldEscalation) {
    const dbody = await c.req.json().catch(() => ({} as Record<string, unknown>));
    const humanAuthorized =
      dbody?.human_authorized === true || dbody?.human_authorized === "true" ||
      c.req.query("human_authorized") === "true";
    if (!humanAuthorized) {
      return c.json({
        action: "refused",
        error: "open escalation not deletable without human authorization",
        message: "this thought is a HELD escalation (escalation_status=open) awaiting the operator's review; an autonomous turn must not delete it. Pass human_authorized:true from a human-directed action (or resolve it via the escalation walk) to delete.",
        escalation_status: "open",
      }, 409, corsHeaders);
    }
  }

  const { data: links } = await supabase
    .from("thought_entities").select("entity_id, mention_role, confidence").eq("thought_id", row.id);
  const { error } = await supabase.from("thoughts").delete().eq("id", row.id);
  if (error) return c.json({ error: error.message }, 500, corsHeaders);
  return c.json({ status: "deleted", snapshot: row, linked_entities: links ?? [] }, 200, corsHeaders);
});

// Resolve a `/thought/:id/reflection` path param (UUID or serial_id string)
// to the thought's canonical UUID, which is what reflections.thought_id FKs to.
async function resolveThoughtUuid(idParam: string): Promise<string | null> {
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idParam);
  if (isUuid) return idParam;
  const serial = parseInt(idParam, 10);
  if (Number.isNaN(serial)) return null;
  const { data } = await supabase.from("thoughts").select("id").eq("serial_id", serial).maybeSingle();
  return data?.id ?? null;
}

// Reflections — GET
app.get("/thought/:id/reflection", async (c) => {
  const uuid = await resolveThoughtUuid(c.req.param("id"));
  if (!uuid) return c.json({ reflections: [] });
  const { data, error } = await supabase
    .from("reflections")
    .select("*")
    .eq("thought_id", uuid)
    .order("created_at", { ascending: false });
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ reflections: data || [] });
});

// Reflections — POST
app.post("/thought/:id/reflection", async (c) => {
  const uuid = await resolveThoughtUuid(c.req.param("id"));
  if (!uuid) return c.json({ error: "thought not found" }, 404);
  const body = await c.req.json();
  // Accept both `reflection_type` (canonical, used by the dashboard composer)
  // and legacy `type` (older callers) — preferring the canonical name.
  const reflection_type = body.reflection_type ?? body.type ?? "general";
  const { data, error } = await supabase.from("reflections").insert({
    thought_id: uuid,
    reflection_type,
    trigger_context: body.trigger_context ?? "",
    conclusion: body.conclusion ?? "",
    options: Array.isArray(body.options) ? body.options : [],
    factors: Array.isArray(body.factors) ? body.factors : [],
    confidence: typeof body.confidence === "number" ? body.confidence : 1.0,
    metadata: body.metadata ?? {},
  }).select().single();
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ reflection: data }, 201, corsHeaders);
});

// Capture — quick single-thought ingest with dedup
app.post("/capture", async (c) => {
  const { content, source_type } = await c.req.json();
  if (!content?.trim()) return c.json({ error: "content is required" }, 400);

  const trimmed = content.trim();
  const fp = await fingerprint(trimmed);

  const { data: existing } = await supabase
    .from("thoughts")
    .select("serial_id, type")
    .eq("metadata->>content_fingerprint", fp)
    .maybeSingle();

  if (existing) {
    return c.json({
      thought_id: existing.serial_id,
      action: "duplicate",
      type: existing.type,
      content_fingerprint: fp,
      message: "Already in brain",
    }, 200, corsHeaders);
  }

  const { data: inserted, error } = await supabase
    .from("thoughts")
    .insert({
      content: trimmed,
      type: "observation",
      status: null,
      importance: 3,
      quality_score: 50,
      classification: "personal",
      source_type: source_type || "manual",
      content_fingerprint: fp,
      metadata: { content_fingerprint: fp },
    })
    .select("id, serial_id, type")
    .single();

  if (error) return c.json({ error: error.message }, 500);

  await supabase.from("entity_extraction_queue")
    .upsert({ thought_id: inserted.id }, { onConflict: "thought_id", ignoreDuplicates: true });

  getEmbedding(trimmed).then(emb => {
    if (emb) supabase.from("thoughts").update({ embedding: emb }).eq("id", inserted.id);
  });

  return c.json({
    thought_id: inserted.serial_id,
    action: "created",
    type: inserted.type,
    content_fingerprint: fp,
    message: "Thought captured",
  }, 201, corsHeaders);
});

// Capture-pending — ingest from Plaud without queueing for processing (waits for review)
app.post("/capture-pending", async (c) => {
  const { content, source_type, ollama_decision, update_target_id, original_content, type, classification, action_items, meeting_id, meeting_title, meeting_position, meeting_total, escalate, open_question, escalate_reason } = await c.req.json();
  if (!content?.trim()) return c.json({ error: "content is required" }, 400);

  const trimmed = content.trim();
  const fp = await fingerprint(trimmed);

  const { data: existing } = await supabase
    .from("thoughts")
    .select("serial_id, type")
    .eq("metadata->>content_fingerprint", fp)
    .maybeSingle();

  if (existing) {
    return c.json({
      thought_id: existing.serial_id,
      action: "duplicate",
      message: "Already in brain",
    }, 200, corsHeaders);
  }

  const meta: Record<string, unknown> = {
    content_fingerprint: fp,
    review_status: "pending_review",
  };
  if (ollama_decision) meta.ollama_decision = ollama_decision;
  if (update_target_id != null) meta.update_target_id = update_target_id;
  if (original_content) meta.original_content = original_content;
  if (Array.isArray(action_items) && action_items.length > 0) {
    meta.action_items = action_items.filter((a: unknown) => typeof a === "string" && a.trim().length > 0);
  }
  // Meeting-cluster context (Plaud recording-id grouping for /review).
  if (meeting_id) meta.meeting_id = String(meeting_id);
  if (meeting_title) meta.meeting_title = String(meeting_title);
  if (Number.isFinite(meeting_position)) meta.meeting_position = Number(meeting_position);
  if (Number.isFinite(meeting_total)) meta.meeting_total = Number(meeting_total);
  // Escalation flag: when the curator (the Hermes agent) is genuinely unsure and wants a
  // human, mark the pending vessel so GET /escalations can surface ONLY these
  // (vs ordinary held rows). escalation_status drives the resolve lifecycle:
  // open -> (resolved | dropped) via PATCH /thought/:id/escalation.
  if (escalate === true || escalate === "true") {
    meta.escalate = true;
    meta.escalation_status = "open";
    if (open_question) meta.open_question = String(open_question);
    if (escalate_reason) meta.escalate_reason = String(escalate_reason);
  }

  const VALID_TYPES = ["task","idea","observation","reference","person_note","decision","lesson","meeting","journal","newsletter"];
  const resolvedType = (typeof type === "string" && VALID_TYPES.includes(type)) ? type : "observation";
  // Newsletter captures default to personal (professional reading, not work) —
  // anything else falls back to work unless the caller said otherwise.
  const classificationDefault = resolvedType === "newsletter" ? "personal" : "work";
  const resolvedClassification = (classification === "work" || classification === "personal") ? classification : classificationDefault;

  if (resolvedClassification) meta.classification = resolvedClassification;

  const { data: inserted, error } = await supabase
    .from("thoughts")
    .insert({
      content: trimmed,
      type: resolvedType,
      status: null,
      importance: 3,
      quality_score: 50,
      classification: resolvedClassification,
      source_type: source_type || "plaud",
      content_fingerprint: fp,
      metadata: meta,
    })
    .select("id, serial_id, type")
    .single();

  if (error) return c.json({ error: error.message }, 500);

  return c.json({
    thought_id: inserted.serial_id,
    action: "pending",
    message: "Thought queued for review",
  }, 201, corsHeaders);
});

// Review — approve a batch of pending thoughts
// For UPDATE decisions: applies merged content to the target thought + deletes pending
// For NEW decisions: queues the thought for entity extraction + clears review_status
app.post("/review/approve", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const ids = body?.ids;
  // Human-authorization gate for escalations (added 2026-07-10 after a reactive
  // review turn on the gemma fallback auto-approved 6 human-flagged escalations
  // via ajo_approve_pending — merging + deleting the vessels before the operator could
  // review them). An escalation means "the curator is unsure and explicitly
  // wants a human"; it must NOT be resolvable by an AUTONOMOUS turn.
  //
  // The real line is HUMAN-DIRECTED vs AUTONOMOUS, NOT which surface called.
  // `human_authorized` is set by callers acting on a live human instruction:
  //   • the dashboard /review proxy — gated behind a logged-in session (requireSession);
  //   • the Hermes agent's ajo_approve_pending on an INTERACTIVE DM turn (the operator present, says "approve #N").
  // It is NEVER set by autonomous turns (cron / --force / reactive-review drains),
  // so those get action:"refused" and the vessel stays intact for the human walk.
  // Do NOT narrow this to "dashboard only" — that would wrongly refuse the operator's
  // intended the Hermes agent-in-DM escalation walk, which uses the same tool/endpoint.
  const humanAuthorized = body?.human_authorized === true || body?.human_authorized === "true";
  // Stale-UPDATE guard override (added 2026-07-23): force-apply an UPDATE whose
  // original_content snapshot no longer matches the target's current content
  // (clobbers the intervening change; prior version is archived). Distinct from
  // human_authorized ON PURPOSE — the dashboard /review walk always sets
  // human_authorized, so reusing it would make the stale-guard a no-op from the UI.
  // The caller must send force_stale_apply:true EXPLICITLY (i.e. Adam clicked
  // "apply anyway" after seeing the staleness), otherwise a stale UPDATE is refused.
  const forceStaleApply = body?.force_stale_apply === true || body?.force_stale_apply === "true";
  const normContent = (s: unknown) => (typeof s === "string" ? s : "").replace(/\s+/g, " ").trim();
  if (!Array.isArray(ids) || ids.length === 0) {
    return c.json({ error: "ids array is required" }, 400);
  }

  const results: Array<Record<string, unknown>> = [];

  for (const serialId of ids) {
    const { data: thought, error: fetchErr } = await supabase
      .from("thoughts")
      .select("*")
      .eq("serial_id", serialId)
      .maybeSingle();

    if (fetchErr || !thought) {
      results.push({ id: serialId, action: "error", message: "Not found" });
      continue;
    }

    const meta = (thought.metadata ?? {}) as Record<string, unknown>;

    // Escalation guard: an unresolved escalation (escalate=true + escalation_status=open)
    // is only approvable with explicit human authorization. Without it (i.e. an automated
    // drainer like ob-curate-sweep), refuse this item and leave the vessel intact for the
    // human review walk — never merge+delete it silently.
    const isOpenEscalation =
      (meta.escalate === true || meta.escalate === "true") &&
      String(meta.escalation_status ?? "") === "open";
    if (isOpenEscalation && !humanAuthorized) {
      results.push({
        id: serialId,
        action: "refused",
        message: "open escalation requires explicit human authorization — pass human_authorized:true from a human-DIRECTED approval (the dashboard /review walk, OR the operator's explicit approval in the interactive DM). Not auto-approvable by an autonomous turn.",
      });
      continue;
    }

    const decision = meta.ollama_decision as string | undefined;
    const targetSerialId = meta.update_target_id as number | undefined;

    if (decision === "UPDATE" && targetSerialId) {
      // Snapshot the target's CURRENT content into thought_versions BEFORE we
      // overwrite it, so the merge is reversible via POST /thought/:id/revert.
      // (thought_versions has existed since April; real cols include archived_at,
      // which is the meaningful timestamp — created_at is unused/null.)
      const { data: targetBefore } = await supabase
        .from("thoughts")
        .select("id, content, version, metadata")
        .eq("serial_id", targetSerialId)
        .maybeSingle();

      if (!targetBefore) {
        results.push({ id: serialId, action: "error", message: `UPDATE target #${targetSerialId} not found` });
        continue;
      }

      // STALE-UPDATE GUARD (added 2026-07-23). The vessel body was merged by the
      // analysis LLM against a snapshot of the target (metadata.original_content) at
      // propose-time. If the target's CURRENT content has diverged from that snapshot,
      // applying this OVERWRITE would clobber whatever changed the target since — e.g.
      // the two-pending-UPDATEs-to-one-target collision (#426: #6229 & #6230), where
      // approving the first makes the second's merge stale and its apply silently loses
      // the first's additions. Refuse instead of clobber; the caller re-merges (or forces).
      //   • EMPTY / absent snapshot  -> UNGUARDED, allow (legacy vessels + callers that
      //     don't yet emit original_content; nothing to compare against). This is why the
      //     existing #6229/#6230 vessels + a hand-combined #426 approval are NOT blocked.
      //   • PRESENT + matches current -> safe, proceed.
      //   • PRESENT + DIVERGED        -> refuse (action:"stale") unless force_stale_apply.
      const snapshot = meta.original_content;
      const haveSnapshot = typeof snapshot === "string" && snapshot.trim().length > 0;
      if (haveSnapshot && normContent(snapshot) !== normContent(targetBefore.content) && !forceStaleApply) {
        results.push({
          id: serialId,
          action: "stale",
          target_id: targetSerialId,
          message: `UPDATE is STALE: target #${targetSerialId} has changed since this merge was computed (its content no longer matches the vessel's original_content snapshot). Applying now would clobber the intervening change. Re-merge this vessel against the target's CURRENT content, or pass force_stale_apply:true to overwrite anyway (the prior version is archived to thought_versions and is revertible).`,
        });
        continue;
      }

      const prevVersion = targetBefore.version ?? 1;
      await supabase.from("thought_versions").insert({
        thought_id: targetBefore.id,
        version: prevVersion,
        content: targetBefore.content,
        metadata: targetBefore.metadata ?? {},
        archived_at: new Date().toISOString(),
      });

      // Apply merged content to the original thought (bump version), re-queue, delete pending
      const { error: updateErr } = await supabase
        .from("thoughts")
        .update({ content: thought.content, updated_at: new Date().toISOString(), version: prevVersion + 1 })
        .eq("serial_id", targetSerialId);

      if (updateErr) {
        results.push({ id: serialId, action: "error", message: updateErr.message });
        continue;
      }

      await supabase.from("entity_extraction_queue")
        .upsert(
          { thought_id: targetBefore.id, status: "pending", attempt_count: 0, last_error: null, queued_at: new Date().toISOString() },
          { onConflict: "thought_id", ignoreDuplicates: false },
        );
      getEmbedding(thought.content).then(emb => {
        if (emb) supabase.from("thoughts").update({ embedding: emb }).eq("serial_id", targetSerialId);
      });

      await supabase.from("thoughts").delete().eq("serial_id", serialId);
      results.push({ id: serialId, action: "update_applied", target_id: targetSerialId, archived_prior_version: prevVersion });

    } else {
      // Mark approved + queue for entity extraction + trigger embedding.
      // Atomic server-side merge (not read-modify-write of the whole object) so
      // a concurrent metadata writer can't be lost-updated — the #5676 race.
      await supabase.rpc("merge_thought_metadata", {
        p_thought_id: thought.id,
        p_patch: { review_status: "approved" },
        p_remove_keys: ["ollama_decision", "update_target_id", "original_content"],
      });

      await supabase.from("entity_extraction_queue")
        // FORCE-reset to pending (not ignoreDuplicates): under the drain's
        // review-gate guard, a pending_review thought's queue row is completed
        // WITHOUT extraction — approval must revive it or the thought never
        // extracts (found 2026-07-03, the #5799 ordering-gap patch review).
        .upsert(
          { thought_id: thought.id, status: "pending", attempt_count: 0, last_error: null, queued_at: new Date().toISOString() },
          { onConflict: "thought_id", ignoreDuplicates: false },
        );

      getEmbedding(thought.content).then(emb => {
        if (emb) supabase.from("thoughts").update({ embedding: emb }).eq("id", thought.id);
      });

      results.push({ id: serialId, action: "approved" });
    }
  }

  return c.json({ results }, 200, corsHeaders);
});

// GENUINE escalations only — pending_review vessels the curator flagged with
// escalate=true + escalation_status=open. This is what the Hermes agent's one-by-one walk
// reads (NOT every pending row): each carries the question + full context so the
// walk can present it by #. Ordinary held rows (capacity timeouts, plain
// captures) are NOT escalations and don't appear here.
app.get("/escalations", async (c) => {
  const { data, error } = await supabase
    .from("thoughts")
    .select("id, serial_id, content, source_type, created_at, metadata")
    .filter("metadata->>review_status", "eq", "pending_review")
    .filter("metadata->>escalate", "eq", "true")
    .filter("metadata->>escalation_status", "eq", "open")
    .order("created_at", { ascending: true });
  if (error) return c.json({ error: error.message }, 500, corsHeaders);
  const escalations = (data ?? []).map((t: any) => {
    const m = t.metadata ?? {};
    return {
      id: t.serial_id,
      open_question: m.open_question ?? null,
      escalate_reason: m.escalate_reason ?? null,
      decision: m.ollama_decision ?? null,       // NEW | UPDATE
      target_id: m.update_target_id ?? null,     // for UPDATE: the thought it would merge into
      target_current: m.original_content ?? null, // snapshot of the target at propose-time
      proposed_content: t.content,               // what the curator wants to write/merge
      meeting_title: m.meeting_title ?? null,
      created_at: t.created_at,
    };
  });
  return c.json({ escalations, count: escalations.length }, 200, corsHeaders);
});

// Resolve an escalation without necessarily capturing. Three the operator-answers:
//  (1) APPROVE as-is -> use POST /review/approve (writes/applies the vessel).
//  (2) ANSWER the question, no capture -> PATCH { status:"resolved", answer } —
//      records the answer, removes the proposal from the queue (no thought written).
//  (3) REJECT/DROP -> PATCH { status:"dropped" } — removes the proposal.
// Soft only: the vessel is marked review_status=rejected (off both the
// escalations list AND the /review queue) but NOT hard-deleted — deletions of
// stored rows remain a human-gated step by policy.
app.patch("/thought/:id/escalation", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  const status = String(body.status ?? "").toLowerCase();
  if (status !== "resolved" && status !== "dropped") {
    return c.json({ error: "status must be 'resolved' or 'dropped'" }, 400, corsHeaders);
  }
  const { data: t } = await supabase
    .from("thoughts").select("id, serial_id, metadata").match(getIdentityFilter(id)).maybeSingle();
  if (!t) return c.json({ error: "not found", id }, 404, corsHeaders);

  // Atomic server-side merge — no read-modify-write race with other writers.
  const patch: Record<string, unknown> = {
    escalation_status: status,
    escalation_resolved_at: new Date().toISOString(),
    // Answered-without-capture AND dropped both remove the proposal from the queue.
    review_status: "rejected",
  };
  if (body.answer) patch.escalation_answer = String(body.answer);
  const { error } = await supabase.rpc("merge_thought_metadata", { p_thought_id: t.id, p_patch: patch });
  if (error) return c.json({ error: error.message }, 500, corsHeaders);
  return c.json({
    ok: true,
    id: t.serial_id,
    escalation_status: status,
    answer: patch.escalation_answer ?? null,
    note: "vessel marked review_status=rejected (soft; not hard-deleted — deletions stay human-gated)",
  }, 200, corsHeaders);
});

// ── Classification-decision review (added 2026-07-11) ───────────────────────
// A LIGHTWEIGHT "needs your call: work or personal?" queue, distinct from the
// escalation queue. The operator's design (option ii): when ob_drain's classifier is
// genuinely UNSURE whether a thought is work or personal, it flags the thought
// for a human decision WITHOUT un-living it — the thought stays live with a
// best-guess classification and simply surfaces in this view. Deliberately does
// NOT touch review_status (that would pull a good thought out of the brain over
// a tag question — the rejected option i). Flat metadata flags mirror the
// escalation style: classification_review = "open" | "resolved".
//
// Raise: flag an EXISTING live thought for a work/personal decision, applying an
// optional best-guess now so it stays usable. This is the create-path ob_drain
// calls on a low-confidence classification.
app.post("/thought/:id/classification-review", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  const guess = (body.guess === "work" || body.guess === "personal") ? body.guess : null;
  if (body.guess != null && !guess) {
    return c.json({ error: "guess must be 'work' or 'personal'" }, 400, corsHeaders);
  }
  const reason = body.reason ? String(body.reason) : null;
  const { data: t } = await supabase
    .from("thoughts").select("id, serial_id, classification, metadata").match(getIdentityFilter(id)).maybeSingle();
  if (!t) return c.json({ error: "not found", id }, 404, corsHeaders);

  // Keep the thought LIVE — do NOT touch review_status. Atomic metadata merge.
  const patch: Record<string, unknown> = {
    classification_review: "open",
    classification_review_at: new Date().toISOString(),
  };
  if (guess) patch.classification = guess;        // best-guess mirrored into metadata
  if (reason) patch.classification_reason = reason;
  const { error: mErr } = await supabase.rpc("merge_thought_metadata", { p_thought_id: t.id, p_patch: patch });
  if (mErr) return c.json({ error: mErr.message }, 500, corsHeaders);
  if (guess) await supabase.from("thoughts").update({ classification: guess }).eq("id", t.id);  // keep column in sync
  return c.json({
    ok: true, id: t.serial_id, classification_review: "open",
    classification: guess ?? t.classification ?? (t.metadata as any)?.classification ?? null,
    reason, note: "thought stays live with a best-guess tag; surfaces in GET /classification-review for the operator's call",
  }, 200, corsHeaders);
});

// The "decision needed" view feed — open classification questions only. Live
// thoughts (never un-lived), each carrying its current best-guess + the reason.
app.get("/classification-review", async (c) => {
  const { data, error } = await supabase
    .from("thoughts")
    .select("id, serial_id, content, classification, source_type, created_at, metadata")
    .filter("metadata->>classification_review", "eq", "open")
    .order("created_at", { ascending: true });
  if (error) return c.json({ error: error.message }, 500, corsHeaders);
  const items = (data ?? []).map((t: any) => {
    const m = t.metadata ?? {};
    return {
      id: t.serial_id,
      current_classification: t.classification ?? m.classification ?? null,  // the best-guess in effect now
      reason: m.classification_reason ?? null,
      raised_at: m.classification_review_at ?? null,
      content_preview: (t.content ?? "").slice(0, 200),
      source_type: t.source_type ?? null,
    };
  });
  return c.json({ items, count: items.length }, 200, corsHeaders);
});

// Resolve — the operator's work/personal decision. Sets the classification (column +
// metadata) and closes the review flag. The thought was live throughout.
app.patch("/thought/:id/classification-review", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  const classification = (body.classification === "work" || body.classification === "personal") ? body.classification : null;
  if (!classification) return c.json({ error: "classification must be 'work' or 'personal'" }, 400, corsHeaders);
  const { data: t } = await supabase
    .from("thoughts").select("id, serial_id").match(getIdentityFilter(id)).maybeSingle();
  if (!t) return c.json({ error: "not found", id }, 404, corsHeaders);
  const { error: mErr } = await supabase.rpc("merge_thought_metadata", {
    p_thought_id: t.id,
    p_patch: { classification, classification_review: "resolved", classification_resolved_at: new Date().toISOString() },
  });
  if (mErr) return c.json({ error: mErr.message }, 500, corsHeaders);
  await supabase.from("thoughts").update({ classification }).eq("id", t.id);  // keep column in sync
  return c.json({ ok: true, id: t.serial_id, classification, classification_review: "resolved" }, 200, corsHeaders);
});

// ── Combined "needs your call" feed (added 2026-07-12) ──────────────────────
// ONE source of truth for everything the AI has flagged for the operator's decision, so
// the dashboard Thoughts-page "Queries" switch AND the Hermes agent's DM-to-the operator read the
// SAME set and can never drift (same principle as /context-brief — one query,
// no drifting approximations). Unions the two flag types verbatim from their
// own endpoints' filters: ESCALATIONS (curator unsure, held pending_review) and
// CLASSIFICATION-REVIEWS (work/personal, thought stays live). Each row carries a
// `kind` discriminator + a common shape, with kind-specific extras. Read-only.
// `?kind=all|escalation|classification` narrows it; default all, oldest-first.
app.get("/needs-attention", async (c) => {
  const kind = (c.req.query("kind") ?? "all").toLowerCase();
  const wantEsc = kind === "all" || kind === "escalation";
  const wantCls = kind === "all" || kind === "classification";

  const [escRes, clsRes] = await Promise.all([
    wantEsc
      ? supabase.from("thoughts")
          .select("serial_id, content, source_type, created_at, metadata")
          .filter("metadata->>review_status", "eq", "pending_review")
          .filter("metadata->>escalate", "eq", "true")
          .filter("metadata->>escalation_status", "eq", "open")
          .order("created_at", { ascending: true })
      : Promise.resolve({ data: [] as any[], error: null }),
    wantCls
      ? supabase.from("thoughts")
          .select("serial_id, content, classification, source_type, created_at, metadata")
          .filter("metadata->>classification_review", "eq", "open")
          .order("created_at", { ascending: true })
      : Promise.resolve({ data: [] as any[], error: null }),
  ]);
  if (escRes.error) return c.json({ error: escRes.error.message }, 500, corsHeaders);
  if (clsRes.error) return c.json({ error: clsRes.error.message }, 500, corsHeaders);

  const escItems = (escRes.data ?? []).map((t: any) => {
    const m = t.metadata ?? {};
    return {
      kind: "escalation" as const,
      id: t.serial_id,
      content_preview: (t.content ?? "").slice(0, 200),
      reason: m.open_question ?? m.escalate_reason ?? null,   // the question the operator should answer
      current_classification: null,
      decision: m.ollama_decision ?? null,                    // NEW | UPDATE
      target_id: m.update_target_id ?? null,                  // for UPDATE: merge target
      raised_at: t.created_at,
      created_at: t.created_at,
      source_type: t.source_type ?? null,
    };
  });
  const clsItems = (clsRes.data ?? []).map((t: any) => {
    const m = t.metadata ?? {};
    return {
      kind: "classification" as const,
      id: t.serial_id,
      content_preview: (t.content ?? "").slice(0, 200),
      reason: m.classification_reason ?? null,                // why the classifier was unsure
      current_classification: t.classification ?? m.classification ?? null,  // best-guess in effect
      decision: null,
      target_id: null,
      raised_at: m.classification_review_at ?? t.created_at,
      created_at: t.created_at,
      source_type: t.source_type ?? null,
    };
  });

  const items = [...escItems, ...clsItems].sort(
    (a, b) => new Date(a.raised_at).getTime() - new Date(b.raised_at).getTime()
  );
  return c.json({
    items,
    count: items.length,
    escalation_count: escItems.length,
    classification_count: clsItems.length,
  }, 200, corsHeaders);
});

// ── Extraction-queue consumer surface (A3 G1 — the Hermes agent replaces the worker) ────
// The queue + its thought-write SQL trigger stay as the universal intake
// ledger; these endpoints let a REST-only consumer (the Hermes agent, future Open Engine
// agents) drain it the way the worker did via direct DB access.

// Queue inspection + the F10 queue-depth alarm feed.
app.get("/extraction-queue", async (c) => {
  const status = c.req.query("status") ?? "pending";
  const limit = Math.min(100, Math.max(1, Number(c.req.query("limit") ?? 20)));
  const { count, error: cErr } = await supabase
    .from("entity_extraction_queue").select("*", { count: "exact", head: true }).eq("status", status);
  if (cErr) return c.json({ error: cErr.message }, 500, corsHeaders);
  const { data, error } = await supabase
    .from("entity_extraction_queue")
    .select("thought_id, status, attempt_count, claimed_by, queued_at, started_at, lease_expires_at, last_error, thoughts(serial_id, source_type, type)")
    .eq("status", status)
    .order("queued_at", { ascending: true })
    .limit(limit);
  if (error) return c.json({ error: error.message }, 500, corsHeaders);
  const rows = (data ?? []).map((r: any) => {
    const t = r.thoughts ?? {};
    const { thoughts: _drop, ...rest } = r;
    return { ...rest, serial_id: t.serial_id ?? null, source_type: t.source_type ?? null, thought_type: t.type ?? null };
  });
  return c.json({ status, total: count ?? 0, rows }, 200, corsHeaders);
});

// Atomic batch claim with crash-recovery leases. Returns full work context per
// row (thought content/source_type/metadata) so a consumer turn needs zero
// extra GETs. Curator-note rows first, then FIFO. Expired leases are reclaimed
// (attempts++, failed at cap) as a side-effect of every claim call.
app.post("/extraction-queue/claim", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const claimedBy = typeof body.claimed_by === "string" && body.claimed_by.trim() ? body.claimed_by.trim() : null;
  if (!claimedBy) return c.json({ error: "claimed_by (string) is required" }, 400, corsHeaders);
  const limit = Math.min(20, Math.max(1, Number(body.limit ?? 1)));
  const lease = Math.min(120, Math.max(1, Number(body.lease_minutes ?? 15)));
  const maxAttempts = Math.min(10, Math.max(1, Number(body.max_attempts ?? 3)));
  const { data, error } = await supabase.rpc("claim_extraction_batch", {
    p_claimed_by: claimedBy, p_limit: limit, p_lease_minutes: lease, p_max_attempts: maxAttempts,
  });
  if (error) return c.json({ error: error.message }, 500, corsHeaders);
  return c.json(data, 200, corsHeaders);
});

// Terminal transitions. :id = serial_id or uuid.
app.post("/extraction-queue/:id/complete", async (c) => {
  const uuid = await resolveThoughtUuid(c.req.param("id"));
  if (!uuid) return c.json({ error: "thought not found" }, 404, corsHeaders);
  const { data, error } = await supabase
    .from("entity_extraction_queue")
    .update({ status: "complete", processed_at: new Date().toISOString(), lease_expires_at: null })
    .eq("thought_id", uuid)
    .select("thought_id, status, claimed_by")
    .maybeSingle();
  if (error) return c.json({ error: error.message }, 500, corsHeaders);
  if (!data) return c.json({ error: "no queue row for that thought" }, 404, corsHeaders);
  return c.json({ ok: true, ...data }, 200, corsHeaders);
});

// Explicit failure: attempts++ immediately, 'failed' at the cap (poison guard —
// a deterministic failure must not spin consumer tokens; explicit reset only).
app.post("/extraction-queue/:id/fail", async (c) => {
  const uuid = await resolveThoughtUuid(c.req.param("id"));
  if (!uuid) return c.json({ error: "thought not found" }, 404, corsHeaders);
  const body = await c.req.json().catch(() => ({}));
  const maxAttempts = Math.min(10, Math.max(1, Number(body.max_attempts ?? 3)));
  const { data: row } = await supabase
    .from("entity_extraction_queue").select("attempt_count").eq("thought_id", uuid).maybeSingle();
  if (!row) return c.json({ error: "no queue row for that thought" }, 404, corsHeaders);
  const attempts = (row.attempt_count ?? 0) + 1;
  const status = attempts >= maxAttempts ? "failed" : "pending";
  const { error } = await supabase
    .from("entity_extraction_queue")
    .update({
      status,
      attempt_count: attempts,
      last_error: String(body.error ?? "consumer reported failure").slice(0, 500),
      claimed_by: null,
      lease_expires_at: null,
    })
    .eq("thought_id", uuid);
  if (error) return c.json({ error: error.message }, 500, corsHeaders);
  return c.json({ ok: true, status, attempt_count: attempts, requeued: status === "pending" }, 200, corsHeaders);
});

// Explicit reset of a failed/stuck row back to a fresh pending state.
app.post("/extraction-queue/:id/reset", async (c) => {
  const uuid = await resolveThoughtUuid(c.req.param("id"));
  if (!uuid) return c.json({ error: "thought not found" }, 404, corsHeaders);
  const { data, error } = await supabase
    .from("entity_extraction_queue")
    .update({ status: "pending", attempt_count: 0, last_error: null, claimed_by: null, lease_expires_at: null, queued_at: new Date().toISOString() })
    .eq("thought_id", uuid)
    .select("thought_id, status")
    .maybeSingle();
  if (error) return c.json({ error: error.message }, 500, corsHeaders);
  if (!data) return c.json({ error: "no queue row for that thought" }, 404, corsHeaders);
  return c.json({ ok: true, ...data }, 200, corsHeaders);
});

// A3 G2: clear a thought's graph links before re-extraction. The worker did
// this pre-write cleanup itself; POST /entities only appends, so a re-extract
// without this leaves stale entities linked and support counts drifting.
// Deleting thought_entity_edges rows fires maintain_edge_support_count, which
// decrements edges and removes zero-support unpinned ones.
app.post("/thought/:id/reset-graph-links", async (c) => {
  const uuid = await resolveThoughtUuid(c.req.param("id"));
  if (!uuid) return c.json({ error: "thought not found" }, 404, corsHeaders);
  const delEdges = await supabase.from("thought_entity_edges").delete().eq("thought_id", uuid).select("thought_id");
  if (delEdges.error) return c.json({ error: delEdges.error.message }, 500, corsHeaders);
  const delLinks = await supabase.from("thought_entities").delete().eq("thought_id", uuid).select("thought_id");
  if (delLinks.error) return c.json({ error: delLinks.error.message }, 500, corsHeaders);
  return c.json({
    ok: true,
    deleted_edge_provenance: delEdges.data?.length ?? 0,
    deleted_entity_links: delLinks.data?.length ?? 0,
    note: "edges.support_count decremented by trigger; zero-support unpinned edges auto-deleted",
  }, 200, corsHeaders);
});

// Granular unlink (GK curation, 2026-07-05): remove ONE wrong thought↔entity
// association without nuking the entity (DELETE /entities/:id) or wiping ALL of
// a thought's links (reset-graph-links). Removes the single thought_entities
// row + this thought's edge provenance touching that entity (the
// maintain_edge_support_count trigger then decrements/drops the rolled-up
// edges), and requeues wiki regen so the entity's page rebuilds without the
// mis-linked thought. Returns a full snapshot for reversibility. Load-bearing
// for the Hermes agent's curation sweep (de-noising mis-associations), not just one cleanup.
// :tid = serial_id or UUID; :eid = entity id. ?keep_edges=1 preserves provenance.
app.delete("/thought/:tid/entities/:eid", async (c) => {
  const uuid = await resolveThoughtUuid(c.req.param("tid"));
  const eid = Number(c.req.param("eid"));
  if (!uuid) return c.json({ error: "thought not found" }, 404, corsHeaders);
  if (!eid || isNaN(eid)) return c.json({ error: "valid entity id required" }, 400, corsHeaders);
  const keepEdges = c.req.query("keep_edges") === "1" || c.req.query("keep_edges") === "true";

  // Snapshot both the link and the pair's provenance before deleting (reversal).
  const { data: linkSnap } = await supabase
    .from("thought_entities").select("*").eq("thought_id", uuid).eq("entity_id", eid);
  if (!linkSnap || linkSnap.length === 0) {
    return c.json({ error: "no such thought↔entity link", thought_uuid: uuid, entity_id: eid }, 404, corsHeaders);
  }
  const { data: provSnap } = await supabase
    .from("thought_entity_edges").select("*").eq("thought_id", uuid)
    .or(`from_entity_id.eq.${eid},to_entity_id.eq.${eid}`);

  // Delete the link.
  const { error: linkErr } = await supabase
    .from("thought_entities").delete().eq("thought_id", uuid).eq("entity_id", eid);
  if (linkErr) return c.json({ error: linkErr.message }, 500, corsHeaders);

  // Delete this thought's edge provenance touching the entity (trigger rolls up
  // edges.support_count and auto-drops zero-support unpinned edges).
  let provDeleted = 0;
  if (!keepEdges && (provSnap ?? []).length) {
    const { data: pd, error: provErr } = await supabase
      .from("thought_entity_edges").delete().eq("thought_id", uuid)
      .or(`from_entity_id.eq.${eid},to_entity_id.eq.${eid}`).select("thought_id");
    if (provErr) return c.json({ error: provErr.message, note: "link removed but provenance delete failed" }, 500, corsHeaders);
    provDeleted = pd?.length ?? 0;
  }

  // Requeue wiki regen for the entity if it has a page, so it rebuilds clean.
  let regenQueued = false;
  const { data: page } = await supabase.from("wiki_pages").select("slug").eq("entity_id", eid).maybeSingle();
  if (page) {
    await supabase.from("wiki_pages").update({ generated_at: null }).eq("entity_id", eid);
    const { error: rqErr } = await supabase.from("wiki_regen_queue")
      .insert({ entity_id: eid, slug: page.slug, requested_by: "granular-unlink", reason: `unlinked thought ${uuid}` });
    regenQueued = !rqErr; // 23505 = already queued; fine
  }

  return c.json({
    ok: true, thought_uuid: uuid, entity_id: eid,
    deleted_link: linkSnap[0],
    deleted_provenance: provSnap ?? [],
    provenance_deleted_count: provDeleted,
    wiki_regen_queued: regenQueued,
    note: "reversible via re-insert of deleted_link (+ deleted_provenance); edges.support_count adjusted by trigger",
  }, 200, corsHeaders);
});

// Graph audit trail (A3 build-order #3) — every semantic entity/edge mutation
// with before/after, written by DB triggers so ALL writers are covered. This
// is the review surface that gates the Hermes agent auto-merge: ?entity_id=N shows every
// mutation touching that entity (its own row + edges where it's an endpoint).
app.get("/graph-audit", async (c) => {
  const limit = Math.min(200, Math.max(1, Number(c.req.query("limit") ?? 50)));
  const entityId = c.req.query("entity_id");
  const table = c.req.query("table");
  const op = c.req.query("op");
  const since = c.req.query("since");
  let q = supabase.from("graph_audit").select("*").order("created_at", { ascending: false }).limit(limit);
  if (table) q = q.eq("table_name", table);
  if (op) q = q.eq("op", op.toUpperCase());
  if (since) q = q.gte("created_at", since);
  if (entityId) {
    q = q.or(
      `and(table_name.eq.entities,row_id.eq.${Number(entityId)}),` +
      `and(table_name.eq.edges,details->from_entity_id.eq.${Number(entityId)}),` +
      `and(table_name.eq.edges,details->to_entity_id.eq.${Number(entityId)})`,
    );
  }
  const { data, error } = await q;
  if (error) return c.json({ error: error.message }, 500, corsHeaders);
  return c.json({ audit: data ?? [], count: (data ?? []).length }, 200, corsHeaders);
});

// Ingestion jobs — list
app.get("/ingestion-jobs", async (c) => {
  const { data, error, count } = await supabase
    .from("ingestion_jobs")
    .select("*", { count: "exact" })
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ jobs: data || [], count: count ?? 0 }, 200, corsHeaders);
});

// Ingestion job — single
app.get("/ingestion-jobs/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const { data: job, error } = await supabase.from("ingestion_jobs").select("*").eq("id", id).maybeSingle();
  if (error) return c.json({ error: error.message }, 500);
  if (!job) return c.json({ error: "Not found" }, 404);
  const { data: items } = await supabase.from("ingestion_items").select("*").eq("job_id", id).order("id");
  return c.json({ job, items: items || [] }, 200, corsHeaders);
});

// Ingest — extract and commit a block of text
app.post("/ingest", async (c) => {
  const { text, dry_run } = await c.req.json();
  if (!text?.trim()) return c.json({ error: "text is required" }, 400);

  const { data: job, error: jobErr } = await supabase
    .from("ingestion_jobs")
    .insert({ source_label: "manual", status: "pending" })
    .select().single();
  if (jobErr) return c.json({ error: jobErr.message }, 500);

  const extracted = await extractThoughts(text.trim());

  if (extracted.length > 0) {
    await supabase.from("ingestion_items").insert(
      extracted.map(item => ({
        job_id: job.id,
        content: item.content,
        type: item.type,
        fingerprint: "",
        action: "pending",
        status: "pending",
        metadata: {},
      }))
    );
  }

  await supabase.from("ingestion_jobs")
    .update({ status: "extracted", extracted_count: extracted.length })
    .eq("id", job.id);

  if (dry_run) {
    return c.json({ job_id: job.id, status: "dry_run_complete", extracted_count: extracted.length }, 201, corsHeaders);
  }

  const added = await executeJob(job.id);
  return c.json({ job_id: job.id, status: "complete", extracted_count: extracted.length, added_count: added }, 201, corsHeaders);
});

// Ingestion job — execute pending items
app.post("/ingestion-jobs/:id/execute", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const added = await executeJob(id);
  return c.json({ job_id: id, status: "complete", added_count: added }, 200, corsHeaders);
});

async function extractThoughts(text: string): Promise<Array<{ content: string; type: string }>> {
  const apiKey = Deno.env.get("OPENROUTER_API_KEY");
  if (apiKey) {
    try {
      const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "openai/gpt-4o-mini",
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: `Extract distinct thoughts from the text. Return JSON: {"thoughts":[{"content":"...","type":"task|idea|observation|reference|meeting|decision|lesson"}]}. Max 20 thoughts.` },
            { role: "user", content: text },
          ],
        }),
      });
      if (r.ok) {
        const d = await r.json();
        const parsed = JSON.parse(d.choices[0].message.content);
        if (Array.isArray(parsed.thoughts) && parsed.thoughts.length > 0) return parsed.thoughts;
      }
    } catch { /* fall through to heuristic */ }
  }
  return text
    .split(/\n+/)
    .map((l: string) => l.replace(/^[\-\*•]\s*/, "").replace(/^\d+[.)]\s*/, "").trim())
    .filter((l: string) => l.length > 10)
    .slice(0, 20)
    .map((content: string) => ({ content, type: "observation" }));
}

async function executeJob(jobId: number): Promise<number> {
  const { data: items } = await supabase
    .from("ingestion_items").select("*").eq("job_id", jobId).eq("status", "pending");
  let added = 0;
  for (const item of items || []) {
    const fp = await fingerprint(item.content);
    const { data: dup } = await supabase.from("thoughts")
      .select("id").eq("metadata->>content_fingerprint", fp).maybeSingle();
    if (dup) {
      await supabase.from("ingestion_items").update({ action: "skip", status: "done", fingerprint: fp }).eq("id", item.id);
      continue;
    }
    const { data: ins } = await supabase.from("thoughts").insert({
      content: item.content, type: item.type || "observation",
      importance: 3, quality_score: 50, classification: "personal",
      content_fingerprint: fp,
      metadata: { content_fingerprint: fp, job_id: jobId },
    }).select("id, serial_id").single();
    if (ins) {
      await supabase.from("entity_extraction_queue")
        .upsert({ thought_id: ins.id }, { onConflict: "thought_id", ignoreDuplicates: true });
      getEmbedding(item.content).then(emb => {
        if (emb) supabase.from("thoughts").update({ embedding: emb }).eq("id", ins.id);
      });
      await supabase.from("ingestion_items")
        .update({ action: "add", status: "done", fingerprint: fp }).eq("id", item.id);
      added++;
    }
  }
  await supabase.from("ingestion_jobs")
    .update({ status: "complete", added_count: added, completed_at: new Date().toISOString() })
    .eq("id", jobId);
  return added;
}

// Wiki pages — list (no content field), includes entity aliases for search
// Wiki pages — list. Explicit pagination so we don't silently rely on
// PostgREST's db-default-rows (1000) ceiling. Returns the page slice + total
// count so the dashboard can show "N of M" and trigger fetch-more.
//   ?page=1          (1-based)
//   ?per_page=N      (default 5000, max 10000 — covers any realistic brain
//                     in one round-trip; bump only if needed)
app.get("/wiki-pages", async (c) => {
  const page = Math.max(1, Number(c.req.query("page")) || 1);
  const perPageParam = Number(c.req.query("per_page"));
  const perPage = Math.min(
    10000,
    Math.max(1, Number.isFinite(perPageParam) && perPageParam > 0 ? perPageParam : 5000)
  );
  const from = (page - 1) * perPage;
  const to = from + perPage - 1;

  const { data, error, count } = await supabase
    .from("wiki_pages")
    .select(
      "id, slug, type, entity_id, title, generated_at, thought_count, manually_edited, metadata, entities(aliases)",
      { count: "exact" }
    )
    .order("type", { ascending: true })
    .order("title", { ascending: true })
    .range(from, to);
  if (error) return c.json({ error: error.message }, 500, corsHeaders);
  const pages = (data || []).map((p: Record<string, unknown>) => {
    const ent = p.entities as { aliases?: string[] } | null;
    return { ...p, aliases: ent?.aliases ?? [], entities: undefined };
  });
  return c.json({
    data: pages,
    total: count ?? pages.length,
    page,
    per_page: perPage,
  }, 200, corsHeaders);
});

// Entities — list / search. Backed by search_entities() RPC so the search
// term matches canonical_name OR any alias in SQL. Default returns 200 rows
// (enough for the merge picker's initial render); when the user types a
// search term, the RPC narrows server-side and returns up to `limit` matches.
//   ?search=eu      — match canonical_name or any alias
//   ?no_wiki=true   — only entities without a wiki page
//   ?limit=N        — cap returned rows (default 200, max 5000)
app.get("/entities", async (c) => {
  const noWiki = c.req.query("no_wiki") === "true";
  const search = c.req.query("search") || "";
  const limitParam = Number(c.req.query("limit"));
  const limit = Math.min(
    5000,
    Math.max(20, Number.isFinite(limitParam) && limitParam > 0 ? limitParam : 200)
  );

  const { data, error } = await supabase.rpc("search_entities", {
    p_search: search || null,
    p_no_wiki: noWiki,
    p_limit: limit,
  });
  if (error) return c.json({ error: error.message }, 500, corsHeaders);

  return c.json({ entities: data ?? [] }, 200, corsHeaders);
});

// Entities — CREATE (or get) an entity, optionally link it to a thought and
// create edges. This is the write counterpart to GET /entities, built for the
// worker-less future where an agent (Hermes/the Hermes agent) owns graph writes directly
// instead of scripts/local-brain-worker.js. It MIRRORS the worker's
// writeGraph() shape so rows are identical whichever path produced them:
//   - dedup: alias-contains, then cross-type normalized_name match (both reuse
//     the existing row), then entity_blocklist (refuse to recreate a deleted one)
//   - entity upsert on (entity_type, normalized_name)
//   - thought_entities link with onConflict (thought_id, entity_id, mention_role)
//   - edges go through the thought_entity_edges PROVENANCE table when a
//     thought_id is supplied (the maintain_edge_support_count trigger rolls them
//     up into `edges`); without a thought_id they go straight to `edges` with
//     metadata.source, the /edges/manual pattern, for a standalone assertion.
// edge_blocklist is respected on both paths. Wiki requeue is opt-in (off by
// default) since it re-involves the worker — leave it off in worker-less mode.
//
// Body: { canonical_name(req), entity_type(req), aliases?:string[], metadata?,
//   thought_id?:serial_id|uuid, mention_role?, confidence?, source?,
//   edges?:[{ to_entity_id?:int | to_entity_name?:string, relation,
//             direction?:"from"|"to", confidence? }], requeue_for_wiki?:bool }
const ENTITY_VALID_TYPES = ["person", "organization", "org", "project", "tool", "place", "topic", "entity", "newsletter", "prompt"];
// Entity-edge relations accepted here = worker VALID_RELATIONS ∪ the inference-
// only pair (lives_in, is_part_of) the worker can't emit single-thought. Keep
// in sync with MANUAL_EDGE_RELATIONS + scripts/local-brain-worker.js.
const ENTITY_EDGE_RELATIONS = new Set([
  "works_on", "uses", "uses_tool", "collaborates_with", "integrates_with",
  "alternative_to", "evaluates", "member_of", "located_in", "related_to",
  "co_occurs_with", "published_by", "references",
  "knew", "friend_of", "family_of", "mentor_of", "introduced_via",
  "lives_in", "is_part_of",
  // relevant_to (2026-07-05): directional "suggested reading" — an AI-newsletter
  // story linked to a project it'd be useful reading FOR (not used-in/references).
  // Intentional feature, not noise. ob_drain + newsletter skill emit it going forward.
  "relevant_to",
]);

// Junk-topic filter, ported server-side from local-brain-worker.js isJunkTopic
// (worker L83-126) so EVERY writer benefits — not just the worker's own
// extraction path (A3 gap-review F4). Applies to entity_type='topic' only.
// Catches dates, filenames/paths, config keys, pure numbers, ticket IDs,
// SKU-like strings, and a block-list of generic nouns that should be a
// specific entity instead. Kept in sync with the worker until it retires.
const TOPIC_FILE_EXT_RE = /\.(md|markdown|json|ya?ml|toml|env|ini|cfg|sql|tsx?|jsx?|mjs|cjs|py|rb|go|rs|sh|ps1|bat|txt|csv|log|html?|css|scss|xml)$/i;
const TOPIC_DATE_RE = /^(\d{4}-\d{1,2}-\d{1,2}|\d{1,2}\/\d{1,2}\/\d{2,4}|Q[1-4](\s*\d{4})?|\d{4}\s*Q[1-4]|H[12](\s*\d{4})?)$/i;
const TOPIC_CONFIG_KEY_RE = /^[a-z][a-z0-9]*(_[a-z0-9]+){1,}$/;
const TOPIC_PURE_NUMBER_RE = /^[£$€]?\s*[\d,]+(\.\d+)?\s*[kKmMbB%]?$/;
const TOPIC_FILE_PATH_RE = /^[.\/\\]|^[\w\-]+\/[\w\-./\\]+\.[a-z]{1,5}$/i;
const TOPIC_TICKET_ID_RE = /^[A-Z]{2,5}-\d+$/;
const TOPIC_SKU_LIKE_RE = /^\d[\d,]*\s*-\s*\w/;
const TOPIC_BAD_GENERIC_NOUNS = new Set([
  "funder", "funders", "rate book", "rate books", "the meeting", "the system",
  "the bot", "the dashboard", "the tool", "the project", "the platform",
  "the team", "the vendor", "the client", "the customer",
  "stakeholder meetings", "stakeholder meeting", "poc milestones", "poc milestone",
  "end-of-quarter period", "weekly standup", "daily standup", "all-hands",
  "the call", "the chat", "the email", "the demo", "the proposal",
]);
function junkTopicReason(name: string): string | null {
  const t = String(name || "").trim();
  if (!t) return "empty";
  if (t.length < 2) return "single character";
  if (TOPIC_DATE_RE.test(t)) return "date/quarter";
  if (TOPIC_FILE_EXT_RE.test(t)) return "filename";
  if (TOPIC_FILE_PATH_RE.test(t)) return "file path";
  if (TOPIC_CONFIG_KEY_RE.test(t)) return "config key";
  if (TOPIC_PURE_NUMBER_RE.test(t)) return "pure number";
  if (TOPIC_TICKET_ID_RE.test(t)) return "ticket id";
  if (TOPIC_SKU_LIKE_RE.test(t)) return "sku-like";
  if (TOPIC_BAD_GENERIC_NOUNS.has(t.toLowerCase())) return "generic noun (name the specific entity instead)";
  return null;
}

app.post("/entities", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const canonicalName = typeof body.canonical_name === "string" ? body.canonical_name.trim() : "";
  const entityType = typeof body.entity_type === "string" ? body.entity_type.trim() : "";

  if (!canonicalName || !entityType) {
    return c.json({ error: "canonical_name and entity_type (strings) are required" }, 400, corsHeaders);
  }
  if (!ENTITY_VALID_TYPES.includes(entityType)) {
    return c.json({ error: `Invalid entity_type. Must be one of: ${ENTITY_VALID_TYPES.join(", ")}` }, 400, corsHeaders);
  }
  // Explicit 422 (not the worker's silent drop) so an agent caller learns the rule.
  if (entityType === "topic") {
    const junk = junkTopicReason(canonicalName);
    if (junk) {
      return c.json({ error: "junk topic rejected", reason: junk, name: canonicalName, rejected: true }, 422, corsHeaders);
    }
  }

  const normalizedName = canonicalName.toLowerCase().trim().replace(/\s+/g, " ");
  const providedAliases: string[] = Array.isArray(body.aliases)
    ? body.aliases.filter((a: unknown) => typeof a === "string" && a.trim()).map((a: string) => a.trim())
    : [];
  const providedMeta: Record<string, unknown> = (body.metadata && typeof body.metadata === "object") ? body.metadata : {};
  const linkSource = typeof body.source === "string" && body.source.trim() ? body.source.trim() : "agent_api";

  // ── 1. Resolve existing entity (mirror worker upsertEntity checks 1–2) ────
  let existing: any = null;
  const { data: aliasMatch } = await supabase
    .from("entities")
    .select("id, canonical_name, entity_type, aliases, metadata")
    .contains("aliases", [canonicalName])
    .limit(1)
    .maybeSingle();
  if (aliasMatch) existing = aliasMatch;

  if (!existing) {
    const { data: nameMatch } = await supabase
      .from("entities")
      .select("id, canonical_name, entity_type, aliases, metadata")
      .eq("normalized_name", normalizedName)
      .limit(1)
      .maybeSingle();
    if (nameMatch) existing = nameMatch;
  }

  let entityId: number;
  let created = false;

  if (existing) {
    entityId = existing.id;
    // Reuse enriches: merge any new aliases + metadata into the surviving row.
    const mergedAliases = Array.from(new Set([...(existing.aliases ?? []), ...providedAliases]));
    const mergedMeta = { ...(existing.metadata ?? {}), ...providedMeta };
    await supabase
      .from("entities")
      .update({
        aliases: mergedAliases,
        metadata: mergedMeta,
        last_seen_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", entityId);
  } else {
    // (3) blocklist — refuse to recreate a user-deleted entity.
    const { data: blocked } = await supabase
      .from("entity_blocklist")
      .select("reason")
      .eq("entity_type", entityType)
      .eq("normalized_name", normalizedName)
      .maybeSingle();
    if (blocked) {
      return c.json({
        blocked: true,
        reason: blocked.reason ?? "blocked",
        message: "Entity is in entity_blocklist (previously removed). Unblock before recreating.",
      }, 409, corsHeaders);
    }

    const { data: inserted, error: insErr } = await supabase
      .from("entities")
      .upsert({
        entity_type: entityType,
        canonical_name: canonicalName,
        normalized_name: normalizedName,
        aliases: providedAliases,
        metadata: providedMeta,
        last_seen_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }, { onConflict: "entity_type,normalized_name" })
      .select("id")
      .single();
    if (insErr) return c.json({ error: insErr.message }, 500, corsHeaders);
    entityId = inserted.id;
    created = true;
  }

  // ── 2. Optional thought link ──────────────────────────────────────────────
  let linked = false;
  let thoughtUuid: string | null = null;
  if (body.thought_id != null) {
    thoughtUuid = await resolveThoughtUuid(String(body.thought_id));
    if (!thoughtUuid) {
      return c.json({ error: `thought_id ${body.thought_id} not found`, entity_id: entityId, created }, 404, corsHeaders);
    }
    const mentionRole = typeof body.mention_role === "string" && body.mention_role.trim() ? body.mention_role.trim() : "mentioned";
    const linkConf = Number.isFinite(Number(body.confidence)) ? Math.max(0, Math.min(1, Number(body.confidence))) : null;
    const { error: linkErr } = await supabase
      .from("thought_entities")
      .upsert({
        thought_id: thoughtUuid,
        entity_id: entityId,
        mention_role: mentionRole,
        confidence: linkConf,
        source: linkSource,
      }, { onConflict: "thought_id,entity_id,mention_role" });
    if (linkErr) return c.json({ error: `link failed: ${linkErr.message}`, entity_id: entityId, created }, 500, corsHeaders);
    linked = true;
  }

  // ── 3. Optional edges ─────────────────────────────────────────────────────
  const edgeResults: Array<Record<string, unknown>> = [];
  if (Array.isArray(body.edges)) {
    for (const spec of body.edges) {
      const relation = typeof spec?.relation === "string" ? spec.relation.trim().toLowerCase() : "";
      if (!ENTITY_EDGE_RELATIONS.has(relation)) {
        edgeResults.push({ skipped: true, reason: `invalid relation '${relation}'` });
        continue;
      }
      // Resolve the other endpoint by id or by exact normalized_name.
      let otherId: number | null = null;
      if (Number.isFinite(Number(spec?.to_entity_id))) {
        otherId = Number(spec.to_entity_id);
      } else if (typeof spec?.to_entity_name === "string" && spec.to_entity_name.trim()) {
        const otherNorm = spec.to_entity_name.toLowerCase().trim().replace(/\s+/g, " ");
        const { data: other } = await supabase
          .from("entities").select("id").eq("normalized_name", otherNorm).limit(1).maybeSingle();
        otherId = other?.id ?? null;
        if (!otherId) { edgeResults.push({ skipped: true, reason: `unknown to_entity_name '${spec.to_entity_name}'` }); continue; }
      } else {
        edgeResults.push({ skipped: true, reason: "edge needs to_entity_id or to_entity_name" });
        continue;
      }

      const direction = spec?.direction === "to" ? "to" : "from";
      let fromId = direction === "to" ? otherId : entityId;
      let toId = direction === "to" ? entityId : otherId;
      if (fromId === toId) { edgeResults.push({ skipped: true, reason: "self-edge" }); continue; }

      const edgeConf = Number.isFinite(Number(spec?.confidence)) ? Math.max(0, Math.min(1, Number(spec.confidence))) : 0.9;
      const key = normalizeEdgeKey(fromId, toId, relation);
      fromId = key.from; toId = key.to;

      const { data: eBlocked } = await supabase
        .from("edge_blocklist").select("reason")
        .eq("from_entity_id", fromId).eq("to_entity_id", toId).eq("relation", relation).maybeSingle();
      if (eBlocked) { edgeResults.push({ blocked: true, reason: eBlocked.reason, from: fromId, to: toId, relation }); continue; }

      if (thoughtUuid) {
        // Provenance path — the trigger upserts edges.support_count for us.
        const { error: provErr } = await supabase
          .from("thought_entity_edges")
          .upsert({
            thought_id: thoughtUuid,
            from_entity_id: fromId,
            to_entity_id: toId,
            relation,
            confidence: edgeConf,
          }, { onConflict: "thought_id,from_entity_id,to_entity_id,relation" });
        if (provErr) { edgeResults.push({ error: provErr.message, from: fromId, to: toId, relation }); continue; }
        edgeResults.push({ created: true, via: "provenance", from: fromId, to: toId, relation });
      } else {
        // Direct path — standalone assertion (mirrors POST /edges/manual).
        const { data: exists } = await supabase
          .from("edges").select("id")
          .eq("from_entity_id", fromId).eq("to_entity_id", toId).eq("relation", relation).maybeSingle();
        if (exists) { edgeResults.push({ existed: true, edge_id: exists.id, from: fromId, to: toId, relation }); continue; }
        const { data: insEdge, error: edgeErr } = await supabase
          .from("edges")
          .insert({
            from_entity_id: fromId,
            to_entity_id: toId,
            relation,
            support_count: 1,
            confidence: edgeConf,
            metadata: { source: linkSource === "agent_api" ? "manual" : linkSource, added_at: new Date().toISOString(), added_via: "POST /entities" },
          })
          .select("id").maybeSingle();
        if (edgeErr) { edgeResults.push({ error: edgeErr.message, from: fromId, to: toId, relation }); continue; }
        edgeResults.push({ created: true, via: "direct", edge_id: insEdge?.id ?? null, from: fromId, to: toId, relation });
      }
    }
  }

  // ── 4. Optional wiki requeue (off by default; re-involves the worker) ─────
  let requeued = false;
  if (body.requeue_for_wiki === true) {
    const ids = new Set<number>([entityId]);
    for (const r of edgeResults) {
      if (typeof r.from === "number") ids.add(r.from as number);
      if (typeof r.to === "number") ids.add(r.to as number);
    }
    for (const eid of ids) {
      const { data: link } = await supabase
        .from("thought_entities").select("thought_id")
        .eq("entity_id", eid).order("created_at", { ascending: false }).limit(1).maybeSingle();
      if (link?.thought_id) {
        await supabase.from("entity_extraction_queue").upsert({
          thought_id: link.thought_id, status: "pending", attempt_count: 0,
          last_error: null, queued_at: new Date().toISOString(),
        }, { onConflict: "thought_id" });
        requeued = true;
      }
    }
  }

  return c.json({
    entity: { id: entityId, canonical_name: canonicalName, entity_type: entityType, created },
    linked,
    thought_uuid: thoughtUuid,
    edges: edgeResults,
    requeued,
  }, created ? 201 : 200, corsHeaders);
});

// Entities — add or remove an alias
app.patch("/entities/:id/aliases", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json();
  const alias = typeof body.alias === "string" ? body.alias.trim() : "";
  if (!alias) return c.json({ error: "alias (string) is required" }, 400, corsHeaders);

  const { data: entity, error: fetchErr } = await supabase
    .from("entities")
    .select("aliases")
    .eq("id", id)
    .single();
  if (fetchErr || !entity) return c.json({ error: "Entity not found" }, 404, corsHeaders);

  const current: string[] = entity.aliases ?? [];

  let updated: string[];
  let absorbed: { id: number; canonical_name: string }[] = [];
  let resplitQueued = 0;

  if (body.action === "remove" || body.action === "remove_and_resplit") {
    updated = current.filter((a: string) => a !== alias);
    // remove_and_resplit: undo a bad auto-absorb. Re-queue every thought
    // currently linked to this entity for re-extraction, so the worker can
    // re-derive entity bindings from content. Thoughts that mention the
    // removed alias name will get a fresh entity created (since the alias is
    // gone, no match exists), splitting the merged data back apart.
    if (body.action === "remove_and_resplit") {
      const { data: links } = await supabase
        .from("thought_entities")
        .select("thought_id")
        .eq("entity_id", id);
      const thoughtIds = Array.from(
        new Set((links ?? []).map((l: { thought_id: string }) => l.thought_id))
      );
      if (thoughtIds.length > 0) {
        const nowIso = new Date().toISOString();
        const rows = thoughtIds.map((thought_id) => ({
          thought_id,
          status: "pending",
          attempt_count: 0,
          last_error: null,
          queued_at: nowIso,
        }));
        await supabase
          .from("entity_extraction_queue")
          .upsert(rows, { onConflict: "thought_id" });
        resplitQueued = rows.length;
      }
      // Mark wiki page stale so the regen picks it up first.
      await supabase
        .from("wiki_pages")
        .update({ generated_at: null })
        .eq("entity_id", id);
    }
  } else {
    // Auto-absorb runs whether or not the alias is already in the list. Why:
    // a duplicate may have been created AFTER the alias was added, so the
    // alias being there doesn't guarantee absorption already happened.
    // Loose normalization (lowercase, hyphen↔space, trim) catches "EU-locked
    // Gemini" matching alias "EU Locked Gemini".
    absorbed = await absorbDuplicatesByName(id, alias);

    // Pull aliases from absorbed rows so they survive into the surviving entity
    const extraAliases = absorbed.flatMap((d) => d.aliases ?? []);
    const merged = new Set([...current, alias, ...extraAliases]);
    updated = Array.from(merged);
  }

  const { error: updateErr } = await supabase
    .from("entities")
    .update({ aliases: updated, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (updateErr) return c.json({ error: updateErr.message }, 500, corsHeaders);
  return c.json({
    aliases: updated,
    absorbed: absorbed.map((a) => ({ id: a.id, canonical_name: a.canonical_name })),
    resplit_queued: resplitQueued,
  }, 200, corsHeaders);
});

// Loose normalization used for alias-driven duplicate detection. Stricter than
// `normalized_name` (which keeps hyphens) — collapses any of [-_ ] runs to a
// single space so "EU-locked Gemini" and "EU Locked Gemini" match.
function looseNormalize(s: string): string {
  return String(s || "")
    .toLowerCase()
    .trim()
    .replace(/[\s\-_]+/g, " ")
    .replace(/[.,;!?]+$/, "");
}

interface AbsorbedEntity {
  id: number;
  canonical_name: string;
  aliases: string[];
}

// Find any other entity whose canonical_name OR any of its aliases looses-
// matches the given name, and absorb each one into `survivorId`. Returns the
// list of absorbed entities so the caller can report them.
async function absorbDuplicatesByName(
  survivorId: number,
  matchName: string
): Promise<AbsorbedEntity[]> {
  const target = looseNormalize(matchName);
  if (!target) return [];

  // Pull a candidate set: any entity whose canonical_name OR alias contains the
  // first significant word of the match (cheap pre-filter via ilike), then
  // verify with full loose normalization in JS.
  const word = target.split(" ").reduce((longest, w) =>
    w.length > longest.length ? w : longest, ""
  );
  if (!word) return [];

  const { data: candidates } = await supabase
    .from("entities")
    .select("id, canonical_name, aliases, entity_type")
    .neq("id", survivorId)
    .or(`canonical_name.ilike.%${word}%,aliases.cs.{${word}}`)
    .limit(50);

  const matches: AbsorbedEntity[] = [];
  for (const c of candidates || []) {
    if (looseNormalize(c.canonical_name) === target) {
      matches.push({ id: c.id, canonical_name: c.canonical_name, aliases: c.aliases ?? [] });
      continue;
    }
    if ((c.aliases ?? []).some((a: string) => looseNormalize(a) === target)) {
      matches.push({ id: c.id, canonical_name: c.canonical_name, aliases: c.aliases ?? [] });
    }
  }

  // Absorb each match into the survivor. Mirror the logic from PATCH
  // /entities/:id absorbDuplicate(): move thought_entities, dedupe edges, drop
  // wiki page + entity row.
  for (const dupe of matches) {
    await supabase
      .from("thought_entities")
      .update({ entity_id: survivorId })
      .eq("entity_id", dupe.id);

    const { data: fromEdges } = await supabase
      .from("edges")
      .select("id, to_entity_id, relation")
      .eq("from_entity_id", dupe.id);
    for (const edge of fromEdges || []) {
      const { data: dup } = await supabase
        .from("edges")
        .select("id")
        .eq("from_entity_id", survivorId)
        .eq("to_entity_id", edge.to_entity_id)
        .eq("relation", edge.relation)
        .maybeSingle();
      if (!dup) {
        await supabase.from("edges").update({ from_entity_id: survivorId }).eq("id", edge.id);
      } else {
        await supabase.from("edges").delete().eq("id", edge.id);
      }
    }

    const { data: toEdges } = await supabase
      .from("edges")
      .select("id, from_entity_id, relation")
      .eq("to_entity_id", dupe.id);
    for (const edge of toEdges || []) {
      const { data: dup } = await supabase
        .from("edges")
        .select("id")
        .eq("from_entity_id", edge.from_entity_id)
        .eq("to_entity_id", survivorId)
        .eq("relation", edge.relation)
        .maybeSingle();
      if (!dup) {
        await supabase.from("edges").update({ to_entity_id: survivorId }).eq("id", edge.id);
      } else {
        await supabase.from("edges").delete().eq("id", edge.id);
      }
    }

    await supabase.from("wiki_pages").delete().eq("entity_id", dupe.id);
    await supabase.from("entities").delete().eq("id", dupe.id);
  }

  // Trigger downstream refresh on the survivor:
  //   1. Re-queue ONE of its thoughts for entity extraction so the
  //      thought_entity_edges trigger refreshes provenance / edge support.
  //   2. Mark the survivor's wiki page stale (generated_at = NULL) so the
  //      next compile picks it up first. The wiki compiler always
  //      regenerates everything but this lets a partial-regen script
  //      filter to "needs_regen" pages and act fast.
  if (matches.length > 0) {
    const { data: link } = await supabase
      .from("thought_entities")
      .select("thought_id")
      .eq("entity_id", survivorId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (link?.thought_id) {
      await supabase.from("entity_extraction_queue").upsert(
        {
          thought_id: link.thought_id,
          status: "pending",
          attempt_count: 0,
          last_error: null,
          queued_at: new Date().toISOString(),
        },
        { onConflict: "thought_id" }
      );
    }
    await supabase
      .from("wiki_pages")
      .update({ generated_at: null })
      .eq("entity_id", survivorId);
  }

  return matches;
}

// Entities — rename and/or reclassify (slug preserved to keep existing links)
app.patch("/entities/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json();
  const newName = typeof body.canonical_name === "string" ? body.canonical_name.trim() : null;
  const newType = typeof body.entity_type === "string" ? body.entity_type.trim() : null;

  if (!newName && !newType) {
    return c.json({ error: "canonical_name or entity_type is required" }, 400, corsHeaders);
  }

  const VALID_TYPES = ["person", "organization", "org", "project", "tool", "place", "topic", "entity", "newsletter", "prompt"];
  if (newType && !VALID_TYPES.includes(newType)) {
    return c.json({ error: `Invalid entity_type. Must be one of: ${VALID_TYPES.join(", ")}` }, 400, corsHeaders);
  }

  // Before applying name or type changes, check for an invisible duplicate entity
  // (same entity_type + normalized_name, no wiki page) and silently absorb it.
  // This prevents unique-constraint failures when the target name/type already exists
  // in the DB but is not visible in the UI.
  async function absorbDuplicate(targetType: string, targetNormalizedName: string) {
    const { data: dupe } = await supabase
      .from("entities")
      .select("id")
      .eq("entity_type", targetType)
      .eq("normalized_name", targetNormalizedName)
      .neq("id", id)
      .maybeSingle();
    if (!dupe) return;
    await supabase.from("thought_entities").update({ entity_id: id }).eq("entity_id", dupe.id);
    const { data: fromEdges } = await supabase.from("edges").select("id, to_entity_id, relation").eq("from_entity_id", dupe.id);
    for (const edge of fromEdges || []) {
      const { data: dup } = await supabase.from("edges").select("id")
        .eq("from_entity_id", id).eq("to_entity_id", edge.to_entity_id).eq("relation", edge.relation).maybeSingle();
      if (!dup) await supabase.from("edges").update({ from_entity_id: id }).eq("id", edge.id);
      else await supabase.from("edges").delete().eq("id", edge.id);
    }
    const { data: toEdges } = await supabase.from("edges").select("id, from_entity_id, relation").eq("to_entity_id", dupe.id);
    for (const edge of toEdges || []) {
      const { data: dup } = await supabase.from("edges").select("id")
        .eq("from_entity_id", edge.from_entity_id).eq("to_entity_id", id).eq("relation", edge.relation).maybeSingle();
      if (!dup) await supabase.from("edges").update({ to_entity_id: id }).eq("id", edge.id);
      else await supabase.from("edges").delete().eq("id", edge.id);
    }
    await supabase.from("wiki_pages").delete().eq("entity_id", dupe.id);
    await supabase.from("entities").delete().eq("id", dupe.id);
  }

  const { data: current } = await supabase
    .from("entities").select("entity_type, normalized_name, canonical_name").eq("id", id).maybeSingle();

  if (current) {
    const effectiveType = newType || current.entity_type;
    const effectiveName = newName
      ? newName.toLowerCase().trim().replace(/\s+/g, " ")
      : current.normalized_name;
    await absorbDuplicate(effectiveType, effectiveName);
  }

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (newName) {
    updates.canonical_name = newName;
    updates.normalized_name = newName.toLowerCase().trim().replace(/\s+/g, " ");
  }
  if (newType) updates.entity_type = newType;

  const { error } = await supabase.from("entities").update(updates).eq("id", id);
  if (error) return c.json({ error: error.message }, 500, corsHeaders);

  // Keep the wiki page in sync — title, metadata, AND the slug (the operator's rule:
  // renames must alias-merge the old slug, never orphan a stale page — the
  // person-mark/person-h4 duplicates came from renames that kept old slugs).
  // The slug moves in place, and a regen request is filed so the Hermes agent re-authors
  // the content under the new name.
  let slugRenamed: string | null = null;
  if (newName || newType) {
    const { data: wikiPage } = await supabase
      .from("wiki_pages").select("id, slug, title, metadata").eq("entity_id", id).maybeSingle();
    if (wikiPage) {
      const effType = newType || current?.entity_type || "entity";
      const effName = newName || current?.canonical_name || wikiPage.title || "";
      const newSlug = `${effType}-${effName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}`;
      const wikiUpdate: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (newName) wikiUpdate.title = newName;
      if (newType) wikiUpdate.metadata = { ...(wikiPage.metadata as object ?? {}), entity_type: newType };
      if (newSlug !== wikiPage.slug) {
        // Collision guard: only move if no OTHER page owns the target slug.
        const { data: taken } = await supabase
          .from("wiki_pages").select("id").eq("slug", newSlug).neq("id", wikiPage.id).maybeSingle();
        if (!taken) {
          wikiUpdate.slug = newSlug;
          slugRenamed = newSlug;
        }
      }
      await supabase.from("wiki_pages").update(wikiUpdate).eq("id", wikiPage.id);
      if (slugRenamed) {
        // Re-author under the new name on the Hermes agent's next drain (dedupe-safe insert).
        await supabase.from("wiki_regen_queue").insert({
          entity_id: id, slug: slugRenamed, requested_by: "rename-guard",
          reason: `entity renamed -> ${effName} (${effType}); re-author under new slug`,
        }).then(() => {}, () => {}); // 23505 = regen already queued, fine
      }
    }
  }

  return c.json({
    id,
    ...(newName ? { canonical_name: newName } : {}),
    ...(newType ? { entity_type: newType } : {}),
    ...(slugRenamed ? { wiki_slug: slugRenamed, wiki_regen_queued: true } : {}),
  }, 200, corsHeaders);
});

// Entities — delete (wiki_pages deleted explicitly; thought_entities + edges cascade)
// Adds (entity_type, normalized_name) to entity_blocklist so the local worker
// will not recreate this entity from thoughts that mention it. Aliases on other
// entities still resolve before the blocklist check, so merges/aliases survive.
app.delete("/entities/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!id || isNaN(id)) return c.json({ error: "Valid entity id required" }, 400, corsHeaders);

  const { data: entity } = await supabase
    .from("entities").select("entity_type, normalized_name").eq("id", id).maybeSingle();

  if (entity?.entity_type && entity?.normalized_name) {
    await supabase.from("entity_blocklist")
      .upsert({
        entity_type: entity.entity_type,
        normalized_name: entity.normalized_name,
        reason: "deleted",
        blocked_at: new Date().toISOString(),
      }, { onConflict: "entity_type,normalized_name" });
  }

  // wiki_pages FK is SET NULL so it won't cascade — delete it first
  await supabase.from("wiki_pages").delete().eq("entity_id", id);

  const { error } = await supabase.from("entities").delete().eq("id", id);
  if (error) return c.json({ error: error.message }, 500, corsHeaders);

  return c.json({ deleted: true, id }, 200, corsHeaders);
});

// Entity blocklist — list all blocked names (deleted/merged sources)
app.get("/entity-blocklist", async (c) => {
  const { data, error } = await supabase
    .from("entity_blocklist")
    .select("entity_type, normalized_name, reason, blocked_at")
    .order("blocked_at", { ascending: false });
  if (error) return c.json({ error: error.message }, 500, corsHeaders);
  return c.json({ entries: data || [] }, 200, corsHeaders);
});

// Entity blocklist — unblock so the worker can re-extract this name. Use this
// if a delete was a mistake or the name now refers to a genuinely new entity.
app.delete("/entity-blocklist", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const entity_type = typeof body.entity_type === "string" ? body.entity_type.trim() : "";
  const normalized_name = typeof body.normalized_name === "string" ? body.normalized_name.trim().toLowerCase() : "";
  if (!entity_type || !normalized_name) {
    return c.json({ error: "entity_type and normalized_name (string) required" }, 400, corsHeaders);
  }
  const { error } = await supabase
    .from("entity_blocklist")
    .delete()
    .eq("entity_type", entity_type)
    .eq("normalized_name", normalized_name);
  if (error) return c.json({ error: error.message }, 500, corsHeaders);
  return c.json({ unblocked: true, entity_type, normalized_name }, 200, corsHeaders);
});

// Distinct entity_type values currently in the entities table, with a count
// and a stable color per type. Used by the dashboard + wiki constellation to
// generate filter chips dynamically — adding a new entity_type lights up a
// new chip everywhere automatically. Backed by entity_types_summary() RPC so
// counting is GROUP BY in SQL — no row cap regardless of brain size.
app.get("/entity-types", async (c) => {
  const { data, error } = await supabase.rpc("entity_types_summary");
  if (error) return c.json({ error: error.message }, 500, corsHeaders);

  const counts = new Map<string, number>();
  for (const row of (data ?? []) as { entity_type: string; count: number | string }[]) {
    counts.set(row.entity_type, Number(row.count));
  }

  // Seed palette for the historical types so existing screens don't reshuffle
  // colors. New types fall back to a deterministic hash-of-name hue.
  const seedPalette: Record<string, string> = {
    person: "#9d83ff",
    organization: "#ff9650",
    org: "#ff9650",
    project: "#6ca6ff",
    tool: "#50c8c8",
    place: "#ffd870",
    topic: "#b8a6ff",
    entity: "#a8b8d0",
    prompt: "#e070b0",  // pink — distinct from tool's teal, signals "LLM artifact" tier
  };

  function hashedHue(name: string): number {
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
    return Math.abs(h) % 360;
  }

  const types = Array.from(counts.entries())
    .map(([entity_type, count]) => {
      // Plural label to match the dashboard legend conventions
      const label =
        entity_type === "person"
          ? "people"
          : entity_type === "organization" || entity_type === "org"
          ? "orgs"
          : `${entity_type}s`;
      const color = seedPalette[entity_type]
        ?? `oklch(72% 0.14 ${hashedHue(entity_type)})`;
      return { entity_type, label, color, count };
    })
    .sort((a, b) => b.count - a.count);

  return c.json({ types }, 200, corsHeaders);
});

// Distinct source_type values from the thoughts table with counts. Backed by
// the sources_summary() Postgres RPC so the heavy lifting is GROUP BY in SQL
// (returns ~10 rows). No row cap to worry about as the brain grows.
app.get("/sources", async (c) => {
  const { data, error } = await supabase.rpc("sources_summary");
  if (error) return c.json({ error: error.message }, 500, corsHeaders);
  const sources = (data ?? []).map((r: { source_type: string; count: number | string }) => ({
    source_type: r.source_type,
    count: Number(r.count),
  }));
  return c.json({ sources }, 200, corsHeaders);
});

// Constellation — top N entities by mention count, plus co-occurrence edges
// (number of thoughts mentioning both endpoints) for the dashboard hero graph.
// Days defaults to 90 to keep the graph current; pass 0 for all-time.
//
// focus_id: when set, switches selection mode to "neighbours of this entity"
//   — the entity itself + every entity it co-occurs with (weight >=
//   min_weight), capped at limit. Lets the wiki re-centre the constellation
//   on the currently-viewed entity without being trapped inside the global
//   top-N.
//
// focus_ids: comma-separated list of entity IDs. When passed, returns the
//   UNION of every focus's neighbourhood — used by wiki search when a query
//   like "zoom" matches multiple entities (Zoom + Zoom Contact Centre + Zoom
//   Virtual Agents) and the user wants all of them shown together.
//
// excluded_types: comma-separated entity_types to drop server-side. Honours
//   the dashboard / wiki type-filter chips so toggled-off types don't eat
//   slots in the top-N.
app.get("/constellation", async (c) => {
  // Cap at 200 — well above the UI's 100 option, leaves room for future
  // expansion. The Postgres RPCs underneath have no row cap; this is just
  // a sanity ceiling against runaway client requests.
  // Cap at 5000 — the wiki view sends limit=2000 to effectively get every
  // entity (~650 in the brain). Old cap of 200 was the actual bug behind
  // "showing 200 of 200 entities" on the dashboard hero: the wiki bumped
  // its requested limit but the server silently clamped to 200.
  const limit = Math.min(5000, Math.max(5, Number(c.req.query("limit")) || 30));
  const days = c.req.query("days") === undefined ? 90 : Number(c.req.query("days"));
  const minWeight = Math.max(1, Number(c.req.query("min_weight")) || 2);
  const classification = c.req.query("classification") || null;
  const focusIdRaw = c.req.query("focus_id");
  const focusIdsRaw = c.req.query("focus_ids") || "";
  const focusId = focusIdRaw ? Number(focusIdRaw) : null;
  const focusIdsList = focusIdsRaw
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
  const excludedTypesRaw = c.req.query("excluded_types") || "";
  const excludedTypes = excludedTypesRaw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const excludedTypesArg = excludedTypes.length > 0 ? excludedTypes : null;

  // Three RPC paths depending on how the caller wants to scope the graph:
  // - focus_ids[]      → constellation_focus_neighbors_multi (union of N hoods)
  // - focus_id (single) → constellation_focus_neighbors
  // - neither           → constellation_top_entities (default top-N)
  const useMulti = focusIdsList.length > 0;
  const useSingle = !useMulti && focusId !== null && !isNaN(focusId);
  const { data: topData, error: topErr } = useMulti
    ? await supabase.rpc("constellation_focus_neighbors_multi", {
        p_focus_ids: focusIdsList,
        p_days: days,
        p_limit: limit,
        p_classification: classification,
        p_min_weight: 1,
        p_excluded_types: excludedTypesArg,
      })
    : useSingle
      ? await supabase.rpc("constellation_focus_neighbors", {
          p_focus_id: focusId,
          p_days: days,
          p_limit: limit,
          p_classification: classification,
          p_min_weight: 1,
          p_excluded_types: excludedTypesArg,
        })
      : await supabase.rpc("constellation_top_entities", {
          p_days: days,
          p_limit: limit,
          p_classification: classification,
          p_excluded_types: excludedTypesArg,
        });
  if (topErr) return c.json({ error: topErr.message }, 500, corsHeaders);

  type TopRow = { entity_id: number; canonical_name: string; entity_type: string; mentions: number | string; dominant_classification: string | null };
  const top = (topData ?? []) as TopRow[];
  const entityIds = top.map((r) => r.entity_id);

  let edgesRaw: { source: number; target: number; weight: number | string }[] = [];
  // Curated edges = both inferred (from infer-entity-edges.mjs) and manual
  // (from POST /edges/manual). Both live in `edges` with metadata.source set.
  // RPC returns inferred:boolean + edge_source:text so the dashboard can
  // distinguish render — inferred dashed, manual solid.
  let curatedEdgesRaw: { source: number; target: number; weight: number | string; relation: string; inferred: boolean; edge_source: string }[] = [];
  if (entityIds.length > 0) {
    // Co-occurrence edges (thought-derived). Existing behaviour.
    const coRes = await supabase.rpc(
      "constellation_co_occurrence",
      {
        p_entity_ids: entityIds,
        p_days: days,
        p_classification: classification,
        p_min_weight: minWeight,
      }
    );
    if (coRes.error) return c.json({ error: coRes.error.message }, 500, corsHeaders);
    edgesRaw = (coRes.data ?? []) as typeof edgesRaw;

    // Curated edges (inferred + manual). RPC name kept for backwards
    // compat even though it now returns both source types.
    const infRes = await supabase.rpc(
      "constellation_inferred_edges",
      { p_entity_ids: entityIds }
    );
    if (!infRes.error) curatedEdgesRaw = (infRes.data ?? []) as typeof curatedEdgesRaw;
  }

  // Resolve wiki slugs for the top entities so the dashboard can deep-link
  // each node directly into the wiki page.
  const slugMap = new Map<number, string>();
  if (entityIds.length > 0) {
    const { data: wikiRows } = await supabase
      .from("wiki_pages")
      .select("entity_id, slug")
      .in("entity_id", entityIds);
    for (const row of wikiRows || []) {
      if (row.entity_id) slugMap.set(row.entity_id, row.slug);
    }
  }

  const nodes = top.map((r) => ({
    id: r.entity_id,
    label: r.canonical_name,
    type: r.entity_type,
    mentions: Number(r.mentions),
    slug: slugMap.get(r.entity_id) ?? null,
    classification: r.dominant_classification ?? null,
  }));
  // Merge inferred edges in. For any pair already in the co-occurrence set,
  // we leave the co-occurrence row alone (extracted/co-occurrence > inferred).
  // For pairs that ONLY have an inferred edge, push a new edge row with
  // `inferred: true` so the dashboard can render it dashed.
  const seenPairs = new Set<string>();
  for (const e of edgesRaw) {
    const key = `${Math.min(e.source, e.target)}:${Math.max(e.source, e.target)}`;
    seenPairs.add(key);
  }
  const edges: Array<{ source: number; target: number; weight: number; inferred?: boolean; manual?: boolean; relation?: string }> = edgesRaw.map((e) => ({
    source: e.source,
    target: e.target,
    weight: Number(e.weight),
  }));
  for (const ie of curatedEdgesRaw) {
    const key = `${Math.min(ie.source, ie.target)}:${Math.max(ie.source, ie.target)}`;
    if (seenPairs.has(key)) continue;
    seenPairs.add(key);
    const isManual = ie.edge_source === "manual";
    edges.push({
      source: ie.source,
      target: ie.target,
      weight: Number(ie.weight),
      inferred: !isManual,
      manual: isManual,
      relation: ie.relation,
    });
  }

  // Strongest cluster — the heaviest edge
  const strongest = edges[0]
    ? {
        source: nodes.find((n) => n.id === edges[0].source)?.label ?? `#${edges[0].source}`,
        target: nodes.find((n) => n.id === edges[0].target)?.label ?? `#${edges[0].target}`,
        weight: edges[0].weight,
      }
    : null;

  return c.json({ nodes, edges, strongest, days }, 200, corsHeaders);
});

// ────────────────────────────────────────────────────────────────────────────
// Edges — read, delete (with auto-blocklist), and edge_blocklist management
// ────────────────────────────────────────────────────────────────────────────

// Mirrors the worker's SYMMETRIC_RELATIONS set in scripts/local-brain-worker.js.
// Symmetric relations are stored with from_entity_id < to_entity_id so a single
// row blocks/represents both directions. Keep these in sync.
const SYMMETRIC_RELATIONS = new Set([
  "co_occurs_with", "related_to", "collaborates_with", "integrates_with", "alternative_to",
]);
function normalizeEdgeKey(fromId: number, toId: number, relation: string): { from: number; to: number } {
  if (SYMMETRIC_RELATIONS.has(relation) && fromId > toId) return { from: toId, to: fromId };
  return { from: fromId, to: toId };
}

// List all edges touching an entity, with the other entity's name/type joined.
// Powers the dashboard's Edit Relationships panel.
app.get("/entities/:id/edges", async (c) => {
  const id = Number(c.req.param("id"));
  if (!id || isNaN(id)) return c.json({ error: "Valid entity id required" }, 400, corsHeaders);

  // Explicit per-side cap so we don't rely on PostgREST's default. The most
  // connected entity today has ~170 edges; 5000 leaves ~30x headroom for
  // graph growth without ever silently truncating.
  const PER_SIDE_LIMIT = 5000;
  const [outRes, inRes] = await Promise.all([
    supabase.from("edges")
      .select("id, from_entity_id, to_entity_id, relation, support_count, confidence, metadata, updated_at")
      .eq("from_entity_id", id)
      .limit(PER_SIDE_LIMIT),
    supabase.from("edges")
      .select("id, from_entity_id, to_entity_id, relation, support_count, confidence, metadata, updated_at")
      .eq("to_entity_id", id)
      .limit(PER_SIDE_LIMIT),
  ]);
  if (outRes.error) return c.json({ error: outRes.error.message }, 500, corsHeaders);
  if (inRes.error) return c.json({ error: inRes.error.message }, 500, corsHeaders);

  // De-dup symmetric edges (where this entity is on both sides via different orderings is impossible,
  // but the same edge could appear in both queries if both endpoints are this entity — guarded by the
  // edge constraint upstream)
  const seen = new Set<number>();
  const all = [...(outRes.data || []), ...(inRes.data || [])].filter((e) => {
    if (seen.has(e.id)) return false;
    seen.add(e.id);
    return true;
  });

  const otherIds = Array.from(new Set(all.flatMap((e) => [e.from_entity_id, e.to_entity_id]).filter((x) => x !== id)));
  const nameMap = new Map<number, { canonical_name: string; entity_type: string }>();
  const slugMap = new Map<number, string>();
  if (otherIds.length > 0) {
    const [{ data: ents }, { data: pages }] = await Promise.all([
      supabase
        .from("entities")
        .select("id, canonical_name, entity_type")
        .in("id", otherIds),
      supabase
        .from("wiki_pages")
        .select("entity_id, slug")
        .in("entity_id", otherIds),
    ]);
    for (const e of ents || []) nameMap.set(e.id, { canonical_name: e.canonical_name, entity_type: e.entity_type });
    for (const p of pages || []) {
      if (p.entity_id) slugMap.set(p.entity_id, p.slug);
    }
  }

  const edges = all.map((e) => {
    const otherId = e.from_entity_id === id ? e.to_entity_id : e.from_entity_id;
    const direction = e.from_entity_id === id ? "out" : "in";
    const other = nameMap.get(otherId) || { canonical_name: `#${otherId}`, entity_type: "unknown" };
    return {
      edge_id: e.id,
      id: e.id,
      from_entity_id: e.from_entity_id,
      to_entity_id: e.to_entity_id,
      relation: e.relation,
      support_count: e.support_count,
      confidence: e.confidence,
      direction,
      other_id: otherId,
      other_name: other.canonical_name,
      other_type: other.entity_type,
      other_slug: slugMap.get(otherId) ?? null,
      // Source tag from metadata: 'manual' | 'inferred' | undefined (=thought-derived).
      // Lets the edge-edit modal show a "where did this come from?" badge.
      edge_source:
        (e.metadata && typeof e.metadata === "object" && (e.metadata as { source?: string }).source) ||
        null,
      // Backwards-compat: keep the nested shape used by the existing edit panel
      other: { id: otherId, canonical_name: other.canonical_name, entity_type: other.entity_type },
      symmetric: SYMMETRIC_RELATIONS.has(e.relation),
    };
  });

  edges.sort((a, b) => (b.support_count ?? 0) - (a.support_count ?? 0));
  return c.json({ edges }, 200, corsHeaders);
});

// Thoughts that mention this entity (via thought_entities). Used by the
// constellation quick-edit modal to give a user one-click access to the
// source thoughts so they can be edited / deleted directly — after a
// thought edit + worker re-extraction, a stale entity often disappears
// because the new content no longer mentions it.
//
// Returns the entity's linked thoughts. This is also the AUTHOR ROUTINE's
// material feed (A3): the old newest-20 default recency-biased the Hermes agent's wiki
// sourcing on high-coverage entities (the one defect the 10-entity prove run
// found), so it now supports full pagination + ordering + full-content mode:
//   ?page=N&per_page=M (per_page up to 200; legacy ?limit=N still honored)
//   ?order=recent (default) | oldest (story arc) | importance (imp desc)
//   ?full=1 → full content instead of the 200-char content_preview
// Response: { thoughts, total, page, per_page } — paginate to empty/total.
app.get("/entities/:id/thoughts", async (c) => {
  const id = Number(c.req.param("id"));
  if (!id || isNaN(id)) return c.json({ error: "Valid entity id required" }, 400, corsHeaders);
  const perPage = Math.min(200, Math.max(1, Number(c.req.query("per_page") ?? c.req.query("limit")) || 20));
  const page = Math.max(1, Number(c.req.query("page")) || 1);
  const order = String(c.req.query("order") ?? "recent");
  const full = c.req.query("full") === "1" || c.req.query("full") === "true";

  const { data: links, error: linksErr } = await supabase
    .from("thought_entities")
    .select("thought_id")
    .eq("entity_id", id);
  if (linksErr) return c.json({ error: linksErr.message }, 500, corsHeaders);
  const thoughtIds = Array.from(new Set((links ?? []).map((l: { thought_id: string }) => l.thought_id)));
  if (thoughtIds.length === 0) return c.json({ thoughts: [], total: 0, page, per_page: perPage }, 200, corsHeaders);

  let q = supabase
    .from("thoughts")
    .select("id, serial_id, content, type, classification, importance, source_type, created_at")
    .in("id", thoughtIds);
  if (order === "importance") q = q.order("importance", { ascending: false, nullsFirst: false }).order("created_at", { ascending: false });
  else if (order === "oldest") q = q.order("created_at", { ascending: true });
  else q = q.order("created_at", { ascending: false });
  const from = (page - 1) * perPage;
  const { data: thoughts, error: thoughtsErr } = await q.range(from, from + perPage - 1);
  if (thoughtsErr) {
    // Past-the-end page = normal end-of-list, same convention as GET /thoughts.
    if ((thoughtsErr as any).code === "PGRST103" || /range not satisfiable/i.test(thoughtsErr.message)) {
      return c.json({ thoughts: [], total: thoughtIds.length, page, per_page: perPage, note: "page beyond end of results" }, 200, corsHeaders);
    }
    return c.json({ error: thoughtsErr.message }, 500, corsHeaders);
  }

  const rows = (thoughts ?? []).map((t: { serial_id: number; content: string; type: string; classification: string; importance: number | null; source_type: string; created_at: string }) => ({
    serial_id: t.serial_id,
    ...(full ? { content: t.content } : { content_preview: (t.content || "").slice(0, 200) }),
    type: t.type,
    classification: t.classification,
    importance: t.importance,
    source_type: t.source_type,
    created_at: t.created_at,
  }));
  return c.json({ thoughts: rows, total: thoughtIds.length, page, per_page: perPage }, 200, corsHeaders);
});

// Reflections attached to any thought that links to this entity. Used by the
// wiki page to surface lessons / decisions / retrospectives / hypotheses
// alongside the entity itself, so they don't get marooned on the single
// source thought.
app.get("/entities/:id/reflections", async (c) => {
  const id = Number(c.req.param("id"));
  if (!id || isNaN(id)) return c.json({ error: "Valid entity id required" }, 400, corsHeaders);

  // 1) Find all thought UUIDs linked to this entity
  const { data: links, error: linksErr } = await supabase
    .from("thought_entities")
    .select("thought_id")
    .eq("entity_id", id);
  if (linksErr) return c.json({ error: linksErr.message }, 500, corsHeaders);
  const thoughtIds = Array.from(new Set((links ?? []).map((l: { thought_id: string }) => l.thought_id)));
  if (thoughtIds.length === 0) return c.json({ reflections: [], by_type: {} }, 200, corsHeaders);

  // 2) Fetch reflections for those thoughts
  const { data: reflections, error: reflErr } = await supabase
    .from("reflections")
    .select("*")
    .in("thought_id", thoughtIds)
    .order("created_at", { ascending: false });
  if (reflErr) return c.json({ error: reflErr.message }, 500, corsHeaders);

  // 3) Map UUIDs back to serial_ids + a short content preview so the
  //    dashboard can render deep-links and context without a follow-up call.
  const { data: thoughts } = await supabase
    .from("thoughts")
    .select("id, serial_id, content")
    .in("id", thoughtIds);
  const thoughtMeta = new Map<string, { serial_id: number; preview: string }>();
  for (const t of thoughts ?? []) {
    thoughtMeta.set(t.id, {
      serial_id: t.serial_id,
      preview: String(t.content ?? "").replace(/\s+/g, " ").slice(0, 160),
    });
  }

  const enriched = (reflections ?? []).map((r: Record<string, unknown>) => ({
    ...r,
    source_thought_serial: thoughtMeta.get(r.thought_id as string)?.serial_id ?? null,
    source_thought_preview: thoughtMeta.get(r.thought_id as string)?.preview ?? "",
  }));

  // 4) Group by reflection_type for the dashboard's grouped rendering
  const byType: Record<string, typeof enriched> = {};
  for (const r of enriched) {
    const t = String(r.reflection_type ?? "general");
    (byType[t] ??= []).push(r);
  }

  return c.json({ reflections: enriched, by_type: byType }, 200, corsHeaders);
});

// Create a manual edge between two entities. Different from
// thought-derived edges (which come from the worker reading a thought) and
// from inferred edges (cross-thought LLM inference): this is the user
// asserting a relationship directly. Highest trust tier.
//
// Body: { from_entity_id, to_entity_id, relation, confidence? }
// Writes to `edges` with metadata.source='manual'. Does NOT go through
// `thought_entity_edges` — there's no backing thought. The trigger that
// maintains support_count from thought_entity_edges doesn't fire, so the
// manual support_count stays at whatever we set (1) until the worker happens
// to also extract the same pair+relation from a real thought, at which
// point the trigger upserts and the metadata stays as 'manual'.
//
// If the pair+relation already has a row in `edges`, return existed:true
// without writing — manual add over an existing edge is a no-op.
// If the pair+relation is in `edge_blocklist`, return blocked:true with 409;
// caller can prompt the user to unblock first.
const MANUAL_EDGE_RELATIONS = new Set([
  "works_on", "uses", "uses_tool", "collaborates_with", "integrates_with",
  "alternative_to", "evaluates", "member_of", "located_in", "related_to",
  "published_by", "references",
  "knew", "friend_of", "family_of", "mentor_of", "introduced_via",
  "lives_in", "is_part_of",
  "relevant_to", // "suggested reading" newsletter→project (see ENTITY_EDGE_RELATIONS)
]);

app.post("/edges/manual", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const fromIdRaw = Number(body.from_entity_id);
  const toIdRaw = Number(body.to_entity_id);
  const relation = typeof body.relation === "string" ? body.relation.trim().toLowerCase() : "";
  const confidence = Number(body.confidence ?? 0.95);

  if (!fromIdRaw || !toIdRaw || isNaN(fromIdRaw) || isNaN(toIdRaw) || fromIdRaw === toIdRaw) {
    return c.json({ error: "from_entity_id and to_entity_id required (distinct integers)" }, 400, corsHeaders);
  }
  if (!relation || !MANUAL_EDGE_RELATIONS.has(relation)) {
    return c.json({
      error: `relation must be one of: ${[...MANUAL_EDGE_RELATIONS].join(", ")}`,
    }, 400, corsHeaders);
  }
  const { from, to } = normalizeEdgeKey(fromIdRaw, toIdRaw, relation);

  // Blocklist check — if the user previously removed this edge, refuse to
  // re-add silently. The dashboard prompts them to unblock first.
  const { data: blocked } = await supabase
    .from("edge_blocklist")
    .select("relation, reason")
    .eq("from_entity_id", from)
    .eq("to_entity_id", to)
    .eq("relation", relation)
    .maybeSingle();
  if (blocked) {
    return c.json({
      blocked: true,
      reason: blocked.reason,
      message: "This edge is in edge_blocklist (previously removed). Unblock it before re-adding.",
    }, 409, corsHeaders);
  }

  // Existing-edge check (any direction for symmetric).
  const { data: existing } = await supabase
    .from("edges")
    .select("id, support_count, confidence, metadata")
    .eq("from_entity_id", from)
    .eq("to_entity_id", to)
    .eq("relation", relation)
    .maybeSingle();
  if (existing) {
    return c.json({
      existed: true,
      edge_id: existing.id,
      from_entity_id: from,
      to_entity_id: to,
      relation,
      message: "Edge already exists. Manual add is a no-op.",
    }, 200, corsHeaders);
  }

  const { data: inserted, error: insErr } = await supabase
    .from("edges")
    .insert({
      from_entity_id: from,
      to_entity_id: to,
      relation,
      support_count: 1,
      confidence: Math.max(0, Math.min(1, isNaN(confidence) ? 0.95 : confidence)),
      metadata: {
        source: "manual",
        added_at: new Date().toISOString(),
        added_via: "POST /edges/manual",
      },
    })
    .select("id")
    .maybeSingle();
  if (insErr) return c.json({ error: insErr.message }, 500, corsHeaders);

  // Requeue thoughts so both endpoints' wiki articles regenerate with the
  // new relationship in their Relationships section.
  for (const entityId of [from, to]) {
    const { data: link } = await supabase
      .from("thought_entities")
      .select("thought_id")
      .eq("entity_id", entityId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (link?.thought_id) {
      await supabase.from("entity_extraction_queue").upsert({
        thought_id: link.thought_id,
        status: "pending",
        attempt_count: 0,
        last_error: null,
        queued_at: new Date().toISOString(),
      }, { onConflict: "thought_id" });
    }
  }

  return c.json({
    created: true,
    edge_id: inserted?.id ?? null,
    from_entity_id: from,
    to_entity_id: to,
    relation,
    source: "manual",
    requeued: true,
  }, 200, corsHeaders);
});

// Delete an edge AND add it to edge_blocklist so the worker won't recreate it.
// This is the "✕ remove" action from the Edit Relationships panel.
// Body: { from_entity_id, to_entity_id, relation }
app.delete("/edges", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const fromIdRaw = Number(body.from_entity_id);
  const toIdRaw = Number(body.to_entity_id);
  const relation = typeof body.relation === "string" ? body.relation.trim() : "";
  if (!fromIdRaw || !toIdRaw || !relation || isNaN(fromIdRaw) || isNaN(toIdRaw)) {
    return c.json({ error: "from_entity_id, to_entity_id, relation required" }, 400, corsHeaders);
  }
  const { from, to } = normalizeEdgeKey(fromIdRaw, toIdRaw, relation);

  await supabase.from("edge_blocklist").upsert({
    from_entity_id: from,
    to_entity_id: to,
    relation,
    reason: "user_removed",
    blocked_at: new Date().toISOString(),
  }, { onConflict: "from_entity_id,to_entity_id,relation" });

  // Layer 2: clear provenance rows. The trigger on thought_entity_edges DELETE
  // will recompute support_count to 0 and delete the edges row (unless an
  // endpoint is pinned, in which case the edges row is kept at support=0 —
  // that's intentional, but the explicit delete below ensures it's gone for
  // user-removed edges since the user clearly doesn't want it.
  await supabase.from("thought_entity_edges").delete()
    .eq("from_entity_id", from)
    .eq("to_entity_id", to)
    .eq("relation", relation);

  const { error } = await supabase.from("edges").delete()
    .eq("from_entity_id", from)
    .eq("to_entity_id", to)
    .eq("relation", relation);
  if (error) return c.json({ error: error.message }, 500, corsHeaders);

  // Re-queue one thought from each affected entity so the local worker spawns
  // wiki regeneration. Without this, the article markdown stays stale — the
  // edges table is live and accurate, but the cached wiki content still shows
  // the deleted relation until something triggers a recompile.
  for (const entityId of [from, to]) {
    const { data: link } = await supabase
      .from("thought_entities")
      .select("thought_id")
      .eq("entity_id", entityId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (link?.thought_id) {
      await supabase.from("entity_extraction_queue").upsert({
        thought_id: link.thought_id,
        status: "pending",
        attempt_count: 0,
        last_error: null,
        queued_at: new Date().toISOString(),
      }, { onConflict: "thought_id" });
    }
  }

  return c.json({ deleted: true, blocklisted: true, from_entity_id: from, to_entity_id: to, relation, requeued: true }, 200, corsHeaders);
});

// Recent edge_blocklist entries touching this entity. Used by the Edges
// modal to detect a "panic delete" session — a burst of removals in a
// short window — and offer a one-click undo. Defaults to 5 minutes which
// catches a single-session click-storm without sweeping up legitimate
// older edits.
app.get("/entities/:id/recent-blocks", async (c) => {
  const id = Number(c.req.param("id"));
  if (!id || isNaN(id)) return c.json({ error: "Valid entity id required" }, 400, corsHeaders);
  const minutes = Math.max(1, Math.min(720, Number(c.req.query("minutes")) || 5));
  const cutoff = new Date(Date.now() - minutes * 60_000).toISOString();

  const { data, error } = await supabase
    .from("edge_blocklist")
    .select("from_entity_id, to_entity_id, relation, reason, blocked_at")
    .gte("blocked_at", cutoff)
    .or(`from_entity_id.eq.${id},to_entity_id.eq.${id}`)
    .order("blocked_at", { ascending: false });
  if (error) return c.json({ error: error.message }, 500, corsHeaders);

  // Resolve other-entity names so the UI can render readable previews.
  const otherIds = Array.from(
    new Set((data || []).map((r) => (r.from_entity_id === id ? r.to_entity_id : r.from_entity_id)))
  );
  const nameMap = new Map<number, string>();
  if (otherIds.length > 0) {
    const { data: ents } = await supabase
      .from("entities")
      .select("id, canonical_name")
      .in("id", otherIds);
    for (const e of ents || []) nameMap.set(e.id, e.canonical_name);
  }
  const entries = (data || []).map((r) => ({
    ...r,
    other_name: nameMap.get(r.from_entity_id === id ? r.to_entity_id : r.from_entity_id) ??
      `#${r.from_entity_id === id ? r.to_entity_id : r.from_entity_id}`,
  }));
  return c.json({ entries, count: entries.length, minutes }, 200, corsHeaders);
});

// Undo recent blocklist deletions on an entity. Deletes the blocklist rows
// touching this entity within the last `minutes`, then re-queues every
// thought linked to this entity so the worker re-extracts the previously-
// deleted relationships. Round-trip is ~30-60s after the worker picks it
// up. Used by the Edges modal's "Undo last session" button.
app.post("/entities/:id/undo-recent-blocks", async (c) => {
  const id = Number(c.req.param("id"));
  if (!id || isNaN(id)) return c.json({ error: "Valid entity id required" }, 400, corsHeaders);
  const minutes = Math.max(1, Math.min(720, Number(c.req.query("minutes")) || 5));
  const cutoff = new Date(Date.now() - minutes * 60_000).toISOString();

  // Step 1: find the recent blocklist entries touching this entity
  const { data: doomed, error: findErr } = await supabase
    .from("edge_blocklist")
    .select("from_entity_id, to_entity_id, relation")
    .gte("blocked_at", cutoff)
    .or(`from_entity_id.eq.${id},to_entity_id.eq.${id}`);
  if (findErr) return c.json({ error: findErr.message }, 500, corsHeaders);
  if (!doomed || doomed.length === 0) {
    return c.json({ ok: true, restored: 0, requeued: 0, message: "Nothing to undo in this window." }, 200, corsHeaders);
  }

  // Step 2: delete the blocklist entries one at a time (composite key)
  let removed = 0;
  for (const b of doomed) {
    const { error } = await supabase
      .from("edge_blocklist")
      .delete()
      .eq("from_entity_id", b.from_entity_id)
      .eq("to_entity_id", b.to_entity_id)
      .eq("relation", b.relation);
    if (error) return c.json({ error: error.message, partial_removed: removed }, 500, corsHeaders);
    removed++;
  }

  // Step 3: re-queue every thought linked to this entity so the worker
  // re-extracts the relationships that were just unblocked. We can't be
  // surgical about which specific thoughts produced which edges, so we
  // re-queue them all and let the worker rebuild.
  const { data: links } = await supabase
    .from("thought_entities")
    .select("thought_id")
    .eq("entity_id", id);
  const thoughtIds = Array.from(new Set((links || []).map((l) => l.thought_id)));
  let requeued = 0;
  for (let i = 0; i < thoughtIds.length; i += 100) {
    const batch = thoughtIds.slice(i, i + 100);
    const { error: qErr } = await supabase.from("entity_extraction_queue").upsert(
      batch.map((tid) => ({
        thought_id: tid,
        status: "pending",
        started_at: null,
        processed_at: null,
        last_error: null,
        queued_at: new Date().toISOString(),
      })),
      { onConflict: "thought_id" }
    );
    if (qErr) return c.json({ error: qErr.message, partial_requeued: requeued, restored: removed }, 500, corsHeaders);
    requeued += batch.length;
  }

  return c.json({
    ok: true,
    restored: removed,
    requeued,
    minutes,
    message: `Cleared ${removed} blocklist entries and re-queued ${requeued} thoughts. Worker will rebuild edges in ~30-60s once it picks up the queue.`,
  }, 200, corsHeaders);
});

// List all blocked edges with entity names joined for display.
app.get("/edge-blocklist", async (c) => {
  const { data, error } = await supabase
    .from("edge_blocklist")
    .select("from_entity_id, to_entity_id, relation, reason, blocked_at")
    .order("blocked_at", { ascending: false });
  if (error) return c.json({ error: error.message }, 500, corsHeaders);

  const ids = Array.from(new Set((data || []).flatMap((r: any) => [r.from_entity_id, r.to_entity_id])));
  const nameMap = new Map<number, string>();
  if (ids.length > 0) {
    const { data: ents } = await supabase.from("entities").select("id, canonical_name").in("id", ids);
    for (const e of ents || []) nameMap.set(e.id, e.canonical_name);
  }
  const entries = (data || []).map((r: any) => ({
    ...r,
    from_name: nameMap.get(r.from_entity_id) ?? `#${r.from_entity_id}`,
    to_name: nameMap.get(r.to_entity_id) ?? `#${r.to_entity_id}`,
  }));
  return c.json({ entries }, 200, corsHeaders);
});

// Unblock an edge so the worker can recreate it from extraction.
// Body: { from_entity_id, to_entity_id, relation }
app.delete("/edge-blocklist", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const fromIdRaw = Number(body.from_entity_id);
  const toIdRaw = Number(body.to_entity_id);
  const relation = typeof body.relation === "string" ? body.relation.trim() : "";
  if (!fromIdRaw || !toIdRaw || !relation || isNaN(fromIdRaw) || isNaN(toIdRaw)) {
    return c.json({ error: "from_entity_id, to_entity_id, relation required" }, 400, corsHeaders);
  }
  const { from, to } = normalizeEdgeKey(fromIdRaw, toIdRaw, relation);
  const { error } = await supabase.from("edge_blocklist").delete()
    .eq("from_entity_id", from)
    .eq("to_entity_id", to)
    .eq("relation", relation);
  if (error) return c.json({ error: error.message }, 500, corsHeaders);
  return c.json({ unblocked: true, from_entity_id: from, to_entity_id: to, relation }, 200, corsHeaders);
});

// Wiki pages — update curator notes only (never overwritten by auto-regeneration)
app.patch("/wiki-pages/:slug/notes", async (c) => {
  const slug = c.req.param("slug");
  const body = await c.req.json();
  if (typeof body.notes !== "string") {
    return c.json({ error: "notes (string) is required" }, 400, corsHeaders);
  }
  const notesText = body.notes.trim();
  // Pull entity_id at the same time so we can enqueue a regen straight after
  // the update — the user expectation is that saving a curator note feeds
  // immediately into a rebuild, not on the next manual Regenerate click.
  const { data, error } = await supabase
    .from("wiki_pages")
    .update({ notes: body.notes || null, updated_at: new Date().toISOString() })
    .eq("slug", slug)
    .select("id, slug, entity_id")
    .maybeSingle();
  if (error) return c.json({ error: error.message }, 500, corsHeaders);
  if (!data) return c.json({ error: "Not found" }, 404, corsHeaders);

  // Curator-note → synthetic thought flow. The note text contains new
  // entities/relationships (Rowan, Lead Allocation Automation, …) that don't
  // exist anywhere in the user's captured thoughts. Without a thought, the
  // entity-extraction worker has nothing to read those names FROM — the wiki
  // compiler only writes prose, it doesn't touch the entities/edges tables.
  //
  // Solution: keep ONE synthetic thought per entity's curator note. Its
  // content is the note text prefixed with the host entity's name so the
  // worker has full context. metadata.curator_note_for_entity_id ties it
  // back to the host. source_type='curator_note' lets the wiki compiler
  // exclude it from evidence summaries (it's already in the notes column).
  //
  //   - Empty notes → delete the synthetic thought entirely (FK cascade
  //     clears thought_entities + thought_entity_edges; trigger recomputes
  //     edges.support_count and removes any orphaned inferences).
  //   - Non-empty notes → upsert the synthetic thought, then enqueue it
  //     for entity extraction. Worker runs, creates new entities, writes
  //     edges, marks the host entity dirty, wiki compiler runs.
  //
  // This replaces the old "queue the entity's most recent existing thought"
  // path — that approach never let new names in the note become entities.
  let regenStatus: "queued" | "no_entity" | "no_thoughts" | "cleared" | "failed" = "no_entity";
  let regenThoughtId: string | null = null;
  if (data.entity_id) {
    // Find any existing synthetic thought for this entity.
    const { data: existing } = await supabase
      .from("thoughts")
      .select("id")
      .eq("source_type", "curator_note")
      .filter("metadata->>curator_note_for_entity_id", "eq", String(data.entity_id))
      .maybeSingle();

    if (notesText.length === 0) {
      // Note cleared — delete the synthetic thought and re-queue any
      // remaining real thoughts so the article rebuilds without the note.
      if (existing?.id) {
        await supabase.from("thoughts").delete().eq("id", existing.id);
        // Also requeue a real thought to trigger a regen pass without
        // the now-deleted synthetic contributing.
        const { data: realLink } = await supabase
          .from("thought_entities")
          .select("thought_id, thoughts(id, created_at)")
          .eq("entity_id", data.entity_id)
          .order("thoughts(created_at)", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (realLink?.thought_id) {
          await supabase.from("entity_extraction_queue").upsert(
            {
              thought_id: realLink.thought_id,
              status: "pending",
              last_error: null,
              started_at: null,
              processed_at: null,
              queued_at: new Date().toISOString(),
            },
            { onConflict: "thought_id" }
          );
          regenThoughtId = realLink.thought_id;
        }
      }
      regenStatus = "cleared";
    } else {
      // Build the synthetic thought content. Prefixing with the host
      // entity's canonical name ensures the worker extracts the host as
      // a participant (so thought_entities + edges reach the host).
      const { data: ent } = await supabase
        .from("entities")
        .select("canonical_name, entity_type")
        .eq("id", data.entity_id)
        .maybeSingle();
      const hostName = ent?.canonical_name ?? `Entity #${data.entity_id}`;
      const synthContent = `Curator note for ${hostName}: ${notesText}`;

      let thoughtId: string | null = existing?.id ?? null;
      if (thoughtId) {
        await supabase
          .from("thoughts")
          .update({
            content: synthContent,
            updated_at: new Date().toISOString(),
          })
          .eq("id", thoughtId);
      } else {
        const { data: ins, error: insErr } = await supabase
          .from("thoughts")
          .insert({
            content: synthContent,
            source_type: "curator_note",
            type: "note",
            importance: 3,
            quality_score: 60,
            metadata: {
              curator_note_for_entity_id: data.entity_id,
              generated_by: "curator_note_save",
              host_entity_name: hostName,
              host_entity_type: ent?.entity_type ?? null,
            },
          })
          .select("id")
          .maybeSingle();
        if (insErr) {
          regenStatus = "failed";
        } else {
          thoughtId = ins?.id ?? null;
        }
      }

      if (thoughtId) {
        const { error: queueErr } = await supabase
          .from("entity_extraction_queue")
          .upsert(
            {
              thought_id: thoughtId,
              status: "pending",
              last_error: null,
              started_at: null,
              processed_at: null,
              queued_at: new Date().toISOString(),
            },
            { onConflict: "thought_id" }
          );
        regenStatus = queueErr ? "failed" : "queued";
        regenThoughtId = thoughtId;
      } else if (regenStatus !== "failed") {
        regenStatus = "no_thoughts";
      }
    }
  }

  return c.json(
    {
      slug: data.slug,
      action: "notes_updated",
      regen_status: regenStatus,
      regen_thought_id: regenThoughtId,
      message:
        regenStatus === "queued"
          ? "Notes saved. Curator-note thought queued for extraction — new entities/edges from the note will appear within ~60s, wiki article rebuilds straight after."
          : regenStatus === "cleared"
            ? "Notes cleared. Synthetic curator-note thought removed; wiki will rebuild without it."
            : regenStatus === "no_thoughts"
              ? "Notes saved. Couldn't create synthetic thought — wiki will not auto-regen."
              : regenStatus === "no_entity"
                ? "Notes saved. Legacy topic page has no linked entity — wiki will not auto-regen."
                : "Notes saved but synthetic-thought extraction failed — click Regenerate to retry.",
    },
    200,
    corsHeaders
  );
});

// Wiki pages — single page with full content
app.get("/wiki-pages/:slug", async (c) => {
  const slug = c.req.param("slug");
  const { data, error } = await supabase
    .from("wiki_pages")
    .select("*")
    .eq("slug", slug)
    .maybeSingle();
  if (error) return c.json({ error: error.message }, 500, corsHeaders);
  if (!data) return c.json({ error: "Not found" }, 404, corsHeaders);
  return c.json(data, 200, corsHeaders);
});

// Validate wiki markdown against the dashboard's WikiGraphView parser contract
// (see .claude/a3-wiki-migration/dashboard-read-contract.md). Returns hard
// errors (reject) + non-fatal warnings (the Hermes agent can self-correct). The dashboard
// keeps only the LAST `# H1`/`## TLDR` when there are multiples, skips a
// `## Relationships` prose section (relationships render from live edges), and
// treats preamble-before-first-H2 as TLDR.
function validateWikiContent(content: string): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const h1Count = (content.match(/^#\s+.+$/gm) || []).length;
  const h2s = [...content.matchAll(/^##\s+(.+)$/gm)].map((m) => m[1].trim());
  const tldrCount = h2s.filter((h) => /^tl;?dr\b/i.test(h)).length;
  const firstH2 = content.search(/^##\s+/m);
  const preamble = (firstH2 >= 0 ? content.slice(0, firstH2) : content).replace(/^#\s+.+$/m, "").trim();
  const resolvableTldr = tldrCount > 0 || preamble.length > 0;

  if (!resolvableTldr) errors.push("no `## TLDR` section and no preamble before the first `##` — the dashboard TLDR slot would be empty");
  if (h1Count > 1) warnings.push(`content has ${h1Count} \`# H1\` headings — the dashboard keeps ONLY the last draft; emit exactly one`);
  if (tldrCount > 1) warnings.push(`content has ${tldrCount} \`## TLDR\` sections — dashboard keeps only the last; emit one`);
  if (h2s.some((h) => /relationship/i.test(h))) warnings.push("a `## Relationships` prose section is present — the dashboard SKIPS it (relationships render from live graph edges); move relationships to edges");
  if (/^##\s+(detailed|story|about)\b/im.test(content) && !/\[#?\d+/.test(content)) warnings.push("Detailed section has no `[#serial_id]` citations — dashboard renders citation chips from these");
  return { errors, warnings };
}

// Wiki pages — UPSERT content (the Hermes agent-as-author + manual edits). Validates the
// dashboard shape; creates the page if the slug doesn't exist (requires
// entity_id + title on create). Sets manually_edited=true.
// Snapshot-first wiki-page delete — for orphan/artifact pages that have no
// entity to route DELETE /entities/:id through. Returns the full deleted row.
app.delete("/wiki-pages/:slug", async (c) => {
  const slug = c.req.param("slug");
  const { data: row } = await supabase.from("wiki_pages").select("*").eq("slug", slug).maybeSingle();
  if (!row) return c.json({ error: "wiki page not found" }, 404, corsHeaders);
  const { error } = await supabase.from("wiki_pages").delete().eq("slug", slug);
  if (error) return c.json({ error: error.message }, 500, corsHeaders);
  return c.json({ status: "deleted", snapshot: row }, 200, corsHeaders);
});

app.put("/wiki-pages/:slug", async (c) => {
  const slug = c.req.param("slug");
  const body = await c.req.json().catch(() => ({}));
  if (typeof body.content !== "string" || !body.content.trim()) {
    return c.json({ error: "content (string) is required" }, 400, corsHeaders);
  }
  const { errors, warnings } = validateWikiContent(body.content);
  if (errors.length) return c.json({ error: "content failed dashboard-shape validation", errors, warnings }, 400, corsHeaders);

  const { data: existing } = await supabase
    .from("wiki_pages").select("id, slug, entity_id").eq("slug", slug).maybeSingle();

  const now = new Date().toISOString();
  const fields: Record<string, unknown> = {
    content: body.content,
    manually_edited: true,
    updated_at: now,
    generated_at: now,
  };
  if (typeof body.notes === "string") fields.notes = body.notes;
  if (typeof body.title === "string") fields.title = body.title;
  if (body.entity_id != null) fields.entity_id = body.entity_id;
  if (Number.isFinite(body.thought_count)) fields.thought_count = body.thought_count;
  if (body.metadata && typeof body.metadata === "object") fields.metadata = body.metadata;

  // Supersede sweep (the operator's rename rule): once this slug is written for an
  // entity, any OTHER page rows for the same entity under different slugs are
  // stale rename-orphans — delete them so it's always one page per entity.
  const supersede = async (entityId: number | null, keepSlug: string): Promise<string[]> => {
    if (entityId == null) return [];
    const { data: others } = await supabase
      .from("wiki_pages").select("slug").eq("entity_id", entityId).neq("slug", keepSlug);
    const slugs = (others ?? []).map((o: { slug: string }) => o.slug);
    if (slugs.length) await supabase.from("wiki_pages").delete().eq("entity_id", entityId).neq("slug", keepSlug);
    return slugs;
  };

  if (existing) {
    const { data, error } = await supabase
      .from("wiki_pages").update(fields).eq("slug", slug).select("id, slug").maybeSingle();
    if (error) return c.json({ error: error.message, warnings }, 500, corsHeaders);
    const superseded = await supersede((body.entity_id ?? existing.entity_id) as number | null, slug);
    return c.json({ slug: data?.slug ?? slug, action: "updated", warnings, ...(superseded.length ? { superseded } : {}) }, 200, corsHeaders);
  }

  // Create path — needs entity_id + title so the dashboard can link + render.
  if (body.entity_id == null || typeof body.title !== "string" || !body.title.trim()) {
    return c.json({ error: "creating a new wiki page requires entity_id and title", warnings }, 400, corsHeaders);
  }
  const { data, error } = await supabase
    .from("wiki_pages")
    .insert({ slug, type: "entity", ...fields })
    .select("id, slug").maybeSingle();
  if (error) return c.json({ error: error.message, warnings }, 500, corsHeaders);
  const superseded = await supersede(body.entity_id as number, slug);
  return c.json({ slug: data?.slug ?? slug, action: "created", warnings, ...(superseded.length ? { superseded } : {}) }, 201, corsHeaders);
});

// On-demand wiki regen (A3: The Hermes agent-as-author). The old path re-queued a thought
// for the WORKER to recompile the page on drain; the worker's wiki step is
// gated off now. A regen request is queue-work for the Hermes agent: insert a
// wiki_regen_queue row that his drain claims like anything else. One active
// request per entity (partial unique index dedupes button-mashing).
app.post("/wiki-pages/:slug/regen", async (c) => {
  const slug = c.req.param("slug");
  const body = await c.req.json().catch(() => ({}));

  const { data: page, error: pageErr } = await supabase
    .from("wiki_pages")
    .select("id, slug, entity_id")
    .eq("slug", slug)
    .maybeSingle();
  if (pageErr) return c.json({ error: pageErr.message }, 500, corsHeaders);
  if (!page) return c.json({ error: "Wiki page not found" }, 404, corsHeaders);
  if (!page.entity_id) {
    return c.json({ error: "Wiki page has no linked entity (legacy topic page) — cannot regen" }, 400, corsHeaders);
  }

  const { data: row, error: insErr } = await supabase
    .from("wiki_regen_queue")
    .insert({
      entity_id: page.entity_id,
      slug,
      requested_by: typeof body.requested_by === "string" ? body.requested_by : "dashboard",
      reason: typeof body.reason === "string" ? body.reason : "manual regen request",
    })
    .select("id, status")
    .maybeSingle();
  if (insErr) {
    // 23505 on the partial unique index = an active request already exists.
    if ((insErr as any).code === "23505") {
      return c.json({ ok: true, slug, entity_id: page.entity_id, message: "Regen already queued for this entity." }, 200, corsHeaders);
    }
    return c.json({ error: insErr.message }, 500, corsHeaders);
  }
  return c.json({
    ok: true,
    slug,
    entity_id: page.entity_id,
    regen_id: row?.id,
    message: "Queued for regeneration — the Hermes agent authors it on his next drain pass.",
  }, 200, corsHeaders);
});

// wiki_regen_queue consumer surface (same semantics as /extraction-queue).
app.get("/wiki-regen-queue", async (c) => {
  const status = c.req.query("status") ?? "pending";
  const limit = Math.min(100, Math.max(1, Number(c.req.query("limit") ?? 20)));
  const { count, error: cErr } = await supabase
    .from("wiki_regen_queue").select("*", { count: "exact", head: true }).eq("status", status);
  if (cErr) return c.json({ error: cErr.message }, 500, corsHeaders);
  const { data, error } = await supabase
    .from("wiki_regen_queue").select("*").eq("status", status)
    .order("queued_at", { ascending: true }).limit(limit);
  if (error) return c.json({ error: error.message }, 500, corsHeaders);
  return c.json({ status, total: count ?? 0, rows: data ?? [] }, 200, corsHeaders);
});

app.post("/wiki-regen-queue/claim", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const claimedBy = typeof body.claimed_by === "string" && body.claimed_by.trim() ? body.claimed_by.trim() : null;
  if (!claimedBy) return c.json({ error: "claimed_by (string) is required" }, 400, corsHeaders);
  const { data, error } = await supabase.rpc("claim_wiki_regen_batch", {
    p_claimed_by: claimedBy,
    p_limit: Math.min(20, Math.max(1, Number(body.limit ?? 1))),
    p_lease_minutes: Math.min(120, Math.max(1, Number(body.lease_minutes ?? 15))),
    p_max_attempts: Math.min(10, Math.max(1, Number(body.max_attempts ?? 3))),
  });
  if (error) return c.json({ error: error.message }, 500, corsHeaders);
  return c.json(data, 200, corsHeaders);
});

app.post("/wiki-regen-queue/:id/complete", async (c) => {
  const id = Number(c.req.param("id"));
  if (!id || isNaN(id)) return c.json({ error: "valid queue row id required" }, 400, corsHeaders);
  const { data, error } = await supabase
    .from("wiki_regen_queue")
    .update({ status: "complete", processed_at: new Date().toISOString(), lease_expires_at: null })
    .eq("id", id).select("id, status, entity_id").maybeSingle();
  if (error) return c.json({ error: error.message }, 500, corsHeaders);
  if (!data) return c.json({ error: "no such regen request" }, 404, corsHeaders);
  return c.json({ ok: true, ...data }, 200, corsHeaders);
});

app.post("/wiki-regen-queue/:id/fail", async (c) => {
  const id = Number(c.req.param("id"));
  if (!id || isNaN(id)) return c.json({ error: "valid queue row id required" }, 400, corsHeaders);
  const body = await c.req.json().catch(() => ({}));
  const maxAttempts = Math.min(10, Math.max(1, Number(body.max_attempts ?? 3)));
  const { data: row } = await supabase.from("wiki_regen_queue").select("attempt_count").eq("id", id).maybeSingle();
  if (!row) return c.json({ error: "no such regen request" }, 404, corsHeaders);
  const attempts = (row.attempt_count ?? 0) + 1;
  const status = attempts >= maxAttempts ? "failed" : "pending";
  const { error } = await supabase.from("wiki_regen_queue")
    .update({ status, attempt_count: attempts, last_error: String(body.error ?? "consumer reported failure").slice(0, 500), claimed_by: null, lease_expires_at: null })
    .eq("id", id);
  if (error) return c.json({ error: error.message }, 500, corsHeaders);
  return c.json({ ok: true, status, attempt_count: attempts, requeued: status === "pending" }, 200, corsHeaders);
});

// curation_queue consumer surface (GK T8) — direct-write curation for the Hermes agent.
// A trigger enqueues live-on-arrival thoughts (external GPT writes, bare
// /capture) that skipped the pending-review gate; the Hermes agent drains here, curates
// each (type/status/classification/action_items via PUT /thought/:id), then
// marks complete. Same consumer semantics as wiki-regen-queue. The Hermes agent's drainer
// must yield to his live conversation (idle-guard is runner-side, not here).
app.get("/curation-queue", async (c) => {
  const status = c.req.query("status") ?? "pending";
  const limit = Math.min(100, Math.max(1, Number(c.req.query("limit") ?? 20)));
  const { count, error: cErr } = await supabase
    .from("curation_queue").select("*", { count: "exact", head: true }).eq("status", status);
  if (cErr) return c.json({ error: cErr.message }, 500, corsHeaders);
  const { data, error } = await supabase
    .from("curation_queue").select("*").eq("status", status)
    .order("queued_at", { ascending: true }).limit(limit);
  if (error) return c.json({ error: error.message }, 500, corsHeaders);
  return c.json({ status, total: count ?? 0, rows: data ?? [] }, 200, corsHeaders);
});

app.post("/curation-queue/claim", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const claimedBy = typeof body.claimed_by === "string" && body.claimed_by.trim() ? body.claimed_by.trim() : null;
  if (!claimedBy) return c.json({ error: "claimed_by (string) is required" }, 400, corsHeaders);
  const { data, error } = await supabase.rpc("claim_curation_batch", {
    p_claimed_by: claimedBy,
    p_limit: Math.min(20, Math.max(1, Number(body.limit ?? 1))),
    p_lease_minutes: Math.min(120, Math.max(1, Number(body.lease_minutes ?? 15))),
    p_max_attempts: Math.min(10, Math.max(1, Number(body.max_attempts ?? 3))),
  });
  if (error) return c.json({ error: error.message }, 500, corsHeaders);
  return c.json(data, 200, corsHeaders);
});

app.post("/curation-queue/:id/complete", async (c) => {
  const id = Number(c.req.param("id"));
  if (!id || isNaN(id)) return c.json({ error: "valid queue row id required" }, 400, corsHeaders);
  const { data, error } = await supabase
    .from("curation_queue")
    .update({ status: "complete", processed_at: new Date().toISOString(), lease_expires_at: null })
    .eq("id", id).select("id, status, thought_id").maybeSingle();
  if (error) return c.json({ error: error.message }, 500, corsHeaders);
  if (!data) return c.json({ error: "no such curation request" }, 404, corsHeaders);
  return c.json({ ok: true, ...data }, 200, corsHeaders);
});

app.post("/curation-queue/:id/fail", async (c) => {
  const id = Number(c.req.param("id"));
  if (!id || isNaN(id)) return c.json({ error: "valid queue row id required" }, 400, corsHeaders);
  const body = await c.req.json().catch(() => ({}));
  const maxAttempts = Math.min(10, Math.max(1, Number(body.max_attempts ?? 3)));
  const { data: row } = await supabase.from("curation_queue").select("attempt_count").eq("id", id).maybeSingle();
  if (!row) return c.json({ error: "no such curation request" }, 404, corsHeaders);
  const attempts = (row.attempt_count ?? 0) + 1;
  const status = attempts >= maxAttempts ? "failed" : "pending";
  const { error } = await supabase.from("curation_queue")
    .update({ status, attempt_count: attempts, last_error: String(body.error ?? "consumer reported failure").slice(0, 500), claimed_by: null, lease_expires_at: null })
    .eq("id", id);
  if (error) return c.json({ error: error.message }, 500, corsHeaders);
  return c.json({ ok: true, status, attempt_count: attempts, requeued: status === "pending" }, 200, corsHeaders);
});

// Context brief — the shared session-start briefing, mirroring the MCP
// get_context_brief query exactly so REST callers (the Hermes agent, all AI clients) and
// MCP callers read ONE source of truth instead of two that drift. Returns
// structured JSON (not the MCP's markdown) so programmatic callers can shape
// their own output. scope filters on metadata->>classification.
// NOTE (2026-07-05, WSL Part-2 finding): active/planning kanban status is NOT
// written by any ingestion path — every /capture, /capture-pending and approve
// insert sets status=null. The ONLY writer of active/planning on thoughts is
// the dashboard kanban drag (app/api/kanban/update). So scope=personal returns
// few/no kanban items until either (a) personal items get captured as
// type=task/idea, or (b) a promotion rule is added. This endpoint reports the
// truth; it does not invent it.
app.get("/context-brief", async (c) => {
  const scopeRaw = (c.req.query("scope") ?? "all").toLowerCase();
  const scope = ["work", "personal", "all"].includes(scopeRaw) ? scopeRaw : "all";
  const hours = Math.min(720, Math.max(1, Number(c.req.query("hours") ?? 48)));
  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  const classification = scope === "all" ? null : scope;

  let kanbanQ = supabase.from("thoughts")
    .select("serial_id, content, type, status, metadata, importance")
    .in("status", ["active", "planning"]).in("type", ["task", "idea"])
    .order("importance", { ascending: false }).limit(15);
  let recentQ = supabase.from("thoughts")
    .select("serial_id, id, content, metadata, source_type, created_at")
    .gte("created_at", since).order("created_at", { ascending: false }).limit(8);
  let actionQ = supabase.from("thoughts")
    .select("serial_id, content, metadata, created_at")
    .gte("created_at", since).not("metadata->action_items", "is", null)
    .order("created_at", { ascending: false }).limit(20);
  if (classification) {
    kanbanQ = kanbanQ.filter("metadata->>classification", "eq", classification);
    recentQ = recentQ.filter("metadata->>classification", "eq", classification);
    actionQ = actionQ.filter("metadata->>classification", "eq", classification);
  }

  const [kanbanRes, recentRes, actionRes, wikiRes] = await Promise.all([
    kanbanQ, recentQ, actionQ,
    supabase.from("wiki_pages").select("slug, title, type, thought_count, generated_at")
      .order("generated_at", { ascending: false }).limit(4),
  ]);

  // Entity mentions from the recent captures (IDs → join), same as the MCP tool.
  const recentUuids = (recentRes.data ?? []).map((t: { id?: string }) => t.id).filter(Boolean);
  const mentionMap = new Map<number, { name: string; type: string; count: number }>();
  if (recentUuids.length) {
    const { data: mentions } = await supabase.from("thought_entities")
      .select("entity_id, entities(canonical_name, entity_type)").in("thought_id", recentUuids);
    for (const m of mentions ?? []) {
      const e = (m as { entities?: { canonical_name: string; entity_type: string } }).entities;
      if (!e) continue;
      const eid = (m as { entity_id: number }).entity_id;
      const existing = mentionMap.get(eid) ?? { name: e.canonical_name, type: e.entity_type, count: 0 };
      mentionMap.set(eid, { ...existing, count: existing.count + 1 });
    }
  }
  const topEntities = [...mentionMap.values()].sort((a, b) => b.count - a.count).slice(0, 6);

  const actionItems: { item: string; thought_id: number; date: string }[] = [];
  for (const t of actionRes.data ?? []) {
    const items = (t as { metadata?: { action_items?: unknown } }).metadata?.action_items;
    if (Array.isArray(items)) {
      for (const item of items) {
        if (typeof item === "string" && item.trim()) {
          actionItems.push({ item, thought_id: (t as { serial_id: number }).serial_id, date: String((t as { created_at: string }).created_at).slice(0, 10) });
        }
      }
    }
  }

  const kanban = kanbanRes.data ?? [];
  return c.json({
    scope, hours,
    kanban: {
      active: kanban.filter((t: { status: string }) => t.status === "active"),
      planning: kanban.filter((t: { status: string }) => t.status === "planning"),
    },
    recent_captures: recentRes.data ?? [],
    action_items: actionItems.slice(0, 20),
    top_entities: topEntities,
    recent_wiki: wikiRes.data ?? [],
    generated_at: new Date().toISOString(),
  }, 200, corsHeaders);
});

// ── OPEN ENGINE v1: agent work-queue REST (t4) ──────────────────────────────
// The the Hermes agent doorway (he is REST-only) + parity surface for the MCP tools.
// Protocol: RUNNER.md in .claude/open-engine/. Tables + atomic claim RPCs in
// migration 20260703060000. Receipt vocabulary is Nate's, verbatim.

const AGENT_TASK_KINDS = ["standing", "task", "standing_skill"];
const AGENT_TASK_STATUSES = ["standing", "todo", "working", "needs_input", "review", "done"];
const AGENT_RECEIPT_TYPES = ["CLAIMED", "DONE", "BLOCKED", "UNBLOCKED", "HUMAN_HOLD", "HUMAN_ANSWERED", "RESUMED", "FAILED", "APPLIED", "FOLLOW_UP"];

// List tasks. agent_code matches the code OR 'all'-assigned tasks.
app.get("/agent-tasks", async (c) => {
  const agentCode = c.req.query("agent_code");
  const status = c.req.query("status");
  const limit = Math.min(200, Math.max(1, Number(c.req.query("limit") ?? 50)));
  let q = supabase.from("agent_tasks").select("*")
    .order("priority", { ascending: false }).order("created_at", { ascending: true }).limit(limit);
  if (agentCode) q = q.or(`agent_code.eq.${agentCode},agent_code.eq.all`);
  if (status) q = q.in("status", status.split(",").map((s: string) => s.trim()));
  const { data, error } = await q;
  if (error) return c.json({ error: error.message }, 500, corsHeaders);
  return c.json({ tasks: data ?? [], count: (data ?? []).length }, 200, corsHeaders);
});

// Claim-next MUST register before /agent-tasks/:id routes.
app.post("/agent-tasks/claim-next", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const agentCode = typeof body.agent_code === "string" && body.agent_code.trim() ? body.agent_code.trim() : null;
  if (!agentCode) return c.json({ error: "agent_code (string) is required" }, 400, corsHeaders);
  const { data, error } = await supabase.rpc("claim_next_agent_task", { p_agent_code: agentCode });
  if (error) return c.json({ error: error.message }, 500, corsHeaders);
  const task = (data ?? [])[0] ?? null;
  if (task) {
    await supabase.from("agent_task_receipts").insert({ task_id: task.id, agent_code: agentCode, receipt_type: "CLAIMED", body: "claim-next" });
  }
  return c.json({ task }, 200, corsHeaders);
});

app.get("/agent-tasks/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!id || isNaN(id)) return c.json({ error: "valid task id required" }, 400, corsHeaders);
  const { data: task, error } = await supabase.from("agent_tasks").select("*").eq("id", id).maybeSingle();
  if (error) return c.json({ error: error.message }, 500, corsHeaders);
  if (!task) return c.json({ error: "task not found" }, 404, corsHeaders);
  const { data: receipts } = await supabase.from("agent_task_receipts")
    .select("*").eq("task_id", id).order("created_at", { ascending: true });
  return c.json({ task, receipts: receipts ?? [] }, 200, corsHeaders);
});

app.post("/agent-tasks", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const agentCode = typeof body.agent_code === "string" && body.agent_code.trim() ? body.agent_code.trim() : null;
  const title = typeof body.title === "string" && body.title.trim() ? body.title.trim() : null;
  if (!agentCode || !title) return c.json({ error: "agent_code and title (strings) are required" }, 400, corsHeaders);
  const kind = AGENT_TASK_KINDS.includes(body.task_kind) ? body.task_kind : "task";
  // standing tasks live in 'standing' status; everything else starts 'todo'.
  const status = kind !== "task" ? "standing" : "todo";
  const row: Record<string, unknown> = {
    agent_code: agentCode, title, task_kind: kind, status,
    body: typeof body.body === "string" ? body.body : null,
    priority: Number.isFinite(Number(body.priority)) ? Number(body.priority) : 0,
  };
  if (body.parent_id != null && Number.isFinite(Number(body.parent_id))) row.parent_id = Number(body.parent_id);
  if (typeof body.local_context_version === "string") row.local_context_version = body.local_context_version;
  const { data, error } = await supabase.from("agent_tasks").insert(row).select("*").maybeSingle();
  if (error) return c.json({ error: error.message }, 500, corsHeaders);
  return c.json({ task: data }, 201, corsHeaders);
});

// Atomic claim by id — 409 when someone else already won (empty RPC return).
app.post("/agent-tasks/:id/claim", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json().catch(() => ({}));
  const agentCode = typeof body.agent_code === "string" && body.agent_code.trim() ? body.agent_code.trim() : null;
  if (!id || isNaN(id) || !agentCode) return c.json({ error: "task id + agent_code required" }, 400, corsHeaders);
  const { data, error } = await supabase.rpc("claim_agent_task", { p_id: id, p_agent_code: agentCode });
  if (error) return c.json({ error: error.message }, 500, corsHeaders);
  const task = (data ?? [])[0] ?? null;
  if (!task) return c.json({ error: "claim lost — task is not in 'todo' (already claimed, done, or missing)", claimed: false }, 409, corsHeaders);
  await supabase.from("agent_task_receipts").insert({ task_id: id, agent_code: agentCode, receipt_type: "CLAIMED", body: "direct claim" });
  return c.json({ claimed: true, task }, 200, corsHeaders);
});

// Update status/fields + optionally leave a receipt in the same call.
app.patch("/agent-tasks/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!id || isNaN(id)) return c.json({ error: "valid task id required" }, 400, corsHeaders);
  const body = await c.req.json().catch(() => ({}));
  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (body.status !== undefined) {
    if (!AGENT_TASK_STATUSES.includes(body.status)) return c.json({ error: `status must be one of: ${AGENT_TASK_STATUSES.join(", ")}` }, 400, corsHeaders);
    updates.status = body.status;
    updates.status_updated_at = new Date().toISOString();
    if (body.status === "done" || body.status === "todo") { updates.claimed_by = null; updates.claimed_at = null; }
  }
  for (const f of ["title", "body", "blocked_reason", "hold_reason", "local_context_version"]) {
    if (typeof body[f] === "string" || body[f] === null) updates[f] = body[f];
  }
  if (body.priority !== undefined && Number.isFinite(Number(body.priority))) updates.priority = Number(body.priority);
  // Reassignment ("pass this to hermes-agent"): distinct from body.agent_code, which
  // only attributes the optional receipt. Clears any claim so the new
  // assignee's claim-next can pick it up.
  if (typeof body.reassign_to === "string" && body.reassign_to.trim()) {
    updates.agent_code = body.reassign_to.trim();
    updates.claimed_by = null;
    updates.claimed_at = null;
  }
  const { data, error } = await supabase.from("agent_tasks").update(updates).eq("id", id).select("*").maybeSingle();
  if (error) return c.json({ error: error.message }, 500, corsHeaders);
  if (!data) return c.json({ error: "task not found" }, 404, corsHeaders);
  let receipt = null;
  if (body.receipt_type) {
    if (!AGENT_RECEIPT_TYPES.includes(body.receipt_type)) return c.json({ error: `receipt_type must be one of: ${AGENT_RECEIPT_TYPES.join(", ")}`, task: data }, 400, corsHeaders);
    const { data: r } = await supabase.from("agent_task_receipts")
      .insert({ task_id: id, agent_code: String(body.agent_code ?? data.claimed_by ?? "unknown"), receipt_type: body.receipt_type, body: typeof body.receipt_body === "string" ? body.receipt_body : null })
      .select("*").maybeSingle();
    receipt = r;
  }
  return c.json({ task: data, ...(receipt ? { receipt } : {}) }, 200, corsHeaders);
});

app.post("/agent-tasks/:id/receipts", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json().catch(() => ({}));
  if (!id || isNaN(id)) return c.json({ error: "valid task id required" }, 400, corsHeaders);
  if (!AGENT_RECEIPT_TYPES.includes(body.receipt_type)) return c.json({ error: `receipt_type must be one of: ${AGENT_RECEIPT_TYPES.join(", ")}` }, 400, corsHeaders);
  const { data, error } = await supabase.from("agent_task_receipts")
    .insert({ task_id: id, agent_code: String(body.agent_code ?? "unknown"), receipt_type: body.receipt_type, body: typeof body.body === "string" ? body.body : null })
    .select("*").maybeSingle();
  if (error) return c.json({ error: error.message }, 500, corsHeaders);
  return c.json({ receipt: data }, 201, corsHeaders);
});

app.get("/agent-ledger", async (c) => {
  const agentCode = c.req.query("agent_code");
  let q = supabase.from("agent_status_ledger").select("*").order("agent_code");
  if (agentCode) q = q.eq("agent_code", agentCode);
  const { data, error } = await q;
  if (error) return c.json({ error: error.message }, 500, corsHeaders);
  return c.json({ ledger: data ?? [] }, 200, corsHeaders);
});

// Upsert on agent_code — heartbeats, queue results, context versions.
app.put("/agent-ledger/:agent_code", async (c) => {
  const agentCode = c.req.param("agent_code");
  const body = await c.req.json().catch(() => ({}));
  const row: Record<string, unknown> = { agent_code: agentCode, updated_at: new Date().toISOString() };
  for (const f of ["human_operator", "runtime", "automation", "automation_state", "last_queue_result", "local_context_version", "notes"]) {
    if (typeof body[f] === "string" || body[f] === null) row[f] = body[f];
  }
  // "true" sentinel (string OR boolean) => now(). The ajo_ledger_update tool
  // schema documents last_heartbeat as "'true' or ISO timestamp", and agents
  // (the Hermes agent's ajo_tasks plugin) send the STRING "true" verbatim — which would
  // otherwise land in a `timestamptz` column and 500. Coerce here so it's
  // fleet-correct for every agent using the documented sentinel; real ISO
  // strings still pass through unchanged.
  if (body.last_heartbeat === true || body.last_heartbeat === "true") row.last_heartbeat = new Date().toISOString();
  else if (typeof body.last_heartbeat === "string") row.last_heartbeat = body.last_heartbeat;
  if (body.last_successful_run === true || body.last_successful_run === "true") row.last_successful_run = new Date().toISOString();
  else if (typeof body.last_successful_run === "string") row.last_successful_run = body.last_successful_run;
  if (Array.isArray(body.optional_skills)) row.optional_skills = body.optional_skills;
  const { data, error } = await supabase.from("agent_status_ledger")
    .upsert(row, { onConflict: "agent_code" }).select("*").maybeSingle();
  if (error) return c.json({ error: error.message }, 500, corsHeaders);
  return c.json({ ledger: data }, 200, corsHeaders);
});

// Entity merge — reassigns thought_entities + edge PROVENANCE + edges to the
// target, then deletes the source. The careful path the Hermes agent's curation tools call.
//
// no_alias_names (optional, string[]): names to NEITHER add as target aliases
// NOR blocklist — the ambiguous-bare-name guard. E.g. merging bare "Sam"
// #2918 into Dr. Jones #219 with no_alias_names:["Sam"] keeps future bare
// "Sam" mentions unresolvable (they mint fresh / escalate) instead of
// auto-resolving to Dr. Jones when they might mean a different Sam #1364.
// Loose-normalized comparison (case/hyphen/space-insensitive).
//
// Provenance (thought_entity_edges) moves by DELETE+INSERT so the
// maintain_edge_support_count trigger fires both directions and the edges
// rollup stays exact. Source↔target rows are dropped (they'd be self-loops).
// Response carries a full pre-merge snapshot for the caller's receipt;
// graph_audit triggers capture the entity/edge mutations independently.
app.post("/entities/:id/merge", async (c) => {
  const sourceId = Number(c.req.param("id"));
  const body = await c.req.json();
  const targetId = Number(body.target_id);
  if (!targetId || isNaN(targetId) || targetId === sourceId) {
    return c.json({ error: "Valid target_id (different from source) required" }, 400, corsHeaders);
  }
  const noAlias = new Set(
    (Array.isArray(body.no_alias_names) ? body.no_alias_names : [])
      .filter((n: unknown) => typeof n === "string").map((n: string) => looseNormalize(n)),
  );

  const { data: source } = await supabase
    .from("entities").select("*").eq("id", sourceId).maybeSingle();
  if (!source) return c.json({ error: "Source entity not found" }, 404, corsHeaders);

  const { data: target } = await supabase
    .from("entities").select("*").eq("id", targetId).maybeSingle();
  if (!target) return c.json({ error: `Target entity not found (id=${targetId}). It may have been previously deleted — refresh the wiki and try again.` }, 404, corsHeaders);

  // ── Pre-merge snapshot (returned to the caller for its receipt trail)
  const { data: snapLinks } = await supabase
    .from("thought_entities").select("*").eq("entity_id", sourceId);
  const { data: snapProv } = await supabase
    .from("thought_entity_edges").select("*")
    .or(`from_entity_id.eq.${sourceId},to_entity_id.eq.${sourceId}`);
  const { data: snapEdges } = await supabase
    .from("edges").select("*")
    .or(`from_entity_id.eq.${sourceId},to_entity_id.eq.${sourceId}`);
  const snapshot = { source, links: snapLinks ?? [], provenance: snapProv ?? [], edges: snapEdges ?? [] };

  // ── thought_entities: repoint, dropping rows whose thought already links target
  let linksMoved = 0, linksDroppedDup = 0;
  const { data: tgtLinks } = await supabase
    .from("thought_entities").select("thought_id").eq("entity_id", targetId);
  const tgtLinked = new Set((tgtLinks ?? []).map((l: { thought_id: string }) => l.thought_id));
  for (const link of snapLinks ?? []) {
    if (tgtLinked.has(link.thought_id)) {
      await supabase.from("thought_entities").delete()
        .eq("thought_id", link.thought_id).eq("entity_id", sourceId);
      linksDroppedDup++;
    } else {
      await supabase.from("thought_entities").update({ entity_id: targetId })
        .eq("thought_id", link.thought_id).eq("entity_id", sourceId);
      linksMoved++;
    }
  }

  // ── edge provenance: DELETE+INSERT repoint (fires the support-count trigger
  // both ways). Source↔target rows are dropped — they'd violate the from≠to CHECK.
  let provMoved = 0, provDropped = 0;
  for (const row of snapProv ?? []) {
    const newFrom = row.from_entity_id === sourceId ? targetId : row.from_entity_id;
    const newTo = row.to_entity_id === sourceId ? targetId : row.to_entity_id;
    await supabase.from("thought_entity_edges").delete()
      .eq("thought_id", row.thought_id)
      .eq("from_entity_id", row.from_entity_id)
      .eq("to_entity_id", row.to_entity_id)
      .eq("relation", row.relation);
    if (newFrom === newTo) { provDropped++; continue; }
    const { error: insErr } = await supabase.from("thought_entity_edges").insert({
      thought_id: row.thought_id, from_entity_id: newFrom, to_entity_id: newTo,
      relation: row.relation, confidence: row.confidence,
    });
    if (insErr) provDropped++; // PK dup: target already has this provenance tuple
    else provMoved++;
  }

  // ── remaining edges (manual/inferred/rolled-up): repoint with dup-merge and
  // a self-loop guard. Re-fetch — the provenance trigger may have changed rows.
  let edgesRepointed = 0, edgesDropped = 0;
  const { data: liveEdges } = await supabase.from("edges")
    .select("id, from_entity_id, to_entity_id, relation")
    .or(`from_entity_id.eq.${sourceId},to_entity_id.eq.${sourceId}`);
  for (const edge of liveEdges ?? []) {
    const newFrom = edge.from_entity_id === sourceId ? targetId : edge.from_entity_id;
    const newTo = edge.to_entity_id === sourceId ? targetId : edge.to_entity_id;
    if (newFrom === newTo) { // source↔target edge becomes a self-loop — drop
      await supabase.from("edges").delete().eq("id", edge.id);
      edgesDropped++;
      continue;
    }
    const { data: dup } = await supabase.from("edges").select("id")
      .eq("from_entity_id", newFrom).eq("to_entity_id", newTo)
      .eq("relation", edge.relation).neq("id", edge.id).maybeSingle();
    if (dup) {
      await supabase.from("edges").delete().eq("id", edge.id);
      edgesDropped++;
    } else {
      await supabase.from("edges").update({ from_entity_id: newFrom, to_entity_id: newTo }).eq("id", edge.id);
      edgesRepointed++;
    }
  }

  // ── aliases: fold source names into the target, EXCEPT no_alias_names
  const srcAliases: string[] = Array.isArray(source.aliases) ? source.aliases : [];
  const tgtAliases: string[] = Array.isArray(target.aliases) ? target.aliases : [];
  const tgtNorm = new Set([...tgtAliases, target.canonical_name].map((a) => looseNormalize(a)));
  const aliasesAdded: string[] = [];
  for (const name of [...srcAliases, source.canonical_name]) {
    const norm = looseNormalize(name);
    if (noAlias.has(norm) || tgtNorm.has(norm)) continue;
    aliasesAdded.push(name);
    tgtNorm.add(norm);
  }
  if (aliasesAdded.length) {
    await supabase.from("entities")
      .update({ aliases: [...tgtAliases, ...aliasesAdded], updated_at: new Date().toISOString() })
      .eq("id", targetId);
  }

  // ── blocklist the source name so it isn't re-minted — UNLESS it's in
  // no_alias_names (ambiguous bare names must stay mintable/escalatable).
  let blocklisted = false;
  if (source.entity_type && source.normalized_name && !noAlias.has(looseNormalize(source.canonical_name))) {
    await supabase.from("entity_blocklist")
      .upsert({
        entity_type: source.entity_type,
        normalized_name: source.normalized_name,
        reason: "merged",
        blocked_at: new Date().toISOString(),
      }, { onConflict: "entity_type,normalized_name" });
    blocklisted = true;
  }

  // ── delete source wiki page + entity; mark target's page stale + queue regen
  const { data: srcPages } = await supabase
    .from("wiki_pages").select("slug").eq("entity_id", sourceId);
  await supabase.from("wiki_pages").delete().eq("entity_id", sourceId);
  await supabase.from("entities").delete().eq("id", sourceId);
  let regenQueued = false;
  const { data: tgtPage } = await supabase
    .from("wiki_pages").select("slug").eq("entity_id", targetId).maybeSingle();
  if (tgtPage) {
    await supabase.from("wiki_pages").update({ generated_at: null }).eq("entity_id", targetId);
    const { error: regenErr } = await supabase.from("wiki_regen_queue")
      .insert({ entity_id: targetId, slug: tgtPage.slug, requested_by: "entity-merge", reason: `absorbed #${sourceId} ${source.canonical_name}` });
    regenQueued = !regenErr; // 23505 = already queued; fine
  }

  return c.json({
    merged: true, source_id: sourceId, target_id: targetId,
    links_moved: linksMoved, links_dropped_dup: linksDroppedDup,
    provenance_moved: provMoved, provenance_dropped: provDropped,
    edges_repointed: edgesRepointed, edges_dropped: edgesDropped,
    aliases_added: aliasesAdded, blocklisted,
    source_wiki_deleted: (srcPages ?? []).map((p: { slug: string }) => p.slug),
    target_regen_queued: regenQueued,
    snapshot,
  }, 200, corsHeaders);
});

// ─────────────────────────────────────────────────────────────────────────────
// Plaud local speaker pipeline (Section B) — recordings / segments / speakers.
// OB stores ONLY non-biometric review artifacts; voiceprint vectors NEVER reach
// here (they stay in the WSL box's local pgvector — Guardian invariant 2026-07-17).
// The /speakers dashboard GUI reads these; enrolment (name → voiceprint library)
// is driven by the LOCAL dashboard, which alone can reach the WSL box.
// ─────────────────────────────────────────────────────────────────────────────

// INGEST — the WSL pipeline POSTs a transcribed+diarized+matched recording here.
// Idempotent per recording_id: upserts the recording, then replaces its speakers
// and segments wholesale (safe to re-run after a re-process). No vectors accepted.
app.post("/plaud-recordings", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const recordingId = typeof body.recording_id === "string" && body.recording_id.trim() ? body.recording_id.trim() : null;
  if (!recordingId) return c.json({ error: "recording_id (string) is required" }, 400, corsHeaders);
  if (!Array.isArray(body.segments)) return c.json({ error: "segments (array) is required" }, 400, corsHeaders);

  const recRow: Record<string, unknown> = {
    recording_id: recordingId,
    title: typeof body.title === "string" ? body.title : null,
    started_at: body.started_at ?? null,
    duration_ms: Number.isFinite(Number(body.duration_ms)) ? Number(body.duration_ms) : null,
    audio_ref: typeof body.audio_ref === "string" ? body.audio_ref : null,
    transcript_text: typeof body.transcript_text === "string" ? body.transcript_text : null,
    review_status: body.review_status === "reviewed" ? "reviewed" : "pending_review",
    metadata: (body.metadata && typeof body.metadata === "object") ? body.metadata : {},
    updated_at: new Date().toISOString(),
  };
  const { error: recErr } = await supabase.from("plaud_recordings")
    .upsert(recRow, { onConflict: "recording_id" });
  if (recErr) return c.json({ error: recErr.message }, 500, corsHeaders);

  // Replace segments + speakers for a clean re-ingest.
  await supabase.from("plaud_speaker_segments").delete().eq("recording_id", recordingId);
  await supabase.from("plaud_recording_speakers").delete().eq("recording_id", recordingId);

  const segRows = body.segments.map((s: Record<string, unknown>, i: number) => ({
    recording_id: recordingId,
    idx: Number.isFinite(Number(s.idx)) ? Number(s.idx) : i,
    start_ms: Number(s.start_ms) || 0,
    end_ms: Number(s.end_ms) || 0,
    speaker_key: String(s.speaker_key ?? "S1"),
    resolved_name_override: typeof s.resolved_name_override === "string" ? s.resolved_name_override : null,
    match_confidence: Number.isFinite(Number(s.match_confidence)) ? Number(s.match_confidence) : null,
    // Lever A: per-turn crosstalk overlap (0..1); null = unscored/allowed.
    overlap: Number.isFinite(Number(s.overlap)) ? Number(s.overlap) : null,
    // Persistent "exclude from identification" flag. The pipeline normally omits it
    // (defaults false); preserved on re-ingest only if the pusher echoes it back.
    excluded: s.excluded === true,
    // Persistent "transcript text hand-edited" flag — same carry-on-re-ingest pattern:
    // the pusher echoes it (+ the corrected text) so a re-ingest keeps the operator's prose.
    text_edited: s.text_edited === true,
    text: typeof s.text === "string" ? s.text : null,
  }));
  if (segRows.length) {
    const { error: segErr } = await supabase.from("plaud_speaker_segments").insert(segRows);
    if (segErr) return c.json({ error: segErr.message }, 500, corsHeaders);
  }

  // Speakers: use the provided list, else derive distinct keys from segments.
  let speakerRows: Record<string, unknown>[];
  if (Array.isArray(body.speakers) && body.speakers.length) {
    speakerRows = body.speakers.map((sp: Record<string, unknown>) => ({
      recording_id: recordingId,
      speaker_key: String(sp.speaker_key ?? "S1"),
      resolved_name: typeof sp.resolved_name === "string" ? sp.resolved_name : null,
      match_confidence: Number.isFinite(Number(sp.match_confidence)) ? Number(sp.match_confidence) : null,
      enrolled: sp.enrolled === true,
      updated_at: new Date().toISOString(),
    }));
  } else {
    const seen = new Map<string, Record<string, unknown>>();
    for (const s of segRows) {
      if (!seen.has(s.speaker_key)) {
        seen.set(s.speaker_key, {
          recording_id: recordingId, speaker_key: s.speaker_key,
          resolved_name: null, match_confidence: s.match_confidence, enrolled: false,
          updated_at: new Date().toISOString(),
        });
      }
    }
    speakerRows = [...seen.values()];
  }
  if (speakerRows.length) {
    const { error: spErr } = await supabase.from("plaud_recording_speakers").insert(speakerRows);
    if (spErr) return c.json({ error: spErr.message }, 500, corsHeaders);
  }

  return c.json({ recording_id: recordingId, segments: segRows.length, speakers: speakerRows.length }, 201, corsHeaders);
});

// LIST — for the /speakers GUI. Newest first; ?review_status= filters.
app.get("/plaud-recordings", async (c) => {
  const status = c.req.query("review_status");
  const limit = Math.min(500, Math.max(1, Number(c.req.query("limit") ?? 100)));
  let q = supabase.from("plaud_recordings")
    .select("id, recording_id, title, started_at, duration_ms, audio_ref, review_status, created_at, updated_at")
    .order("created_at", { ascending: false }).limit(limit);
  if (status) q = q.eq("review_status", status);
  const { data, error } = await q;
  if (error) return c.json({ error: error.message }, 500, corsHeaders);
  return c.json({ recordings: data ?? [] }, 200, corsHeaders);
});

// DETAIL — recording + its speakers + ordered segments.
app.get("/plaud-recordings/:recording_id", async (c) => {
  const rid = c.req.param("recording_id");
  const { data: rec, error: recErr } = await supabase.from("plaud_recordings")
    .select("*").eq("recording_id", rid).maybeSingle();
  if (recErr) return c.json({ error: recErr.message }, 500, corsHeaders);
  if (!rec) return c.json({ error: "recording not found" }, 404, corsHeaders);
  const { data: speakers } = await supabase.from("plaud_recording_speakers")
    .select("*").eq("recording_id", rid).order("speaker_key");
  const { data: segments } = await supabase.from("plaud_speaker_segments")
    .select("*").eq("recording_id", rid).order("idx");
  return c.json({ recording: rec, speakers: speakers ?? [], segments: segments ?? [] }, 200, corsHeaders);
});

// MARK REVIEWED (or back to pending) — light state toggle for the GUI. This endpoint
// ONLY sets review_status. It rejects any other field with 400 rather than silently
// 200-ing (the footgun: a stray {text}/{start_ms} here does NOT edit anything — those
// are per-segment fields; use PATCH /plaud-recordings/:recording_id/segments/:idx).
app.patch("/plaud-recordings/:recording_id", async (c) => {
  const rid = c.req.param("recording_id");
  const body = await c.req.json().catch(() => ({}));
  const ALLOWED = new Set(["review_status", "summary_md"]);
  const unknown = Object.keys(body).filter((k) => !ALLOWED.has(k));
  if (unknown.length) {
    return c.json({ error: `unrecognised field(s): ${unknown.join(", ")}. This endpoint accepts review_status and/or summary_md; per-segment edits (text/resolved_name/excluded/text_edited) go to PATCH /plaud-recordings/:recording_id/segments/:idx.` }, 400, corsHeaders);
  }
  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if ("review_status" in body) {
    if (body.review_status !== "reviewed" && body.review_status !== "pending_review") {
      return c.json({ error: "review_status must be 'reviewed' or 'pending_review'" }, 400, corsHeaders);
    }
    updates.review_status = body.review_status;
  }
  if ("summary_md" in body) {
    if (body.summary_md !== null && typeof body.summary_md !== "string") {
      return c.json({ error: "summary_md must be a string or null" }, 400, corsHeaders);
    }
    updates.summary_md = body.summary_md;
  }
  if (Object.keys(updates).length === 1) {  // only updated_at ⇒ nothing real supplied
    return c.json({ error: "provide review_status and/or summary_md" }, 400, corsHeaders);
  }
  const { data, error } = await supabase.from("plaud_recordings").update(updates).eq("recording_id", rid).select("*").maybeSingle();
  if (error) return c.json({ error: error.message }, 500, corsHeaders);
  if (!data) return c.json({ error: "recording not found" }, 404, corsHeaders);
  return c.json({ recording: data }, 200, corsHeaders);
});

// DELETE a recording + its speakers/segments (FK ON DELETE CASCADE) — purge a
// blank/accidental review-queue entry. This touches ONLY the pre-capture Plaud
// review tables; no `thoughts` are affected (analysis/capture happens later, on
// Release). Idempotent-ish: 404 if the recording is already gone.
app.delete("/plaud-recordings/:recording_id", async (c) => {
  const rid = c.req.param("recording_id");
  const { data: existing } = await supabase.from("plaud_recordings")
    .select("recording_id").eq("recording_id", rid).maybeSingle();
  if (!existing) return c.json({ error: "recording not found" }, 404, corsHeaders);
  const { count: segCount } = await supabase.from("plaud_speaker_segments")
    .select("*", { count: "exact", head: true }).eq("recording_id", rid);
  const { count: spkCount } = await supabase.from("plaud_recording_speakers")
    .select("*", { count: "exact", head: true }).eq("recording_id", rid);
  const { error } = await supabase.from("plaud_recordings").delete().eq("recording_id", rid);
  if (error) return c.json({ error: error.message }, 500, corsHeaders);
  return c.json({ deleted: true, recording_id: rid, segments_deleted: segCount ?? 0, speakers_deleted: spkCount ?? 0 }, 200, corsHeaders);
});

// BULK PURGE recordings by review_status — clear a stale backlog (e.g. wipe all
// pending_review to restart a clean one-at-a-time drip). Speakers+segments cascade.
// SAFETY: review_status is REQUIRED and must be an explicit known status — there is
// no unfiltered "delete everything" path. Returns the ids removed. Pre-capture review
// data only; no thoughts touched.
app.post("/plaud-recordings/purge", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const status = body.review_status;
  const ALLOWED = ["pending_review", "reviewed"];
  if (!ALLOWED.includes(status)) {
    return c.json({ error: `review_status is required and must be one of ${ALLOWED.join("|")} (no unfiltered purge)` }, 400, corsHeaders);
  }
  const { data: rows, error: selErr } = await supabase.from("plaud_recordings")
    .select("recording_id").eq("review_status", status);
  if (selErr) return c.json({ error: selErr.message }, 500, corsHeaders);
  const ids = (rows ?? []).map((r) => r.recording_id);
  if (ids.length === 0) return c.json({ deleted: 0, recording_ids: [], review_status: status }, 200, corsHeaders);
  const { error: delErr } = await supabase.from("plaud_recordings").delete().eq("review_status", status);
  if (delErr) return c.json({ error: delErr.message }, 500, corsHeaders);
  return c.json({ deleted: ids.length, recording_ids: ids, review_status: status }, 200, corsHeaders);
});

// PATCH ONE segment: rename "just this instance" (diarization slip fix), set the
// persistent `excluded` flag, and/or correct the transcript `text` (+ `text_edited`).
// All fields optional; at least one required. Fields are independent — a rename PATCH
// never touches `text_edited`, so a hand-corrected line keeps its edited mark.
app.patch("/plaud-recordings/:recording_id/segments/:idx", async (c) => {
  const rid = c.req.param("recording_id");
  const idx = Number(c.req.param("idx"));
  if (!Number.isFinite(idx)) return c.json({ error: "valid segment idx required" }, 400, corsHeaders);
  const body = await c.req.json().catch(() => ({}));
  // name === null clears the override (revert to the speaker's bulk label);
  // undefined = "don't touch the name" (e.g. an excluded-only or text-only PATCH).
  const name = body.resolved_name === null ? null
    : (typeof body.resolved_name === "string" && body.resolved_name.trim() ? body.resolved_name.trim() : undefined);
  // excluded is optional; only written when the caller sends a real boolean.
  const excluded = typeof body.excluded === "boolean" ? body.excluded : undefined;
  // text is optional; a hand-corrected transcript line. text_edited is the persistent
  // "this prose is the human's" flag (only written when a real boolean is sent).
  const text = typeof body.text === "string" ? body.text : undefined;
  const textEdited = typeof body.text_edited === "boolean" ? body.text_edited : undefined;
  const patch: Record<string, unknown> = {};
  if (name !== undefined) patch.resolved_name_override = name;
  if (excluded !== undefined) patch.excluded = excluded;
  if (text !== undefined) patch.text = text;
  if (textEdited !== undefined) patch.text_edited = textEdited;
  if (Object.keys(patch).length === 0) {
    return c.json({ error: "resolved_name (string|null), excluded (boolean), text (string), or text_edited (boolean) required" }, 400, corsHeaders);
  }
  const { data, error } = await supabase.from("plaud_speaker_segments")
    .update(patch).eq("recording_id", rid).eq("idx", idx).select("*").maybeSingle();
  if (error) return c.json({ error: error.message }, 500, corsHeaders);
  if (!data) return c.json({ error: "segment not found" }, 404, corsHeaders);
  return c.json({ segment: data }, 200, corsHeaders);
});

// RENAME "all instances of Speaker X" + mark enrolled — the bulk relabel /
// enrolment path. Updates OB's own labels ONLY. The actual voiceprint enrolment
// (name → WSL library) is fired by the LOCAL dashboard, which can reach the box;
// this Edge Function can't. Clearing per-segment overrides for the speaker so the
// bulk name takes effect everywhere is optional via ?clear_overrides=1.
app.patch("/plaud-recordings/:recording_id/speakers/:speaker_key", async (c) => {
  const rid = c.req.param("recording_id");
  const key = c.req.param("speaker_key");
  const body = await c.req.json().catch(() => ({}));
  const name = body.resolved_name === null ? null
    : (typeof body.resolved_name === "string" && body.resolved_name.trim() ? body.resolved_name.trim() : undefined);
  // excluded is the whole-speaker "disregard in analysis" flag (mirrors the per-segment
  // excluded). Only written when a real boolean is sent, so a rename-only PATCH leaves it.
  const excluded = typeof body.excluded === "boolean" ? body.excluded : undefined;
  if (name === undefined && excluded === undefined) {
    return c.json({ error: "resolved_name (string|null) or excluded (boolean) required" }, 400, corsHeaders);
  }
  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (name !== undefined) updates.resolved_name = name;
  if (excluded !== undefined) updates.excluded = excluded;
  if (body.enrolled === true) updates.enrolled = true;
  const { data, error } = await supabase.from("plaud_recording_speakers")
    .update(updates).eq("recording_id", rid).eq("speaker_key", key).select("*").maybeSingle();
  if (error) return c.json({ error: error.message }, 500, corsHeaders);
  if (!data) return c.json({ error: "speaker not found" }, 404, corsHeaders);
  if (c.req.query("clear_overrides") === "1") {
    await supabase.from("plaud_speaker_segments")
      .update({ resolved_name_override: null }).eq("recording_id", rid).eq("speaker_key", key);
  }
  return c.json({ speaker: data }, 200, corsHeaders);
});

// Double Mount — handles both /rest-api/... and /...
const api = new Hono();
api.route("/rest-api", app);
api.route("/", app);

Deno.serve(api.fetch);
