import { requireSessionOrRedirect } from "@/lib/auth";
import { EngineBoard } from "@/components/EngineBoard";

export const dynamic = "force-dynamic";

export default async function EnginePage() {
  await requireSessionOrRedirect();

  return (
    <div
      className="ob1-fullbleed from-legacy"
      style={{
        background: "var(--bg-0)",
        fontFamily: "var(--font-sans)",
        minHeight: "100vh",
      }}
    >
      <div
        className="mobile-pad"
        style={{
          padding: "32px 32px 56px",
          display: "flex",
          flexDirection: "column",
          gap: 22,
        }}
      >
        <div
          className="mobile-wrap"
          style={{
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: 16,
            flexWrap: "wrap",
          }}
        >
          <div>
            <div className="eyebrow" style={{ marginBottom: 8 }}>
              Agents · Open Engine
            </div>
            <h1
              className="mobile-h1"
              style={{
                margin: 0,
                fontSize: 30,
                fontWeight: 600,
                letterSpacing: "-0.025em",
                color: "var(--fg)",
              }}
            >
              Engine control centre
            </h1>
            <p
              style={{
                margin: "6px 0 0",
                color: "var(--fg-3)",
                fontSize: 14,
              }}
            >
              The shared agent work-queue — who&apos;s alive, what&apos;s
              claimed, and every receipt. File a task and the assigned agent
              picks it up on its next pass.
            </p>
          </div>
        </div>

        <EngineBoard />
      </div>
    </div>
  );
}
