/**
 * @fileoverview Extended tests for noaa_climate_find_stations — params forwarding,
 * bounding-box filtering, format output, and security.
 * @module tests/tools/noaa-find-stations-extended.tool.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { noaaClimateFindStations } from '@/mcp-server/tools/definitions/noaa-climate-find-stations.tool.js';
import { firstText } from '../helpers/content.js';

vi.mock('@/services/cdo/cdo-service.js', () => ({
  getCdoService: vi.fn(),
}));

import { getCdoService } from '@/services/cdo/cdo-service.js';

const defaultStation = {
  id: 'GHCND:USC00450974',
  name: 'YAKIMA WA US',
  latitude: 46.6039,
  longitude: -120.5097,
  elevation: 324.6,
  elevationUnit: 'Meters',
  mindate: '1948-01-01',
  maxdate: '2024-12-31',
  datacoverage: 0.99,
};

beforeEach(() => {
  vi.mocked(getCdoService).mockReturnValue({
    findStations: vi.fn().mockResolvedValue({
      results: [defaultStation],
      metadata: { resultset: { count: 1, limit: 25, offset: 0 } },
    }),
  } as unknown as ReturnType<typeof getCdoService>);
});

describe('noaaClimateFindStations — input validation', () => {
  it('rejects limit=0', () => {
    expect(() => noaaClimateFindStations.input.parse({ limit: 0 })).toThrow();
  });

  it('rejects limit=1001', () => {
    expect(() => noaaClimateFindStations.input.parse({ limit: 1001 })).toThrow();
  });

  it('rejects negative offset', () => {
    expect(() => noaaClimateFindStations.input.parse({ offset: -1 })).toThrow();
  });

  it('rejects invalid sortField value', () => {
    expect(() => noaaClimateFindStations.input.parse({ sortField: 'city' })).toThrow();
  });
});

describe('noaaClimateFindStations — params forwarding', () => {
  it('forwards extent (bounding box) to the service', async () => {
    const mockService = {
      findStations: vi.fn().mockResolvedValue({
        results: [],
        metadata: { resultset: { count: 0, limit: 25, offset: 0 } },
      }),
    } as unknown as ReturnType<typeof getCdoService>;
    vi.mocked(getCdoService).mockReturnValue(mockService);

    const ctx = createMockContext({ errors: noaaClimateFindStations.errors });
    const input = noaaClimateFindStations.input.parse({
      extent: '47.5,-122.4,47.7,-122.1',
    });
    await noaaClimateFindStations.handler(input, ctx);

    expect(mockService.findStations).toHaveBeenCalledWith(
      expect.objectContaining({ extent: '47.5,-122.4,47.7,-122.1' }),
      ctx,
    );
  });

  it('forwards multiple datatypeIds to the service', async () => {
    const mockService = {
      findStations: vi.fn().mockResolvedValue({
        results: [defaultStation],
        metadata: { resultset: { count: 1, limit: 25, offset: 0 } },
      }),
    } as unknown as ReturnType<typeof getCdoService>;
    vi.mocked(getCdoService).mockReturnValue(mockService);

    const ctx = createMockContext({ errors: noaaClimateFindStations.errors });
    const input = noaaClimateFindStations.input.parse({
      datatypeId: ['TMAX', 'TMIN', 'PRCP'],
    });
    await noaaClimateFindStations.handler(input, ctx);

    expect(mockService.findStations).toHaveBeenCalledWith(
      expect.objectContaining({ datatypeid: ['TMAX', 'TMIN', 'PRCP'] }),
      ctx,
    );
  });

  it('forwards all optional filter params', async () => {
    const mockService = {
      findStations: vi.fn().mockResolvedValue({
        results: [],
        metadata: { resultset: { count: 0, limit: 10, offset: 25 } },
      }),
    } as unknown as ReturnType<typeof getCdoService>;
    vi.mocked(getCdoService).mockReturnValue(mockService);

    const ctx = createMockContext({ errors: noaaClimateFindStations.errors });
    const input = noaaClimateFindStations.input.parse({
      locationId: 'FIPS:53',
      datasetId: 'GHCND',
      datacategoryId: 'TEMP',
      startDate: '2020-01-01',
      endDate: '2023-12-31',
      sortField: 'name',
      sortOrder: 'asc',
      limit: 10,
      offset: 25,
    });
    await noaaClimateFindStations.handler(input, ctx);

    expect(mockService.findStations).toHaveBeenCalledWith(
      expect.objectContaining({
        locationid: 'FIPS:53',
        datasetid: 'GHCND',
        datacategoryid: 'TEMP',
        startdate: '2020-01-01',
        enddate: '2023-12-31',
        sortfield: 'name',
        sortorder: 'asc',
        limit: 10,
        offset: 25,
      }),
      ctx,
    );
  });
});

describe('noaaClimateFindStations — notice message with filters', () => {
  it('notice includes applied filter context when no stations matched', async () => {
    vi.mocked(getCdoService).mockReturnValue({
      findStations: vi.fn().mockResolvedValue({
        results: [],
        metadata: { resultset: { count: 0, limit: 25, offset: 0 } },
      }),
    } as unknown as ReturnType<typeof getCdoService>);

    const ctx = createMockContext({ errors: noaaClimateFindStations.errors });
    const input = noaaClimateFindStations.input.parse({
      locationId: 'FIPS:99',
      datasetId: 'GHCND',
      datatypeId: ['SNOW'],
      extent: '10,20,30,40',
    });
    await noaaClimateFindStations.handler(input, ctx);

    const enrichment = getEnrichment(ctx);
    expect(typeof enrichment.notice).toBe('string');
    const notice = enrichment.notice as string;
    // Notice should reference at least some of the applied filters
    expect(notice).toMatch(/FIPS:99|GHCND|SNOW|10,20,30,40/);
  });
});

describe('noaaClimateFindStations — format output', () => {
  it('formats stations with no coordinates gracefully', () => {
    const blocks = noaaClimateFindStations.format!({
      results: [{ id: 'GHCND:SPARSE', name: 'Sparse Station' }],
      metadata: { resultset: { count: 1, limit: 25, offset: 0 } },
    });
    const text = firstText(blocks);
    expect(text).toContain('GHCND:SPARSE');
    expect(text).toContain('Sparse Station');
    // No coordinate line since lat/lon absent
    expect(text).not.toContain('Coords/Elevation:');
  });

  it('formats an empty station list with a neutral empty-page message', () => {
    const blocks = noaaClimateFindStations.format!({
      results: [],
      metadata: { resultset: { count: 0, limit: 25, offset: 0 } },
    });
    expect(firstText(blocks)).toContain('No records on this page.');
  });

  it('format includes fractional data coverage', () => {
    const blocks = noaaClimateFindStations.format!({
      results: [defaultStation],
      metadata: { resultset: { count: 1, limit: 25, offset: 0 } },
    });
    expect(firstText(blocks)).toContain('**Coverage (0–1):** 0.99');
  });

  it('format includes data range when both mindate and maxdate are present', () => {
    const blocks = noaaClimateFindStations.format!({
      results: [defaultStation],
      metadata: { resultset: { count: 1, limit: 25, offset: 0 } },
    });
    expect(firstText(blocks)).toContain('1948-01-01');
    expect(firstText(blocks)).toContain('2024-12-31');
  });
});

describe('noaaClimateFindStations — error propagation', () => {
  it('re-throws service HTTP 400 as validation_error with data.reason set', async () => {
    vi.mocked(getCdoService).mockReturnValue({
      findStations: vi.fn().mockRejectedValue(
        new McpError(JsonRpcErrorCode.InvalidParams, 'NOAA CDO returned HTTP 400.', {
          status: 400,
        }),
      ),
    } as unknown as ReturnType<typeof getCdoService>);

    const ctx = createMockContext({ errors: noaaClimateFindStations.errors });
    const input = noaaClimateFindStations.input.parse({ locationId: 'INVALID:99' });
    await expect(noaaClimateFindStations.handler(input, ctx)).rejects.toMatchObject({
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
      findStations: vi.fn().mockRejectedValue(serviceError),
    } as unknown as ReturnType<typeof getCdoService>);

    const ctx = createMockContext({ errors: noaaClimateFindStations.errors });
    const input = noaaClimateFindStations.input.parse({});
    await expect(noaaClimateFindStations.handler(input, ctx)).rejects.toBe(serviceError);
  });
});

describe('noaaClimateFindStations — security', () => {
  it('injection attempts in locationId are passed as opaque strings, not executed', async () => {
    const mockService = {
      findStations: vi.fn().mockResolvedValue({
        results: [],
        metadata: { resultset: { count: 0, limit: 25, offset: 0 } },
      }),
    } as unknown as ReturnType<typeof getCdoService>;
    vi.mocked(getCdoService).mockReturnValue(mockService);

    const ctx = createMockContext({ errors: noaaClimateFindStations.errors });
    const injection = "FIPS:37' OR '1'='1";
    const input = noaaClimateFindStations.input.parse({ locationId: injection });
    await noaaClimateFindStations.handler(input, ctx);

    expect(mockService.findStations).toHaveBeenCalledWith(
      expect.objectContaining({ locationid: injection }),
      ctx,
    );
  });
});
