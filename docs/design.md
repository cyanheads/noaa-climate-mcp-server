# noaa-climate-mcp-server — Design

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `noaa_climate_list_datasets` | List available NOAA CDO datasets, optionally filtered by data type, location, station, or date range. Returns dataset IDs, names, and temporal coverage. | `datatypeId[]?`, `locationId?`, `startDate?`, `endDate?`, `limit`, `offset` | `readOnlyHint: true`, `openWorldHint: false` |
| `noaa_climate_list_data_types` | List available data types (TMAX, TMIN, PRCP, SNOW, etc.), optionally filtered by dataset, data category, location, or station. Use to discover what measurements are available before querying data. | `datasetId?`, `datacategoryId?`, `locationId?`, `stationId?`, `limit`, `offset` | `readOnlyHint: true`, `openWorldHint: false` |
| `noaa_climate_list_data_categories` | List data categories (Temperature, Precipitation, Wind, etc.) that group related data types. Optionally filter by dataset, location, or station. | `datasetId?`, `locationId?`, `stationId?`, `limit`, `offset` | `readOnlyHint: true`, `openWorldHint: false` |
| `noaa_climate_list_location_categories` | List the 12 location categories that scope location search. Pagination and sort only — CDO ignores every domain filter on `/locationcategories`. | `sortField?`, `sortOrder?`, `limit`, `offset` | `readOnlyHint: true`, `openWorldHint: false` |
| `noaa_climate_find_locations` | Search for locations by category (country, state, county, city, zip, climate region). Optionally filter by dataset, data category, and date range, or by name via the client-side `nameContains` filter. Use to discover location IDs for narrowing station and data queries. | `locationCategoryId?`, `nameContains?`, `datasetId?`, `datacategoryId?`, `startDate?`, `endDate?`, `sortField?`, `limit`, `offset` | `readOnlyHint: true`, `openWorldHint: true` |
| `noaa_climate_find_stations` | Search for weather stations by location, bounding box, dataset, data type, and date range. Returns station IDs, names, coordinates, and data coverage metadata. | `locationId?`, `extent?`, `datasetId?`, `datatypeId?`, `datacategoryId?`, `startDate?`, `endDate?`, `sortField?`, `limit`, `offset` | `readOnlyHint: true`, `openWorldHint: true` |
| `noaa_climate_get_station` | Fetch full metadata for a single station by ID, including name, coordinates, elevation, and data coverage dates. | `stationId` | `readOnlyHint: true`, `openWorldHint: false` |
| `noaa_climate_fetch_data` | Fetch historical observation data for a dataset, date range, and one or more stations or locations. Returns time-series values for the requested data types. | `datasetId`, `startDate`, `endDate`, `stationId[]?`, `locationId[]?`, `datatypeId[]?`, `units?`, `limit`, `offset` | `readOnlyHint: true`, `openWorldHint: true` |
| `noaa_climate_get_normals` | Read one station's 1991–2020 U.S. Climate Normals — monthly, daily, hourly, or annual/seasonal — in NCEI's native units, with completeness flags. A separate upstream from CDO (NCEI Access Data Service), no token. CDO's `NORMAL_*` datasets are the superseded 1981–2010 normals. | `stationId`, `granularity`, `datatypeId[]?`, `month?`, `limit`, `offset` | `readOnlyHint: true`, `openWorldHint: true` |
| `noaa_climate_search_storm_events` | Search the NCEI Storm Events Database for one calendar year — severe-weather events with magnitude, casualties, damage, narratives, and, on county rows, the CDO county location ID. A separate corpus from CDO: bulk gzip CSV, no token. | `year`, `episodeId?`, `state?`, `countyFips?`, `eventType?`, `month?`, `startDate?`, `endDate?`, `minDamageInUsd?`, `limit`, `offset` | `readOnlyHint: true`, `openWorldHint: true` |
| `noaa_climate_get_billion_dollar_disasters` | Query NCEI Billion-Dollar Weather and Climate Disasters — individual disasters with CPI-adjusted cost and deaths, or per-year totals by disaster class. A third corpus: small static CSVs, no token, every cost normalized to whole US dollars. | `startYear?`, `endYear?`, `disasterType?`, `state?`, `minCostInUsd?`, `summary`, `limit`, `offset` | `readOnlyHint: true`, `openWorldHint: true` |

### Resources

| URI Template | Description | Pagination |
|:-------------|:------------|:-----------|
| `noaa://datasets` | All available CDO datasets with IDs, names, and temporal coverage. | Stable small list (11–13 datasets via the API) — no pagination needed |
| `noaa://stations/{stationId}` | Station metadata by ID (name, coordinates, elevation, data coverage). | n/a |
| `skill://noaa-climate-guide/SKILL.md` | Published guide for climate comparisons, coverage, observation quality, and storm-to-station investigation; also discoverable through the MCP Skills extension. | n/a |

### Prompts

None. This is a data-access server; no recurring interaction templates are warranted.

---

## Overview

`noaa-climate-mcp-server` exposes NOAA's Climate Data Online (CDO) API v2 to LLM agents. It provides access to historical weather observations, climate summaries, and station metadata going back centuries. The primary use case is answering questions like "what's the historical climate at location X?" or "what were the temperatures and precipitation at station Y between these dates?"

It complements the `nws-weather-mcp-server` (real-time forecasts and alerts) by providing the historical record — together they form a complete weather data stack for agents.

The API wraps `https://www.ncei.noaa.gov/cdo-web/api/v2/`.

## Requirements

- Read-only access to NOAA CDO API v2
- API token required (free registration at ncdc.noaa.gov/cdo-web/token; token passed as `token` request header)
- Rate limits: 5 requests/second, 10,000 requests/day per token
- Seven endpoints exposed: datasets, datacategories, datatypes, locationcategories, locations, stations, data
- Date range constraints: sub-daily, daily, and radar data (GHCND, PRECIP_*, NORMAL_DLY, NORMAL_HLY, NEXRAD2, NEXRAD3) limited to 1-year ranges per request; monthly/annual data (GSOM, GSOY, NORMAL_MLY, NORMAL_ANN) limited to 10-year ranges
- Pagination: zero-based input and returned metadata offsets; max 1000 results per request. Only outbound CDO requests convert offset to one-based; absent upstream metadata stays absent.
- Units: `standard` or `metric` for data endpoint; no scaling without explicit `units` param
- Base URL: `https://www.ncei.noaa.gov/cdo-web/api/v2/`

## Services

| Service | Wraps | Used By |
|:--------|:------|:--------|
| `CdoService` | NOAA CDO API v2 (`https://www.ncei.noaa.gov/cdo-web/api/v2/`) | Eight CDO tools, both data resources |
| `NormalsService` | NCEI Access Data Service (`https://www.ncei.noaa.gov/access/services/data/v1`), 1991–2020 normals datasets | `noaa_climate_get_normals` |
| `StormEventsService` | NCEI Storm Events bulk CSV export (`https://www.ncei.noaa.gov/pub/data/swdi/stormevents/csvfiles/`) | `noaa_climate_search_storm_events` |
| `BillionDollarDisastersService` | NCEI Billion-Dollar Weather and Climate Disasters CSV exports (`https://www.ncei.noaa.gov/access/billions/`) | `noaa_climate_get_billion_dollar_disasters` |
| `CsvStreamReader` (`src/services/csv/`) | Not an upstream — the incremental RFC 4180 reader both bulk-CSV services parse with | `StormEventsService`, `BillionDollarDisastersService` |

**Parameter name translation.** MCP input schemas use camelCase (`datasetId`, `locationId`, `stationId`, `datatypeId`, `datacategoryId`). The CDO API requires all lowercase (`datasetid`, `locationid`, `stationid`, `datatypeid`, `datacategoryid`). `CdoService` is responsible for this translation — do not rely on the caller to pass lowercase keys.

**CDO station IDs share one normalization rule.** CDO station filters, station lookup, and the station resource trim surrounding whitespace, uppercase IDs, and prefix bare 11-character GHCN aliases with `GHCND:`. Other nonempty namespace/payload pairs, including additional colons in the payload, remain accepted. Ambiguous unprefixed IDs and empty namespaces/payloads fail schema validation. Successful tools compose normalization notices; the resource preserves its existing station result shape.

