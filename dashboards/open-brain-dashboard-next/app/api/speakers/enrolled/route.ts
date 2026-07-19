import { NextResponse } from "next/server";
import { requireSession, AuthError } from "@/lib/auth";

// Enrolled voiceprint names for the rename typeahead (fixes the name/typo
// dup problem — the operator autocompletes an existing name instead of re-typing).
// Proxies the WSL library endpoint, reachable ONLY from this local dashboard.
const WSL_SPEAKERS_URL = process.env.WSL_PIPELINE_SPEAKERS_URL || "";

export async function GET() {
  try {
    await requireSession();
  } catch (err) {
    if (err instanceof AuthError) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    throw err;
  }
  if (!WSL_SPEAKERS_URL) return NextResponse.json({ speakers: [] });
  try {
    const res = await fetch(WSL_SPEAKERS_URL, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return NextResponse.json({ speakers: [] });
    const j = await res.json();
    // Shape: { speakers: [{ name, n_samples }, ...] } most-used first.
    return NextResponse.json({ speakers: Array.isArray(j.speakers) ? j.speakers : [] });
  } catch {
    // Degrade-safe: typeahead just shows no suggestions if the box is unreachable.
    return NextResponse.json({ speakers: [] });
  }
}
