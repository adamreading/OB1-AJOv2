import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// open-engine-mcp — SCOPED MCP server for external/work-tenant agents
// (M365 Copilot first). Exposes ONLY the Open Engine work-queue tools —
// no thoughts, no wiki, no entities, no capture. Two hard boundaries:
//
//   1. Its own access key (OPEN_ENGINE_KEY). The master MCP_ACCESS_KEY
//      never leaves Supabase secrets — this function holds it server-side
//      to delegate to rest-api, but clients authenticate with the scoped
//      key, which unlocks nothing except this server.
//   2. Agent identity is LOCKED server-side (ENGINE_AGENT_CODE, default
//      'copilot-work'). Claims, receipts, and ledger writes are always
//      attributed to the locked code no matter what the client model
//      passes — a work-tenant agent cannot impersonate hermes-agent/ob-claude.
//
// All tools delegate to the same rest-api routes as open-brain-mcp's
// engine tools, so semantics are identical across every surface.
// Runner protocol: .claude/open-engine/COPILOT-RUNNER.md (paste-in
// instructions for the Copilot Studio agent).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPTransport } from "@hono/mcp";
import { Hono } from "hono";
import { z } from "zod";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const MCP_ACCESS_KEY = Deno.env.get("MCP_ACCESS_KEY")!; // server-side only, never accepted from clients
const OPEN_ENGINE_KEY = Deno.env.get("OPEN_ENGINE_KEY")!;
const AGENT_CODE = Deno.env.get("ENGINE_AGENT_CODE") || "copilot-work";

