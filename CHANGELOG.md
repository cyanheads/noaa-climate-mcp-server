# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

## [0.6.3](changelog/0.6.x/0.6.3.md) — 2026-09-16

Adopts mcp-ts-core 0.13.2 — strict argument-rejection responses, CDO 500 retry-with-backoff, explicit SIGTERM/SIGINT exit, and session mode declared in source; fixes plugin manifests that shipped a placeholder NOAA_CDO_TOKEN.

## [0.6.2](changelog/0.6.x/0.6.2.md) — 2026-08-24

Adopts MCP SDK v2 with protocol revision 2026-07-28 support and strict tool-wire contracts.

## [0.6.1](changelog/0.6.x/0.6.1.md) — 2026-08-18

service_unavailable now reaches all eight CDO-backed tools where it was previously declared but unreachable, and a new rate_limited reason routes a throttled token separately.

## [0.6.0](changelog/0.6.x/0.6.0.md) — 2026-08-18

Adds noaa_climate_get_billion_dollar_disasters over NCEI's Billion-Dollar Weather and Climate Disasters, with every cost normalized to whole US dollars; CDO's own rejection message is now recovered, and a rejected NOAA_CDO_TOKEN routes to a dedicated upstream_auth_failed reason across all eight CDO tools.

## [0.5.0](changelog/0.5.x/0.5.0.md) — 2026-08-18

Adds noaa_climate_search_storm_events over the NCEI Storm Events Database (tornadoes, hail, floods, hurricanes) — a separate, tokenless bulk-CSV corpus from the existing CDO tools, with damage figures that distinguish unreported from a confirmed zero.

## [0.4.0](changelog/0.4.x/0.4.0.md) — 2026-08-18

Adds noaa_climate_list_location_categories and a nameContains name filter on find_locations; fixes fetch_data's date-range cap to follow CDO's calendar-month rule (was rejecting a full leap year) and extends it to NEXRAD radar; normalizes outbound date filters to CDO's canonical wire form; sweeps dead example identifiers.

## [0.3.0](changelog/0.3.x/0.3.0.md) — 2026-08-18 · ⚠️ Breaking

Validates date and identifier inputs across all seven tools before calling CDO (breaking schema narrowing); fixes fetch_data's metadata-total collapse and exhausted-page pagination; adds a typed not-found contract to the station resource. mcp-ts-core ^0.10.9 → ^0.11.5.

## [0.2.0](changelog/0.2.x/0.2.0.md) — 2026-06-21 · ⚠️ Breaking

Rename noaa-cdo-mcp-server → noaa-climate-mcp-server; tool prefix noaa_* → noaa_climate_* across all 7 tools. Breaking: new package name and tool ids. Install @cyanheads/noaa-climate-mcp-server; the old package is deprecated.

## [0.1.15](changelog/0.1.x/0.1.15.md) — 2026-06-20

Adopt @cyanheads/mcp-ts-core ^0.10.9 — check-dependency-specifiers devcheck guard, plugin-manifest packaging checks, synced framework scripts + skills; dev-dependency refresh

## [0.1.14](changelog/0.1.x/0.1.14.md) — 2026-06-12

Adopt @cyanheads/mcp-ts-core 0.10.6; explicit name/title identity, MCPB bundle agent-doc cleaner, packaging identity + bundle-content lints, Dockerfile healthcheck

## [0.1.13](changelog/0.1.x/0.1.13.md) — 2026-06-08

noaa_fetch_data pre-request datasetId validation, noaa_get_station not_found recovery hint, corrected entity counts in two tool descriptions

## [0.1.12](changelog/0.1.x/0.1.12.md) — 2026-06-04

HTTP 400 errors from the NOAA CDO API now surface as structured validation_error with recovery hints across all 6 tools

## [0.1.11](changelog/0.1.x/0.1.11.md) — 2026-06-02

Adopt @cyanheads/mcp-ts-core 0.9.21 — per-request log context fix, secret scrubbing from error messages, withRetry fail-fast on non-retryable errors

## [0.1.10](changelog/0.1.x/0.1.10.md) — 2026-05-30

Enrichment adoption — discovery and fetch tools now surface query echoes, result totals, and empty-result guidance in a typed enrichment block.

## [0.1.9](changelog/0.1.x/0.1.9.md) — 2026-05-28 · 🛡️ Security

mcp-ts-core ^0.9.9 → ^0.9.13: 413 body cap, HTTP session-init gate, quieter 401/403/400/404 logging, landing.requireAuth, GET /mcp keywords

## [0.1.8](changelog/0.1.x/0.1.8.md) — 2026-05-24

code simplification, mcp-ts-core ^0.9.7 → ^0.9.9, error code corrections

## [0.1.7](changelog/0.1.x/0.1.7.md) — 2026-05-24

pagination offset fix and dead error contract cleanup

## [0.1.6](changelog/0.1.x/0.1.6.md) — 2026-05-23

hosted server endpoint — remotes block in server.json, public URL in README

## [0.1.5](changelog/0.1.x/0.1.5.md) — 2026-05-23

metadata alignment — package.json scripts use bun, tsx removed from devDeps, .env.example restructured, .gitignore/.mcpbignore aligned, Dockerfile labels updated, server.json MCP_PUBLIC_URL added, manifest.json reformatted

## [0.1.4](changelog/0.1.x/0.1.4.md) — 2026-05-23

sync tagline across all surfaces — package.json, server.json, manifest.json, README, GitHub description

## [0.1.3](changelog/0.1.x/0.1.3.md) — 2026-05-24

not-found guard for noaa_get_station, resource double-encoding fix, 1-based offset descriptions across 6 tools, metadata polish

## [0.1.2](changelog/0.1.x/0.1.2.md) — 2026-05-23

Station resource not-found handling: detect empty-object responses from NOAA CDO and throw a not-found error

## [0.1.1](changelog/0.1.x/0.1.1.md) — 2026-05-23

NOAA Climate Data Online MCP server — 7 tools and 2 resources for historical weather observations

## [0.1.0](changelog/0.1.x/0.1.0.md) — 2026-05-23

Initial release — NOAA CDO API v2 MCP server with 7 tools and 2 resources for historical weather data access
