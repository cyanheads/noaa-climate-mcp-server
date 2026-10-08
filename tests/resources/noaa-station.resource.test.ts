/**
 * @fileoverview Tests for the noaa://stations/{stationId} resource.
 * @module tests/resources/noaa-station.resource.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { noaaStationResource } from '@/mcp-server/resources/definitions/noaa-station.resource.js';
import { resourceFailure } from '../helpers/resource-failure.js';

vi.mock('@/services/cdo/cdo-service.js', () => ({
  getCdoService: vi.fn(),
}));

import { getCdoService } from '@/services/cdo/cdo-service.js';

const mockStation = {
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
    getStation: vi.fn().mockResolvedValue(mockStation),
  } as unknown as ReturnType<typeof getCdoService>);
});

describe('noaaStationResource', () => {
  it('returns full station metadata for a known station', async () => {
    const ctx = createMockContext({ errors: noaaStationResource.errors });
    const result = await noaaStationResource.handler({ stationId: 'GHCND:USC00450974' }, ctx);

    expect(result).toMatchObject({
      id: 'GHCND:USC00450974',
      name: 'YAKIMA WA US',
      latitude: 46.6039,
      elevation: 324.6,
    });
  });

  it('throws not_found when service returns an object without an id', async () => {
    vi.mocked(getCdoService).mockReturnValue({
      getStation: vi.fn().mockResolvedValue({ name: 'Unknown' }),
    } as unknown as ReturnType<typeof getCdoService>);

    const ctx = createMockContext({ errors: noaaStationResource.errors });
    const err = await Promise.resolve(
      noaaStationResource.handler({ stationId: 'GHCND:BADID' }, ctx),
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(McpError);
    expect((err as McpError).code).toBe(JsonRpcErrorCode.NotFound);
    expect((err as McpError).message).toContain('not found');
    expect((err as McpError).data).toMatchObject({
      reason: 'not_found',
      stationId: 'GHCND:BADID',
    });
  });

  it('throws not_found (not undefined) when API returns empty object', async () => {
    vi.mocked(getCdoService).mockReturnValue({
      getStation: vi.fn().mockResolvedValue({}),
    } as unknown as ReturnType<typeof getCdoService>);

    const ctx = createMockContext({ errors: noaaStationResource.errors });
    const err = await Promise.resolve(
      noaaStationResource.handler({ stationId: 'GHCND:NONE' }, ctx),
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(McpError);
    expect((err as McpError).code).toBe(JsonRpcErrorCode.NotFound);
    expect((err as McpError).data).toMatchObject({ reason: 'not_found' });
  });

  it('declares the not_found error contract with actionable recovery text', () => {
    const contract = noaaStationResource.errors?.find((e) => e.reason === 'not_found');

    expect(contract).toBeDefined();
    expect(contract!.code).toBe(JsonRpcErrorCode.NotFound);
    expect(contract!.when.length).toBeGreaterThan(0);
    expect(contract!.recovery).toContain('noaa_climate_find_stations');
  });

  it('puts the recovery hint on the wire for a not-found station', async () => {
    vi.mocked(getCdoService).mockReturnValue({
      getStation: vi.fn().mockResolvedValue({}),
    } as unknown as ReturnType<typeof getCdoService>);

    const failure = await resourceFailure(
      noaaStationResource,
      'noaa://stations/GHCND:NOT-A-REAL-STATION',
    );

    expect(failure.code).toBe(JsonRpcErrorCode.NotFound);
    expect(failure.data).toMatchObject({
      reason: 'not_found',
      stationId: 'GHCND:NOT-A-REAL-STATION',
      recovery: { hint: expect.stringContaining('noaa_climate_find_stations') },
    });
  });

  it('rejects an empty stationId at the params schema', () => {
    expect(() => noaaStationResource.params!.parse({ stationId: '' })).toThrow();
  });

  it('rejects a whitespace-only stationId at the params schema', () => {
    expect(() => noaaStationResource.params!.parse({ stationId: '   ' })).toThrow();
  });

  it('reports a single message for an empty stationId', () => {
    const result = noaaStationResource.params!.safeParse({ stationId: '' });

    expect(result.success).toBe(false);
    expect(result.error!.issues).toHaveLength(1);
  });

  it('accepts a real stationId unmodified', () => {
    expect(noaaStationResource.params!.parse({ stationId: 'GHCND:USC00450974' })).toEqual({
      stationId: 'GHCND:USC00450974',
    });
  });

  it('advertises minLength to clients through JSON Schema', () => {
    const json = z.toJSONSchema(noaaStationResource.params!, { io: 'input' }) as unknown as {
      properties: { stationId: { minLength?: number } };
    };

    expect(json.properties.stationId.minLength).toBe(1);
  });

  it('still resolves not_found for a schema-valid ID that no station uses', async () => {
    vi.mocked(getCdoService).mockReturnValue({
      getStation: vi.fn().mockResolvedValue({}),
    } as unknown as ReturnType<typeof getCdoService>);

    const ctx = createMockContext({ errors: noaaStationResource.errors });
    const params = noaaStationResource.params!.parse({ stationId: 'GHCND:NOT-REAL' });
    const err = await Promise.resolve(noaaStationResource.handler(params, ctx)).catch(
      (e: unknown) => e,
    );

    expect((err as McpError).code).toBe(JsonRpcErrorCode.NotFound);
    expect((err as McpError).data).toMatchObject({
      reason: 'not_found',
      stationId: 'GHCND:NOT-REAL',
    });
  });

  it('propagates service errors', async () => {
    vi.mocked(getCdoService).mockReturnValue({
      getStation: vi.fn().mockRejectedValue(new Error('NOAA CDO returned HTTP 429')),
    } as unknown as ReturnType<typeof getCdoService>);

    const ctx = createMockContext({ errors: noaaStationResource.errors });
    await expect(
      noaaStationResource.handler({ stationId: 'GHCND:USC00450974' }, ctx),
    ).rejects.toThrow();
  });

  it('preserves sparse upstream payloads — omits optional fields when absent', async () => {
    vi.mocked(getCdoService).mockReturnValue({
      getStation: vi.fn().mockResolvedValue({ id: 'GHCND:SPARSE', name: 'Sparse Station' }),
    } as unknown as ReturnType<typeof getCdoService>);

    const ctx = createMockContext({ errors: noaaStationResource.errors });
    const result = await noaaStationResource.handler({ stationId: 'GHCND:SPARSE' }, ctx);

    expect((result as { id: string }).id).toBe('GHCND:SPARSE');
    expect((result as Record<string, unknown>).latitude).toBeUndefined();
    expect((result as Record<string, unknown>).elevation).toBeUndefined();
    expect((result as Record<string, unknown>).datacoverage).toBeUndefined();
  });

  it('error message includes the station ID for actionable diagnosis', async () => {
    vi.mocked(getCdoService).mockReturnValue({
      getStation: vi.fn().mockResolvedValue({}),
    } as unknown as ReturnType<typeof getCdoService>);

    const ctx = createMockContext({ errors: noaaStationResource.errors });
    const stationId = 'GHCND:NOTFOUND123';
    await expect(noaaStationResource.handler({ stationId }, ctx)).rejects.toMatchObject({
      message: expect.stringContaining(stationId),
    });
  });

  it('passes the stationId directly to the service without modification', async () => {
    const mockService = {
      getStation: vi.fn().mockResolvedValue(mockStation),
    } as unknown as ReturnType<typeof getCdoService>;
    vi.mocked(getCdoService).mockReturnValue(mockService);

    const ctx = createMockContext({ errors: noaaStationResource.errors });
    await noaaStationResource.handler({ stationId: 'GHCND:USC00450974' }, ctx);

    expect(mockService.getStation).toHaveBeenCalledWith('GHCND:USC00450974', ctx);
  });
});
