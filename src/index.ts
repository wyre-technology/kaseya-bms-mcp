#!/usr/bin/env node
/**
 * Kaseya BMS MCP Server
 *
 * This MCP server provides tools for interacting with the Kaseya BMS PSA API.
 * It accepts credentials via environment variables (env mode) or per-request
 * HTTP headers (gateway mode). Supports both stdio (default) and HTTP
 * (StreamableHTTP) transports.
 */

import { createServer, IncomingMessage, ServerResponse, Server as HttpServer } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { KaseyaBmsClient } from "@wyre-technology/node-kaseya-bms";
import { bindServerRef, runWithServerRef } from "./utils/server-ref.js";
import { elicitConfirmation, elicitSelection, elicitText } from "./utils/elicitation.js";
import {
  TICKET_CARD_META,
  TICKET_CARD_RESOURCE_URI,
  MCP_APP_RESOURCE_MIME,
  applyBrandInjection,
  resolveBrandFromEnv,
  buildTicketCard,
} from "./card.builder.js";
import { TICKET_CARD_HTML } from "./generated/ticket-card-html.js";
import { verifyS2sHeader, S2S_HEADER } from "./s2s-verify.js";

const S2S_SECRET = process.env.CONDUIT_S2S_SECRET || "";

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

export interface KaseyaBmsCredentials {
  tenantSubdomain: string;
  apiToken?: string;
  kaseyaOneToken?: string;
}

// An unresolved MCPB/DXT manifest placeholder, e.g. "${user_config.kaseya_bms_k1_token}".
// Desktop hosts inject the config template verbatim when its optional user_config
// field is left blank, so the literal string arrives in the env var / header.
const CONFIG_PLACEHOLDER = /^\$\{.*\}$/;

/**
 * Strip empty/whitespace and unresolved MCPB "${user_config.X}" placeholders
 * (issue #73 pattern), returning `undefined` so the auth layer treats the value
 * as absent rather than a real credential.
 *
 * Root cause: both KASEYA_BMS_API_TOKEN and KASEYA_BMS_K1_TOKEN are optional and
 * map to ${user_config.*} in manifest.json. When the Kaseya One token field is
 * left blank, the host injects the literal "${user_config.kaseya_bms_k1_token}".
 * Because createClient prefers kaseyaOneToken over apiToken, that placeholder was
 * sent as the SSO token and a valid API token was ignored → auth failure.
 */
export function cleanCredential(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || CONFIG_PLACEHOLDER.test(trimmed)) return undefined;
  return trimmed;
}

export function getCredentials(): KaseyaBmsCredentials | null {
  const tenantSubdomain = process.env.KASEYA_BMS_TENANT_SUBDOMAIN;
  if (!tenantSubdomain) return null;
  const apiToken = cleanCredential(process.env.KASEYA_BMS_API_TOKEN);
  const kaseyaOneToken = cleanCredential(process.env.KASEYA_BMS_K1_TOKEN);
  if (!apiToken && !kaseyaOneToken) return null;
  return { tenantSubdomain, apiToken, kaseyaOneToken };
}

export function createClient(creds: KaseyaBmsCredentials): KaseyaBmsClient {
  const opts: Record<string, unknown> = { tenantSubdomain: creds.tenantSubdomain };
  if (creds.kaseyaOneToken) {
    opts.kaseyaOneToken = creds.kaseyaOneToken;
  } else {
    opts.apiToken = creds.apiToken;
  }
  return new KaseyaBmsClient(opts as never);
}

// ---------------------------------------------------------------------------
// Server factory — fresh server per request (stateless HTTP mode)
// ---------------------------------------------------------------------------

