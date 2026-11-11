/**
 * @fileoverview Fetch one station's 1991–2020 U.S. Climate Normals — monthly,
 * daily, hourly, or annual/seasonal — from NCEI.
 * @module mcp-server/tools/definitions/noaa-climate-get-normals
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import { upstreamOutageReason } from '@/mcp-server/tools/definitions/shared/upstream-availability.js';
import {
  applyPageLimit,
  ghcnStationIdFilter,
  identifierArrayFilter,
  normalizeGhcnStationId,
  pageLimitSchema,
} from '@/mcp-server/tools/definitions/shared/validation.js';
import { getNormalsService, NORMALS_GRANULARITIES } from '@/services/normals/normals-service.js';
import type { NormalsRecord, NormalsResult } from '@/services/normals/types.js';

const MAX_LIMIT = 1000;
const MAX_DATATYPES = 50;

/** Completeness flags that mark a normal computed from fewer years, or estimated. */
const QUALIFIED_COMPLETENESS = new Set(['R', 'P', 'E']);

/**
 * The per-occurrence override for an outage the service marks `retryable: false`
 * — JSON in a shape this server does not read, which a retry returns unchanged.
 * The contract's `service_unavailable` entry is retryable and says to retry.
 */
const UNCHANGED_ON_RETRY = {
  retryable: false,
  recovery: {
    hint: 'Retrying the same call returns the same response, so do not retry it unchanged. The superseded 1981–2010 normals remain readable through noaa_climate_fetch_data (datasetId NORMAL_MLY, NORMAL_DLY, NORMAL_HLY, or NORMAL_ANN).',
  },
};

