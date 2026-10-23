/**
 * @fileoverview Extended tests for noaa_climate_list_data_types — params forwarding,
 * input validation, error propagation, and security.
 * @module tests/tools/noaa-list-data-types-extended.tool.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { noaaClimateListDataTypes } from '@/mcp-server/tools/definitions/noaa-climate-list-data-types.tool.js';

vi.mock('@/services/cdo/cdo-service.js', () => ({
  getCdoService: vi.fn(),
}));

import { getCdoService } from '@/services/cdo/cdo-service.js';

const mockResponse = {
  results: [
    {
      id: 'TMAX',
      name: 'Maximum temperature',
      datacoverage: 0.99,
      mindate: '1763-01-01',
      maxdate: '2024-12-31',
    },
    { id: 'PRCP', name: 'Precipitation' },
  ],
  metadata: { resultset: { count: 2, limit: 25, offset: 0 } },
};

beforeEach(() => {
  vi.mocked(getCdoService).mockReturnValue({
    listDataTypes: vi.fn().mockResolvedValue(mockResponse),
  } as unknown as ReturnType<typeof getCdoService>);
});

describe('noaaClimateListDataTypes — input validation', () => {
  it('rejects limit=0', () => {
    expect(() => noaaClimateListDataTypes.input.parse({ limit: 0 })).toThrow();
  });

  it('retains an oversized positive limit for handler clamping', () => {
    expect(noaaClimateListDataTypes.input.parse({ limit: 1001 }).limit).toBe(1001);
  });

  it('rejects negative offset', () => {
    expect(() => noaaClimateListDataTypes.input.parse({ offset: -1 })).toThrow();
  });

  it('rejects invalid sortField', () => {
    expect(() => noaaClimateListDataTypes.input.parse({ sortField: 'city' })).toThrow();
  });
});

describe('noaaClimateListDataTypes — params forwarding', () => {
  it('forwards all filter params to the service', async () => {
    const mockService = {
      listDataTypes: vi.fn().mockResolvedValue(mockResponse),
    } as unknown as ReturnType<typeof getCdoService>;
    vi.mocked(getCdoService).mockReturnValue(mockService);

    const ctx = createMockContext({ errors: noaaClimateListDataTypes.errors });
    const input = noaaClimateListDataTypes.input.parse({
      datasetId: 'GHCND',
      locationId: 'FIPS:37',
      stationId: 'GHCND:USC00450974',
      datacategoryId: 'TEMP',
      startDate: '2020-01-01',
      endDate: '2023-12-31',
      sortField: 'id',
      sortOrder: 'asc',
      limit: 50,
      offset: 0,
    });
    await noaaClimateListDataTypes.handler(input, ctx);

    expect(mockService.listDataTypes).toHaveBeenCalledWith(
      expect.objectContaining({
        datasetid: 'GHCND',
        locationid: 'FIPS:37',
        stationid: 'GHCND:USC00450974',
        datacategoryid: 'TEMP',
        startdate: '2020-01-01',
        enddate: '2023-12-31',
        sortfield: 'id',
        sortorder: 'asc',
        limit: 50,
        offset: 0,
      }),
      ctx,
    );
  });
});

describe('noaaClimateListDataTypes — error propagation', () => {
  it('propagates service errors', async () => {
    vi.mocked(getCdoService).mockReturnValue({
      listDataTypes: vi.fn().mockRejectedValue(new Error('CDO API error')),
    } as unknown as ReturnType<typeof getCdoService>);

    const ctx = createMockContext({ errors: noaaClimateListDataTypes.errors });
    const input = noaaClimateListDataTypes.input.parse({ datasetId: 'GHCND' });
    await expect(noaaClimateListDataTypes.handler(input, ctx)).rejects.toThrow();
  });

  it('re-throws service HTTP 400 as validation_error with data.reason set', async () => {
    vi.mocked(getCdoService).mockReturnValue({
      listDataTypes: vi.fn().mockRejectedValue(
        new McpError(JsonRpcErrorCode.InvalidParams, 'NOAA CDO returned HTTP 400.', {
          status: 400,
        }),
      ),
    } as unknown as ReturnType<typeof getCdoService>);

    const ctx = createMockContext({ errors: noaaClimateListDataTypes.errors });
    const input = noaaClimateListDataTypes.input.parse({ datacategoryId: 'INVALID_CAT' });
    await expect(noaaClimateListDataTypes.handler(input, ctx)).rejects.toMatchObject({
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
      listDataTypes: vi.fn().mockRejectedValue(serviceError),
    } as unknown as ReturnType<typeof getCdoService>);

    const ctx = createMockContext({ errors: noaaClimateListDataTypes.errors });
    const input = noaaClimateListDataTypes.input.parse({ datasetId: 'GHCND' });
    await expect(noaaClimateListDataTypes.handler(input, ctx)).rejects.toBe(serviceError);
  });
});

describe('noaaClimateListDataTypes — security', () => {
  it('injection attempts in datasetId are forwarded as opaque strings', async () => {
    const mockService = {
      listDataTypes: vi.fn().mockResolvedValue(mockResponse),
    } as unknown as ReturnType<typeof getCdoService>;
    vi.mocked(getCdoService).mockReturnValue(mockService);

    const ctx = createMockContext({ errors: noaaClimateListDataTypes.errors });
    const injection = 'GHCND; DROP TABLE datatypes; --';
    const input = noaaClimateListDataTypes.input.parse({ datasetId: injection });
    await noaaClimateListDataTypes.handler(input, ctx);

    expect(mockService.listDataTypes).toHaveBeenCalledWith(
      expect.objectContaining({ datasetid: injection }),
      ctx,
    );
  });
});
