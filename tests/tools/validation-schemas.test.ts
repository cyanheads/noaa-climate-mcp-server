/**
 * @fileoverview Cross-tool input-validation tests — date shape, calendar validity,
 * and non-empty scalar/array identifier filters, plus the handler-level
 * startDate > endDate rule on noaa_climate_fetch_data.
 * @module tests/tools/validation-schemas.test
 */

import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { noaaClimateFetchData } from '@/mcp-server/tools/definitions/noaa-climate-fetch-data.tool.js';
import { noaaClimateFindLocations } from '@/mcp-server/tools/definitions/noaa-climate-find-locations.tool.js';
import { noaaClimateFindStations } from '@/mcp-server/tools/definitions/noaa-climate-find-stations.tool.js';
import { noaaClimateGetStation } from '@/mcp-server/tools/definitions/noaa-climate-get-station.tool.js';
import { noaaClimateListDataCategories } from '@/mcp-server/tools/definitions/noaa-climate-list-data-categories.tool.js';
import { noaaClimateListDataTypes } from '@/mcp-server/tools/definitions/noaa-climate-list-data-types.tool.js';
import { noaaClimateListDatasets } from '@/mcp-server/tools/definitions/noaa-climate-list-datasets.tool.js';

vi.mock('@/services/cdo/cdo-service.js', () => ({
  getCdoService: vi.fn(),
}));

import { getCdoService } from '@/services/cdo/cdo-service.js';

/**
 * Date forms NOAA CDO accepts and answers correctly — verified live against the
 * /data endpoint. Narrowing the schema past these would reject working input.
 */
const ACCEPTED_DATES = [
  '2024-07-01',
  '2024-07-01T00:00:00',
  '2024-07-01T12:30:45',
  '2024-07-01T00:00:00.0',
  '2024-07-01T00:00:00.000',
  '2024-07-01T00:00:00.123456',
  // Compact form — accepted on all six CDO endpoints.
  '20240701',
  // Unpadded month/day — accepted on every endpoint except /data, which
  // answers 400. That 400 surfaces through the validation_error remap rather
  // than being pre-empted with a per-endpoint schema.
  '2024-7-1',
  '2024-07-1',
  '2024-7-01',
];

/** Date forms CDO rejects (HTTP 400/500) or silently ignores — reject locally instead. */
const REJECTED_DATES = [
  'not-a-date',
  '',
  '2024-13-01',
  '2024-02-30',
  '2024-06-31',
  '20241301',
  '20240230',
  '20230229',
  '2024-13-1',
  '2024-2-30',
  '2024-07-01T00:00',
  '2024-07-01 00:00:00',
  '2024/07/01',
];

/** Tools carrying optional startDate/endDate filters. */
const DATE_FILTER_TOOLS = [
  ['noaa_climate_list_datasets', noaaClimateListDatasets],
  ['noaa_climate_list_data_categories', noaaClimateListDataCategories],
  ['noaa_climate_list_data_types', noaaClimateListDataTypes],
  ['noaa_climate_find_locations', noaaClimateFindLocations],
  ['noaa_climate_find_stations', noaaClimateFindStations],
] as const;

beforeEach(() => {
  const empty = vi.fn().mockResolvedValue({ results: [] });
  vi.mocked(getCdoService).mockReturnValue({
    listDatasets: empty,
    listDataCategories: empty,
    listDataTypes: empty,
    findLocations: empty,
    findStations: empty,
    fetchData: vi.fn().mockResolvedValue({
      results: [],
      metadata: { resultset: { count: 0, limit: 25, offset: 0 } },
    }),
  } as unknown as ReturnType<typeof getCdoService>);
});

