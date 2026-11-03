/**
 * @fileoverview Tests for the noaa_climate_fetch_data tool.
 * @module tests/tools/noaa-climate-fetch-data.tool.test
 */

import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { noaaClimateFetchData } from '@/mcp-server/tools/definitions/noaa-climate-fetch-data.tool.js';
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
