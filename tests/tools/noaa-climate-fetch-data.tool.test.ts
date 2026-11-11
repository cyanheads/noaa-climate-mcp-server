/**
 * @fileoverview Tests for the noaa_climate_fetch_data tool.
 * @module tests/tools/noaa-climate-fetch-data.tool.test
 */

import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { noaaClimateFetchData } from '@/mcp-server/tools/definitions/noaa-climate-fetch-data.tool.js';
import type { CdoDataRecord } from '@/services/cdo/types.js';
import { firstText } from '../helpers/content.js';

vi.mock('@/services/cdo/cdo-service.js', () => ({
  getCdoService: vi.fn(),
}));

import { getCdoService } from '@/services/cdo/cdo-service.js';

const mockRecords = [
  {
    date: '2023-01-01T00:00:00',
    datatype: 'TMAX',
    station: 'GHCND:USC00450974',
    value: 22,
    attributes: 'T,,,',
  },
  { date: '2023-01-01T00:00:00', datatype: 'TMIN', station: 'GHCND:USC00450974', value: -3 }, // sparse — no attributes
];

beforeEach(() => {
  vi.mocked(getCdoService).mockReturnValue({
    fetchData: vi.fn().mockResolvedValue({
      results: mockRecords,
      metadata: { resultset: { count: 2, limit: 25, offset: 0 } },
    }),
  } as unknown as ReturnType<typeof getCdoService>);
});

