<div align="center">
  <h1>@cyanheads/noaa-climate-mcp-server</h1>
  <p><b>Search NOAA climate stations and datasets, fetch historical weather observations via MCP. STDIO or Streamable HTTP.</b>
  <div>10 Tools • 2 Resources</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.6.3-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/noaa-climate-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.0.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/noaa-climate-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/noaa-climate-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.0-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/noaa-climate-mcp-server/releases/latest/download/noaa-climate-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=noaa-climate-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvbm9hYS1jbGltYXRlLW1jcC1zZXJ2ZXIiXSwiZW52Ijp7Ik5PQUFfQ0RPX1RPS0VOIjoieW91ci10b2tlbi1oZXJlIn19) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22noaa-climate-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fnoaa-climate-mcp-server%22%5D%2C%22env%22%3A%7B%22NOAA_CDO_TOKEN%22%3A%22your-token-here%22%7D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://noaa-climate.caseyjhand.com/mcp](https://noaa-climate.caseyjhand.com/mcp)

</div>

---

## Overview

NOAA Climate Data Online (CDO) API v2 for historical weather observations, plus two separate NCEI bulk-CSV corpora — the Storm Events Database and Billion-Dollar Weather and Climate Disasters. Search locations and stations, fetch historical observations with date-range validation and unit conversion, and query severe-weather events or disaster costs from any MCP client. Runs as a stdio process, a local Streamable HTTP server, or the public hosted endpoint above.

### Tools

| Tool | Description |
|:---|:---|
| `noaa_climate_list_datasets` | List available CDO datasets with IDs, names, and temporal coverage |
| `noaa_climate_list_data_categories` | List data category groups (Temperature, Precipitation, Wind, etc.) |
| `noaa_climate_list_data_types` | List specific measurement labels (TMAX, TMIN, PRCP, SNOW, etc.) by dataset or category |
| `noaa_climate_list_location_categories` | List the 12 location categories that scope location search |
| `noaa_climate_find_locations` | Search geographic locations by category (states, cities, counties, zip codes, climate regions), with an optional name filter |
| `noaa_climate_find_stations` | Search weather stations by location, bounding box, dataset, and data type |
| `noaa_climate_get_station` | Fetch full metadata for a single station by ID |
| `noaa_climate_fetch_data` | Fetch historical observation records for a dataset and date range |
| `noaa_climate_search_storm_events` | Search the NCEI Storm Events Database for one year — tornadoes, hail, floods, hurricanes, with damage, casualties, and narratives |
| `noaa_climate_get_billion_dollar_disasters` | Query NOAA's Billion-Dollar Weather and Climate Disasters — CPI-adjusted costs and deaths per disaster, or per-year totals by disaster class |

### Resources

| Resource | Description |
|:---|:---|
| `noaa://datasets` | All CDO datasets with IDs and temporal coverage — injectable context for orienting an agent before querying data |
| `noaa://stations/{stationId}` | Station metadata by ID — name, coordinates, elevation, and data coverage date range |

## Capability reference

### `noaa_climate_list_datasets` <sub>tool</sub>

- No required parameters — returns all ~11 CDO datasets by default; optional filters by data type, location, station, or date range
- Paginated (`limit` 1–1000, default 25; `offset`), sortable by `id`, `name`, `mindate`, `maxdate`, or `datacoverage`
- Common IDs: GHCND (daily, 1763–present), GSOM (monthly), GSOY (annual), NORMAL_DLY/MLY/ANN/HLY (1981–2010 normals)

---

### `noaa_climate_list_data_categories` <sub>tool</sub>

- 42 categories total (Temperature, Precipitation, Wind, Pressure, Sunshine, Sky cover, Weather Type, and more)
- Optional filters by dataset, location, station, or date range; paginated (`limit` 1–1000, default 25; `offset`), sortable by `id` or `name`
- Use before `noaa_climate_list_data_types` to narrow by measurement domain

---

### `noaa_climate_list_data_types` <sub>tool</sub>

- Filter by `datasetId` (e.g. `GHCND`) or `datacategoryId` (e.g. `TEMP`) — hundreds of types exist across all datasets
- Common GHCND types: `TMAX`, `TMIN`, `PRCP`, `SNOW`, `SNWD`, `AWND`
- Coverage fraction and date range are included only when the upstream record carries them
- Paginated (`limit` 1–1000, default 25; `offset`)

