"use client";

import { useCallback, useEffect, useMemo, useRef, useState, Suspense } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";

type RecordingSummary = {
  recording_id: string;
  title: string | null;
  started_at: string | null;
  duration_ms: number | null;
  review_status: string;
  created_at: string;
};
type Speaker = {
  recording_id: string;
  speaker_key: string;
  resolved_name: string | null;
  match_confidence: number | null;
  enrolled: boolean;
};
type Segment = {
  recording_id: string;
  idx: number;
  start_ms: number;
  end_ms: number;
  speaker_key: string;
  resolved_name_override: string | null;
  match_confidence: number | null;
  overlap: number | null;   // 0..1 fraction of the turn with 2+ speakers; null = unscored
  excluded?: boolean;       // persistent "exclude from identification" flag (manual or gated)
  text_edited?: boolean;    // persistent "transcript text hand-corrected by the operator" flag
  text: string | null;
};

type Hint = { id: number | string; phrase: string; context: string; misheard: string };
type AdminSpeaker = { id: number | string; name: string; context: string; n_samples: number };

// Two overlap thresholds (the operator's spec):
//  - TEACH_GATE (0.10): at/above this, the turn won't teach the voice library →
//    a subtle "won't teach" flag so he can SEE what's excluded by the gate.
//  - OVERLAP_GATE (0.40): clearly mixed voices → the louder amber ⚠ badge.
const TEACH_GATE = 0.10;
const OVERLAP_GATE = 0.40;
type Detail = {
  recording: RecordingSummary & { transcript_text: string | null; audio_ref: string | null };
  speakers: Speaker[];
  segments: Segment[];
};

const SPEAKER_COLORS = [
  "#7c9cff", "#ff9c7c", "#7cffb0", "#e07cff", "#ffd67c", "#7ce0ff", "#ff7ca8", "#b0ff7c",
];

// Clean the raw folder-name title ("2026-07-07_07-07_Tesla_Update__31682213")
// into something readable: drop the leading date/time prefix + trailing __id,
// underscores → spaces.
function prettyTitle(raw: string): string {
  let t = raw.replace(/^\d{4}-\d{2}-\d{2}[_-]\d{2}-\d{2}[_-]?/, "");
  t = t.replace(/__[0-9a-f]{6,}$/i, "");
  t = t.replace(/_/g, " ").trim();
  return t || raw;
}

function fmtTime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