describe('noaaClimateFetchData', () => {
  it.each([
    ['PRECIP_HLY', 'HPCP', undefined, 99999],
    ['PRECIP_HLY', 'HPCP', 'standard', 999.99],
    ['PRECIP_HLY', 'HPCP', 'metric', 25399.75],
    ['PRECIP_15', 'QPCP', undefined, 99999],
    ['PRECIP_15', 'QPCP', 'standard', 999.99],
    ['PRECIP_15', 'QPCP', 'metric', 25399.75],
  ] as const)(
    'marks %s/%s missing in %s units on both surfaces',
    async (datasetId, datatype, units, value) => {
      vi.mocked(vi.mocked(getCdoService)().fetchData).mockResolvedValueOnce({
        results: [
          { date: '2010-01-01', datatype, station: 'COOP:454769', value, attributes: '{,' },
          { date: '2010-01-02', datatype, station: 'COOP:454769', value: 0, attributes: 'g,,HT' },
          { date: '2010-01-03', datatype, station: 'COOP:454769', value: 12, attributes: 'A,' },
        ],
        metadata: { resultset: { count: 3, offset: 1, limit: 1000 } },
      });
      const result = await runToolContract(noaaClimateFetchData, {
        datasetId,
        startDate: '2010-01-01',
        endDate: '2010-01-03',
        units,
        limit: 1001,
      });
      expect(result.structuredContent).toMatchObject({
        results: [{ missing: true, attributes: '{,' }, { value: 0 }, { value: 12 }],
        metadata: { resultset: { count: 3, offset: 0, limit: 1000 } },
      });
      const data = result.structuredContent as {
        results: Record<string, unknown>[];
        notice: string;
      };
      expect(data.results[0]).not.toHaveProperty('value');
      expect(data.notice).toContain('1 missing');
      expect(data.notice).toContain('clamped');
      expect(firstText(result.content)).toContain('missing');
      expect(firstText(result.content)).not.toContain('undefined');
    },
  );

  it('decodes only GHCND positional flags and counts page-local QC failures', async () => {
    vi.mocked(vi.mocked(getCdoService)().fetchData).mockResolvedValueOnce({
      results: [
        {
          date: '2023-01-01',
          datatype: 'PRCP',
          station: 'GHCND:X',
          value: 0,
          attributes: ',L,N,0800',
        },
        { date: '2023-01-02', datatype: 'PRCP', station: 'GHCND:X', value: 4, attributes: 'T,,Z' },
        { date: '2023-01-03', datatype: 'TMAX', station: 'GHCND:X', value: 17 },
      ],
      metadata: { resultset: { count: 500, offset: 1, limit: 25 } },
    });
    const result = await runToolContract(noaaClimateFetchData, {
      datasetId: 'GHCND',
      startDate: '2023-01-01',
      endDate: '2023-01-03',
    });
    expect(result.structuredContent).toMatchObject({
      results: [
        {
          value: 0,
          attributes: ',L,N,0800',
          flags: { measurement: '', quality: 'L', source: 'N', observationTime: '0800' },
        },
        { flags: { measurement: 'T', quality: '', source: 'Z' } },
        { value: 17 },
      ],
      notice: expect.stringContaining('1 observation'),
    });
    const data = result.structuredContent as { results: Record<string, unknown>[]; notice: string };
    expect(data.results[2]).not.toHaveProperty('flags');
    expect(data.notice).toContain('raw');
    const text = firstText(result.content);
    for (const token of [
      'measurement',
      'quality',
      'source',
      'observationTime',
      '0800',
      ',L,N,0800',
    ])
      expect(text).toContain(token);
  });

  it.each([
    'GHCND',
    'GSOM',
    'GSOY',
    'NORMAL_DLY',
    'NORMAL_MLY',
    'NORMAL_ANN',
    'NORMAL_HLY',
    'PRECIP_HLY',
    'PRECIP_15',
    'NEXRAD2',
    'NEXRAD3',
  ])('guides raw %s units even for empty pages', async (datasetId) => {
    vi.mocked(vi.mocked(getCdoService)().fetchData).mockResolvedValueOnce({
      metadata: { resultset: { count: 0, limit: 25, offset: 1 } },
    });
    const result = await runToolContract(noaaClimateFetchData, {
      datasetId,
      startDate: '2010-01-01',
      endDate: '2010-01-02',
    });
    const data = result.structuredContent as { notice: string };
    for (const token of ['raw', 'datatype', 'metric', 'standard', 'https://', 'No observation']) {
      expect(data.notice).toContain(token);
      expect(JSON.stringify(result.content)).toContain(token);
    }
  });
  it('preserves zero, sparse attributes, row order and omitted upstream units', async () => {
    const ctx = createMockContext({ errors: noaaClimateFetchData.errors });
    const service = vi.mocked(getCdoService)();
    vi.mocked(service.fetchData).mockResolvedValueOnce({
      results: [
        {
          date: '2023-01-01',
          datatype: 'PRCP',
          station: 'GHCND:X',
          value: 0,
          attributes: ',L,N,0800',
        },
        { date: '2023-01-02', datatype: 'AWND', station: 'GHCND:X', value: 17 },
      ],
      metadata: { resultset: { count: 2, limit: 25, offset: 1 } },
    });
    const result = await noaaClimateFetchData.handler(
      noaaClimateFetchData.input.parse({
        datasetId: 'GHCND',
        startDate: '2023-01-01',
        endDate: '2023-01-02',
      }),
      ctx,
    );
    expect(result.results.map((row) => row.value)).toEqual([0, 17]);
    expect(result.results[0]?.attributes).toBe(',L,N,0800');
    expect(result.results[1]).not.toHaveProperty('attributes');
    expect(service.fetchData).toHaveBeenCalledWith(
      expect.objectContaining({ units: undefined, includemetadata: true, offset: 0 }),
      ctx,
    );
    expect(firstText(noaaClimateFetchData.format!(result))).toContain(',L,N,0800');
  });
  it('returns observation records for a valid date range', async () => {
    const ctx = createMockContext({ errors: noaaClimateFetchData.errors });
    const input = noaaClimateFetchData.input.parse({
      datasetId: 'GHCND',
      startDate: '2023-01-01',
      endDate: '2023-01-31',
      units: 'metric',
    });
    const result = await noaaClimateFetchData.handler(input, ctx);

    expect(result.results).toHaveLength(2);
    expect(result.results[0]).toMatchObject({
      date: '2023-01-01T00:00:00',
      datatype: 'TMAX',
      value: 22,
    });
    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalCount).toBe(2);
    expect(typeof enrichment.effectiveQuery).toBe('string');
    expect(enrichment.effectiveQuery as string).toContain('GHCND');
    expect(enrichment.effectiveQuery as string).toContain('metric');
    expect(enrichment).not.toHaveProperty('notice');
  });

  it('enriches with notice when no records returned', async () => {
    vi.mocked(getCdoService).mockReturnValue({
      fetchData: vi.fn().mockResolvedValue({
        results: [],
        metadata: { resultset: { count: 0, limit: 25, offset: 0 } },
      }),
    } as unknown as ReturnType<typeof getCdoService>);
    const ctx = createMockContext({ errors: noaaClimateFetchData.errors });
    const input = noaaClimateFetchData.input.parse({
      datasetId: 'GHCND',
      startDate: '2023-01-01',
      endDate: '2023-01-31',
    });
    await noaaClimateFetchData.handler(input, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalCount).toBe(0);
    expect(typeof enrichment.notice).toBe('string');
    expect(enrichment.notice as string).toContain('No observation records');
  });

  it('throws date_range_exceeded for GHCND with >365-day range', async () => {
    const ctx = createMockContext({ errors: noaaClimateFetchData.errors });
    const input = noaaClimateFetchData.input.parse({
      datasetId: 'GHCND',
      startDate: '2022-01-01',
      endDate: '2023-06-30',
    });
    await expect(noaaClimateFetchData.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'date_range_exceeded' },
    });
  });

  it('throws date_range_exceeded for GSOM with >10-year range', async () => {
    const ctx = createMockContext({ errors: noaaClimateFetchData.errors });
    const input = noaaClimateFetchData.input.parse({
      datasetId: 'GSOM',
      startDate: '2000-01-01',
      endDate: '2015-01-01',
    });
    await expect(noaaClimateFetchData.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'date_range_exceeded' },
    });
  });

  it('allows NORMAL_DLY within 1-year range', async () => {
    const ctx = createMockContext({ errors: noaaClimateFetchData.errors });
    const input = noaaClimateFetchData.input.parse({
      datasetId: 'NORMAL_DLY',
      startDate: '2010-01-01',
      endDate: '2010-12-31',
    });
    const result = await noaaClimateFetchData.handler(input, ctx);
    expect(result.results).toBeDefined();
  });

  it('allows GSOM within 10-year range', async () => {
    const ctx = createMockContext({ errors: noaaClimateFetchData.errors });
    const input = noaaClimateFetchData.input.parse({
      datasetId: 'GSOM',
      startDate: '2015-01-01',
      endDate: '2020-01-01', // ~5 years, well within 10-year limit
    });
    const result = await noaaClimateFetchData.handler(input, ctx);
    expect(result.results).toBeDefined();
  });

  it('throws validation_error for an unknown datasetId before calling the service', async () => {
    const ctx = createMockContext({ errors: noaaClimateFetchData.errors });
    const input = noaaClimateFetchData.input.parse({
      datasetId: 'BOGUS_DATASET',
      startDate: '2026-05-01',
      endDate: '2026-05-07',
    });
    await expect(noaaClimateFetchData.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'validation_error' },
    });
    // Service must not have been called
    const { getCdoService } = await import('@/services/cdo/cdo-service.js');
    expect(vi.mocked(getCdoService)().fetchData).not.toHaveBeenCalled();
  });

  it('validation_error for unknown datasetId includes a recovery hint', async () => {
    const ctx = createMockContext({ errors: noaaClimateFetchData.errors });
    const input = noaaClimateFetchData.input.parse({
      datasetId: 'TYPO_DATASET',
      startDate: '2026-05-01',
      endDate: '2026-05-07',
    });
    await expect(noaaClimateFetchData.handler(input, ctx)).rejects.toMatchObject({
      data: {
        reason: 'validation_error',
        recovery: { hint: expect.stringContaining('noaa_climate_list_datasets') },
      },
    });
  });

  it('validates the NEXRAD2 date range on the 1-year rule CDO enforces', async () => {
    const ctx = createMockContext({ errors: noaaClimateFetchData.errors });
    const input = noaaClimateFetchData.input.parse({
      datasetId: 'NEXRAD2',
      startDate: '2000-01-01',
      endDate: '2024-12-31',
    });
    await expect(noaaClimateFetchData.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'date_range_exceeded', maxEndDate: '2001-01-31' },
    });
  });

  it('accepts a NEXRAD2 range inside the 1-year rule', async () => {
    const ctx = createMockContext({ errors: noaaClimateFetchData.errors });
    const input = noaaClimateFetchData.input.parse({
      datasetId: 'NEXRAD2',
      startDate: '2020-03-10',
      endDate: '2021-03-31',
    });
    const result = await noaaClimateFetchData.handler(input, ctx);
    expect(result.results).toBeDefined();
  });

  it('preserves sparse upstream payloads — omits attributes when absent', async () => {
    const ctx = createMockContext({ errors: noaaClimateFetchData.errors });
    const input = noaaClimateFetchData.input.parse({
      datasetId: 'GHCND',
      startDate: '2023-01-01',
      endDate: '2023-01-31',
    });
    const result = await noaaClimateFetchData.handler(input, ctx);

    const tmin = result.results.find((r) => r.datatype === 'TMIN');
    expect(tmin!.attributes).toBeUndefined();
  });

  it('formats output as a table with date, type, station, value, and attributes', () => {
    const blocks = noaaClimateFetchData.format!({
      results: mockRecords,
      metadata: { resultset: { count: 2, limit: 25, offset: 0 } },
    });
    const text = firstText(blocks);
    expect(text).toContain('2023-01-01T00:00:00');
    expect(text).toContain('TMAX');
    expect(text).toContain('GHCND:USC00450974');
    expect(text).toContain('22');
    expect(text).toContain('T,,,');
    expect(text).toContain('0'); // offset
  });

  it('formats empty results with a neutral empty-page message', () => {
    const blocks = noaaClimateFetchData.format!({ results: [] });
    // format() cannot see `exhausted` — the line has to hold for a no-match
    // page and for a page past the end of a nonzero total alike.
    expect(firstText(blocks)).toContain('No records on this page.');
  });
});

