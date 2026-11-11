/**
 * @fileoverview NCEI Access Data Service client for one station's 1991–2020
 * U.S. Climate Normals — monthly, daily, hourly, or annual/seasonal. Keyless.
 * @module services/normals/normals-service
 */

import { type Context, z } from '@cyanheads/mcp-ts-core';
import { McpError, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { fetchWithTimeout, requestContextService, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { explainUpstreamFailure, isHtmlPage } from '@/services/upstream-failure.js';
import type { NormalsGranularity, NormalsQuery, NormalsRecord, NormalsResult } from './types.js';

const BASE_URL = 'https://www.ncei.noaa.gov/access/services/data/v1';

/** The largest legal request — every hourly datatype for one month — is 2.4 MB in about 1 s. */
const ATTEMPT_TIMEOUT_MS = 20_000;

/**
 * One budget for the whole call: every attempt, every backoff. An MCP SDK
 * client gives up on a request at 60 s, so a hung upstream has to settle as
 * this server's classified `Timeout` before then rather than as a transport
 * timeout the caller cannot read.
 */
const DEADLINE_MS = 45_000;

/**
 * The request as a caller reads it: every failure message names it, the retry
 * deadline's included ("… exceeded its 45000ms retry deadline after 3
 * attempts."). The request context keeps the `normals.get` key for logs.
 */
const OPERATION = 'NCEI Access Data Service normals request';

/**
 * What each granularity reads, and what a caller may ask of it.
 *
 * `prefixes` are every datatype prefix the dataset carries (from NCEI's
 * station files); the service answers any other ID with HTTP 200 and the column
 * silently absent, so the tool holds requests to these before sending them.
 * `defaults` are always sent explicitly: the service's own default column set
 * for the monthly product leaves out `MLY-TAVG-NORMAL`. Daily has no
 * precipitation default because its precipitation normals are month-to-date and
 * year-to-date accumulations or probabilities, none of which reads as "the
 * normal for this day".
 */
export const NORMALS_GRANULARITIES = {
  monthly: {
    dataset: 'normals-monthly-1991-2020',
    prefixes: ['MLY'],
    defaults: [
      'MLY-TAVG-NORMAL',
      'MLY-TMAX-NORMAL',
      'MLY-TMIN-NORMAL',
      'MLY-PRCP-NORMAL',
      'MLY-SNOW-NORMAL',
    ],
    documentation:
      'https://www.ncei.noaa.gov/data/normals-monthly/1991-2020/doc/Normals_MLY_Documentation_1991-2020.pdf',
  },
  daily: {
    dataset: 'normals-daily-1991-2020',
    prefixes: ['DLY', 'MTD', 'YTD'],
    defaults: ['DLY-TAVG-NORMAL', 'DLY-TMAX-NORMAL', 'DLY-TMIN-NORMAL'],
    documentation:
      'https://www.ncei.noaa.gov/data/normals-daily/1991-2020/doc/Normals_DLY_Documentation_1991-2020.pdf',
  },
  hourly: {
    dataset: 'normals-hourly-1991-2020',
    prefixes: ['HLY'],
    defaults: ['HLY-TEMP-NORMAL', 'HLY-DEWP-NORMAL'],
    documentation:
      'https://www.ncei.noaa.gov/data/normals-hourly/1991-2020/doc/Normals_HLY_Documentation_1991-2020.pdf',
  },
  annualseasonal: {
    dataset: 'normals-annualseasonal-1991-2020',
    prefixes: ['ANN', 'DJF', 'MAM', 'JJA', 'SON'],
    defaults: [
      'ANN-TAVG-NORMAL',
      'ANN-TMAX-NORMAL',
      'ANN-TMIN-NORMAL',
      'ANN-PRCP-NORMAL',
      'ANN-SNOW-NORMAL',
    ],
    documentation:
      'https://www.ncei.noaa.gov/data/normals-annualseasonal/1991-2020/doc/Normals_ANN_Documentation_1991-2020.pdf',
  },
} as const satisfies Record<
  NormalsGranularity,
  {
    dataset: string;
    prefixes: readonly string[];
    defaults: readonly string[];
    documentation: string;
  }
>;

/**
 * Native units, for the datatypes whose unit was checked against live values.
 *
 * The service's own `units` conversion is wrong for several datatypes (monthly
 * average temperature stays in °F, degree days get a temperature offset), so
 * values are never converted and only labeled. A datatype outside this table
 * gets no `unit` rather than a guess — standard deviations, ranges, percentiles,
 * counts, and probabilities each have their own unit in NCEI's documentation.
 * Hourly sea-level pressure is labeled because that documentation is wrong for
 * it: it says inches of mercury, and the values arrive in hPa (1017.7 at
 * USW00024233, 1012.7 at AQW00061705, 1011.0 at USW00003017, whose station
 * pressure would read near 840), so the documentation link the notice gives
 * for unlabeled units would mislead.
 */
const UNITS: readonly (readonly [RegExp, string])[] = [
  [/^(?:MLY|DLY|ANN|DJF|MAM|JJA|SON)-(?:TAVG|TMAX|TMIN)-NORMAL$/, '°F'],
  [/^HLY-(?:TEMP|DEWP)-NORMAL$/, '°F'],
  [/^HLY-PRES-(?:NORMAL|10PCTL|90PCTL)$/, 'hPa'],
  [/^(?:MLY|MTD|YTD|ANN|DJF|MAM|JJA|SON)-(?:PRCP|SNOW)-NORMAL$/, 'in'],
  [/^(?:MLY|DLY|ANN|DJF|MAM|JJA|SON)-(?:HTDD|CLDD)-NORMAL$/, '°F-days'],
];

/** The native unit of a datatype, or `undefined` when it has not been verified. */
export function unitFor(datatype: string): string | undefined {
  return UNITS.find(([pattern]) => pattern.test(datatype))?.[1];
}

/** NCEI's special value for a normal it could not compute. */
const MISSING_VALUE = -9999;

/** Rows are flat objects of strings — every value, flag, and year count left-padded. */
const RowsSchema = z.array(z.record(z.string(), z.string()));

/** The JSON body NCEI sends with a 400: one entry per rejected parameter. */
const RejectionSchema = z.object({ errors: z.array(z.object({ message: z.string() })).min(1) });

/**
 * The service's own explanation of a 400, read from the body `fetchWithTimeout`
 * captured server-side.
 *
 * That capture never reaches a client envelope, so the messages are carried in
 * the error message instead — "A start date is required.", "Unsupported
 * dataset." — which is the one part a caller can act on.
 */
function rejectionMessages(body: unknown): string | undefined {
  if (typeof body !== 'string') return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    // A body clipped at the capture budget, or not JSON at all: no message to read.
    return;
  }
  const result = RejectionSchema.safeParse(parsed);
  return result.success ? result.data.errors.map((entry) => entry.message).join(' ') : undefined;
}

function explainNormalsFailure(error: unknown): unknown {
  if (error instanceof McpError && error.data?.status === 400) {
    const messages = rejectionMessages(error.data.body);
    if (messages) {
      return new McpError(
        error.code,
        `The NCEI Access Data Service rejected the request (HTTP 400): ${messages}`,
        { ...error.data, upstreamMessage: messages },
        { cause: error },
      );
    }
  }
  return explainUpstreamFailure(error, OPERATION);
}

/**
 * The month-day window that narrows a dataset to one month.
 *
 * The service matches month and day and ignores the year, but the window must
 * not wrap and its end must be a real date. 2020 is a leap year, so February
 * ends on the 29th and the daily product's `02-29` row is included.
 */
function monthWindow(month: number): { startDate: string; endDate: string } {
  const mm = String(month).padStart(2, '0');
  const lastDay = new Date(Date.UTC(2020, month, 0)).getUTCDate();
  return { startDate: `2020-${mm}-01`, endDate: `2020-${mm}-${lastDay}` };
}

/**
 * Daily and hourly answer HTTP 400 without dates; monthly honors a window when
 * one is sent; annual/seasonal has no month axis at all.
 */
function dateWindow(query: NormalsQuery): { startDate: string; endDate: string } | undefined {
  if (query.granularity === 'annualseasonal') return;
  if (query.month !== undefined) return monthWindow(query.month);
  if (query.granularity === 'daily') return { startDate: '2020-01-01', endDate: '2020-12-31' };
  return;
}

/** The request URL. `units` is never sent: the service's conversion is wrong for several datatypes. */
function buildNormalsUrl(query: NormalsQuery, baseUrl: string): string {
  const params = new URLSearchParams({
    dataset: NORMALS_GRANULARITIES[query.granularity].dataset,
    stations: query.station,
    dataTypes: query.datatypes.join(','),
  });
  const window = dateWindow(query);
  if (window) {
    params.set('startDate', window.startDate);
    params.set('endDate', window.endDate);
  }
  params.set('includeAttributes', 'true');
  params.set('format', 'json');
  return `${baseUrl}?${params}`;
}

/** A trimmed attribute cell, or `undefined` when blank. */
function cellText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** Turn one datatype's cell and its three attribute cells into a record, or nothing for a blank cell. */
function projectValue(
  row: Record<string, string>,
  datatype: string,
): Omit<NormalsRecord, 'date'> | undefined {
  const raw = cellText(row[datatype]);
  if (raw === undefined) return;
  const parsed = Number(raw);
  const unit = unitFor(datatype);
  const completeness = cellText(row[`comp_flag_${datatype}`]);
  const yearsText = cellText(row[`years_${datatype}`]);
  const years = yearsText === undefined ? undefined : Number(yearsText);
  const measurementFlag = cellText(row[`meas_flag_${datatype}`]);
  return {
    datatype,
    ...(parsed === MISSING_VALUE
      ? { missing: true as const }
      : Number.isFinite(parsed)
        ? { value: parsed }
        : { valueText: raw }),
    ...(unit && { unit }),
    ...(completeness && { completeness }),
    ...(years !== undefined && Number.isInteger(years) && { years }),
    ...(measurementFlag && { measurementFlag }),
  };
}

/**
 * Parse the 200 body: a JSON array of rows, or a service that is not serving data.
 *
 * A body that is not JSON at all — a gateway or maintenance page — is retried.
 * JSON in the wrong shape is the service's own answer and would come back the
 * same, so it fails on the first attempt.
 */
function parseRows(text: string): Record<string, string>[] {
  const fault = isHtmlPage(text)
    ? 'an HTML page instead of JSON'
    : 'a response that is not a JSON array of rows';
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw serviceUnavailable(`The NCEI Access Data Service returned ${fault}.`, undefined, {
      cause,
    });
  }
  const rows = RowsSchema.safeParse(parsed);
  if (!rows.success) {
    throw serviceUnavailable(
      `The NCEI Access Data Service returned ${fault}.`,
      { retryable: false },
      { cause: rows.error },
    );
  }
  return rows.data;
}

