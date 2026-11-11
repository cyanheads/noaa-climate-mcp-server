/**
 * @fileoverview Tests for the noaa_climate_get_normals tool on the real
 * NormalsService, with `fetch` stubbed at the network boundary and every call
 * read back through the framework's contract runner — both surfaces
 * (`structuredContent` and `content[]`), the declared error reasons, and the
 * boundaries: no rows, a requested datatype no row carries, the page cap, an
 * offset past the end, and rejected input.
 * @module tests/tools/noaa-climate-get-normals.tool.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { noaaClimateGetNormals } from '@/mcp-server/tools/definitions/noaa-climate-get-normals.tool.js';
import { initNormalsService, NORMALS_GRANULARITIES } from '@/services/normals/normals-service.js';
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
} from '../fixtures/normals.js';
import { contractFailure } from '../helpers/contract-failure.js';
import { expectLinearCpu } from '../helpers/linear-cpu.js';

const ADS = 'https://www.ncei.noaa.gov/access/services/data/v1';

/** Past the summed 1 s + 2 s + 4 s retry backoff, each at most +25% jitter. */
const BACKOFF_WINDOW_MS = 10_000;

/** What a client reads off `structuredContent`: the output plus every enrichment field, nothing else. */
const Wire = noaaClimateGetNormals.output
  .extend({
    totalCount: z.number(),
    effectiveQuery: z.string(),
    notice: z.string().optional(),
    truncated: z.boolean().optional(),
    shown: z.number().optional(),
    cap: z.number().optional(),
    exhausted: z.boolean().optional(),
  })
  .strict();

const json =
  (body: string, status = 200) =>
  () =>
    new Response(body, { status, headers: { 'Content-Type': 'application/json' } });

const html = (body: string, status: number) => () =>
  new Response(body, { status, headers: { 'Content-Type': 'text/html' } });