/**
 * CDO `/data` pages captured from NORMAL_MLY and GSOM at GHCND:USW00024233.
 *
 * Under units=metric CDO converts the base-65 degree days, the diurnal
 * temperature range, and the temperature standard deviations with the
 * temperature offset: January MLY-HTDD-NORMAL is 711 °F-days under
 * units=standard and 377 under units=metric, where 711 × 5/9 is 395, and a
 * 0 °F-day MLY-CLDD-NORMAL comes back −18. The base-specific degree days,
 * base-only growing degree days, and GSOM's HTDD/CLDD convert correctly. Values
 * are written as JavaScript reads CDO's JSON (`377.0` is `377`).
 */
const record = (date: string, attributes: string) => (datatype: string, value: number) => ({
  date,
  datatype,
  station: 'GHCND:USW00024233',
  attributes,
  value,
});
const jan = record('2010-01-01T00:00:00', 'C');
const jul = record('2010-07-01T00:00:00', 'C');
const gsom = record('2024-01-01T00:00:00', ',W');
const NORMAL_MLY_JAN_METRIC = [
  jan('MLY-HTDD-NORMAL', 377),
  jan('MLY-PRCP-NORMAL', 141.48),
  jan('MLY-TAVG-NORMAL', 5.6),
  jan('MLY-TMAX-NORMAL', 8.4),
];
const NORMAL_MLY_JAN_STANDARD = [
  jan('MLY-HTDD-NORMAL', 711),
  jan('MLY-PRCP-NORMAL', 5.57),
  jan('MLY-TAVG-NORMAL', 42),
  jan('MLY-TMAX-NORMAL', 47.2),
];
const NORMAL_MLY_JAN_RAW = [
  jan('MLY-HTDD-NORMAL', 711),
  jan('MLY-PRCP-NORMAL', 557),
  jan('MLY-TAVG-NORMAL', 420),
  jan('MLY-TMAX-NORMAL', 472),
];
const NORMAL_MLY_JUL_METRIC = [
  jul('MLY-CLDD-NORMAL', 22),
  jul('MLY-GRDD-BASE50', 271),
  jul('MLY-HTDD-NORMAL', 9),
];
const NORMAL_MLY_JAN_BASES_METRIC = [
  jan('MLY-CLDD-BASE70', 0),
  jan('MLY-CLDD-NORMAL', -18),
  jan('MLY-GRDD-BASE50', 2),
  jan('MLY-HTDD-BASE60', 309),
  jan('MLY-HTDD-NORMAL', 377),
];
const NORMAL_MLY_JAN_SPREAD_METRIC = [
  jan('MLY-DUTR-NORMAL', -12.1),
  jan('MLY-DUTR-STDDEV', -17.1),
  jan('MLY-TAVG-NORMAL', 5.6),
  jan('MLY-TAVG-STDDEV', -16.2),
  jan('MLY-TMAX-STDDEV', -16.2),
];
const GSOM_JAN_2024_METRIC = [gsom('CLDD', 0), gsom('HTDD', 403), gsom('TAVG', 5.3)];

