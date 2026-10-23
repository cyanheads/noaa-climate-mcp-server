/**
 * @fileoverview Server pagination configuration and its process-wide schema policy.
 * @module tests/config/server-config.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllEnvs();
});

/** Load definitions after the process configuration has been selected. */
async function paginatedDefinitions() {
  return Promise.all([
    import('@/mcp-server/tools/definitions/noaa-climate-fetch-data.tool.js').then(
      (m) => m.noaaClimateFetchData,
    ),
    import('@/mcp-server/tools/definitions/noaa-climate-find-locations.tool.js').then(
      (m) => m.noaaClimateFindLocations,
    ),
    import('@/mcp-server/tools/definitions/noaa-climate-find-stations.tool.js').then(
      (m) => m.noaaClimateFindStations,
    ),
    import('@/mcp-server/tools/definitions/noaa-climate-list-data-categories.tool.js').then(
      (m) => m.noaaClimateListDataCategories,
    ),
    import('@/mcp-server/tools/definitions/noaa-climate-list-data-types.tool.js').then(
      (m) => m.noaaClimateListDataTypes,
    ),
    import('@/mcp-server/tools/definitions/noaa-climate-list-datasets.tool.js').then(
      (m) => m.noaaClimateListDatasets,
    ),
    import('@/mcp-server/tools/definitions/noaa-climate-list-location-categories.tool.js').then(
      (m) => m.noaaClimateListLocationCategories,
    ),
    import('@/mcp-server/tools/definitions/noaa-climate-search-storm-events.tool.js').then(
      (m) => m.noaaClimateSearchStormEvents,
    ),
    import('@/mcp-server/tools/definitions/noaa-climate-get-billion-dollar-disasters.tool.js').then(
      (m) => m.noaaClimateGetBillionDollarDisasters,
    ),
  ]);
}

describe('NOAA_CLAMP_LIMITS', () => {
  it('restores schema rejection on both contract surfaces for all nine paginated tools', async () => {
    vi.resetModules();
    vi.stubEnv('NOAA_CLAMP_LIMITS', 'false');
    const definitions = await paginatedDefinitions();
    for (const definition of definitions) {
      const maximum = [
        'noaa_climate_search_storm_events',
        'noaa_climate_get_billion_dollar_disasters',
      ].includes(definition.name)
        ? 100
        : 1000;
      expect(z.toJSONSchema(definition.input).properties?.limit).toMatchObject({ maximum });
      const args =
        definition.name === 'noaa_climate_fetch_data'
          ? { datasetId: 'GHCND', startDate: '2024-01-01', endDate: '2024-01-02', limit: 1001 }
          : definition.name === 'noaa_climate_search_storm_events'
            ? { year: 2024, limit: maximum + 1 }
            : { limit: maximum + 1 };
      const result = await runToolContract(definition, args);
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.InvalidParams },
      });
      const text = result.content
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('\n');
      expect(text).toContain('limit');
      expect(text).toContain(String(maximum));
    }
  });

  it('advertises and accepts oversized limits by default for all nine paginated tools', async () => {
    vi.resetModules();
    vi.stubEnv('NOAA_CLAMP_LIMITS', undefined);
    const definitions = await paginatedDefinitions();
    for (const definition of definitions) {
      expect(z.toJSONSchema(definition.input).properties?.limit).toMatchObject({
        maximum: Number.MAX_SAFE_INTEGER,
      });
      const args =
        definition.name === 'noaa_climate_fetch_data'
          ? { datasetId: 'GHCND', startDate: '2024-01-01', endDate: '2024-01-02', limit: 1001 }
          : definition.name === 'noaa_climate_search_storm_events'
            ? { year: 2024, limit: 101 }
            : { limit: 1001 };
      expect(definition.input.safeParse(args).success).toBe(true);
    }
  });

  it.each([undefined, '', '\u0024{user_config.noaa_clamp_limits}', 'true', 'false'])(
    'sets the advertised and validated page policy for %j',
    async (value) => {
      vi.resetModules();
      vi.stubEnv('NOAA_CLAMP_LIMITS', value);
      const { getPaginationConfig } = await import('@/config/server-config.js');
      const { pageLimitSchema } = await import(
        '@/mcp-server/tools/definitions/shared/validation.js'
      );
      const enabled = value !== 'false';
      expect(getPaginationConfig().clampLimits).toBe(enabled);
      for (const maximum of [100, 1000]) {
        const schema = pageLimitSchema(maximum);
        expect(schema.safeParse(maximum).success).toBe(true);
        expect(schema.safeParse(maximum + 1).success).toBe(enabled);
        expect(z.toJSONSchema(schema).maximum).toBe(enabled ? Number.MAX_SAFE_INTEGER : maximum);
        for (const invalid of [0, -1, 1.5, 'many', Infinity, NaN]) {
          expect(schema.safeParse(invalid).success).toBe(false);
        }
      }
      vi.stubEnv('NOAA_CLAMP_LIMITS', enabled ? 'false' : 'true');
      expect(getPaginationConfig().clampLimits).toBe(enabled);
      expect(pageLimitSchema(1000).safeParse(1001).success).toBe(enabled);
    },
  );

  it.each(['typo', 'TRUE', 'FALSE', '1', '0', 'yes', 'no', ' true '])(
    'rejects non-boolean spelling %j without exposing credentials',
    async (value) => {
      vi.resetModules();
      vi.stubEnv('NOAA_CLAMP_LIMITS', value);
      vi.stubEnv('NOAA_CDO_TOKEN', 'config-test-secret-sentinel');
      const { getPaginationConfig } = await import('@/config/server-config.js');
      expect(getPaginationConfig).toThrow('NOAA_CLAMP_LIMITS');
      try {
        getPaginationConfig();
        throw new Error('Expected configuration rejection');
      } catch (error) {
        expect(String(error)).not.toContain('config-test-secret-sentinel');
        expect(error).toMatchObject({ code: JsonRpcErrorCode.ConfigurationError });
      }
    },
  );
});
