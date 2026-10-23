/**
 * @fileoverview Tests for the noaa_climate_list_datasets tool.
 * @module tests/tools/noaa-climate-list-datasets.tool.test
 */

import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { noaaClimateListDatasets } from '@/mcp-server/tools/definitions/noaa-climate-list-datasets.tool.js';
import { firstText } from '../helpers/content.js';

// Mock the service module so tests don't hit the network
vi.mock('@/services/cdo/cdo-service.js', () => ({
  getCdoService: vi.fn(),
}));

import { getCdoService } from '@/services/cdo/cdo-service.js';

const mockDatasets = [
  {
    id: 'GHCND',
    name: 'Daily Summaries',
    datacoverage: 1,
    mindate: '1763-01-01',
    maxdate: '2024-12-31',
  },
  {
    id: 'GSOM',
    name: 'Global Summary of the Month',
    datacoverage: 0.95,
    mindate: '1763-01-01',
    maxdate: '2024-12-31',
  },
];

const mockResponse = {
  results: mockDatasets,
  metadata: { resultset: { count: 2, limit: 25, offset: 0 } },
};

beforeEach(() => {
  vi.mocked(getCdoService).mockReturnValue({
    listDatasets: vi.fn().mockResolvedValue(mockResponse),
  } as unknown as ReturnType<typeof getCdoService>);
});

