/**
 * @fileoverview Fetch historical NOAA CDO observation data for a dataset and date range.
 * @module mcp-server/tools/definitions/noaa-fetch-data
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import { isUpstreamTokenRejection } from '@/mcp-server/tools/definitions/shared/upstream-auth.js';
import { upstreamOutageReason } from '@/mcp-server/tools/definitions/shared/upstream-availability.js';
import {
  applyPageLimit,
  identifierArrayFilter,
  identifierFilter,
  isoDateFilter,
  normalizeStationId,
  pageLimitSchema,
  stationIdArrayFilter,
  stationNormalizationNotice,
  toCdoWireDate,
  toUtcMillis,
} from '@/mcp-server/tools/definitions/shared/validation.js';
import { getCdoService } from '@/services/cdo/cdo-service.js';
import { resolveCollectionTotal } from '@/services/cdo/pagination.js';

const MS_PER_DAY = 86_400_000;

/** Dataset-qualified examples; other datatypes retain their own documented units. */
function rawUnitsNotice(datasetId: string): string {
  const id = datasetId.toUpperCase();
  let examples: string;
  if (id === 'GHCND') examples = 'TMAX/TMIN use tenths °C, PRCP tenths mm, and SNOW/SNWD whole mm';
  else if (id === 'GSOM' || id === 'GSOY')
    examples = 'temperature and precipitation examples use °C and mm';
  else if (id.startsWith('NORMAL_'))
    examples = 'temperature normals use tenths °F and precipitation normals hundredths inches';
  else if (id === 'PRECIP_HLY') examples = 'HPCP uses hundredths inches';
  else if (id === 'PRECIP_15') examples = 'QPCP uses hundredths inches';
  else examples = 'radar values follow the selected product documentation';
  const documentation = id.startsWith('NEXRAD')
    ? 'https://www.ncei.noaa.gov/products/radar/next-generation-weather-radar'
    : `https://www.ncei.noaa.gov/pub/data/cdo/documentation/${id}_documentation.pdf`;
  return `Units omitted: ${id} values are raw; units and scale depend on datatype. Examples: ${examples}. These are examples, not complete unit metadata or conversion rules for wind, direction, counts, or percentages. Request units=metric or units=standard for conversion. NOAA documentation: ${documentation}`;
}

/** Sub-daily and daily datasets. */
const DAILY_DATASETS = new Set(['GHCND', 'PRECIP_15', 'PRECIP_HLY', 'NORMAL_DLY', 'NORMAL_HLY']);

/** Weather radar datasets. */
const RADAR_DATASETS = new Set(['NEXRAD2', 'NEXRAD3']);

/**
 * Datasets limited to a 1-year date range per request.
 *
 * CDO documents the cap for the daily datasets, and enforces the identical
 * calendar-month boundary on radar without documenting it: from a 2020-03-10
 * start, NEXRAD2 and NEXRAD3 answer 2021-04-01 with "The date range must be
 * less than 1 year." while 2021-03-31 gets past the range check. Leaving radar
 * uncapped forwarded an over-long request and handed the caller that opaque
 * upstream error in place of the `date_range_exceeded` contract and its
 * computed `maxEndDate`.
 */
const ONE_YEAR_DATASETS = new Set([...DAILY_DATASETS, ...RADAR_DATASETS]);

/** Datasets limited to a 10-year date range per request. */
const MONTHLY_DATASETS = new Set(['GSOM', 'GSOY', 'NORMAL_MLY', 'NORMAL_ANN']);

/**
 * All stable CDO datasets. Used for pre-request validation so unknown IDs
 * surface as validation_error, not a raw HTTP 500.
 *
 * Exported so the opt-in live lane can assert every gated ID still resolves
 * upstream — a dataset CDO retires would otherwise turn this gate into a
 * permanent rejection of a value the tool advertises.
 */
export const KNOWN_DATASETS = new Set([...ONE_YEAR_DATASETS, ...MONTHLY_DATASETS]);

/** Years of span CDO allows for a datasetId, or undefined when it documents no cap. */
function maxSpanYearsForDataset(datasetId: string): number | undefined {
  const upper = datasetId.toUpperCase();
  if (ONE_YEAR_DATASETS.has(upper)) return 1;
  if (MONTHLY_DATASETS.has(upper)) return 10;
  return;
}

