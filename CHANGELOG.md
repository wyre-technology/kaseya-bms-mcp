# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Initial scaffold of the Kaseya BMS MCP server.
- 10 tools: list/get/create tickets, add ticket notes, list time entries,
  accounts, contacts, contracts, service catalog, and KB search.
- stdio + HTTP transports with `env` and `gateway` auth modes.
- Stateless per-request server in HTTP mode for safe multi-tenant gateway use.
- Elicitation for destructive actions and missing date / status filters.
- CI, semantic-release, multi-stage Docker, MCPB packaging, and MCP Registry
  publishing workflows.
