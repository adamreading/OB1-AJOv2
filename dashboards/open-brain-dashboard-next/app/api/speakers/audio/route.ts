import { NextRequest, NextResponse } from "next/server";
import { requireSession, AuthError } from "@/lib/auth";
import { createReadStream, promises as fsp } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";

// Streams a recording's on-box audio.ogg to the GUI with HTTP Range support so the
// <audio> element can seek to a segment's start_ms. The audio NEVER leaves the box
// (no Supabase Storage / cloud copy — Guardian invariant): this route reads the
// local file the pipeline already processed and streams only the requested bytes.
//
// Node runtime (needs fs). Recordings root comes from APPLAUD_RECORDINGS_DIR (set
// in .env.local — a machine path, kept out of tracked code). Path-traversal guarded.
export const runtime = "nodejs";

const API_URL = process.env.NEXT_PUBLIC_API_URL!;
const RECORDINGS_DIR = process.env.APPLAUD_RECORDINGS_DIR || "";

function resolveWithinRoot(root: string, ref: string): string | null {
  // Accept an absolute path (must sit under root) or a path relative to root.
  const candidate = path.isAbsolute(ref) ? ref : path.join(root, ref);
  const resolved = path.resolve(candidate);
  const resolvedRoot = path.resolve(root);
  const rel = path.relative(resolvedRoot, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null; // traversal / outside root
  if (!/\.(ogg|mp3|m4a|wav|opus)$/i.test(resolved)) return null; // audio files only
  return resolved;
}

export async function GET(request: NextRequest) {
  let apiKey: string;
  try {
    ({ apiKey } = await requireSession());
  } catch (err) {
    if (err instanceof AuthError) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    throw err;
  }
  if (!RECORDINGS_DIR) {
    return NextResponse.json({ error: "APPLAUD_RECORDINGS_DIR not configured" }, { status: 500 });
  }

  const rid = request.nextUrl.searchParams.get("recording_id");
  let ref = request.nextUrl.searchParams.get("rel");

  // Resolve audio_ref from the recording if not passed explicitly.
  if (!ref && rid) {
    try {
      const res = await fetch(`${API_URL}/plaud-recordings/${encodeURIComponent(rid)}`, {
        headers: { "x-brain-key": apiKey },
      });
      if (res.ok) {
        const j = await res.json();
        ref = j?.recording?.audio_ref ?? null;
      }
    } catch {
      /* fall through to 404 */
    }
  }
  // Default convention when the pipeline didn't set audio_ref: "<recording_id>/audio.ogg".
  if (!ref && rid) ref = `${rid}/audio.ogg`;
  if (!ref) return NextResponse.json({ error: "recording_id or rel required" }, { status: 400 });

  const filePath = resolveWithinRoot(RECORDINGS_DIR, ref);
  if (!filePath) return NextResponse.json({ error: "invalid audio path" }, { status: 400 });

  let size: number;
  try {
    size = (await fsp.stat(filePath)).size;
  } catch {
    return NextResponse.json({ error: "audio not found" }, { status: 404 });
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType =
    ext === ".mp3" ? "audio/mpeg" :
    ext === ".m4a" ? "audio/mp4" :
    ext === ".wav" ? "audio/wav" :
    ext === ".opus" ? "audio/opus" : "audio/ogg";

  const range = request.headers.get("range");
  const baseHeaders: Record<string, string> = {
    "Content-Type": contentType,
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=3600",
  };

  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    if (m) {
      let start = m[1] ? parseInt(m[1], 10) : 0;
      let end = m[2] ? parseInt(m[2], 10) : size - 1;
      if (isNaN(start)) start = 0;
      if (isNaN(end) || end >= size) end = size - 1;
      if (start > end || start >= size) {
        return new NextResponse(null, {
          status: 416,
          headers: { "Content-Range": `bytes */${size}`, "Accept-Ranges": "bytes" },
        });
      }
      const nodeStream = createReadStream(filePath, { start, end });
      const webStream = Readable.toWeb(nodeStream) as unknown as ReadableStream;
      return new NextResponse(webStream, {
        status: 206,
        headers: {
          ...baseHeaders,
          "Content-Range": `bytes ${start}-${end}/${size}`,
          "Content-Length": String(end - start + 1),
        },
      });
    }
  }

  const nodeStream = createReadStream(filePath);
  const webStream = Readable.toWeb(nodeStream) as unknown as ReadableStream;
  return new NextResponse(webStream, {
    status: 200,
    headers: { ...baseHeaders, "Content-Length": String(size) },
  });
}