/**
 * Pages captured under units=metric at GHCND:USW00023183: April NORMAL_MLY,
 * NORMAL_ANN, and the April 15 NORMAL_DLY row. Which endings CDO offsets
 * depends on the dataset. On MLY and ANN the thresholded growing degree days
 * take the temperature offset like HTDD and CLDD (MLY-GRDD-TB4886 is 695
 * °F-days raw and reads 368, where 695 × 5/9 is 386), and the seasonal
 * DJF-DUTR-NORMAL does too. On DLY only the ranges and standard deviations do
 * (DLY-DUTR-NORMAL 25.1 °F reads −3.8): its degree days scale correctly
 * (DLY-CLDD-NORMAL 8 reads 4, DLY-GRDD-TB4886 23 reads 13).
 */
const phx = (date: string) => (datatype: string, value: number) => ({
  date,
  datatype,
  station: 'GHCND:USW00023183',
  attributes: 'S',
  value,
});
const phxApr = phx('2010-04-01T00:00:00');
const phxAnn = phx('2010-01-01T00:00:00');
const phxApr15 = phx('2010-04-15T00:00:00');
const NORMAL_MLY_PHX_APR_METRIC = [
  phxApr('MLY-GRDD-BASE50', 378),
  phxApr('MLY-GRDD-TB4886', 368),
  phxApr('MLY-GRDD-TB5086', 336),
  phxApr('MLY-HTDD-BASE60', 3),
  phxApr('MLY-HTDD-NORMAL', -7),
  phxApr('MLY-TAVG-NORMAL', 22.6),
];
const NORMAL_ANN_PHX_METRIC = [
  phxAnn('ANN-GRDD-BASE50', 5098),
  phxAnn('ANN-GRDD-TB4886', 4796),
  phxAnn('ANN-GRDD-TB5086', 4434),
  phxAnn('ANN-TAVG-NORMAL', 23.9),
  phxAnn('DJF-DUTR-NORMAL', 102),
  phxAnn('DJF-GRDD-BASE50', 369),
  phxAnn('DJF-GRDD-TB4886', 517),
];
const NORMAL_DLY_PHX_APR15_METRIC = [
  phxApr15('DLY-CLDD-NORMAL', 4),
  phxApr15('DLY-DUTR-NORMAL', -3.8),
  phxApr15('DLY-DUTR-STDDEV', -14.8),
  phxApr15('DLY-GRDD-BASE50', 12),
  phxApr15('DLY-GRDD-TB4886', 13),
  phxApr15('DLY-HTDD-NORMAL', 1),
  phxApr15('DLY-TAVG-STDDEV', -14),
  phxApr15('DLY-TMAX-NORMAL', 29.4),
];
/** NORMAL_HLY degree hours scale correctly: HLY-HTDH-NORMAL 25.6 under units=standard reads 14.3. */
const NORMAL_HLY_JAN_METRIC = [record('2010-01-01T12:00:00', 'S')('HLY-HTDH-NORMAL', 14.3)];

