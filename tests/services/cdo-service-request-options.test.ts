/**
 * @fileoverview Options CdoService hands to `fetchWithTimeout`.
 *
 * CDO answers a missing station with HTTP 200 and a bare `{}` — never a 404 —
 * so declaring 404 an expected status on that route describes a response the
 * endpoint cannot produce. The not-found path is the `!station.id` check in the
 * handlers, not a status mapping.
 * @module tests/services/cdo-service-request-options.test
 */

import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: vi.fn().mockReturnValue({ token: 'test-token-1234' }),
  getPaginationConfig: vi.fn().mockReturnValue({ clampLimits: true }),
}));

vi.mock('@cyanheads/mcp-ts-core/utils', async (importOriginal) => {
  const original = await importOriginal<typeof import('@cyanheads/mcp-ts-core/utils')>();
  return {
    ...original,
    withRetry: vi.fn(async (fn: () => Promise<unknown>) => fn()),
    fetchWithTimeout: vi.fn(),
  };
});

import { fetchWithTimeout, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { noaaClimateFetchData } from '@/mcp-server/tools/definitions/noaa-climate-fetch-data.tool.js';
import { CdoService, initCdoService } from '@/services/cdo/cdo-service.js';

/** Options object from the most recent fetchWithTimeout call. */
function lastOptions(): Record<string, unknown> {
  const call = vi.mocked(fetchWithTimeout).mock.calls.at(-1);
  if (!call) throw new Error('fetchWithTimeout was never called.');
  return (call[3] ?? {}) as Record<string, unknown>;
}

beforeEach(() => {
  vi.mocked(fetchWithTimeout).mockReset();
  vi.mocked(withRetry).mockClear();
  // A fresh Response per call — a shared instance throws "Body already used".
  vi.mocked(fetchWithTimeout).mockImplementation(
    async () =>
      new Response(JSON.stringify({ id: 'GHCND:USC00450974', name: 'YAKIMA WA US' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
  );
});

describe('CdoService — request options', () => {
  it.each([4000, 4001])(
    'measures tool canonical dates, defaults and offset in the %i-character query',
    async (length) => {
      const prefix =
        'datasetid=GHCND&locationid=FIPS%3A53&stationid=GHCND%3AUSW00024233&stationid=RARE%3A&datatypeid=A%26B&startdate=2024-06-01&enddate=2024-06-01&limit=25&offset=10&includemetadata=true';
      vi.mocked(fetchWithTimeout).mockImplementation(async () =>
        Response.json({
          results: [
            { date: '2024-06-01', datatype: 'TMAX', station: 'GHCND:USW00024233', value: 172 },
          ],
          metadata: { resultset: { count: 17, limit: 25, offset: 10 } },
        }),
      );
      initCdoService();
      const result = await runToolContract(noaaClimateFetchData, {
        datasetId: 'GHCND',
        stationId: ['usw00024233', `rare:${'X'.repeat(length - prefix.length)}`],
        locationId: ['FIPS:53'],
        datatypeId: ['A&B'],
        startDate: '20240601',
        endDate: '2024-6-1',
        offset: 9,
        includemetadata: false,
      });
      if (length === 4000) {
        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toMatchObject({
          results: [{ value: 172 }],
          totalCount: 17,
        });
        expect(result.structuredContent).not.toHaveProperty('metadata');
        expect(JSON.stringify(result.content)).toContain('172');
        const url = new URL(String(vi.mocked(fetchWithTimeout).mock.calls[0]![0]));
        expect(url.search.slice(1)).toHaveLength(4000);
        expect(url.searchParams.get('startdate')).toBe('2024-06-01');
        expect(url.searchParams.get('enddate')).toBe('2024-06-01');
        expect(url.searchParams.get('includemetadata')).toBe('true');
        expect(url.searchParams.get('limit')).toBe('25');
        expect(url.searchParams.get('offset')).toBe('10');
        expect(url.searchParams.has('units')).toBe(false);
      } else {
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({
          error: { data: { reason: 'validation_error' } },
        });
        expect(JSON.stringify(result.content)).toContain('separate calls');
        expect(withRetry).not.toHaveBeenCalled();
        expect(fetchWithTimeout).not.toHaveBeenCalled();
      }
    },
  );
  it.each([4000, 4001])(
    'bounds the actual combined encoded data query at %i characters',
    async (length) => {
      const prefix =
        'datasetid=GHCND&locationid=FIPS%3A53&stationid=GHCND%3AUSW00024233&stationid=RARE%3A&datatypeid=A%26B&startdate=2024-06-01&enddate=2024-06-01&limit=25&offset=10&includemetadata=true';
      const params = {
        datasetid: 'GHCND',
        locationid: ['FIPS:53'],
        stationid: ['GHCND:USW00024233', `RARE:${'X'.repeat(length - prefix.length)}`],
        datatypeid: ['A&B'],
        startdate: '2024-06-01',
        enddate: '2024-06-01',
        limit: 25,
        offset: 9,
        includemetadata: true,
      };
      const run = async () => new CdoService().fetchData(params, createMockContext());
      if (length === 4000) {
        await run();
        const url = new URL(String(vi.mocked(fetchWithTimeout).mock.calls[0]![0]));
        expect(url.search.slice(1)).toHaveLength(4000);
        expect(url.searchParams.getAll('stationid')).toEqual(params.stationid);
        expect(url.searchParams.get('offset')).toBe('10');
        expect(url.searchParams.get('includemetadata')).toBe('true');
        expect(url.searchParams.get('datatypeid')).toBe('A&B');
        expect(withRetry).toHaveBeenCalledTimes(1);
      } else {
        await expect(run()).rejects.toMatchObject({
          data: { recovery: { hint: expect.stringContaining('separate calls') } },
        });
        expect(withRetry).not.toHaveBeenCalled();
        expect(fetchWithTimeout).not.toHaveBeenCalled();
      }
    },
  );

  it('does not apply the observation ceiling to other endpoints', async () => {
    await new CdoService().listDataTypes(
      { stationid: `RARE:${'X'.repeat(4001)}` },
      createMockContext(),
    );
    expect(fetchWithTimeout).toHaveBeenCalledTimes(1);
  });

  it('routes oversized distinct filters through the tool before retry or fetch on both surfaces', async () => {
    initCdoService();
    const result = await runToolContract(noaaClimateFetchData, {
      datasetId: 'GHCND',
      stationId: ['GHCND:USW00024233', `RARE:${'X'.repeat(4001)}`],
      locationId: ['FIPS:53'],
      datatypeId: ['TMAX'],
      startDate: '20240601',
      endDate: '2024-6-1',
      offset: 9,
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        data: {
          reason: 'validation_error',
          recovery: { hint: expect.stringContaining('stationId, locationId, and datatypeId') },
        },
      },
    });
    expect(JSON.stringify(result.content)).toContain('separate calls');
    expect(withRetry).not.toHaveBeenCalled();
    expect(fetchWithTimeout).not.toHaveBeenCalled();
  });
  it('getStation declares no expected non-2xx statuses', async () => {
    const service = new CdoService('https://mock-cdo.test/v2');
    await service.getStation('GHCND:USC00450974', createMockContext());

    expect(lastOptions()).not.toHaveProperty('expectedStatuses');
  });

  it('no CDO route declares an expected non-2xx status', async () => {
    const service = new CdoService('https://mock-cdo.test/v2');
    const ctx = createMockContext();

    await service.listDatasets({}, ctx);
    await service.listDataCategories({}, ctx);
    await service.listDataTypes({}, ctx);
    await service.findLocations({}, ctx);
    await service.findStations({}, ctx);
    await service.fetchData({ datasetid: 'GHCND' }, ctx);
    await service.getStation('GHCND:USC00450974', ctx);

    for (const call of vi.mocked(fetchWithTimeout).mock.calls) {
      expect(call[3] ?? {}).not.toHaveProperty('expectedStatuses');
    }
  });

  it('still authenticates every request with the token header', async () => {
    const service = new CdoService('https://mock-cdo.test/v2');
    await service.getStation('GHCND:USC00450974', createMockContext());

    expect(lastOptions().headers).toMatchObject({ token: 'test-token-1234' });
  });

  it('returns the bare {} CDO sends for a missing station rather than a 404', async () => {
    vi.mocked(fetchWithTimeout).mockResolvedValueOnce(
      new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );

    const service = new CdoService('https://mock-cdo.test/v2');
    const station = await service.getStation('GHCND:NOT-REAL', createMockContext());

    expect(station).toEqual({});
  });
});
