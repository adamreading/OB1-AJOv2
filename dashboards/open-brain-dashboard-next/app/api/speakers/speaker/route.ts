import { NextRequest, NextResponse } from "next/server";
import { requireSession, AuthError } from "@/lib/auth";

const API_URL = process.env.NEXT_PUBLIC_API_URL!;
// WSL voiceprint endpoints, reachable ONLY from this local dashboard server (the
// box can reach WSL; the rest-api Edge Function cannot). /relabel (scope 'all')
// supersedes /enrol — it moves the cluster's voiceprints into the named library,
// recomputes centroids, and heals the moved-off speaker. Fall back to /enrol if
// relabel isn't configured. Unset both ⇒ labels update in OB, no voiceprint learning.
const WSL_RELABEL_URL = process.env.WSL_PIPELINE_RELABEL_URL || "";
const WSL_ENROL_URL = process.env.WSL_PIPELINE_ENROL_URL || "";

// PATCH /api/speakers/speaker?recording_id=X&speaker_key=S1  { resolved_name | null }
// "All instances of Speaker X" relabel. When a real name is set this DOUBLES as
// enrolment (the operator's spec): OB labels update AND that speaker's turns' voiceprints
// join the WSL library under the name. Biometric enrolment happens ON-BOX; OB only
// records that it was enrolled.
export async function PATCH(request: NextRequest) {
  let apiKey: string;
  try {
    ({ apiKey } = await requireSession());
  } catch (err) {
    if (err instanceof AuthError) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    throw err;
  }
  const rid = request.nextUrl.searchParams.get("recording_id");
  const key = request.nextUrl.searchParams.get("speaker_key");
  if (!rid || !key) return NextResponse.json({ error: "recording_id + speaker_key required" }, { status: 400 });
  const body = await request.json().catch(() => ({}));
  // "Ignore / not a tracked person": adds nothing to the library AND strips any
  // print already learned from this speaker's turns. No name.
  const ignore = body.ignore === true;
  const name: string | null = ignore ? null :
    (body.resolved_name === null ? null : (typeof body.resolved_name === "string" ? body.resolved_name.trim() : ""));
  if (!ignore && name === "") return NextResponse.json({ error: "resolved_name (string) or null required" }, { status: 400 });

  // A named bulk-rename marks the speaker enrolled and clears per-segment overrides.
  const doEnrol = name !== null;
  try {
    const res = await fetch(
      `${API_URL}/plaud-recordings/${encodeURIComponent(rid)}/speakers/${encodeURIComponent(key)}?clear_overrides=1`,
      {
        method: "PATCH",
        headers: { "x-brain-key": apiKey, "Content-Type": "application/json" },
        // Ignore clears the OB label (untracked → shows as Speaker N), un-enrols, AND
        // sets the whole-speaker `excluded` flag so the review LLM disregards their content.
        // Naming a speaker re-includes them (excluded:false) — a named person is tracked.
        body: JSON.stringify({ resolved_name: name, enrolled: ignore ? false : doEnrol, excluded: ignore }),
      }
    );
    if (!res.ok) throw new Error(`API ${res.status}`);
    const obResult = await res.json();

    // Fire the on-box voiceprint action (best-effort). Prefer /relabel scope:'all'
    // (moves the cluster's voiceprints + recomputes centroids + heals moved-off, OR
    // with ignore:true strips any learned print); fall back to /enrol for a name.
    // `key` is the raw pipeline speaker_key (S1/UNID), exactly what /relabel expects.
    const target = WSL_RELABEL_URL || WSL_ENROL_URL;
    let enrolment: { attempted: boolean; ok?: boolean; status?: number; moved?: number; ignored?: boolean; removed?: number; via?: string; error?: string } = { attempted: false };
    const shouldCall = ignore ? !!WSL_RELABEL_URL : (doEnrol && !!target);
    if (shouldCall) {
      const via = ignore ? "relabel-ignore" : (WSL_RELABEL_URL ? "relabel" : "enrol");
      enrolment = { attempted: true, via };
      const payload = ignore
        ? { recording_id: rid, scope: "all", ignore: true, speaker_key: key }
        : (WSL_RELABEL_URL
          ? { recording_id: rid, name, scope: "all", speaker_key: key }
          : { recording_id: rid, speaker_key: key, name });
      try {
        const er = await fetch(ignore ? WSL_RELABEL_URL : target, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(10000),
        });
        enrolment.ok = er.ok;
        enrolment.status = er.status;
        try {
          const j = await er.json();
          if (typeof j.moved === "number") enrolment.moved = j.moved;
          if (typeof j.removed === "number") enrolment.removed = j.removed;
          if (j.ignored === true) enrolment.ignored = true;
        } catch { /* non-JSON ok */ }
      } catch (e) {
        enrolment.ok = false;
        enrolment.error = e instanceof Error ? e.message : "learn call failed";
      }
    }
    return NextResponse.json({ ...obResult, enrolment });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed" }, { status: 500 });
  }
}