---

### `noaa_climate_list_location_categories` <sub>tool</sub>

- Returns the 12 category IDs `noaa_climate_find_locations` accepts as `locationCategoryId`: `CITY`, `ST`, `CNTY`, `CNTRY`, `ZIP`, `US_TERR`, `CLIM_REG`, `CLIM_DIV`, `HYD_ACC`, `HYD_CAT`, `HYD_REG`, `HYD_SUB`
- Sortable by `id` or `name`; paginated (`limit` 1–1000, default 25; `offset`)
- Pagination and sort only — CDO ignores dataset, location, station, and date filters on this endpoint, so none are offered

---

### `noaa_climate_find_locations` <sub>tool</sub>

- `locationCategoryId` scopes the search (e.g. `ST` returns all 51 states in one call); omit it to return every location type
- `nameContains` synthesizes the name search CDO lacks by enumerating the category client-side and matching the substring case-insensitively — capped to categories of at most 4,000 locations (every category but `ZIP`, 30,415); a `datasetId`/`datacategoryId` filter can narrow a larger category under that limit
- Returns location IDs used by `noaa_climate_find_stations` and `noaa_climate_fetch_data` — `FIPS:37`, `CITY:US530018`, `ZIP:98101`
- Typed failures when `nameContains` is passed without `locationCategoryId`, or the resolved category is too large to enumerate
- Paginated (`limit` 1–1000, default 25; `offset`); sort alphabetically by `name` to page through an over-large category instead

---

### `noaa_climate_find_stations` <sub>tool</sub>

- Filter by `locationId`, `extent` (lat/lon bounding box), `datasetId`, `datatypeId` (array), and date range
- Returns station IDs, names, coordinates, elevation, and data-coverage dates — station IDs feed `noaa_climate_fetch_data` as `stationId`
- Pair `datasetId` and date range to confirm a returned station actually has data for what you plan to query
- Common station ID formats: `GHCND:USW00024233`, `COOP:010008`
- Paginated (`limit` 1–1000, default 25; `offset`)

---

### `noaa_climate_get_station` <sub>tool</sub>

- Single required input: `stationId`
- Returns name, coordinates, elevation, and full data-coverage date range
- Mirrors the `noaa://stations/{stationId}` resource as a direct call
- `not_found` when the ID is well-formed but resolves to nothing

---

### `noaa_climate_fetch_data` <sub>tool</sub>

- Requires `datasetId`, `startDate`, `endDate`; optional `stationId`, `locationId`, `datatypeId` filters (arrays)
- Date-range cap depends on dataset: GHCND, PRECIP_15, PRECIP_HLY, NORMAL_DLY, NORMAL_HLY, NEXRAD2, NEXRAD3 allow 1 year max; GSOM, GSOY, NORMAL_MLY, NORMAL_ANN allow 10 years max, measured to the end of the calendar month that many years after `startDate`
- `units: "metric"` or `"standard"` is strongly recommended — without it, GHCND values are raw tenths-of-unit integers (e.g. `TMAX=256` is 25.6°C)
- For any `NORMAL_*` dataset, use `startDate=2010-01-01` / `endDate=2010-12-31` — the fixed API proxy year regardless of which 30-year period is described
- `date_range_exceeded` reports the exact `maxEndDate` CDO will accept; an unrecognized `datasetId` fails `validation_error` before any network call
- Returns flat `{ date, datatype, station, value, attributes }` tuples plus an `effectiveQuery` echo of the applied filters

---

### `noaa_climate_search_storm_events` <sub>tool</sub>

- Separate NCEI bulk-CSV corpus — no token required; `year` is required (1950 through the current partial year, one file per year)
- Filter by `state` (the full NCEI name, e.g. `"FLORIDA"`, never a postal code), `eventType` (matched case-insensitively against the exact NWS label), `month`, and `minDamageInUsd`
- Damage arrives as both the raw magnitude-suffixed string (`"1.20M"`) and a parsed dollar amount; an unreported figure is omitted rather than reported as zero, and `minDamageInUsd` excludes those rows and reports how many it dropped
- `limit` 1–100 (default 50) with `offset`; a zero-match response names the event types and states the requested year actually contains
- `year_unavailable` when NCEI has no file for the year; `malformed_export` if a downloaded file fails to decompress into the expected table

