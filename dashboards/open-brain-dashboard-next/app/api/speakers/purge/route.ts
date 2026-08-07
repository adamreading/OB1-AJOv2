import { NextRequest, NextResponse } from "next/server";
import { requireSession, AuthError } from "@/lib/auth";

const API_URL = process.env.NEXT_PUBLIC_API_URL!;

// POST /api/speakers/purge  { review_status: "pending_review" | "reviewed" }
// Bulk-delete all review-queue recordings with the given status (+ their speakers/
// segments via FK cascade) — e.g. wipe a stale pending_review backlog. Pre-capture
// review data only; no thoughts touched. review_status is required server-side (no
// unfiltered wipe). Behind a logged-in session.
export async function POST(request: NextRequest) {
  let apiKey: string;
  try {
    ({ apiKey } = await requireSession());
  } catch (err) {
    if (err instanceof AuthError) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    throw err;
  }
  const body = await request.json().catch(() => ({}));
  try {
    // rest-api now requires confirm_token === review_status AND a max_delete ceiling
    // (a partition holding 100% of the corpus made this a one-call corpus-zeroer). The
    // dashboard clear is a deliberate window.confirm'd bulk action, so it forwards both.
    const res = await fetch(`${API_URL}/plaud-recordings/purge`, {
      method: "POST",
      headers: { "x-brain-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ review_status: body.review_status, confirm_token: body.confirm_token, max_delete: body.max_delete }),
    });
    const j = await res.json().catch(() => ({}));
    return NextResponse.json(j, { status: res.status });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed" }, { status: 500 });
  }
}
