import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  // Pin the Turbopack workspace root to THIS directory. Without this, Next
  // walks up the tree looking for a package-lock.json and may pick the one
  // in C:\Users\USER\ (a stray from an unrelated CLI install)
  // instead of the dashboard's own lockfile.
  turbopack: {
    root: path.resolve(__dirname),
  },

  // Origins permitted to POST Server Actions in dev. Without this, the login
  // form silently fails when the dashboard is accessed via any hostname other
  // than localhost (Tailscale, LAN IP, etc.) because Next 16 rejects the
  // action as cross-origin. Read from ALLOWED_DEV_ORIGINS (comma-separated) so
  // no private LAN/tailnet host is ever hardcoded in tracked source — real
  // values live in the gitignored .env.local; see .env.example for the shape.
  allowedDevOrigins: (process.env.ALLOWED_DEV_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),

  // Standalone output bundles the dashboard for Docker / containerized
  // deploys (picked up from upstream eb68169).
  output: "standalone",
};

export default nextConfig;
