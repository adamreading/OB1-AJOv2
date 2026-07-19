import { NextRequest, NextResponse } from "next/server";
import { requireSession, AuthError } from "@/lib/auth";

// STT-admin proxy → the WSL pipeline's /admin/* endpoints (local box only, :8799).
// GET  /api/speakers/admin/speakers            → WSL GET  /admin/speakers
// POST /api/speakers/admin/speakers {id|name,context} → WSL POST /admin/speaker-context
// Behind a logged-in session; the WSL call is local + unauthenticated. Env-gated —
// unset ADMIN_URL degrades to an empty list + configured:false so the UI can explain.
const ADMIN_URL = process.env.WSL_PIPELINE_ADMIN_URL || ""; // e.g. http://localhost:8799/admin

async function requireAuth(): Promise<NextResponse | null> {
  try { await requireSession(); return null; }
  catch (err) {
    if (err instanceof AuthError) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    throw err;
  }
}

export async function GET() {
  const unauth = await requireAuth();
  if (unauth) return unauth;
  if (!ADMIN_URL) return NextResponse.json({ speakers: [], configured: false });
  try {
    const r = await fetch(`${ADMIN_URL}/speakers`, { signal: AbortSignal.timeout(10000) });
    const j = await r.json().catch(() => ({ speakers: [] }));
    return NextResponse.json({ ...j, configured: true }, { status: r.status });
  } catch (e) {
    return NextResponse.json({ speakers: [], configured: true, error: e instanceof Error ? e.message : "admin unreachable" }, { status: 502 });
  }
}

export async function POST(request: NextRequest) {
  const unauth = await requireAuth();
  if (unauth) return unauth;
  if (!ADMIN_URL) return NextResponse.json({ error: "admin endpoint not configured" }, { status: 503 });
  const body = await request.json().catch(() => ({}));
  try {
    const r = await fetch(`${ADMIN_URL}/speaker-context`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    const j = await r.json().catch(() => ({}));
    return NextResponse.json(j, { status: r.status });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "admin unreachable" }, { status: 502 });
  }
}
