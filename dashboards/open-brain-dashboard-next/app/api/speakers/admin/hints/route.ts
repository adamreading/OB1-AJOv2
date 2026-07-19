import { NextRequest, NextResponse } from "next/server";
import { requireSession, AuthError } from "@/lib/auth";

// STT-correction hints proxy → the WSL pipeline's /admin/hints endpoints (local, :8799).
// GET    /api/speakers/admin/hints                       → WSL GET  /admin/hints
// POST   /api/speakers/admin/hints {phrase,context,misheard} → WSL POST /admin/hints (upsert by phrase)
// DELETE /api/speakers/admin/hints?id=N                  → WSL POST /admin/hints/delete {id}
// A hint = "I saw <misheard>, it should be <phrase>": a deterministic word-level
// post-pass correction, context-gated by the recording's participants. NOT a decode-time
// vocabulary boost.
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
  if (!ADMIN_URL) return NextResponse.json({ hints: [], configured: false });
  try {
    const r = await fetch(`${ADMIN_URL}/hints`, { signal: AbortSignal.timeout(10000) });
    const j = await r.json().catch(() => ({ hints: [] }));
    return NextResponse.json({ ...j, configured: true }, { status: r.status });
  } catch (e) {
    return NextResponse.json({ hints: [], configured: true, error: e instanceof Error ? e.message : "admin unreachable" }, { status: 502 });
  }
}

export async function POST(request: NextRequest) {
  const unauth = await requireAuth();
  if (unauth) return unauth;
  if (!ADMIN_URL) return NextResponse.json({ error: "admin endpoint not configured" }, { status: 503 });
  const body = await request.json().catch(() => ({}));
  try {
    const r = await fetch(`${ADMIN_URL}/hints`, {
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

export async function DELETE(request: NextRequest) {
  const unauth = await requireAuth();
  if (unauth) return unauth;
  if (!ADMIN_URL) return NextResponse.json({ error: "admin endpoint not configured" }, { status: 503 });
  const id = request.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  try {
    const r = await fetch(`${ADMIN_URL}/hints/delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: Number.isNaN(Number(id)) ? id : Number(id) }),
      signal: AbortSignal.timeout(10000),
    });
    const j = await r.json().catch(() => ({}));
    return NextResponse.json(j, { status: r.status });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "admin unreachable" }, { status: 502 });
  }
}
