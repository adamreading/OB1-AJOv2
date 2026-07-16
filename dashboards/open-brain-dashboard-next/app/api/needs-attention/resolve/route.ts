import { NextRequest, NextResponse } from "next/server";
import { requireSession, AuthError } from "@/lib/auth";

const API_URL = process.env.NEXT_PUBLIC_API_URL!;

// Resolve a classification "query" inline from the Thoughts-page Queries switch:
// the operator's work/personal call -> rest-api PATCH /thought/:id/classification-review.
// This is behind a logged-in session (requireSession) so it's a human-DIRECTED
// action. Escalation-kind rows are NOT resolved here — they route to /review
// where the full (human-gated) approve/answer/drop flow lives.
export async function POST(req: NextRequest) {
  let apiKey: string;
  try {
    ({ apiKey } = await requireSession());
  } catch (err) {
    if (err instanceof AuthError)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    throw err;
  }

  const body = await req.json().catch(() => ({}));
  const id = body?.id;
  const classification = body?.classification;
  if (id == null || (classification !== "work" && classification !== "personal")) {
    return NextResponse.json(
      { error: "id and classification ('work'|'personal') are required" },
      { status: 400 }
    );
  }

  try {
    const res = await fetch(`${API_URL}/thought/${encodeURIComponent(String(id))}/classification-review`, {
      method: "PATCH",
      headers: { "x-brain-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ classification }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return NextResponse.json(
        { error: (data as { error?: string }).error || res.statusText },
        { status: res.status }
      );
    }
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed" },
      { status: 500 }
    );
  }
}