function createServer(): McpServer {
  const server = new McpServer({
    name: "open-engine",
    version: "1.0.0",
  });

  const engineApi = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/rest-api${path}`, {
      method,
      headers: { "x-brain-key": MCP_ACCESS_KEY, "Content-Type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const json = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, json };
  };
  const engineText = (r: { ok: boolean; status: number; json: unknown }) => ({
    content: [{ type: "text" as const, text: JSON.stringify(r.json, null, 2) }],
    ...(r.ok ? {} : { isError: true }),
  });

  server.registerTool(
    "list_my_tasks",
    {
      title: "List My Tasks",
      description: `Open Engine work-queue: list tasks assigned to you (${AGENT_CODE}, plus 'all'-assigned tasks), optionally filtered by status (comma-separated: todo,working,needs_input,review,done,standing). Start every queue pass here.`,
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: {
        status: z.string().optional().describe("Status filter, comma-separated (e.g. 'todo' or 'needs_input,working')"),
      },
    },
    async ({ status }) =>
      engineText(await engineApi("GET", `/agent-tasks?agent_code=${encodeURIComponent(AGENT_CODE)}${status ? `&status=${encodeURIComponent(status)}` : ""}`)),
  );

  server.registerTool(
    "get_task",
    {
      title: "Get Task",
      description: "Open Engine: fetch one task by id including its full receipt thread (the CLAIMED/DONE/BLOCKED/... history other agents and the human have left). Always re-read after claiming.",
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: { id: z.number().describe("Task id") },
    },
    async ({ id }) => engineText(await engineApi("GET", `/agent-tasks/${id}`)),
  );

  server.registerTool(
    "claim_task",
    {
      title: "Claim Task",
      description: `Open Engine ATOMIC claim-lock as ${AGENT_CODE}. With id: claim that specific task (error = someone else won). Without id: claim the next eligible todo (priority-first). Writes a CLAIMED receipt automatically. Claim exactly ONE task per pass.`,
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: {
        id: z.number().optional().describe("Task id to claim; omit to claim the next eligible todo"),
      },
    },
    async ({ id }) =>
      engineText(
        id != null
          ? await engineApi("POST", `/agent-tasks/${id}/claim`, { agent_code: AGENT_CODE })
          : await engineApi("POST", "/agent-tasks/claim-next", { agent_code: AGENT_CODE }),
      ),
  );

  server.registerTool(
    "update_task",
    {
      title: "Update Task",
      description: "Open Engine: transition a task's status (todo|working|needs_input|review|done) and/or leave a receipt in the same call (receipt_type: DONE, BLOCKED, UNBLOCKED, HUMAN_HOLD, HUMAN_ANSWERED, RESUMED, FAILED, APPLIED, FOLLOW_UP). Set blocked_reason for on-task blocks, hold_reason when only your human can answer. Status done/todo clears the claim.",
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: {
        id: z.number().describe("Task id"),
        status: z.string().optional().describe("New status"),
        receipt_type: z.string().optional().describe("Receipt to leave"),
        receipt_body: z.string().optional().describe("Receipt detail — write it for the OTHER agents reading the thread: what you did, where, how verified"),
        blocked_reason: z.string().optional(),
        hold_reason: z.string().optional(),
      },
    },
    async ({ id, ...rest }) => engineText(await engineApi("PATCH", `/agent-tasks/${id}`, { ...rest, agent_code: AGENT_CODE })),
  );

  server.registerTool(
    "post_receipt",
    {
      title: "Post Receipt",
      description: "Open Engine: append a receipt to a task's thread without changing its status (e.g. FOLLOW_UP with a progress note or a question for the thread).",
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: {
        id: z.number().describe("Task id"),
        receipt_type: z.string().describe("CLAIMED|DONE|BLOCKED|UNBLOCKED|HUMAN_HOLD|HUMAN_ANSWERED|RESUMED|FAILED|APPLIED|FOLLOW_UP"),
        body: z.string().optional(),
      },
    },
    async ({ id, ...rest }) => engineText(await engineApi("POST", `/agent-tasks/${id}/receipts`, { ...rest, agent_code: AGENT_CODE })),
  );

  server.registerTool(
    "create_task",
    {
      title: "Create Task",
      description: "Open Engine: file a task on the queue for another agent (hermes-agent | wsl-claude | ob-claude | copilot-work | perplexity, or 'all' so any agent may claim it). Higher priority = claimed first.",
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: {
        agent_code: z.string().describe("Assignee code, or 'all'"),
        title: z.string(),
        body: z.string().optional().describe("Full task description/instructions — include everything the assignee needs, they can't see this chat"),
        priority: z.number().optional().describe("Higher = more urgent (default 0)"),
        parent_id: z.number().optional().describe("Parent task id when delegating a sub-task of something you're working on"),
      },
    },
    async (args) => engineText(await engineApi("POST", "/agent-tasks", args)),
  );

  server.registerTool(
    "get_ledger",
    {
      title: "Get Agent Ledger",
      description: "Open Engine: read the shared per-agent status ledger (who's alive, last heartbeats, last queue results). Omit agent_code for all agents.",
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: { agent_code: z.string().optional() },
    },
    async ({ agent_code }) =>
      engineText(await engineApi("GET", `/agent-ledger${agent_code ? `?agent_code=${encodeURIComponent(agent_code)}` : ""}`)),
  );

  server.registerTool(
    "update_my_ledger",
    {
      title: "Update My Ledger",
      description: `Open Engine: upsert YOUR (${AGENT_CODE}) ledger row. Set heartbeat=true to stamp last_heartbeat=now, run_succeeded=true to stamp last_successful_run=now. Update last_queue_result at the start ('checking') and end ('completed <id>' / 'blocked <id>' / 'idle') of every pass.`,
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: {
        heartbeat: z.boolean().optional(),
        run_succeeded: z.boolean().optional(),
        last_queue_result: z.string().optional(),
        notes: z.string().optional(),
      },
    },
    async ({ heartbeat, run_succeeded, ...rest }) =>
      engineText(await engineApi("PUT", `/agent-ledger/${encodeURIComponent(AGENT_CODE)}`, {
        ...rest,
        ...(heartbeat ? { last_heartbeat: true } : {}),
        ...(run_succeeded ? { last_successful_run: true } : {}),
      })),
  );

  return server;
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-brain-key, accept, mcp-session-id, mcp-protocol-version, last-event-id",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS, DELETE",
};

const app = new Hono();

app.options("*", (c) => c.text("ok", 200, corsHeaders));

// OAuth discovery routes — MCP clients probe these before falling back to key auth.
app.get("/.well-known/oauth-authorization-server", (c) =>
  c.json({ error: "not_supported" }, 404, corsHeaders)
);
app.post("/oauth/register", (c) =>
  c.json({ error: "not_supported" }, 404, corsHeaders)
);

app.all("*", async (c) => {
  // Auth: scoped key ONLY. The master key is deliberately not accepted here.
  const provided = c.req.header("x-brain-key") || new URL(c.req.url).searchParams.get("key");
  if (!provided || provided !== OPEN_ENGINE_KEY) {
    return c.json({ error: "Invalid or missing access key" }, 401, corsHeaders);
  }

  if (c.req.method === "GET") {
    if (c.req.header("accept")?.includes("text/event-stream")) {
      const server = createServer();
      const transport = new StreamableHTTPTransport();
      await server.connect(transport);
      return transport.handleRequest(c);
    }
    return c.json({
      status: "ok",
      name: "open-engine",
      version: "1.0.0",
      agent_code: AGENT_CODE,
      capabilities: { tools: true, resources: false, prompts: false },
    }, 200, corsHeaders);
  }

  const headers = new Headers(c.req.raw.headers);
  const currentAccept = headers.get("accept") || "";

  if (!currentAccept.includes("application/json") || !currentAccept.includes("text/event-stream")) {
    headers.set("Accept", "application/json, text/event-stream");
    const patched = new Request(c.req.raw.url, {
      method: c.req.raw.method,
      headers,
      body: c.req.raw.body,
      // @ts-ignore - Duplex is required for streaming bodies in Deno
      duplex: "half",
    });
    const newContext = { ...c, req: { ...c.req, raw: patched } };
    const server = createServer();
    const transport = new StreamableHTTPTransport();
    await server.connect(transport);
    return transport.handleRequest(newContext as any);
  }

  const server = createServer();
  const transport = new StreamableHTTPTransport();
  await server.connect(transport);
  return transport.handleRequest(c);
});

Deno.serve(app.fetch);