---

### `noaa_climate_get_billion_dollar_disasters` <sub>tool</sub>

- Two shapes: individual disasters by default, or `summary=true` for per-year counts and costs by disaster class plus an "All Disasters" total
- Every cost is normalized to whole US dollars regardless of the unit NCEI declares per export (millions for the per-event file, billions for the national per-year file); the response echoes the source unit as `declaredCostUnit`
- Filter by `startYear`/`endYear` (overlap match), `disasterType` (one of seven exact NCEI classes), `minCostInUsd`, and `state` (two-letter postal code)
- A `state` scope reports each disaster's national cost, not a state share (`costBasis: "national"`), and its per-year rows carry a binned `costRangeInUsd` instead of a point estimate and confidence bands
- Coverage runs 1980 through the last year NCEI has finished assessing (`coveredYears`), not the current calendar year; `limit` 1–100 (default 50) with `offset`

---

### `noaa://datasets` <sub>resource</sub>

- All CDO datasets as `application/json` — IDs, names, temporal coverage
- Equivalent to `noaa_climate_list_datasets` with no filters and a high limit — injectable, zero-fetch context

---

### `noaa://stations/{stationId}` <sub>resource</sub>

- Station metadata by ID — mirrors `noaa_climate_get_station`
- `stationId` comes from `noaa_climate_find_stations`
- `not_found` when the ID is well-formed but resolves to nothing

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

NOAA-specific:

- Full CDO API v2 coverage — datasets, data categories, data types, locations, stations, and observations — plus two separate NCEI bulk-CSV corpora requiring no token: severe-weather events (Storm Events Database) and billion-dollar disaster costs
- Client-side date-range validation enforced per dataset before hitting the API, reporting the exact upstream limit back to the caller
- Unit normalization via CDO's `units` parameter avoids raw tenths-of-unit integer confusion
- CDO's own rejection message is recovered and surfaced — an over-long date range, malformed date, missing parameter, or over-large `limit` reports the reason CDO gave instead of a bare status line
- Billion-Dollar Disasters costs are converted to whole US dollars from whichever unit each NCEI export declares in its own preamble, since the unit differs by export

Agent-friendly output:

- Paginated results across every list and search tool — `limit`, `offset`, and total count in every response
- Station, location, and dataset IDs flow naturally between tools — find a location, find stations in it, fetch data from those stations
- Structured error contracts with typed `reason` codes and recovery hints — agents branch on data, not string parsing
- Damage and cost fields are honest about upstream gaps — an unreported NCEI figure is omitted rather than reported as a confirmed zero

## Getting started

### Public Hosted Instance

A public instance is available at `https://noaa-climate.caseyjhand.com/mcp` — no installation required. Point any MCP client at it via Streamable HTTP:

```json
{
  "mcpServers": {
    "noaa-climate-mcp-server": {
      "type": "streamable-http",
      "url": "https://noaa-climate.caseyjhand.com/mcp"
    }
  }
}
```

### Self-Hosted / Local

Add the following to your MCP client configuration file.

```json
{
  "mcpServers": {
    "noaa-climate-mcp-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/noaa-climate-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info",
        "NOAA_CDO_TOKEN": "your-token-here"
      }
    }
  }
}
```

Or with npx (no Bun required):

```json
{
  "mcpServers": {
    "noaa-climate-mcp-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cyanheads/noaa-climate-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info",
        "NOAA_CDO_TOKEN": "your-token-here"
      }
    }
  }
}
```

Or with Docker:

```json
{
  "mcpServers": {
    "noaa-climate-mcp-server": {
      "type": "stdio",
      "command": "docker",
      "args": ["run", "-i", "--rm", "-e", "MCP_TRANSPORT_TYPE=stdio", "-e", "NOAA_CDO_TOKEN=your-token-here", "ghcr.io/cyanheads/noaa-climate-mcp-server:latest"]
    }
  }
}
```

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 NOAA_CDO_TOKEN=your-token-here bun run start:http
# Server listens at http://localhost:3010/mcp
```

### Prerequisites

- [Bun v1.4.0](https://bun.sh/) or higher (or Node.js ≥24.0.0).
- A free [NOAA CDO API token](https://www.ncdc.noaa.gov/cdo-web/token) — required for all requests.

### Installation

1. **Clone the repository:**

```sh
git clone https://github.com/cyanheads/noaa-climate-mcp-server.git
```

2. **Navigate into the directory:**

```sh
cd noaa-climate-mcp-server
```

3. **Install dependencies:**

```sh
bun install
```

4. **Configure environment:**

```sh
cp .env.example .env
# edit .env and set required vars
```

## Configuration

All configuration is validated at startup via Zod schemas in `src/config/server-config.ts`. Key environment variables:

| Variable | Description | Default |
|:---|:---|:---|
| `NOAA_CDO_TOKEN` | **Required.** NOAA CDO API token — obtain free at [ncdc.noaa.gov/cdo-web/token](https://www.ncdc.noaa.gov/cdo-web/token) | — |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http` | `stdio` |
| `MCP_HTTP_PORT` | HTTP server port | `3010` |
| `MCP_HTTP_ENDPOINT_PATH` | HTTP endpoint path where the MCP server is mounted | `/mcp` |
| `MCP_SESSION_MODE` | HTTP session posture: `stateful`, `stateless`, or `auto`. Ships as `stateless` — no tool asks the caller for input mid-handler | `stateless` |
| `MCP_PUBLIC_URL` | Public origin override for TLS-terminating reverse-proxy deployments | none |
| `MCP_AUTH_MODE` | Authentication: `none`, `jwt`, or `oauth` | `none` |
| `MCP_LOG_LEVEL` | Log level (`debug`, `info`, `warning`, `error`, etc.) | `info` |
| `MCP_GC_PRESSURE_INTERVAL_MS` | Opt-in Bun-only forced-GC pressure loop (ms). Try `60000` if heap growth is observed under sustained HTTP load. | `0` (disabled) |
| `STORAGE_PROVIDER_TYPE` | Storage backend: `in-memory`, `filesystem`, `supabase`, `cloudflare-kv/r2/d1` | `in-memory` |
| `OTEL_ENABLED` | Enable OpenTelemetry | `false` |

See [`.env.example`](./.env.example) for the full list of optional overrides.

## Running the server

### Local development

- **Build and run the production version**:

  ```sh
  # One-time build
  bun run rebuild

  # Run the built server
  bun run start:http
  # or
  bun run start:stdio
  ```

- **Run checks and tests**:
  ```sh
  bun run devcheck  # Lints, formats, type-checks, and more
  bun run test      # Runs the test suite
  bun run test:live # Opt-in: resolves every documented example identifier against the live CDO API
  ```

### Docker

```sh
docker build -t noaa-climate-mcp-server .
docker run --rm -e NOAA_CDO_TOKEN=your-token-here -p 3010:3010 noaa-climate-mcp-server
```

The Dockerfile defaults to HTTP transport, stateless session mode, and logs to `/var/log/noaa-climate-mcp-server`. OpenTelemetry peer dependencies are installed by default — build with `--build-arg OTEL_ENABLED=false` to omit them.

## Project structure

| Directory | Purpose |
|:---|:---|
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`). Ten tools across datasets, locations, stations, observations, storm events, and disaster costs. |
| `src/mcp-server/resources` | Resource definitions. Datasets catalog and station metadata resources. |
| `src/services/cdo` | CDO HTTP client with retry, backoff, camelCase→lowercase parameter translation, and recovery of CDO's own rejection message. |
| `src/services/csv` | Incremental RFC 4180 CSV reader shared by the two NCEI bulk-CSV corpora. |
| `src/services/storm-events` | NCEI Storm Events bulk-CSV client — filename discovery, streamed decompression, damage parsing. |
| `src/services/billion-dollar-disasters` | NCEI Billion-Dollar Disasters client — declared-unit resolution and conversion to whole US dollars. |
| `src/config` | Server-specific environment variable parsing and validation with Zod. |
| `tests/` | Unit and integration tests, mirroring the `src/` structure. |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for logging, `ctx.state` for storage
- Register new tools and resources in the `createApp()` arrays
- Wrap external API calls as validate raw → normalize to domain types → return the output schema; never fabricate missing fields

## Contributing

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

This project is licensed under the Apache 2.0 License. See the [LICENSE](./LICENSE) file for details.
