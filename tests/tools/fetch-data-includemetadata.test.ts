/**
 * @fileoverview Tests for noaa_climate_fetch_data's includemetadata handling —
 * the client-facing flag must control only the tool's own output, never whether
 * the server can determine the true total.
 * @module tests/tools/fetch-data-includemetadata.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it, vi } from 'vitest';
import { noaaClimateFetchData } from '@/mcp-server/tools/definitions/noaa-climate-fetch-data.tool.js';
import { firstText } from '../helpers/content.js';

vi.mock('@/services/cdo/cdo-service.js', () => ({
  getCdoService: vi.fn(),
}));

import { getCdoService } from '@/services/cdo/cdo-service.js';

const TOTAL = 7;

const record = {
  date: '2024-07-01T00:00:00',
  datatype: 'TMAX',
  station: 'GHCND:USC00450482',
  value: 25.6,
};

/**
 * Mirrors the live CDO /data contract: the `metadata` block is emitted only when
 * the request asked for it, and its `count` is the full match total regardless
 * of the page limit.
 */
function cdoFetchData() {
  return vi.fn(async (params: { limit?: number; offset?: number; includemetadata?: boolean }) => {
    const limit = params.limit ?? 25;
    const offset = params.offset ?? 0;
    const results = Array.from({ length: Math.max(0, Math.min(limit, TOTAL - offset)) }, () => ({
      ...record,
    }));
    if (params.includemetadata === false) return { results };
    return { results, metadata: { resultset: { count: TOTAL, limit, offset: offset + 1 } } };
  });
}

function mockService() {
  const fetchData = cdoFetchData();
  vi.mocked(getCdoService).mockReturnValue({ fetchData } as unknown as ReturnType<
    typeof getCdoService
  >);
  return fetchData;
}

const base = {
  datasetId: 'GHCND',
  startDate: '2024-07-01',
  endDate: '2024-07-07',
  stationId: ['GHCND:USC00450482'],
  datatypeId: ['TMAX'],
  units: 'metric' as const,
};

describe('noaa_climate_fetch_data — includemetadata decoupling', () => {
  it('always requests metadata upstream, even when the client disabled it', async () => {
    const fetchData = mockService();
    const ctx = createMockContext({ errors: noaaClimateFetchData.errors });
    const input = noaaClimateFetchData.input.parse({
      ...base,
      limit: 2,
      includemetadata: false,
    });

    await noaaClimateFetchData.handler(input, ctx);

    expect(fetchData).toHaveBeenCalledWith(expect.objectContaining({ includemetadata: true }), ctx);
  });

  it('preserves the true total when the client disabled output metadata', async () => {
    mockService();
    const ctx = createMockContext({ errors: noaaClimateFetchData.errors });
    const input = noaaClimateFetchData.input.parse({
      ...base,
      limit: 2,
      includemetadata: false,
    });

    const result = await noaaClimateFetchData.handler(input, ctx);

    expect(result.results).toHaveLength(2);
    expect(result.metadata).toBeUndefined();
    expect(getEnrichment(ctx).totalCount).toBe(TOTAL);
  });

  it('omits metadata from structuredContent when includemetadata is false', async () => {
    mockService();
    const ctx = createMockContext({ errors: noaaClimateFetchData.errors });
    const input = noaaClimateFetchData.input.parse({ ...base, limit: 2, includemetadata: false });

    const result = await noaaClimateFetchData.handler(input, ctx);

    expect(Object.hasOwn(result, 'metadata')).toBe(false);
  });

  it('omits the pagination header from content[] when includemetadata is false', async () => {
    mockService();
    const ctx = createMockContext({ errors: noaaClimateFetchData.errors });
    const input = noaaClimateFetchData.input.parse({ ...base, limit: 2, includemetadata: false });

    const result = await noaaClimateFetchData.handler(input, ctx);
    const blocks = noaaClimateFetchData.format!(result);
    const text = firstText(blocks);

    expect(text).not.toContain('Total records:');
    expect(text).toContain('GHCND:USC00450482');
  });

  it('returns metadata with the caller offset when includemetadata is true', async () => {
    mockService();
    const ctx = createMockContext({ errors: noaaClimateFetchData.errors });
    const input = noaaClimateFetchData.input.parse({ ...base, limit: 2, includemetadata: true });

    const result = await noaaClimateFetchData.handler(input, ctx);

    expect(result.metadata).toEqual({ resultset: { count: TOTAL, limit: 2, offset: 0 } });
    expect(getEnrichment(ctx).totalCount).toBe(TOTAL);
  });

  it('renders the pagination header in content[] when includemetadata is true', async () => {
    mockService();
    const ctx = createMockContext({ errors: noaaClimateFetchData.errors });
    const input = noaaClimateFetchData.input.parse({ ...base, limit: 2, includemetadata: true });

    const result = await noaaClimateFetchData.handler(input, ctx);
    const blocks = noaaClimateFetchData.format!(result);
    const text = firstText(blocks);

    expect(text).toContain('Total records:');
    expect(text).toContain(String(TOTAL));
  });

  it('defaults to including metadata when the flag is omitted', async () => {
    mockService();
    const ctx = createMockContext({ errors: noaaClimateFetchData.errors });
    const input = noaaClimateFetchData.input.parse(base);

    const result = await noaaClimateFetchData.handler(input, ctx);

    expect(result.metadata).toBeDefined();
    expect(getEnrichment(ctx).totalCount).toBe(TOTAL);
  });

  it('never substitutes the page length for the total', async () => {
    mockService();
    const ctx = createMockContext({ errors: noaaClimateFetchData.errors });
    const input = noaaClimateFetchData.input.parse({ ...base, limit: 2, includemetadata: false });

    const result = await noaaClimateFetchData.handler(input, ctx);

    expect(getEnrichment(ctx).totalCount).not.toBe(result.results.length);
  });
});