describe.each(DATE_FILTER_TOOLS)('%s — date filter validation', (_name, def) => {
  it.each([
    ['2024-12-31', '2024-01-01'],
    ['20240101', '2023-12-31'],
    ['2024-1-1T00:00:00.001', '20240101'],
  ])('rejects reversed %s through %s before service access', async (startDate, endDate) => {
    vi.mocked(getCdoService).mockClear();
    const result = await runToolContract(def, { startDate, endDate });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        data: {
          reason: 'validation_error',
          startDate,
          endDate,
          recovery: { hint: expect.stringContaining('Swap') },
        },
      },
    });
    const content = JSON.stringify(result.content);
    expect(content).toContain(startDate);
    expect(content).toContain(endDate);
    expect(content).toContain('Swap');
    expect(getCdoService).not.toHaveBeenCalled();
  });
  it.each([
    { startDate: '20240101', endDate: '2024-1-1T00:00:00.000' },
    { startDate: '2024-1-1', endDate: '20240102' },
    { startDate: '20240101' },
    { endDate: '2024-1-1' },
  ])('preserves valid discovery dates %j', async (args) => {
    const fetchPage = vi.fn().mockResolvedValue({ results: [] });
    vi.mocked(getCdoService).mockReturnValue({
      listDatasets: fetchPage,
      listDataCategories: fetchPage,
      listDataTypes: fetchPage,
      findLocations: fetchPage,
      findStations: fetchPage,
    } as unknown as ReturnType<typeof getCdoService>);
    const result = await runToolContract(def, args);
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ results: [], totalCount: 0 });
    expect(JSON.stringify(result.content)).toContain('No records on this page');
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });
  it.each(ACCEPTED_DATES)('accepts startDate=%s', (date) => {
    expect(() => def.input.parse({ startDate: date })).not.toThrow();
  });

  it.each(ACCEPTED_DATES)('accepts endDate=%s', (date) => {
    expect(() => def.input.parse({ endDate: date })).not.toThrow();
  });

  it.each(REJECTED_DATES)('rejects startDate=%j', (date) => {
    expect(() => def.input.parse({ startDate: date })).toThrow();
  });

  it.each(REJECTED_DATES)('rejects endDate=%j', (date) => {
    expect(() => def.input.parse({ endDate: date })).toThrow();
  });
});

describe('noaa_climate_fetch_data — date filter validation', () => {
  const base = { datasetId: 'GHCND', startDate: '2024-07-01', endDate: '2024-07-07' };

  it.each(ACCEPTED_DATES)('accepts startDate=%s', (date) => {
    expect(() =>
      noaaClimateFetchData.input.parse({ ...base, startDate: date, endDate: '2024-12-31' }),
    ).not.toThrow();
  });

  it.each(REJECTED_DATES)('rejects startDate=%j', (date) => {
    expect(() => noaaClimateFetchData.input.parse({ ...base, startDate: date })).toThrow();
  });

  it.each(REJECTED_DATES)('rejects endDate=%j', (date) => {
    expect(() => noaaClimateFetchData.input.parse({ ...base, endDate: date })).toThrow();
  });

  it('requires startDate and endDate', () => {
    expect(() => noaaClimateFetchData.input.parse({ datasetId: 'GHCND' })).toThrow();
  });
});

describe('scalar identifier filters reject empty and whitespace-only values', () => {
  const cases = [
    ['noaa_climate_list_data_categories.datasetId', noaaClimateListDataCategories, 'datasetId'],
    ['noaa_climate_list_data_categories.locationId', noaaClimateListDataCategories, 'locationId'],
    ['noaa_climate_list_data_categories.stationId', noaaClimateListDataCategories, 'stationId'],
    ['noaa_climate_list_data_types.datasetId', noaaClimateListDataTypes, 'datasetId'],
    ['noaa_climate_list_data_types.datacategoryId', noaaClimateListDataTypes, 'datacategoryId'],
    ['noaa_climate_list_data_types.locationId', noaaClimateListDataTypes, 'locationId'],
    ['noaa_climate_list_data_types.stationId', noaaClimateListDataTypes, 'stationId'],
    ['noaa_climate_list_datasets.locationId', noaaClimateListDatasets, 'locationId'],
    ['noaa_climate_list_datasets.stationId', noaaClimateListDatasets, 'stationId'],
    [
      'noaa_climate_find_locations.locationCategoryId',
      noaaClimateFindLocations,
      'locationCategoryId',
    ],
    ['noaa_climate_find_locations.datasetId', noaaClimateFindLocations, 'datasetId'],
    ['noaa_climate_find_locations.datacategoryId', noaaClimateFindLocations, 'datacategoryId'],
    ['noaa_climate_find_stations.locationId', noaaClimateFindStations, 'locationId'],
    ['noaa_climate_find_stations.datasetId', noaaClimateFindStations, 'datasetId'],
    ['noaa_climate_find_stations.datacategoryId', noaaClimateFindStations, 'datacategoryId'],
    ['noaa_climate_find_stations.extent', noaaClimateFindStations, 'extent'],
  ] as const;

  it.each(cases)('%s rejects an empty string', (_label, def, field) => {
    expect(() => def.input.parse({ [field]: '' })).toThrow();
  });

  it.each(cases)('%s rejects a whitespace-only string', (_label, def, field) => {
    expect(() => def.input.parse({ [field]: '   ' })).toThrow();
  });

  it.each(cases)('%s accepts a real identifier unmodified', (_label, def, field) => {
    const value = field === 'extent' ? '47.5,-122.4,47.7,-122.1' : 'GHCND:USC00450974';
    const parsed = def.input.parse({ [field]: value }) as Record<string, unknown>;
    expect(parsed[field]).toBe(value);
  });

  it('noaa_climate_get_station.stationId already rejects empty (reference pattern)', () => {
    expect(() => noaaClimateGetStation.input.parse({ stationId: '' })).toThrow();
    expect(() => noaaClimateGetStation.input.parse({ stationId: '  ' })).toThrow();
  });
});