**The normals tool has its own station rule.** `noaa_climate_get_normals` takes one GHCN-Daily ID, bare or with a `GHCND:` prefix, through `ghcnStationIdFilter` and `normalizeGhcnStationId`, and sends the bare form the Access Data Service matches. Other namespaces fail schema validation: `COOP:` or `NEXRAD:` passed through to a source keyed on bare GHCN IDs would come back as an empty result and read as "no normals" rather than "wrong ID form". NCEI matches IDs case-sensitively and a few hundred legacy CoCoRaHS IDs are published mixed-case (`US10adam002`), so only an ID written entirely in lowercase is uppercased; any other is sent as written. Either way an ID written with a lowercase letter can miss its station, so an empty answer for one adds the case cause to the zero-row notice: pass the ID exactly as `noaa_climate_find_stations` lists it. The notice does not lean on `noaa_climate_get_station` for those IDs: CDO's `/stations/{id}` answers none of the 293 mixed-case IDs in NCEI's normals station lists, in either case.

**Observation queries share one serializer and one length check.** `/data` rejects an encoded query longer than 4000 characters before fetch or retry, after canonical dates, defaults, metadata, and offset conversion are serialized. Recovery asks callers to reduce filters and make separate calls; filters are never discarded or implicitly split. Other endpoints have no such local ceiling.

**Storm Events is a second upstream, not an extension of CDO.** There is no token, no JSON envelope, and no `resolveCollectionTotal()` — a bulk CSV result set has a known total once scanned, so `totalCount` and `exhausted` are computed directly. Transport failure explanations share `src/services/upstream-failure.ts` with the other clients; retry policies remain service-specific. Three properties of the upstream shape the service:

- **Filenames are discovered, never constructed.** Each year is published as `StormEvents_details-ftp_v1.0_d{year}_c{publishDate}.csv.gz`, and `{publishDate}` is whenever NCEI last republished that year, so neighboring years carry different suffixes and any year's suffix moves on its next republish. The service reads the directory index and selects the highest `_c` date per year. A republish removes the file it supersedes, so a name held from a six-hour-old listing can 404; the service treats that as an upstream republish, drops the listing, and re-resolves once before failing.
- **Decompression is explicit.** The files are served as `Content-Type: application/gzip` with no `Content-Encoding` header, so `fetch` returns the compressed bytes untouched. The service pipes them through `DecompressionStream('gzip')` and an incremental CSV reader, so the ~70 MB decompressed form is never materialized. A body that will not decompress — an HTML error page under HTTP 200, a truncated transfer — is reclassified as an upstream availability failure and its bytes are evicted, so a bad download cannot be replayed from cache.
- **Damage values are magnitude-suffixed strings.** `H`/`K`/`M`/`B` suffixes, bare numbers (not always `0`), and abbreviated fractions (`.5M`) all occur; an empty cell means "not reported" and is preserved as an absent value rather than `0`, and a cell that does not parse keeps its raw text with no amount. See `src/services/storm-events/damage.ts`.

**Storm episode navigation.** `episodeId` is an optional trimmed digit string, matched exactly against `EPISODE_ID` before totals and paging; blank means omitted and leading zeros stay significant. The tool removes each event's `episodeNarrative` and emits `episodeNarrativeRef` plus a page-local `episodeNarratives: [{ ref, text }]` dictionary. Text identity determines grouping because one episode can carry different narratives and historical narratives can lack episode IDs. `eventNarrative` stays on the event. Valid `BEGIN_YEARMONTH`/`BEGIN_DAY` and `END_YEARMONTH`/`END_DAY` pairs add optional local ISO `beginDate`/`endDate` fields without replacing raw date-time or timezone fields; missing or invalid pairs omit only the ISO field.

**Storm date overlap.** Optional real-calendar `YYYY-MM-DD` inputs `startDate` and `endDate` intersect the other filters before unknown-damage accounting, totals, and pagination: a valid source span ends on or after the lower bound and begins on or before the upper bound. Both endpoints must exist, be valid, and be ordered when either bound is active; without date bounds sparse or reversed spans remain visible. One-sided and equal bounds work. Cross-year intervals search only the export selected by required `year`, avoiding implicit multi-file downloads. Reversed request dates fail locally as `invalid_date_range` with recovery guidance. `appliedDateRange: { startDate?, endDate? }` appears on both surfaces only when a bound was supplied; `month` continues to match the begin month.

**County codes compose one CDO location ID.** The export's `STATE_FIPS` and `CZ_FIPS` arrive unpadded (`1`, `43`); `countyCodes()` pads them to two and three digits and composes `cdoLocationId` (`FIPS:53043` for Lincoln County, WA) only for `CZ_TYPE` `C` rows with a state code in 01–56 other than Alaska's 02. Alaska's county rows carry NWS zone numbers, and NCEI writes territories as 96–99 and marine areas as 81–95, so those rows keep `stateFips` and `czFips` without an ID. The projection and the `countyFips` filter read the same composition, so the filter matches exactly the rows that carry the ID; it applies ahead of damage accounting so `excludedUnknownDamage` counts only that county. `WFO`, `BEGIN_LOCATION`, and `END_LAT`/`END_LON` are projected and omitted when blank; `beginLocation` is the reference place NWS measures the start from, not the start point. CDO's county catalog can lag the export (it still lists Oglala Lakota County, SD under its former name, Shannon County, as 46113 where the export writes 46102), so `cdoLocationId` can return no stations and the guide falls back to an `extent` station search around the event coordinates.

**Literal Storm narratives.** The text formatter escapes CommonMark punctuation and renders source line breaks explicitly for both event and deduplicated episode narratives. Structured text, dictionary grouping, references, and row order remain unchanged, so literal source notation such as `**may**` survives rendering. `marked` is a development-only parser used to check rendered equivalence, including entities and multiline source text.

**Caching bounds.** The directory listing and up to two years of compressed bytes are held for six hours, then re-fetched — NCEI republishes a year under a new `_c` suffix at any time. Two resident years stay under 30 MB: a recent bundle is about 12 MB and the largest, 2011, is 15 MB. That is the retained set, not the memory envelope — 2024 decompresses to 66.6 MB in 4,272 16 KB chunks, and a cold full-year scan of it measured 129 MB RSS at baseline against a 269 MB peak, climbing further across repeated scans. The chunk strings are transient garbage the collector reclaims, not retention, but sizing the process against the ~30 MB cache figure would be wrong.

**Billion-Dollar Disasters is a third upstream, and its defining hazard is units.** `BillionDollarDisastersService` reads four small static CSVs — `events-US.csv` (403 rows), `time-series-US.csv` (45 rows), and their `events-{STATE}.csv` / `time-series-{STATE}.csv` variants. No token, no gzip, no filename discovery: they are plain `text/csv` at fixed names, small enough to buffer whole, so the streaming machinery Storm Events needs would be overhead here. Four properties shape the service:

- **The exports do not share a cost unit, and each states its own.** `events-*.csv` declares "Cost values are in millions of dollars"; `time-series-US.csv` declares billions; `time-series-{STATE}.csv` declares millions again. A figure read under the wrong one is wrong by three orders of magnitude and still entirely plausible — Hurricane Helene's `78721` is $78.7B, not $78,721B. The service therefore parses the unit out of each file's own preamble and scales at a single site, `toUsd()`, publishing whole US dollars and echoing the unit it read as `declaredCostUnit`. An unrecognized or absent unit is `malformed_export`, never a default.
- **Every file opens with lines that are neither data nor header.** `events-*.csv` leads with a title line and the unit note; `time-series-*.csv` leads with two `#` comments and a blank line. Treating row 1 as the header silently mis-keys every column, so the header is located by name (`Name` or `State`) and everything above it is read only for the unit.
- **The per-state per-year export has a different shape, not just a different scope.** It publishes `"<Type> Cost Range"` — a binned range like `2000-5000` — where the national file publishes `"<Type> Cost"` plus six 75/90/95% confidence-bound columns. Which shape a file carries is read off its header rather than inferred from the scope, so one parser handles both.
- **Per-state per-event rows carry the national cost.** The state exports select national disasters that reached the state; they do not apportion cost. Summing per-state figures double-counts, and the tool description says so.

**Caching bounds.** Up to eight parsed exports are held for six hours, then re-fetched from the archive without promising new years or current-price CPI rebasing. The bound exists so a long-lived process does not accumulate one entry per state and territory; a parsed export is a few hundred rows, so bytes are not the concern.

**Retired archive.** NOAA retired the product after calendar year 2024; the 1980–2024 archive remains available with no later years added. The service reports the span it actually found in each export’s rows. Every successful response carries the retirement notice, composed after truncation enrichment with any clamp, empty-page, or exhaustion guidance. CPI-adjusted costs preserve the archived export’s adjustment; no current-price rebasing or undocumented CPI base year is inferred.

