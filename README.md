<div align="center">
  <h1>@cyanheads/noaa-climate-mcp-server</h1>
  <p><b>Search NOAA climate stations and datasets, fetch historical weather observations via MCP. STDIO or Streamable HTTP.</b>
  <div>11 Tools • 2 Data Resources • 1 Skill</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.8.0-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/noaa-climate-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.4.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/noaa-climate-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/noaa-climate-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.4-blueviolet.svg?style=flat-square)](https://bun.sh/)

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

Historical weather and climate records from NOAA: station observations from Climate Data Online, 1991–2020 U.S. Climate Normals, the Storm Events Database, and Billion-Dollar Weather and Climate Disasters. Find stations, pull observations in the units you want, read a station's current normals, and look up storm damage or disaster costs.

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
| `noaa_climate_get_normals` | Read one station's 1991–2020 U.S. Climate Normals — monthly, daily, hourly, or annual/seasonal — with completeness flags |
| `noaa_climate_search_storm_events` | Search the NCEI Storm Events Database for one year — tornadoes, hail, floods, hurricanes, with damage, casualties, narratives, and the county's CDO location ID |
| `noaa_climate_get_billion_dollar_disasters` | Query NOAA's retired 1980–2024 Billion-Dollar Weather and Climate Disasters archive — CPI-adjusted costs and deaths per disaster, or per-year totals by disaster class |

### Resources

| Resource | Description |
|:---|:---|
| `noaa://datasets` | All CDO datasets with IDs and temporal coverage — injectable context for orienting an agent before querying data |
| `noaa://stations/{stationId}` | Station metadata by ID — name, coordinates, elevation, and data coverage date range |

### Agent skill

[noaa-climate-guide](skills/noaa-climate-guide/SKILL.md) covers historical comparisons, coverage checks, observation quality, and storm-to-station investigation. It ships with plugin, npm, Docker, and MCPB installs and is served through the MCP Skills extension and a skill resource alongside the two data resources.

## Capability reference

Every CDO `stationId` input, including the station resource, trims surrounding whitespace and uppercases IDs. Bare 11-character GHCN IDs (`USW00024233`) become `GHCND:USW00024233`. Namespaced IDs such as `COOP:454769`, `NEXRAD:KATX`, and unfamiliar nonempty namespace/payload pairs remain accepted; ambiguous bare IDs are rejected. Tools disclose changes in a notice; the resource returns the canonical station ID. Syntax does not establish that a station exists.

`noaa_climate_get_normals` takes a GHCN-Daily ID only, bare or with a `GHCND:` prefix, and sends the bare form: NCEI matches IDs case-sensitively, so an ID written entirely in lowercase is uppercased and a mixed-case legacy ID such as `US10adam002` goes as written. Other namespaces such as `COOP:454769` are rejected rather than returning an empty result.

### `noaa_climate_list_datasets` <sub>tool</sub>

- No required inputs; optional data type, location, station, and date-range filters; `limit` 1–1000 (default 25) with `offset`, sortable by `id`, `name`, `mindate`, `maxdate`, or `datacoverage`
- Returns each dataset's ID, name, and date span — GHCND (daily, 1763–present), GSOM (monthly), GSOY (annual), NORMAL_DLY/MLY/ANN/HLY (the superseded 1981–2010 normals; `noaa_climate_get_normals` serves 1991–2020)
- Date filters use inclusive coverage overlap: `maxdate >= startDate` and `mindate <= endDate` for each supplied bound. The complete catalog matching the other filters is retrieved before filtering and pagination; totals describe that filtered view.

---

### `noaa_climate_list_data_categories` <sub>tool</sub>

- Optional dataset, location, station, and date-range filters; `limit` 1–1000 (default 25) with `offset`, sortable by `id` or `name`
- Returns the 42 measurement categories (Temperature, Precipitation, Wind, Pressure, Sunshine, and more), whose IDs narrow `noaa_climate_list_data_types` as `datacategoryId`

---

### `noaa_climate_list_data_types` <sub>tool</sub>

- Filter by `datasetId` (e.g. `GHCND`) or `datacategoryId` (e.g. `TEMP`); `limit` 1–1000 (default 25) with `offset`
- Returns the datatype IDs `noaa_climate_fetch_data` takes — common GHCND types are `TMAX`, `TMIN`, `PRCP`, `SNOW`, `SNWD`, `AWND` — with coverage and date range when CDO carries them

---

### `noaa_climate_list_location_categories` <sub>tool</sub>

- Pagination and sort only: `limit` 1–1000 (default 25) with `offset`, sortable by `id` or `name`
- Returns the 12 category IDs `noaa_climate_find_locations` accepts as `locationCategoryId`: `CITY`, `ST`, `CNTY`, `CNTRY`, `ZIP`, `US_TERR`, `CLIM_REG`, `CLIM_DIV`, `HYD_ACC`, `HYD_CAT`, `HYD_REG`, `HYD_SUB`

---

### `noaa_climate_find_locations` <sub>tool</sub>

- `locationCategoryId` scopes the search (e.g. `ST` returns all 51 states); optional `datasetId`, `datacategoryId`, and date-range filters; `limit` 1–1000 (default 25) with `offset`
- Returns the location IDs `noaa_climate_find_stations` and `noaa_climate_fetch_data` take — `FIPS:37`, `CITY:US530018`, `ZIP:98101`
- `nameContains` adds a case-insensitive name match within one category of at most 4,000 locations (every category but `ZIP`); it fails as `name_filter_requires_category` without a category and `name_filter_category_too_large` past the cap

---

### `noaa_climate_find_stations` <sub>tool</sub>

- Filter by `locationId`, `extent` (lat/lon bounding box), `datasetId`, `datatypeId` (array), and date range; `limit` 1–1000 (default 25) with `offset`
- `extent` is `minLat,minLon,maxLat,maxLon`: four finite signed decimal or scientific numbers, with surrounding whitespace allowed, latitude within ±90 and longitude within ±180. Equal coordinates work; reversed axes return no matches and are forwarded unchanged, without antimeridian wrapping.
- Returns station IDs (`GHCND:USW00024233`, `COOP:010008`), names, coordinates, elevation, and data-coverage dates — the IDs feed `noaa_climate_fetch_data` as `stationId`

---

### `noaa_climate_get_station` <sub>tool</sub>

- Single required input: `stationId`, from `noaa_climate_find_stations`; the tool form of the `noaa://stations/{stationId}` resource
- Returns name, coordinates, elevation, and the full data-coverage date range; fails as `not_found` when a well-formed ID resolves to nothing

---

### `noaa_climate_fetch_data` <sub>tool</sub>

- Requires `datasetId`, `startDate`, `endDate`; optional `stationId`, `locationId`, `datatypeId` arrays. The span cap is 1 year for GHCND, PRECIP_15, PRECIP_HLY, NORMAL_DLY, NORMAL_HLY, NEXRAD2, NEXRAD3 and 10 years for GSOM, GSOY, NORMAL_MLY, NORMAL_ANN; any `NORMAL_*` dataset takes `startDate=2010-01-01` / `endDate=2010-12-31`. The `NORMAL_*` datasets are the superseded 1981–2010 normals; read 1991–2020 with `noaa_climate_get_normals`, and a notice on `NORMAL_*` pages says so.
- Returns flat observation records plus an `effectiveQuery` echo; `date_range_exceeded` names the latest `maxEndDate` CDO will accept. The encoded query ceiling is 4000 characters; longer queries fail as `validation_error` before any request. Reduce `stationId`, `locationId`, and `datatypeId` filters and make separate calls. Filters are never discarded or automatically split.
- Request `units: "metric"` or `"standard"`. Omission preserves NOAA's raw values and adds dataset-specific guidance, including on empty pages. Examples: GHCND `TMAX`/`TMIN` use tenths °C, `PRCP` tenths mm, and `SNOW`/`SNWD` whole mm; GSOM/GSOY temperature and precipitation use °C/mm; NORMAL_* temperature normals use tenths °F, degree days whole °F-days, and precipitation normals hundredths inches; PRECIP_HLY `HPCP` and PRECIP_15 `QPCP` use hundredths inches. Units and scale depend on datatype; these examples do not describe wind, direction, counts, percentages, or every snow datatype. See [NOAA's dataset documentation](https://www.ncei.noaa.gov/pub/data/cdo/documentation/).
- Under `units=metric`, CDO converts some `NORMAL_*` degree days, diurnal temperature ranges, and standard deviations as if they were temperatures, so the numbers are wrong: `-HTDD-NORMAL`, `-CLDD-NORMAL`, `-GRDD-TB4886`, `-GRDD-TB5086`, and `-DUTR-NORMAL` on NORMAL_MLY and NORMAL_ANN; `-STDDEV` on NORMAL_MLY; `-DUTR-NORMAL` and `-STDDEV` on NORMAL_DLY. Values are kept as CDO returned them and a notice names the affected datatypes. To recover them, omit `units` and convert the raw values: degree days are whole °F-days (×5/9 for °C-days), and ranges and standard deviations are tenths °F (×1/18 for °C). `units=standard` is no substitute, since it leaves the seasonal ranges unscaled.
- `NORMAL_*` pages can carry NCEI special-value codes: `-9999` missing or insufficient data, `-7777` a non-zero value that would round to zero, `-6666` parameter undefined, `-4444` year-round frost-freeze risk. They are not measurements and are kept as CDO returned them, with a notice naming the datatypes that carry them.
- PRECIP_HLY `HPCP` and PRECIP_15 `QPCP` missing sentinels become `missing: true` with `value` omitted: `99999` without units, `999.99` standard, or `25399.75` metric. Rows, raw `attributes`, order, totals, and offsets remain intact. Zero, trace, and accumulation-end measurements remain values; flags alone do not mark a row missing. A notice counts missing observations on this page.
- GHCND `attributes` remain raw and are also decoded as `flags: { measurement, quality, source, observationTime }`. Explicit blank slots and leading-zero times are preserved; absent trailing positions remain omitted. A nonblank `quality` means the observation failed a quality check. A notice counts those rows on this page; numeric values remain available for callers to decide how to aggregate them. Other datasets retain their raw attributes without GHCND decoding. See [GHCND's flag layout](https://www.ncei.noaa.gov/pub/data/cdo/documentation/GHCND_documentation.pdf).

---

### `noaa_climate_get_normals` <sub>tool</sub>

- No token required; reads NCEI's Access Data Service, not CDO. Takes one GHCN-Daily `stationId` per call (`USW00024233`), a `granularity` (`monthly`, `daily`, `hourly`, or `annualseasonal`), optional `datatypeId` (1–50 IDs held to the granularity's prefix), `month` (1–12), `limit` 1–1000 (default 100), and `offset`
- Returns NOAA's current 1991–2020 U.S. Climate Normals as flat records, one datatype on one row, with an `effectiveQuery` echo. `date` is NCEI's row key with no year (`"01"`, `"01-31"`, `"01-01T00:00:00"` in local standard time) and is absent for `annualseasonal`. Defaults: monthly and annual/seasonal read average, maximum, and minimum temperature, precipitation, and snowfall (`MLY-TAVG-NORMAL`, `ANN-PRCP-NORMAL`, and so on); daily reads `DLY-TAVG-NORMAL`, `DLY-TMAX-NORMAL`, `DLY-TMIN-NORMAL`; hourly reads `HLY-TEMP-NORMAL` and `HLY-DEWP-NORMAL`. NCEI's documentation for each product lists the other datatypes: degree days, standard deviations, percentiles, frost dates.
- `hourly` requires `month`, since a full year is 8,760 rows per datatype; `annualseasonal` rejects it, and its seasons are the `DJF-`, `MAM-`, `JJA-`, and `SON-` datatype prefixes. `daily` with a `month` narrows to that month and February includes `02-29`.
- Values stay in NCEI's native units and are never converted: the tool does not send `units`, because the service's conversion is wrong for some datatypes. `unit` is labeled for temperature and dew point (`°F`), precipitation and snowfall (`in`), base-65 heating and cooling degree days (`°F-days` on the monthly, daily, seasonal, and annual `-HTDD-NORMAL` and `-CLDD-NORMAL`), and hourly sea-level pressure (`hPa` on `HLY-PRES-NORMAL`, `HLY-PRES-10PCTL`, and `HLY-PRES-90PCTL`; NCEI's documentation says inches of mercury, but the values are hPa); any other datatype has none, degree days at other bases included, and a notice links NCEI's documentation.
- Each record carries NCEI's `completeness` flag and `years` of data: `S` is a standard normal, while `R`, `P`, and `E` are built from fewer years or estimated from nearby stations. A notice counts the non-standard records on the page. NCEI's `-9999` special value becomes `missing: true` with `value` omitted, and its `measurementFlag` is relayed.
- About 15,600 stations carry monthly, daily, and annual/seasonal normals and about 470 carry hourly; precipitation-only stations carry no temperature normals. NCEI answers an unknown station and a station without normals alike, so both return a successful empty result whose notice points to `noaa_climate_get_station` and `noaa_climate_find_stations`. When the ID was written with a lowercase letter, the notice also names its case as a cause: NCEI matches IDs case-sensitively, the ID should be passed exactly as `noaa_climate_find_stations` lists it, and `noaa_climate_get_station` cannot resolve the mixed-case legacy CoCoRaHS IDs (about 290 stations with normals). A requested datatype no row carries is named in the notice while the rest return.
- Fails as `validation_error` (a datatype outside the granularity's prefixes, `month` missing for `hourly` or given for `annualseasonal`, or a parameter NCEI rejected), `service_unavailable` (unreachable, a server error other than 504, or a body that is not JSON rows), or `rate_limited`. A 504 and a request that times out, its 45-second deadline included, fail with the `Timeout` code and no declared reason, as on the CDO tools.

---

### `noaa_climate_search_storm_events` <sub>tool</sub>

- No token required; `year` selects one export (1950 through the current partial year); filter by `episodeId` (exact digit string from a returned event; whitespace is trimmed, blank means unset, leading zeros remain significant), `state` (the full NCEI name, e.g. `"FLORIDA"`), `countyFips` (five digits, optionally behind `FIPS:`, e.g. `"53043"`), `eventType`, `month`, `startDate`/`endDate`, and `minDamageInUsd`; page ceiling 100 (default 10) with `offset`
- Events carry `stateFips` and `czFips` (NCEI's codes, zero-padded to two and three digits), `wfo` (the NWS forecast office), `beginLocation` (the place NWS measures the start from, not the start point), and `endLatitude`/`endLongitude` (a tornado's track end), each omitted when NCEI left the cell blank. `cdoLocationId` (`FIPS:53043` for Lincoln County, WA) is the `locationId` that `noaa_climate_find_stations` and `noaa_climate_fetch_data` take. It appears only on county rows (`countyOrZoneType` `C`) in DC and every state but Alaska, whose county rows carry NWS zone numbers; zone and marine rows and the territories (NCEI writes them as `96`–`99`) have none.
- `countyFips` selects exactly the events whose `cdoLocationId` it names, ANDed with the other filters and applied before damage accounting, totals, and paging. A county whose events were filed under forecast zones returns nothing, and the zero-match notice says so. CDO's county catalog can lag Census changes: the export writes Oglala Lakota County, SD as 46102 while CDO still lists it under its former name, Shannon County (46113), so when CDO returns no stations for a `cdoLocationId`, search stations by `extent` around the event coordinates.
- Optional `startDate`/`endDate` are real `YYYY-MM-DD` dates and match inclusive event-span overlap before damage accounting, totals, and pagination. One-sided, equal, and cross-year intervals work; only `year` selects the export. Active date bounds exclude missing, invalid, or reversed source spans; without bounds those rows remain visible. `appliedDateRange` echoes supplied bounds on both surfaces. Reversed request dates fail as `invalid_date_range` before downloading.
- Each distinct episode narrative appears once in `episodeNarratives`, linked from events by `episodeNarrativeRef`; individual `eventNarrative` text stays on each event. Rendered narratives preserve literal punctuation and line breaks. Optional local ISO `beginDate`/`endDate` values can feed CDO date filters alongside the unchanged NCEI date-time and timezone fields.
- Damage arrives as the raw magnitude-suffixed string (`"1.20M"`) and a parsed dollar amount, omitted rather than zeroed when NCEI reported none; a zero-match response names the event types and states the year contains
- Fails as `year_unavailable` when NCEI publishes no file for the year, and `malformed_export` when a downloaded file is not the expected table

---

### `noaa_climate_get_billion_dollar_disasters` <sub>tool</sub>

- Individual disasters by default, or `summary=true` for per-year counts and costs by disaster class; filter by `startYear`/`endYear`, `disasterType` (one of seven NCEI classes), `minCostInUsd`, and `state` (two-letter postal code); `limit` 1–100 (default 50) with `offset`
- Every cost is whole US dollars whatever unit the export declares (echoed as `declaredCostUnit`); a `state` scope reports national costs (`costBasis: "national"`) and binned per-year `costRangeInUsd`
- NOAA retired the product after 2024; the 1980–2024 archive remains available with no later years added. `coveredYears` reports the span actually present in the selected export. Every successful response carries this archive notice alongside any clamp or paging guidance.
- CPI-adjusted costs preserve the archived export’s adjustment; the server does not rebase them to current prices or infer a CPI base year.

---

### `noaa://datasets` <sub>resource</sub>

- All CDO datasets as `application/json` — IDs, names, temporal coverage
- Equivalent to `noaa_climate_list_datasets` with no filters and a high limit — injectable, zero-fetch context

---

### `noaa://stations/{stationId}` <sub>resource</sub>

- `stationId` from `noaa_climate_find_stations`; the resource form of `noaa_climate_get_station`
- Returns station metadata; fails as `not_found` when a well-formed ID resolves to nothing

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

NOAA-specific:

- Full CDO API v2 coverage — datasets, data categories, data types, locations, stations, and observations — plus three separate NCEI sources requiring no token: 1991–2020 climate normals (Access Data Service), and two bulk-CSV corpora, severe-weather events (Storm Events Database) and billion-dollar disaster costs
- Client-side date-range validation enforced per dataset before hitting the API, reporting the exact upstream limit back to the caller
- Discovery date intervals reject `startDate > endDate` before any request, with `validation_error` and a hint to swap the values. Equal and single-ended dates remain valid; compact `YYYYMMDD`, unpadded dashed dates, and supported second-precision datetime forms are normalized for comparison.
- Unit conversion via CDO's `units` parameter, with datatype-qualified guidance when raw values are requested
- CDO's own rejection message is recovered and surfaced — an over-long date range, malformed date, or missing parameter reports the reason CDO gave instead of a bare status line
- Billion-Dollar Disasters costs are converted to whole US dollars from whichever unit each NCEI export declares in its own preamble, since the unit differs by export

Agent-friendly output:

- Paginated results across every list and search tool — zero-based `offset` in inputs and returned metadata. Locally filtered dataset and location views synthesize metadata from the filtered results; other CDO pages preserve absent upstream metadata. Coordinates and coverage retain upstream precision; coverage text uses raw fractions labeled 0–1.
- Positive integer read limits are clamped to the page ceiling: 1000 for CDO and climate normals, 100 for Storm Events and Billion-Dollar Disasters. A notice names the requested and applied limits alongside any empty-page or exhaustion guidance; use the applied limit to advance `offset`. Each clamp is logged and counted as `noaa.pagination.limit_clamped`.
- Station, location, and dataset IDs flow naturally between tools — find a location, find stations in it, fetch data from those stations
- Structured error contracts with typed `reason` codes and recovery hints — agents branch on data, not string parsing
- Damage and cost fields are honest about upstream gaps — an unreported NCEI figure is omitted rather than reported as a confirmed zero

## Getting started

Connect to the hosted instance, no install:

```sh
claude mcp add --transport http noaa-climate-mcp-server https://noaa-climate.caseyjhand.com/mcp
```

Or run it locally:

```sh
claude mcp add noaa-climate-mcp-server -e NOAA_CDO_TOKEN=your-token-here -- npx -y @cyanheads/noaa-climate-mcp-server
```

For other clients, add this to the MCP config file:

```json
{
  "mcpServers": {
    "noaa-climate-mcp-server": {
      "command": "npx",
      "args": ["-y", "@cyanheads/noaa-climate-mcp-server"],
      "env": { "NOAA_CDO_TOKEN": "your-token-here" }
    }
  }
}
```

Get a free [NOAA CDO API token](https://www.ncdc.noaa.gov/cdo-web/token) for CDO requests; climate normals, Storm Events, and Billion-Dollar Disasters need no token. For Docker or a source build, see [Running the server](#running-the-server).

## Configuration

Server-specific configuration uses Zod schemas in `src/config/server-config.ts`. The page-limit policy is validated at startup; the CDO token is required when a CDO request runs. Key environment variables:

| Variable | Description | Default |
|:---|:---|:---|
| `NOAA_CDO_TOKEN` | **Required for CDO.** Obtain free at [ncdc.noaa.gov/cdo-web/token](https://www.ncdc.noaa.gov/cdo-web/token); climate normals, Storm Events, and Billion-Dollar Disasters need no token | — |
| `NOAA_CLAMP_LIMITS` | `true` clamps positive integer read limits to the page ceiling; `false` restores schema rejection above it. Only the exact strings `true` and `false` are accepted; other nonempty values fail startup. Restart after changing this setting. | `true` |
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
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP base URL; traces go to `/v1/traces` and metrics to `/v1/metrics`. Nothing is exported without it | none |
| `LOG_TOOL_FAILURE_PAYLOADS` | Log each failed tool call's arguments and result, redacted by key name and capped at `LOG_TOOL_FAILURE_PAYLOAD_MAX_BYTES` (default `16384`). A secret inside a free-form value is not redacted. | `false` |

See [`.env.example`](./.env.example) for the full list of optional overrides.

## Running the server

### Prerequisites

- [Bun v1.4.4](https://bun.sh/) or higher (or Node.js ≥24.0.0).
- A free [NOAA CDO API token](https://www.ncdc.noaa.gov/cdo-web/token) for CDO requests; climate normals, Storm Events, and Billion-Dollar Disasters need no token.

### Source installation

```sh
git clone https://github.com/cyanheads/noaa-climate-mcp-server.git
cd noaa-climate-mcp-server
bun install
cp .env.example .env
# Set NOAA_CDO_TOKEN in .env for CDO requests.
```

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
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`). Eleven tools across datasets, locations, stations, observations, climate normals, storm events, and disaster costs. |
| `src/mcp-server/resources` | Resource definitions. Datasets catalog and station metadata resources. |
| `src/services/cdo` | CDO HTTP client with retry, backoff, camelCase→lowercase parameter translation, and recovery of CDO's own rejection message. |
| `src/services/normals` | NCEI Access Data Service client for 1991–2020 climate normals — per-granularity datasets, padded-string parsing, native-unit labels. |
| `src/services/csv` | Incremental RFC 4180 CSV reader shared by the two NCEI bulk-CSV corpora. |
| `src/services/storm-events` | NCEI Storm Events bulk-CSV client — filename discovery, streamed decompression, damage parsing. |
| `src/services/billion-dollar-disasters` | NCEI Billion-Dollar Disasters client — declared-unit resolution and conversion to whole US dollars. |
| `src/config` | Server-specific environment variable parsing and validation with Zod. |
| `tests/` | Unit and integration tests, mirroring the `src/` structure. |
| `skills/` | Published agent guide, discovered by plugin hosts and served over MCP. |

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
