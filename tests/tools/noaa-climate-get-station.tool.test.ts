/**
 * @fileoverview Tests for the noaa_climate_get_station tool.
 * @module tests/tools/noaa-climate-get-station.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { noaaClimateGetStation } from '@/mcp-server/tools/definitions/noaa-climate-get-station.tool.js';
import { firstText } from '../helpers/content.js';

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

describe('noaaClimateGetStation', () => {
  it.each([0, 0.9969, 1])(
    'preserves coordinate and fractional coverage precision %s on both surfaces',
    async (datacoverage) => {
      vi.mocked(getCdoService).mockReturnValue({
        getStation: vi.fn().mockResolvedValue({
          ...mockStation,
          latitude: 47.44467,
          longitude: -122.31442,
          datacoverage,
        }),
      } as unknown as ReturnType<typeof getCdoService>);
      const result = await noaaClimateGetStation.handler(
        noaaClimateGetStation.input.parse({ stationId: mockStation.id }),
        createMockContext({ errors: noaaClimateGetStation.errors }),
      );
      expect(result.latitude).toBe(47.44467);
      expect(result.longitude).toBe(-122.31442);
      expect(result.datacoverage).toBe(datacoverage);
      const text = firstText(noaaClimateGetStation.format!(result));
      expect(text).toContain('47.44467, -122.31442');
      expect(text).toContain(`**Coverage (0–1):** ${datacoverage}`);
    },
  );
  it('returns full station metadata', async () => {
    const ctx = createMockContext({ errors: noaaClimateGetStation.errors });
    const input = noaaClimateGetStation.input.parse({ stationId: 'GHCND:USC00450974' });
    const result = await noaaClimateGetStation.handler(input, ctx);

    expect(result.id).toBe('GHCND:USC00450974');
    expect(result.name).toBe('YAKIMA WA US');
    expect(result.latitude).toBe(46.6039);
    expect(result.elevation).toBe(324.6);
    expect(result.datacoverage).toBe(0.99);
  });

  it('throws service_unavailable when the CDO service errors', async () => {
    vi.mocked(getCdoService).mockReturnValue({
      getStation: vi.fn().mockRejectedValue(new Error('NOAA CDO returned HTTP 503')),
    } as unknown as ReturnType<typeof getCdoService>);

    const ctx = createMockContext({ errors: noaaClimateGetStation.errors });
    const input = noaaClimateGetStation.input.parse({ stationId: 'GHCND:USC00450974' });
    await expect(noaaClimateGetStation.handler(input, ctx)).rejects.toThrow();
  });

  it('preserves sparse upstream payloads — omits optional fields when absent', async () => {
    vi.mocked(getCdoService).mockReturnValue({
      getStation: vi.fn().mockResolvedValue({ id: 'GHCND:X', name: 'Sparse' }),
    } as unknown as ReturnType<typeof getCdoService>);

    const ctx = createMockContext({ errors: noaaClimateGetStation.errors });
    const input = noaaClimateGetStation.input.parse({ stationId: 'GHCND:X' });
    const result = await noaaClimateGetStation.handler(input, ctx);

    expect(result.latitude).toBeUndefined();
    expect(result.elevation).toBeUndefined();
    expect(result.datacoverage).toBeUndefined();
  });

  it('formats output with all known fields', () => {
    const blocks = noaaClimateGetStation.format!({ ...mockStation });
    const text = firstText(blocks);
    expect(text).toContain('YAKIMA WA US');
    expect(text).toContain('GHCND:USC00450974');
    expect(text).toContain('46.6039');
    expect(text).toContain('-120.5097');
    expect(text).toContain('324.6');
    expect(text).toContain('Meters');
    expect(text).toContain('1948-01-01');
    expect(text).toContain('2024-12-31');
  });

  it('formats sparse station showing "Not available" for missing fields', () => {
    const blocks = noaaClimateGetStation.format!({ id: 'GHCND:X', name: 'Sparse' });
    const text = firstText(blocks);
    expect(text).toContain('GHCND:X');
    expect(text).toContain('Sparse');
    expect(text).toContain('Not available');
  });
});
