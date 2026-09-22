/**
 * @fileoverview Tests for BillionDollarDisastersService — cost-unit resolution,
 * preamble skipping, the two per-year export shapes, filtering, and the
 * upstream failures the exports can present.
 * @module tests/services/billion-dollar-disasters-service.test
 */

import type { McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Execute the retried function once, without backoff delays.
vi.mock('@cyanheads/mcp-ts-core/utils', async (importOriginal) => {
  const original = await importOriginal<typeof import('@cyanheads/mcp-ts-core/utils')>();
  return {
    ...original,
    withRetry: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  };
});

import { noaaClimateGetBillionDollarDisasters } from '@/mcp-server/tools/definitions/noaa-climate-get-billion-dollar-disasters.tool.js';
import { BillionDollarDisastersService } from '@/services/billion-dollar-disasters/billion-dollar-disasters-service.js';
import type {
  DisasterQuery,
  DisasterSummaryResult,
} from '@/services/billion-dollar-disasters/types.js';
import {
  EVENTS_CA_CSV,
  EVENTS_CA_CSV_CROSSING_NEW_YEAR,
  EVENTS_US_CSV,
  EVENTS_US_CSV_DECLARING_BILLIONS,
  EVENTS_US_CSV_DECLARING_UNKNOWN_UNIT,
  EVENTS_US_CSV_MISSING_COLUMN,
  EVENTS_US_CSV_WITHOUT_ROWS,
  EVENTS_US_CSV_WITHOUT_UNIT_NOTE,
  TIME_SERIES_CA_CSV,
  TIME_SERIES_US_CSV,
  TIME_SERIES_US_CSV_DECLARING_MILLIONS,
} from '../fixtures/billion-dollar-disasters.js';

const BASE_URL = 'https://mock-ncei.test/billions/';

const ONE_MILLION = 1_000_000;
const ONE_BILLION = 1_000_000_000;

const csvResponse = (body: string): Response =>
  new Response(body, { status: 200, headers: { 'Content-Type': 'text/csv' } });

const notFoundResponse = (): Response =>
  new Response('<!DOCTYPE html><html><body>Page not found</body></html>', {
    status: 404,
    headers: { 'Content-Type': 'text/html' },
  });

/** Serve each fixture at the filename NCEI publishes it under. */
function serveExports(files: Record<string, string>): void {
  vi.mocked(fetch).mockImplementation((input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    for (const [name, body] of Object.entries(files)) {
      if (url.endsWith(name)) return Promise.resolve(csvResponse(body));
    }
    return Promise.resolve(notFoundResponse());
  });
}

const NATIONAL_EXPORTS = {
  'events-US.csv': EVENTS_US_CSV,
  'time-series-US.csv': TIME_SERIES_US_CSV,
};

const query = (overrides: Partial<DisasterQuery> = {}): DisasterQuery => ({
  limit: 50,
  offset: 0,
  ...overrides,
});

/** A fresh service per call — the cache is per-instance and would mask a refetch. */
const service = () => new BillionDollarDisastersService(BASE_URL);

/** Await a call that must reject, and hand back the error it threw. */
async function rejection(promise: Promise<unknown>): Promise<McpError> {
  try {
    await promise;
  } catch (error) {
    return error as McpError;
  }
  throw new Error('Expected the call to reject, but it resolved.');
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('cost units', () => {
  it('converts the per-event export from the millions it declares to whole dollars', async () => {
    serveExports(NATIONAL_EXPORTS);
    const result = await service().searchEvents(query(), createMockContext());

    const helene = result.disasters.find((d) => d.name.startsWith('Hurricane Helene'));
    // NCEI writes 78721 in a file that declares millions.
    expect(helene?.cpiAdjustedCostInUsd).toBe(78_721 * ONE_MILLION);
    expect(helene?.cpiAdjustedCostInUsd).toBe(78_721_000_000);
    expect(helene?.unadjustedCostInUsd).toBe(78_721_000_000);
    expect(result.declaredCostUnit).toBe('millions of dollars');
  });

  it('converts the per-year export from the billions it declares to whole dollars', async () => {
    serveExports(NATIONAL_EXPORTS);
    const result = await service().searchSummaries(query(), createMockContext());

    const total2024 = result.summaries
      .find((s) => s.year === 2024)
      ?.byDisasterType.find((t) => t.disasterType === 'All Disasters');
    // NCEI writes 182.7 in a file that declares billions.
    expect(total2024?.costInUsd).toBe(182.7 * ONE_BILLION);
    expect(total2024?.costInUsd).toBe(182_700_000_000);
    expect(result.declaredCostUnit).toBe('billions of dollars');
  });

  it('follows each file’s declared unit rather than assuming one per export', async () => {
    // Identical rows and identical numbers in both fixtures; only the preamble's
    // unit word differs. A parser reading the declared unit scales the second
    // one 1,000x; a parser that hardcodes "events files are millions" returns
    // the same number twice.
    serveExports({ 'events-US.csv': EVENTS_US_CSV });
    const asMillions = await service().searchEvents(query(), createMockContext());

    serveExports({ 'events-US.csv': EVENTS_US_CSV_DECLARING_BILLIONS });
    const asBillions = await service().searchEvents(query(), createMockContext());

    const millions = asMillions.disasters[0]?.cpiAdjustedCostInUsd ?? 0;
    const billions = asBillions.disasters[0]?.cpiAdjustedCostInUsd ?? 0;
    expect(millions).toBeGreaterThan(0);
    expect(billions / millions).toBe(1_000);
  });

  it('follows the per-year export’s declared unit the same way', async () => {
    serveExports({ 'time-series-US.csv': TIME_SERIES_US_CSV });
    const asBillions = await service().searchSummaries(query(), createMockContext());

    serveExports({ 'time-series-US.csv': TIME_SERIES_US_CSV_DECLARING_MILLIONS });
    const asMillions = await service().searchSummaries(query(), createMockContext());

    const costOf = (result: DisasterSummaryResult) =>
      result.summaries
        .find((summary) => summary.year === 2024)
        ?.byDisasterType.find((tally) => tally.disasterType === 'All Disasters')?.costInUsd ?? 0;

    expect(costOf(asBillions) / costOf(asMillions)).toBe(1_000);
  });

  it('keeps the two exports’ 2024 figures on the same scale, which a unit swap would not', async () => {
    // The per-event and per-year exports describe the same disasters in
    // different units. Converted correctly, one year's event costs and that
    // year's reported total land within an order of magnitude of each other.
    // Swap the two multipliers and they diverge by a factor of a million, which
    // is exactly the failure that still looks plausible in isolation.
    serveExports(NATIONAL_EXPORTS);
    const events = await service().searchEvents(query({ startYear: 2024 }), createMockContext());
    const summaries = await service().searchSummaries(
      query({ startYear: 2024, endYear: 2024 }),
      createMockContext(),
    );

    const eventSum = events.disasters
      .filter((d) => d.beginDate.startsWith('2024'))
      .reduce((total, d) => total + d.cpiAdjustedCostInUsd, 0);
    const reportedTotal =
      summaries.summaries[0]?.byDisasterType.find((t) => t.disasterType === 'All Disasters')
        ?.costInUsd ?? 0;

    expect(eventSum).toBeGreaterThan(0);
    expect(reportedTotal).toBeGreaterThan(0);
    const ratio = reportedTotal / eventSum;
    expect(ratio).toBeGreaterThan(0.1);
    expect(ratio).toBeLessThan(10);
  });

  it('converts the per-state binned ranges from the millions that file declares', async () => {
    serveExports({ 'time-series-CA.csv': TIME_SERIES_CA_CSV });
    const result = await service().searchSummaries(query({ state: 'CA' }), createMockContext());

    const flooding1983 = result.summaries
      .find((s) => s.year === 1983)
      ?.byDisasterType.find((t) => t.disasterType === 'Flooding');
    // The cell reads `2000-5000` in a file declaring millions.
    expect(flooding1983?.costRangeInUsd).toEqual({
      low: 2_000 * ONE_MILLION,
      high: 5_000 * ONE_MILLION,
    });
    expect(result.declaredCostUnit).toBe('millions of dollars');
  });
});

describe('preamble handling', () => {
  it('skips the title and unit lines rather than reading row 1 as the header', async () => {
    serveExports(NATIONAL_EXPORTS);
    const result = await service().searchEvents(query(), createMockContext());

    expect(result.totalCount).toBe(6);
    expect(result.disasters[0]?.name).toBe('Southern Severe Storms and Flooding (April 1980)');
    expect(result.disasters.map((d) => d.name)).not.toContain(
      'Cost values are in millions of dollars',
    );
    expect(result.disasters.every((d) => d.disasterType.length > 0)).toBe(true);
  });

  it('skips the comment and blank lines ahead of the per-year header', async () => {
    serveExports(NATIONAL_EXPORTS);
    const result = await service().searchSummaries(query(), createMockContext());

    expect(result.totalCount).toBe(3);
    expect(result.summaries.map((s) => s.year)).toEqual([1980, 2023, 2024]);
  });

  it('reads a name whose quoted cell contains commas', async () => {
    serveExports(NATIONAL_EXPORTS);
    const result = await service().searchEvents(query(), createMockContext());

    const quoted = result.disasters.find((d) => d.name.startsWith('Severe Storms,'));
    expect(quoted?.name).toBe('Severe Storms, Flash Floods, Hail, Tornadoes (May 1981)');
    expect(quoted?.disasterType).toBe('Severe Storm');
    expect(quoted?.deaths).toBe(20);
  });
});

describe('per-year export shapes', () => {
  it('reports all seven classes plus the total, with confidence bands, on the national export', async () => {
    serveExports(NATIONAL_EXPORTS);
    const result = await service().searchSummaries(
      query({ startYear: 2024, endYear: 2024 }),
      createMockContext(),
    );

    const tallies = result.summaries[0]?.byDisasterType ?? [];
    expect(tallies.map((t) => t.disasterType)).toEqual([
      'Drought',
      'Flooding',
      'Freeze',
      'Severe Storm',
      'Tropical Cyclone',
      'Wildfire',
      'Winter Storm',
      'All Disasters',
    ]);

    const cyclones = tallies.find((t) => t.disasterType === 'Tropical Cyclone');
    expect(cyclones?.eventCount).toBe(5);
    expect(cyclones?.costInUsd).toBe(124 * ONE_BILLION);
    expect(cyclones?.confidenceBoundsInUsd).toEqual({
      lower75: 104.2 * ONE_BILLION,
      upper75: 143.5 * ONE_BILLION,
      lower90: 100.1 * ONE_BILLION,
      upper90: 147.9 * ONE_BILLION,
      lower95: 96.9 * ONE_BILLION,
      upper95: 152.4 * ONE_BILLION,
    });
    expect(cyclones?.costRangeInUsd).toBeUndefined();
  });

  it('reports a binned range and no point estimate on a per-state export', async () => {
    serveExports({ 'time-series-CA.csv': TIME_SERIES_CA_CSV });
    const result = await service().searchSummaries(
      query({ state: 'CA', startYear: 2022, endYear: 2022 }),
      createMockContext(),
    );

    const wildfire = result.summaries[0]?.byDisasterType.find((t) => t.disasterType === 'Wildfire');
    expect(wildfire?.eventCount).toBe(1);
    expect(wildfire?.costInUsd).toBeUndefined();
    expect(wildfire?.confidenceBoundsInUsd).toBeUndefined();
    expect(wildfire?.costRangeInUsd).toEqual({ low: 1_000_000_000, high: 2_000_000_000 });
  });

  it('reads a zero year without inventing a cost', async () => {
    serveExports({ 'time-series-CA.csv': TIME_SERIES_CA_CSV });
    const result = await service().searchSummaries(
      query({ state: 'CA', startYear: 2024, endYear: 2024 }),
      createMockContext(),
    );

    const total = result.summaries[0]?.byDisasterType.find(
      (t) => t.disasterType === 'All Disasters',
    );
    expect(total?.eventCount).toBe(0);
    expect(total?.costRangeInUsd).toEqual({ low: 0, high: 0 });
  });
});

describe('scope resolution', () => {
  it('requests the national export when no state is given', async () => {
    serveExports(NATIONAL_EXPORTS);
    await service().searchEvents(query(), createMockContext());

    expect(String(vi.mocked(fetch).mock.calls[0]?.[0])).toBe(`${BASE_URL}events-US.csv`);
  });

  it('requests the per-state export, upper-casing the code', async () => {
    serveExports({ 'events-CA.csv': EVENTS_CA_CSV });
    const result = await service().searchEvents(query({ state: 'ca' }), createMockContext());

    expect(String(vi.mocked(fetch).mock.calls[0]?.[0])).toBe(`${BASE_URL}events-CA.csv`);
    expect(result.sourceFile).toBe('events-CA.csv');
    expect(result.totalCount).toBe(3);
  });

  it('carries the national cost on a per-state event row, not a state share', async () => {
    serveExports(NATIONAL_EXPORTS);
    const national = await service().searchEvents(query(), createMockContext());
    serveExports({ 'events-CA.csv': EVENTS_CA_CSV });
    const state = await service().searchEvents(query({ state: 'CA' }), createMockContext());

    // The same disaster appears in both exports with the same figure — the
    // per-state file selects national disasters that reached the state, it does
    // not apportion their cost.
    const stateFlood = state.disasters.find((d) => d.name.startsWith('Western Storms'));
    expect(stateFlood?.cpiAdjustedCostInUsd).toBe(4_828.7 * ONE_MILLION);
    expect(national.disasters.some((d) => d.name.startsWith('Western Storms'))).toBe(false);
  });

  it('requests the per-state per-year export', async () => {
    serveExports({ 'time-series-CA.csv': TIME_SERIES_CA_CSV });
    await service().searchSummaries(query({ state: 'CA' }), createMockContext());

    expect(String(vi.mocked(fetch).mock.calls[0]?.[0])).toBe(`${BASE_URL}time-series-CA.csv`);
  });

  it('fails with unknown_state when NCEI publishes no export for the code', async () => {
    serveExports(NATIONAL_EXPORTS);
    await expect(
      service().searchEvents(query({ state: 'ZZ' }), createMockContext()),
    ).rejects.toMatchObject({ data: { reason: 'unknown_state' } });
  });

  it('names the state, not the internal URL, when an export is missing', async () => {
    serveExports(NATIONAL_EXPORTS);
    const error = await rejection(
      service().searchEvents(query({ state: 'ZZ' }), createMockContext()),
    );

    expect(error.message).toContain('ZZ');
    expect(error.message).not.toContain('mock-ncei.test');
  });
});

describe('filtering and paging', () => {
  beforeEach(() => {
    serveExports(NATIONAL_EXPORTS);
  });

  it('includes a disaster that overlaps the range without beginning inside it', async () => {
    // Runs 1982-12-01 to 1983-01-15; a 1983-only range must still return it.
    const result = await service().searchEvents(
      query({ startYear: 1983, endYear: 1983 }),
      createMockContext(),
    );

    expect(result.disasters.map((d) => d.name)).toEqual([
      'Gulf States Storms and Flooding (December 1982-January 1983)',
    ]);
  });

  it('filters to one disaster class, matched exactly', async () => {
    const result = await service().searchEvents(
      query({ disasterType: 'Tropical Cyclone' }),
      createMockContext(),
    );

    expect(result.totalCount).toBe(2);
    expect(result.disasters.every((d) => d.disasterType === 'Tropical Cyclone')).toBe(true);
  });

  it('filters on CPI-adjusted cost in whole dollars', async () => {
    const result = await service().searchEvents(
      query({ minCostInUsd: 30 * ONE_BILLION }),
      createMockContext(),
    );

    expect(result.disasters.map((d) => d.name)).toEqual([
      'Hurricane Helene (September 2024)',
      'Hurricane Milton (October 2024)',
    ]);
  });

  it('keeps a year whose reported total reaches the cost floor', async () => {
    const result = await service().searchSummaries(
      query({ minCostInUsd: 100 * ONE_BILLION }),
      createMockContext(),
    );

    expect(result.summaries.map((s) => s.year)).toEqual([2024]);
  });

  it('compares the cost floor against the named class when one is given', async () => {
    const result = await service().searchSummaries(
      query({ disasterType: 'Wildfire', minCostInUsd: 5 * ONE_BILLION }),
      createMockContext(),
    );

    // 2023 wildfire cost is 5.7B; 2024's is 1.8B and 1980's is 0.
    expect(result.summaries.map((s) => s.year)).toEqual([2023]);
    expect(result.summaries[0]?.byDisasterType.map((t) => t.disasterType)).toEqual(['Wildfire']);
  });

  it('pages with limit and offset while reporting the full match count', async () => {
    const page = await service().searchEvents(query({ limit: 2, offset: 2 }), createMockContext());

    expect(page.totalCount).toBe(6);
    expect(page.disasters).toHaveLength(2);
    expect(page.disasters[0]?.name).toBe(
      'Gulf States Storms and Flooding (December 1982-January 1983)',
    );
  });

  it('returns an empty page when offset runs past the end, without losing the count', async () => {
    const page = await service().searchEvents(query({ offset: 99 }), createMockContext());

    expect(page.totalCount).toBe(6);
    expect(page.disasters).toEqual([]);
  });

  it('returns nothing for a year the export does not cover', async () => {
    const result = await service().searchEvents(query({ startYear: 2026 }), createMockContext());

    expect(result.totalCount).toBe(0);
    expect(result.disasters).toEqual([]);
  });

  it('reports the year span the export actually holds', async () => {
    const result = await service().searchEvents(query(), createMockContext());

    expect(result.firstYear).toBe(1980);
    // The corpus ends at the last fully assessed year, not the current one.
    expect(result.lastYear).toBe(2024);
  });

  it('reaches the end year of a disaster that crosses a new year', async () => {
    // The overlap filter returns a row ending in 2023; a span read from begin
    // years alone reports the file as ending in 2022 and contradicts it.
    serveExports({ 'events-CA.csv': EVENTS_CA_CSV_CROSSING_NEW_YEAR });
    const result = await service().searchEvents(
      query({ state: 'CA', startYear: 2023 }),
      createMockContext(),
    );

    expect(result.disasters.map((d) => d.name)).toEqual([
      'California Flooding (December 2022-March 2023)',
    ]);
    expect(result.lastYear).toBe(2023);
  });

  it('lists the disaster classes present in the export for a zero-match notice', async () => {
    const result = await service().searchEvents(query(), createMockContext());

    expect(result.disasterTypesInFile).toEqual([
      'Drought',
      'Flooding',
      'Severe Storm',
      'Tropical Cyclone',
    ]);
  });
});

describe('malformed exports', () => {
  it('refuses an export declaring a cost unit it cannot convert', async () => {
    serveExports({ 'events-US.csv': EVENTS_US_CSV_DECLARING_UNKNOWN_UNIT });

    await expect(service().searchEvents(query(), createMockContext())).rejects.toMatchObject({
      data: { reason: 'malformed_export' },
    });
  });

  it('refuses an export with no declared cost unit rather than assuming one', async () => {
    serveExports({ 'events-US.csv': EVENTS_US_CSV_WITHOUT_UNIT_NOTE });

    await expect(service().searchEvents(query(), createMockContext())).rejects.toMatchObject({
      data: { reason: 'malformed_export' },
    });
  });

  it('refuses an export missing a column the reader needs', async () => {
    serveExports({ 'events-US.csv': EVENTS_US_CSV_MISSING_COLUMN });

    await expect(service().searchEvents(query(), createMockContext())).rejects.toMatchObject({
      data: { reason: 'malformed_export', missing: ['End Date'] },
    });
  });

  it('refuses an export carrying a header but no rows', async () => {
    serveExports({ 'events-US.csv': EVENTS_US_CSV_WITHOUT_ROWS });

    await expect(service().searchEvents(query(), createMockContext())).rejects.toMatchObject({
      data: { reason: 'malformed_export' },
    });
  });

  it('refuses a body with no recognizable header row', async () => {
    serveExports({ 'events-US.csv': 'not a csv at all\njust prose\n' });

    await expect(service().searchEvents(query(), createMockContext())).rejects.toMatchObject({
      data: { reason: 'malformed_export' },
    });
  });

  it.each([
    ['an unrecognized cost unit', EVENTS_US_CSV_DECLARING_UNKNOWN_UNIT],
    ['a missing column', EVENTS_US_CSV_MISSING_COLUMN],
    ['no rows', EVENTS_US_CSV_WITHOUT_ROWS],
    ['no header row', 'not a csv at all\njust prose\n'],
  ])('carries the declared malformed_export recovery hint for %s', async (_case, body) => {
    serveExports({ 'events-US.csv': body });
    const contract = noaaClimateGetBillionDollarDisasters.errors;
    const declared = contract?.find((entry) => entry.reason === 'malformed_export')?.recovery;
    const error = await rejection(
      service().searchEvents(query(), createMockContext({ errors: contract })),
    );

    expect(error.data).toMatchObject({ reason: 'malformed_export' });
    expect(declared).toBeDefined();
    expect(error.data?.recovery).toEqual({ hint: declared });
  });
});

describe('caching', () => {
  it('reads an export once and serves a second query from the cache', async () => {
    serveExports(NATIONAL_EXPORTS);
    const shared = service();

    await shared.searchEvents(query(), createMockContext());
    await shared.searchEvents(query({ disasterType: 'Drought' }), createMockContext());

    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });

  it('fetches the per-event and per-year exports separately', async () => {
    serveExports(NATIONAL_EXPORTS);
    const shared = service();

    await shared.searchEvents(query(), createMockContext());
    await shared.searchSummaries(query(), createMockContext());

    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
  });
});
