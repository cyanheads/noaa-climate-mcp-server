/**
 * @fileoverview Tests for the noaa_climate_find_stations tool.
 * @module tests/tools/noaa-climate-find-stations.tool.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { noaaClimateFindStations } from '@/mcp-server/tools/definitions/noaa-climate-find-stations.tool.js';
import { firstText } from '../helpers/content.js';

vi.mock('@/services/cdo/cdo-service.js', () => ({
  getCdoService: vi.fn(),
}));

import { getCdoService } from '@/services/cdo/cdo-service.js';

const mockStations = [
  {
    id: 'GHCND:USC00450974',
    name: 'YAKIMA WA US',
    latitude: 46.6039,
    longitude: -120.5097,
    elevation: 324.6,
    elevationUnit: 'Meters',
    mindate: '1948-01-01',
    maxdate: '2024-12-31',
    datacoverage: 0.99,
  },
  {
    id: 'GHCND:USC00456789',
    name: 'SPARSE STATION', // omits coordinate/coverage fields
  },
];

beforeEach(() => {
  vi.mocked(getCdoService).mockReturnValue({
    findStations: vi.fn().mockResolvedValue({
      results: mockStations,
      metadata: { resultset: { count: 2, limit: 25, offset: 0 } },
    }),
  } as unknown as ReturnType<typeof getCdoService>);
});

describe('noaaClimateFindStations', () => {
  it.each(['48,-122,47,-123', '-90,170,90,-170'])(
    'preserves empty reversed-axis query %s',
    async (extent) => {
      const findStations = vi.fn().mockResolvedValue({});
      vi.mocked(getCdoService).mockReturnValue({ findStations } as unknown as ReturnType<
        typeof getCdoService
      >);
      const result = await runToolContract(noaaClimateFindStations, { extent });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        results: [],
        totalCount: 0,
        notice: expect.stringContaining('No stations matched'),
      });
      expect(JSON.stringify(result.content)).toContain('No stations matched');
      expect(findStations).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ extent }),
        expect.anything(),
      );
    },
  );
  it('advertises decimal/scientific extent syntax to clients', () => {
    const schema = z.toJSONSchema(noaaClimateFindStations.input, { io: 'input' });
    const field = z
      .object({ properties: z.object({ extent: z.object({ pattern: z.string() }) }) })
      .parse(schema).properties.extent;
    const pattern = new RegExp(field.pattern);
    expect(pattern.test(' +4.75e1,-122.4,47.7,-122.1 ')).toBe(true);
    expect(pattern.test('1,2,3')).toBe(false);
    expect(pattern.test('1,2,3,4,5')).toBe(false);
    expect(pattern.test('Infinity,0,1,2')).toBe(false);
  });
  it('bounds CPU use for long extent input', () => {
    const cpu = () => {
      const usage = process.threadCpuUsage();
      return usage.user + usage.system;
    };
    for (const size of [1250, 5000, 20000, 80000]) {
      const inputs = [
        `${'9'.repeat(size)}x,0,0,0`,
        `${' '.repeat(size)}x`,
        `0,0,0,${'9'.repeat(size)}x\n`,
        `${' \n'.repeat(size)}x`,
        `${'1e+'.repeat(size)}x`,
        `${'('.repeat(size)}x`,
      ];
      const before = cpu();
      for (const extent of inputs) {
        expect(noaaClimateFindStations.input.safeParse({ extent }).success).toBe(false);
      }
      expect(cpu() - before).toBeLessThan(200_000);
    }
  });
  it.each([
    '47.4,-122.4,47.5',
    'garbage',
    '1,2,3,4,5',
    '1,,3,4',
    '1,2,3,',
    'NaN,0,1,2',
    'Infinity,0,1,2',
    '1e999,0,1,2',
    '91,0,1,2',
    '-91,0,1,2',
    '0,-181,1,2',
    '0,0,91,2',
    '0,0,1,181',
    '0x10,0,1,2',
    '1,2,3,4\nextra',
  ])('rejects malformed extent %j before any CDO access', async (extent) => {
    vi.mocked(getCdoService).mockClear();
    const result = await runToolContract(noaaClimateFindStations, { extent });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.structuredContent)).toContain('minLat,minLon,maxLat,maxLon');
    expect(JSON.stringify(result.content)).toContain('minLat,minLon,maxLat,maxLon');
    expect(getCdoService).not.toHaveBeenCalled();
  });
  it.each([
    '47.5,-122.4,47.7,-122.1',
    ' +47.5 , -122.4 , 47.7 , -122.1 ',
    '4.75e1,-1.224e2,4.77e1,-1.221e2',
    '-90,-180,+90,+180',
    '47.5,-122.4,47.5,-122.4',
    '48,-122,47,-123',
    '-90,170,90,-170',
    '.5,-.5,+.7,-.1',
  ])('preserves accepted extent %j verbatim', async (extent) => {
    const result = await runToolContract(noaaClimateFindStations, { extent });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      results: [{ id: 'GHCND:USC00450974' }, { id: 'GHCND:USC00456789' }],
    });
    expect(JSON.stringify(result.content)).toContain('GHCND:USC00450974');
    expect(getCdoService().findStations).toHaveBeenCalledWith(
      expect.objectContaining({ extent }),
      expect.anything(),
    );
  });
  it.each([0, 0.9969, 1])(
    'preserves coordinate and coverage precision %s on both surfaces',
    async (datacoverage) => {
      vi.mocked(getCdoService).mockReturnValue({
        findStations: vi.fn().mockResolvedValue({
          results: [
            { ...mockStations[0], latitude: 47.44467, longitude: -122.31442, datacoverage },
          ],
        }),
      } as unknown as ReturnType<typeof getCdoService>);
      const result = await noaaClimateFindStations.handler(
        noaaClimateFindStations.input.parse({}),
        createMockContext({ errors: noaaClimateFindStations.errors }),
      );
      expect(result.results[0]).toMatchObject({
        latitude: 47.44467,
        longitude: -122.31442,
        datacoverage,
      });
      const text = firstText(noaaClimateFindStations.format!(result));
      expect(text).toContain('47.44467, -122.31442');
      expect(text).toContain(`**Coverage (0–1):** ${datacoverage}`);
    },
  );
  it('returns station results with coordinates and coverage', async () => {
    const ctx = createMockContext({ errors: noaaClimateFindStations.errors });
    const input = noaaClimateFindStations.input.parse({
      locationId: 'FIPS:53',
      datasetId: 'GHCND',
    });
    const result = await noaaClimateFindStations.handler(input, ctx);

    expect(result.results).toHaveLength(2);
    const yakima = result.results[0]!;
    expect(yakima.id).toBe('GHCND:USC00450974');
    expect(yakima.latitude).toBe(46.6039);
    expect(yakima.elevation).toBe(324.6);
    expect(yakima.datacoverage).toBe(0.99);
    expect(getEnrichment(ctx)).toMatchObject({ totalCount: 2 });
    expect(getEnrichment(ctx)).not.toHaveProperty('notice');
  });

  it('enriches with notice when no stations matched', async () => {
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
    });
    await noaaClimateFindStations.handler(input, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalCount).toBe(0);
    expect(typeof enrichment.notice).toBe('string');
    expect(enrichment.notice as string).toContain('No stations matched');
  });

  it('preserves sparse upstream payloads — omits optional coordinate fields', async () => {
    const ctx = createMockContext({ errors: noaaClimateFindStations.errors });
    const input = noaaClimateFindStations.input.parse({});
    const result = await noaaClimateFindStations.handler(input, ctx);

    const sparse = result.results.find((s) => s.id === 'GHCND:USC00456789');
    expect(sparse!.latitude).toBeUndefined();
    expect(sparse!.longitude).toBeUndefined();
    expect(sparse!.elevation).toBeUndefined();
    expect(sparse!.datacoverage).toBeUndefined();
  });

  it('formats output with station IDs, names, coordinates, and dates', () => {
    const blocks = noaaClimateFindStations.format!({
      results: mockStations,
      metadata: { resultset: { count: 2, limit: 25, offset: 0 } },
    });
    const text = firstText(blocks);
    expect(text).toContain('GHCND:USC00450974');
    expect(text).toContain('YAKIMA WA US');
    expect(text).toContain('46.6039');
    expect(text).toContain('324.6');
    expect(text).toContain('Meters');
    expect(text).toContain('1948-01-01');
    expect(text).toContain('0'); // offset
  });
});
