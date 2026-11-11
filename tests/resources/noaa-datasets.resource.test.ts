/**
 * @fileoverview Tests for the noaa://datasets resource.
 * @module tests/resources/noaa-datasets.resource.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { noaaDatasetsResource } from '@/mcp-server/resources/definitions/noaa-datasets.resource.js';

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

beforeEach(() => {
  vi.mocked(getCdoService).mockReturnValue({
    listDatasets: vi.fn().mockResolvedValue({
      results: mockDatasets,
      metadata: { resultset: { count: 2, limit: 1000, offset: 0 } },
    }),
  } as unknown as ReturnType<typeof getCdoService>);
});

describe('noaaDatasetsResource', () => {
  it('returns all datasets via listDatasets with limit=1000', async () => {
    const mockService = {
      listDatasets: vi.fn().mockResolvedValue({
        results: mockDatasets,
        metadata: { resultset: { count: 2, limit: 1000, offset: 0 } },
      }),
    } as unknown as ReturnType<typeof getCdoService>;
    vi.mocked(getCdoService).mockReturnValue(mockService);

    const ctx = createMockContext();
    const result = await noaaDatasetsResource.handler({}, ctx);

    expect(mockService.listDatasets).toHaveBeenCalledWith({ limit: 1000 }, ctx);
    expect(result).toMatchObject({ datasets: mockDatasets });
    expect((result as { datasets: typeof mockDatasets }).datasets).toHaveLength(2);
  });

  it('returns empty datasets array when API returns no results', async () => {
    vi.mocked(getCdoService).mockReturnValue({
      listDatasets: vi.fn().mockResolvedValue({}),
    } as unknown as ReturnType<typeof getCdoService>);

    const ctx = createMockContext();
    const result = await noaaDatasetsResource.handler({}, ctx);

    expect((result as { datasets: unknown[] }).datasets).toEqual([]);
  });

  it('returns empty datasets array when results field is null/missing', async () => {
    vi.mocked(getCdoService).mockReturnValue({
      listDatasets: vi.fn().mockResolvedValue({ results: null }),
    } as unknown as ReturnType<typeof getCdoService>);

    const ctx = createMockContext();
    const result = await noaaDatasetsResource.handler({}, ctx);

    expect((result as { datasets: unknown[] }).datasets).toEqual([]);
  });

  it('propagates service errors without swallowing them', async () => {
    vi.mocked(getCdoService).mockReturnValue({
      listDatasets: vi.fn().mockRejectedValue(new Error('NOAA CDO returned HTTP 503')),
    } as unknown as ReturnType<typeof getCdoService>);

    const ctx = createMockContext();
    await expect(noaaDatasetsResource.handler({}, ctx)).rejects.toThrow();
  });

  it('dataset objects preserve id, name, and coverage fields', async () => {
    const ctx = createMockContext();
    const result = await noaaDatasetsResource.handler({}, ctx);
    const datasets = (result as { datasets: typeof mockDatasets }).datasets;

    expect(datasets[0]!.id).toBe('GHCND');
    expect(datasets[0]!.name).toBe('Daily Summaries');
    expect(datasets[0]!.datacoverage).toBe(1);
    expect(datasets[0]!.mindate).toBe('1763-01-01');
    expect(datasets[0]!.maxdate).toBe('2024-12-31');
  });

  it('describes NORMAL_* as the superseded 1981–2010 normals and names noaa_climate_get_normals', () => {
    expect(noaaDatasetsResource.description).toContain('superseded 1981–2010 normals');
    expect(noaaDatasetsResource.description).toContain('noaa_climate_get_normals');
  });
});
