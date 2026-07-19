"use client";

// Segment error boundary for /speakers. Without this, an unhandled client-side
// throw during render/hydration blanks the whole page (which is exactly the
// "empty on mobile" symptom under investigation). This surfaces the actual error
// text on-screen so we can see what's throwing on a device we can't inspect.
export default function SpeakersError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="p-6 max-w-[800px] mx-auto">
      <h2 className="text-lg font-semibold mb-2">Speakers hit a client error</h2>
      <p className="text-sm opacity-70 mb-3">
        This message means the page threw while rendering. Please screenshot / paste it.
      </p>
      <pre className="text-xs whitespace-pre-wrap break-words p-3 rounded bg-black/30 border border-white/15 mb-3">
        {error?.name}: {error?.message}
        {error?.digest ? `\n\ndigest: ${error.digest}` : ""}
      </pre>
      <button
        onClick={reset}
        className="text-sm px-3 py-1.5 rounded bg-white/10 border border-white/20 hover:bg-white/20"
      >
        Retry
      </button>
    </div>
  );
}
