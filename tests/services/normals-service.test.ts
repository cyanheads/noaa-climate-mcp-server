/**
 * @fileoverview Tests for NormalsService — the request each granularity sends,
 * the projection of NCEI's padded string rows into records, the unit table, and
 * every failure class through the real retry loop: a 400 with and without
 * NCEI's JSON explanation, 404, 429, 5xx, a network failure, a 200 that is not
 * JSON rows, a hung upstream against the one call deadline, and caller
 * cancellation.
 * @module tests/services/normals-service.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  NORMALS_GRANULARITIES,
  NormalsService,
  unitFor,
} from '@/services/normals/normals-service.js';
import type { NormalsQuery } from '@/services/normals/types.js';
import {
  ANNUAL_DEFAULTS_JSON,
  ANNUAL_FROST_DATES_JSON,
  APACHE_404_HTML,
  DAILY_FEBRUARY_TAIL_JSON,
  hourlyJanuaryJson,
  MISSING_DATES_400_JSON,
  MONTHLY_DEFAULTS_JSON,
  MONTHLY_STDDEV_JANUARY_JSON,
  MONTHLY_UNKNOWN_DATATYPE_JSON,
  NO_ROWS_JSON,
  PRECIP_ONLY_MONTHLY_JSON,
  UNSUPPORTED_DATASET_400_JSON,
} from '../fixtures/normals.js';

const BASE = 'https://mock-ncei.test/access/services/data/v1';

const MONTHLY_DEFAULTS = [...NORMALS_GRANULARITIES.monthly.defaults];
const ANNUAL_DEFAULTS = [...NORMALS_GRANULARITIES.annualseasonal.defaults];

/** `withRetry`'s default `maxRetries: 3` plus the first attempt. */
const TOTAL_ATTEMPTS = 4;

/** Past the summed 1 s + 2 s + 4 s backoff (each at most +25% jitter). */
const BACKOFF_WINDOW_MS = 10_000;

const monthly = (overrides: Partial<NormalsQuery> = {}): NormalsQuery => ({
  station: 'USW00024233',
  granularity: 'monthly',
  datatypes: MONTHLY_DEFAULTS,
  ...overrides,
});

const json =
  (body: string, status = 200) =>
  () =>
    new Response(body, { status, headers: { 'Content-Type': 'application/json' } });

const html = (body: string, status: number) => () =>
  new Response(body, { status, headers: { 'Content-Type': 'text/html' } });

/** Serve every request from `respond`, so each attempt gets a fresh body. */
function serve(respond: () => Response) {
  const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => respond());
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** The URL of the `index`th request the service sent. */
function sentUrl(fetchMock: ReturnType<typeof serve>, index = 0): URL {
  const call = fetchMock.mock.calls[index];
  if (!call)
    throw new Error(
      `Expected request ${index}, but only ${fetchMock.mock.calls.length} were sent.`,
    );
  return new URL(String(call[0]));
}

/** Await a call that must reject, with the backoff clock wound forward, and hand back its error. */
async function rejection(run: () => Promise<unknown>, advanceMs = 0): Promise<McpError> {
  const settled = run().then(
    () => undefined,
    (error: unknown) => error,
  );
  if (advanceMs > 0) await vi.advanceTimersByTimeAsync(advanceMs);
  const error = await settled;
  if (error instanceof McpError) return error;
  throw new Error(`Expected an McpError, got: ${String(error)}`);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('NormalsService — the request', () => {
  it.each([
    ['monthly', undefined, undefined],
    ['monthly', 2, ['2020-02-01', '2020-02-29']],
    ['daily', undefined, ['2020-01-01', '2020-12-31']],
    ['daily', 2, ['2020-02-01', '2020-02-29']],
    ['daily', 4, ['2020-04-01', '2020-04-30']],
    ['daily', 12, ['2020-12-01', '2020-12-31']],
    ['hourly', 1, ['2020-01-01', '2020-01-31']],
    ['annualseasonal', undefined, undefined],
  ] as const)('%s with month %s sends window %j', async (granularity, month, window) => {
    const fetchMock = serve(json(NO_ROWS_JSON));
    const spec = NORMALS_GRANULARITIES[granularity];
    await new NormalsService(BASE).getNormals(
      {
        station: 'USW00024233',
        granularity,
        datatypes: spec.defaults,
        ...(month !== undefined && { month }),
      },
      createMockContext(),
    );

    const url = sentUrl(fetchMock);
    expect(`${url.origin}${url.pathname}`).toBe(BASE);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      dataset: spec.dataset,
      stations: 'USW00024233',
      dataTypes: spec.defaults.join(','),
      ...(window && { startDate: window[0], endDate: window[1] }),
      includeAttributes: 'true',
      format: 'json',
    });
    expect(url.searchParams.has('units')).toBe(false);
  });

  it('names every requested datatype, in request order, on the wire', async () => {
    const fetchMock = serve(json(NO_ROWS_JSON));
    await new NormalsService(BASE).getNormals(
      monthly({ datatypes: ['MLY-PRCP-NORMAL', 'MLY-TAVG-NORMAL', 'MLY-HTDD-NORMAL'] }),
      createMockContext(),
    );
    expect(sentUrl(fetchMock).searchParams.get('dataTypes')).toBe(
      'MLY-PRCP-NORMAL,MLY-TAVG-NORMAL,MLY-HTDD-NORMAL',
    );
  });
});

