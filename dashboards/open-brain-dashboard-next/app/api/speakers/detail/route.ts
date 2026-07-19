import { NextRequest, NextResponse } from "next/server";
import { requireSession, AuthError } from "@/lib/auth";

const API_URL = process.env.NEXT_PUBLIC_API_URL!;
// The WSL pipeline's analysis trigger. Fired from THIS local dashboard route on
// RELEASE (mark-reviewed) so the terra analysis turn runs ONLY on recordings the
// operator has actually confirmed — not at ingest (design correction 2026-07-18:
// analysis is release-gated to stop spend on unconfirmed speakers). Reachable only
// from the local box; unset ⇒ release still works, analysis just isn't auto-fired.
const WSL_ANALYZE_URL = process.env.WSL_PIPELINE_ANALYZE_URL || "";

// GET  /api/speakers/detail?recording_id=X  → recording + speakers + segments
// PATCH same (body {review_status})         → mark reviewed / pending
//   On review_status:"reviewed" (RELEASE) also notifies the pipeline to analyze.
async function auth() {
  return requireSession();
}

export async function GET(request: NextRequest) {
  let apiKey: string;
  try {
    ({ apiKey } = await auth());
  } catch (err) {
    if (err instanceof AuthError) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    throw err;
  }
  const rid = request.nextUrl.searchParams.get("recording_id");
  if (!rid) return NextResponse.json({ error: "recording_id required" }, { status: 400 });
  try {
    const res = await fetch(`${API_URL}/plaud-recordings/${encodeURIComponent(rid)}`, {
      headers: { "x-brain-key": apiKey },
    });
    if (!res.ok) throw new Error(`API ${res.status}`);
    return NextResponse.json(await res.json());
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed" }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  let apiKey: string;
  try {
    ({ apiKey } = await auth());
  } catch (err) {
    if (err instanceof AuthError) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    throw err;
  }
  const rid = request.nextUrl.searchParams.get("recording_id");
  if (!rid) return NextResponse.json({ error: "recording_id required" }, { status: 400 });
  const body = await request.json().catch(() => ({}));
  try {
    const res = await fetch(`${API_URL}/plaud-recordings/${encodeURIComponent(rid)}`, {
      method: "PATCH",
      headers: { "x-brain-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`API ${res.status}`);
    const result = await res.json();

    // RELEASE → trigger analysis. Best-effort: a label/state update must never fail
    // because the pipeline is momentarily down. The pipeline's /analyze is expected
    // to be idempotent (skip if already analysed unless the speakers changed).
    let analysis: { attempted: boolean; ok?: boolean; status?: number; error?: string } = { attempted: false };
    if (body.review_status === "reviewed" && WSL_ANALYZE_URL) {
      analysis = { attempted: true };
      try {
        const ar = await fetch(WSL_ANALYZE_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ recording_id: rid }),
          signal: AbortSignal.timeout(8000),
        });
        analysis.ok = ar.ok;
        analysis.status = ar.status;
      } catch (e) {
        analysis.ok = false;
        analysis.error = e instanceof Error ? e.message : "analyze call failed";
      }
    }
    return NextResponse.json({ ...result, analysis });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed" }, { status: 500 });
  }
}
