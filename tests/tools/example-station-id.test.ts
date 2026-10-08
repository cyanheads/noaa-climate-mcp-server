/**
 * @fileoverview The example station ID quoted across the tool and resource
 * surface must resolve against the live CDO API, and must be spelled the same
 * way everywhere.
 *
 * CDO answers an unknown station with HTTP 200 and a bare `{}`, so a dead
 * example ID costs an agent a `not_found` on the very call the example exists
 * to teach. `GHCND:USW00024233` (SEATTLE TACOMA AIRPORT, WA US) was verified
 * live; `GHCND:USC00450974` and its `USW`-spelled twin were not resolvable.
 * @module tests/tools/example-station-id.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { noaaStationResource } from '@/mcp-server/resources/definitions/noaa-station.resource.js';
import { noaaClimateFetchData } from '@/mcp-server/tools/definitions/noaa-climate-fetch-data.tool.js';
import { noaaClimateFindStations } from '@/mcp-server/tools/definitions/noaa-climate-find-stations.tool.js';
import { noaaClimateGetStation } from '@/mcp-server/tools/definitions/noaa-climate-get-station.tool.js';
import { noaaClimateListDatasets } from '@/mcp-server/tools/definitions/noaa-climate-list-datasets.tool.js';
import { contractFailure } from '../helpers/contract-failure.js';
import { resourceFailure } from '../helpers/resource-failure.js';

vi.mock('@/services/cdo/cdo-service.js', () => ({
  getCdoService: vi.fn(),
}));

import { getCdoService } from '@/services/cdo/cdo-service.js';

/** Verified live: resolves to SEATTLE TACOMA AIRPORT, WA US. */
const LIVE_STATION_ID = 'GHCND:USW00024233';

/** Verified live: CDO answers each of these with a bare `{}`. */
const DEAD_STATION_IDS = ['GHCND:USC00450974', 'GHCND:USW00450974'];

/** Every station-ID-bearing string an agent reads before it makes a call. */
function agentFacingStrings(): string[] {
  const strings: string[] = [];

  const collect = (value: unknown): void => {
    if (typeof value === 'string') {
      strings.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) collect(item);
      return;
    }
    if (value && typeof value === 'object') {
      for (const item of Object.values(value)) collect(item);
    }
  };

  for (const def of [
    noaaClimateGetStation,
    noaaClimateFindStations,
    noaaClimateFetchData,
    noaaClimateListDatasets,
  ]) {
    strings.push(def.description);
    collect(z.toJSONSchema(def.input, { io: 'input' }));
    for (const entry of def.errors ?? []) strings.push(entry.when, entry.recovery);
  }

  strings.push(noaaStationResource.description ?? '');
  collect(z.toJSONSchema(noaaStationResource.params!, { io: 'input' }));
  for (const entry of noaaStationResource.errors ?? []) {
    strings.push(entry.when, entry.recovery);
  }

  return strings;
}

beforeEach(() => {
  vi.mocked(getCdoService).mockReturnValue({
    getStation: vi.fn().mockResolvedValue({}),
  } as unknown as ReturnType<typeof getCdoService>);
});

describe('example station ID', () => {
  it.each(DEAD_STATION_IDS)('is never %s in an agent-facing string', (dead) => {
    const offenders = agentFacingStrings().filter((s) => s.includes(dead));

    expect(offenders).toEqual([]);
  });

  it('is the live-verified ID wherever a station example is given', () => {
    const withExamples = agentFacingStrings().filter((s) => /GHCND:US[CW]\d{8}/.test(s));

    expect(withExamples.length).toBeGreaterThan(0);
    for (const text of withExamples) {
      expect(text).toContain(LIVE_STATION_ID);
    }
  });

  it('spells the same ID in the runtime not_found hint as in the declared contract', async () => {
    const failure = await contractFailure(noaaClimateGetStation, {
      stationId: 'GHCND:UNKNOWN0001',
    });

    expect(failure.data.recovery?.hint).toContain(LIVE_STATION_ID);
    const declared = noaaClimateGetStation.errors!.find((e) => e.reason === 'not_found')!.recovery;
    expect(declared).toContain(LIVE_STATION_ID);
  });

  it('spells the live ID in the station resource not_found hint', async () => {
    const failure = await resourceFailure(noaaStationResource, 'noaa://stations/GHCND:UNKNOWN0001');

    expect(failure.data.recovery?.hint).toContain(LIVE_STATION_ID);
  });
});