describe('NormalsService — projection', () => {
  it('splits the monthly defaults into 60 records ordered by date, then requested datatype', async () => {
    serve(json(MONTHLY_DEFAULTS_JSON));
    const result = await new NormalsService(BASE).getNormals(monthly(), createMockContext());

    expect(result).toMatchObject({
      dataset: 'normals-monthly-1991-2020',
      rowCount: 12,
      unmatchedDatatypes: [],
    });
    expect(result.records).toHaveLength(60);
    expect(result.records.map((record) => `${record.date} ${record.datatype}`).slice(0, 6)).toEqual(
      [
        '01 MLY-TAVG-NORMAL',
        '01 MLY-TMAX-NORMAL',
        '01 MLY-TMIN-NORMAL',
        '01 MLY-PRCP-NORMAL',
        '01 MLY-SNOW-NORMAL',
        '02 MLY-TAVG-NORMAL',
      ],
    );
    expect(result.records.at(-1)).toMatchObject({ date: '12', datatype: 'MLY-SNOW-NORMAL' });
    expect(result.records[0]).toEqual({
      date: '01',
      datatype: 'MLY-TAVG-NORMAL',
      value: 42.8,
      unit: '°F',
      completeness: 'S',
      years: 27,
    });
    expect(result.records[3]).toEqual({
      date: '01',
      datatype: 'MLY-PRCP-NORMAL',
      value: 5.78,
      unit: 'in',
      completeness: 'S',
      years: 30,
    });
    expect(result.records[4]).toEqual({
      date: '01',
      datatype: 'MLY-SNOW-NORMAL',
      value: 1.8,
      unit: 'in',
      completeness: 'P',
      years: 18,
    });
  });

  it('orders by date when the service returns rows out of order, and keeps request order within a row', async () => {
    const reversed = JSON.stringify([...JSON.parse(MONTHLY_DEFAULTS_JSON)].reverse());
    serve(json(reversed));
    const result = await new NormalsService(BASE).getNormals(
      monthly({ datatypes: ['MLY-SNOW-NORMAL', 'MLY-TAVG-NORMAL'] }),
      createMockContext(),
    );
    expect(result.records.map((record) => `${record.date} ${record.datatype}`).slice(0, 4)).toEqual(
      ['01 MLY-SNOW-NORMAL', '01 MLY-TAVG-NORMAL', '02 MLY-SNOW-NORMAL', '02 MLY-TAVG-NORMAL'],
    );
  });

  it('orders hourly keys by calendar hour across days', async () => {
    const rows = JSON.parse(hourlyJanuaryJson()) as Record<string, string>[];
    serve(json(JSON.stringify([rows[743], rows[24], rows[0], rows[23]])));
    const result = await new NormalsService(BASE).getNormals(
      {
        station: 'USW00024233',
        granularity: 'hourly',
        datatypes: ['HLY-TEMP-NORMAL'],
        month: 1,
      },
      createMockContext(),
    );
    expect(result.records.map((record) => record.date)).toEqual([
      '01-01T00:00:00',
      '01-01T23:00:00',
      '01-02T00:00:00',
      '01-31T23:00:00',
    ]);
  });

  it('carries no date on the annual/seasonal row', async () => {
    serve(json(ANNUAL_DEFAULTS_JSON));
    const result = await new NormalsService(BASE).getNormals(
      { station: 'USW00024233', granularity: 'annualseasonal', datatypes: ANNUAL_DEFAULTS },
      createMockContext(),
    );
    expect(result.records).toEqual([
      { datatype: 'ANN-TAVG-NORMAL', value: 53.7, unit: '°F', completeness: 'S', years: 25 },
      { datatype: 'ANN-TMAX-NORMAL', value: 61.3, unit: '°F', completeness: 'S', years: 30 },
      { datatype: 'ANN-TMIN-NORMAL', value: 46.1, unit: '°F', completeness: 'S', years: 25 },
      { datatype: 'ANN-PRCP-NORMAL', value: 39.34, unit: 'in', completeness: 'S', years: 29 },
      { datatype: 'ANN-SNOW-NORMAL', value: 6.3, unit: 'in', completeness: 'P', years: 17 },
    ]);
  });

  it('reads -9999 as missing with no value, keeping its M flag and blank completeness omitted', async () => {
    serve(json(DAILY_FEBRUARY_TAIL_JSON));
    const result = await new NormalsService(BASE).getNormals(
      {
        station: 'USW00024233',
        granularity: 'daily',
        datatypes: ['DLY-TMAX-NORMAL', 'MTD-PRCP-NORMAL'],
        month: 2,
      },
      createMockContext(),
    );
    const leapDay = result.records.filter((record) => record.date === '02-29');
    expect(leapDay).toEqual([
      {
        date: '02-29',
        datatype: 'DLY-TMAX-NORMAL',
        value: 51.9,
        unit: '°F',
        completeness: 'S',
        years: 30,
      },
      {
        date: '02-29',
        datatype: 'MTD-PRCP-NORMAL',
        missing: true,
        unit: 'in',
        years: 0,
        measurementFlag: 'M',
      },
    ]);
    expect(leapDay[1]).not.toHaveProperty('value');
    expect(leapDay[1]).not.toHaveProperty('completeness');
  });

  it('keeps a value NCEI writes as text, and a padded -9999.0, apart from numbers', async () => {
    serve(json(ANNUAL_FROST_DATES_JSON));
    const result = await new NormalsService(BASE).getNormals(
      {
        station: 'USW00024233',
        granularity: 'annualseasonal',
        datatypes: ['ANN-TMIN-PRBLST-T32FP50', 'ANN-TMIN-PRBFST-T16FP10'],
      },
      createMockContext(),
    );
    expect(result.records).toEqual([
      { datatype: 'ANN-TMIN-PRBLST-T32FP50', valueText: '03/02' },
      { datatype: 'ANN-TMIN-PRBFST-T16FP10', missing: true },
    ]);
  });

  it('labels no unit for a datatype outside the verified table', async () => {
    serve(json(MONTHLY_STDDEV_JANUARY_JSON));
    const result = await new NormalsService(BASE).getNormals(
      monthly({ datatypes: ['MLY-TAVG-STDDEV'] }),
      createMockContext(),
    );
    expect(result.records).toEqual([
      { date: '01', datatype: 'MLY-TAVG-STDDEV', value: 2.8, completeness: 'S', years: 27 },
    ]);
  });

  it('names a requested datatype no row carries while returning the rest', async () => {
    serve(json(MONTHLY_UNKNOWN_DATATYPE_JSON));
    const result = await new NormalsService(BASE).getNormals(
      monthly({ datatypes: ['MLY-TAVG-NORMAL', 'MLY-FAKE-NORMAL'] }),
      createMockContext(),
    );
    expect(result.unmatchedDatatypes).toEqual(['MLY-FAKE-NORMAL']);
    expect(result.records).toHaveLength(12);
    expect(new Set(result.records.map((record) => record.datatype))).toEqual(
      new Set(['MLY-TAVG-NORMAL']),
    );
  });

  it('names the temperature datatype a precipitation-only station lacks', async () => {
    serve(json(PRECIP_ONLY_MONTHLY_JSON));
    const result = await new NormalsService(BASE).getNormals(
      monthly({ station: 'US1WAKG0005', datatypes: ['MLY-TAVG-NORMAL', 'MLY-PRCP-NORMAL'] }),
      createMockContext(),
    );
    expect(result.unmatchedDatatypes).toEqual(['MLY-TAVG-NORMAL']);
    expect(result.records[0]).toEqual({
      date: '01',
      datatype: 'MLY-PRCP-NORMAL',
      value: 5.57,
      unit: 'in',
      completeness: 'E',
      years: 12,
    });
    expect(result.records.every((record) => record.completeness === 'E')).toBe(true);
  });

  it('answers an empty array with no records and every datatype unmatched', async () => {
    serve(json(NO_ROWS_JSON));
    const result = await new NormalsService(BASE).getNormals(monthly(), createMockContext());
    expect(result).toEqual({
      dataset: 'normals-monthly-1991-2020',
      records: [],
      rowCount: 0,
      unmatchedDatatypes: MONTHLY_DEFAULTS,
    });
  });
});