export function createMcpServer(credentialOverrides?: KaseyaBmsCredentials): Server {
  const server = new Server(
    {
      name: "kaseya-bms-mcp",
      version: "0.0.0",
    },
    {
      capabilities: {
        tools: {},
        resources: {},
      },
    }
  );

  // The caller owns binding this server into server-ref.ts's scope now
  // (bindServerRef for stdio's single session, runWithServerRef wrapping
  // the whole per-request chain for HTTP) — createMcpServer() stays
  // side-effect-free with respect to server-ref.

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: "kaseya_bms_list_tickets",
          description:
            "List BMS tickets. Supports OData $filter, $top, $skip. If no filter is provided, the user is prompted to choose a status scope.",
          inputSchema: {
            type: "object",
            properties: {
              filter: { type: "string", description: "OData $filter expression (optional)" },
              top: { type: "number", description: "Max records (default 100)", default: 100 },
              skip: { type: "number", description: "Records to skip" },
            },
          },
        },
        {
          name: "kaseya_bms_get_ticket",
          description: "Get details for a single ticket by ticket id.",
          _meta: TICKET_CARD_META,
          inputSchema: {
            type: "object",
            properties: {
              ticketId: { type: "string", description: "Ticket identifier" },
            },
            required: ["ticketId"],
          },
        },
        {
          name: "kaseya_bms_create_ticket",
          description:
            "Create a new ticket in BMS. DESTRUCTIVE: requires user confirmation before submission.",
          inputSchema: {
            type: "object",
            properties: {
              subject: { type: "string", description: "Ticket subject / title" },
              description: { type: "string", description: "Ticket description body" },
              accountId: { type: "string", description: "Account / client identifier" },
              contactId: { type: "string", description: "Contact identifier (optional)" },
              priority: { type: "string", description: "Priority (e.g. Low / Medium / High)" },
              status: { type: "string", description: "Initial status (optional)" },
            },
            required: ["subject", "description"],
          },
        },
        {
          name: "kaseya_bms_add_ticket_note",
          description:
            "Append a note to an existing ticket. DESTRUCTIVE: requires user confirmation before submission.",
          _meta: TICKET_CARD_META,
          inputSchema: {
            type: "object",
            properties: {
              ticketId: { type: "string", description: "Ticket identifier" },
              body: { type: "string", description: "Note body / text content" },
              isInternal: {
                type: "boolean",
                description: "Mark note as internal-only (default false)",
                default: false,
              },
            },
            required: ["ticketId", "body"],
          },
        },
        {
          name: "kaseya_bms_list_time_entries",
          description:
            "List time entries by date range. If no range is given the user is prompted (24h / 7d / 30d / custom / all).",
          inputSchema: {
            type: "object",
            properties: {
              startDate: { type: "string", description: "ISO date (YYYY-MM-DD) start of range" },
              endDate: { type: "string", description: "ISO date (YYYY-MM-DD) end of range" },
              top: { type: "number", description: "Max records (default 100)", default: 100 },
            },
          },
        },
        {
          name: "kaseya_bms_list_accounts",
          description: "List accounts (clients) in the BMS tenant.",
          inputSchema: {
            type: "object",
            properties: {
              filter: { type: "string", description: "OData $filter expression (optional)" },
              top: { type: "number", description: "Max records (default 250)", default: 250 },
            },
          },
        },
        {
          name: "kaseya_bms_list_contacts",
          description: "List contacts in the BMS tenant.",
          inputSchema: {
            type: "object",
            properties: {
              filter: { type: "string", description: "OData $filter expression (optional)" },
              top: { type: "number", description: "Max records (default 250)", default: 250 },
            },
          },
        },
        {
          name: "kaseya_bms_list_contracts",
          description: "List contracts in the BMS tenant.",
          inputSchema: {
            type: "object",
            properties: {
              filter: { type: "string", description: "OData $filter expression (optional)" },
              top: { type: "number", description: "Max records (default 250)", default: 250 },
            },
          },
        },
        {
          name: "kaseya_bms_list_service_catalog",
          description: "List service catalog items configured in the tenant.",
          inputSchema: {
            type: "object",
            properties: {
              top: { type: "number", description: "Max records (default 250)", default: 250 },
            },
          },
        },
        {
          name: "kaseya_bms_search_knowledge_base",
          description:
            "Search the BMS knowledge base. If no query is provided the user is prompted for one.",
          inputSchema: {
            type: "object",
            properties: {
              query: { type: "string", description: "Free-text search query" },
              top: { type: "number", description: "Max records (default 50)", default: 50 },
            },
          },
        },
      ],
    };
  });

  // -------------------------------------------------------------------------
  // Resources — MCP Apps (SEP-1865) ticket-card UI
  // -------------------------------------------------------------------------

  // The ui:// ticket card is static HTML embedded at build time
  // (src/generated/ticket-card-html.ts), so it serves identically from stdio
  // and Node HTTP without touching the filesystem.
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    return {
      resources: [
        {
          uri: TICKET_CARD_RESOURCE_URI,
          name: "Kaseya BMS Ticket Card",
          description: "Interactive MCP Apps card rendering a Kaseya BMS ticket",
          mimeType: MCP_APP_RESOURCE_MIME,
        },
      ],
    };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;
    if (uri !== TICKET_CARD_RESOURCE_URI) {
      throw new Error(`Unknown resource: ${uri}`);
    }
    return {
      contents: [
        {
          uri,
          mimeType: MCP_APP_RESOURCE_MIME,
          // Neutral by default; MCP_BRAND_* env vars inject a per-operator
          // brand at serve time (no vars = HTML served unchanged).
          text: applyBrandInjection(TICKET_CARD_HTML, resolveBrandFromEnv()),
        },
      ],
    };
  });

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  // Hard cap to keep one tool call from streaming the entire history.
  const RESULT_HARD_CAP = 2000;

  async function resolveTicketFilter(provided: string | undefined): Promise<string | undefined> {
    if (provided) return provided;
    const choice = await elicitSelection(
      "No ticket filter provided. Choose a scope:",
      "status",
      [
        { value: "Open", label: "Open tickets only" },
        { value: "InProgress", label: "In-progress tickets only" },
        { value: "Closed", label: "Closed tickets only" },
        { value: "__all__", label: "All tickets (no filter)" },
        { value: "__custom__", label: "Enter a custom OData $filter" },
      ]
    );
    if (!choice || choice === "__all__") return undefined;
    if (choice === "__custom__") {
      const f = await elicitText(
        "Enter the OData $filter expression.",
        "filter",
        "OData $filter"
      );
      return f || undefined;
    }
    return `Status eq '${choice.replace(/'/g, "''")}'`;
  }

  function isoDaysAgo(days: number): string {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - days);
    return d.toISOString().slice(0, 10);
  }

  async function resolveDateWindow(
    startDate: string | undefined,
    endDate: string | undefined
  ): Promise<{ startDate?: string; endDate?: string }> {
    if (startDate || endDate) return { startDate, endDate };
    const choice = await elicitSelection(
      "No date range provided. Choose a window:",
      "window",
      [
        { value: "24h", label: "Last 24 hours" },
        { value: "7d", label: "Last 7 days" },
        { value: "30d", label: "Last 30 days" },
        { value: "__custom__", label: "Enter a custom range" },
        { value: "__all__", label: "All time (no filter)" },
      ]
    );
    if (!choice || choice === "__all__") return {};
    if (choice === "__custom__") {
      const s = await elicitText("Start date (YYYY-MM-DD):", "startDate");
      const e = await elicitText("End date (YYYY-MM-DD):", "endDate");
      return { startDate: s || undefined, endDate: e || undefined };
    }
    const today = new Date().toISOString().slice(0, 10);
    if (choice === "24h") return { startDate: isoDaysAgo(1), endDate: today };
    if (choice === "7d") return { startDate: isoDaysAgo(7), endDate: today };
    if (choice === "30d") return { startDate: isoDaysAgo(30), endDate: today };
    return {};
  }

  // -------------------------------------------------------------------------
  // Tool call handler
  // -------------------------------------------------------------------------

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const creds = credentialOverrides ?? getCredentials();

    if (!creds) {
      return {
        content: [
          {
            type: "text",
            text:
              "Error: No API credentials provided. Configure KASEYA_BMS_TENANT_SUBDOMAIN plus either KASEYA_BMS_API_TOKEN or KASEYA_BMS_K1_TOKEN — or pass them as gateway headers.",
          },
        ],
        isError: true,
      };
    }

    const client = createClient(creds);
    // Cast for SDK calls whose exact signatures may vary; we exercise the
    // documented surface from the design brief and surface real errors.
    type AnyClient = KaseyaBmsClient & Record<string, Record<string, (...a: unknown[]) => Promise<unknown>>>;
    const c = client as unknown as AnyClient;

    try {
      switch (name) {
        case "kaseya_bms_list_tickets": {
          const params = (args ?? {}) as { filter?: string; top?: number; skip?: number };
          const filter = await resolveTicketFilter(params.filter);
          const top = Math.min(params.top ?? 100, RESULT_HARD_CAP);
          const result = await c.tickets.list({ top, skip: params.skip, filter });
          return { content: [{ type: "text", text: JSON.stringify(result ?? [], null, 2) }] };
        }

        case "kaseya_bms_get_ticket": {
          const { ticketId } = args as { ticketId: string };
          const ticket = await c.tickets.get(ticketId);
          // MCP Apps: attach the normalized card payload the ui:// ticket
          // card renders from. Best-effort — a null card just means no UI
          // surface; the model-visible JSON is otherwise unchanged.
          const card = await buildTicketCard(
            ticket as Record<string, unknown> | null | undefined,
            client
          );
          const payload = card ? { ...ticket, _card: card } : ticket;
          return { content: [{ type: "text", text: JSON.stringify(payload ?? {}, null, 2) }] };
        }

        case "kaseya_bms_create_ticket": {
          // BMS API expects PascalCase fields. Tool input stays camelCase for
          // ergonomics; we map at the boundary.
          const input = args as {
            subject: string;
            description?: string;
            accountId?: string;
            contactId?: string;
            priority?: string;
            status?: string;
          };
          const ok = await elicitConfirmation(
            `This will create a new BMS ticket: "${input.subject}". Proceed?`
          );
          if (ok !== true) {
            return { content: [{ type: "text", text: "Ticket creation cancelled by user." }] };
          }
          const created = await c.tickets.create({
            Subject: input.subject,
            Description: input.description,
            AccountId: input.accountId,
            ContactId: input.contactId,
            Priority: input.priority,
            Status: input.status,
          });
          return { content: [{ type: "text", text: JSON.stringify(created ?? {}, null, 2) }] };
        }

        case "kaseya_bms_add_ticket_note": {
          const { ticketId, body, isInternal } = args as {
            ticketId: string;
            body: string;
            isInternal?: boolean;
          };
          const ok = await elicitConfirmation(
            `This will append a note to ticket ${ticketId}. Proceed?`
          );
          if (ok !== true) {
            return { content: [{ type: "text", text: "Note add cancelled by user." }] };
          }
          const result = await c.tickets.addNote(ticketId, { Note: body, IsInternal: isInternal });
          return { content: [{ type: "text", text: JSON.stringify(result ?? { ok: true }, null, 2) }] };
        }

        case "kaseya_bms_list_time_entries": {
          const params = (args ?? {}) as { startDate?: string; endDate?: string; top?: number };
          const window = await resolveDateWindow(params.startDate, params.endDate);
          const top = Math.min(params.top ?? 100, RESULT_HARD_CAP);
          const entries = await c.timeEntries.list({ ...window, top });
          return { content: [{ type: "text", text: JSON.stringify(entries ?? [], null, 2) }] };
        }

        case "kaseya_bms_list_accounts": {
          const params = (args ?? {}) as { filter?: string; top?: number };
          const top = Math.min(params.top ?? 250, RESULT_HARD_CAP);
          const accounts = await c.accounts.list({ top, filter: params.filter });
          return { content: [{ type: "text", text: JSON.stringify(accounts ?? [], null, 2) }] };
        }

        case "kaseya_bms_list_contacts": {
          const params = (args ?? {}) as { filter?: string; top?: number };
          const top = Math.min(params.top ?? 250, RESULT_HARD_CAP);
          const contacts = await c.contacts.list({ top, filter: params.filter });
          return { content: [{ type: "text", text: JSON.stringify(contacts ?? [], null, 2) }] };
        }

        case "kaseya_bms_list_contracts": {
          const params = (args ?? {}) as { filter?: string; top?: number };
          const top = Math.min(params.top ?? 250, RESULT_HARD_CAP);
          const contracts = await c.contracts.list({ top, filter: params.filter });
          return { content: [{ type: "text", text: JSON.stringify(contracts ?? [], null, 2) }] };
        }

        case "kaseya_bms_list_service_catalog": {
          const params = (args ?? {}) as { top?: number };
          const top = Math.min(params.top ?? 250, RESULT_HARD_CAP);
          const items = await c.catalog.list({ top });
          return { content: [{ type: "text", text: JSON.stringify(items ?? [], null, 2) }] };
        }

        case "kaseya_bms_search_knowledge_base": {
          // BMS KB endpoint accepts only OData params. Free-text "search" is
          // expressed as a $filter on Title (case-insensitive contains).
          const params = (args ?? {}) as { query?: string; top?: number };
          let query = params.query;
          if (!query) {
            const q = await elicitText("Enter a knowledge base search query:", "query");
            query = q || undefined;
          }
          const top = Math.min(params.top ?? 50, RESULT_HARD_CAP);
          const filter = query
            ? `contains(tolower(Title), '${query.toLowerCase().replace(/'/g, "''")}')`
            : undefined;
          const results = await c.knowledgeBase.list({ top, filter });
          return { content: [{ type: "text", text: JSON.stringify(results ?? [], null, 2) }] };
        }

        default:
          return {
            content: [{ type: "text", text: `Unknown tool: ${name}` }],
            isError: true,
          };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text", text: `Error: ${message}` }],
        isError: true,
      };
    }
  });

  return server;
}