export class NormalsService {
  private readonly baseUrl: string;

  constructor(baseUrl = BASE_URL) {
    this.baseUrl = baseUrl;
  }

  /** Fetch one station's normals and split each row into one record per requested datatype. */
  async getNormals(query: NormalsQuery, ctx: Context): Promise<NormalsResult> {
    const url = buildNormalsUrl(query, this.baseUrl);
    const retryCtx = requestContextService.createRequestContext({
      operation: 'normals.get',
      parentContext: ctx,
    });

    const rows = await withRetry(
      async ({ signal, remainingMs }) => {
        ctx.log.debug('NCEI normals request', { url });
        let text: string;
        try {
          const response = await fetchWithTimeout(
            url,
            Math.min(ATTEMPT_TIMEOUT_MS, remainingMs),
            retryCtx,
            { signal },
          );
          text = await response.text();
        } catch (error) {
          throw explainNormalsFailure(error);
        }
        return parseRows(text);
      },
      {
        operation: OPERATION,
        context: retryCtx,
        baseDelayMs: 1000,
        signal: ctx.signal,
        deadlineMs: DEADLINE_MS,
      },
    );

    // Lexical order is calendar order for every key form ("01", "01-31", "01-01T00:00:00").
    const ordered = [...rows].sort((a, b) => (a.DATE ?? '').localeCompare(b.DATE ?? ''));
    const carried = new Set<string>();
    const records: NormalsRecord[] = [];
    for (const row of ordered) {
      const date = cellText(row.DATE);
      for (const datatype of query.datatypes) {
        const record = projectValue(row, datatype);
        if (!record) continue;
        carried.add(datatype);
        records.push(date === undefined ? record : { date, ...record });
      }
    }

    return {
      dataset: NORMALS_GRANULARITIES[query.granularity].dataset,
      records,
      rowCount: rows.length,
      unmatchedDatatypes: query.datatypes.filter((datatype) => !carried.has(datatype)),
    };
  }
}

// --- Init/accessor pattern ---

let _service: NormalsService | undefined;

export function initNormalsService(): void {
  _service = new NormalsService();
}

export function getNormalsService(): NormalsService {
  if (!_service) {
    throw new Error('NormalsService not initialized — call initNormalsService() in setup()');
  }
  return _service;
}
