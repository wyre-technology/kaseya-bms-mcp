# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
- Ignore unresolved MCPB/DXT config placeholders (`${user_config.X}`) in
  credentials. When the optional Kaseya One token field was left blank, desktop
  hosts injected the literal `${user_config.kaseya_bms_k1_token}` string; because
  the client prefers the K1 token over the API token, that placeholder was sent
  as the SSO token and a valid API token was ignored, causing auth failures.
  Credentials are now sanitised at ingress (env and gateway header paths).
  Mirrors itglue-mcp #73.

### Added
- Initial scaffold of the Kaseya BMS MCP server.
- 10 tools: list/get/create tickets, add ticket notes, list time entries,
  accounts, contacts, contracts, service catalog, and KB search.
- stdio + HTTP transports with `env` and `gateway` auth modes.
- Stateless per-request server in HTTP mode for safe multi-tenant gateway use.
- Elicitation for destructive actions and missing date / status filters.
- CI, semantic-release, multi-stage Docker, MCPB packaging, and MCP Registry
  publishing workflows.