// ---------------------------------------------------------------------------
// Transport: stdio (default)
// ---------------------------------------------------------------------------

async function startStdioTransport(): Promise<void> {
  const server = createMcpServer();
  // stdio is single-session for the whole process — no concurrent tenants
  // to isolate from each other, so enterWith's process-lifetime binding is
  // safe.
  bindServerRef(server);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Kaseya BMS MCP server running on stdio");
}

// ---------------------------------------------------------------------------
// Transport: HTTP (StreamableHTTPServerTransport)
// ---------------------------------------------------------------------------

let httpServer: HttpServer | undefined;

async function startHttpTransport(): Promise<void> {
  const port = parseInt(process.env.MCP_HTTP_PORT || "8080", 10);
  const host = process.env.MCP_HTTP_HOST || "0.0.0.0";
  const authMode = process.env.AUTH_MODE || "env";
  const isGatewayMode = authMode === "gateway";

  httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    // Health endpoint - no auth required
    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          transport: "http",
          authMode: isGatewayMode ? "gateway" : "env",
          timestamp: new Date().toISOString(),
        })
      );
      return;
    }

    if (url.pathname === "/mcp") {
      if (S2S_SECRET && !verifyS2sHeader(req.headers[S2S_HEADER] as string | undefined, S2S_SECRET)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: "Missing or invalid X-Gateway-S2S header: this endpoint only accepts requests signed by the gateway.",
          })
        );
        return;
      }

      if (req.method !== "POST") {
        res.writeHead(405, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32000, message: "Method not allowed" },
            id: null,
          })
        );
        return;
      }

      // In gateway mode, extract credentials from headers and pass directly
      // to avoid process.env race conditions under concurrent load.
      let gatewayCredentials: KaseyaBmsCredentials | undefined;
      if (isGatewayMode) {
        const headers = req.headers as Record<string, string | string[] | undefined>;
        const tenantSubdomain = headers["x-kaseya-bms-tenant-subdomain"] as string | undefined;
        // Strip unresolved MCPB placeholders here too, so a blank optional field
        // forwarded as "${user_config.X}" never overrides a real token (issue #73).
        const apiToken = cleanCredential(headers["x-kaseya-bms-api-token"] as string | undefined);
        const kaseyaOneToken = cleanCredential(headers["x-kaseya-bms-k1-token"] as string | undefined);

        if (!tenantSubdomain || (!apiToken && !kaseyaOneToken)) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: "Missing credentials",
              message:
                "Gateway mode requires X-Kaseya-BMS-Tenant-Subdomain plus either X-Kaseya-BMS-API-Token or X-Kaseya-BMS-K1-Token.",
              required: [
                "X-Kaseya-BMS-Tenant-Subdomain",
                "X-Kaseya-BMS-API-Token OR X-Kaseya-BMS-K1-Token",
              ],
            })
          );
          return;
        }

        gatewayCredentials = { tenantSubdomain, apiToken, kaseyaOneToken };
      }

      // Stateless: fresh server + transport per request
      const server = createMcpServer(gatewayCredentials);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });

      res.on("close", () => {
        transport.close();
        server.close();
      });

      // The whole chain below (connect through the catch handler) runs
      // inside runWithServerRef so the server-ref binding — used by
      // elicitation (elicitConfirmation/elicitSelection/elicitText) —
      // survives every await gap in this request's lifecycle without
      // leaking into a concurrent request's server-ref.
      runWithServerRef(server, () =>
        server
          .connect(transport as unknown as Transport)
          .then(() => {
            transport.handleRequest(req, res);
          })
          .catch((err) => {
            console.error("MCP transport error:", err);
            if (!res.headersSent) {
              res.writeHead(500, { "Content-Type": "application/json" });
              res.end(
                JSON.stringify({
                  jsonrpc: "2.0",
                  error: { code: -32603, message: "Internal error" },
                  id: null,
                })
              );
            }
          })
      );

      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found", endpoints: ["/mcp", "/health"] }));
  });

  await new Promise<void>((resolve) => {
    httpServer!.listen(port, host, () => {
      console.error(`Kaseya BMS MCP server listening on http://${host}:${port}/mcp`);
      console.error(`Health check available at http://${host}:${port}/health`);
      console.error(
        `Authentication mode: ${isGatewayMode ? "gateway (header-based)" : "env (environment variables)"}`
      );
      resolve();
    });
  });
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

function setupShutdownHandlers(): void {
  const shutdown = async () => {
    console.error("Shutting down Kaseya BMS MCP server...");
    if (httpServer) {
      await new Promise<void>((resolve, reject) => {
        httpServer!.close((err) => (err ? reject(err) : resolve()));
      });
    }
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  setupShutdownHandlers();

  const transportType = process.env.MCP_TRANSPORT || "stdio";

  if (transportType === "http") {
    await startHttpTransport();
  } else {
    await startStdioTransport();
  }
}

// Only bootstrap the server when run as a process, not when imported for tests.
if (process.env.NODE_ENV !== "test") {
  main().catch(console.error);
}