**Climate normals are a fourth upstream, and CDO's `NORMAL_*` datasets are the old baseline.** CDO serves only the 1981–2010 normals; NOAA's current 1991–2020 normals sit behind NCEI's keyless Access Data Service, one dataset per granularity (`normals-monthly-1991-2020`, `normals-daily-1991-2020`, `normals-hourly-1991-2020`, `normals-annualseasonal-1991-2020`). `NormalsService` reads them through `fetchWithTimeout` and `withRetry` with a 20-second attempt timeout and a 45-second total deadline, and holds no cache. Properties of the upstream that shape it:

- **Rows are flat objects of left-padded strings.** Each row carries a `DATE` key without a year (`01`, `01-31`, `01-01T00:00:00`) and, per datatype, the value plus `comp_flag_`, `years_`, and `meas_flag_` attribute cells. The service splits a row into one record per requested datatype and drops a blank cell; `-9999` becomes `missing: true`, and a non-numeric cell (the annual frost and freeze probability dates) becomes `valueText`.
- **Every request names its datatypes.** The service's own default column set for the monthly product leaves out `MLY-TAVG-NORMAL`, and an ID the dataset does not compute is answered with HTTP 200 and the column silently absent, so the tool holds IDs to the granularity's prefixes before sending and reports a requested datatype no row carries.
- **Dates are required for daily and hourly.** Both answer HTTP 400 without a window, monthly honors one, and annual/seasonal has none. The service sends a 2020 window, a leap year, so a `month` of 2 reaches the daily product's `02-29` row.
- **Unknown stations are results.** An unknown station, a station without normals, and an absent datatype all come back as HTTP 200, so they surface as an empty result with a notice, not an error. A 400 carries NCEI's `errors[].message` into `validation_error`; a 5xx other than 504, network failure, and a 200 that is not JSON rows become `service_unavailable`; 429 becomes `rate_limited`. A 504 and a timed-out request, the 45-second deadline included, pass through as `Timeout` with no declared reason, the rule the CDO tools follow: `service_unavailable` is declared under `ServiceUnavailable`, and the caller's next move is the one it already carries.
- **Units are labeled, never converted.** See the Decisions Log: the service's `units` conversion is wrong per datatype, so values stay native and a verified table labels temperature (`°F`), precipitation and snowfall (`in`), base-65 heating and cooling degree days (`°F-days`), and hourly sea-level pressure (`hPa`, where NCEI's documentation says inches of mercury). A datatype outside the table, a degree day at another base included, carries no unit rather than a guessed one.

## Config

| Env Var | Required | Description |
|:--------|:---------|:------------|
| `NOAA_CDO_TOKEN` | CDO only | API token from ncdc.noaa.gov/cdo-web/token. Sent as the `token` header on CDO requests; the two public bulk corpora need no token. |
| `NOAA_CLAMP_LIMITS` | No | Defaults to `true`: clamp positive integer read limits to 1000 for CDO and climate normals or 100 for either bulk corpus. Exact `false` restores schema rejection above the ceiling; other nonempty values fail startup. Restart after changing it. |

## Implementation Order

1. Config (`src/config/server-config.ts`) — `NOAA_CDO_TOKEN` via `parseEnvConfig`
2. `CdoService` — typed HTTP client with retry, rate-limit handling, pagination helper
3. `noaa_climate_list_datasets`, `noaa_climate_list_data_categories`, `noaa_climate_list_data_types` — reference/discovery tools (simplest; no required params)
4. `noaa_climate_find_locations` — location search (required for navigation workflows)
5. `noaa_climate_find_stations`, `noaa_climate_get_station` — station discovery and lookup
6. `noaa_climate_fetch_data` — observation data retrieval (most complex; requires all prior pieces)
7. Resources: `noaa://datasets` (small, stable list), `noaa://stations/{stationId}` (wraps get_station)
8. `StormEventsService` + `noaa_climate_search_storm_events` — second upstream (NCEI bulk CSV); independent of every step above
9. `BillionDollarDisastersService` + `noaa_climate_get_billion_dollar_disasters` — third upstream (NCEI Billions CSV); shares only the CSV reader with step 8
10. `NormalsService` + `noaa_climate_get_normals` — fourth upstream (NCEI Access Data Service); reuses the shared station-ID, limit, and upstream-failure helpers

Each step is independently testable against the live API.

---

## Domain Mapping

The NOAA CDO data model has five entity types and one data-fetch endpoint:

| Entity | API Endpoint | Key ID Format | Notes |
|:-------|:-------------|:-------------|:------|
| Dataset | `/datasets` or `/datasets/{id}` | `GHCND`, `GSOM`, `GSOY`, `NORMAL_DLY`, `NORMAL_MLY`, `NORMAL_ANN`, `NORMAL_HLY`, `PRECIP_15`, `PRECIP_HLY`, `NEXRAD2`, `NEXRAD3` | 11–13 via API; primary ones are GHCND, GSOM, GSOY, NORMAL_DLY |
| Data category | `/datacategories` or `/datacategories/{id}` | `TEMP`, `PRCP`, `WIND`, `PRES`, `SUN`, `SKY`, `WXTYPE`, `ANNAGR`, etc. | ~41 categories; groups data types |
| Data type | `/datatypes` or `/datatypes/{id}` | `TMAX`, `TMIN`, `TOBS`, `PRCP`, `SNOW`, `SNWD`, `AWND`, etc. | Hundreds; the actual measurement labels |
| Location category | `/locationcategories` | `CITY`, `CLIM_DIV`, `CLIM_REG`, `CNTRY`, `CNTY`, `HYD_ACC`, `HYD_CAT`, `HYD_REG`, `HYD_SUB`, `ST`, `US_TERR`, `ZIP` | 12 categories; hierarchical geography |
| Location | `/locations` or `/locations/{id}` | `FIPS:37` (state), `CITY:US390029`, `ZIP:28801`, `FIPS:US` (country) | Filtered by `locationcategoryid` |
| Station | `/stations` or `/stations/{id}` | `GHCND:USC00010008`, `COOP:010008` | Supports bounding box via `extent` param |
| Data | `/data` | n/a (query-only) | Requires `datasetid`, `startdate`, `enddate`; returns `{date, datatype, station, value, attributes}` |

### Billion-Dollar Disasters Corpus

A separate, retired 1980–2024 NCEI archive with no CDO entity model — four static CSVs under `https://www.ncei.noaa.gov/access/billions/`, addressed by scope rather than by ID. Costs are stated per file and differ; the server converts every one to whole US dollars while preserving the archive’s CPI adjustment.

| Export | Rows | Declared cost unit | Cost shape |
|:-------|:-----|:-------------------|:-----------|
| `events-US.csv` | 403 (1980–2024) | millions of dollars | Per disaster: CPI-adjusted and unadjusted point costs |
| `time-series-US.csv` | 45 (one per year) | **billions** of dollars | Per year per class: point cost plus 75/90/95% confidence bounds |
| `events-{STATE}.csv` | varies | millions of dollars | Per disaster, carrying the **national** cost of a disaster that reached the state |
| `time-series-{STATE}.csv` | 45 (one per year) | millions of dollars | Per year per class: a binned range (`2000-5000`), no point estimate, no bounds |

`{STATE}` is a two-letter postal code. The 50 states, DC, PR, VI, and GU have exports; AS and MP return 404. The seven `Disaster` values are `Drought`, `Flooding`, `Freeze`, `Severe Storm`, `Tropical Cyclone`, `Wildfire`, `Winter Storm`; the per-year exports carry an eighth column group, `All Disasters`, which is the year's total rather than a class.

### Key Dataset Reference

| Dataset ID | Name | Temporal Granularity | Date Range |
|:-----------|:-----|:---------------------|:-----------|
| `GHCND` | Global Historical Climatology Network Daily | Daily | 1763–present |
| `GSOM` | Global Summary of the Month | Monthly | 1763–present |
| `GSOY` | Global Summary of the Year | Annual | 1763–present |
| `NORMAL_DLY` | Normals Daily (1981–2010, superseded) | Daily (30-year norms) | 2010-01-01–2010-12-31 |
| `NORMAL_MLY` | Normals Monthly (1981–2010, superseded) | Monthly (30-year norms) | 2010-01-01–2010-12-31 |
| `NORMAL_ANN` | Normals Annual/Seasonal (1981–2010, superseded) | Annual (30-year norms) | 2010-01-01–2010-12-31 |
| `NORMAL_HLY` | Normals Hourly (1981–2010, superseded) | Hourly (30-year norms) | 2010-01-01–2010-12-31 |
| `PRECIP_15` | Precipitation 15 Minute | 15-minute intervals | 1970–present |
| `PRECIP_HLY` | Precipitation Hourly | Hourly | 1900–present |

### 1991–2020 Normals Datasets