/**
 * Floor a validated CDO date to UTC midnight.
 *
 * The schema admits an optional time-of-day, and CDO's range rule reads the
 * calendar date alone — comparing raw milliseconds would reject a `T23:59:59`
 * end that CDO accepts.
 */
function toUtcDayMillis(value: string): number {
  return Math.floor(toUtcMillis(value) / MS_PER_DAY) * MS_PER_DAY;
}

/**
 * The latest `endDate` CDO accepts for a given start.
 *
 * Established by probing the live `/data` endpoint: acceptance holds while the
 * end date falls on or before the last day of the calendar month `years` years
 * after the start's month, and the next day answers HTTP 400. CDO compares at
 * month granularity, so a fixed day count cannot express the boundary — the
 * same 1-year rule admits 365 days from 2023-01-01 and 397 from 2024-01-01,
 * and a 365-day cap rejected a full leap year CDO answers with 366 records.
 *
 * Day 0 of the following month resolves to the last day of the target month,
 * which also lands February correctly in both leap and common years.
 */
function maxEndDateFor(startDate: string, years: number): string {
  const start = new Date(toUtcDayMillis(startDate));
  const last = new Date(Date.UTC(start.getUTCFullYear() + years, start.getUTCMonth() + 1, 0));
  return last.toISOString().slice(0, 10);
}

/**
 * Count calendar days between two validated CDO date strings (inclusive).
 *
 * Both ends are floored to UTC midnight first: the bare-date and datetime forms
 * the schema accepts otherwise parse against different timelines, which shifts
 * the count by the host's UTC offset and can flip a range sitting on the limit.
 */
function daysBetween(start: string, end: string): number {
  return (toUtcDayMillis(end) - toUtcDayMillis(start)) / MS_PER_DAY + 1;
}