/**
 * NORMAL_MLY special values captured at GHCND:USW00024233 over the March–May
 * proxy months, one page per units mode. CDO returns the -7777 code itself with
 * units omitted, scales it with the datatype under units=standard (the
 * tenths-of-days counts read -777.7), and converts it under units=metric (the
 * whole-degree-day MLY-CLDD-NORMAL reads -4338). May MLY-CLDD-NORMAL is a real
 * 6 °F-days, −14 once mis-converted under metric.
 */
const mar = record('2010-03-01T00:00:00', 'C');
const apr = record('2010-04-01T00:00:00', 'C');
const may = record('2010-05-01T00:00:00', 'C');
const SPECIAL_PAGE = (code: number, scaled: number, mayCldd: number) => [
  mar('MLY-CLDD-NORMAL', code),
  apr('MLY-CLDD-NORMAL', code),
  apr('MLY-SNOW-NORMAL', 0),
  apr('MLY-TMIN-AVGNDS-LSTH032', scaled),
  may('MLY-CLDD-NORMAL', mayCldd),
  may('MLY-PRCP-AVGNDS-GE100HI', scaled),
];
const NORMAL_MLY_SPECIAL_RAW = SPECIAL_PAGE(-7777, -7777, 6);
const NORMAL_MLY_SPECIAL_STANDARD = SPECIAL_PAGE(-7777, -777.7, 6);
const NORMAL_MLY_SPECIAL_METRIC = SPECIAL_PAGE(-4338, -777.7, -14);
/** NORMAL_DLY captured at GHCND:USW00023169 under units=standard. */
const NORMAL_DLY_SPECIAL_STANDARD = [
  { ...record('2010-06-01T00:00:00', 'S')('DLY-HTDD-NORMAL', -7777), station: 'GHCND:USW00023169' },
  { ...record('2010-06-01T00:00:00', 'S')('DLY-TMIN-NORMAL', 70.3), station: 'GHCND:USW00023169' },
];
/** Not captured: the other three documented codes, to pin grouping and meanings. */
const ann = record('2010-01-01T00:00:00', 'C');
const NORMAL_ANN_DOCUMENTED_CODES_RAW = [
  ann('ANN-TMIN-PRBLST-T32FP90', -4444),
  ann('ANN-TMIN-PRBFST-T16FP10', -6666),
  ann('ANN-SNOW-NORMAL', -9999),
  ann('ANN-TMIN-PRBFST-T32FP10', -4444),
];
/** Not captured: a hundredths-of-an-inch datatype's code as units=standard scales it. */
const NORMAL_MLY_HUNDREDTHS_CODE_STANDARD = [
  jan('MLY-PRCP-NORMAL', -99.99),
  jan('MLY-TAVG-NORMAL', 42),
];