describe('array identifier filters reject empty arrays and blank entries', () => {
  const cases = [
    ['noaa_climate_list_datasets.datatypeId', noaaClimateListDatasets, 'datatypeId'],
    ['noaa_climate_find_stations.datatypeId', noaaClimateFindStations, 'datatypeId'],
    ['noaa_climate_fetch_data.stationId', noaaClimateFetchData, 'stationId'],
    ['noaa_climate_fetch_data.locationId', noaaClimateFetchData, 'locationId'],
    ['noaa_climate_fetch_data.datatypeId', noaaClimateFetchData, 'datatypeId'],
  ] as const;

  const base = { datasetId: 'GHCND', startDate: '2024-07-01', endDate: '2024-07-07' };
  const requiredInput = (def: (typeof cases)[number][1]) =>
    def === noaaClimateFetchData ? base : {};

  it.each(cases)('%s rejects an empty array', (_label, def, field) => {
    expect(() => def.input.parse({ ...requiredInput(def), [field]: [] })).toThrow();
  });

  it.each(cases)('%s rejects an empty-string entry', (_label, def, field) => {
    expect(() => def.input.parse({ ...requiredInput(def), [field]: [''] })).toThrow();
  });

  it.each(cases)('%s rejects a whitespace-only entry', (_label, def, field) => {
    expect(() => def.input.parse({ ...requiredInput(def), [field]: ['  '] })).toThrow();
  });

  it.each(cases)('%s rejects a blank entry mixed with a valid one', (_label, def, field) => {
    expect(() => def.input.parse({ ...requiredInput(def), [field]: ['TMAX', ''] })).toThrow();
  });

  it.each(cases)('%s accepts real identifiers unmodified', (_label, def, field) => {
    const parsed = def.input.parse({
      ...requiredInput(def),
      [field]: ['TMAX', 'TMIN'],
    }) as Record<string, unknown>;
    expect(parsed[field]).toEqual(['TMAX', 'TMIN']);
  });
});

describe('noaa_climate_fetch_data — startDate > endDate is a handler-level contract failure', () => {
  it('throws validation_error and never calls the service', async () => {
    const ctx = createMockContext({ errors: noaaClimateFetchData.errors });
    const input = noaaClimateFetchData.input.parse({
      datasetId: 'GHCND',
      startDate: '2024-07-10',
      endDate: '2024-07-01',
    });

    await expect(noaaClimateFetchData.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'validation_error' },
    });
    expect(vi.mocked(getCdoService)().fetchData).not.toHaveBeenCalled();
  });

  it('carries an actionable recovery hint naming the ordering rule', async () => {
    const ctx = createMockContext({ errors: noaaClimateFetchData.errors });
    const input = noaaClimateFetchData.input.parse({
      datasetId: 'GHCND',
      startDate: '2024-07-10',
      endDate: '2024-07-01',
    });

    await expect(noaaClimateFetchData.handler(input, ctx)).rejects.toMatchObject({
      data: { recovery: { hint: expect.stringContaining('endDate') } },
    });
  });

  it('allows startDate === endDate (single-day query)', async () => {
    const ctx = createMockContext({ errors: noaaClimateFetchData.errors });
    const input = noaaClimateFetchData.input.parse({
      datasetId: 'GHCND',
      startDate: '2024-07-01',
      endDate: '2024-07-01',
    });

    await expect(noaaClimateFetchData.handler(input, ctx)).resolves.toBeDefined();
  });

  it('compares dates by instant, not lexically — a datetime start against a bare-date end of the same day is not inverted', async () => {
    const ctx = createMockContext({ errors: noaaClimateFetchData.errors });
    const input = noaaClimateFetchData.input.parse({
      datasetId: 'GHCND',
      startDate: '2024-07-01T00:00:00',
      endDate: '2024-07-01',
    });

    await expect(noaaClimateFetchData.handler(input, ctx)).resolves.toBeDefined();
  });

  it('measures the range limit consistently across bare-date and datetime forms', async () => {
    const ctx = createMockContext({ errors: noaaClimateFetchData.errors });
    const input = noaaClimateFetchData.input.parse({
      datasetId: 'GHCND',
      startDate: '2024-01-01T00:00:00',
      endDate: '2024-12-30',
    });

    await expect(noaaClimateFetchData.handler(input, ctx)).resolves.toBeDefined();
  });
});

