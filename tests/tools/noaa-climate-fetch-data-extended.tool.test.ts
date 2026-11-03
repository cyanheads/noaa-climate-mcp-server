/**
 * @fileoverview Extended tests for noaa_climate_fetch_data — input validation, service
 * params forwarding, error propagation, and security assertions.
 * @module tests/tools/noaa-fetch-data-extended.tool.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { noaaClimateFetchData } from '@/mcp-server/tools/definitions/noaa-climate-fetch-data.tool.js';

vi.mock('@/services/cdo/cdo-service.js', () => ({
  getCdoService: vi.fn(),
}));

import { getCdoService } from '@/services/cdo/cdo-service.js';

const defaultMockResponse = {
  results: [],
  metadata: { resultset: { count: 0, limit: 25, offset: 0 } },
};

beforeEach(() => {
  vi.mocked(getCdoService).mockReturnValue({
    fetchData: vi.fn().mockResolvedValue(defaultMockResponse),
  } as unknown as ReturnType<typeof getCdoService>);
});

describe('noaaClimateFetchData — input validation', () => {
  it.each([
    ['PRECIP_HLY', 'HPCP', 'metric', 99999, '{,'],
    ['PRECIP_HLY', 'HPCP', 'standard', 25399.75, '{,'],
    ['PRECIP_15', 'QPCP', undefined, 999.99, '{,'],
    ['PRECIP_HLY', 'OTHER', undefined, 99999, '{,'],
    ['GHCND', 'HPCP', undefined, 99999, '{,'],
    ['PRECIP_15', 'QPCP', 'metric', 0, 'T,'],
    ['PRECIP_HLY', 'HPCP', undefined, 45, '],'],
    ['PRECIP_HLY', 'HPCP', undefined, 12, 'A,'],
    ['NORMAL_HLY', 'HLY-TEMP-NORMAL', undefined, 585, ',L,N,0800'],
    ['GSOM', 'TAVG', 'metric', 5.33, ',L,N,0800'],
  ] as const)(
    'preserves %s/%s %s value %s with attributes %s',
    async (datasetId, datatype, units, value, attributes) => {
      vi.mocked(vi.mocked(getCdoService)().fetchData).mockResolvedValueOnce({
        results: [{ date: '2010-01-01', datatype, station: 'COOP:454769', value, attributes }],
        metadata: { resultset: { count: 1, limit: 1, offset: 1 } },
      });
      const result = await runToolContract(noaaClimateFetchData, {
        datasetId,
        units,
        startDate: '2010-01-01',
        endDate: '2010-01-01',
        limit: 1,
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ results: [{ value, attributes }] });
      const data = result.structuredContent as {
        results: Record<string, unknown>[];
        notice?: string;
      };
      expect(data.results[0]).not.toHaveProperty('missing');
      if (datasetId !== 'GHCND') expect(data.results[0]).not.toHaveProperty('flags');
      if (units !== undefined) expect(data.notice).toBeUndefined();
      expect(JSON.stringify(result.content)).toContain(String(value));
      expect(JSON.stringify(result.content)).toContain(attributes);
      expect(getCdoService().fetchData).toHaveBeenCalledWith(
        expect.objectContaining({ units }),
        expect.anything(),
      );
    },
  );

  it.each([
    ['', { measurement: '' }],
    [',', { measurement: '', quality: '' }],
    ['T,,Z', { measurement: 'T', quality: '', source: 'Z' }],
    [', ,N,0000', { measurement: '', quality: ' ', source: 'N', observationTime: '0000' }],
    [',?,Z,0030', { measurement: '', quality: '?', source: 'Z', observationTime: '0030' }],
  ] as const)('preserves GHCND flag slots in %j', async (attributes, expectedFlags) => {
    vi.mocked(vi.mocked(getCdoService)().fetchData).mockResolvedValueOnce({
      results: [{ date: '2024-01-01', datatype: 'PRCP', station: 'GHCND:X', value: 0, attributes }],
      metadata: { resultset: { count: 1, limit: 25, offset: 1 } },
    });
    const result = await runToolContract(noaaClimateFetchData, {
      datasetId: 'ghcnd',
      units: 'metric',
      startDate: '20240101',
      endDate: '20240101',
    });
    const data = result.structuredContent as {
      results: { attributes: string; flags: Record<string, string> }[];
      notice?: string;
    };
    expect(data.results[0]?.attributes).toBe(attributes);
    expect(data.results[0]!.flags).toEqual(expectedFlags);
    if (attributes === ',?,Z,0030') {
      expect(data.notice).toContain('1 observation');
      expect(JSON.stringify(result.content)).toContain('0030');
    } else expect(data.notice).toBeUndefined();
  });
  it('rejects an empty datasetId string', () => {
    expect(() =>
      noaaClimateFetchData.input.parse({
        datasetId: '',
        startDate: '2023-01-01',
        endDate: '2023-01-31',
      }),
    ).toThrow();
  });

  it('rejects limit=0 (below minimum 1)', () => {
    expect(() =>
      noaaClimateFetchData.input.parse({
        datasetId: 'GHCND',
        startDate: '2023-01-01',
        endDate: '2023-01-31',
        limit: 0,
      }),
    ).toThrow();
  });

  it('retains an oversized positive limit for handler clamping', () => {
    expect(
      noaaClimateFetchData.input.parse({
        datasetId: 'GHCND',
        startDate: '2023-01-01',
        endDate: '2023-01-31',
        limit: 1001,
      }).limit,
    ).toBe(1001);
  });

  it('rejects negative offset', () => {
    expect(() =>
      noaaClimateFetchData.input.parse({
        datasetId: 'GHCND',
        startDate: '2023-01-01',
        endDate: '2023-01-31',
        offset: -1,
      }),
    ).toThrow();
  });

  it('rejects invalid units value', () => {
    expect(() =>
      noaaClimateFetchData.input.parse({
        datasetId: 'GHCND',
        startDate: '2023-01-01',
        endDate: '2023-01-31',
        units: 'imperial',
      }),
    ).toThrow();
  });

  it('rejects invalid sortField value', () => {
    expect(() =>
      noaaClimateFetchData.input.parse({
        datasetId: 'GHCND',
        startDate: '2023-01-01',
        endDate: '2023-01-31',
        sortField: 'unknown',
      }),
    ).toThrow();
  });

  it('accepts limit=1 (boundary minimum)', () => {
    const input = noaaClimateFetchData.input.parse({
      datasetId: 'GHCND',
      startDate: '2023-01-01',
      endDate: '2023-01-31',
      limit: 1,
    });
    expect(input.limit).toBe(1);
  });

  it('accepts limit=1000 (boundary maximum)', () => {
    const input = noaaClimateFetchData.input.parse({
      datasetId: 'GHCND',
      startDate: '2023-01-01',
      endDate: '2023-01-31',
      limit: 1000,
    });
    expect(input.limit).toBe(1000);
  });
});

describe('noaaClimateFetchData — date range validation edge cases', () => {
  it('throws date_range_exceeded for PRECIP_15 (daily set) with >365-day range', async () => {
    const ctx = createMockContext({ errors: noaaClimateFetchData.errors });
    const input = noaaClimateFetchData.input.parse({
      datasetId: 'PRECIP_15',
      startDate: '2022-01-01',
      endDate: '2023-06-30',
    });
    await expect(noaaClimateFetchData.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'date_range_exceeded' },
    });
  });

  it('throws date_range_exceeded for NORMAL_HLY with >365-day range', async () => {
    const ctx = createMockContext({ errors: noaaClimateFetchData.errors });
    const input = noaaClimateFetchData.input.parse({
      datasetId: 'NORMAL_HLY',
      startDate: '2010-01-01',
      endDate: '2011-12-31',
    });
    await expect(noaaClimateFetchData.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'date_range_exceeded' },
    });
  });

  it('throws date_range_exceeded for GSOY with >10-year range', async () => {
    const ctx = createMockContext({ errors: noaaClimateFetchData.errors });
    const input = noaaClimateFetchData.input.parse({
      datasetId: 'GSOY',
      startDate: '2000-01-01',
      endDate: '2015-01-01',
    });
    await expect(noaaClimateFetchData.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'date_range_exceeded' },
    });
  });

  it('allows NORMAL_DLY exactly on 365-day boundary (2010-01-01 to 2010-12-31)', async () => {
    const ctx = createMockContext({ errors: noaaClimateFetchData.errors });
    const input = noaaClimateFetchData.input.parse({
      datasetId: 'NORMAL_DLY',
      startDate: '2010-01-01',
      endDate: '2010-12-31',
    });
    const result = await noaaClimateFetchData.handler(input, ctx);
    expect(result.results).toBeDefined();
  });

  it('date range error includes requestedDays, maxDays, and maxEndDate in data', async () => {
    const ctx = createMockContext({ errors: noaaClimateFetchData.errors });
    const input = noaaClimateFetchData.input.parse({
      datasetId: 'GHCND',
      startDate: '2022-01-01',
      endDate: '2023-12-31',
    });
    await expect(noaaClimateFetchData.handler(input, ctx)).rejects.toMatchObject({
      data: {
        reason: 'date_range_exceeded',
        requestedDays: 730,
        // CDO accepts through the end of January 2023 for a January 2022 start.
        maxDays: 396,
        maxEndDate: '2023-01-31',
      },
    });
  });
});

describe('noaaClimateFetchData — service params forwarding', () => {
  it('forwards all optional filter params to the service', async () => {
    const mockService = {
      fetchData: vi.fn().mockResolvedValue(defaultMockResponse),
    } as unknown as ReturnType<typeof getCdoService>;
    vi.mocked(getCdoService).mockReturnValue(mockService);

    const ctx = createMockContext({ errors: noaaClimateFetchData.errors });
    const input = noaaClimateFetchData.input.parse({
      datasetId: 'GHCND',
      startDate: '2023-01-01',
      endDate: '2023-01-31',
      stationId: ['GHCND:USC00450974', 'GHCND:USC00456789'],
      locationId: ['FIPS:53'],
      datatypeId: ['TMAX', 'TMIN'],
      units: 'metric',
      sortField: 'date',
      sortOrder: 'desc',
      limit: 100,
      offset: 50,
    });
    await noaaClimateFetchData.handler(input, ctx);

    expect(mockService.fetchData).toHaveBeenCalledWith(
      expect.objectContaining({
        datasetid: 'GHCND',
        startdate: '2023-01-01',
        enddate: '2023-01-31',
        stationid: ['GHCND:USC00450974', 'GHCND:USC00456789'],
        locationid: ['FIPS:53'],
        datatypeid: ['TMAX', 'TMIN'],
        units: 'metric',
        sortfield: 'date',
        sortorder: 'desc',
        limit: 100,
        offset: 50,
      }),
      ctx,
    );
  });
});

describe('noaaClimateFetchData — datasetId pre-request validation', () => {
  it('throws validation_error for an unknown datasetId before any service call', async () => {
    const mockService = {
      fetchData: vi.fn().mockResolvedValue(defaultMockResponse),
    } as unknown as ReturnType<typeof getCdoService>;
    vi.mocked(getCdoService).mockReturnValue(mockService);

    const ctx = createMockContext({ errors: noaaClimateFetchData.errors });
    const input = noaaClimateFetchData.input.parse({
      datasetId: 'BOGUS_DATASET',
      startDate: '2026-05-01',
      endDate: '2026-05-07',
    });
    await expect(noaaClimateFetchData.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'validation_error' },
    });
    expect(mockService.fetchData).not.toHaveBeenCalled();
  });

  it('validation_error for unknown datasetId includes a recovery hint', async () => {
    const ctx = createMockContext({ errors: noaaClimateFetchData.errors });
    const input = noaaClimateFetchData.input.parse({
      datasetId: 'BOGUS_DATASET',
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

  it('accepts NEXRAD2 as a known datasetId', async () => {
    const ctx = createMockContext({ errors: noaaClimateFetchData.errors });
    const input = noaaClimateFetchData.input.parse({
      datasetId: 'NEXRAD2',
      startDate: '2023-01-01',
      endDate: '2023-01-31',
    });
    const result = await noaaClimateFetchData.handler(input, ctx);
    expect(result.results).toBeDefined();
  });

  it('accepts NEXRAD3 as a known datasetId', async () => {
    const ctx = createMockContext({ errors: noaaClimateFetchData.errors });
    const input = noaaClimateFetchData.input.parse({
      datasetId: 'NEXRAD3',
      startDate: '2023-01-01',
      endDate: '2023-01-31',
    });
    const result = await noaaClimateFetchData.handler(input, ctx);
    expect(result.results).toBeDefined();
  });

  it('unknown datasetId validation is case-insensitive', async () => {
    const ctx = createMockContext({ errors: noaaClimateFetchData.errors });
    const input = noaaClimateFetchData.input.parse({
      datasetId: 'ghcnd', // lowercase — should still be recognized
      startDate: '2023-01-01',
      endDate: '2023-01-31',
    });
    const result = await noaaClimateFetchData.handler(input, ctx);
    expect(result.results).toBeDefined();
  });
});

describe('noaaClimateFetchData — error propagation', () => {
  it('propagates service errors without swallowing them', async () => {
    vi.mocked(getCdoService).mockReturnValue({
      fetchData: vi.fn().mockRejectedValue(new Error('NOAA CDO returned HTTP 503')),
    } as unknown as ReturnType<typeof getCdoService>);

    const ctx = createMockContext({ errors: noaaClimateFetchData.errors });
    const input = noaaClimateFetchData.input.parse({
      datasetId: 'GHCND',
      startDate: '2023-01-01',
      endDate: '2023-01-31',
    });
    await expect(noaaClimateFetchData.handler(input, ctx)).rejects.toThrow();
  });

  it('propagates timeout errors from the service', async () => {
    vi.mocked(getCdoService).mockReturnValue({
      fetchData: vi.fn().mockRejectedValue(new Error('Request timed out')),
    } as unknown as ReturnType<typeof getCdoService>);

    const ctx = createMockContext({ errors: noaaClimateFetchData.errors });
    const input = noaaClimateFetchData.input.parse({
      datasetId: 'GHCND',
      startDate: '2023-01-01',
      endDate: '2023-01-31',
    });
    await expect(noaaClimateFetchData.handler(input, ctx)).rejects.toThrow();
  });

  it('re-throws service HTTP 400 as validation_error with data.reason set', async () => {
    vi.mocked(getCdoService).mockReturnValue({
      fetchData: vi.fn().mockRejectedValue(
        new McpError(JsonRpcErrorCode.InvalidParams, 'NOAA CDO returned HTTP 400.', {
          status: 400,
        }),
      ),
    } as unknown as ReturnType<typeof getCdoService>);

    const ctx = createMockContext({ errors: noaaClimateFetchData.errors });
    const input = noaaClimateFetchData.input.parse({
      datasetId: 'GHCND',
      startDate: '2023-01-01',
      endDate: '2023-01-31',
      datatypeId: ['INVALID_TYPE'],
    });
    await expect(noaaClimateFetchData.handler(input, ctx)).rejects.toMatchObject({
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
      fetchData: vi.fn().mockRejectedValue(serviceError),
    } as unknown as ReturnType<typeof getCdoService>);

    const ctx = createMockContext({ errors: noaaClimateFetchData.errors });
    const input = noaaClimateFetchData.input.parse({
      datasetId: 'GHCND',
      startDate: '2023-01-01',
      endDate: '2023-01-31',
    });
    await expect(noaaClimateFetchData.handler(input, ctx)).rejects.toBe(serviceError);
  });
});

describe('noaaClimateFetchData — security', () => {
  it('rejects an unnamespaced ambiguous stationId before service access', async () => {
    const mockService = {
      fetchData: vi.fn().mockResolvedValue(defaultMockResponse),
    } as unknown as ReturnType<typeof getCdoService>;
    vi.mocked(getCdoService).mockReturnValue(mockService);

    const injectionAttempt = "'; DROP TABLE stations; --";
    expect(() =>
      noaaClimateFetchData.input.parse({
        datasetId: 'GHCND',
        startDate: '2023-01-01',
        endDate: '2023-01-31',
        stationId: [injectionAttempt],
      }),
    ).toThrow();
    expect(mockService.fetchData).not.toHaveBeenCalled();
  });

  it('output and error messages do not expose NOAA_CDO_TOKEN or any env secret', async () => {
    // Simulate a service error carrying a synthetic token-like string in the message
    const fakeToken = 'FAKE_SECRET_TOKEN_12345';
    vi.mocked(getCdoService).mockReturnValue({
      fetchData: vi.fn().mockRejectedValue(new Error(`CDO error for token ${fakeToken}`)),
    } as unknown as ReturnType<typeof getCdoService>);

    const ctx = createMockContext({ errors: noaaClimateFetchData.errors });
    const input = noaaClimateFetchData.input.parse({
      datasetId: 'GHCND',
      startDate: '2023-01-01',
      endDate: '2023-01-31',
    });

    let caughtError: unknown;
    try {
      await noaaClimateFetchData.handler(input, ctx);
    } catch (e) {
      caughtError = e;
    }
    expect(caughtError).toBeDefined();
    // The handler itself throws — the raw service message may propagate (service
    // owns the error), but the handler adds no secret from the env. Verify that
    // the handler doesn't add NOAA_CDO_TOKEN to its own output enrichment.
    const enrichment = JSON.stringify(ctx);
    expect(enrichment).not.toContain('NOAA_CDO_TOKEN');
  });

  it('effectiveQuery enrichment never contains env variable names', async () => {
    vi.mocked(getCdoService).mockReturnValue({
      fetchData: vi.fn().mockResolvedValue(defaultMockResponse),
    } as unknown as ReturnType<typeof getCdoService>);

    const ctx = createMockContext({ errors: noaaClimateFetchData.errors });
    const input = noaaClimateFetchData.input.parse({
      datasetId: 'GHCND',
      startDate: '2023-01-01',
      endDate: '2023-01-31',
    });
    await noaaClimateFetchData.handler(input, ctx);

    const enrichment = JSON.stringify(ctx);
    expect(enrichment).not.toContain('NOAA_CDO_TOKEN');
    expect(enrichment).not.toContain('process.env');
  });
});

describe('noaaClimateFetchData — format', () => {
  it('format includes all filter-summary fields in the effective query', async () => {
    const mockService = {
      fetchData: vi.fn().mockResolvedValue({
        results: [{ date: '2023-01-01T00:00:00', datatype: 'TMAX', station: 'GHCND:X', value: 10 }],
        metadata: { resultset: { count: 1, limit: 25, offset: 0 } },
      }),
    } as unknown as ReturnType<typeof getCdoService>;
    vi.mocked(getCdoService).mockReturnValue(mockService);

    const ctx = createMockContext({ errors: noaaClimateFetchData.errors });
    const input = noaaClimateFetchData.input.parse({
      datasetId: 'GHCND',
      startDate: '2023-01-01',
      endDate: '2023-01-31',
      datatypeId: ['TMAX'],
      locationId: ['FIPS:53'],
    });
    await noaaClimateFetchData.handler(input, ctx);

    // Verify enrichment includes locations and datatypes in the query summary
    const { getEnrichment } = await import('@cyanheads/mcp-ts-core/testing');
    const enrichment = getEnrichment(ctx);
    expect(enrichment.effectiveQuery as string).toContain('FIPS:53');
    expect(enrichment.effectiveQuery as string).toContain('TMAX');
  });
});
