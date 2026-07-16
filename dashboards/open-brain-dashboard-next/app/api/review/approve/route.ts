import { NextRequest, NextResponse } from "next/server";
import { requireSession, AuthError } from "@/lib/auth";

const API_URL = process.env.NEXT_PUBLIC_API_URL!;

function headers(apiKey: string): HeadersInit {
  return { "x-brain-key": apiKey, "Content-Type": "application/json" };
}

export async function POST(request: NextRequest) {
  let apiKey: string;
  try {
    ({ apiKey } = await requireSession());
  } catch (err) {
    if (err instanceof AuthError)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    throw err;
  }

  try {
    const { ids } = (await request.json()) as { ids: number[] };
    if (!Array.isArray(ids) || ids.length === 0) {
      return NextResponse.json({ error: "No IDs provided" }, { status: 400 });
    }

    // This route is gated behind requireSession(), so any request that reaches
    // here is a logged-in human (the operator). Assert human_authorized so rest-api will
    // approve escalations (escalate=true + escalation_status=open) from the review
    // walk — the server refuses those for automated callers (e.g. the
    // ob-curate-sweep cron) that don't set this flag.
    const res = await fetch(`${API_URL}/review/approve`, {
      method: "POST",
      headers: headers(apiKey),
      body: JSON.stringify({ ids, human_authorized: true }),
    });
    if (!res.ok) throw new Error(`API ${res.status}`);
    return NextResponse.json(await res.json());
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Approve failed" },
      { status: 500 }
    );
  }
}