export const noaaClimateGetNormals = tool('noaa_climate_get_normals', {
  title: 'Get NOAA 1991–2020 Climate Normals',
  description:
    "Fetch one station's 1991–2020 U.S. Climate Normals, NOAA's current 30-year baseline, for comparing an observed day, month, season, or year against normal. Covers monthly, daily, hourly, and annual/seasonal normals of temperature, precipitation, snowfall, degree days, and the other NCEI normals elements, and needs no token. noaa_climate_fetch_data's NORMAL_* datasets are the superseded 1981–2010 normals. stationId is a GHCN-Daily ID such as USW00024233; about 15,600 stations carry monthly, daily, and annual/seasonal normals, about 470 (nearly all USW stations) hourly normals, and precipitation-only stations carry no temperature normals. Values stay in NCEI's native units — °F, inches, °F-days, hPa — and are never converted; a record carries its unit wherever that unit was verified. Each record carries NCEI's completeness flag and the years of data behind it: S is standard, while R, P, and E mark normals built from fewer years or estimated from neighboring stations. A -9999 value comes back as missing=true with no value. An unknown station and a station without normals both return no records.",
  annotations: { readOnlyHint: true, openWorldHint: true },

  input: z.object({
    stationId: ghcnStationIdFilter(
      'GHCN-Daily station to read, one per call (e.g., "USW00024233", Seattle-Tacoma International Airport). Find IDs with noaa_climate_find_stations; confirm one with noaa_climate_get_station.',
    ),
    granularity: z
      .enum(['monthly', 'daily', 'hourly', 'annualseasonal'])
      .describe(
        'Which normals product to read: monthly (rows "01"–"12"), daily (rows "01-01"–"12-31", including "02-29"), hourly (rows "01-01T00:00:00"–"12-31T23:00:00" in local standard time; month required), or annualseasonal (one row with no date — the period is the datatype prefix: ANN annual, DJF/MAM/JJA/SON seasons).',
      ),
    datatypeId: identifierArrayFilter(
      "Normals datatype IDs to read (1–50), uppercased before sending. Each must carry the granularity's prefix: MLY- for monthly; DLY-, MTD- (month-to-date), or YTD- (year-to-date) for daily; HLY- for hourly; ANN-, DJF-, MAM-, JJA-, or SON- for annualseasonal. Omitted, monthly reads MLY-TAVG-NORMAL, MLY-TMAX-NORMAL, MLY-TMIN-NORMAL, MLY-PRCP-NORMAL, and MLY-SNOW-NORMAL; annualseasonal the same five with ANN-; daily DLY-TAVG-NORMAL, DLY-TMAX-NORMAL, and DLY-TMIN-NORMAL; hourly HLY-TEMP-NORMAL and HLY-DEWP-NORMAL. NCEI's documentation for each product lists the rest — degree days such as MLY-HTDD-NORMAL, standard deviations, percentiles, and frost dates.",
    )
      .max(MAX_DATATYPES, `Request at most ${MAX_DATATYPES} datatypes per call.`)
      .optional(),
    month: z
      .number()
      .int()
      .min(1)
      .max(12)
      .optional()
      .describe(
        'Month 1–12. Required for hourly, which is read one month at a time (744 rows per datatype for January). Narrows daily to that month’s days — February includes 02-29 — and monthly to that month. Rejected for annualseasonal, which has no month axis.',
      ),
    limit: pageLimitSchema(MAX_LIMIT)
      .default(100)
      .describe(
        'Maximum records per page; a record is one datatype on one row. Defaults to 100, which holds the monthly defaults (60 records) or one month of daily defaults (up to 93). Larger positive integers are clamped to 1000 with a notice unless NOAA_CLAMP_LIMITS=false.',
      ),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe('Zero-based index of the first record to return. Defaults to 0.'),
  }),

  output: z.object({
    station: z.string().describe('The bare GHCN-Daily station ID that was read.'),
    granularity: z
      .enum(['monthly', 'daily', 'hourly', 'annualseasonal'])
      .describe('The normals product that was read.'),
    results: z
      .array(
        z
          .object({
            date: z
              .string()
              .optional()
              .describe(
                'NCEI’s row key with no year: "01" monthly, "01-31" daily, "01-01T00:00:00" hourly in local standard time. Omitted for annualseasonal.',
              ),
            datatype: z.string().describe('Normals datatype ID, e.g. MLY-TAVG-NORMAL.'),
            value: z
              .number()
              .optional()
              .describe(
                'The normal in its native unit. Omitted when missing is true, and when NCEI writes the value as text (valueText).',
              ),
            valueText: z
              .string()
              .optional()
              .describe(
                'A value NCEI writes as text rather than a number: the MM/DD dates of the annual frost and freeze probability normals (ANN-TMIN-PRBFST-*, ANN-TMIN-PRBLST-*). Omitted otherwise.',
              ),
            missing: z
              .literal(true)
              .optional()
              .describe(
                'True when NCEI reports its -9999 special value — the normal is missing or could not be computed; value is omitted.',
              ),
            unit: z
              .string()
              .optional()
              .describe(
                'Native unit: °F for temperature and dew point normals, in for precipitation and snowfall normals (monthly, seasonal, annual, month-to-date, year-to-date), °F-days for base-65 heating and cooling degree days (monthly, daily, seasonal, and annual -HTDD-NORMAL and -CLDD-NORMAL), hPa for hourly sea-level pressure (HLY-PRES-NORMAL, HLY-PRES-10PCTL, HLY-PRES-90PCTL; NCEI’s documentation says inches of mercury, but the values are hPa). Omitted for every other datatype, degree days at other bases included; the notice links NCEI’s documentation for its unit.',
              ),
            completeness: z
              .string()
              .optional()
              .describe(
                'NCEI completeness flag: S standard (24 or more years), R representative (10 or more years, gaps filled from nearby stations), P provisional (10 or more years, gaps unfilled), E estimated from nearby stations (2 or more years). Omitted when blank.',
              ),
            years: z
              .number()
              .optional()
              .describe('Years of data behind the value. Omitted when NCEI leaves it blank.'),
            measurementFlag: z
              .string()
              .optional()
              .describe(
                'NCEI measurement flag: M missing, V year-round frost-freeze risk, X nonzero value rounded to zero, Y too few values to compute, Z computed value inconsistent with others. Omitted when blank.',
              ),
          })
          .describe('One datatype on one row.'),
      )
      .describe('Normals records ordered by date, then by requested datatype.'),
  }),

  enrichment: {
    totalCount: z.number().describe('Records in the whole response, before offset and limit.'),
    effectiveQuery: z
      .string()
      .describe('The NCEI dataset, station, datatypes, and month that were requested.'),
    truncated: z
      .boolean()
      .optional()
      .describe('True when more records exist beyond this page. Omitted otherwise.'),
    shown: z.number().optional().describe('Records returned on this page. Omitted otherwise.'),
    cap: z.number().optional().describe('The limit that was applied. Omitted otherwise.'),
    exhausted: z
      .boolean()
      .optional()
      .describe(
        'True when offset is past the end of a non-empty response — the page is empty but records exist. Omitted otherwise.',
      ),
    notice: z
      .string()
      .optional()
      .describe(
        'Composed guidance: station ID normalization, limit clamping, missing values and non-standard completeness on this page, requested datatypes no row carries, unlabeled units, no records, and paging. Omitted when none applies.',
      ),
  },

  errors: [
    {
      reason: 'validation_error',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A datatypeId lacks the granularity’s prefix, month is missing for hourly or given for annualseasonal, or the NCEI Access Data Service rejected a parameter.',
      recovery:
        'Use datatype IDs with the granularity’s prefix (MLY- monthly; DLY-, MTD-, YTD- daily; HLY- hourly; ANN-, DJF-, MAM-, JJA-, SON- annualseasonal), pass month for hourly and omit it for annualseasonal, then retry.',
    },
    {
      reason: 'service_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The NCEI Access Data Service is unreachable, returned a server error other than a 504, or answered with something other than JSON rows. A 504 and a request that times out, the 45-second call deadline included, fail as Timeout with no declared reason instead.',
      retryable: true,
      recovery:
        'Wait a moment and retry the same call; the NCEI Access Data Service may be temporarily unavailable.',
    },
    {
      reason: 'rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: 'The NCEI Access Data Service throttled the request (HTTP 429).',
      retryable: true,
      recovery:
        'Pause a few seconds, run fewer normals calls at once, then retry the same request.',
    },
  ],

  async handler(input, ctx) {
    const spec = NORMALS_GRANULARITIES[input.granularity];
    const station = normalizeGhcnStationId(input.stationId);
    const datatypes = input.datatypeId
      ? [...new Set(input.datatypeId.map((id) => id.trim().toUpperCase()))]
      : [...spec.defaults];

    const prefixed = new RegExp(`^(?:${spec.prefixes.join('|')})-[A-Z0-9-]+$`);
    const foreign = datatypes.filter((id) => !prefixed.test(id));
    if (foreign.length > 0) {
      throw ctx.fail(
        'validation_error',
        `${foreign.join(', ')} ${foreign.length === 1 ? 'is not a' : 'are not'} ${input.granularity} normals datatype${foreign.length === 1 ? '' : 's'}: ${input.granularity} IDs start with ${spec.prefixes.map((prefix) => `${prefix}-`).join(', ')}.`,
      );
    }
    if (input.granularity === 'hourly' && input.month === undefined) {
      throw ctx.fail(
        'validation_error',
        'Hourly normals are read one month at a time — a full year is 8,760 rows per datatype. Pass month (1–12).',
      );
    }
    if (input.granularity === 'annualseasonal' && input.month !== undefined) {
      throw ctx.fail(
        'validation_error',
        'annualseasonal normals have no month axis. Drop month; for a season use DJF-, MAM-, JJA-, or SON- datatypes, or read granularity monthly with month.',
      );
    }

    const { limit, notice: clampNotice } = applyPageLimit(
      input.limit,
      MAX_LIMIT,
      'noaa_climate_get_normals',
      ctx,
    );
    const notices: string[] = clampNotice ? [clampNotice] : [];
    if (station !== input.stationId) {
      notices.push(`Normalized station ID: ${JSON.stringify(input.stationId)} → ${station}.`);
    }
    ctx.log.info('Getting normals', {
      station,
      granularity: input.granularity,
      datatypes,
      month: input.month,
    });

    let result: NormalsResult;
    try {
      result = await getNormalsService().getNormals(
        {
          station,
          granularity: input.granularity,
          datatypes,
          ...(input.month !== undefined && { month: input.month }),
        },
        ctx,
      );
    } catch (err) {
      if (err instanceof McpError) {
        const outage = upstreamOutageReason(err);
        if (outage) {
          const override = err.data?.retryable === false ? UNCHANGED_ON_RETRY : undefined;
          throw ctx.fail(outage, err.message, override, { cause: err });
        }
        if (err.code === JsonRpcErrorCode.InvalidParams) {
          throw ctx.fail('validation_error', err.message, undefined, { cause: err });
        }
      }
      throw err;
    }

    const query = [
      `dataset=${result.dataset}`,
      `station=${station}`,
      `datatypes=[${datatypes.join(', ')}]`,
    ];
    if (input.month !== undefined) query.push(`month=${input.month}`);
    ctx.enrich.echo(query.join(', '));

    const totalCount = result.records.length;
    ctx.enrich.total(totalCount);
    const page = result.records.slice(input.offset, input.offset + limit);

    if (result.rowCount === 0) {
      notices.push(
        `No 1991–2020 normals came back for station ${station} from ${result.dataset}. NCEI answers an unknown station and a station without normals the same way: confirm the ID with noaa_climate_get_station, or pick a long-record station with noaa_climate_find_stations${input.granularity === 'hourly' ? ' — hourly normals exist for about 470 stations' : ''}.`,
      );
      const caseSentence = stationCaseSentence(input.stationId, station);
      if (caseSentence) notices.push(caseSentence);
    } else if (result.unmatchedDatatypes.length > 0) {
      notices.push(
        `No row for station ${station} carries ${result.unmatchedDatatypes.join(', ')}: the ID is not one ${result.dataset} computes, or this station does not have it (precipitation-only stations carry no temperature normals). Datatype IDs: ${spec.documentation}`,
      );
    }
    notices.push(...pageNotices(page, spec.documentation));

    if (totalCount > 0 && input.offset >= totalCount) {
      ctx.enrich({ exhausted: true });
      notices.push(
        `Page is empty because offset ${input.offset} is past the end of ${totalCount} records. Lower offset or reset it to 0.`,
      );
    } else if (totalCount > input.offset + page.length) {
      const narrowing =
        input.month === undefined && input.granularity !== 'annualseasonal'
          ? 'datatypeId or month'
          : 'datatypeId';
      const guidance = `Showing records ${input.offset + 1}–${input.offset + page.length} of ${totalCount}. Raise offset to page forward, or narrow with ${narrowing}.`;
      ctx.enrich.truncated({ shown: page.length, cap: limit, guidance });
      notices.push(guidance);
    }
    if (notices.length > 0) ctx.enrich.notice(notices.join(' '));

    return { station, granularity: input.granularity, results: page };
  },

  format(result) {
    const lines = [`**Station:** ${result.station} | **Granularity:** ${result.granularity}`];
    if (result.results.length === 0) {
      lines.push('', '_No records on this page._');
      return [{ type: 'text', text: lines.join('\n') }];
    }
    lines.push(
      '',
      '| Date | Datatype | Value | Unit | Missing | Completeness | Years | Measurement flag |',
      '|:-----|:---------|------:|:-----|:--------|:-------------|------:|:-----------------|',
    );
    for (const record of result.results) {
      const value = `${record.value ?? ''}${record.valueText ? escapeMarkdownInline(record.valueText) : ''}`;
      lines.push(
        `| ${record.date ?? '—'} | ${record.datatype} | ${value} | ${record.unit ?? 'not labeled'} | ${record.missing ? 'missing=true' : ''} | ${record.completeness ?? ''} | ${record.years ?? ''} | ${record.measurementFlag ?? ''} |`,
      );
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});

/**
 * Why an empty answer may be the ID's case rather than the station, for an ID
 * written with a lowercase letter: NCEI matches station IDs case-sensitively,
 * and that ID went out uppercased or as written, either of which can miss.
 * About 290 of the stations with normals carry a mixed-case legacy CoCoRaHS ID
 * (293 in NCEI's monthly, daily, and annual/seasonal station lists: 291 US10,
 * one US1C, one US1P), and CDO's station lookup answers none of them, in either
 * case. Normalization only strips a `GHCND:` prefix and changes case, so the ID
 * as written is the input's last `station.length` characters.
 */
function stationCaseSentence(stationId: string, station: string): string | undefined {
  const written = stationId.trim().slice(-station.length);
  if (written === written.toUpperCase()) return;
  const treatment =
    written === station
      ? 'as written, because it mixes upper and lower case'
      : `uppercased, as ${station}, because it is written all in lowercase`;
  return `NCEI matches station IDs case-sensitively, and ${JSON.stringify(written)} was sent ${treatment}. Pass the ID exactly as noaa_climate_find_stations lists it; about 290 stations with normals carry a mixed-case legacy CoCoRaHS ID such as US10adam002, and noaa_climate_get_station cannot resolve those.`;
}

/** Page-local counts of missing values and non-standard completeness, and unlabeled units. */
function pageNotices(page: readonly NormalsRecord[], documentation: string): string[] {
  const notices: string[] = [];
  const missing = page.filter((record) => record.missing).length;
  if (missing > 0) {
    notices.push(
      `${missing} record(s) on this page carry NCEI's -9999 special value: missing=true and value is omitted.`,
    );
  }
  const qualified = page.filter(
    (record) => record.completeness && QUALIFIED_COMPLETENESS.has(record.completeness),
  ).length;
  if (qualified > 0) {
    notices.push(
      `${qualified} record(s) on this page have completeness R, P, or E rather than S: built from fewer than 24 years of data or estimated from nearby stations, so they are not standard 30-year normals.`,
    );
  }
  const unlabeled = [...new Set(page.filter((record) => !record.unit).map((r) => r.datatype))];
  if (unlabeled.length > 0) {
    notices.push(
      `No unit is labeled for ${unlabeled.join(', ')}; NCEI's documentation gives it: ${documentation}`,
    );
  }
  return notices;
}
