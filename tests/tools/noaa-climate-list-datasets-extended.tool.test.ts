/**
 * @fileoverview Extended tests for noaa_climate_list_datasets — params forwarding,
 * input validation, and security.
 * @module tests/tools/noaa-list-datasets-extended.tool.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { noaaClimateListDatasets } from '@/mcp-server/tools/definitions/noaa-climate-list-datasets.tool.js';

vi.mock('@/services/cdo/cdo-service.js', () => ({
  getCdoService: vi.fn(),
}));

import { getCdoService } from '@/services/cdo/cdo-service.js';

const mockResponse = {
  results: [
    {
      id: 'GHCND',
      name: 'Daily Summaries',
      datacoverage: 1,
      mindate: '1763-01-01',
      maxdate: '2024-12-31',
    },
  ],
  metadata: { resultset: { count: 1, limit: 25, offset: 0 } },
};

beforeEach(() => {
  vi.mocked(getCdoService).mockReturnValue({
    listDatasets: vi.fn().mockResolvedValue(mockResponse),
  } as unknown as ReturnType<typeof getCdoService>);
});

describe('noaaClimateListDatasets — input validation', () => {
  it('rejects limit=0', () => {
    expect(() => noaaClimateListDatasets.input.parse({ limit: 0 })).toThrow();
  });

  it('retains an oversized positive limit for handler clamping', () => {
    expect(noaaClimateListDatasets.input.parse({ limit: 1001 }).limit).toBe(1001);
  });

  it('rejects negative offset', () => {
    expect(() => noaaClimateListDatasets.input.parse({ offset: -1 })).toThrow();
  });

  it('rejects invalid sortField', () => {
    expect(() => noaaClimateListDatasets.input.parse({ sortField: 'foo' })).toThrow();
  });

  it('accepts valid sortField values', () => {
    for (const field of ['id', 'name', 'mindate', 'maxdate', 'datacoverage'] as const) {
      const input = noaaClimateListDatasets.input.parse({ sortField: field });
      expect(input.sortField).toBe(field);
    }
  });
});

describe('noaaClimateListDatasets — service params forwarding', () => {
  it('forwards stationId while applying date overlap locally', async () => {
    const mockService = {
      listDatasets: vi.fn().mockResolvedValue(mockResponse),
    } as unknown as ReturnType<typeof getCdoService>;
    vi.mocked(getCdoService).mockReturnValue(mockService);

    const ctx = createMockContext({ errors: noaaClimateListDatasets.errors });
    const input = noaaClimateListDatasets.input.parse({
      stationId: 'GHCND:USC00450974',
      startDate: '2010-01-01',
      endDate: '2020-12-31',
    });
    const result = await noaaClimateListDatasets.handler(input, ctx);
    expect(result.results.map((row) => row.id)).toEqual(['GHCND']);

    expect(mockService.listDatasets).toHaveBeenCalledWith(
      expect.objectContaining({
        stationid: 'GHCND:USC00450974',
        limit: 1000,
        offset: 0,
      }),
      expect.objectContaining({ requestId: ctx.requestId }),
    );
    expect(vi.mocked(mockService.listDatasets).mock.calls[0]![0]).not.toHaveProperty('startdate');
    expect(vi.mocked(mockService.listDatasets).mock.calls[0]![0]).not.toHaveProperty('enddate');
  });

  it('forwards sort params', async () => {
    const mockService = {
      listDatasets: vi.fn().mockResolvedValue(mockResponse),
    } as unknown as ReturnType<typeof getCdoService>;
    vi.mocked(getCdoService).mockReturnValue(mockService);

    const ctx = createMockContext({ errors: noaaClimateListDatasets.errors });
    const input = noaaClimateListDatasets.input.parse({ sortField: 'name', sortOrder: 'desc' });
    await noaaClimateListDatasets.handler(input, ctx);

    expect(mockService.listDatasets).toHaveBeenCalledWith(
      expect.objectContaining({ sortfield: 'name', sortorder: 'desc' }),
      ctx,
    );
  });
});

describe('noaaClimateListDatasets — error propagation', () => {
  it('propagates service errors without swallowing', async () => {
    vi.mocked(getCdoService).mockReturnValue({
      listDatasets: vi.fn().mockRejectedValue(new Error('CDO API unavailable')),
    } as unknown as ReturnType<typeof getCdoService>);

    const ctx = createMockContext({ errors: noaaClimateListDatasets.errors });
    const input = noaaClimateListDatasets.input.parse({});
    await expect(noaaClimateListDatasets.handler(input, ctx)).rejects.toThrow();
  });

  it('re-throws service HTTP 400 as validation_error with data.reason set', async () => {
    vi.mocked(getCdoService).mockReturnValue({
      listDatasets: vi.fn().mockRejectedValue(
        new McpError(JsonRpcErrorCode.InvalidParams, 'NOAA CDO returned HTTP 400.', {
          status: 400,
        }),
      ),
    } as unknown as ReturnType<typeof getCdoService>);

    const ctx = createMockContext({ errors: noaaClimateListDatasets.errors });
    const input = noaaClimateListDatasets.input.parse({ locationId: 'INVALID:99' });
    await expect(noaaClimateListDatasets.handler(input, ctx)).rejects.toMatchObject({
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
      listDatasets: vi.fn().mockRejectedValue(serviceError),
    } as unknown as ReturnType<typeof getCdoService>);

    const ctx = createMockContext({ errors: noaaClimateListDatasets.errors });
    const input = noaaClimateListDatasets.input.parse({});
    await expect(noaaClimateListDatasets.handler(input, ctx)).rejects.toBe(serviceError);
  });
});

describe('noaaClimateListDatasets — security', () => {
  it('injection attempts in locationId are forwarded as opaque strings', async () => {
    const mockService = {
      listDatasets: vi.fn().mockResolvedValue(mockResponse),
    } as unknown as ReturnType<typeof getCdoService>;
    vi.mocked(getCdoService).mockReturnValue(mockService);

    const ctx = createMockContext({ errors: noaaClimateListDatasets.errors });
    const injection = "FIPS:37' OR '1'='1";
    const input = noaaClimateListDatasets.input.parse({ locationId: injection });
    await noaaClimateListDatasets.handler(input, ctx);

    expect(mockService.listDatasets).toHaveBeenCalledWith(
      expect.objectContaining({ locationid: injection }),
      ctx,
    );
  });

  it('unicode in datatypeId is forwarded without modification', async () => {
    const mockService = {
      listDatasets: vi.fn().mockResolvedValue(mockResponse),
    } as unknown as ReturnType<typeof getCdoService>;
    vi.mocked(getCdoService).mockReturnValue(mockService);

    const ctx = createMockContext({ errors: noaaClimateListDatasets.errors });
    const unicodeId = 'TMAX​'; // zero-width space
    const input = noaaClimateListDatasets.input.parse({ datatypeId: [unicodeId] });
    await noaaClimateListDatasets.handler(input, ctx);

    expect(mockService.listDatasets).toHaveBeenCalledWith(
      expect.objectContaining({ datatypeid: [unicodeId] }),
      ctx,
    );
  });
});