describe('noaa_climate_fetch_data — guards still fire for the compact and unpadded date forms', () => {
  /** Same instant expressed four ways; every guard must read them identically. */
  const INVERTED_RANGES = [
    ['dashed', '2024-07-10', '2024-07-01'],
    ['compact', '20240710', '20240701'],
    ['unpadded', '2024-7-10', '2024-7-1'],
    ['mixed', '20240710', '2024-7-1'],
  ] as const;

  it.each(INVERTED_RANGES)(
    'rejects a %s startDate after endDate',
    async (_form, startDate, endDate) => {
      const ctx = createMockContext({ errors: noaaClimateFetchData.errors });
      const input = noaaClimateFetchData.input.parse({ datasetId: 'GHCND', startDate, endDate });

      await expect(noaaClimateFetchData.handler(input, ctx)).rejects.toMatchObject({
        data: { reason: 'validation_error' },
      });
      expect(vi.mocked(getCdoService)().fetchData).not.toHaveBeenCalled();
    },
  );

  /** 731 days on GHCND — twice the 365-day daily-dataset cap. */
  const OVERLONG_RANGES = [
    ['dashed', '2020-01-01', '2021-12-31'],
    ['compact', '20200101', '20211231'],
    ['unpadded', '2020-1-1', '2021-12-31'],
    ['mixed', '20200101', '2021-12-31'],
  ] as const;

  it.each(OVERLONG_RANGES)(
    'rejects a %s range that exceeds the dataset limit',
    async (_form, startDate, endDate) => {
      const ctx = createMockContext({ errors: noaaClimateFetchData.errors });
      const input = noaaClimateFetchData.input.parse({ datasetId: 'GHCND', startDate, endDate });

      await expect(noaaClimateFetchData.handler(input, ctx)).rejects.toMatchObject({
        data: { reason: 'date_range_exceeded', requestedDays: 731 },
      });
      expect(vi.mocked(getCdoService)().fetchData).not.toHaveBeenCalled();
    },
  );

  const IN_RANGE = [
    ['dashed', '2024-01-01', '2024-07-01'],
    ['compact', '20240101', '20240701'],
    ['unpadded', '2024-1-1', '2024-7-1'],
    ['mixed', '20240101', '2024-7-1'],
  ] as const;

  it.each(IN_RANGE)('admits a %s range inside the limit', async (_form, startDate, endDate) => {
    const ctx = createMockContext({ errors: noaaClimateFetchData.errors });
    const input = noaaClimateFetchData.input.parse({ datasetId: 'GHCND', startDate, endDate });

    await expect(noaaClimateFetchData.handler(input, ctx)).resolves.toBeDefined();
  });

  // `/data` is the one CDO endpoint that rejects the compact and unpadded forms
  // it advertises elsewhere, so the canonical form is what goes on the wire.
  it.each(['20240701', '2024-7-1'])('sends %s to CDO in the canonical form', async (startDate) => {
    const ctx = createMockContext({ errors: noaaClimateFetchData.errors });
    const input = noaaClimateFetchData.input.parse({
      datasetId: 'GHCND',
      startDate,
      endDate: '2024-07-07',
    });

    await noaaClimateFetchData.handler(input, ctx);

    const fetchData = vi.mocked(getCdoService)().fetchData as ReturnType<typeof vi.fn>;
    expect(fetchData.mock.calls[0]![0]).toMatchObject({ startdate: '2024-07-01' });
  });
});
