/**
 * Ticket-card payload builder for the MCP Apps (SEP-1865) UI surface.
 *
 * kaseya_bms_get_ticket results get a normalized `_card` object attached
 * (see index.ts) that the ui:// ticket card renders from. The card is
 * progressive enhancement: every step here is best-effort, and a null
 * return simply means the host renders no card while the JSON payload is
 * unchanged.
 */

import type { KaseyaBmsClient } from "@wyre-technology/node-kaseya-bms";

export const TICKET_CARD_RESOURCE_URI = "ui://kaseya-bms/ticket-card.html";

/** MCP Apps resource MIME (RESOURCE_MIME_TYPE in @modelcontextprotocol/ext-apps). */
export const MCP_APP_RESOURCE_MIME = "text/html;profile=mcp-app";

/**
 * Tool `_meta` advertising the card. Carries both the canonical flat key
 * (RESOURCE_URI_META_KEY in ext-apps) and the nested form ext-apps'
 * registerAppTool emits, so any MCP Apps host revision finds it.
 */
export const TICKET_CARD_META = {
  "ui/resourceUri": TICKET_CARD_RESOURCE_URI,
  ui: { resourceUri: TICKET_CARD_RESOURCE_URI },
} as const;

/** Mirror of Brand in ui/ticket-card.ts — keep in sync. */
export interface CardBrand {
  name?: string;
  logoUrl?: string;
  primaryColor?: string;
  accentColor?: string;
  bg?: string;
  text?: string;
}

/** The brand-inject comment marker baked into the card HTML (see ui/index.html). */
const BRAND_INJECT_MARKER = /<!--\s*BRAND_INJECT:[\s\S]*?-->/;

/**
 * Serve-time brand injection: replace the marker comment with an inline
 * `window.__BRAND__` script so self-hosters can theme the card without
 * rebuilding the bundle. An empty brand returns the HTML unchanged (the card
 * renders its neutral defaults). `<` is escaped so brand values can never
 * break out of the script element.
 */
export function applyBrandInjection(html: string, brand: CardBrand): string {
  const entries = Object.entries(brand).filter(
    ([, value]) => typeof value === "string" && value !== "",
  );
  if (entries.length === 0) return html;
  const json = JSON.stringify(Object.fromEntries(entries)).replace(/</g, "\\u003c");
  return html.replace(BRAND_INJECT_MARKER, `<script>window.__BRAND__=${json}</script>`);
}

/**
 * Resolve brand overrides from MCP_BRAND_* environment variables. Returns an
 * empty brand (HTML served unchanged) when none are set, or on runtimes
 * without `process.env`.
 */
export function resolveBrandFromEnv(): CardBrand {
  if (typeof process === "undefined" || !process.env) return {};
  const env = process.env;
  const brand: CardBrand = {};
  if (env.MCP_BRAND_NAME) brand.name = env.MCP_BRAND_NAME;
  if (env.MCP_BRAND_LOGO_URL) brand.logoUrl = env.MCP_BRAND_LOGO_URL;
  if (env.MCP_BRAND_PRIMARY_COLOR) brand.primaryColor = env.MCP_BRAND_PRIMARY_COLOR;
  if (env.MCP_BRAND_ACCENT_COLOR) brand.accentColor = env.MCP_BRAND_ACCENT_COLOR;
  if (env.MCP_BRAND_BG) brand.bg = env.MCP_BRAND_BG;
  if (env.MCP_BRAND_TEXT) brand.text = env.MCP_BRAND_TEXT;
  return brand;
}

/** Mirror of TicketCard in ui/ticket-card.ts — keep in sync. */
export interface TicketCard {
  id: string;
  ticketNumber?: string;
  title: string;
  status?: string;
  priority?: string;
  account?: string;
  assignedTo?: string;
  createdOn?: string;
  modifiedOn?: string;
  description?: string;
  noteDefaults?: { isInternal: boolean };
}

const CARD_DESCRIPTION_MAX_LENGTH = 500;

/** Non-empty string helper for the loosely-typed BMS payloads. */
function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * Build the renderable card from a kaseya_bms_get_ticket payload. BMS returns
 * Status/Priority/AssignedTo as label strings already; the only server-side
 * lookup is the account name (AccountsResource.get — a lookup this server
 * already ships). Every step is best-effort.
 */
export async function buildTicketCard(
  ticket: Record<string, unknown> | null | undefined,
  client: Pick<KaseyaBmsClient, "accounts">,
): Promise<TicketCard | null> {
  const id = ticket?.Id ?? ticket?.TicketId;
  const title = str(ticket?.Subject) ?? str(ticket?.Summary);
  if (ticket == null || id == null || !title) return null;

  const card: TicketCard = {
    id: String(id),
    title,
    // BMS visibility on a note is the universal IsInternal boolean (not a
    // tenant-specific enum), so an internal-only default is always safe. The
    // card passes it back verbatim and never guesses visibility itself.
    noteDefaults: { isInternal: true },
  };

  const ticketNumber = str(ticket.TicketNumber);
  if (ticketNumber) card.ticketNumber = ticketNumber;
  const status = str(ticket.Status);
  if (status) card.status = status;
  const priority = str(ticket.Priority);
  if (priority) card.priority = priority;
  const assignedTo = str(ticket.AssignedTo);
  if (assignedTo) card.assignedTo = assignedTo;
  const createdOn = str(ticket.CreatedOn);
  if (createdOn) card.createdOn = createdOn;
  const modifiedOn = str(ticket.ModifiedOn);
  if (modifiedOn) card.modifiedOn = modifiedOn;
  const description = str(ticket.Description);
  if (description) card.description = description.slice(0, CARD_DESCRIPTION_MAX_LENGTH);

  // Resolve the account (client) name server-side — the card never sees a
  // bare id unless the lookup fails. `AccountID` is the legacy Vorex casing.
  const accountId = ticket.AccountId ?? ticket.AccountID;
  if (accountId != null) {
    try {
      const account = await client.accounts.get(accountId as string | number);
      card.account = str(account?.Name) ?? str(account?.AccountName) ?? `#${accountId}`;
    } catch {
      // Best-effort: render the card without the account name.
      card.account = `#${accountId}`;
    }
  }

  return card;
}
