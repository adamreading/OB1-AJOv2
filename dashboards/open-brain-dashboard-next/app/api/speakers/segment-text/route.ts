import { NextRequest, NextResponse } from "next/server";
import { requireSession, AuthError } from "@/lib/auth";

const API_URL = process.env.NEXT_PUBLIC_API_URL!;

// PATCH /api/speakers/segment-text?recording_id=X&idx=N   { text }
// Correct ONE utterance's transcript TEXT. Writes { text, text_edited: true } to the
// OB segment row and NOTHING else — no speaker relabel, no WSL voiceprint call: a text
// correction is orthogonal to who spoke. `text_edited` marks the row as the operator's
// prose so the WSL re-ingest carry preserves it and terra reads the corrected text on
// Release. Renaming the line later will NOT clear this flag (handled server-side —
// a rename PATCH doesn't send text_edited).
export async function PATCH(request: NextRequest) {
  let apiKey: string;
  try {
    ({ apiKey } = await requireSession());
  } catch (err) {
    if (err instanceof AuthError) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    throw err;
  }
  const rid = request.nextUrl.searchParams.get("recording_id");
  const idx = request.nextUrl.searchParams.get("idx");
  if (!rid || idx === null) return NextResponse.json({ error: "recording_id + idx required" }, { status: 400 });
  const body = await request.json().catch(() => ({}));
  if (typeof body.text !== "string") return NextResponse.json({ error: "text (string) required" }, { status: 400 });

  try {
    const res = await fetch(
      `${API_URL}/plaud-recordings/${encodeURIComponent(rid)}/segments/${encodeURIComponent(idx)}`,
      {
        method: "PATCH",
        headers: { "x-brain-key": apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({ text: body.text, text_edited: true }),
      }
    );
    if (!res.ok) throw new Error(`API ${res.status}`);
    return NextResponse.json(await res.json());
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed" }, { status: 500 });
  }
}