Not CDO datasets: NCEI Access Data Service dataset names behind `noaa_climate_get_normals`, keyed by `granularity`. No date range applies; rows are keyed by `DATE` without a year.

| `granularity` | Dataset | Default `datatypeId` | Datatype prefixes |
|:--------------|:--------|:---------------------|:------------------|
| `monthly` | `normals-monthly-1991-2020` | `MLY-{TAVG,TMAX,TMIN,PRCP,SNOW}-NORMAL` | `MLY-` |
| `daily` | `normals-daily-1991-2020` | `DLY-{TAVG,TMAX,TMIN}-NORMAL` | `DLY-`, `MTD-`, `YTD-` |
| `hourly` | `normals-hourly-1991-2020` | `HLY-{TEMP,DEWP}-NORMAL` | `HLY-` |
| `annualseasonal` | `normals-annualseasonal-1991-2020` | `ANN-{TAVG,TMAX,TMIN,PRCP,SNOW}-NORMAL` | `ANN-`, `DJF-`, `MAM-`, `JJA-`, `SON-` |

### Core Data Types (GHCND/GSOM)

| Data Type ID | Description | Unit (standard) |
|:-------------|:------------|:----------------|
| `TMAX` | Maximum temperature | Tenths of °C |
| `TMIN` | Minimum temperature | Tenths of °C |
| `TOBS` | Temperature at observation time | Tenths of °C |
| `PRCP` | Precipitation | Tenths of mm |
| `SNOW` | Snowfall | mm |
| `SNWD` | Snow depth | mm |
| `AWND` | Average wind speed | Tenths of m/s |
| `WDF2` | Direction of fastest 2-minute wind | Degrees |
| `WSF2` | Fastest 2-minute wind speed | Tenths of m/s |

---

## Workflow Analysis

### Primary workflow: station → data

The most common agent workflow is "find stations near a place, then query historical data":

| Step | Tool | What it does |
|:-----|:-----|:-------------|
| 1 | `noaa_climate_find_locations` | Find a location ID for a city, state, or zip — e.g., `CITY:US530018` for Seattle |
| 2 | `noaa_climate_find_stations` | Find stations within that location that support the desired dataset and data types |
| 3 | `noaa_climate_fetch_data` | Fetch observations for chosen stations over the desired date range |

### Discovery workflow: what's available?

When the agent doesn't know what data exists:

| Step | Tool | What it does |
|:-----|:-----|:-------------|
| 1 | `noaa_climate_list_datasets` | See all available datasets and their temporal coverage |
| 2 | `noaa_climate_list_data_categories` | Browse measurement groups (Temperature, Precipitation, etc.) |
| 3 | `noaa_climate_list_data_types` | Get specific measurement IDs (TMAX, PRCP, etc.) for the chosen dataset |

### Climate profile workflow

"What's the typical climate in X?" — uses the current 1991–2020 normals:

| Step | Tool | What it does |
|:-----|:-----|:-------------|
| 1 | `noaa_climate_find_stations` | Find a GHCND station near the location with a long record |
| 2 | `noaa_climate_get_normals` | Read its normals at `granularity` `monthly` (or `daily`, `hourly` with a `month`, `annualseasonal`); each record carries a completeness flag and years of data |

Use `granularity=annualseasonal` for annual and seasonal totals, or `daily` for one day's normal. The 1981–2010 normals stay reachable through `noaa_climate_fetch_data` with `datasetId=NORMAL_DLY` (or `NORMAL_HLY`, `NORMAL_MLY`, `NORMAL_ANN`), `startDate=2010-01-01`, and `endDate=2010-12-31`; all four use the same 2010 proxy date range.

---

## Tool Detail

### `noaa_climate_list_datasets`

- **Description**: List available NOAA CDO datasets with their IDs, names, and temporal coverage. Returns all ~11 datasets by default (no required params). Optionally filter to datasets that contain a specific data type, cover a location or station, or overlap a date range.
- **Input**: `datatypeId?: string[]`, `locationId?: string`, `stationId?: string`, `startDate?: string` (ISO), `endDate?: string` (ISO), `sortField?: enum('id'|'name'|'mindate'|'maxdate'|'datacoverage')`, `sortOrder?: enum('asc'|'desc')`, `limit: number (default 25, max 1000)`, `offset: number (default 0)`
- **Output**: `{ results: Array<{ id, name, datacoverage, mindate, maxdate }>, metadata: { resultset: { count, limit, offset } } }`
- **Errors**: `{ reason: 'service_unavailable', code: ServiceUnavailable, when: 'CDO API is down or unreachable', retryable: true }`, `{ reason: 'upstream_auth_failed', code: ConfigurationError, when: 'CDO rejected the API token this server is configured with' }`, `{ reason: 'validation_error', code: ValidationError, when: 'Bad date format or unknown ID' }`
- **Annotations**: `readOnlyHint: true`, `openWorldHint: false`

### `noaa_climate_list_data_categories`

- **Description**: List data categories that group related data types — Temperature, Precipitation, Wind, etc. Use to discover what types of measurements are available before calling `noaa_climate_list_data_types`. Optionally filter by dataset, location, station, or date range.
- **Input**: `datasetId?: string`, `locationId?: string`, `stationId?: string`, `startDate?: string`, `endDate?: string`, `sortField?`, `sortOrder?`, `limit`, `offset`
- **Output**: `{ results: Array<{ id, name }>, metadata: { resultset: { count, limit, offset } } }`
- **Errors**: `{ reason: 'service_unavailable', code: ServiceUnavailable, when: 'CDO API is down or unreachable', retryable: true }`, `{ reason: 'upstream_auth_failed', code: ConfigurationError, when: 'CDO rejected the API token this server is configured with' }`, `{ reason: 'validation_error', code: ValidationError, when: 'A filter parameter is not recognized by the CDO API' }`
- **Annotations**: `readOnlyHint: true`, `openWorldHint: false`

### `noaa_climate_list_data_types`

- **Description**: List available data types (measurement labels like TMAX, TMIN, PRCP, SNOW) for a given dataset or category. Pass a `datasetId` to see what's measured in that dataset, or a `datacategoryId` (e.g., `TEMP`) to see all temperature-related types. Required before querying data when the data type IDs are unknown.
- **Input**: `datasetId?: string`, `datacategoryId?: string`, `locationId?: string`, `stationId?: string`, `startDate?: string`, `endDate?: string`, `sortField?`, `sortOrder?`, `limit`, `offset`
- **Output**: `{ results: Array<{ id, name, datacoverage, mindate, maxdate }>, metadata: { resultset: { count, limit, offset } } }`
- **Errors**: `{ reason: 'service_unavailable', code: ServiceUnavailable, when: 'CDO API is down or unreachable', retryable: true }`, `{ reason: 'upstream_auth_failed', code: ConfigurationError, when: 'CDO rejected the API token this server is configured with' }`, `{ reason: 'validation_error', code: ValidationError, when: 'A filter parameter is not recognized by the CDO API' }`
- **Annotations**: `readOnlyHint: true`, `openWorldHint: false`

### `noaa_climate_list_location_categories`

- **Description**: List the location categories that scope `noaa_climate_find_locations` — 12 in total: `CITY`, `CLIM_DIV`, `CLIM_REG`, `CNTRY`, `CNTY`, `HYD_ACC`, `HYD_CAT`, `HYD_REG`, `HYD_SUB`, `ST`, `US_TERR`, `ZIP`. Call it when the `locationCategoryId` to use is unknown.
- **Input**: `sortField?: enum('id'|'name')`, `sortOrder?: enum('asc'|'desc')`, `limit: number (default 25, max 1000)`, `offset: number (default 0)`. No domain filters — CDO ignores `datasetid`, `locationid`, `stationid`, and the date range on `/locationcategories`, verified live.
- **Output**: `{ results: Array<{ id, name }>, metadata: { resultset: { count, limit, offset } } }`
- **Errors**: `{ reason: 'service_unavailable', code: ServiceUnavailable, when: 'CDO API is down or unreachable', retryable: true }`, `{ reason: 'upstream_auth_failed', code: ConfigurationError, when: 'CDO rejected the API token this server is configured with' }`, `{ reason: 'validation_error', code: ValidationError, when: 'A pagination or sort parameter is not recognized' }`
- **Annotations**: `readOnlyHint: true`, `openWorldHint: false`

### `noaa_climate_find_locations`