export const noaaClimateFetchData = tool('noaa_climate_fetch_data', {
  title: 'Fetch NOAA Climate Observation Data',
  description:
    'Fetch historical observation records from a NOAA CDO dataset for a given date range. Requires datasetId, startDate, and endDate; optionally filter stations, locations, and datatypes. The encoded query is limited to 4000 characters; reduce filters and make separate calls if exceeded. Sub-daily, daily, and radar datasets allow 1 year; GSOM/GSOY/NORMAL_MLY/NORMAL_ANN allow 10 years, through the end of the corresponding calendar month. For NORMAL_* use the API proxy year 2010. Request units=metric or units=standard: omitted units retain datatype-specific raw scales. Examples: GHCND TMAX/TMIN tenths °C, PRCP tenths mm, SNOW/SNWD whole mm; GSOM/GSOY temperature/precipitation °C/mm; NORMAL_* temperature normals tenths °F and precipitation normals hundredths inches; PRECIP_HLY/HPCP and PRECIP_15/QPCP hundredths inches. These examples are not universal conversion rules. Missing precipitation rows omit value and carry missing=true; GHCND flags expose quality-check failures without dropping values.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    datasetId: identifierFilter(
      'Dataset ID to query (e.g., GHCND for daily data, GSOM for monthly, GSOY for annual, NORMAL_DLY/MLY/ANN/HLY for 1981–2010 climate normals, NEXRAD2/NEXRAD3 for weather radar). Determines date range limit: GHCND/PRECIP_*/NORMAL_DLY/NORMAL_HLY/NEXRAD2/NEXRAD3 allow 1-year max per request; GSOM/GSOY/NORMAL_MLY/NORMAL_ANN allow 10-year max.',
    ),
    startDate: isoDateFilter(
      'Start date for observations (YYYY-MM-DD). For NORMAL_* datasets use 2010-01-01 regardless of the years being analyzed — 2010 is the API proxy year for all normals.',
    ),
    endDate: isoDateFilter(
      'End date for observations (YYYY-MM-DD). Must be within 1 year of startDate for sub-daily/daily/radar datasets (GHCND, PRECIP_15, PRECIP_HLY, NORMAL_DLY, NORMAL_HLY, NEXRAD2, NEXRAD3) or within 10 years for monthly/annual datasets (GSOM, GSOY, NORMAL_MLY, NORMAL_ANN) — measured to the end of the calendar month that many years after startDate, so a full calendar year (2024-01-01 to 2024-12-31) always fits. For any NORMAL_* dataset use 2010-12-31.',
    ),
    stationId: stationIdArrayFilter(
      'One or more station IDs to filter by (e.g., ["GHCND:USW00024233"]). Obtain from noaa_climate_find_stations. Multiple IDs return comparative readings across stations. Optional.',
    ).optional(),
    locationId: identifierArrayFilter(
      'One or more location IDs to filter by (e.g., ["FIPS:37", "ZIP:98101"]). Broader than stationId — returns data from all stations within the location. Optional.',
    ).optional(),
    datatypeId: identifierArrayFilter(
      'One or more data type IDs to include (e.g., ["TMAX", "TMIN", "PRCP"]). Without this, all data types for the dataset are returned. Use noaa_climate_list_data_types to discover valid IDs. Optional.',
    ).optional(),
    units: z
      .enum(['standard', 'metric'])
      .optional()
      .describe(
        'Request metric or standard conversion. Omission preserves datatype-specific raw values: GHCND TMAX/TMIN tenths °C, PRCP tenths mm, SNOW/SNWD whole mm; GSOM/GSOY temperature/precipitation °C/mm; NORMAL_* temperature normals tenths °F and precipitation normals hundredths inches; HPCP/QPCP hundredths inches. Examples are not complete unit metadata. Optional.',
      ),
    includemetadata: z
      .boolean()
      .default(true)
      .describe('Include pagination metadata in the response. Defaults to true.'),
    sortField: z
      .enum(['datatype', 'date', 'station'])
      .optional()
      .describe('Sort results by this field. Optional.'),
    sortOrder: z
      .enum(['asc', 'desc'])
      .optional()
      .describe('Sort direction. Optional; defaults to asc.'),
    limit: pageLimitSchema(1000)
      .default(25)
      .describe(
        'Maximum number of records to return (1–1000). Defaults to 25. Larger positive integers are clamped to 1000 with a notice unless NOAA_CLAMP_LIMITS=false.',
      ),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe('Zero-based index of the first record to return for pagination. Defaults to 0.'),
  }),
  output: z.object({
    results: z
      .array(
        z
          .object({
            date: z.string().describe('Observation date-time in ISO 8601 format.'),
            datatype: z.string().describe('Data type ID (e.g., TMAX, PRCP).'),
            station: z.string().describe('Station ID that recorded this observation.'),
            value: z
              .number()
              .optional()
              .describe(
                'Observed value, omitted for identified missing precipitation. With units omitted, scale depends on datatype: GHCND TMAX/TMIN tenths °C, PRCP tenths mm, SNOW/SNWD whole mm; GSOM/GSOY temperature/precipitation °C/mm; NORMAL_* temperature normals tenths °F, precipitation normals hundredths inches; HPCP/QPCP hundredths inches. Examples are not universal conversion rules.',
              ),
            missing: z
              .literal(true)
              .optional()
              .describe(
                'True for a documented PRECIP_HLY/HPCP or PRECIP_15/QPCP missing sentinel; value is omitted.',
              ),
            attributes: z
              .string()
              .optional()
              .describe(
                'Untouched upstream attributes. GHCND positions are measurement, quality, source, observation time; other datasets have their own layouts documented at https://www.ncei.noaa.gov/pub/data/cdo/documentation/.',
              ),
            flags: z
              .object({
                measurement: z
                  .string()
                  .optional()
                  .describe('GHCND measurement flag; an explicit blank is preserved.'),
                quality: z
                  .string()
                  .optional()
                  .describe(
                    'GHCND quality flag; a nonblank code means a failed quality check. Explicit blanks are preserved.',
                  ),
                source: z
                  .string()
                  .optional()
                  .describe('GHCND source flag, including unknown codes and explicit blanks.'),
                observationTime: z
                  .string()
                  .optional()
                  .describe(
                    'GHCND local observation time, preserving leading zeros and explicit blanks.',
                  ),
              })
              .optional()
              .describe(
                'Decoded GHCND attributes only. Absent trailing positions remain omitted; raw attributes and numeric values are retained.',
              ),
          })
          .describe('A single observation record.'),
      )
      .describe('Flat array of observation records sorted by date by default.'),
    metadata: z
      .object({
        resultset: z
          .object({
            count: z.number().describe('Total number of matching records.'),
            limit: z.number().describe('Page size used for this response.'),
            offset: z
              .number()
              .describe('Zero-based starting index of this page, echoing the requested offset.'),
          })
          .describe('Pagination cursor fields for this response.'),
      })
      .optional()
      .describe('Pagination metadata. Present when includemetadata=true.'),
  }),

  enrichment: {
    totalCount: z
      .number()
      .describe('Total number of matching observation records before the page limit.'),
    effectiveQuery: z
      .string()
      .describe(
        'Summary of the effective query: dataset, date range, units, and any station/location/datatype filters applied.',
      ),
    exhausted: z
      .boolean()
      .optional()
      .describe(
        'True when the requested offset is past the end of a non-empty result set — the page is empty but matches exist. Omitted otherwise.',
      ),
    notice: z
      .string()
      .optional()
      .describe(
        'Composed guidance for station ID normalization, page-limit adjustments, raw units, missing precipitation, GHCND quality-check failures, and empty or exhausted pages. Omitted when no guidance applies.',
      ),
  },

  errors: [
    {
      reason: 'service_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'NOAA CDO API is unreachable or returning errors.',
      retryable: true,
      recovery: 'Wait a moment and retry; NOAA CDO may be temporarily unavailable.',
    },
    {
      reason: 'rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: 'NOAA CDO throttled the request — the configured token went over its rate limit.',
      retryable: true,
      recovery:
        'Space the calls out — NOAA CDO allows 5 requests per second per token, so several climate tools running concurrently is the usual cause. Pause a second, drop the concurrency, then retry.',
    },
    {
      reason: 'date_range_exceeded',
      code: JsonRpcErrorCode.ValidationError,
      when: 'endDate is past the end of the calendar month 1 year after startDate for sub-daily/daily/radar datasets (GHCND, PRECIP_*, NORMAL_DLY, NORMAL_HLY, NEXRAD2, NEXRAD3), or 10 years after it for monthly/annual datasets (GSOM, GSOY, NORMAL_MLY, NORMAL_ANN).',
      recovery:
        'Use the maxEndDate named in the error, or split into consecutive requests. For NORMAL_* datasets use startDate=2010-01-01 and endDate=2010-12-31.',
    },
    {
      reason: 'upstream_auth_failed',
      code: JsonRpcErrorCode.ConfigurationError,
      when: 'NOAA CDO rejected the API token this server is configured with.',
      recovery:
        'The inputs are not at fault — this deployment’s NOAA_CDO_TOKEN is missing or no longer valid. Set it to a working token (free at https://www.ncdc.noaa.gov/cdo-web/token) and restart the server; every retry fails identically until then.',
    },
    {
      reason: 'validation_error',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Bad dataset ID, date format, unknown station/location/datatype ID, or encoded observation query exceeding 4000 characters.',
      recovery:
        'Verify datasetId, dates, and filter IDs using the discovery tools. For a query over 4000 encoded characters, reduce stationId/locationId/datatypeId filters and make separate calls.',
    },
  ],

  async handler(input, ctx) {
    const { limit, notice: clampNotice } = applyPageLimit(
      input.limit,
      1000,
      'noaa_climate_fetch_data',
      ctx,
    );
    const notices: string[] = [];
    if (clampNotice) notices.push(clampNotice);
    const stationId = input.stationId?.map(normalizeStationId);
    const stationNotice = stationNormalizationNotice(input.stationId ?? []);
    if (stationNotice) notices.push(stationNotice);
    ctx.log.info('Fetching data', {
      datasetId: input.datasetId,
      startDate: input.startDate,
      endDate: input.endDate,
      stationId: input.stationId,
      datatypeId: input.datatypeId,
    });

    // Validate datasetId against the known stable set before making a network call.
    // NOAA CDO returns HTTP 500 for unknown dataset IDs — which would surface as a
    // confusing InternalError. Pre-emptively throw validation_error so the agent
    // knows the input is wrong, not that the service is down.
    if (!KNOWN_DATASETS.has(input.datasetId.toUpperCase())) {
      throw ctx.fail(
        'validation_error',
        `Unknown datasetId "${input.datasetId}". Use noaa_climate_list_datasets to retrieve valid dataset IDs.`,
        {
          recovery: {
            hint: 'Use noaa_climate_list_datasets to list valid datasetId values.',
          },
        },
      );
    }

    // Cross-field rule: must be a handler check, not a schema .refine(). Input
    // parsing runs before ctx exists, so a schema-level rejection would bypass
    // the declared validation_error contract and surface as a bare InvalidParams.
    if (toUtcMillis(input.startDate) > toUtcMillis(input.endDate)) {
      throw ctx.fail(
        'validation_error',
        `startDate "${input.startDate}" is after endDate "${input.endDate}".`,
        {
          startDate: input.startDate,
          endDate: input.endDate,
          recovery: {
            hint: 'Swap the values so startDate is on or before endDate, then retry.',
          },
        },
      );
    }

    // Validate the date range against the boundary CDO itself enforces.
    const maxSpanYears = maxSpanYearsForDataset(input.datasetId);
    if (maxSpanYears !== undefined) {
      const maxEndDate = maxEndDateFor(input.startDate, maxSpanYears);
      if (toUtcDayMillis(input.endDate) > toUtcDayMillis(maxEndDate)) {
        const limit = `${maxSpanYears}-year`;
        const requestedDays = daysBetween(input.startDate, input.endDate);
        throw ctx.fail(
          'date_range_exceeded',
          `Date range of ${requestedDays} days exceeds the ${limit} limit for dataset "${input.datasetId}". From startDate "${input.startDate}", the latest endDate NOAA CDO accepts is ${maxEndDate}.`,
          {
            datasetId: input.datasetId,
            requestedDays,
            maxDays: daysBetween(input.startDate, maxEndDate),
            maxEndDate,
            recovery: {
              hint: `Set endDate to ${maxEndDate} or earlier, or split the query into consecutive requests. For NORMAL_* datasets use startDate=2010-01-01 and endDate=2010-12-31.`,
            },
          },
        );
      }
    }

    const service = getCdoService();
    const params = {
      datasetid: input.datasetId,
      startdate: toCdoWireDate(input.startDate),
      enddate: toCdoWireDate(input.endDate),
      stationid: stationId,
      locationid: input.locationId,
      datatypeid: input.datatypeId,
      units: input.units,
      includemetadata: true,
      sortfield: input.sortField,
      sortorder: input.sortOrder,
      limit,
      offset: input.offset,
    };
    let response: Awaited<ReturnType<typeof service.fetchData>>;
    try {
      response = await service.fetchData(params, ctx);
    } catch (err) {
      if (err instanceof McpError) {
        // Checked ahead of the InvalidParams branch: an unreachable or
        // throttled upstream is not a parameter fault, and its codes never
        // enter that branch anyway.
        const outage = upstreamOutageReason(err);
        if (outage === 'rate_limited') throw ctx.fail('rate_limited', err.message);
        if (outage === 'service_unavailable') throw ctx.fail('service_unavailable', err.message);
        if (err.code === JsonRpcErrorCode.InvalidParams) {
          if (isUpstreamTokenRejection(err)) throw ctx.fail('upstream_auth_failed', err.message);
          throw ctx.fail(
            'validation_error',
            err.message,
            err.data?.recovery ? { recovery: err.data.recovery } : undefined,
          );
        }
      }
      throw err;
    }

    const dataset = input.datasetId.toUpperCase();
    const sentinel =
      input.units === 'metric' ? 25399.75 : input.units === 'standard' ? 999.99 : 99999;
    let missingCount = 0;
    let qualityCount = 0;
    const results = (response.results ?? []).map((rec) => {
      const missing =
        ((dataset === 'PRECIP_HLY' && rec.datatype === 'HPCP') ||
          (dataset === 'PRECIP_15' && rec.datatype === 'QPCP')) &&
        rec.value === sentinel;
      if (missing) missingCount++;
      const slots =
        dataset === 'GHCND' && rec.attributes !== undefined ? rec.attributes.split(',') : undefined;
      const flags = slots
        ? {
            measurement: slots[0],
            ...(slots[1] !== undefined && { quality: slots[1] }),
            ...(slots[2] !== undefined && { source: slots[2] }),
            ...(slots[3] !== undefined && { observationTime: slots[3] }),
          }
        : undefined;
      if (flags?.quality?.trim()) qualityCount++;
      return {
        date: rec.date,
        datatype: rec.datatype,
        station: rec.station,
        ...(missing ? { missing: true as const } : { value: rec.value }),
        ...(rec.attributes !== undefined && { attributes: rec.attributes }),
        ...(flags && { flags }),
      };
    });
    if (input.units === undefined) notices.push(rawUnitsNotice(input.datasetId));
    if (missingCount)
      notices.push(
        `${missingCount} missing precipitation observation(s) on this page; value is omitted and missing=true.`,
      );
    if (qualityCount)
      notices.push(
        `${qualityCount} observation(s) on this page failed a GHCND quality check; values are retained. Inspect flags.quality before aggregation.`,
      );

    const { totalCount, exhausted } = await resolveCollectionTotal(
      response,
      params,
      ctx,
      (probeParams, probeCtx) => service.fetchData(probeParams, probeCtx),
    );
    ctx.enrich.total(totalCount);

    // Build effective-query summary for the agent
    const queryParts: string[] = [
      `dataset=${input.datasetId}`,
      `${input.startDate}–${input.endDate}`,
    ];
    if (input.units) queryParts.push(`units=${input.units}`);
    if (stationId?.length) queryParts.push(`stations=[${stationId.join(', ')}]`);
    if (input.locationId?.length) queryParts.push(`locations=[${input.locationId.join(', ')}]`);
    if (input.datatypeId?.length) queryParts.push(`datatypes=[${input.datatypeId.join(', ')}]`);
    const effectiveQuery = queryParts.join(', ');
    ctx.enrich.echo(effectiveQuery);

    // Compose every notice before the single last-wins enrichment write.
    if (exhausted) {
      ctx.enrich({ exhausted: true });
      notices.push(
        `Page is empty because offset ${input.offset} is past the end of ${totalCount} matching records. Lower offset or reset it to 0.`,
      );
    } else if (results.length === 0) {
      notices.push(
        `No observation records found for ${effectiveQuery}. Verify the station has data for this dataset and date range using noaa_climate_find_stations, or try a different datatypeId.`,
      );
    }

    if (notices.length > 0) ctx.enrich.notice(notices.join(' '));

    return {
      results,
      // input.includemetadata gates only this tool's output. Never synthesize a
      // metadata object CDO did not send (an exhausted page carries none).
      ...(input.includemetadata &&
        response.metadata && {
          metadata: { resultset: { ...response.metadata.resultset, limit, offset: input.offset } },
        }),
    };
  },

  format(result) {
    const lines: string[] = [];
    const meta = result.metadata?.resultset;
    if (meta) {
      lines.push(
        `**Total records:** ${meta.count} | **Limit:** ${meta.limit} | **Offset:** ${meta.offset}`,
      );
    }
    if (result.results.length === 0) {
      lines.push('\n_No records on this page._');
      return [{ type: 'text', text: lines.join('\n') }];
    }
    lines.push('');
    lines.push('| Date | Type | Station | Value | Missing | Attributes | Flags |');
    lines.push('|:-----|:-----|:--------|------:|:--------|:-----------|:------|');
    for (const rec of result.results) {
      const attrs = rec.attributes ?? '';
      const flags = rec.flags ? escapeMarkdownInline(JSON.stringify(rec.flags)) : '';
      lines.push(
        `| ${rec.date} | ${rec.datatype} | ${rec.station} | ${rec.value ?? ''} | ${rec.missing ? 'missing=true' : ''} | ${attrs} | ${flags} |`,
      );
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
