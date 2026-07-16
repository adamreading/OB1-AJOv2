import { NextRequest, NextResponse } from "next/server";
import { requireSession, AuthError } from "@/lib/auth";

const API_URL = process.env.NEXT_PUBLIC_API_URL!;

// Proxy for the unioned "needs your call" feed (rest-api GET /needs-attention):
// open escalations + open classification-reviews, kind-tagged. Powers the
// Thoughts-page "Queries" switch. Read-only; forwards ?kind through.
export async function GET(req: NextRequest) {
  let apiKey: string;
  try {
    ({ apiKey } = await requireSession());
  } catch (err) {
    if (err instanceof AuthError)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    throw err;
  }

  const kind = req.nextUrl.searchParams.get("kind");
  const qs = kind ? `?kind=${encodeURIComponent(kind)}` : "";
  try {
    const res = await fetch(`${API_URL}/needs-attention${qs}`, {
      headers: { "x-brain-key": apiKey },
      cache: "no-store",
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return NextResponse.json({ error: text || res.statusText }, { status: res.status });
    }
    return NextResponse.json(await res.json());
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed" },
      { status: 500 }
    );
  }
}