/** Answer every request NCEI's Access Data Service would get with `respond`. */
function serve(respond: (url: URL) => Response) {
  const fetchMock = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
    const url = new URL(String(input));
    if (`${url.origin}${url.pathname}` !== ADS) throw new Error(`Unexpected request to ${url}`);
    return respond(url);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** The query parameters of the only request the call sent. */
function sentParams(fetchMock: ReturnType<typeof serve>): Record<string, string> {
  expect(fetchMock).toHaveBeenCalledTimes(1);
  return Object.fromEntries(new URL(String(fetchMock.mock.calls[0]?.[0])).searchParams);
}

const textOf = (content: { type: string; text?: string }[]) =>
  content.map((block) => (block.type === 'text' ? block.text : '')).join('\n');

/** Run a successful call through the contract runner and read back both surfaces. */
async function call(input: z.input<typeof noaaClimateGetNormals.input>) {
  const response = await runToolContract(noaaClimateGetNormals, input);
  expect(response.isError, textOf(response.content)).not.toBe(true);
  return { structured: Wire.parse(response.structuredContent), text: textOf(response.content) };
}

/** A failed call's envelope, with the retry backoff wound forward under fake timers. */
async function failureAfterRetries(input: Record<string, unknown>) {
  const pending = contractFailure(noaaClimateGetNormals, input);
  await vi.advanceTimersByTimeAsync(BACKOFF_WINDOW_MS);
  return pending;
}

const SEA_TAC = { stationId: 'USW00024233' };

beforeEach(() => {
  initNormalsService();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('monthly defaults', () => {
  it('return 60 records ordered by date, then requested datatype, on both surfaces', async () => {
    serve(json(MONTHLY_DEFAULTS_JSON));
    const { structured, text } = await call({ ...SEA_TAC, granularity: 'monthly' });

    expect(structured.station).toBe('USW00024233');
    expect(structured.granularity).toBe('monthly');
    expect(structured.totalCount).toBe(60);
    expect(structured.results).toHaveLength(60);
    expect(structured.results.map((r) => `${r.date} ${r.datatype}`).slice(0, 6)).toEqual([
      '01 MLY-TAVG-NORMAL',
      '01 MLY-TMAX-NORMAL',
      '01 MLY-TMIN-NORMAL',
      '01 MLY-PRCP-NORMAL',
      '01 MLY-SNOW-NORMAL',
      '02 MLY-TAVG-NORMAL',
    ]);
    expect(structured.results[0]).toEqual({
      date: '01',
      datatype: 'MLY-TAVG-NORMAL',
      value: 42.8,
      unit: '°F',
      completeness: 'S',
      years: 27,
    });
    expect(structured.results[3]).toMatchObject({
      datatype: 'MLY-PRCP-NORMAL',
      value: 5.78,
      unit: 'in',
    });
    expect(structured.effectiveQuery).toBe(
      'dataset=normals-monthly-1991-2020, station=USW00024233, datatypes=[MLY-TAVG-NORMAL, MLY-TMAX-NORMAL, MLY-TMIN-NORMAL, MLY-PRCP-NORMAL, MLY-SNOW-NORMAL]',
    );
    expect(structured.truncated).toBeUndefined();

    const tableRows = text.split('\n').filter((line) => /^\| \d\d \|/.test(line));
    expect(tableRows).toHaveLength(60);
    expect(tableRows[0]).toBe('| 01 | MLY-TAVG-NORMAL | 42.8 | °F |  | S | 27 |  |');
    expect(tableRows[3]).toBe('| 01 | MLY-PRCP-NORMAL | 5.78 | in |  | S | 30 |  |');
    expect(text).toContain(structured.effectiveQuery);
    expect(text).toContain('60 total');
  });

  it('count the provisional snowfall normals on the page in the notice', async () => {
    serve(json(MONTHLY_DEFAULTS_JSON));
    const { structured, text } = await call({ ...SEA_TAC, granularity: 'monthly' });
    const phrase = '12 record(s) on this page have completeness R, P, or E rather than S';
    expect(structured.notice).toContain(phrase);
    expect(text).toContain(phrase);
    expect(structured.notice).not.toContain('Normalized');
  });
});

describe('annualseasonal defaults', () => {
  it('return the annual normals with no date, snowfall provisional', async () => {
    serve(json(ANNUAL_DEFAULTS_JSON));
    const { structured, text } = await call({ ...SEA_TAC, granularity: 'annualseasonal' });

    expect(structured.results).toEqual([
      { datatype: 'ANN-TAVG-NORMAL', value: 53.7, unit: '°F', completeness: 'S', years: 25 },
      { datatype: 'ANN-TMAX-NORMAL', value: 61.3, unit: '°F', completeness: 'S', years: 30 },
      { datatype: 'ANN-TMIN-NORMAL', value: 46.1, unit: '°F', completeness: 'S', years: 25 },
      { datatype: 'ANN-PRCP-NORMAL', value: 39.34, unit: 'in', completeness: 'S', years: 29 },
      { datatype: 'ANN-SNOW-NORMAL', value: 6.3, unit: 'in', completeness: 'P', years: 17 },
    ]);
    expect(structured.effectiveQuery).toContain('dataset=normals-annualseasonal-1991-2020');
    expect(text).toContain('| — | ANN-TAVG-NORMAL | 53.7 | °F |  | S | 25 |  |');
    expect(text).toContain('| — | ANN-PRCP-NORMAL | 39.34 | in |  | S | 29 |  |');
    expect(text).toContain('| — | ANN-SNOW-NORMAL | 6.3 | in |  | P | 17 |  |');
    for (const surface of [structured.notice, text]) {
      expect(surface).toContain('1 record(s) on this page have completeness R, P, or E');
    }
  });
});

describe('the request', () => {
  it.each([
    ['monthly', undefined, {}],
    ['daily', undefined, { startDate: '2020-01-01', endDate: '2020-12-31' }],
    ['hourly', 3, { startDate: '2020-03-01', endDate: '2020-03-31' }],
    ['annualseasonal', undefined, {}],
  ] as const)(
    '%s names its default dataTypes explicitly and never sends units',
    async (granularity, month, window) => {
      const fetchMock = serve(json(NO_ROWS_JSON));
      await call({ ...SEA_TAC, granularity, ...(month !== undefined && { month }) });
      expect(sentParams(fetchMock)).toEqual({
        dataset: NORMALS_GRANULARITIES[granularity].dataset,
        stations: 'USW00024233',
        dataTypes: NORMALS_GRANULARITIES[granularity].defaults.join(','),
        ...window,
        includeAttributes: 'true',
        format: 'json',
      });
    },
  );
});

describe('stationId', () => {
  it('sends a lowercase GHCND: form bare, with a normalization notice on both surfaces', async () => {
    const fetchMock = serve(json(MONTHLY_DEFAULTS_JSON));
    const { structured, text } = await call({
      stationId: 'ghcnd:usw00024233 ',
      granularity: 'monthly',
    });
    expect(sentParams(fetchMock).stations).toBe('USW00024233');
    expect(structured.station).toBe('USW00024233');
    const notice = 'Normalized station ID: "ghcnd:usw00024233 " → USW00024233.';
    expect(structured.notice).toContain(notice);
    expect(text).toContain(notice);
  });

  it.each(['US10adam002', 'US10box_001', 'US1Colf1831'])(
    'sends the mixed-case legacy ID %s as written, which is the only form NCEI matches',
    async (stationId) => {
      const fetchMock = serve(json(NO_ROWS_JSON));
      const { structured } = await call({ stationId, granularity: 'monthly' });
      expect(sentParams(fetchMock).stations).toBe(stationId);
      expect(structured.station).toBe(stationId);
      expect(structured.notice).not.toContain('Normalized');
    },
  );

  it('strips the GHCND: prefix from a mixed-case legacy ID without changing its case', async () => {
    const fetchMock = serve(json(NO_ROWS_JSON));
    const { structured } = await call({ stationId: 'GHCND:US10adam002', granularity: 'monthly' });
    expect(sentParams(fetchMock).stations).toBe('US10adam002');
    expect(structured.notice).toContain(
      'Normalized station ID: "GHCND:US10adam002" → US10adam002.',
    );
  });

  it.each(['COOP:454769', 'NEXRAD:KATX', 'GHCND:', 'USW0002423', ' '])(
    'rejects %j at input validation, before any request',
    async (stationId) => {
      const fetchMock = serve(json(NO_ROWS_JSON));
      const failure = await contractFailure(noaaClimateGetNormals, {
        stationId,
        granularity: 'monthly',
      });
      expect(failure.code).toBe(JsonRpcErrorCode.InvalidParams);
      for (const surface of [failure.message, failure.text]) {
        expect(surface).toContain('USW00024233');
        expect(surface).toContain('GHCND:USW00024233');
      }
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
});

describe('datatypeId', () => {
  it('is uppercased, trimmed, and deduplicated before it is sent', async () => {
    const fetchMock = serve(json(MONTHLY_UNKNOWN_DATATYPE_JSON));
    const { structured } = await call({
      ...SEA_TAC,
      granularity: 'monthly',
      datatypeId: ['mly-tavg-normal', ' MLY-TAVG-NORMAL '],
    });
    expect(sentParams(fetchMock).dataTypes).toBe('MLY-TAVG-NORMAL');
    expect(structured.results[0]).toMatchObject({ datatype: 'MLY-TAVG-NORMAL', value: 42.8 });
    expect(structured.effectiveQuery).toContain('datatypes=[MLY-TAVG-NORMAL]');
  });

  it.each([
    [
      'monthly',
      undefined,
      ['DLY-TAVG-NORMAL'],
      'DLY-TAVG-NORMAL is not a monthly normals datatype: monthly IDs start with MLY-.',
    ],
    [
      'daily',
      2,
      ['MLY-TAVG-NORMAL'],
      'MLY-TAVG-NORMAL is not a daily normals datatype: daily IDs start with DLY-, MTD-, YTD-.',
    ],
    [
      'hourly',
      1,
      ['ANN-TAVG-NORMAL'],
      'ANN-TAVG-NORMAL is not a hourly normals datatype: hourly IDs start with HLY-.',
    ],
    [
      'annualseasonal',
      undefined,
      ['MLY-TAVG-NORMAL', 'HLY-TEMP-NORMAL'],
      'MLY-TAVG-NORMAL, HLY-TEMP-NORMAL are not annualseasonal normals datatypes: annualseasonal IDs start with ANN-, DJF-, MAM-, JJA-, SON-.',
    ],
    ['monthly', undefined, ['MLY-'], 'MLY- is not a monthly normals datatype'],
    [
      'monthly',
      undefined,
      ['MLY_TAVG_NORMAL'],
      'MLY_TAVG_NORMAL is not a monthly normals datatype',
    ],
    [
      'monthly',
      undefined,
      ['XMLY-TAVG-NORMAL'],
      'XMLY-TAVG-NORMAL is not a monthly normals datatype',
    ],
    [
      'monthly',
      undefined,
      ['MLY-TAVG-NORMAL X'],
      'MLY-TAVG-NORMAL X is not a monthly normals datatype',
    ],
  ] as const)(
    'fails %s with %j as validation_error before any request',
    async (granularity, month, datatypeId, message) => {
      const fetchMock = serve(json(NO_ROWS_JSON));
      const failure = await contractFailure(noaaClimateGetNormals, {
        ...SEA_TAC,
        granularity,
        datatypeId,
        ...(month !== undefined && { month }),
      });
      expect(failure.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(failure.data.reason).toBe('validation_error');
      expect(failure.data.recovery?.hint).toContain('MLY- monthly');
      expect(failure.message).toContain(message);
      expect(failure.text).toContain(message);
      expect(failure.text).toContain('MLY- monthly');
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['daily', 1, ['DLY-TAVG-NORMAL', 'MTD-PRCP-NORMAL', 'YTD-SNOW-NORMAL']],
    [
      'annualseasonal',
      undefined,
      [
        'ANN-TAVG-NORMAL',
        'DJF-TAVG-NORMAL',
        'MAM-PRCP-NORMAL',
        'JJA-TMAX-NORMAL',
        'SON-SNOW-NORMAL',
      ],
    ],
    ['hourly', 7, ['HLY-PRES-NORMAL']],
  ] as const)('sends every %s prefix it carries', async (granularity, month, datatypeId) => {
    const fetchMock = serve(json(NO_ROWS_JSON));
    await call({
      ...SEA_TAC,
      granularity,
      datatypeId: [...datatypeId],
      ...(month !== undefined && { month }),
    });
    expect(sentParams(fetchMock).dataTypes).toBe(datatypeId.join(','));
  });

  it('takes 50 datatypes and rejects 51 at input validation', async () => {
    const ids = Array.from({ length: 51 }, (_, i) => `MLY-TEST-${i}`);
    expect(
      noaaClimateGetNormals.input.safeParse({
        ...SEA_TAC,
        granularity: 'monthly',
        datatypeId: ids.slice(0, 50),
      }).success,
    ).toBe(true);
    const failure = await contractFailure(noaaClimateGetNormals, {
      ...SEA_TAC,
      granularity: 'monthly',
      datatypeId: ids,
    });
    expect(failure.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(failure.text).toContain('at most 50 datatypes');
  });

  it.each([
    ['trailing break', (n: number) => `MLY-${'X '.repeat(n / 2)}\ny`, 80_000],
    ['breaks throughout', (n: number) => `MLY-A${'  \r\nB'.repeat(n / 5)}`, 80_000],
    ['overlapping prefixes', (n: number) => `${'MLY-'.repeat(n / 4)}!`, 80_000],
    ['digits', (n: number) => '1'.repeat(n), 320_000],
  ] as const)('checks the datatype prefix in linear CPU time for %s', (_label, shape, maximum) => {
    const fetchMock = serve(() => {
      throw new Error('The prefix check must reject every timing input before a request.');
    });
    const ctx = createMockContext({ errors: noaaClimateGetNormals.errors });
    const settled: Promise<unknown>[] = [];
    // The handler throws before its first await, so its whole check runs inside the timed call.
    expectLinearCpu(
      (datatype) => {
        const input = noaaClimateGetNormals.input.parse({
          ...SEA_TAC,
          granularity: 'monthly',
          datatypeId: [datatype],
        });
        settled.push(
          Promise.resolve(noaaClimateGetNormals.handler(input, ctx)).catch(
            (error: unknown) => error,
          ),
        );
      },
      shape,
      maximum,
    );
    return Promise.all(settled).then((errors) => {
      expect(
        errors.every(
          (error) => (error as { data?: { reason?: string } }).data?.reason === 'validation_error',
        ),
      ).toBe(true);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});

describe('month', () => {
  it.each([
    ['hourly', undefined, 'Hourly normals are read one month at a time'],
    ['annualseasonal', 7, 'annualseasonal normals have no month axis'],
  ] as const)(
    '%s with month %s fails as validation_error before any request',
    async (granularity, month, message) => {
      const fetchMock = serve(json(NO_ROWS_JSON));
      const failure = await contractFailure(noaaClimateGetNormals, {
        ...SEA_TAC,
        granularity,
        ...(month !== undefined && { month }),
      });
      expect(failure.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(failure.data.reason).toBe('validation_error');
      expect(failure.message).toContain(message);
      expect(failure.text).toContain(message);
      expect(failure.text).toContain('pass month for hourly and omit it for annualseasonal');
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it.each([0, 13, 1.5, -1])('rejects month %s at input validation', (month) => {
    expect(
      noaaClimateGetNormals.input.safeParse({ ...SEA_TAC, granularity: 'daily', month }).success,
    ).toBe(false);
  });

  it('narrows monthly to one month', async () => {
    const fetchMock = serve(json(NO_ROWS_JSON));
    const { structured } = await call({ ...SEA_TAC, granularity: 'monthly', month: 2 });
    expect(sentParams(fetchMock)).toMatchObject({ startDate: '2020-02-01', endDate: '2020-02-29' });
    expect(structured.effectiveQuery).toContain('month=2');
  });
});

describe('hourly with month 1', () => {
  it('pages the 1,488 default records from 01-01T00:00:00 through 01-31T23:00:00', async () => {
    serve(() => json(hourlyJanuaryJson())());
    const pages = [
      { offset: 0, size: 100, first: '01-01T00:00:00', window: 'Showing records 1–100 of 1488' },
      {
        offset: 100,
        size: 100,
        first: '01-03T02:00:00',
        window: 'Showing records 101–200 of 1488',
      },
      { offset: 1400, size: 88, first: '01-30T04:00:00' },
      { offset: 1488, size: 0 },
    ];
    for (const page of pages) {
      const { structured, text } = await call({
        ...SEA_TAC,
        granularity: 'hourly',
        month: 1,
        offset: page.offset,
      });
      expect(structured.totalCount).toBe(1488);
      expect(structured.results).toHaveLength(page.size);
      expect(text).toContain('1488 total');
      if (page.first) {
        expect(structured.results[0]).toMatchObject({
          date: page.first,
          datatype: 'HLY-TEMP-NORMAL',
        });
        expect(text).toContain(`| ${page.first} | HLY-TEMP-NORMAL | 40 | °F |  | S | 30 |  |`);
      }
      if (page.window) {
        expect(structured).toMatchObject({ truncated: true, shown: 100, cap: 100 });
        const guidance = `${page.window}. Raise offset to page forward, or narrow with datatypeId.`;
        expect(structured.notice).toContain(guidance);
        expect(text).toContain(guidance);
      } else {
        expect(structured.truncated).toBeUndefined();
      }
    }
  });

  it('ends the last page on the month’s final hour', async () => {
    serve(() => json(hourlyJanuaryJson())());
    const { structured } = await call({
      ...SEA_TAC,
      granularity: 'hourly',
      month: 1,
      offset: 1400,
    });
    expect(structured.results.at(-1)).toMatchObject({
      date: '01-31T23:00:00',
      datatype: 'HLY-DEWP-NORMAL',
      value: 34.8,
    });
    expect(structured.exhausted).toBeUndefined();
  });

  it('flags an offset past the end as exhausted on both surfaces', async () => {
    serve(() => json(hourlyJanuaryJson())());
    const { structured, text } = await call({
      ...SEA_TAC,
      granularity: 'hourly',
      month: 1,
      offset: 1488,
    });
    expect(structured.exhausted).toBe(true);
    const notice =
      'Page is empty because offset 1488 is past the end of 1488 records. Lower offset or reset it to 0.';
    expect(structured.notice).toContain(notice);
    expect(text).toContain(notice);
    expect(text).toContain('_No records on this page._');
  });
});

describe('daily with month 2', () => {
  it('includes 02-29, where MTD-PRCP-NORMAL is missing with no value and flag M, counted in the notice', async () => {
    const fetchMock = serve(json(DAILY_FEBRUARY_TAIL_JSON));
    const { structured, text } = await call({
      ...SEA_TAC,
      granularity: 'daily',
      month: 2,
      datatypeId: ['DLY-TMAX-NORMAL', 'MTD-PRCP-NORMAL'],
    });
    expect(sentParams(fetchMock)).toMatchObject({ startDate: '2020-02-01', endDate: '2020-02-29' });
    const leapDay = structured.results.find(
      (record) => record.date === '02-29' && record.datatype === 'MTD-PRCP-NORMAL',
    );
    expect(leapDay).toEqual({
      date: '02-29',
      datatype: 'MTD-PRCP-NORMAL',
      missing: true,
      unit: 'in',
      years: 0,
      measurementFlag: 'M',
    });
    expect(text).toContain('| 02-29 | MTD-PRCP-NORMAL |  | in | missing=true |  | 0 | M |');
    const notice =
      "1 record(s) on this page carry NCEI's -9999 special value: missing=true and value is omitted.";
    expect(structured.notice).toContain(notice);
    expect(text).toContain(notice);
  });
});

describe('a requested datatype no row carries', () => {
  it('is named in the notice while the rest return', async () => {
    serve(json(MONTHLY_UNKNOWN_DATATYPE_JSON));
    const { structured, text } = await call({
      ...SEA_TAC,
      granularity: 'monthly',
      datatypeId: ['MLY-TAVG-NORMAL', 'MLY-FAKE-NORMAL'],
    });
    expect(structured.results).toHaveLength(12);
    expect(structured.results.every((record) => record.datatype === 'MLY-TAVG-NORMAL')).toBe(true);
    for (const surface of [structured.notice, text]) {
      expect(surface).toContain('No row for station USW00024233 carries MLY-FAKE-NORMAL');
      expect(surface).toContain(NORMALS_GRANULARITIES.monthly.documentation);
    }
  });

  it('names the temperatures a precipitation-only station lacks, and counts its estimated normals', async () => {
    serve(json(PRECIP_ONLY_MONTHLY_JSON));
    const { structured, text } = await call({
      stationId: 'US1WAKG0005',
      granularity: 'monthly',
      datatypeId: ['MLY-TAVG-NORMAL', 'MLY-PRCP-NORMAL'],
    });
    expect(structured.results).toHaveLength(12);
    expect(structured.results[0]).toEqual({
      date: '01',
      datatype: 'MLY-PRCP-NORMAL',
      value: 5.57,
      unit: 'in',
      completeness: 'E',
      years: 12,
    });
    for (const surface of [structured.notice, text]) {
      expect(surface).toContain('No row for station US1WAKG0005 carries MLY-TAVG-NORMAL');
      expect(surface).toContain('precipitation-only stations carry no temperature normals');
      expect(surface).toContain('12 record(s) on this page have completeness R, P, or E');
    }
  });
});

describe('no rows', () => {
  it.each(['US1WAKG0210', 'USW00099999'])(
    '%s is a success with empty results and a notice routing to the station tools',
    async (stationId) => {
      serve(json(NO_ROWS_JSON));
      const { structured, text } = await call({ stationId, granularity: 'monthly' });
      expect(structured.results).toEqual([]);
      expect(structured.totalCount).toBe(0);
      expect(structured.exhausted).toBeUndefined();
      expect(structured.truncated).toBeUndefined();
      for (const surface of [structured.notice, text]) {
        expect(surface).toContain(
          `No 1991–2020 normals came back for station ${stationId} from normals-monthly-1991-2020`,
        );
        expect(surface).toContain('noaa_climate_get_station');
        expect(surface).toContain('noaa_climate_find_stations');
        expect(surface).not.toContain('carries');
      }
      expect(text).toContain('_No records on this page._');
    },
  );

  it('points hourly callers at the small hourly inventory', async () => {
    serve(json(NO_ROWS_JSON));
    const { structured } = await call({
      stationId: 'USC00454769',
      granularity: 'hourly',
      month: 1,
    });
    expect(structured.notice).toContain('hourly normals exist for about 470 stations');
  });

  const CASE_TAIL =
    'Pass the ID exactly as noaa_climate_find_stations lists it; about 290 stations with normals carry a mixed-case legacy CoCoRaHS ID such as US10adam002, and noaa_climate_get_station cannot resolve those.';

  it.each([
    [
      'us10adam002',
      'US10ADAM002',
      'NCEI matches station IDs case-sensitively, and "us10adam002" was sent uppercased, as US10ADAM002, because it is written all in lowercase.',
    ],
    [
      'GHCND:us10adam002',
      'US10ADAM002',
      'NCEI matches station IDs case-sensitively, and "us10adam002" was sent uppercased, as US10ADAM002, because it is written all in lowercase.',
    ],
    [
      'US10Adam002',
      'US10Adam002',
      'NCEI matches station IDs case-sensitively, and "US10Adam002" was sent as written, because it mixes upper and lower case.',
    ],
  ])(
    'names the case cause for %j, sent as %s, on both surfaces',
    async (stationId, sent, sentence) => {
      const fetchMock = serve(json(NO_ROWS_JSON));
      const { structured, text } = await call({ stationId, granularity: 'monthly' });
      expect(sentParams(fetchMock).stations).toBe(sent);
      for (const surface of [structured.notice, text]) {
        expect(surface).toContain(`No 1991–2020 normals came back for station ${sent}`);
        expect(surface).toContain(`${sentence} ${CASE_TAIL}`);
      }
    },
  );

  it.each(['USW00099999', 'ghcnd:USW00099999', 'GHCND:US1WAKG0210 '])(
    'leaves the case sentence off for %j, written without a lowercase letter',
    async (stationId) => {
      serve(json(NO_ROWS_JSON));
      const { structured, text } = await call({ stationId, granularity: 'monthly' });
      for (const surface of [structured.notice, text]) {
        expect(surface).toContain('No 1991–2020 normals came back');
        expect(surface).not.toContain('case-sensitively');
      }
    },
  );

  it('leaves the case sentence off when a lowercase ID returns rows', async () => {
    serve(json(MONTHLY_DEFAULTS_JSON));
    const { structured, text } = await call({ stationId: 'usw00024233', granularity: 'monthly' });
    expect(structured.results).toHaveLength(60);
    for (const surface of [structured.notice, text]) {
      expect(surface).not.toContain('case-sensitively');
    }
  });
});

describe('limit and offset', () => {
  it('defaults limit to 100', () => {
    expect(noaaClimateGetNormals.input.parse({ ...SEA_TAC, granularity: 'monthly' })).toMatchObject(
      {
        limit: 100,
        offset: 0,
      },
    );
  });

  it('clamps a limit above 1000 with the shared notice on both surfaces', async () => {
    serve(() => json(hourlyJanuaryJson())());
    const { structured, text } = await call({
      ...SEA_TAC,
      granularity: 'hourly',
      month: 1,
      limit: 5000,
    });
    expect(structured).toMatchObject({ truncated: true, shown: 1000, cap: 1000, totalCount: 1488 });
    expect(structured.results).toHaveLength(1000);
    for (const surface of [structured.notice, text]) {
      expect(surface).toContain('Requested limit 5000 was clamped to 1000.');
      expect(surface).toContain('Showing records 1–1000 of 1488');
    }
  });

  it('restores the 1000 ceiling with clamping disabled', async () => {
    vi.resetModules();
    vi.stubEnv('NOAA_CLAMP_LIMITS', 'false');
    const { noaaClimateGetNormals: strict } = await import(
      '@/mcp-server/tools/definitions/noaa-climate-get-normals.tool.js'
    );
    expect(z.toJSONSchema(strict.input).properties?.limit).toMatchObject({ maximum: 1000 });
    const failure = await contractFailure(strict, {
      ...SEA_TAC,
      granularity: 'monthly',
      limit: 1001,
    });
    expect(failure.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(failure.text).toContain('1000');
    for (const limit of [0, -1, 1.5, 'abc']) {
      expect(strict.input.safeParse({ ...SEA_TAC, granularity: 'monthly', limit }).success).toBe(
        false,
      );
    }
  });

  it('returns the last record alone at offset 59 without claiming truncation', async () => {
    serve(json(MONTHLY_DEFAULTS_JSON));
    const { structured } = await call({ ...SEA_TAC, granularity: 'monthly', offset: 59 });
    expect(structured.results).toEqual([
      expect.objectContaining({ date: '12', datatype: 'MLY-SNOW-NORMAL' }),
    ]);
    expect(structured.totalCount).toBe(60);
    expect(structured.truncated).toBeUndefined();
    expect(structured.exhausted).toBeUndefined();
  });

  it('rejects a negative offset', () => {
    expect(
      noaaClimateGetNormals.input.safeParse({ ...SEA_TAC, granularity: 'monthly', offset: -1 })
        .success,
    ).toBe(false);
  });
});

describe('page-local notices', () => {
  it('counts an R record with the P and E ones, and no S record', async () => {
    serve(
      json(
        '[{"DATE":"01","MLY-TAVG-NORMAL":"    42.8","comp_flag_MLY-TAVG-NORMAL":"R","years_MLY-TAVG-NORMAL":"21","MLY-PRCP-NORMAL":"    5.78","comp_flag_MLY-PRCP-NORMAL":"S","years_MLY-PRCP-NORMAL":"30"}]',
      ),
    );
    const { structured, text } = await call({
      ...SEA_TAC,
      granularity: 'monthly',
      datatypeId: ['MLY-TAVG-NORMAL', 'MLY-PRCP-NORMAL'],
    });
    const phrase = '1 record(s) on this page have completeness R, P, or E rather than S';
    expect(structured.notice).toContain(phrase);
    expect(text).toContain(phrase);
  });

  it('counts completeness, missing values, and unlabeled units on the page, not the whole response', async () => {
    serve(json(DAILY_FEBRUARY_TAIL_JSON));
    const { structured } = await call({
      ...SEA_TAC,
      granularity: 'daily',
      month: 2,
      datatypeId: ['DLY-TMAX-NORMAL', 'MTD-PRCP-NORMAL'],
      limit: 2,
    });
    expect(structured.results.map((record) => record.date)).toEqual(['02-27', '02-27']);
    expect(structured.notice).not.toContain('-9999 special value');

    serve(json(MONTHLY_DEFAULTS_JSON));
    const last = await call({ ...SEA_TAC, granularity: 'monthly', offset: 59 });
    expect(last.structured.notice).toContain(
      '1 record(s) on this page have completeness R, P, or E rather than S',
    );
  });
});

describe('units', () => {
  it.each([
    ['monthly', undefined, 'MLY-TAVG-STDDEV', MONTHLY_STDDEV_JANUARY_JSON],
    [
      'daily',
      1,
      'DLY-TAVG-STDDEV',
      '[{"DATE":"01-01","DLY-TAVG-STDDEV":"     3.1","comp_flag_DLY-TAVG-STDDEV":"S","years_DLY-TAVG-STDDEV":"30"}]',
    ],
    [
      'hourly',
      7,
      'HLY-WIND-AVGSPD',
      '[{"DATE":"07-01T12:00:00","HLY-WIND-AVGSPD":"     8.6","comp_flag_HLY-WIND-AVGSPD":"S","years_HLY-WIND-AVGSPD":"30"}]',
    ],
    ['annualseasonal', undefined, 'ANN-TMIN-PRBLST-T32FP50', ANNUAL_FROST_DATES_JSON],
  ] as const)(
    '%s leaves %s unlabeled and links that granularity’s documentation',
    async (granularity, month, datatype, body) => {
      serve(json(body));
      const { structured, text } = await call({
        ...SEA_TAC,
        granularity,
        datatypeId: [datatype],
        ...(month !== undefined && { month }),
      });
      expect(structured.results[0]).toMatchObject({ datatype });
      expect(structured.results[0]).not.toHaveProperty('unit');
      expect(text).toMatch(new RegExp(`\\| ${datatype} \\| [^|]+ \\| not labeled \\|`));
      const notice = `No unit is labeled for ${datatype}; NCEI's documentation gives it: ${NORMALS_GRANULARITIES[granularity].documentation}`;
      expect(structured.notice).toContain(notice);
      expect(text).toContain(notice);
    },
  );

  it('labels hourly sea-level pressure hPa on both surfaces, with no documentation notice', async () => {
    // NCEI's hourly documentation says inches of mercury; the values are hPa.
    serve(
      json(
        '[{"DATE":"07-01T12:00:00","HLY-PRES-NORMAL":"  1011.0","comp_flag_HLY-PRES-NORMAL":"S","years_HLY-PRES-NORMAL":"25","HLY-PRES-10PCTL":"  1005.2","comp_flag_HLY-PRES-10PCTL":"S","years_HLY-PRES-10PCTL":"25","HLY-PRES-90PCTL":"  1017.7","comp_flag_HLY-PRES-90PCTL":"S","years_HLY-PRES-90PCTL":"25"}]',
      ),
    );
    const { structured, text } = await call({
      ...SEA_TAC,
      granularity: 'hourly',
      month: 7,
      datatypeId: ['HLY-PRES-NORMAL', 'HLY-PRES-10PCTL', 'HLY-PRES-90PCTL'],
    });
    expect(
      structured.results.map((record) => [record.datatype, record.value, record.unit]),
    ).toEqual([
      ['HLY-PRES-NORMAL', 1011, 'hPa'],
      ['HLY-PRES-10PCTL', 1005.2, 'hPa'],
      ['HLY-PRES-90PCTL', 1017.7, 'hPa'],
    ]);
    expect(text).toContain('| 07-01T12:00:00 | HLY-PRES-NORMAL | 1011 | hPa |  | S | 25 |  |');
    expect(text).toContain('| 07-01T12:00:00 | HLY-PRES-90PCTL | 1017.7 | hPa |  | S | 25 |  |');
    for (const surface of [structured.notice ?? '', text]) {
      expect(surface).not.toContain('No unit is labeled');
    }
  });

  it('carries a text value on both surfaces', async () => {
    serve(json(ANNUAL_FROST_DATES_JSON));
    const { structured, text } = await call({
      ...SEA_TAC,
      granularity: 'annualseasonal',
      datatypeId: ['ANN-TMIN-PRBLST-T32FP50', 'ANN-TMIN-PRBFST-T16FP10'],
    });
    expect(structured.results).toEqual([
      { datatype: 'ANN-TMIN-PRBLST-T32FP50', valueText: '03/02' },
      { datatype: 'ANN-TMIN-PRBFST-T16FP10', missing: true },
    ]);
    expect(text).toContain('| — | ANN-TMIN-PRBLST-T32FP50 | 03/02 | not labeled |  |  |  |  |');
    expect(text).toContain(
      '| — | ANN-TMIN-PRBFST-T16FP10 |  | not labeled | missing=true |  |  |  |',
    );
  });
});

describe('upstream failures', () => {
  it("turns a 400 into validation_error carrying NCEI's message, never the body", async () => {
    const fetchMock = serve(json(MISSING_DATES_400_JSON, 400));
    const failure = await contractFailure(noaaClimateGetNormals, {
      ...SEA_TAC,
      granularity: 'monthly',
    });
    expect(failure.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(failure.data.reason).toBe('validation_error');
    const message =
      'The NCEI Access Data Service rejected the request (HTTP 400): A start date is required. An end date is required.';
    expect(failure.message).toBe(message);
    expect(failure.text).toContain(message);
    expect(failure.text).toContain('Use datatype IDs with the granularity’s prefix');
    for (const field of ['body', 'responseBody', 'upstreamMessage', 'status']) {
      expect(failure.data).not.toHaveProperty(field);
    }
    expect(failure.text).not.toContain('errorCode');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      'a 503',
      'service_unavailable',
      'HTTP 503 (503 Service Unavailable)',
      () =>
        html(
          '<!DOCTYPE html><html><head><title>503 Service Unavailable</title></head></html>',
          503,
        )(),
    ],
    [
      'a network failure',
      'service_unavailable',
      'NCEI Access Data Service normals request',
      () => {
        throw new TypeError('fetch failed');
      },
    ],
    [
      'an HTML page on HTTP 200',
      'service_unavailable',
      'an HTML page instead of JSON',
      () => html(APACHE_404_HTML, 200)(),
    ],
    ['a 429', 'rate_limited', 'HTTP 429', () => json('{}', 429)()],
  ] as const)(
    'turns %s into %s with its recovery on both surfaces',
    async (_label, reason, phrase, respond) => {
      vi.useFakeTimers();
      serve(respond);
      const failure = await failureAfterRetries({ ...SEA_TAC, granularity: 'monthly' });
      expect(failure.data.reason).toBe(reason);
      expect(failure.data.retryable).toBe(true);
      expect(failure.message).toContain(phrase);
      expect(failure.text).toContain(phrase);
      const hint =
        reason === 'rate_limited'
          ? 'run fewer normals calls at once'
          : 'may be temporarily unavailable';
      expect(failure.data.recovery?.hint).toContain(hint);
      expect(failure.text).toContain(hint);
      expect(failure.text).not.toMatch(/<html|<title/i);
      expect(failure.data).not.toHaveProperty('body');
    },
  );

  it('marks JSON in the wrong shape not retryable, after one request, on both surfaces', async () => {
    const fetchMock = serve(json('{"results":[]}'));
    const failure = await contractFailure(noaaClimateGetNormals, {
      ...SEA_TAC,
      granularity: 'monthly',
    });
    expect(failure.data.reason).toBe('service_unavailable');
    expect(failure.data.retryable).toBe(false);
    expect(failure.message).toBe(
      'The NCEI Access Data Service returned a response that is not a JSON array of rows.',
    );
    const hint = 'Retrying the same call returns the same response';
    expect(failure.data.recovery?.hint).toContain(hint);
    expect(failure.text).toContain(hint);
    expect(failure.text).not.toContain('may be temporarily unavailable');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('passes a 504 through as Timeout with no reason, the rule the CDO tools follow', async () => {
    // service_unavailable is declared under ServiceUnavailable, so emitting it
    // on a Timeout-coded error would contradict the contract the tool advertises.
    vi.useFakeTimers();
    const fetchMock = serve(
      html(
        '<!DOCTYPE html><html><head><title>504 Gateway Time-out</title></head><body></body></html>',
        504,
      ),
    );
    const failure = await failureAfterRetries({ ...SEA_TAC, granularity: 'monthly' });
    expect(failure.code).toBe(JsonRpcErrorCode.Timeout);
    expect(failure.data.reason).toBeUndefined();
    const message =
      'NCEI Access Data Service normals request returned HTTP 504 (504 Gateway Time-out). (failed after 4 attempts)';
    expect(failure.message).toBe(message);
    expect(failure.text).toContain(message);
    expect(failure.text).not.toMatch(/<html|<title/i);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('passes the call deadline through as Timeout with no declared reason, naming the request', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
              once: true,
            });
          }),
      ),
    );
    const pending = contractFailure(noaaClimateGetNormals, { ...SEA_TAC, granularity: 'monthly' });
    await vi.advanceTimersByTimeAsync(45_000);
    const failure = await pending;
    expect(failure.code).toBe(JsonRpcErrorCode.Timeout);
    expect(noaaClimateGetNormals.errors?.map((entry) => entry.reason)).not.toContain(
      failure.data.reason,
    );
    const message =
      'NCEI Access Data Service normals request exceeded its 45000ms retry deadline after 3 attempts.';
    expect(failure.message).toBe(message);
    expect(failure.text).toContain(message);
    expect(failure.text).not.toContain('normals.get');
  });

  it('passes a 404 through as the status-mapped NotFound with its page title', async () => {
    serve(html(APACHE_404_HTML, 404));
    const failure = await contractFailure(noaaClimateGetNormals, {
      ...SEA_TAC,
      granularity: 'monthly',
    });
    expect(failure.code).toBe(JsonRpcErrorCode.NotFound);
    expect(failure.message).toContain('returned HTTP 404 (404 Not Found)');
    expect(failure.text).not.toMatch(/<html|<title/i);
  });

  it('settles a cancelled call as RequestCancelled', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const pending = runToolContract(
      noaaClimateGetNormals,
      { ...SEA_TAC, granularity: 'monthly' },
      { context: { signal: controller.signal } },
    );
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    controller.abort();
    const response = await pending;
    expect(response.isError).toBe(true);
    expect(response.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.RequestCancelled },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('format', () => {
  it('renders every structured field, including missing, a text value, and an absent unit', () => {
    const [block] = noaaClimateGetNormals.format!({
      station: 'USW00024233',
      granularity: 'daily',
      results: [
        {
          date: '02-28',
          datatype: 'DLY-TMAX-NORMAL',
          value: 51.8,
          unit: '°F',
          completeness: 'R',
          years: 21,
          measurementFlag: 'X',
        },
        {
          date: '02-29',
          datatype: 'MTD-PRCP-NORMAL',
          missing: true,
          unit: 'in',
          years: 0,
          measurementFlag: 'M',
        },
        { date: '02-29', datatype: 'DLY-TAVG-STDDEV', valueText: '0*1' },
      ],
    });
    expect(block?.type === 'text' && block.text.split('\n')).toEqual([
      '**Station:** USW00024233 | **Granularity:** daily',
      '',
      '| Date | Datatype | Value | Unit | Missing | Completeness | Years | Measurement flag |',
      '|:-----|:---------|------:|:-----|:--------|:-------------|------:|:-----------------|',
      '| 02-28 | DLY-TMAX-NORMAL | 51.8 | °F |  | R | 21 | X |',
      '| 02-29 | MTD-PRCP-NORMAL |  | in | missing=true |  | 0 | M |',
      '| 02-29 | DLY-TAVG-STDDEV | 0\\*1 | not labeled |  |  |  |  |',
    ]);
  });
});

describe('description', () => {
  it('names the example station and routes away from the superseded CDO normals', () => {
    expect(noaaClimateGetNormals.description).toContain('USW00024233');
    expect(noaaClimateGetNormals.description).toContain(
      'NORMAL_* datasets are the superseded 1981–2010 normals',
    );
  });
});
