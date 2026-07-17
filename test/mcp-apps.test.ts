/**
 * MCP Apps (SEP-1865) contract tests — mirrors the checks an MCP Apps host
 * performs to render the ticket card:
 *   1. renderable tools advertise the UI resource via _meta
 *   2. the ui:// resource lists and reads back as profile=mcp-app HTML
 *   3. kaseya_bms_get_ticket results carry the normalized `_card` payload
 *      the iframe renders from
 *
 * Wire-level checks drive createMcpServer over an in-memory transport (the
 * same Server the stdio and HTTP transports connect); buildTicketCard is
 * unit-tested directly.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const { ticketsGetMock, accountsGetMock } = vi.hoisted(() => ({
  ticketsGetMock: vi.fn(),
  accountsGetMock: vi.fn(),
}));
vi.mock('@wyre-technology/node-kaseya-bms', () => ({
  KaseyaBmsClient: class {
    tickets = { get: ticketsGetMock };
    accounts = { get: accountsGetMock };
  },
}));

import { createMcpServer } from '../src/index.js';
import {
  applyBrandInjection,
  resolveBrandFromEnv,
  buildTicketCard,
  TICKET_CARD_RESOURCE_URI,
  MCP_APP_RESOURCE_MIME,
} from '../src/card.builder.js';
import { TICKET_CARD_HTML } from '../src/generated/ticket-card-html.js';

const RENDERABLE_TOOLS = ['kaseya_bms_get_ticket', 'kaseya_bms_add_ticket_note'];

const bmsTicket = {
  Id: 4821,
  TicketNumber: 'T-2026-0042',
  Subject: 'VPN outage — main office',
  Description: 'Users report VPN drops since 09:00.',
  Status: 'Open',
  Priority: 'High',
  AccountId: 77,
  AssignedTo: 'Dana Ruiz',
  CreatedOn: '2026-07-17T09:00:00Z',
  ModifiedOn: '2026-07-17T10:15:00Z',
};

/** Connect a fresh server (with test credentials) to an in-memory client. */
async function connect(): Promise<Client> {
  const server = createMcpServer({ tenantSubdomain: 'acme', apiToken: 'test-token' });
  const client = new Client({ name: 'mcp-apps-test', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

describe('MCP Apps ticket card', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('tool _meta advertisement', () => {
    it.each(RENDERABLE_TOOLS)('%s links the card via _meta', async (name) => {
      const client = await connect();
      const { tools } = await client.listTools();
      const tool = tools.find((t) => t.name === name);
      expect(tool).toBeDefined();
      // Canonical flat key (ext-apps RESOURCE_URI_META_KEY) …
      expect(tool?._meta?.['ui/resourceUri']).toBe(TICKET_CARD_RESOURCE_URI);
      // … and the nested form registerAppTool also emits.
      expect((tool?._meta?.ui as { resourceUri?: string })?.resourceUri).toBe(
        TICKET_CARD_RESOURCE_URI
      );
    });

    it('no other tools carry UI metadata', async () => {
      const client = await connect();
      const { tools } = await client.listTools();
      const others = tools.filter((t) => t._meta && !RENDERABLE_TOOLS.includes(t.name));
      expect(others).toEqual([]);
    });
  });

  describe('ui:// resource', () => {
    it('is listed with the MCP Apps MIME type', async () => {
      const client = await connect();
      const { resources } = await client.listResources();
      const card = resources.find((r) => r.uri === TICKET_CARD_RESOURCE_URI);
      expect(card?.mimeType).toBe(MCP_APP_RESOURCE_MIME);
    });

    it('reads back as profile=mcp-app HTML containing the card app', async () => {
      const client = await connect();
      const { contents } = await client.readResource({ uri: TICKET_CARD_RESOURCE_URI });
      const content = contents[0] as { mimeType?: string; text?: string };
      expect(content.mimeType).toBe(MCP_APP_RESOURCE_MIME);
      expect(content.text).toBe(TICKET_CARD_HTML);
      expect(content.text).toContain('card__bar');
      expect(content.text).toContain('BRAND_INJECT');
      // The vite build must have inlined the bridge script — a bare <script src>
      // would be unloadable from a resources/read HTML string.
      expect(content.text).not.toContain('src="./ticket-card.ts"');
    });

    it('injects MCP_BRAND_* env branding at serve time', async () => {
      vi.stubEnv('MCP_BRAND_NAME', 'Acme MSP');
      const client = await connect();
      const { contents } = await client.readResource({ uri: TICKET_CARD_RESOURCE_URI });
      const text = (contents[0] as { text?: string }).text ?? '';
      expect(text).toContain('window.__BRAND__={"name":"Acme MSP"}');
      expect(text).not.toContain('BRAND_INJECT');
    });

    it('rejects unknown resource URIs', async () => {
      const client = await connect();
      await expect(
        client.readResource({ uri: 'ui://kaseya-bms/nope.html' })
      ).rejects.toThrow(/Unknown resource/);
    });

    it('default bundle is brand-neutral (published server — no baked-in identity)', () => {
      expect(TICKET_CARD_HTML).not.toMatch(/WYRE/i);
      expect(TICKET_CARD_HTML).not.toContain('fonts.googleapis.com');
      // Exactly one injection marker — serve-time branding replaces it wholesale.
      expect(TICKET_CARD_HTML.split('BRAND_INJECT').length - 1).toBe(1);
    });
  });

  describe('kaseya_bms_get_ticket result', () => {
    it('carries the normalized _card payload alongside the raw ticket', async () => {
      ticketsGetMock.mockResolvedValue(bmsTicket);
      accountsGetMock.mockResolvedValue({ Id: 77, Name: 'Acme Corp' });
      const client = await connect();
      const result = await client.callTool({
        name: 'kaseya_bms_get_ticket',
        arguments: { ticketId: '4821' },
      });
      expect(result.isError).toBeFalsy();
      const text = (result.content as Array<{ type: string; text?: string }>).find(
        (c) => c.type === 'text'
      )?.text;
      const payload = JSON.parse(text ?? '{}');
      // Raw ticket fields unchanged…
      expect(payload.Id).toBe(bmsTicket.Id);
      expect(payload.Subject).toBe(bmsTicket.Subject);
      // …with the flat, label-resolved card attached.
      expect(payload._card).toEqual({
        id: '4821',
        ticketNumber: 'T-2026-0042',
        title: 'VPN outage — main office',
        status: 'Open',
        priority: 'High',
        account: 'Acme Corp',
        assignedTo: 'Dana Ruiz',
        createdOn: '2026-07-17T09:00:00Z',
        modifiedOn: '2026-07-17T10:15:00Z',
        description: 'Users report VPN drops since 09:00.',
        noteDefaults: { isInternal: true },
      });
    });

    it('drops the card (not the result) for payloads that are not a ticket', async () => {
      ticketsGetMock.mockResolvedValue({ Message: 'not a ticket' });
      const client = await connect();
      const result = await client.callTool({
        name: 'kaseya_bms_get_ticket',
        arguments: { ticketId: '999' },
      });
      expect(result.isError).toBeFalsy();
      const text = (result.content as Array<{ type: string; text?: string }>).find(
        (c) => c.type === 'text'
      )?.text;
      const payload = JSON.parse(text ?? '{}');
      expect(payload.Message).toBe('not a ticket');
      expect(payload._card).toBeUndefined();
    });
  });

  describe('buildTicketCard', () => {
    const clientStub = { accounts: { get: accountsGetMock } } as never;

    it('normalizes the BMS ticket into the flat card payload', async () => {
      accountsGetMock.mockResolvedValue({ Id: 77, Name: 'Acme Corp' });
      const card = await buildTicketCard(bmsTicket, clientStub);
      expect(card).toMatchObject({
        id: '4821',
        ticketNumber: 'T-2026-0042',
        title: 'VPN outage — main office',
        status: 'Open',
        priority: 'High',
        account: 'Acme Corp',
        assignedTo: 'Dana Ruiz',
      });
    });

    it('always resolves internal-only note defaults for the add-note round-trip', async () => {
      accountsGetMock.mockResolvedValue({ Id: 77, Name: 'Acme Corp' });
      const card = await buildTicketCard(bmsTicket, clientStub);
      expect(card?.noteDefaults).toEqual({ isInternal: true });
    });

    it('falls back to Summary and TicketId (legacy Vorex field casings)', async () => {
      const card = await buildTicketCard(
        { TicketId: '99', Summary: 'Printer jam', AccountID: 5 },
        { accounts: { get: vi.fn().mockResolvedValue({ AccountName: 'Legacy Co' }) } } as never
      );
      expect(card).toMatchObject({ id: '99', title: 'Printer jam', account: 'Legacy Co' });
    });

    it('truncates long descriptions', async () => {
      const card = await buildTicketCard(
        { ...bmsTicket, AccountId: undefined, Description: 'x'.repeat(2000) },
        clientStub
      );
      expect(card?.description).toHaveLength(500);
    });

    it('survives account-lookup failures (card is best-effort)', async () => {
      accountsGetMock.mockRejectedValue(new Error('BMS 500'));
      const card = await buildTicketCard(bmsTicket, clientStub);
      expect(card).toMatchObject({ id: '4821', account: '#77' });
    });

    it('returns null for payloads that are not a ticket', async () => {
      expect(await buildTicketCard(undefined, clientStub)).toBeNull();
      expect(await buildTicketCard(null, clientStub)).toBeNull();
      expect(await buildTicketCard({ Message: 'nope' }, clientStub)).toBeNull();
      expect(await buildTicketCard({ Id: 1 }, clientStub)).toBeNull();
    });
  });

  describe('brand injection', () => {
    it('replaces the BRAND_INJECT marker with a window.__BRAND__ script', () => {
      const out = applyBrandInjection(TICKET_CARD_HTML, {
        name: 'Acme MSP',
        primaryColor: '#123456',
      });
      expect(out).not.toContain('BRAND_INJECT');
      expect(out).toContain('window.__BRAND__={"name":"Acme MSP","primaryColor":"#123456"}');
    });

    it('serves the HTML byte-identical when no brand is configured', () => {
      expect(applyBrandInjection(TICKET_CARD_HTML, {})).toBe(TICKET_CARD_HTML);
      expect(applyBrandInjection(TICKET_CARD_HTML, { name: '' })).toBe(TICKET_CARD_HTML);
    });

    it('escapes "<" so brand values cannot break out of the script element', () => {
      const out = applyBrandInjection(TICKET_CARD_HTML, { name: '</script><script>alert(1)' });
      expect(out).not.toContain('</script><script>alert(1)');
      expect(out).toContain('\\u003c/script');
    });

    it('resolveBrandFromEnv maps MCP_BRAND_* vars and ignores everything else', () => {
      vi.stubEnv('MCP_BRAND_NAME', 'Acme MSP');
      vi.stubEnv('MCP_BRAND_PRIMARY_COLOR', '#123456');
      expect(resolveBrandFromEnv()).toEqual({ name: 'Acme MSP', primaryColor: '#123456' });
    });
  });
});