describe('unitFor', () => {
  it.each(Object.entries(NORMALS_GRANULARITIES))(
    'labels every %s default',
    (_granularity, spec) => {
      for (const datatype of spec.defaults) expect(unitFor(datatype), datatype).toBeDefined();
    },
  );

  it.each([
    ['MLY-TAVG-NORMAL', '°F'],
    ['DJF-TMIN-NORMAL', '°F'],
    ['HLY-DEWP-NORMAL', '°F'],
    ['MTD-PRCP-NORMAL', 'in'],
    ['YTD-SNOW-NORMAL', 'in'],
    ['ANN-PRCP-NORMAL', 'in'],
    ['MLY-HTDD-NORMAL', '°F-days'],
    ['DLY-CLDD-NORMAL', '°F-days'],
    // NCEI's hourly documentation says inches of mercury; live values read 1004.2–1028.7 hPa at three stations.
    ['HLY-PRES-NORMAL', 'hPa'],
    ['HLY-PRES-10PCTL', 'hPa'],
    ['HLY-PRES-90PCTL', 'hPa'],
  ])('labels %s as %s', (datatype, unit) => {
    expect(unitFor(datatype)).toBe(unit);
  });

  it.each([
    'MLY-TAVG-STDDEV',
    'HLY-WIND-AVGSPD',
    'HLY-TEMP-10PCTL',
    'ANN-TMIN-PRBFST-T16FP10',
    'DLY-PRCP-PCTALL-GE001HI',
    'MLY-TMAX-AVGNDS-GRTH090',
    'XMLY-TAVG-NORMAL',
    'MLY-TAVG-NORMALX',
  ])('leaves %s unlabeled', (datatype) => {
    expect(unitFor(datatype)).toBeUndefined();
  });
});

