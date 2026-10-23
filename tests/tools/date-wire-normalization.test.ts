/**
 * @fileoverview Every date filter reaches NOAA CDO in the canonical
 * `YYYY-MM-DD[THH:MM:SS[.fff]]` form, whichever accepted form the caller wrote.
 *
 * CDO's own parsers disagree with each other. `/data` rejects a compact
 * `startdate` — answering with the misleading "The date range must be less than
 * 1 year." — and rejects the unpadded dashed form outright, while every other
 * endpoint accepts both. Normalizing at the edge of the server is what makes
 * each advertised input form work on every endpoint, so the assertions below
 * are on the value the service method receives, not merely on the call
 * succeeding.
 * @module tests/tools/date-wire-normalization.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { noaaClimateFetchData } from '@/mcp-server/tools/definitions/noaa-climate-fetch-data.tool.js';
import { noaaClimateFindLocations } from '@/mcp-server/tools/definitions/noaa-climate-find-locations.tool.js';
import { noaaClimateFindStations } from '@/mcp-server/tools/definitions/noaa-climate-find-stations.tool.js';
import { noaaClimateListDataCategories } from '@/mcp-server/tools/definitions/noaa-climate-list-data-categories.tool.js';
import { noaaClimateListDataTypes } from '@/mcp-server/tools/definitions/noaa-climate-list-data-types.tool.js';
import { noaaClimateListDatasets } from '@/mcp-server/tools/definitions/noaa-climate-list-datasets.tool.js';

vi.mock('@/services/cdo/cdo-service.js', () => ({
  getCdoService: vi.fn(),
}));

import { getCdoService } from '@/services/cdo/cdo-service.js';

/** Every tool that forwards a date filter, with the service method it calls. */
const TOOLS = [
  {
    name: 'noaa_climate_list_datasets',
    def: noaaClimateListDatasets,
    method: 'listDatasets',
    args: {},
  },
  {
    name: 'noaa_climate_list_data_categories',
    def: noaaClimateListDataCategories,
    method: 'listDataCategories',
    args: {},
  },
  {
    name: 'noaa_climate_list_data_types',
    def: noaaClimateListDataTypes,
    method: 'listDataTypes',
    args: {},
  },
  {
    name: 'noaa_climate_find_locations',
    def: noaaClimateFindLocations,
    method: 'findLocations',
    args: {},
  },
  {
    name: 'noaa_climate_find_stations',
    def: noaaClimateFindStations,
    method: 'findStations',
    args: {},
  },
  {
    name: 'noaa_climate_fetch_data',
    def: noaaClimateFetchData,
    method: 'fetchData',
    args: { datasetId: 'GHCND' },
  },
] as const;

/** Accepted input form → the one form CDO parses on every endpoint. */
const FORMS = [
  { form: 'compact', startDate: '20240701', endDate: '20240707' },
  { form: 'unpadded', startDate: '2024-7-1', endDate: '2024-7-7' },
  { form: 'canonical', startDate: '2024-07-01', endDate: '2024-07-07' },
] as const;

/** Install a mocked service whose named method records the params it receives. */
function install(method: string) {
  const impl = vi.fn().mockResolvedValue({
    results: [],
    metadata: { resultset: { count: 0, limit: 25, offset: 1 } },
  });
  vi.mocked(getCdoService).mockReturnValue({ [method]: impl } as unknown as ReturnType<
    typeof getCdoService
  >);
  return impl;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe.each(TOOLS)('$name — date wire form', ({ def, method, args }) => {
  it.each(FORMS)('sends the $form form upstream as the canonical one', async (variant) => {
    const impl = install(method);
    const ctx = createMockContext({ errors: def.errors });
    const input = def.input.parse({
      ...args,
      startDate: variant.startDate,
      endDate: variant.endDate,
    });

    await def.handler(input as never, ctx as never);

    if (def === noaaClimateListDatasets) {
      expect(impl.mock.calls[0]![0]).not.toHaveProperty('startdate');
      expect(impl.mock.calls[0]![0]).not.toHaveProperty('enddate');
      expect(impl.mock.calls[0]![0]).toMatchObject({ limit: 1000, offset: 0 });
      return;
    }
    expect(impl.mock.calls[0]![0]).toMatchObject({
      startdate: '2024-07-01',
      enddate: '2024-07-07',
    });
  });

  it('keeps an already-canonical datetime intact and pads an unpadded one', async () => {
    const impl = install(method);
    const ctx = createMockContext({ errors: def.errors });

    const canonical = def.input.parse({
      ...args,
      startDate: '2024-07-01T12:30:45',
      endDate: '2024-07-07T23:59:59.500',
    });
    await def.handler(canonical as never, ctx as never);
    expect(impl.mock.calls[0]![0]).toMatchObject(
      def === noaaClimateListDatasets
        ? { limit: 1000, offset: 0 }
        : {
            startdate: '2024-07-01T12:30:45',
            enddate: '2024-07-07T23:59:59.500',
          },
    );

    const unpadded = def.input.parse({
      ...args,
      startDate: '2024-7-1T12:30:45',
      endDate: '2024-7-7T23:59:59',
    });
    await def.handler(unpadded as never, ctx as never);
    expect(impl.mock.calls[1]![0]).toMatchObject(
      def === noaaClimateListDatasets
        ? { limit: 1000, offset: 0 }
        : {
            startdate: '2024-07-01T12:30:45',
            enddate: '2024-07-07T23:59:59',
          },
    );
  });
});

describe('noaa_climate_find_locations — nameContains enumeration path', () => {
  it('normalizes the dates on every enumeration fetch, not just the first', async () => {
    const findLocations = vi.fn(async (params: { offset?: number } = {}) => {
      const offset = params.offset ?? 0;
      // 1,500 entries — two 1,000-row enumeration fetches.
      if (offset >= 1500) return {};
      const size = Math.min(1000, 1500 - offset);
      return {
        results: Array.from({ length: size }, (_, i) => ({
          id: `CITY:FILLER${offset + i}`,
          name: `Filler ${offset + i}, XX US`,
        })),
        metadata: { resultset: { count: 1500, limit: 1000, offset: offset + 1 } },
      };
    });
    vi.mocked(getCdoService).mockReturnValue({ findLocations } as unknown as ReturnType<
      typeof getCdoService
    >);
    const ctx = createMockContext({ errors: noaaClimateFindLocations.errors });
    const input = noaaClimateFindLocations.input.parse({
      locationCategoryId: 'CITY',
      nameContains: 'filler',
      startDate: '20200101',
      endDate: '2023-12-3',
    });

    await noaaClimateFindLocations.handler(input, ctx);

    expect(findLocations).toHaveBeenCalledTimes(2);
    for (const [call] of findLocations.mock.calls) {
      expect(call).toMatchObject({ startdate: '2020-01-01', enddate: '2023-12-03' });
    }
  });
});