function SpeakersInner() {
  const searchParams = useSearchParams();
  const [recordings, setRecordings] = useState<RecordingSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<string>("");
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [activeIdx, setActiveIdx] = useState<number | null>(null);

  // Rename UI state
  const [renaming, setRenaming] = useState<{ speakerKey: string; idx: number | null } | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [enrolledNames, setEnrolledNames] = useState<{ name: string; n_samples: number }[]>([]);

  // Which recordings to list. Default "pending" (the review queue). "reviewed" lets
  // the operator get back to a released recording to correct speakers (re-analysis path);
  // "all" shows everything.
  const [filter, setFilter] = useState<"pending" | "reviewed" | "all">("pending");
  const [refreshing, setRefreshing] = useState(false);

  // Per-line transcript-text edit (pencil). editingText = idx being edited.
  const [editingText, setEditingText] = useState<number | null>(null);
  const [editTextValue, setEditTextValue] = useState("");

  // Corrections admin panel (speaker Work/Personal + STT hints). Dashboard-only,
  // proxies to the WSL /admin/* endpoints.
  const [showCorrections, setShowCorrections] = useState(false);
  const [adminSpeakers, setAdminSpeakers] = useState<AdminSpeaker[]>([]);
  const [hints, setHints] = useState<Hint[]>([]);
  const [adminConfigured, setAdminConfigured] = useState(true);
  const [adminBusy, setAdminBusy] = useState(false);
  const [newHint, setNewHint] = useState<{ phrase: string; misheard: string; context: "work" | "personal" | "all" }>({ phrase: "", misheard: "", context: "all" });

  const loadRecordings = useCallback(async (which: "pending" | "reviewed" | "all" = filter) => {
    const qs = which === "all" ? "" : `?review_status=${which === "reviewed" ? "reviewed" : "pending_review"}`;
    try {
      const res = await fetch(`/api/speakers${qs}`);
      if (!res.ok) {
        setStatus(`List load failed (${res.status}) — will retry`);
        return [];
      }
      const j = await res.json();
      setRecordings(j.recordings ?? []);
      setStatus((s) => (s.startsWith("Couldn't reach") || s.startsWith("List load failed") ? "" : s));
      return j.recordings ?? [];
    } catch (e) {
      // Network error ("Failed to fetch") — e.g. the server was momentarily down
      // (a restart) or the connection blipped. Do NOT clear the list; surface a
      // retry note and let the 30s poll recover. Previously this threw unhandled
      // and left the list permanently empty.
      setStatus(`Couldn't reach server — retrying (${e instanceof Error ? e.message : "network error"})`);
      return [];
    }
  }, [filter]);

  const loadDetail = useCallback(async (rid: string) => {
    setLoading(true);
    setStatus("");
    setActiveIdx(null);
    try {
      const res = await fetch(`/api/speakers/detail?recording_id=${encodeURIComponent(rid)}`);
      if (res.ok) setDetail(await res.json());
      else setStatus(`Failed to load recording (${res.status})`);
    } catch (e) {
      setStatus(`Couldn't reach server (${e instanceof Error ? e.message : "network error"})`);
    } finally {
      setLoading(false);
    }
  }, []);

  // Mount: only auto-open a recording if it was deep-linked (?recording_id=).
  // Otherwise land on the LIST — critical for mobile single-pane, where auto-
  // opening a detail would hide the list + filters (the phone-review bug).
  useEffect(() => {
    const deep = searchParams.get("recording_id");
    if (deep) {
      setSelectedId(deep);
      loadDetail(deep);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Refetch the list when the filter changes, and poll every 30s so recordings
  // ingested after the page opened appear without a manual reload (the original
  // bug: the list loaded once on mount and never saw new recordings).
  useEffect(() => {
    loadRecordings(filter);
    const t = setInterval(() => loadRecordings(filter), 30000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter]);

  const manualRefresh = useCallback(async () => {
    setRefreshing(true);
    try { await loadRecordings(filter); } finally { setRefreshing(false); }
  }, [loadRecordings, filter]);

  // Load enrolled voiceprint names for the rename typeahead when the modal opens
  // (autocomplete to an existing name → stops name/typo-style duplicate speakers).
  useEffect(() => {
    if (!renaming) return;
    fetch("/api/speakers/enrolled")
      .then((r) => (r.ok ? r.json() : { speakers: [] }))
      .then((j) => setEnrolledNames(Array.isArray(j.speakers) ? j.speakers : []))
      .catch(() => setEnrolledNames([]));
  }, [renaming]);

  // Stable "Speaker N" numbering from sorted distinct speaker keys.
  const speakerDisplay = useMemo(() => {
    const map = new Map<string, { num: number; color: string; name: string | null; enrolled: boolean; confidence: number | null }>();
    if (!detail) return map;
    const keys = [...detail.speakers].sort((a, b) => a.speaker_key.localeCompare(b.speaker_key, undefined, { numeric: true }));
    keys.forEach((sp, i) => {
      map.set(sp.speaker_key, {
        num: i + 1,
        color: SPEAKER_COLORS[i % SPEAKER_COLORS.length],
        name: sp.resolved_name,
        enrolled: sp.enrolled,
        confidence: sp.match_confidence,
      });
    });
    return map;
  }, [detail]);

  const labelFor = useCallback(
    (seg: Segment): string => {
      if (seg.resolved_name_override) return seg.resolved_name_override;
      const sp = speakerDisplay.get(seg.speaker_key);
      if (sp?.name) return sp.name;
      return `Speaker ${sp?.num ?? "?"}`;
    },
    [speakerDisplay]
  );

  const seekTo = useCallback((seg: Segment) => {
    const a = audioRef.current;
    if (!a) return;
    a.currentTime = seg.start_ms / 1000;
    a.play().catch(() => {});
    setActiveIdx(seg.idx);
  }, []);

  const submitRename = useCallback(
    async (scope: "instance" | "all" | "ignore") => {
      if (!renaming || !detail) return;
      const rid = detail.recording.recording_id;
      const name = renameValue.trim();
      if (scope !== "ignore" && !name) return;
      setStatus("Saving…");
      // Soft-describe the voiceprint result. moved>=1 = a snippet was moved +
      // centroids recomputed. moved=0 is NOT a failure (segment too short / mixed
      // voices — the text relabel is still correct). removed = prints stripped (ignore).
      const learnNote = (v?: { attempted?: boolean; ok?: boolean; moved?: number; ignored?: boolean; removed?: number }) => {
        if (!v?.attempted) return "";
        if (v.ignored) return v.removed ? ` · ignored, ${v.removed} voiceprint(s) removed` : " · ignored (nothing was learned)";
        if (v.moved && v.moved >= 1) return ` · voice learned ✓ (${v.moved})`;
        if (v.ok) return " · named (too short/mixed voices to learn)";
        return " · named (voice-learn unavailable)";
      };
      const isLine = renaming.idx !== null;
      try {
        // LINE-level: rename this line, OR exclude JUST this line (scope 'one').
        // Ignore-from-a-line must NOT touch the speaker (the destructive-wipe bug).
        if ((scope === "instance" || (scope === "ignore" && isLine)) && renaming.idx !== null) {
          const seg = detail.segments.find((s) => s.idx === renaming.idx);
          const body = scope === "ignore"
            ? { ignore: true, start_ms: seg?.start_ms, end_ms: seg?.end_ms }
            : { resolved_name: name, start_ms: seg?.start_ms, end_ms: seg?.end_ms };
          const res = await fetch(
            `/api/speakers/segment?recording_id=${encodeURIComponent(rid)}&idx=${renaming.idx}`,
            { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
          );
          if (res.ok) { const j = await res.json(); setStatus(`${scope === "ignore" ? "Excluded this line" : "Renamed this line"}${learnNote(j.relabel)}`); }
          else setStatus(`${scope === "ignore" ? "Exclude" : "Rename"} failed (${res.status})`);
        } else {
          // SPEAKER-level: name all turns, OR ignore the whole speaker (chip context).
          const res = await fetch(
            `/api/speakers/speaker?recording_id=${encodeURIComponent(rid)}&speaker_key=${encodeURIComponent(renaming.speakerKey)}`,
            { method: "PATCH", headers: { "Content-Type": "application/json" },
              body: JSON.stringify(scope === "ignore" ? { ignore: true } : { resolved_name: name }) }
          );
          if (res.ok) {
            const j = await res.json();
            setStatus(scope === "ignore" ? `Speaker ignored${learnNote(j.enrolment)}` : `Renamed all turns${learnNote(j.enrolment)}`);
          } else setStatus(`${scope === "ignore" ? "Ignore" : "Rename"} failed (${res.status})`);
        }
        setRenaming(null);
        setRenameValue("");
        await loadDetail(rid);
      } catch (e) {
        setStatus(e instanceof Error ? e.message : "Action failed");
      }
    },
    [renaming, renameValue, detail, loadDetail]
  );

  // Save a per-line transcript-text correction. Orthogonal to identity — sets
  // text + text_edited only, no speaker relabel / voiceprint call.
  const saveText = useCallback(async (idx: number) => {
    if (!detail) return;
    const rid = detail.recording.recording_id;
    setStatus("Saving text…");
    try {
      const res = await fetch(
        `/api/speakers/segment-text?recording_id=${encodeURIComponent(rid)}&idx=${idx}`,
        { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: editTextValue }) }
      );
      if (res.ok) { setStatus("Text corrected ✓"); setEditingText(null); await loadDetail(rid); }
      else setStatus(`Text save failed (${res.status})`);
    } catch (e) {
      setStatus(e instanceof Error ? e.message : "Text save failed");
    }
  }, [detail, editTextValue, loadDetail]);

  // Corrections admin — load / mutate the WSL /admin/* data via the proxies.
  const loadAdmin = useCallback(async () => {
    setAdminBusy(true);
    try {
      const [sp, hi] = await Promise.all([
        fetch("/api/speakers/admin/speakers").then((r) => r.json()).catch(() => ({ speakers: [] })),
        fetch("/api/speakers/admin/hints").then((r) => r.json()).catch(() => ({ hints: [] })),
      ]);
      setAdminSpeakers(sp.speakers ?? []);
      setHints(hi.hints ?? []);
      setAdminConfigured(sp.configured !== false);
    } finally {
      setAdminBusy(false);
    }
  }, []);

  const setSpeakerContext = useCallback(async (sp: AdminSpeaker, context: "work" | "personal") => {
    setAdminSpeakers((prev) => prev.map((s) => (s.id === sp.id ? { ...s, context } : s))); // optimistic
    await fetch("/api/speakers/admin/speakers", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: sp.id, name: sp.name, context }),
    }).catch(() => {});
  }, []);

  const addHint = useCallback(async () => {
    const phrase = newHint.phrase.trim(), misheard = newHint.misheard.trim();
    if (!phrase || !misheard) { setStatus("A hint needs both the correct phrase and the misheard form(s)."); return; }
    setAdminBusy(true);
    try {
      const res = await fetch("/api/speakers/admin/hints", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phrase, misheard, context: newHint.context }),
      });
      if (res.ok) { setNewHint({ phrase: "", misheard: "", context: "all" }); await loadAdmin(); }
      else setStatus(`Add hint failed (${res.status})`);
    } finally { setAdminBusy(false); }
  }, [newHint, loadAdmin]);

  const deleteHint = useCallback(async (id: Hint["id"]) => {
    setHints((prev) => prev.filter((h) => h.id !== id)); // optimistic
    await fetch(`/api/speakers/admin/hints?id=${encodeURIComponent(String(id))}`, { method: "DELETE" }).catch(() => {});
  }, []);

  // Open the corrections panel, optionally pre-filling the misheard word from a
  // transcript line ("fix transcription" shortcut).
  const openCorrections = useCallback((prefillMisheard?: string) => {
    setShowCorrections(true);
    if (prefillMisheard) setNewHint((h) => ({ ...h, misheard: prefillMisheard }));
    loadAdmin();
  }, [loadAdmin]);

  const releaseForAnalysis = useCallback(async () => {
    if (!detail) return;
    const rid = detail.recording.recording_id;
    setStatus("Releasing…");
    const res = await fetch(`/api/speakers/detail?recording_id=${encodeURIComponent(rid)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ review_status: "reviewed" }),
    });
    if (res.ok) {
      const j = await res.json();
      const a = j.analysis?.attempted
        ? j.analysis.ok ? " · analysis triggered ✓ (entries will land in Review)" : " · analysis trigger failed (released; re-run manually)"
        : " · (analysis endpoint not configured)";
      setStatus(`Released${a}`);
      // Released → it leaves the pending queue. Drop the selection so it visibly
      // clears, then advance to the next pending recording if there is one.
      const remaining = (await loadRecordings(filter)).filter(
        (r: RecordingSummary) => r.recording_id !== rid
      );
      if (filter === "pending") {
        const next = remaining[0]?.recording_id ?? null;
        setSelectedId(next);
        if (next) loadDetail(next); else setDetail(null);
      }
    } else {
      setStatus(`Release failed (${res.status})`);
    }
  }, [detail, loadRecordings, filter, loadDetail]);

  return (
    <div className="p-4 sm:p-6 max-w-[1400px] mx-auto overflow-x-hidden">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-2xl font-semibold">
            Speakers <span className="text-xs font-normal opacity-50">build m6 · {recordings.length} loaded</span>
          </h1>
          <p className="text-sm opacity-60">Review transcripts, confirm who spoke, enrol voices into the library.</p>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <button onClick={() => openCorrections()} title="Speaker Work/Personal context + fix recurring mistranscriptions (e.g. 'Remzi' heard as 'Randy')"
            className="text-sm px-2.5 py-1.5 rounded border border-white/15 opacity-80 hover:opacity-100 whitespace-nowrap">
            ⚙ Corrections
          </button>
          <Link href="/review" className="text-sm opacity-70 hover:opacity-100 underline whitespace-nowrap">→ Thought review</Link>
        </div>
      </div>

      <div className="grid grid-cols-[280px_1fr] gap-4 mobile-stack">
        {/* Recordings list — on mobile, shown only when nothing is selected (single-pane) */}
        {/* NB: this is a <div>, NOT <aside> — globals.css hides ALL <aside> on mobile
            (that rule is for the nav sidebar; it was blanking this recordings list on
            phone, the zero-rows blocker). */}
        <div className={`border border-white/10 rounded-lg overflow-hidden self-start ${selectedId ? "hidden md:block" : "block"}`}>
          <div className="px-3 py-2 border-b border-white/10">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs uppercase tracking-wide opacity-50">Recordings ({recordings.length})</span>
              <button onClick={manualRefresh} title="Refresh list" className="text-xs opacity-60 hover:opacity-100">
                {refreshing ? "…" : "↻"}
              </button>
            </div>
            <div className="flex gap-1">
              {(["pending", "reviewed", "all"] as const).map((f) => (
                <button key={f} onClick={() => setFilter(f)}
                  className={`text-xs px-2 py-0.5 rounded-full border ${filter === f ? "bg-white/15 border-white/30" : "border-white/10 opacity-60 hover:opacity-100"}`}>
                  {f}
                </button>
              ))}
            </div>
            {/* Status/errors surfaced HERE so they're visible on the mobile list view
                (the detail pane is hidden on mobile when nothing is selected). */}
            {status && <div className="text-xs mt-2 opacity-80 break-words">{status}</div>}
          </div>
          <ul className="max-h-[70vh] overflow-y-auto">
            {recordings.map((r) => (
              <li key={r.recording_id}>
                <button
                  onClick={() => { setSelectedId(r.recording_id); loadDetail(r.recording_id); }}
                  className={`w-full text-left px-3 py-2 text-sm border-b border-white/5 hover:bg-white/5 ${selectedId === r.recording_id ? "bg-white/10" : ""}`}
                >
                  <div className="truncate">{prettyTitle(r.title || r.recording_id)}</div>
                  <div className="text-xs opacity-50">
                    {r.duration_ms ? fmtTime(r.duration_ms) : "—"} · {new Date(r.created_at).toLocaleDateString()}
                  </div>
                </button>
              </li>
            ))}
            {recordings.length === 0 && <li className="px-3 py-4 text-sm opacity-50">No {filter === "all" ? "" : filter + " "}recordings.</li>}
          </ul>
        </div>

        {/* Detail — on mobile, shown only when a recording is selected (single-pane).
            min-w-0 is load-bearing: without it this 1fr grid child blows out its track
            past the viewport (the horizontal-overflow bug). */}
        <section className={`min-w-0 ${selectedId ? "block" : "hidden md:block"}`}>
          {loading && <div className="opacity-60 text-sm">Loading…</div>}
          {!loading && !detail && <div className="opacity-60 text-sm">Select a recording.</div>}
          {detail && (
            <div className="max-w-3xl">
              {/* Sticky header: back (mobile) + title + ONE player + speaker legend.
                  One audio element for the whole recording; rows just seek it. */}
              <div className="sticky top-0 z-10 bg-[var(--bg-0,#0b0b0f)] pb-3 mb-3 border-b border-white/10">
                <div className="flex items-center gap-2 mb-2 min-w-0">
                  <button onClick={() => { setSelectedId(null); setDetail(null); }} title="Back to recordings" className="md:hidden text-sm px-2 py-1 rounded border border-white/15 opacity-80 hover:opacity-100 shrink-0">
                    ←
                  </button>
                  <h2 className="text-sm font-medium truncate min-w-0 flex-1" title={detail.recording.title || detail.recording.recording_id}>
                    {prettyTitle(detail.recording.title || detail.recording.recording_id)}
                  </h2>
                  <button onClick={releaseForAnalysis} title="Confirm the speakers are correct and release this recording for analysis" className="text-xs px-2.5 py-1.5 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 hover:bg-emerald-500/25 whitespace-nowrap shrink-0">
                    Release
                  </button>
                </div>
                <audio ref={audioRef} controls preload="metadata" className="w-full max-w-full h-9"
                       src={`/api/speakers/audio?recording_id=${encodeURIComponent(detail.recording.recording_id)}`} />
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {[...speakerDisplay.entries()].map(([key, sp]) => (
                    <button key={key}
                      onClick={() => { setRenaming({ speakerKey: key, idx: null }); setRenameValue(sp.name || ""); }}
                      className={`text-xs px-2 py-1 rounded-full border flex items-center gap-1.5 ${sp.name ? "" : "border-dashed"}`}
                      style={{ borderColor: sp.color, color: sp.color }}
                      title={sp.name ? "Rename / re-enrol this speaker" : "Unknown speaker — tap to name + enrol"}>
                      <span className="w-2 h-2 rounded-full inline-block shrink-0" style={{ background: sp.color }} />
                      <span className="truncate max-w-[10rem]">{sp.name || `Speaker ${sp.num}`}</span>
                      {sp.enrolled && <span title="enrolled">◆</span>}
                      {sp.name ? (sp.confidence != null && <span className="opacity-50">{Math.round(sp.confidence * 100)}%</span>)
                               : <span className="opacity-70">· name?</span>}
                    </button>
                  ))}
                </div>
                {status && <div className="text-xs mt-2 opacity-80 break-words">{status}</div>}
              </div>

              {/* Utterance blocks. Gutter (speaker+time+seek) sits left of the wrapping
                  text on ≥sm; on mobile it collapses ABOVE the text (single column).
                  Text is min-w-0 + break-words so nothing overflows horizontally. */}
              <div className="flex flex-col gap-1">
                {detail.segments.map((seg) => {
                  const sp = speakerDisplay.get(seg.speaker_key);
                  const color = sp?.color ?? "#888";
                  const isActive = activeIdx === seg.idx;
                  const excluded = seg.excluded === true;                       // persistent manual/gated exclude
                  const mixed = !excluded && seg.overlap != null && seg.overlap >= OVERLAP_GATE;
                  const wontTeach = !excluded && seg.overlap != null && seg.overlap >= TEACH_GATE && seg.overlap < OVERLAP_GATE;
                  const unknown = !sp?.name;
                  return (
                    <div key={seg.idx}
                      className={`group relative rounded-lg px-3 py-2 grid grid-cols-1 sm:grid-cols-[132px_1fr] gap-x-3 gap-y-1 ${isActive ? "bg-white/10" : "hover:bg-white/5"}`}>
                      {/* gutter */}
                      <div className="flex items-center gap-2 min-w-0 sm:flex-col sm:items-start sm:gap-0.5">
                        <button onClick={() => seekTo(seg)} className="flex items-center gap-1.5 text-xs font-semibold min-w-0" style={{ color }} title="Play from here">
                          <span className="w-2 h-2 rounded-full inline-block shrink-0" style={{ background: color }} />
                          <span className="truncate">{labelFor(seg)}</span>
                        </button>
                        <div className="flex items-center gap-1.5 shrink-0">
                          <span className="text-[11px] font-mono opacity-50 tabular-nums">{fmtTime(seg.start_ms)}</span>
                          <button onClick={() => seekTo(seg)} title="Play from here"
                            className="w-4 h-4 rounded-full border border-white/15 grid place-items-center text-[8px] opacity-60 hover:opacity-100 hover:border-emerald-400 shrink-0">▶</button>
                        </div>
                      </div>
                      {/* text — inline textarea editor when this line is being corrected */}
                      <div className="min-w-0 pr-14">
                        {editingText === seg.idx ? (
                          <div className="flex flex-col gap-1.5">
                            <textarea autoFocus value={editTextValue} onChange={(e) => setEditTextValue(e.target.value)}
                              onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) saveText(seg.idx); if (e.key === "Escape") setEditingText(null); }}
                              rows={Math.min(8, Math.max(2, Math.ceil(((editTextValue.length || 40) + 1) / 60)))}
                              className="w-full px-2 py-1.5 rounded bg-black/40 border border-white/20 text-sm leading-relaxed outline-none focus:border-white/50 resize-y" />
                            <div className="flex items-center gap-2 flex-wrap">
                              <button onClick={() => saveText(seg.idx)} className="text-xs px-2.5 py-1 rounded bg-emerald-500/20 border border-emerald-500/40 text-emerald-200 hover:bg-emerald-500/30">Save text</button>
                              <button onClick={() => setEditingText(null)} className="text-xs px-2.5 py-1 rounded border border-white/15 opacity-70 hover:opacity-100">Cancel</button>
                              <span className="text-[10px] opacity-40 whitespace-nowrap">⌘/Ctrl+Enter saves · Esc cancels</span>
                            </div>
                          </div>
                        ) : (
                          <button onClick={() => seekTo(seg)} className={`text-left text-sm leading-relaxed break-words w-full block ${unknown ? "opacity-70" : ""}`}>
                            {seg.text}
                            {seg.text_edited && (
                              <span className="ml-2 align-[1px] whitespace-nowrap text-[10.5px] font-mono px-1.5 py-0.5 rounded-full bg-violet-500/10 text-violet-300 border border-violet-500/30"
                                title="Transcript text hand-corrected by you (saved). Preserved on re-ingest and used in analysis.">
                                ✎ edited
                              </span>
                            )}
                            {excluded && (
                              <span className="ml-2 align-[1px] whitespace-nowrap text-[10.5px] font-mono px-1.5 py-0.5 rounded-full bg-sky-500/10 text-sky-300 border border-sky-500/30"
                                title="Excluded from voice identification — this turn won't teach the voice library (saved). Rename it to re-include.">
                                ⊘ excluded
                              </span>
                            )}
                            {mixed && (
                              <span className="ml-2 align-[1px] whitespace-nowrap text-[10.5px] font-mono px-1.5 py-0.5 rounded-full bg-amber-500/10 text-amber-300 border border-amber-500/30"
                                title="Two or more people speak over this line — it won't teach the voice library">
                                ⚠ mixed {seg.overlap!.toFixed(2)}
                              </span>
                            )}
                            {wontTeach && (
                              <span className="ml-2 align-[1px] whitespace-nowrap text-[10px] opacity-45"
                                title={`Some overlap (${seg.overlap!.toFixed(2)}) — above the ${TEACH_GATE} teaching gate, so this line won't teach the voice library`}>
                                · won't teach
                              </span>
                            )}
                          </button>
                        )}
                      </div>
                      {/* action cluster — pencil (edit transcript text) + kebab (speaker).
                          Always tappable (mobile has no hover). Hidden while editing. */}
                      {editingText !== seg.idx && (
                        <div className="absolute top-1.5 right-1.5 flex items-center gap-0.5">
                          <button
                            onClick={() => { setEditingText(seg.idx); setEditTextValue(seg.text ?? ""); }}
                            className="w-6 h-6 rounded grid place-items-center text-xs opacity-50 group-hover:opacity-100 hover:bg-white/10 border border-transparent hover:border-white/15"
                            title="Edit this line's transcript text">✎</button>
                          <button
                            onClick={() => { setRenaming({ speakerKey: seg.speaker_key, idx: seg.idx }); setRenameValue(labelFor(seg)); }}
                            className="w-6 h-6 rounded grid place-items-center text-sm opacity-50 group-hover:opacity-100 hover:bg-white/10 border border-transparent hover:border-white/15"
                            title="Rename / correct this line's speaker">⋯</button>
                        </div>
                      )}
                    </div>
                  );
                })}
                {detail.segments.length === 0 && <div className="opacity-50 text-sm">No segments.</div>}
              </div>
            </div>
          )}
        </section>
      </div>

      {/* Rename modal */}
      {renaming && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={() => setRenaming(null)}>
          <div className="bg-[var(--bg-1,#15151c)] border border-white/15 rounded-lg p-5 w-[420px] max-w-[90vw]" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-base font-medium mb-1">Who is this?</h3>
            <p className="text-xs opacity-60 mb-3">
              {renaming.idx !== null
                ? 'Fix just this one line (if it was mis-attributed), or apply the name to every turn of this speaker. Both teach the voice library so future recordings recognise them.'
                : 'Name every turn of this speaker across the recording. This teaches the voice library so future recordings recognise them automatically.'}
            </p>
            {renaming.idx !== null && (() => {
              const seg = detail?.segments.find((s) => s.idx === renaming.idx);
              return seg && seg.overlap != null && seg.overlap >= OVERLAP_GATE ? (
                <p className="text-xs text-amber-400/90 mb-3">⚠ This line has mixed voices — the name will be saved, but no voiceprint will be learned from it.</p>
              ) : null;
            })()}
            <input autoFocus value={renameValue} onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") submitRename(renaming.idx !== null ? "instance" : "all"); }}
              placeholder="Start typing — pick an existing name or add a new one"
              list="enrolled-speakers"
              autoComplete="off"
              className="w-full px-3 py-2 rounded bg-black/30 border border-white/15 text-sm mb-1 outline-none focus:border-white/40" />
            <datalist id="enrolled-speakers">
              {enrolledNames.map((s) => <option key={s.name} value={s.name}>{`${s.name} (${s.n_samples})`}</option>)}
            </datalist>
            <p className="text-[11px] opacity-40 mb-4">
              {enrolledNames.length ? `Autocompletes from ${enrolledNames.length} known voices — pick one to avoid duplicates.` : "Type a name."}
            </p>
            <div className="flex gap-2 justify-end flex-wrap">
              <button onClick={() => setRenaming(null)} className="text-xs px-3 py-1.5 rounded border border-white/15 opacity-70 hover:opacity-100">Cancel</button>
              <button onClick={() => submitRename("ignore")} title={renaming.idx !== null ? "Exclude ONLY this line from voice identification (doesn't rename anyone or touch other lines)" : "Not someone you track — exclude this whole speaker; removes any voiceprint learned from their turns"} className="text-xs px-3 py-1.5 rounded border border-amber-500/30 text-amber-300/90 hover:bg-amber-500/10">
                {renaming.idx !== null ? "Exclude this line" : "Ignore speaker"}
              </button>
              {renaming.idx !== null && (
                <button onClick={() => submitRename("instance")} className="text-xs px-3 py-1.5 rounded bg-white/10 border border-white/20 hover:bg-white/20">
                  Just this line
                </button>
              )}
              <button onClick={() => submitRename("all")} className="text-xs px-3 py-1.5 rounded bg-violet-500/20 border border-violet-500/40 text-violet-200 hover:bg-violet-500/30">
                All turns of this speaker
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Corrections admin — speaker Work/Personal context + STT mistranscription
          hints. Dashboard-only; proxies to the WSL /admin/* endpoints. */}
      {showCorrections && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-3" onClick={() => setShowCorrections(false)}>
          <div className="bg-[var(--bg-1,#15151c)] border border-white/15 rounded-lg p-5 w-[560px] max-w-[95vw] max-h-[88vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-1">
              <h3 className="text-base font-medium">Corrections</h3>
              <button onClick={() => setShowCorrections(false)} className="text-sm opacity-60 hover:opacity-100">✕</button>
            </div>
            <p className="text-xs opacity-60 mb-4">
              Teach recurring fixes: mark each voice Work or Personal, and log words the transcriber mishears (e.g. it writes “Randy”/“Ramsey”, you mean “Remzi”). Corrections are a deterministic find-and-replace on future transcripts — work fixes never touch a personal recording.
            </p>

            {!adminConfigured && (
              <p className="text-xs text-amber-400/90 mb-4">The correction service isn’t configured on this machine (WSL_PIPELINE_ADMIN_URL unset) — changes can’t be saved.</p>
            )}

            {/* Speaker Work/Personal */}
            <div className="mb-5">
              <div className="text-xs uppercase tracking-wide opacity-50 mb-2">Speaker context</div>
              {adminBusy && adminSpeakers.length === 0 && <div className="text-xs opacity-50">Loading…</div>}
              {!adminBusy && adminSpeakers.length === 0 && <div className="text-xs opacity-50">No enrolled speakers yet.</div>}
              <div className="flex flex-col gap-1.5">
                {adminSpeakers.map((s) => (
                  <div key={String(s.id)} className="flex items-center justify-between gap-2">
                    <span className="text-sm truncate min-w-0">{s.name} <span className="opacity-40 text-xs">({s.n_samples})</span></span>
                    <div className="flex gap-1 shrink-0">
                      {(["work", "personal"] as const).map((c) => (
                        <button key={c} onClick={() => setSpeakerContext(s, c)}
                          className={`text-xs px-2 py-0.5 rounded-full border ${s.context === c ? "bg-white/15 border-white/30" : "border-white/10 opacity-60 hover:opacity-100"}`}>
                          {c}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Mistranscription hints */}
            <div>
              <div className="text-xs uppercase tracking-wide opacity-50 mb-2">Mistranscription fixes</div>
              <div className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_auto] gap-2 mb-3">
                <input value={newHint.phrase} onChange={(e) => setNewHint((h) => ({ ...h, phrase: e.target.value }))}
                  placeholder="Correct form (e.g. Remzi)" className="px-2 py-1.5 rounded bg-black/30 border border-white/15 text-sm outline-none focus:border-white/40 min-w-0" />
                <input value={newHint.misheard} onChange={(e) => setNewHint((h) => ({ ...h, misheard: e.target.value }))}
                  placeholder="Heard as — comma-sep (Randy, Ramsey)" className="px-2 py-1.5 rounded bg-black/30 border border-white/15 text-sm outline-none focus:border-white/40 min-w-0" />
                <div className="flex gap-1 items-center">
                  <select value={newHint.context} onChange={(e) => setNewHint((h) => ({ ...h, context: e.target.value as "work" | "personal" | "all" }))}
                    className="px-2 py-1.5 rounded bg-black/30 border border-white/15 text-sm outline-none">
                    <option value="all">all</option><option value="work">work</option><option value="personal">personal</option>
                  </select>
                  <button onClick={addHint} disabled={adminBusy || !adminConfigured} className="text-xs px-2.5 py-1.5 rounded bg-violet-500/20 border border-violet-500/40 text-violet-200 hover:bg-violet-500/30 disabled:opacity-40">Add</button>
                </div>
              </div>
              <div className="flex flex-col gap-1">
                {hints.map((h) => (
                  <div key={String(h.id)} className="flex items-center justify-between gap-2 text-sm border-b border-white/5 py-1">
                    <span className="min-w-0 truncate">
                      <span className="text-violet-300">{h.phrase}</span>
                      <span className="opacity-40"> ← {h.misheard}</span>
                      <span className="opacity-30 text-xs ml-1">[{h.context}]</span>
                    </span>
                    <button onClick={() => deleteHint(h.id)} className="text-xs opacity-50 hover:opacity-100 hover:text-red-300 shrink-0" title="Delete this fix">✕</button>
                  </div>
                ))}
                {hints.length === 0 && !adminBusy && <div className="text-xs opacity-50">No correction fixes yet.</div>}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function SpeakersPage() {
  return (
    <Suspense fallback={<div className="p-6 opacity-60">Loading…</div>}>
      <SpeakersInner />
    </Suspense>
  );
}