describe('noaaClimateListDatasets', () => {
  it('composes a date-filtered empty page with the applied limit notice', async () => {
    const result = await runToolContract(noaaClimateListDatasets, {
      startDate: '21000101',
      limit: 1001,
      offset: 1000,
    });
    expect(result.structuredContent).toMatchObject({
      results: [],
      totalCount: 0,
      metadata: { resultset: { count: 0, limit: 1000, offset: 1000 } },
      notice: expect.stringContaining('clamped to 1000'),
    });
    expect(result.structuredContent).not.toHaveProperty('exhausted');
    expect(JSON.stringify(result.content)).toContain('No datasets matched');
    expect(JSON.stringify(result.content)).toContain('clamped to 1000');
    expect(getCdoService().listDatasets).toHaveBeenCalledTimes(1);
  });
  it('shares the catalog deadline across pages and never returns a timed-out partial result', async () => {
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
    const signals: AbortSignal[] = [];
    const listDatasets = vi.fn(async (_params, context) => {
      signals.push(context.signal);
      if (signals.length === 2)
        deadline.abort(new DOMException('Catalog deadline reached', 'TimeoutError'));
      return {
        results: [mockDatasets[0]!],
        metadata: { resultset: { count: 3, limit: 1, offset: signals.length } },
      };
    });
    vi.mocked(getCdoService).mockReturnValue({ listDatasets } as unknown as ReturnType<
      typeof getCdoService
    >);
    try {
      await expect(
        noaaClimateListDatasets.handler(
          noaaClimateListDatasets.input.parse({ startDate: '20200101' }),
          createMockContext({ errors: noaaClimateListDatasets.errors }),
        ),
      ).rejects.toMatchObject({ name: 'TimeoutError' });
      expect(timeout).toHaveBeenCalledExactlyOnceWith(45_000);
      expect(signals[0]).toBe(signals[1]);
      expect(listDatasets).toHaveBeenCalledTimes(2);
    } finally {
      timeout.mockRestore();
    }
  });
  it.each([0, 1, 2, 3])(
    'filters a complete two-page catalog before slicing offset %s',
    async (offset) => {
      const catalog = [
        { ...mockDatasets[0]!, id: 'OLD', maxdate: '1900-01-01' },
        { ...mockDatasets[0]!, id: 'B' },
        { ...mockDatasets[0]!, id: 'A' },
      ];
      const listDatasets = vi
        .fn()
        .mockResolvedValueOnce({
          results: catalog.slice(0, 2),
          metadata: { resultset: { count: 3, limit: 2, offset: 1 } },
        })
        .mockResolvedValueOnce({ results: catalog.slice(2) });
      vi.mocked(getCdoService).mockReturnValue({ listDatasets } as unknown as ReturnType<
        typeof getCdoService
      >);
      const result = await runToolContract(noaaClimateListDatasets, {
        startDate: '20200101',
        limit: 1,
        offset,
        sortField: 'name',
        sortOrder: 'desc',
        datatypeId: ['TMAX'],
        stationId: 'GHCND:USW00024233',
        locationId: 'FIPS:53',
      });
      expect(result.isError).not.toBe(true);
      const output = noaaClimateListDatasets.output.parse(result.structuredContent);
      expect(output.results.map((row) => row.id)).toEqual(
        offset === 0 ? ['B'] : offset === 1 ? ['A'] : [],
      );
      expect(output.metadata?.resultset).toEqual({ count: 2, limit: 1, offset });
      expect(result.structuredContent).toMatchObject({ totalCount: 2 });
      expect(JSON.stringify(result.content)).toContain(
        `**Total:** 2 | **Limit:** 1 | **Offset:** ${offset}`,
      );
      if (offset >= 2) {
        expect(result.structuredContent).toMatchObject({
          exhausted: true,
          notice: expect.stringContaining('past the end of 2'),
        });
        expect(JSON.stringify(result.content)).toContain('past the end of 2');
      }
      expect(listDatasets).toHaveBeenCalledTimes(2);
      for (const [index, [params]] of listDatasets.mock.calls.entries()) {
        expect(params).toEqual({
          datatypeid: ['TMAX'],
          stationid: 'GHCND:USW00024233',
          locationid: 'FIPS:53',
          sortfield: 'name',
          sortorder: 'desc',
          limit: 1000,
          offset: index === 0 ? 0 : 2,
        });
      }
    },
  );
  it('fails with recovery instead of returning a partial catalog when a later page makes no progress', async () => {
    const listDatasets = vi
      .fn()
      .mockResolvedValueOnce({
        results: mockDatasets,
        metadata: { resultset: { count: 3, limit: 2, offset: 1 } },
      })
      .mockResolvedValueOnce({});
    vi.mocked(getCdoService).mockReturnValue({ listDatasets } as unknown as ReturnType<
      typeof getCdoService
    >);
    const result = await runToolContract(noaaClimateListDatasets, { startDate: '20200101' });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        data: {
          reason: 'service_unavailable',
          recovery: { hint: expect.stringContaining('retry') },
        },
      },
    });
    expect(JSON.stringify(result.content)).toContain('incomplete dataset catalog');
    expect(listDatasets).toHaveBeenCalledTimes(2);
  });
  it('honors caller cancellation between catalog pages', async () => {
    const controller = new AbortController();
    const listDatasets = vi.fn(async () => {
      controller.abort();
      return { results: mockDatasets, metadata: { resultset: { count: 3, limit: 2, offset: 1 } } };
    });
    vi.mocked(getCdoService).mockReturnValue({ listDatasets } as unknown as ReturnType<
      typeof getCdoService
    >);
    await expect(
      noaaClimateListDatasets.handler(
        noaaClimateListDatasets.input.parse({ startDate: '20200101' }),
        createMockContext({ errors: noaaClimateListDatasets.errors, signal: controller.signal }),
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(listDatasets).toHaveBeenCalledTimes(1);
  });
  it.each([
    [{ startDate: '21000101' }, []],
    [{ endDate: '1600-1-1' }, []],
    [{ startDate: '2024-12-31' }, ['GHCND', 'GSOM']],
    [{ endDate: '17630101' }, ['GHCND', 'GSOM']],
    [{ startDate: '2024-12-31T00:00:00.001' }, []],
  ])('locally filters dataset coverage %j', async (dates, ids) => {
    const result = await runToolContract(noaaClimateListDatasets, dates);
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      results: ids.map((id) => ({ id })),
      totalCount: ids.length,
      metadata: { resultset: { count: ids.length, limit: 25, offset: 0 } },
    });
    const parsed = noaaClimateListDatasets.output.parse(result.structuredContent);
    expect(parsed.results.map((row) => row.id)).toEqual(ids);
    expect(JSON.stringify(result.content)).toContain(`**Total:** ${ids.length}`);
    expect(getCdoService().listDatasets).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 1000, offset: 0 }),
      expect.anything(),
    );
    const params = vi.mocked(getCdoService().listDatasets).mock.calls[0]![0];
    expect(params).not.toHaveProperty('startdate');
    expect(params).not.toHaveProperty('enddate');
  });
  it.each([0, 0.9969, 1])('preserves fractional coverage %s', (datacoverage) => {
    expect(
      firstText(
        noaaClimateListDatasets.format!({ results: [{ ...mockDatasets[0]!, datacoverage }] }),
      ),
    ).toContain(`**Coverage (0–1):** ${datacoverage}`);
  });
  it('returns dataset results with metadata', async () => {
    const ctx = createMockContext({ errors: noaaClimateListDatasets.errors });
    const input = noaaClimateListDatasets.input.parse({});
    const result = await noaaClimateListDatasets.handler(input, ctx);

    expect(result.results).toHaveLength(2);
    expect(result.results[0]).toMatchObject({
      id: 'GHCND',
      name: 'Daily Summaries',
      datacoverage: 1,
    });
    expect(result.metadata?.resultset.count).toBe(2);
    expect(getEnrichment(ctx)).toMatchObject({ totalCount: 2 });
    expect(getEnrichment(ctx)).not.toHaveProperty('notice');
  });

  it('returns empty results gracefully when API returns no data', async () => {
    vi.mocked(getCdoService).mockReturnValue({
      listDatasets: vi
        .fn()
        .mockResolvedValue({ metadata: { resultset: { count: 0, limit: 25, offset: 0 } } }),
    } as unknown as ReturnType<typeof getCdoService>);

    const ctx = createMockContext({ errors: noaaClimateListDatasets.errors });
    const input = noaaClimateListDatasets.input.parse({});
    const result = await noaaClimateListDatasets.handler(input, ctx);

    expect(result.results).toEqual([]);
    expect(result.metadata?.resultset.count).toBe(0);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalCount).toBe(0);
    expect(typeof enrichment.notice).toBe('string');
    expect(enrichment.notice as string).toContain('No datasets matched');
  });

  it('passes filter params to the service', async () => {
    const mockService = {
      listDatasets: vi.fn().mockResolvedValue(mockResponse),
    } as unknown as ReturnType<typeof getCdoService>;
    vi.mocked(getCdoService).mockReturnValue(mockService);

    const ctx = createMockContext({ errors: noaaClimateListDatasets.errors });
    const input = noaaClimateListDatasets.input.parse({
      datatypeId: ['TMAX'],
      locationId: 'FIPS:37',
      limit: 10,
    });
    await noaaClimateListDatasets.handler(input, ctx);

    expect(mockService.listDatasets).toHaveBeenCalledWith(
      expect.objectContaining({ datatypeid: ['TMAX'], locationid: 'FIPS:37', limit: 10 }),
      ctx,
    );
  });

  it('formats output with dataset IDs, names, coverage, and dates', () => {
    const blocks = noaaClimateListDatasets.format!({
      results: mockDatasets,
      metadata: { resultset: { count: 2, limit: 25, offset: 0 } },
    });
    expect(blocks[0]?.type).toBe('text');
    const text = firstText(blocks);
    expect(text).toContain('GHCND');
    expect(text).toContain('Daily Summaries');
    expect(text).toContain('1763-01-01');
    expect(text).toContain('2024-12-31');
    expect(text).toContain('**Coverage (0–1):** 1');
    expect(text).toContain('0'); // offset
  });

  it('formats empty results with a neutral empty-page message', () => {
    const blocks = noaaClimateListDatasets.format!({
      results: [],
      metadata: { resultset: { count: 0, limit: 25, offset: 0 } },
    });
    expect(firstText(blocks)).toContain('No records on this page.');
  });
});
