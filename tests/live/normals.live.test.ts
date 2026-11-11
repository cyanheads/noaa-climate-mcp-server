/**
 * @fileoverview Opt-in live lane: the station noaa_climate_get_normals
 * documents returns 1991–2020 normals from NCEI's keyless Access Data Service,
 * at the values NCEI publishes for it. Needs no token, unlike the CDO checks
 * beside it; run with `bun run test:live`.
 * @module tests/live/normals.live.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { noaaClimateGetNormals } from '@/mcp-server/tools/definitions/noaa-climate-get-normals.tool.js';
import { normalizeGhcnStationId } from '@/mcp-server/tools/definitions/shared/validation.js';
import { NORMALS_GRANULARITIES, NormalsService } from '@/services/normals/normals-service.js';

/** Seattle-Tacoma International Airport, the tool's documented example. */
const EXAMPLE_STATION = 'USW00024233';

describe('noaa_climate_get_normals — live NCEI Access Data Service', () => {
  it('documents the station this lane checks', () => {
    expect(noaaClimateGetNormals.description).toContain(EXAMPLE_STATION);
  });

  it('reads the annual normals at the published 1991–2020 values', async () => {
    const result = await new NormalsService().getNormals(
      {
        station: EXAMPLE_STATION,
        granularity: 'annualseasonal',
        datatypes: NORMALS_GRANULARITIES.annualseasonal.defaults,
      },
      createMockContext(),
    );
    expect(result.dataset).toBe('normals-annualseasonal-1991-2020');
    expect(result.unmatchedDatatypes).toEqual([]);
    expect(result.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ datatype: 'ANN-TAVG-NORMAL', value: 53.7, unit: '°F' }),
        expect.objectContaining({ datatype: 'ANN-PRCP-NORMAL', value: 39.34, unit: 'in' }),
      ]),
    );
  });

  it('carries every monthly default, MLY-TAVG-NORMAL included, for all 12 months', async () => {
    const result = await new NormalsService().getNormals(
      {
        station: EXAMPLE_STATION,
        granularity: 'monthly',
        datatypes: NORMALS_GRANULARITIES.monthly.defaults,
      },
      createMockContext(),
    );
    expect(result.rowCount).toBe(12);
    expect(result.unmatchedDatatypes).toEqual([]);
    expect(result.records).toHaveLength(60);
    expect(result.records[0]).toMatchObject({
      date: '01',
      datatype: 'MLY-TAVG-NORMAL',
      value: 42.8,
    });
  });

  it('reaches a mixed-case legacy CoCoRaHS station, which NCEI matches only as written', async () => {
    const result = await new NormalsService().getNormals(
      {
        station: normalizeGhcnStationId('GHCND:US10adam002'),
        granularity: 'monthly',
        datatypes: ['MLY-PRCP-NORMAL'],
      },
      createMockContext(),
    );
    expect(result.rowCount).toBe(12);
    expect(result.records[0]).toMatchObject({ datatype: 'MLY-PRCP-NORMAL', unit: 'in' });
  });
});
