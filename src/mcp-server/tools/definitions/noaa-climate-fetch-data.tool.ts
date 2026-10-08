/**
 * @fileoverview Fetch historical NOAA CDO observation data for a dataset and date range.
 * @module mcp-server/tools/definitions/noaa-fetch-data
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { isUpstreamTokenRejection } from '@/mcp-server/tools/definitions/shared/upstream-auth.js';
import { upstreamOutageReason } from '@/mcp-server/tools/definitions/shared/upstream-availability.js';
import {
  identifierArrayFilter,
  identifierFilter,
  isoDateFilter,
  toCdoWireDate,
  toUtcMillis,
} from '@/mcp-server/tools/definitions/shared/validation.js';
import { getCdoService } from '@/services/cdo/cdo-service.js';
import { resolveCollectionTotal } from '@/services/cdo/pagination.js';

const MS_PER_DAY = 86_400_000;

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
    'Fetch historical observation records from a NOAA CDO dataset for a given date range. Requires datasetId (e.g., GHCND for daily, GSOM for monthly), startDate, and endDate. Optionally scope to specific stations, locations, and data types. Date range limits per request: sub-daily, daily, and radar datasets (GHCND, PRECIP_15, PRECIP_HLY, NORMAL_DLY, NORMAL_HLY, NEXRAD2, NEXRAD3) are limited to 1 year; monthly and annual datasets (GSOM, GSOY, NORMAL_MLY, NORMAL_ANN) are limited to 10 years. A full calendar year always fits, leap years included — the limit runs to the end of the calendar month 1 (or 10) years after startDate. For climate normals (NORMAL_*), use startDate=2010-01-01 and endDate=2010-12-31 — that is the API proxy year regardless of which 30-year period is being described. Returns flat tuples of { date, datatype, station, value, attributes }. Strongly recommended: pass units=metric or units=standard — without it, GHCND values are raw tenths-of-unit integers (TMAX=256 = 25.6°C, PRCP=12 = 1.2mm). GSOM/GSOY are already scaled.',
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
    stationId: identifierArrayFilter(
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
        'Unit system for returned values. Without this parameter, GHCND returns raw tenths-of-unit integers (TMAX=256 = 25.6°C). Strongly recommended: pass metric (SI units) or standard (Fahrenheit/inches). Optional.',
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
    limit: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .default(25)
      .describe('Maximum number of records to return (1–1000). Defaults to 25.'),
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
              .describe(
                'Observed value. Unit depends on the dataset and units parameter. For GHCND without units, this is a raw tenths-of-unit integer.',
              ),
            attributes: z
              .string()
              .optional()
              .describe('Quality flags and measurement attributes. Omitted when not provided.'),
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
              .describe('1-based starting index of this page as returned by the NOAA CDO API.'),
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
        'Guidance when no records were returned — echoes query parameters and suggests how to broaden.',
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
      when: 'Bad dataset ID, date format, or unknown station/location/datatype ID.',
      recovery:
        'Verify the datasetId, date format (YYYY-MM-DD), and all filter IDs. Use noaa_climate_list_datasets, noaa_climate_find_stations, and noaa_climate_list_data_types to confirm valid IDs.',
    },
  ],

  async handler(input, ctx) {
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
      stationid: input.stationId,
      locationid: input.locationId,
      datatypeid: input.datatypeId,
      units: input.units,
      includemetadata: true,
      sortfield: input.sortField,
      sortorder: input.sortOrder,
      limit: input.limit,
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
          throw ctx.fail('validation_error', err.message);
        }
      }
      throw err;
    }

    const results = (response.results ?? []).map((rec) => ({
      date: rec.date,
      datatype: rec.datatype,
      station: rec.station,
      value: rec.value,
      ...(rec.attributes && { attributes: rec.attributes }),
    }));

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
    if (input.stationId?.length) queryParts.push(`stations=[${input.stationId.join(', ')}]`);
    if (input.locationId?.length) queryParts.push(`locations=[${input.locationId.join(', ')}]`);
    if (input.datatypeId?.length) queryParts.push(`datatypes=[${input.datatypeId.join(', ')}]`);
    const effectiveQuery = queryParts.join(', ');
    ctx.enrich.echo(effectiveQuery);

    // ctx.enrich.notice is last-wins — exactly one of these branches may fire.
    if (exhausted) {
      ctx.enrich({ exhausted: true });
      ctx.enrich.notice(
        `Page is empty because offset ${input.offset} is past the end of ${totalCount} matching records. Lower offset or reset it to 0.`,
      );
    } else if (results.length === 0) {
      ctx.enrich.notice(
        `No observation records found for ${effectiveQuery}. Verify the station has data for this dataset and date range using noaa_climate_find_stations, or try a different datatypeId.`,
      );
    }

    return {
      results,
      // input.includemetadata gates only this tool's output. Never synthesize a
      // metadata object CDO did not send (an exhausted page carries none).
      ...(input.includemetadata && response.metadata && { metadata: response.metadata }),
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
    lines.push('| Date | Type | Station | Value | Attributes |');
    lines.push('|:-----|:-----|:--------|------:|:-----------|');
    for (const rec of result.results) {
      const attrs = rec.attributes ?? '';
      lines.push(`| ${rec.date} | ${rec.datatype} | ${rec.station} | ${rec.value} | ${attrs} |`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
