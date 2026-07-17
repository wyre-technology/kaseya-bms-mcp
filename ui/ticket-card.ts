/**
 * Iframe bridge + renderer for the Kaseya BMS ticket card (MCP Apps, SEP-1865).
 *
 * Runs inside the host's sandboxed iframe. Uses the official MCP Apps client
 * (`App`) to receive the tool result from the host and to call
 * kaseya_bms_add_ticket_note back (the "Add note" round-trip).
 *
 * The server attaches a normalized `_card` payload to kaseya_bms_get_ticket
 * results (see src/card.builder.ts) so this renderer never needs to resolve
 * ids or entity names itself.
 *
 * Rendering uses DOM construction (no innerHTML) — ticket subjects and
 * descriptions are untrusted PSA data, so text only ever lands in text nodes.
 *
 * Branding: the card is neutral by default (this is a published server) and
 * applies an injected `window.__BRAND__` override — set by the server from
 * MCP_BRAND_* env vars at serve time, or by a gateway per-org — so the same
 * card can render in any operator's brand.
 */
import { App } from "@modelcontextprotocol/ext-apps";

interface Brand {
  name?: string;
  logoUrl?: string;
  primaryColor?: string;
  accentColor?: string;
  bg?: string;
  text?: string;
}
declare global {
  interface Window {
    __BRAND__?: Brand;
  }
}

/** Mirror of TicketCard in src/card.builder.ts — keep in sync. */
interface TicketCard {
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

const brand: Brand = window.__BRAND__ ?? {};
// No brand injected → no brand identity rendered (neutral default).
const brandName = brand.name ?? "";

// Apply any injected brand overrides onto the CSS custom properties.
function applyBrand(): void {
  const root = document.documentElement.style;
  if (brand.primaryColor) root.setProperty("--brand-primary", brand.primaryColor);
  if (brand.accentColor) root.setProperty("--brand-accent", brand.accentColor);
  if (brand.bg) root.setProperty("--brand-bg", brand.bg);
  if (brand.text) root.setProperty("--brand-text", brand.text);
}

const app = new App({ name: "Kaseya BMS Ticket Card", version: "1.0.0" });
let current: TicketCard | null = null;
// The BMS SDK has no notes-list endpoint, so the card can't show note history.
// Notes added from the card this session are echoed here after a confirmed add.
let addedNotes: string[] = [];

/** Create an element with a class and (safe, text-node) children. */
function el(
  tag: string,
  className = "",
  ...children: Array<Node | string | null>
): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  for (const child of children) {
    if (child == null) continue;
    node.append(child); // strings become text nodes — never parsed as HTML
  }
  return node;
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function field(label: string, value: string | undefined): HTMLElement | null {
  if (!value) return null;
  return el("div", "field", el("div", "field__label", label), el("div", "field__value", value));
}

function badge(text: string | undefined, cls: string): HTMLElement | null {
  return text ? el("span", `badge ${cls}`, text) : null;
}

function render(t: TicketCard): void {
  current = t;

  // Empty when no brand is injected — the span still occupies the flex slot
  // so the ticket number stays right-aligned.
  const brandId = el("span", "brandid");
  if (brand.logoUrl) {
    const logo = document.createElement("img");
    logo.src = brand.logoUrl;
    logo.alt = brandName || "logo";
    logo.style.display = "inline-block";
    brandId.append(logo);
  }
  if (brandName) brandId.append(el("span", "brand", brandName));

  let descSection: HTMLElement | null = null;
  if (t.description || t.noteDefaults || addedNotes.length > 0) {
    descSection = el("div", "desc");
    if (t.description) {
      descSection.append(el("div", "desc__h", "Description"), el("div", "desc__body", t.description));
    }
    for (const note of addedNotes) {
      descSection.append(el("div", "note", note));
    }

    if (t.noteDefaults) {
      const input = document.createElement("input");
      input.id = "note-input";
      input.type = "text";
      input.placeholder = "Add an internal note to this ticket…";
      const btn = el("button", "btn", "Add note") as HTMLButtonElement;
      btn.id = "note-btn";

      const submit = async () => {
        const body = input.value.trim();
        if (!body || !current?.noteDefaults) return;
        btn.disabled = true;
        btn.textContent = "Adding…";
        try {
          // The server resolved the internal-only visibility default into
          // noteDefaults (isInternal); the card never guesses visibility.
          const result = await app.callServerTool({
            name: "kaseya_bms_add_ticket_note",
            arguments: {
              ticketId: current.id,
              body,
              isInternal: current.noteDefaults.isInternal,
            },
          });
          // The note tool declines (without isError) when the user rejects the
          // host's confirmation prompt — don't echo a note that wasn't added.
          const text =
            (result.content ?? []).find(
              (c): c is { type: "text"; text: string } => c.type === "text",
            )?.text ?? "";
          if (result.isError || /cancelled/i.test(text)) throw new Error("note not added");
          addedNotes = [...addedNotes, body];
          render(current);
        } catch {
          btn.disabled = false;
          btn.textContent = "Add note";
        }
      };
      btn.addEventListener("click", submit);
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") submit();
      });
      descSection.append(el("div", "addnote", input, btn));
    }
  }

  const body = el(
    "div",
    "card__body",
    el(
      "div",
      "brandrow",
      brandId,
      el("span", "ticketno", `${t.ticketNumber ?? `#${t.id}`} · Kaseya BMS`),
    ),
    el("h1", "", t.title),
    el("div", "badges", badge(t.status, "badge--status"), badge(t.priority, "badge--prio")),
    el(
      "div",
      "grid",
      field("Account", t.account),
      field("Assigned", t.assignedTo ?? "Unassigned"),
      field("Created", t.createdOn && fmtDate(t.createdOn)),
      field("Updated", t.modifiedOn && fmtDate(t.modifiedOn)),
    ),
    descSection,
  );

  const root = document.getElementById("root")!;
  root.replaceChildren(el("div", "card", el("div", "card__bar"), body));
}

// kaseya-bms-mcp returns the ticket JSON directly, with the normalized card
// attached as a top-level _card field.
function extractCard(obj: unknown): TicketCard | null {
  const card = (obj as { _card?: TicketCard })?._card;
  return card && typeof card.id === "string" && typeof card.title === "string" && card.title
    ? card
    : null;
}

applyBrand();

// Must be set before connect() so the initial tool-result isn't missed.
app.ontoolresult = (result: { content?: Array<{ type: string; text?: string }> }) => {
  const payload = (result.content ?? []).find((c) => c.type === "text");
  if (!payload?.text) return;
  try {
    const card = extractCard(JSON.parse(payload.text));
    if (card) render(card);
  } catch {
    /* ignore malformed payloads */
  }
};

app.connect();
