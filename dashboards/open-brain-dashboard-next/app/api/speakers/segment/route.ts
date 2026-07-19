import { NextRequest, NextResponse } from "next/server";
import { requireSession, AuthError } from "@/lib/auth";

const API_URL = process.env.NEXT_PUBLIC_API_URL!;
// WSL voiceprint relabel endpoint (scope 'one' | 'all'): moves the confirmed
// voiceprint(s) into the library, recomputes centroids, and heals the speaker it
// was moved off. Reachable only from this local dashboard server. Per-line
// corrections now DO teach the voiceprint DB (the operator's requirement).
const WSL_RELABEL_URL = process.env.WSL_PIPELINE_RELABEL_URL || "";

// PATCH /api/speakers/segment?recording_id=X&idx=N
//   { resolved_name | null, start_ms?, end_ms? }
// "Just this line" relabel: overrides this ONE segment's speaker in OB AND (when
// start_ms/end_ms + a real name are given) fires WSL /relabel scope:'one' so that
// single turn's voiceprint moves into the named speaker's library + heals the
// mis-attributed cluster.
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
  // ignore = "exclude just THIS line from identification": scope:'one' ignore on
  // WSL (strips only this turn's voiceprint). Does NOT rename the speaker or touch
  // any other segment — fixes the destructive bug where line-Ignore wiped the whole
  // speaker + renamed them "Speaker N".
  const ignore = body.ignore === true;
  const name: string | null = ignore ? null :
    (body.resolved_name === null ? null : (typeof body.resolved_name === "string" ? body.resolved_name.trim() : ""));
  const startMs = Number(body.start_ms), endMs = Number(body.end_ms);

  try {
    // OB write in both cases, but different payloads:
    //  - ignore: leave the label as-is (we're excluding its voiceprint, not
    //    re-attributing the line) and SET the persistent `excluded` flag so the row
    //    keeps a visible "excluded" mark across reloads.
    //  - name:   set the label AND clear `excluded` (naming = identifying, so the line
    //    is back in the identification set).
    const obBody = ignore ? { excluded: true } : { resolved_name: name, excluded: false };
    const res = await fetch(
      `${API_URL}/plaud-recordings/${encodeURIComponent(rid)}/segments/${encodeURIComponent(idx)}`,
      {
        method: "PATCH",
        headers: { "x-brain-key": apiKey, "Content-Type": "application/json" },
        body: JSON.stringify(obBody),
      }
    );
    if (!res.ok) throw new Error(`API ${res.status}`);
    const obResult: unknown = await res.json();

    // WSL scope:'one' — teach (name) or exclude (ignore) exactly this turn.
    let relabel: { attempted: boolean; ok?: boolean; status?: number; moved?: number; removed?: number; ignored?: boolean; error?: string } = { attempted: false };
    const canCall = WSL_RELABEL_URL && Number.isFinite(startMs) && Number.isFinite(endMs) && (ignore || name);
    if (canCall) {
      relabel = { attempted: true };
      const payload = ignore
        ? { recording_id: rid, scope: "one", ignore: true, start_ms: startMs, end_ms: endMs }
        : { recording_id: rid, name, scope: "one", start_ms: startMs, end_ms: endMs };
      try {
        const rr = await fetch(WSL_RELABEL_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(10000),
        });
        relabel.ok = rr.ok;
        relabel.status = rr.status;
        // moved>=1 = a voiceprint moved (name). moved=0 on scope:'one' is EXPECTED
        // (segment <1.2s or crosstalk). removed/ignored = exclude result.
        try {
          const j = await rr.json();
          if (typeof j.moved === "number") relabel.moved = j.moved;
          if (typeof j.removed === "number") relabel.removed = j.removed;
          if (j.ignored === true) relabel.ignored = true;
        } catch { /* non-JSON ok */ }
      } catch (e) {
        relabel.ok = false;
        relabel.error = e instanceof Error ? e.message : "relabel call failed";
      }
    }
    return NextResponse.json({ ...(obResult as object), relabel });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed" }, { status: 500 });
  }
}
