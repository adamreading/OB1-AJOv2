import { NextRequest, NextResponse } from "next/server";
import { requireSession, AuthError } from "@/lib/auth";

const API_URL = process.env.NEXT_PUBLIC_API_URL!;

function headers(apiKey: string): HeadersInit {
  return { "x-brain-key": apiKey, "Content-Type": "application/json" };
}

export async function GET(request: NextRequest) {
  let apiKey: string;
  try {
    ({ apiKey } = await requireSession());
  } catch (err) {
    if (err instanceof AuthError)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    throw err;
  }

  const classification = request.nextUrl.searchParams.get("classification");
  const page = request.nextUrl.searchParams.get("page") || "1";

  const sp = new URLSearchParams({
    review_status: "pending_review",
    // NOTE (2026-08-05): select the review queue by review_status ALONE — do NOT filter
    // source_type=plaud. The queue is "everything pending human review", regardless of who
    // wrote it. The old source_type=plaud filter was load-bearing only because MCP writes
    // were mislabelled "plaud" (open-brain-mcp :438/:531); once that hardcode is fixed to the
    // true mcp-<name> source, a source_type filter here would hide those vessels. Decoupled.
    per_page: "50",
    page,
    // This is the logged-in human review surface — it MUST see held escalations so the
    // operator can approve them (with human_authorized via the session). rest-api
    // default-excludes escalations from pending_review pulls to keep them away from
    // autonomous curate turns (regression 2026-07-16); the human path opts back in.
    include_escalations: "true",
  });
  if (classification) sp.set("classification", classification);

  try {
    const res = await fetch(`${API_URL}/thoughts?${sp}`, { headers: headers(apiKey) });
    if (!res.ok) throw new Error(`API ${res.status}`);
    return NextResponse.json(await res.json());
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed" },
      { status: 500 }
    );
  }
}
