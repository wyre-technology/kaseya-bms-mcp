# Kaseya BMS MCP Server

[![Release](https://github.com/wyre-technology/kaseya-bms-mcp/actions/workflows/release.yml/badge.svg)](https://github.com/wyre-technology/kaseya-bms-mcp/actions/workflows/release.yml)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

Model Context Protocol (MCP) server for the Kaseya BMS PSA API.
Exposes tickets, accounts, contacts, contracts, time entries, the service
catalog, and the knowledge base to AI assistants.

## Tools

| Tool | Description |
|------|-------------|
| `kaseya_bms_list_tickets` | List tickets. Optional `$filter`; status pick if omitted. |
| `kaseya_bms_get_ticket` | Get a ticket by id. |
| `kaseya_bms_create_ticket` | Create a new ticket (destructive — confirmation required). |
| `kaseya_bms_add_ticket_note` | Append a note to a ticket (destructive — confirmation required). |
| `kaseya_bms_list_time_entries` | Time entries by date range (24h / 7d / 30d / custom / all). |
| `kaseya_bms_list_accounts` | Accounts (clients). |
| `kaseya_bms_list_contacts` | Contacts. |
| `kaseya_bms_list_contracts` | Contracts. |
| `kaseya_bms_list_service_catalog` | Service catalog items. |
| `kaseya_bms_search_knowledge_base` | Knowledge base search. |

When the user omits required filters or runs a destructive action, the server
uses MCP elicitation to prompt for choices or confirm.

## Configuration

### Environment-variable mode (default)

| Variable | Required | Description |
|----------|----------|-------------|
| `KASEYA_BMS_TENANT_SUBDOMAIN` | yes | Tenant subdomain (e.g. `yourcompany`) |
| `KASEYA_BMS_API_TOKEN` | one of | BMS API token (secret) |
| `KASEYA_BMS_K1_TOKEN` | one of | Kaseya One SSO token (secret) |
| `MCP_TRANSPORT` | no | `stdio` (default) or `http` |
| `MCP_HTTP_PORT` | no | HTTP listen port (default `8080`) |
| `AUTH_MODE` | no | `env` (default) or `gateway` |

Either `KASEYA_BMS_API_TOKEN` OR `KASEYA_BMS_K1_TOKEN` is required.

### Gateway mode

When deployed behind the WYRE MCP Gateway, set `AUTH_MODE=gateway` and the
server will read credentials from per-request HTTP headers:

- `X-Kaseya-BMS-Tenant-Subdomain` (required)
- `X-Kaseya-BMS-API-Token` (or)
- `X-Kaseya-BMS-K1-Token`

Each request creates a fresh server instance with isolated credentials — no
cross-tenant `process.env` pollution.

## Local development

```bash
npm install
npm run build
KASEYA_BMS_TENANT_SUBDOMAIN=yourcompany \
  KASEYA_BMS_API_TOKEN=... \
  npm start
```

Run as HTTP for testing:

```bash
MCP_TRANSPORT=http npm start
curl http://localhost:8080/health
```

## Docker

```bash
docker build -t kaseya-bms-mcp .
docker run --rm -p 8080:8080 \
  -e KASEYA_BMS_TENANT_SUBDOMAIN=yourcompany \
  -e KASEYA_BMS_API_TOKEN=... \
  kaseya-bms-mcp
```

## License

Apache-2.0