- **Description**: Search for geographic locations by category (CITY, ST, CNTY, CNTRY, ZIP, CLIM_REG, etc.). Returns location IDs used in station search and data queries. Without `locationCategoryId`, returns all location types. Use `locationCategoryId=ST` to list US states (51), `locationCategoryId=CITY` for cities (1,989). The API has no name-search parameter, so `nameContains` synthesizes one client-side for any category of at most 4,000 locations; past that limit — `ZIP` (30,415) — narrow with `datasetId`/`datacategoryId`, or sort alphabetically with `sortField=name` and page through results. Location IDs follow formats like `FIPS:37` (state), `CITY:US530018` (city), `ZIP:98101`.
- **Input**: `locationCategoryId?: string` (e.g., `ST`, `CITY`, `CNTY`, `CNTRY`, `ZIP`, `US_TERR`, `CLIM_REG`; enumerate with `noaa_climate_list_location_categories`), `nameContains?: string` — case-insensitive substring match applied after a full client-side enumeration of the category; requires `locationCategoryId` and a category of at most 4,000 locations, `datasetId?: string`, `datacategoryId?: string`, `startDate?: string`, `endDate?: string`, `sortField?: enum('id'|'name'|'mindate'|'maxdate'|'datacoverage')`, `sortOrder?: enum('asc'|'desc')`, `limit: number (default 25, max 1000)`, `offset: number (default 0)`
- **Output**: `{ results: Array<{ id, name, datacoverage, mindate, maxdate }>, appliedNameFilter?: string, metadata: { resultset: { count, limit, offset } } }`. With `nameContains` active, `count` is the exact post-filter match total and `offset` echoes the caller's zero-based offset — never CDO's raw echo from the internal enumeration fetch.
- **Errors**: `{ reason: 'service_unavailable', code: ServiceUnavailable, when: 'CDO API is down or unreachable', retryable: true }`, `{ reason: 'upstream_auth_failed', code: ConfigurationError, when: 'CDO rejected the API token this server is configured with' }`, `{ reason: 'validation_error', code: ValidationError, when: 'A filter parameter is not recognized by the CDO API' }`, `{ reason: 'name_filter_requires_category', code: ValidationError, when: 'nameContains supplied without locationCategoryId' }`, `{ reason: 'name_filter_category_too_large', code: ValidationError, when: 'The category holds more locations than nameContains can enumerate' }`
- **Annotations**: `readOnlyHint: true`, `openWorldHint: true`

### `noaa_climate_find_stations`

- **Description**: Search for weather observation stations by location, bounding box, dataset, and data type. Returns station IDs, names, coordinates, elevation, and data coverage dates. Filters by `locationId` (e.g., `FIPS:37` for NC), `extent` (lat/lon bounding box as `"minLat,minLon,maxLat,maxLon"`), `datasetId`, `datatypeId`, and date range. Station IDs returned here are used as `stationId` in `noaa_climate_fetch_data`.
- **Input**: `locationId?: string`, `extent?: string` (e.g., `"47.5,-122.4,47.7,-122.1"`), `datasetId?: string`, `datatypeId?: string[]`, `datacategoryId?: string`, `startDate?: string`, `endDate?: string`, `sortField?`, `sortOrder?`, `limit`, `offset`
- **Output**: `{ results: Array<{ id, name, latitude, longitude, elevation, mindate, maxdate, datacoverage }>, metadata: { resultset: { count, limit, offset } } }`
- **Errors**: `{ reason: 'service_unavailable', code: ServiceUnavailable, when: 'CDO API is down or unreachable', retryable: true }`, `{ reason: 'upstream_auth_failed', code: ConfigurationError, when: 'CDO rejected the API token this server is configured with' }`, `{ reason: 'validation_error', code: ValidationError, when: 'A filter parameter is not recognized by the CDO API' }`
- **Annotations**: `readOnlyHint: true`, `openWorldHint: true`

### `noaa_climate_get_station`

- **Description**: Fetch full metadata for a single weather station by its ID (e.g., `GHCND:USW00024233`, `COOP:010008`). Returns name, coordinates, elevation, and the full date range for which data is available. Use when you have a station ID from `noaa_climate_find_stations` and want its details.
- **Input**: `stationId: string` (e.g., `GHCND:USW00024233`)
- **Output**: `{ id, name, latitude, longitude, elevation, mindate, maxdate, datacoverage }`
- **Errors**: `{ reason: 'not_found', code: NotFound, when: 'Station ID format is valid but no station exists with that ID' }`, `{ reason: 'service_unavailable', code: ServiceUnavailable, when: 'CDO API is down or unreachable', retryable: true }`, `{ reason: 'upstream_auth_failed', code: ConfigurationError, when: 'CDO rejected the API token this server is configured with' }`
- **Annotations**: `readOnlyHint: true`, `openWorldHint: false`

### `noaa_climate_fetch_data`

- **Description**: Fetch historical observation records for a required `datasetId`, `startDate`, and `endDate`, optionally filtered by stations, locations, and datatypes. Sub-daily, daily, and radar datasets allow 1 year; GSOM/GSOY/NORMAL_MLY/NORMAL_ANN allow 10 years, through the end of the corresponding calendar month. Returns flat records with optional `value`, `missing`, raw `attributes`, and GHCND-only decoded `flags`. Identified PRECIP_HLY/HPCP and PRECIP_15/QPCP missing sentinels omit `value` and set `missing: true`; GHCND quality failures retain their numeric values. Missing/QC counts describe the returned page and compose with units, normalization, clamp, and paging notices.
- **Input**:
  - `datasetId: string` — `.describe('Dataset ID (e.g., GHCND for daily data, GSOM for monthly, GSOY for annual, NORMAL_DLY/MLY/ANN/HLY for the superseded 1981–2010 normals, NEXRAD2/NEXRAD3 for weather radar); noaa_climate_get_normals serves the current 1991–2020 normals. Determines the date range limit: sub-daily, daily, and radar datasets (GHCND, PRECIP_15, PRECIP_HLY, NORMAL_DLY, NORMAL_HLY, NEXRAD2, NEXRAD3) allow 1-year max per request; monthly/annual datasets (GSOM, GSOY, NORMAL_MLY, NORMAL_ANN) allow 10-year max.')` 
  - `startDate: string` (ISO date `YYYY-MM-DD`) — `.describe('Start date for observations. For NORMAL_* datasets use 2010-01-01 — CDO dates its 1981–2010 normals in the proxy year 2010.')`
  - `endDate: string` (ISO date `YYYY-MM-DD`) — `.describe('End date for observations. Must be within 1 year of startDate for sub-daily/daily/radar datasets (GHCND, PRECIP_15, PRECIP_HLY, NORMAL_DLY, NORMAL_HLY, NEXRAD2, NEXRAD3) or within 10 years for monthly/annual datasets (GSOM, GSOY, NORMAL_MLY, NORMAL_ANN). For any NORMAL_* dataset use 2010-12-31.')`
  - `stationId?: string[]` — `.describe('One or more station IDs to filter by (e.g., ["GHCND:USW00024233"]). Obtain from noaa_climate_find_stations. Serialized to ampersand-chained query params.')`
  - `locationId?: string[]` — `.describe('One or more location IDs to filter by (e.g., ["FIPS:37", "ZIP:98101"]). Broader than stationId — returns all data within the location.')`
  - `datatypeId?: string[]` — `.describe('One or more data type IDs to include (e.g., ["TMAX","TMIN","PRCP"]). Without this, all data types for the dataset are returned. Use noaa_climate_list_data_types to discover valid IDs.')`
  - `units?: enum('standard'|'metric')` — explicit conversion; omission preserves datatype-specific raw values and adds guidance, including on empty pages. GHCND TMAX/TMIN use tenths °C, PRCP tenths mm, and SNOW/SNWD whole mm; GSOM/GSOY temperature/precipitation examples use °C/mm; NORMAL_* temperature normals use tenths °F, degree days whole °F-days, and precipitation normals hundredths inches; HPCP/QPCP use hundredths inches. These examples are not conversion rules for wind, directions, counts, or percentages. Under metric, CDO converts some NORMAL_* degree days, diurnal ranges, and standard deviations as if they were temperatures, which makes them wrong: `-HTDD-NORMAL`, `-CLDD-NORMAL`, `-GRDD-TB4886`, `-GRDD-TB5086`, and `-DUTR-NORMAL` on NORMAL_MLY and NORMAL_ANN; `-STDDEV` on NORMAL_MLY; `-DUTR-NORMAL` and `-STDDEV` on NORMAL_DLY. A notice names them, values stay as CDO returned them, and the recovery is the raw values with units omitted: whole °F-day degree days ×5/9, tenths-°F ranges and standard deviations ×1/18. NORMAL_* pages also carry a notice for NCEI special-value codes (-9999, -7777, -6666, -4444).
  - `includemetadata?: boolean (default true)`
  - `sortField?`, `sortOrder?`, `limit`, `offset`
