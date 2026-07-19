import { NextRequest, NextResponse } from "next/server";
import { requireSession, AuthError } from "@/lib/auth";

const API_URL = process.env.NEXT_PUBLIC_API_URL!;

// GET /api/speakers — list Plaud recordings for the speaker-review GUI.
// Proxies rest-api GET /plaud-recordings. Behind requireSession (logged-in human).
export async function GET(request: NextRequest) {
  let apiKey: string;
  try {
    ({ apiKey } = await requireSession());
  } catch (err) {
    if (err instanceof AuthError) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    throw err;
  }
  const status = request.nextUrl.searchParams.get("review_status");
  const sp = new URLSearchParams();
  if (status) sp.set("review_status", status);
  try {
    const res = await fetch(`${API_URL}/plaud-recordings?${sp}`, {
      headers: { "x-brain-key": apiKey },
    });
    const text = await res.text();
    if (!res.ok) {
      // Forward the REAL upstream status so the client shows a precise error
      // (401 = auth/key, 5xx = server) instead of a blanket 500.
      return NextResponse.json(
        { error: `upstream ${res.status}`, detail: text.slice(0, 200) },
        { status: res.status }
      );
    }
    return new NextResponse(text, { status: 200, headers: { "content-type": "application/json" } });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed" }, { status: 502 });
  }
}
