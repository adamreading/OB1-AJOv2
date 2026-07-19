import { NextRequest, NextResponse } from "next/server";
import { requireSession, AuthError } from "@/lib/auth";

const API_URL = process.env.NEXT_PUBLIC_API_URL!;

// DELETE /api/speakers/delete?recording_id=X
// Purge a blank/accidental review-queue recording (+ its speakers/segments via FK
// cascade). Pre-capture review data only — no thoughts touched. Behind a logged-in
// session; forwards to rest-api DELETE /plaud-recordings/:recording_id.
export async function DELETE(request: NextRequest) {
  let apiKey: string;
  try {
    ({ apiKey } = await requireSession());
  } catch (err) {
    if (err instanceof AuthError) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    throw err;
  }
  const rid = request.nextUrl.searchParams.get("recording_id");
  if (!rid) return NextResponse.json({ error: "recording_id required" }, { status: 400 });
  try {
    const res = await fetch(`${API_URL}/plaud-recordings/${encodeURIComponent(rid)}`, {
      method: "DELETE",
      headers: { "x-brain-key": apiKey },
    });
    const j = await res.json().catch(() => ({}));
    return NextResponse.json(j, { status: res.status });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed" }, { status: 500 });
  }
}
