/**
 * @fileoverview Extended tests for noaa_climate_list_data_categories — params forwarding,
 * input validation, and error propagation.
 * @module tests/tools/noaa-list-data-categories-extended.tool.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { noaaClimateListDataCategories } from '@/mcp-server/tools/definitions/noaa-climate-list-data-categories.tool.js';

vi.mock('@/services/cdo/cdo-service.js', () => ({
  getCdoService: vi.fn(),
}));

import { getCdoService } from '@/services/cdo/cdo-service.js';

const mockResponse = {
  results: [
    { id: 'TEMP', name: 'Air Temperature' },
    { id: 'PRCP', name: 'Precipitation' },
  ],
  metadata: { resultset: { count: 2, limit: 25, offset: 0 } },
};

beforeEach(() => {
  vi.mocked(getCdoService).mockReturnValue({
    listDataCategories: vi.fn().mockResolvedValue(mockResponse),
  } as unknown as ReturnType<typeof getCdoService>);
});

describe('noaaClimateListDataCategories — input validation', () => {
  it('rejects limit=0', () => {
    expect(() => noaaClimateListDataCategories.input.parse({ limit: 0 })).toThrow();
  });

  it('retains an oversized positive limit for handler clamping', () => {
    expect(noaaClimateListDataCategories.input.parse({ limit: 1001 }).limit).toBe(1001);
  });

  it('rejects negative offset', () => {
    expect(() => noaaClimateListDataCategories.input.parse({ offset: -1 })).toThrow();
  });

  it('rejects invalid sortField', () => {
    expect(() => noaaClimateListDataCategories.input.parse({ sortField: 'coverage' })).toThrow();
  });

  it('accepts sortField=id and sortField=name', () => {
    expect(noaaClimateListDataCategories.input.parse({ sortField: 'id' }).sortField).toBe('id');
    expect(noaaClimateListDataCategories.input.parse({ sortField: 'name' }).sortField).toBe('name');
  });
});

describe('noaaClimateListDataCategories — all filter params forwarded', () => {
  it('forwards datasetId, locationId, stationId, date range, sort, and pagination', async () => {
    const mockService = {
      listDataCategories: vi.fn().mockResolvedValue(mockResponse),
    } as unknown as ReturnType<typeof getCdoService>;
    vi.mocked(getCdoService).mockReturnValue(mockService);

    const ctx = createMockContext({ errors: noaaClimateListDataCategories.errors });
    const input = noaaClimateListDataCategories.input.parse({
      datasetId: 'GHCND',
      locationId: 'FIPS:37',
      stationId: 'GHCND:USC00450974',
      startDate: '2020-01-01',
      endDate: '2023-12-31',
      sortField: 'name',
      sortOrder: 'asc',
      limit: 10,
      offset: 5,
    });
    await noaaClimateListDataCategories.handler(input, ctx);

    expect(mockService.listDataCategories).toHaveBeenCalledWith(
      expect.objectContaining({
        datasetid: 'GHCND',
        locationid: 'FIPS:37',
        stationid: 'GHCND:USC00450974',
        startdate: '2020-01-01',
        enddate: '2023-12-31',
        sortfield: 'name',
        sortorder: 'asc',
        limit: 10,
        offset: 5,
      }),
      ctx,
    );
  });
});

describe('noaaClimateListDataCategories — error propagation', () => {
  it('propagates service errors', async () => {
    vi.mocked(getCdoService).mockReturnValue({
      listDataCategories: vi.fn().mockRejectedValue(new Error('CDO unavailable')),
    } as unknown as ReturnType<typeof getCdoService>);

    const ctx = createMockContext({ errors: noaaClimateListDataCategories.errors });
    const input = noaaClimateListDataCategories.input.parse({});
    await expect(noaaClimateListDataCategories.handler(input, ctx)).rejects.toThrow();
  });

  it('re-throws service HTTP 400 as validation_error with data.reason set', async () => {
    vi.mocked(getCdoService).mockReturnValue({
      listDataCategories: vi.fn().mockRejectedValue(
        new McpError(JsonRpcErrorCode.InvalidParams, 'NOAA CDO returned HTTP 400.', {
          status: 400,
        }),
      ),
    } as unknown as ReturnType<typeof getCdoService>);

    const ctx = createMockContext({ errors: noaaClimateListDataCategories.errors });
    const input = noaaClimateListDataCategories.input.parse({ datasetId: 'INVALID_DS' });
    await expect(noaaClimateListDataCategories.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'validation_error' },
    });
  });

  // Uses a 500: the transient codes are routed onto declared reasons (see
  // cdo-upstream-rejection-routing), so an unrouted code is what still proves
  // the catch does not swallow whatever it was not built to answer.
  it('passes an unrouted McpError through unchanged', async () => {
    const serviceError = new McpError(
      JsonRpcErrorCode.InternalError,
      'NOAA CDO returned HTTP 500.',
      { status: 500 },
    );
    vi.mocked(getCdoService).mockReturnValue({
      listDataCategories: vi.fn().mockRejectedValue(serviceError),
    } as unknown as ReturnType<typeof getCdoService>);

    const ctx = createMockContext({ errors: noaaClimateListDataCategories.errors });
    const input = noaaClimateListDataCategories.input.parse({});
    await expect(noaaClimateListDataCategories.handler(input, ctx)).rejects.toBe(serviceError);
  });
});