- **Output**: `{ results: Array<{ date, datatype, station, value?: number, missing?: true, attributes?: string, flags?: { measurement?, quality?, source?, observationTime? } }>, metadata?: { resultset: { count, limit, offset } } }`. GHCND flags preserve positional blanks, unknown codes, and observation-time leading zeros; absent trailing slots stay omitted. Nonblank `flags.quality` means a failed quality check. Other datasets retain raw attributes without GHCND decoding. Precipitation sentinels are matched only for HPCP/QPCP in their respective datasets and requested unit systems: raw `99999`, standard `999.99`, metric `25399.75`.
- **Errors**: `{ reason: 'service_unavailable', code: ServiceUnavailable, when: 'CDO API is down or unreachable', retryable: true }`, `{ reason: 'date_range_exceeded', code: ValidationError, when: 'Date range exceeds the dataset calendar-month boundary' }`, `{ reason: 'upstream_auth_failed', code: ConfigurationError, when: 'CDO rejected the configured API token' }`, `{ reason: 'validation_error', code: ValidationError, when: 'Invalid dataset, dates, or filter IDs, or an encoded observation query over 4000 characters' }`.
- **Annotations**: `readOnlyHint: true`, `openWorldHint: true`

### `noaa_climate_get_normals`

- **Description**: Fetch one station's 1991–2020 U.S. Climate Normals, NOAA's current 30-year baseline, at monthly, daily, hourly, or annual/seasonal granularity. Needs no token. Values stay in NCEI's native units and are never converted, with a unit on each record whose unit was verified; each record carries NCEI's completeness flag and years of data. CDO `NORMAL_*` datasets are the superseded 1981–2010 normals.
- **Input**:
  - `stationId: string` — one GHCN-Daily ID per call, bare (`USW00024233`) or with a `GHCND:` prefix; other namespaces fail validation
  - `granularity: enum('monthly'|'daily'|'hourly'|'annualseasonal')`
  - `datatypeId?: string[]` (1–50) — uppercased and held to the granularity's prefixes (see the 1991–2020 Normals Datasets table); omitted, the granularity's defaults are read
  - `month?: number` (1–12) — required for `hourly`, narrows `daily` and `monthly`, rejected for `annualseasonal`
  - `limit: number (default 100, max 1000)`, `offset: number (default 0)`
- **Output**: `{ station, granularity, results: Array<{ date?, datatype, value?: number, valueText?: string, missing?: true, unit?, completeness?, years?: number, measurementFlag? }> }` plus enrichment `totalCount`, `effectiveQuery`, `truncated`/`shown`/`cap`, `exhausted`, and a composed `notice`. Records are ordered by `date`, then by requested datatype. `date` is NCEI's key without a year and is absent for `annualseasonal`. `completeness` is `S` standard (24 or more years), `R` representative (10 or more, gaps filled from nearby stations), `P` provisional (10 or more, gaps unfilled), or `E` estimated from nearby stations (2 or more); the notice counts `R`, `P`, and `E` records on the page.
- **Errors**: `{ reason: 'validation_error', code: ValidationError, when: 'A datatypeId lacks the granularity prefix, month is missing for hourly or given for annualseasonal, or NCEI rejected a parameter' }`, `{ reason: 'service_unavailable', code: ServiceUnavailable, when: 'The Access Data Service is unreachable, returned a server error other than a 504, or answered with something other than JSON rows', retryable: true }`, `{ reason: 'rate_limited', code: RateLimited, when: 'NCEI throttled the request (HTTP 429)', retryable: true }`. A 504 and a timed-out request fail as `Timeout` with no declared reason. An unknown station, a station without normals, and an absent datatype are results with notices, not errors.
- **Annotations**: `readOnlyHint: true`, `openWorldHint: true`

---

## Design Decisions

**Dataset date filters use inclusive coverage overlap locally.** CDO ignores dates on `/datasets`. The handler retrieves the complete catalog matching the non-date filters in upstream sort order, then compares normalized `maxdate >= startDate` and `mindate <= endDate` for each supplied bound before slicing. Filtered totals, metadata, and exhaustion describe the caller's page. Catalog requests share a 45-second deadline and caller cancellation; an incomplete response that makes no progress fails rather than returning a partial total. Undated calls retain upstream paging and count-probe behavior.

**Discovery dates use normalized handler-level ordering checks.** The five discovery tools reject `startDate > endDate` with `validation_error` before fetching, as observation queries do. Equal dates and single-ended ranges remain accepted, including compact, unpadded dashed, and supported second-precision datetime forms. Handler checks carry recovery instructions that schema refinements cannot.

**Station extents validate geography without reordering it.** `minLat,minLon,maxLat,maxLon` accepts four finite signed decimal or scientific numbers with surrounding whitespace, latitude within ±90 and longitude within ±180. Equal bounds remain valid. In-range reversed axes are forwarded unchanged and yield no matches; the server does not split or wrap an antimeridian box. Syntax reaches clients through the advertised pattern; numeric overflow and geographic bounds are checked locally before any request.

**1. `noaa_climate_list_location_categories` is a first-class discovery tool.**
`/locationcategories` returns 12 stable ID/name pairs. Keeping them in the `noaa_climate_find_locations` parameter prose alone let one — `US_TERR` — go missing, and left the hydrological categories buried in a sentence rather than reachable by a call. The tool takes pagination and sort only: CDO ignores `datasetid`, `locationid`, `stationid`, and the date range on this endpoint, so offering those filters would advertise narrowing that never happens.

**2. `noaa_climate_find_locations` has `openWorldHint: true`, discovery tools have `false`.**
Datasets, categories, and data types are small, bounded, stable lists (the full universe fits in one or two pages). Locations — cities, counties, zip codes — are a large open corpus. `openWorldHint` accurately communicates this to clients.

**3. `noaa_climate_fetch_data` returns flat records, not pivoted tables.**
The CDO API returns `{ date, datatype, station, value }` tuples, not wide rows per date. Preserving this shape avoids fabricating a schema that doesn't match the data. The agent can pivot as needed. Pivoting in the server would also require knowing all the data types in advance, which creates coupling.

**4. Rate limit handling in the service layer, not in tools.**
The 5 req/s limit is best managed at the HTTP client level (token-bucket or retry-after backoff), not distributed across seven tool handlers. `CdoService` owns this concern.

**5. No workflow tool for "find stations and fetch data" composite.**
The primary workflow (find location → find stations → fetch data) is simple enough for agents to execute step-by-step with three tool calls. The intermediate state (location IDs, station IDs) is naturally captured by the agent. A composite workflow tool would save a round-trip but at the cost of a bloated, hard-to-test tool with many conditional parameters. Keep tools focused.

**6. Resources are supplementary only.**
`noaa://datasets` provides injectable context for clients that support resources, covering the small stable dataset list. `noaa://stations/{stationId}` mirrors `noaa_climate_get_station`. Both data resources are optional — tools cover the same data. The published `skills/noaa-climate-guide/SKILL.md` is also served as `skill://noaa-climate-guide/SKILL.md` and through the MCP Skills extension, so workflow guidance reaches resource-capable clients as well as plugin hosts. npm, MCPB, and Docker retain the root `skills/` tree.

**7. No prompt templates.**
This is a data-access server. The interaction patterns are "query → result", not structured workflows that benefit from templates.

**8. `noaa_climate_fetch_data` accepts arrays for `stationId` and `locationId`.**
The CDO API supports comma-separated or chained IDs for filtering. Accepting arrays on the MCP side and serializing them to the API's expected format is more ergonomic for agents. Common workflow: search returns several stations, agent passes all of them to fetch_data to get comparative readings.

---

## Known Limitations