describe('NormalsService — an upstream rejection (HTTP 400)', () => {
  it("carries NCEI's errors[].message and is not retried", async () => {
    const fetchMock = serve(json(MISSING_DATES_400_JSON, 400));
    const error = await rejection(() =>
      new NormalsService(BASE).getNormals(
        { station: 'USW00024233', granularity: 'daily', datatypes: ['DLY-TAVG-NORMAL'] },
        createMockContext(),
      ),
    );
    expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(error.message).toBe(
      'The NCEI Access Data Service rejected the request (HTTP 400): A start date is required. An end date is required.',
    );
    expect(error.data).toMatchObject({
      status: 400,
      upstreamMessage: 'A start date is required. An end date is required.',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('carries a one-field rejection verbatim', async () => {
    serve(json(UNSUPPORTED_DATASET_400_JSON, 400));
    const error = await rejection(() =>
      new NormalsService(BASE).getNormals(monthly(), createMockContext()),
    );
    expect(error.message).toBe(
      'The NCEI Access Data Service rejected the request (HTTP 400): Unsupported dataset.',
    );
  });

  it('falls back to the operation and status when the 400 body is not NCEI JSON', async () => {
    serve(
      html(
        '<!DOCTYPE HTML PUBLIC "-//IETF//DTD HTML 2.0//EN">\n<html><head>\n<title>400 Bad Request</title>\n</head><body></body></html>\n',
        400,
      ),
    );
    const error = await rejection(() =>
      new NormalsService(BASE).getNormals(monthly(), createMockContext()),
    );
    expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(error.message).toBe(
      'NCEI Access Data Service normals request returned HTTP 400 (400 Bad Request).',
    );
    expect(error.data).not.toHaveProperty('upstreamMessage');
  });
});

describe('NormalsService — transient failures through the real retry loop', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it.each([
    [
      'a 503 error page',
      html(
        '<!DOCTYPE html><html><head><title>503 Service Unavailable</title></head><body></body></html>',
        503,
      ),
      JsonRpcErrorCode.ServiceUnavailable,
      'returned HTTP 503 (503 Service Unavailable)',
    ],
    [
      "NCEI's documented 500 body",
      json(
        '{"errorMessage":"An unexpected error occurred while servicing your request.","errorCode":500}',
        500,
      ),
      JsonRpcErrorCode.ServiceUnavailable,
      'returned HTTP 500',
    ],
    ['a 429', json('{}', 429), JsonRpcErrorCode.RateLimited, 'returned HTTP 429'],
    [
      'a 504 gateway page',
      html(
        '<!DOCTYPE html><html><head><title>504 Gateway Time-out</title></head><body></body></html>',
        504,
      ),
      JsonRpcErrorCode.Timeout,
      'returned HTTP 504 (504 Gateway Time-out)',
    ],
    [
      'an HTML page on HTTP 200',
      html(APACHE_404_HTML, 200),
      JsonRpcErrorCode.ServiceUnavailable,
      'returned an HTML page instead of JSON',
    ],
    [
      'a body that is not JSON on HTTP 200',
      json('Service temporarily unavailable'),
      JsonRpcErrorCode.ServiceUnavailable,
      'returned a response that is not a JSON array of rows',
    ],
  ])(
    'retries %s, then fails with its code and the operation named',
    async (_label, respond, code, phrase) => {
      const fetchMock = serve(respond);
      const error = await rejection(
        () => new NormalsService(BASE).getNormals(monthly(), createMockContext()),
        BACKOFF_WINDOW_MS,
      );
      expect(error.code).toBe(code);
      expect(error.message).toContain(phrase);
      expect(error.message).not.toMatch(/[<>]/);
      expect(error.message).not.toContain('https://');
      expect(fetchMock).toHaveBeenCalledTimes(TOTAL_ATTEMPTS);
    },
  );

  it('retries a network failure as ServiceUnavailable without naming the URL', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    vi.stubGlobal('fetch', fetchMock);
    const error = await rejection(
      () => new NormalsService(BASE).getNormals(monthly(), createMockContext()),
      BACKOFF_WINDOW_MS,
    );
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.message).toContain('NCEI Access Data Service normals request');
    expect(error.message).not.toContain('https://');
    expect(fetchMock).toHaveBeenCalledTimes(TOTAL_ATTEMPTS);
  });

  it('recovers when a later attempt answers with rows', async () => {
    let attempt = 0;
    const fetchMock = serve(() =>
      attempt++ === 0
        ? html('<html><title>502</title></html>', 502)()
        : json(MONTHLY_DEFAULTS_JSON)(),
    );
    const pending = new NormalsService(BASE).getNormals(monthly(), createMockContext());
    await vi.advanceTimersByTimeAsync(BACKOFF_WINDOW_MS);
    const result = await pending;
    expect(result.records).toHaveLength(60);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('fails a JSON body that is not an array of rows at once — the service answered, and will answer the same', async () => {
    const fetchMock = serve(json('{"errorCode":500,"errorMessage":"Unexpected"}'));
    const error = await rejection(
      () => new NormalsService(BASE).getNormals(monthly(), createMockContext()),
      BACKOFF_WINDOW_MS,
    );
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.message).toContain('not a JSON array of rows');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('fails a row holding a non-string cell at once', async () => {
    const fetchMock = serve(json('[{"DATE":"01","MLY-TAVG-NORMAL":42.8}]'));
    const error = await rejection(
      () => new NormalsService(BASE).getNormals(monthly(), createMockContext()),
      BACKOFF_WINDOW_MS,
    );
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('settles a hung upstream as a classified Timeout at the 45 s call deadline, inside a 60 s client timeout', async () => {
    const fetchMock = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
            once: true,
          });
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const outcome = new NormalsService(BASE).getNormals(monthly(), createMockContext()).then(
      () => 'resolved',
      (error: unknown) => error,
    );
    const PENDING = Symbol('pending');
    const current = () => Promise.race([outcome, Promise.resolve(PENDING)]);

    // Each attempt is cut at 20 s: the first is retried rather than left to hang.
    await vi.advanceTimersByTimeAsync(19_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_300);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(44_900 - 21_299);
    expect(await current()).toBe(PENDING);
    await vi.advanceTimersByTimeAsync(200);

    const error = await current();
    expect(error).toBeInstanceOf(McpError);
    if (!(error instanceof McpError)) return;
    expect(error.code).toBe(JsonRpcErrorCode.Timeout);
    expect(error.data).toMatchObject({ reason: 'retry_deadline_exceeded', deadlineMs: 45_000 });
    expect(error.message).toBe(
      'NCEI Access Data Service normals request exceeded its 45000ms retry deadline after 3 attempts.',
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe('NormalsService — other upstream answers', () => {
  it('reports an Apache 404 by its title, never its markup', async () => {
    const fetchMock = serve(html(APACHE_404_HTML, 404));
    const error = await rejection(() =>
      new NormalsService(BASE).getNormals(monthly(), createMockContext()),
    );
    expect(error.code).toBe(JsonRpcErrorCode.NotFound);
    expect(error.message).toBe(
      'NCEI Access Data Service normals request returned HTTP 404 (404 Not Found).',
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('stops on caller cancellation without retrying or relabelling it', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
            once: true,
          });
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const pending = rejection(() =>
      new NormalsService(BASE).getNormals(
        monthly(),
        createMockContext({ signal: controller.signal }),
      ),
    );
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    controller.abort();
    const error = await pending;
    expect(error.code).toBe(JsonRpcErrorCode.RequestCancelled);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