describe('noaaClimateFetchData — CDO NORMAL_* metric conversion and 1981–2010 routing', () => {
  type Units = 'metric' | 'standard' | undefined;
  type Data = { results: { datatype: string; value?: number }[]; notice?: string };

  function run(
    datasetId: string,
    units: Units,
    results: readonly CdoDataRecord[],
    extra: Record<string, unknown> = {},
  ) {
    vi.mocked(vi.mocked(getCdoService)().fetchData).mockResolvedValueOnce({
      results: [...results],
      metadata: { resultset: { count: results.length, limit: 25, offset: 1 } },
    });
    return runToolContract(noaaClimateFetchData, {
      datasetId,
      startDate: '2010-01-01',
      endDate: '2010-12-31',
      units,
      ...extra,
    });
  }

  it('warns of mis-converted degree days on both surfaces, keeps CDO values, and composes notices', async () => {
    const result = await run('NORMAL_MLY', 'metric', NORMAL_MLY_JAN_METRIC, {
      stationId: ['usw00024233'],
      limit: 1001,
    });
    const data = result.structuredContent as Data;
    expect(data.results.map((row) => [row.datatype, row.value])).toEqual([
      ['MLY-HTDD-NORMAL', 377],
      ['MLY-PRCP-NORMAL', 141.48],
      ['MLY-TAVG-NORMAL', 5.6],
      ['MLY-TMAX-NORMAL', 8.4],
    ]);
    const text = JSON.stringify(result.content);
    for (const surface of [data.notice ?? '', text]) {
      expect(surface).toContain('mis-converts MLY-HTDD-NORMAL on this page');
      // units=standard leaves the seasonal ranges unscaled, so the recipe starts from raw values.
      expect(surface).toContain(
        'Re-request with units omitted and convert the raw values: degree days are whole °F-days (multiply by 5/9 for °C-days); diurnal ranges and standard deviations are tenths °F (multiply by 1/18 for °C).',
      );
      expect(surface).not.toContain('units=standard');
      expect(surface).toContain('clamped to 1000');
      expect(surface).toContain('GHCND:USW00024233');
      expect(surface).toContain('noaa_climate_get_normals');
    }
    expect(firstText(result.content)).toContain('| 377 |');
  });

  it.each([
    [
      'July degree days, base-only growing degree days excluded',
      NORMAL_MLY_JUL_METRIC,
      ['MLY-CLDD-NORMAL', 'MLY-HTDD-NORMAL'],
    ],
    [
      'base-65 degree days, base-specific ones excluded',
      NORMAL_MLY_JAN_BASES_METRIC,
      ['MLY-CLDD-NORMAL', 'MLY-HTDD-NORMAL'],
    ],
    [
      'diurnal ranges and standard deviations, the mean temperature excluded',
      NORMAL_MLY_JAN_SPREAD_METRIC,
      ['MLY-DUTR-NORMAL', 'MLY-DUTR-STDDEV', 'MLY-TAVG-STDDEV', 'MLY-TMAX-STDDEV'],
    ],
    [
      'a datatype repeated across months, named once',
      [...NORMAL_MLY_JAN_METRIC, ...NORMAL_MLY_JUL_METRIC],
      ['MLY-HTDD-NORMAL', 'MLY-CLDD-NORMAL'],
    ],
  ])('names exactly the mis-converted datatypes: %s', async (_label, results, flagged) => {
    const result = await run('NORMAL_MLY', 'metric', results);
    const phrase = `mis-converts ${flagged.join(', ')} on this page`;
    expect((result.structuredContent as Data).notice).toContain(phrase);
    expect(JSON.stringify(result.content)).toContain(phrase);
  });

  it.each([
    [
      'NORMAL_MLY',
      'thresholded growing degree days with HTDD, base-specific ones excluded',
      NORMAL_MLY_PHX_APR_METRIC,
      ['MLY-GRDD-TB4886', 'MLY-GRDD-TB5086', 'MLY-HTDD-NORMAL'],
    ],
    [
      'NORMAL_ANN',
      'annual and seasonal thresholded growing degree days and the seasonal range',
      NORMAL_ANN_PHX_METRIC,
      ['ANN-GRDD-TB4886', 'ANN-GRDD-TB5086', 'DJF-DUTR-NORMAL', 'DJF-GRDD-TB4886'],
    ],
    [
      'NORMAL_DLY',
      'ranges and standard deviations only, its degree days excluded',
      NORMAL_DLY_PHX_APR15_METRIC,
      ['DLY-DUTR-NORMAL', 'DLY-DUTR-STDDEV', 'DLY-TAVG-STDDEV'],
    ],
  ])(
    'names exactly the %s datatypes CDO offsets: %s',
    async (datasetId, _label, results, flagged) => {
      const result = await run(datasetId, 'metric', results);
      const data = result.structuredContent as Data;
      expect(data.results.map((row) => row.value)).toEqual(results.map((row) => row.value));
      const phrase = `mis-converts ${flagged.join(', ')} on this page`;
      expect(data.notice).toContain(phrase);
      expect(JSON.stringify(result.content)).toContain(phrase);
    },
  );

  it.each([
    ['units=standard', 'NORMAL_MLY', 'standard', NORMAL_MLY_JAN_STANDARD],
    ['omitted units', 'NORMAL_MLY', undefined, NORMAL_MLY_JAN_RAW],
    [
      'a NORMAL_* page without an affected datatype',
      'NORMAL_MLY',
      'metric',
      NORMAL_MLY_JAN_METRIC.slice(1),
    ],
    ['a GSOM page carrying HTDD and CLDD', 'GSOM', 'metric', GSOM_JAN_2024_METRIC],
    ['a NORMAL_HLY page carrying degree hours', 'NORMAL_HLY', 'metric', NORMAL_HLY_JAN_METRIC],
  ] as const)('adds no conversion warning for %s', async (_label, datasetId, units, results) => {
    const result = await run(datasetId, units, results);
    const data = result.structuredContent as Data;
    expect(data.results.map((row) => row.value)).toEqual(results.map((row) => row.value));
    for (const surface of [data.notice ?? '', JSON.stringify(result.content)]) {
      expect(surface).not.toContain('mis-converts');
      expect(surface).not.toContain('5/9');
    }
  });

  it.each([
    ['NORMAL_MLY', 'standard', true],
    ['normal_dly', 'metric', true],
    ['GSOM', 'metric', false],
    ['GHCND', undefined, false],
  ] as const)(
    'routes %s (units %s) to the 1991–2020 normals tool: %s',
    async (datasetId, units, routed) => {
      const result = await run(datasetId, units, []);
      const data = result.structuredContent as Data;
      for (const surface of [data.notice ?? '', JSON.stringify(result.content)]) {
        if (routed) {
          expect(surface).toContain('superseded 1981–2010 normals');
          expect(surface).toContain('noaa_climate_get_normals');
        } else expect(surface).not.toContain('noaa_climate_get_normals');
      }
    },
  );

  it('routes a 1991–2020 date range on a NORMAL_* dataset to noaa_climate_get_normals', async () => {
    const ctx = createMockContext({ errors: noaaClimateFetchData.errors });
    const input = noaaClimateFetchData.input.parse({
      datasetId: 'NORMAL_MLY',
      startDate: '1991-01-01',
      endDate: '2020-12-31',
    });
    await expect(noaaClimateFetchData.handler(input, ctx)).rejects.toMatchObject({
      data: {
        reason: 'date_range_exceeded',
        recovery: { hint: expect.stringContaining('noaa_climate_get_normals') },
      },
    });
    const declared = noaaClimateFetchData.errors?.find((e) => e.reason === 'date_range_exceeded');
    expect(declared?.recovery).toContain('noaa_climate_get_normals');
  });

  const ROUNDS_TO_ZERO = '-7777 (a non-zero value that would round to zero)';

  it.each([
    [
      'NORMAL_MLY codes with units omitted',
      'NORMAL_MLY',
      undefined,
      NORMAL_MLY_SPECIAL_RAW,
      `${ROUNDS_TO_ZERO} in MLY-CLDD-NORMAL, MLY-TMIN-AVGNDS-LSTH032, MLY-PRCP-AVGNDS-GE100HI.`,
    ],
    [
      'NORMAL_MLY codes scaled under units=standard',
      'NORMAL_MLY',
      'standard',
      NORMAL_MLY_SPECIAL_STANDARD,
      `${ROUNDS_TO_ZERO} in MLY-CLDD-NORMAL, MLY-TMIN-AVGNDS-LSTH032 as -777.7, MLY-PRCP-AVGNDS-GE100HI as -777.7. Under units=standard CDO scales a code with its datatype.`,
    ],
    [
      'a NORMAL_DLY code under units=standard',
      'NORMAL_DLY',
      'standard',
      NORMAL_DLY_SPECIAL_STANDARD,
      `${ROUNDS_TO_ZERO} in DLY-HTDD-NORMAL.`,
    ],
    [
      'the other documented codes, grouped by code',
      'NORMAL_ANN',
      undefined,
      NORMAL_ANN_DOCUMENTED_CODES_RAW,
      '-4444 (year-round risk of frost-freeze) in ANN-TMIN-PRBLST-T32FP90, ANN-TMIN-PRBFST-T32FP10; -6666 (parameter undefined: too few occurrences to compute) in ANN-TMIN-PRBFST-T16FP10; -9999 (missing or insufficient data) in ANN-SNOW-NORMAL.',
    ],
    [
      'a hundredths-scaled code under units=standard',
      'NORMAL_MLY',
      'standard',
      NORMAL_MLY_HUNDREDTHS_CODE_STANDARD,
      '-9999 (missing or insufficient data) in MLY-PRCP-NORMAL as -99.99. Under units=standard CDO scales a code with its datatype.',
    ],
  ] as const)(
    'names NCEI special values on both surfaces: %s',
    async (_label, datasetId, units, results, groups) => {
      const result = await run(datasetId, units, results);
      const data = result.structuredContent as Data;
      expect(data.results.map((row) => row.value)).toEqual(results.map((row) => row.value));
      const phrase = `NCEI special values on this page are codes, not measurements, and are kept as CDO returned them: ${groups}`;
      expect(data.notice).toContain(phrase);
      expect(JSON.stringify(result.content)).toContain(phrase);
      expect(firstText(result.content)).toContain(`| ${results[0]!.value} |`);
      if (units !== 'standard' || datasetId === 'NORMAL_DLY')
        expect(data.notice).not.toContain('scales a code');
    },
  );

  it('names converted special values under units=metric on both surfaces and composes with the mis-conversion notice', async () => {
    const result = await run('NORMAL_MLY', 'metric', NORMAL_MLY_SPECIAL_METRIC);
    const data = result.structuredContent as Data;
    expect(data.results.map((row) => row.value)).toEqual([-4338, -4338, 0, -777.7, -14, -777.7]);
    for (const surface of [data.notice ?? '', JSON.stringify(result.content)]) {
      expect(surface).toContain(
        "MLY-CLDD-NORMAL, MLY-TMIN-AVGNDS-LSTH032, MLY-PRCP-AVGNDS-GE100HI carry values on this page far below any normal's range",
      );
      expect(surface).toContain('-7777 a non-zero value that would round to zero');
      expect(surface).toContain('converted under units=metric');
      expect(surface).toContain('not a measurement');
      expect(surface).toContain('omit units');
      expect(surface).toContain('mis-converts MLY-CLDD-NORMAL on this page');
    }
  });

  it.each([
    ['a NORMAL_* page under units=standard', 'NORMAL_MLY', 'standard', NORMAL_MLY_JAN_STANDARD],
    ['a NORMAL_* page with units omitted', 'NORMAL_MLY', undefined, NORMAL_MLY_JAN_RAW],
    ['mis-converted metric normals', 'NORMAL_MLY', 'metric', NORMAL_MLY_JAN_BASES_METRIC],
    ['a GHCND page carrying -7777', 'GHCND', undefined, [jan('TMIN', -7777)]],
    ['a GHCND page carrying -4338 under units=metric', 'GHCND', 'metric', [jan('TMIN', -4338)]],
  ] as const)('adds no special-value notice for %s', async (_label, datasetId, units, results) => {
    const result = await run(datasetId, units, results);
    const data = result.structuredContent as Data;
    expect(data.results.map((row) => row.value)).toEqual(results.map((row) => row.value));
    for (const surface of [data.notice ?? '', JSON.stringify(result.content)]) {
      expect(surface).not.toContain('NCEI special');
    }
  });

  it('describes NORMAL_* as the superseded 1981–2010 normals and warns about metric spreads', () => {
    const { shape } = noaaClimateFetchData.input;
    for (const text of [noaaClimateFetchData.description, shape.datasetId.description]) {
      expect(text).toContain('superseded 1981–2010 normals');
      expect(text).toContain('noaa_climate_get_normals');
    }
    expect(shape.units.description).toContain('NORMAL_*');
    expect(shape.units.description).toContain(
      '-HTDD-NORMAL, -CLDD-NORMAL, -GRDD-TB4886, -GRDD-TB5086, and -DUTR-NORMAL on NORMAL_MLY and NORMAL_ANN; -STDDEV on NORMAL_MLY; -DUTR-NORMAL and -STDDEV on NORMAL_DLY',
    );
    expect(shape.units.description).toContain(
      'omit units and convert the raw values (whole °F-day degree days ×5/9, tenths-°F ranges and standard deviations ×1/18)',
    );
    expect(shape.units.description).not.toContain('request standard and multiply');
  });
});