- **No geocoding.** The CDO API has no lat/lon-to-location-name lookup. Agents that start with a place name must either know the location ID (e.g., FIPS code) or use `noaa_climate_find_locations` to search by name within a category.
- **No upstream text search on locations.** The `/locations` endpoint has no name-search or substring-filter parameter — only `sortfield=name` for alphabetical ordering. `noaa_climate_find_locations` synthesizes one client-side via `nameContains`: it enumerates the requested category (up to four `limit=1000` fetches, the largest burst that fits inside CDO's 5-requests-per-second limit) and substring-matches the names, which covers every category of at most 4,000 locations — every one but `ZIP` (30,415). Past the limit, narrow with `datasetId`/`datacategoryId`, page alphabetically, or use a known location ID format (e.g., `FIPS:37` for NC). Station search by `locationId` still requires an exact location ID — there is no name-based station lookup.
- **Date range limits.** Sub-daily, daily, and radar datasets are limited to 1-year per request; monthly/annual to 10 years. Multi-year daily analyses require sequential requests — each consuming daily quota.
- **10,000 requests/day ceiling.** Bulk historical analysis across many stations and long date ranges will hit the daily limit. Agents should prefer monthly (GSOM) or annual (GSOY) datasets when fine-grained daily data isn't needed.
- **Raw units by default.** Omitted units preserve datatype-specific scales; the response provides examples and a NOAA documentation link, not complete unit metadata. Prefer explicit metric/standard conversion and establish each datatype's units before aggregation. Missing precipitation is never zero; GHCND QC failures require an explicit inclusion policy.
- **CDO normals are the superseded baseline and date-range-fixed.** NORMAL_DLY/MLY/ANN/HLY are the 1981–2010 climatological normals. Despite spanning 30 years of source data, they are accessed with `startdate=2010-01-01` and `enddate=2010-12-31` — the API uses 2010 as the proxy year for all normals queries. This is an API convention, not a bug. The current 1991–2020 normals come from `noaa_climate_get_normals`, which covers one GHCN-Daily station per call (about 15,600 stations monthly, daily, and annual/seasonal; about 470 hourly) and labels units for only the datatypes whose native unit was verified.

---

## API Reference

### Base URL
`https://www.ncei.noaa.gov/cdo-web/api/v2/`

### Auth
Header: `token: <NOAA_CDO_TOKEN>`

### Rate Limits
- 5 requests/second
- 10,000 requests/day

### Pagination
- `limit`: max results per page, up to 1000 (default 25)
- `offset`: 1-based record index to start from — the tools' own `offset` input is zero-based, and `CdoService` adds 1 before sending
- Response includes `metadata.resultset.{ count, limit, offset }` when `includemetadata=true`

### Date Range Constraints (data endpoint)
| Dataset type | Max range per request |
|:-------------|:----------------------|
| Sub-daily, daily, and radar (GHCND, PRECIP_15, PRECIP_HLY, NORMAL_DLY, NORMAL_HLY, NEXRAD2, NEXRAD3) | 1 year |
| Monthly/Annual (GSOM, GSOY, NORMAL_MLY, NORMAL_ANN) | 10 years |

### Common Location ID Formats
| Format | Example | Meaning |
|:-------|:--------|:--------|
| `FIPS:{2-digit}` | `FIPS:37` | US state (FIPS code) |
| `FIPS:{5-digit}` | `FIPS:37021` | US county |
| `CITY:{id}` | `CITY:US530018` | City |
| `ZIP:{5-digit}` | `ZIP:98101` | US zip code |
| `FIPS:{2-letter}` | `FIPS:US` | Country (the `CNTRY` category, but IDs carry the `FIPS:` prefix) |
| `CLIM:{id}` | `CLIM:104` | NOAA climate region — the `CLIM_REG` category, but its IDs carry the `CLIM:` prefix |

### Common Station ID Formats
| Format | Example | Notes |
|:-------|:--------|:------|
| `GHCND:{id}` | `GHCND:USW00024233` | GHCND stations (most common for daily data) |
| `COOP:{id}` | `COOP:010008` | NOAA Cooperative Observer network |

---

## Decisions Log

| Date | Decision | Rationale |
|:-----|:---------|:----------|
| 2026-05-23 | Single `CdoService` for all endpoints | All seven CDO endpoints share the same base URL, auth header, and pagination pattern. No benefit to splitting by endpoint. |
| 2026-05-23 | No `/locationcategories` tool | Only ~11 stable values; documenting them in the `noaa_climate_find_locations` description is sufficient. A dedicated tool would be called once and forgotten. |
| 2026-05-23 | Flat tuple output from `noaa_climate_fetch_data` | Preserves the CDO API's native response shape. Pivoting to wide-format would require knowing all requested data types upfront and introduces transformation errors. |
| 2026-05-23 | No composite station-search-and-fetch workflow tool | Three focused tools map to a simple three-step agent workflow. Combining them creates a bloated interface and moves error handling complexity into the tool. |
| 2026-05-23 | `openWorldHint: false` for reference/discovery tools | Datasets, categories, and data types are finite, enumerable lists the server can fully return. `openWorldHint: true` reserved for locations and stations (effectively unbounded). |
| 2026-05-23 | Arrays accepted for `stationId`/`locationId` in fetch_data | CDO API supports multiple IDs natively. Accepting arrays avoids forcing agents to loop and accumulate results manually — key for comparing readings across stations. |
| 2026-05-23 | Rate-limit handling owned by `CdoService` | Centralizing retry/backoff in the HTTP client prevents duplicating logic across seven tool handlers and ensures consistent behavior. |
| 2026-05-23 | Corrected rate limit: 10,000/day (not 1,000) | The official CDO API docs state 10,000 requests/day. The idea.md noted 1,000, which appears to be an older or incorrect figure. API docs are authoritative. |
| 2026-05-23 | Corrected list response shape: `results` key, not endpoint-named keys | Official CDO API returns `{"results": [...], "metadata": {"resultset": {"limit","count","offset"}}}`. All collection output schemas updated. |
| 2026-05-23 | Added NORMAL_HLY dataset | Exists as a full CDO dataset (hourly normals) omitted from initial design. |
| 2026-05-23 | Corrected date range limits for NORMAL_DLY/HLY | API classifies by temporal resolution, not dataset name. NORMAL_DLY and NORMAL_HLY follow the 1-year daily rule; NORMAL_MLY/ANN follow the 10-year monthly/annual rule. |
| 2026-05-23 | Added typed error contracts to all tools | Structured `{ reason, code, when, retryable }` format required for `ctx.fail` type-checking. |
| 2026-05-23 | Documented camelCase→lowercase param translation responsibility | CDO API requires lowercase param names; MCP input schemas use camelCase. CdoService owns the translation. |
| 2026-08-18 | Reversed the 2026-05-23 "No `/locationcategories` tool" decision | The live endpoint returns 12 categories, not the ~11 the original entry assumed — the parameter prose omitted `US_TERR` entirely. The hydrological categories are also the entry point practitioners need, and `nameContains` makes picking a bounded category a real decision. `noaa_climate_list_location_categories` now enumerates them. |
| 2026-08-18 | `nameContains` eligibility is a live count, never a category allowlist | `HYD_CAT` (2,111) is larger than `CITY` (1,989), so any hardcoded "small categories" list gets it wrong, and a category can grow across the line. The handler reads `metadata.resultset.count` from its own first enumeration fetch and rejects past four `limit=1000` pages — four being the largest burst inside CDO's 5-requests-per-second limit, and 4,000 landing in the 9.6x gap between `CNTY` (3,178) and `ZIP` (30,415). |
| 2026-08-18 | `nameContains` enumerates fully, then filters, and synthesizes its own `metadata.resultset` | Filtering one upstream page would leave `totalCount` describing the raw category while the results describe the filtered set. Relaying CDO's raw echo reproduces the same lie in `metadata` and `format()`, since it describes an internal fetch the caller never made. |
| 2026-08-18 | Date-range cap follows CDO's month rule, not a fixed day count | Probing `/data` live: a request is accepted while `endDate` is on or before the last day of the calendar month N years after `startDate`'s month. The old 365/3650-day caps rejected a full leap year (366 days) and a full 10 calendar years (3,652 days) that CDO answers normally. |
| 2026-08-18 | Date filters go on the wire in the canonical `YYYY-MM-DD[THH:MM:SS]` form, not the caller's string | CDO's parsers disagree with each other: `/data` rejects a compact `startdate` — with the misleading "The date range must be less than 1 year." — and rejects the unpadded dashed form outright, while every other endpoint accepts both. Normalizing at the edge keeps one schema across the whole surface *and* makes every advertised form work everywhere, which passing the caller's string through did not. |
| 2026-08-18 | `NEXRAD2`/`NEXRAD3` carry the 1-year cap | CDO documents the cap for daily datasets only, yet enforces the same calendar-month boundary on radar: from a 2020-03-10 start, 2021-04-01 answers "The date range must be less than 1 year." while 2021-03-31 gets past the range check. Uncapped, an over-long radar request was forwarded and the caller got that opaque upstream error in place of `date_range_exceeded` and its computed `maxEndDate`. |
| 2026-08-18 | Example station ID is `GHCND:USW00024233` | `GHCND:USC00450974` never resolved — CDO answers it with a bare `{}` — so an agent following the example landed on `not_found`. Replacements are verified against the live API before landing. |
| 2026-08-18 | Billion-Dollar Disasters costs are exposed in whole US dollars, not the units NCEI writes | NCEI declares three different cost units across the four exports — millions per-event, billions for the national per-year, millions again for a per-state per-year — so relaying each file's own unit would make `minCostInUsd` mean something different per call and make two responses from the same tool incomparable. One exposed unit removes the ambiguity, and the field names carry it (`cpiAdjustedCostInUsd`, `costRangeInUsd`). |
| 2026-08-18 | The cost multiplier is read from each file's preamble, never hardcoded per endpoint | Both files state their own unit in a leading comment line. Parsing it makes the declared unit the single source of truth, self-corrects if NCEI changes one, and turns an unrecognized unit into `malformed_export` instead of a silent 1,000x error. Hardcoding "events files are millions" would still be right today and wrong the moment NCEI restates a file. |
| 2026-08-18 | The Billions per-year exports are parsed off their header, not off the scope | The national file publishes `"<Type> Cost"` plus six confidence-bound columns; the per-state file publishes `"<Type> Cost Range"` with a binned value and no point estimate — a shape difference the issue's national-only reading did not anticipate. Reading which columns exist keeps one parser correct for both instead of branching on national-vs-state. |
| 2026-08-18 | `CsvStreamReader` moved to `src/services/csv/` | Two bulk-CSV services now parse with it. Importing it from inside `storm-events/` would imply a dependency on that domain that the Billions service does not have. Nothing else was extracted — filename discovery, gzip, the year LRU, and damage parsing are Storm Events' alone, and the Billions exports need none of them. |
| 2026-08-18 | `CdoService` recovers CDO's own rejection message before rethrowing | `fetchWithTimeout` throws on a non-2xx before anything reads the body, so every 4xx reached the client as `Fetch failed for <url>. Status: 400` — a bad date form, an over-long range, a missing parameter, and an over-large `limit` were indistinguishable, and the message leaked the fully-parameterized URL. The body is not lost: the helper captures it under `data.body`, so the message is recoverable. CDO writes most faults as XML `<developerMessage>` and its token failures as JSON `message`, so both are matched. |
| 2026-08-18 | A rejected API token routes to `upstream_auth_failed`, not `validation_error` | The token failure is the one 4xx a well-formed request hits routinely, and the caller's inputs are not what broke — `validation_error`'s recovery sends the agent to re-verify IDs that were never wrong, and every retry fails identically, so the advice loops. The new reason names `NOAA_CDO_TOKEN` as the thing to fix. Every CDO-backed tool declares it under the same `ConfigurationError` code so a client branches on one value, and one shared predicate (`shared/upstream-auth.ts`) decides the routing — each route sends the same `token` header, so a per-tool copy of the pattern would be a per-tool copy to drift. |
| 2026-08-18 | No routing on CDO's upstream range sentence | `KNOWN_DATASETS` is exactly `ONE_YEAR_DATASETS ∪ MONTHLY_DATASETS` and `maxSpanYearsForDataset()` returns a cap for every member, so a datasetId reaching the request always has a local cap and one that does not is rejected as `validation_error` before any request is made. The local caps were verified against CDO's own boundary: `GHCND` 2024-01-15..2025-01-31 answers 200 and 2025-02-01 answers 400; `GSOM` 2010-05-01..2020-05-31 answers 200 and 2020-06-01 answers 400. A branch on the upstream sentence was therefore unreachable, and a dataset CDO caps without documenting it is when it earns its place. |
| 2026-08-18 | An unexplained CDO failure carries a recovery hint of its own | CDO's front end answers an over-long request URL with HTTP 414 and an Apache error page — no `<developerMessage>`, no JSON `message` — and 414 maps to `InvalidRequest`, past every tool's `InvalidParams` routing, so the caller got a bare status with no next move. The hint is attached in `explainCdoFailure` where the message extraction already failed, covering every route at one site rather than capping `datatypeId` at a guessed array length. |
| 2026-08-18 | A state-scoped events response declares its `costBasis` | The per-state rows carry the whole disaster's national cost, which the tool description, README, and this doc all say — and none of which an agent re-reads while paging results. `scope: "CA"` beside `$30,000,000,000` reads as a California figure, so the response states the basis for itself, in `structuredContent` and in the rendered text. |
| 2026-08-18 | `coveredYears` is read from both ends of every row | The year filter matches on overlap, so a 2023 query returns a disaster that began in December 2022 — under a coverage line reading 1982–2022 when the span was built from begin years alone. The span now folds in end years, so it cannot end before a row the same response returned. |
| 2026-08-18 | `CLIM_REG:` is not a location ID prefix — climate regions are `CLIM:104` | `CLIM_REG` is the location *category*; its locations carry the `CLIM:` prefix. The documented `CLIM_REG:SOUTHATL` was unresolvable at the prefix, before its value was even in question. |
| 2026-08-18 | Example identifiers are checked against the live API in an opt-in `live` vitest project | Three dead example IDs reached production because nothing could catch them: the linter checks schema shape, typecheck cannot reach a string literal's meaning, and the unit suite runs on fixtures by design. Extraction is tractable because the identifiers have a rigid `PREFIX:VALUE` shape. The lane is a separate vitest project so `bun run test` stays hermetic; `bun run test:live` opts in. The extraction rules themselves are pinned by a hermetic unit test, so the live lane cannot pass by matching nothing. |
| 2026-11-11 | `noaa_climate_get_normals` labels NCEI's native units and never sends `units` | The Access Data Service's conversion is wrong per datatype: under `units=metric`, `MLY-TAVG-NORMAL` stays 42.8 while a 2.1 °F `MLY-TAVG-STDDEV` becomes −16.6, because temperatures need an offset and degree days, standard deviations, and ranges only scale. Values stay native and a `unit` is labeled only for datatypes whose unit was checked against live values (temperature, precipitation and snowfall, base-65 heating and cooling degree days, hourly sea-level pressure in hPa although NCEI's documentation says inches of mercury); any other datatype carries none, degree days at other bases included, and the notice links NCEI's documentation. |
| 2026-11-11 | `noaa_climate_get_normals` `limit` defaults to 100 | A record is about 170 B, so a full page is about 17–18 KB across `content[]` and `structuredContent`, and the monthly default baseline is 60 records, which a default page holds whole. The ceiling stays at 1000 like CDO. |
| 2026-11-11 | `cdoLocationId` appears only on `C` rows with a state code in 01–56 other than Alaska's 02 | Alaska's county rows carry NWS zone numbers, and some compose a different real borough (`185 EASTERN ALEUTIANS` would make `FIPS:02185`, which CDO resolves to North Slope). NCEI writes territories as 96–99, not their Census codes. A remap or alias table would hand callers a wrong county on any gap in it, so those rows keep `stateFips` and `czFips` and omit the ID. |
| 2026-11-11 | `noaa_climate_search_storm_events` `limit` defaults to 10, down from 50 | A default Tornado page measured about 62 KB of structured output at 50 and about 16 KB at 10. The ceiling stays 100, and callers who want a wide page ask for it. |
| 2026-11-11 | `NORMAL_*` values stay as CDO returned them, with notices for the metric mis-conversion and special-value codes | Under `units=metric` CDO converts some degree days, ranges, and standard deviations as temperatures, and which ones depends on the dataset: NORMAL_MLY and NORMAL_ANN offset `-HTDD-NORMAL`, `-CLDD-NORMAL`, the thresholded `-GRDD-TB4886`/`-GRDD-TB5086`, and `-DUTR-NORMAL`, NORMAL_MLY also `-STDDEV`, while NORMAL_DLY scales its degree days correctly and offsets only `-DUTR-NORMAL` and `-STDDEV`. NCEI's special values (-9999, -7777, -6666, -4444) arrive as numbers, sometimes scaled with the datatype or converted outright. Correcting or dropping them server-side would mean guessing which converted number was a code, so the notice names the affected datatypes and the fix: omit `units` and convert the raw values (whole °F-day degree days ×5/9, tenths-°F ranges and standard deviations ×1/18). `units=standard` is not the fix, because it leaves the seasonal ranges unscaled (`DJF-DUTR-NORMAL` 157 raw and standard alike). |
| 2026-11-11 | An upstream HTML error page reaches the caller as its `<title>`, never as markup; no route sets `exposeErrorBody` | `fetchWithTimeout` keeps the body it captures off every client envelope. CDO's own explanation already reaches the caller through the message, extracted on the server, so exposing the XML fault would add only markup. An HTML page — CDO's Apache 414, an NCEI or proxy error page — was readable only inside `data.body`, so `describeHttpStatus()` (`services/upstream-failure.ts`) quotes its title beside the status for all three services, and CDO no longer pattern-matches an HTML page for a `"message"`. A page with no title gets the bare status. |
