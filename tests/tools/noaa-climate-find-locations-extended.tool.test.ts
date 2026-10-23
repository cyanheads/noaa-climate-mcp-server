/**
 * @fileoverview Extended tests for noaa_climate_find_locations — params forwarding,
 * format edge cases, and security.
 * @module tests/tools/noaa-find-locations-extended.tool.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { noaaClimateFindLocations } from '@/mcp-server/tools/definitions/noaa-climate-find-locations.tool.js';
import { firstText } from '../helpers/content.js';

vi.mock('@/services/cdo/cdo-service.js', () => ({
  getCdoService: vi.fn(),
}));

import { getCdoService } from '@/services/cdo/cdo-service.js';

const defaultLocations = [
  {
    id: 'FIPS:37',
    name: 'North Carolina',
    datacoverage: 1,
    mindate: '1869-03-01',
    maxdate: '2024-12-31',
  },
];

beforeEach(() => {
  vi.mocked(getCdoService).mockReturnValue({
    findLocations: vi.fn().mockResolvedValue({
      results: defaultLocations,
      metadata: { resultset: { count: 1, limit: 25, offset: 0 } },
    }),
  } as unknown as ReturnType<typeof getCdoService>);
});

describe('noaaClimateFindLocations — input validation', () => {
  it('rejects limit=0', () => {
    expect(() => noaaClimateFindLocations.input.parse({ limit: 0 })).toThrow();
  });

  it('retains an oversized positive limit for handler clamping', () => {
    expect(noaaClimateFindLocations.input.parse({ limit: 1001 }).limit).toBe(1001);
  });

  it('rejects negative offset', () => {
    expect(() => noaaClimateFindLocations.input.parse({ offset: -1 })).toThrow();
  });

  it('rejects invalid sortField value', () => {
    expect(() => noaaClimateFindLocations.input.parse({ sortField: 'country' })).toThrow();
  });
});

describe('noaaClimateFindLocations — all filter params forwarded', () => {
  it('forwards all optional filter fields to the service', async () => {
    const mockService = {
      findLocations: vi.fn().mockResolvedValue({
        results: [],
        metadata: { resultset: { count: 0, limit: 5, offset: 10 } },
      }),
    } as unknown as ReturnType<typeof getCdoService>;
    vi.mocked(getCdoService).mockReturnValue(mockService);

    const ctx = createMockContext({ errors: noaaClimateFindLocations.errors });
    const input = noaaClimateFindLocations.input.parse({
      locationCategoryId: 'ST',
      datasetId: 'GHCND',
      datacategoryId: 'TEMP',
      startDate: '2020-01-01',
      endDate: '2023-12-31',
      sortField: 'name',
      sortOrder: 'desc',
      limit: 5,
      offset: 10,
    });
    await noaaClimateFindLocations.handler(input, ctx);

    expect(mockService.findLocations).toHaveBeenCalledWith(
      expect.objectContaining({
        locationcategoryid: 'ST',
        datasetid: 'GHCND',
        datacategoryid: 'TEMP',
        startdate: '2020-01-01',
        enddate: '2023-12-31',
        sortfield: 'name',
        sortorder: 'desc',
        limit: 5,
        offset: 10,
      }),
      ctx,
    );
  });
});

describe('noaaClimateFindLocations — notice with category filter context', () => {
  it('notice includes both category and datasetId when both are applied', async () => {
    vi.mocked(getCdoService).mockReturnValue({
      findLocations: vi.fn().mockResolvedValue({
        results: [],
        metadata: { resultset: { count: 0, limit: 25, offset: 0 } },
      }),
    } as unknown as ReturnType<typeof getCdoService>);

    const ctx = createMockContext({ errors: noaaClimateFindLocations.errors });
    const input = noaaClimateFindLocations.input.parse({
      locationCategoryId: 'ZIP',
      datasetId: 'GHCND',
    });
    await noaaClimateFindLocations.handler(input, ctx);

    const enrichment = getEnrichment(ctx);
    const notice = enrichment.notice as string;
    expect(notice).toContain('ZIP');
    expect(notice).toContain('GHCND');
  });
});

describe('noaaClimateFindLocations — error propagation', () => {
  it('propagates service errors', async () => {
    vi.mocked(getCdoService).mockReturnValue({
      findLocations: vi.fn().mockRejectedValue(new Error('CDO API error')),
    } as unknown as ReturnType<typeof getCdoService>);

    const ctx = createMockContext({ errors: noaaClimateFindLocations.errors });
    const input = noaaClimateFindLocations.input.parse({ locationCategoryId: 'ST' });
    await expect(noaaClimateFindLocations.handler(input, ctx)).rejects.toThrow();
  });

  it('re-throws service HTTP 400 as validation_error with data.reason set', async () => {
    vi.mocked(getCdoService).mockReturnValue({
      findLocations: vi.fn().mockRejectedValue(
        new McpError(JsonRpcErrorCode.InvalidParams, 'NOAA CDO returned HTTP 400.', {
          status: 400,
        }),
      ),
    } as unknown as ReturnType<typeof getCdoService>);

    const ctx = createMockContext({ errors: noaaClimateFindLocations.errors });
    const input = noaaClimateFindLocations.input.parse({ datacategoryId: 'INVALID_CAT' });
    await expect(noaaClimateFindLocations.handler(input, ctx)).rejects.toMatchObject({
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
      findLocations: vi.fn().mockRejectedValue(serviceError),
    } as unknown as ReturnType<typeof getCdoService>);

    const ctx = createMockContext({ errors: noaaClimateFindLocations.errors });
    const input = noaaClimateFindLocations.input.parse({});
    await expect(noaaClimateFindLocations.handler(input, ctx)).rejects.toBe(serviceError);
  });
});

describe('noaaClimateFindLocations — format edge cases', () => {
  it('formats locations with no optional fields (no date/coverage line)', () => {
    const blocks = noaaClimateFindLocations.format!({
      results: [{ id: 'FIPS:53', name: 'Washington' }],
      metadata: { resultset: { count: 1, limit: 25, offset: 0 } },
    });
    const text = firstText(blocks);
    expect(text).toContain('FIPS:53');
    expect(text).toContain('Washington');
    // No Coverage or date range since fields absent
    expect(text).not.toContain('Coverage:');
    expect(text).not.toContain(' – '); // no date range separator
  });

  it('formats coverage as a fraction when present', () => {
    const blocks = noaaClimateFindLocations.format!({
      results: [{ id: 'FIPS:37', name: 'North Carolina', datacoverage: 1 }],
    });
    expect(firstText(blocks)).toContain('Coverage (0–1): 1');
  });

  it('formats date range when both mindate and maxdate are present', () => {
    const blocks = noaaClimateFindLocations.format!({
      results: [{ id: 'FIPS:37', name: 'NC', mindate: '1869-01-01', maxdate: '2024-12-31' }],
    });
    expect(firstText(blocks)).toContain('1869-01-01');
    expect(firstText(blocks)).toContain('2024-12-31');
  });
});

describe('noaaClimateFindLocations — security', () => {
  it('injection attempts in locationCategoryId are passed as opaque strings', async () => {
    const mockService = {
      findLocations: vi.fn().mockResolvedValue({
        results: [],
        metadata: { resultset: { count: 0, limit: 25, offset: 0 } },
      }),
    } as unknown as ReturnType<typeof getCdoService>;
    vi.mocked(getCdoService).mockReturnValue(mockService);

    const ctx = createMockContext({ errors: noaaClimateFindLocations.errors });
    const injection = "ST' UNION SELECT * FROM secrets--";
    const input = noaaClimateFindLocations.input.parse({ locationCategoryId: injection });
    await noaaClimateFindLocations.handler(input, ctx);

    expect(mockService.findLocations).toHaveBeenCalledWith(
      expect.objectContaining({ locationcategoryid: injection }),
      ctx,
    );
  });

  it('oversized locationCategoryId string is passed as-is (service rejects at HTTP level)', async () => {
    const mockService = {
      findLocations: vi.fn().mockResolvedValue({
        results: [],
        metadata: { resultset: { count: 0, limit: 25, offset: 0 } },
      }),
    } as unknown as ReturnType<typeof getCdoService>;
    vi.mocked(getCdoService).mockReturnValue(mockService);

    const ctx = createMockContext({ errors: noaaClimateFindLocations.errors });
    const oversized = 'A'.repeat(10_000);
    const input = noaaClimateFindLocations.input.parse({ locationCategoryId: oversized });
    await noaaClimateFindLocations.handler(input, ctx);

    expect(mockService.findLocations).toHaveBeenCalled();
  });
});
