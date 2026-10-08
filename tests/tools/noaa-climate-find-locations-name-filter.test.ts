/**
 * @fileoverview `nameContains` on noaa_climate_find_locations — the synthesized
 * name search CDO does not offer.
 *
 * The filter is applied to a complete client-side enumeration of one category,
 * never to a single upstream page: filtering a page would leave `totalCount`
 * describing the raw category while the results describe something else. Every
 * count the caller sees — enrichment, `metadata.resultset`, and the `format()`
 * header — therefore has to describe the filtered view.
 * @module tests/tools/noaa-climate-find-locations-name-filter.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { noaaClimateFindLocations } from '@/mcp-server/tools/definitions/noaa-climate-find-locations.tool.js';
import { firstText } from '../helpers/content.js';
import { contractFailure } from '../helpers/contract-failure.js';

vi.mock('@/services/cdo/cdo-service.js', () => ({
  getCdoService: vi.fn(),
}));

import { getCdoService } from '@/services/cdo/cdo-service.js';

/** Live CITY size, measured against `/locations?locationcategoryid=CITY&limit=1`. */
const CITY_COUNT = 1989;

/** Live HYD_CAT size — larger than CITY, which is why eligibility is a count, not a name list. */
const HYD_CAT_COUNT = 2111;

/** Live CNTY size — inside the four-page enumeration budget, by 822 entries. */
const CNTY_COUNT = 3178;

/** Live ZIP size — 31 pages, the case the budget exists to refuse. */
const ZIP_COUNT = 30_415;

/** Names seeded into the synthetic category at fixed indexes. */
const SEEDED: ReadonlyArray<readonly [number, string, string]> = [
  [4, 'CITY:US530018', 'Seattle, WA US'],
  [1200, 'CITY:US000002', 'West Seattle Junction, WA US'], // lands on the second fetched page
  [1500, 'CITY:US000003', 'SEATTLE HEIGHTS, WA US'], // upper-case, exercises case folding
];

/**
 * A category of `total` locations, paged the way CDO pages: an offset past the
 * end answers with a bare `{}`, and every in-range page echoes the full count.
 */
function installCategory(total: number) {
  const findLocations = vi.fn(async (params: { limit?: number; offset?: number } = {}) => {
    const limit = params.limit ?? 25;
    const offset = params.offset ?? 0;
    if (offset >= total) return {};
    const size = Math.min(limit, total - offset);
    const results = Array.from({ length: size }, (_, i) => {
      const index = offset + i;
      const seed = SEEDED.find(([at]) => at === index);
      return seed
        ? { id: seed[1], name: seed[2], datacoverage: 1 }
        : { id: `CITY:FILLER${index}`, name: `Filler ${index}, XX US` };
    });
    return { results, metadata: { resultset: { count: total, limit, offset: offset + 1 } } };
  });
  vi.mocked(getCdoService).mockReturnValue({ findLocations } as unknown as ReturnType<
    typeof getCdoService
  >);
  return findLocations;
}

beforeEach(() => {
  vi.clearAllMocks();
  installCategory(CITY_COUNT);
});

describe('nameContains — matching', () => {
  it('returns every substring match across the full enumeration, not just the first page', async () => {
    const impl = installCategory(CITY_COUNT);
    const ctx = createMockContext({ errors: noaaClimateFindLocations.errors });
    const input = noaaClimateFindLocations.input.parse({
      locationCategoryId: 'CITY',
      nameContains: 'seattle',
    });

    const result = await noaaClimateFindLocations.handler(input, ctx);

    expect(impl).toHaveBeenCalledTimes(2); // 1,989 entries fit in two 1,000-row fetches
    expect(result.results.map((l) => l.id)).toEqual([
      'CITY:US530018',
      'CITY:US000002',
      'CITY:US000003',
    ]);
  });

  it('matches case-insensitively in both directions', async () => {
    const ctx = createMockContext({ errors: noaaClimateFindLocations.errors });
    const upper = noaaClimateFindLocations.input.parse({
      locationCategoryId: 'CITY',
      nameContains: 'SEATTLE',
    });

    const result = await noaaClimateFindLocations.handler(upper, ctx);

    // 'SEATTLE HEIGHTS' is stored upper-case; 'Seattle, WA US' is not.
    expect(result.results.map((l) => l.id)).toContain('CITY:US000003');
    expect(result.results.map((l) => l.id)).toContain('CITY:US530018');
  });

  it('enumerates a category larger than CITY within the page budget', async () => {
    const impl = installCategory(HYD_CAT_COUNT);
    const ctx = createMockContext({ errors: noaaClimateFindLocations.errors });
    const input = noaaClimateFindLocations.input.parse({
      locationCategoryId: 'HYD_CAT',
      nameContains: 'seattle',
    });

    await noaaClimateFindLocations.handler(input, ctx);

    expect(impl).toHaveBeenCalledTimes(3);
  });

  it('enumerates CNTY at its live size, on both consumption surfaces', async () => {
    const impl = installCategory(CNTY_COUNT);
    const ctx = createMockContext({ errors: noaaClimateFindLocations.errors });
    const input = noaaClimateFindLocations.input.parse({
      locationCategoryId: 'CNTY',
      nameContains: 'seattle',
    });

    const result = await noaaClimateFindLocations.handler(input, ctx);

    expect(impl).toHaveBeenCalledTimes(4); // 3,178 entries across four 1,000-row fetches
    expect(result.results.map((l) => l.id)).toEqual([
      'CITY:US530018',
      'CITY:US000002',
      'CITY:US000003',
    ]);
    expect(getEnrichment(ctx).totalCount).toBe(3);
    const text = firstText(noaaClimateFindLocations.format!(result));
    expect(text).toContain('**Total:** 3');
    expect(text).toContain('CITY:US530018');
  });

  it('forwards the other domain filters on every enumeration fetch', async () => {
    const impl = installCategory(CITY_COUNT);
    const ctx = createMockContext({ errors: noaaClimateFindLocations.errors });
    const input = noaaClimateFindLocations.input.parse({
      locationCategoryId: 'CITY',
      nameContains: 'seattle',
      datasetId: 'GHCND',
      datacategoryId: 'TEMP',
      startDate: '2020-01-01',
      endDate: '2023-12-31',
      sortField: 'name',
    });

    await noaaClimateFindLocations.handler(input, ctx);

    for (const [call] of impl.mock.calls) {
      expect(call).toMatchObject({
        locationcategoryid: 'CITY',
        datasetid: 'GHCND',
        datacategoryid: 'TEMP',
        startdate: '2020-01-01',
        enddate: '2023-12-31',
        sortfield: 'name',
        limit: 1000,
      });
    }
  });
});

describe('nameContains — totals, pagination, and disclosure', () => {
  it('reports the post-filter count as totalCount, never the raw category size', async () => {
    const ctx = createMockContext({ errors: noaaClimateFindLocations.errors });
    const input = noaaClimateFindLocations.input.parse({
      locationCategoryId: 'CITY',
      nameContains: 'seattle',
    });

    await noaaClimateFindLocations.handler(input, ctx);

    expect(getEnrichment(ctx).totalCount).toBe(3);
    expect(getEnrichment(ctx).totalCount).not.toBe(CITY_COUNT);
  });

  it('synthesizes metadata.resultset from the filtered view, not the raw CDO echo', async () => {
    const ctx = createMockContext({ errors: noaaClimateFindLocations.errors });
    const input = noaaClimateFindLocations.input.parse({
      locationCategoryId: 'CITY',
      nameContains: 'seattle',
      limit: 2,
      offset: 1,
    });

    const result = await noaaClimateFindLocations.handler(input, ctx);

    // The raw echo from the last enumeration fetch would be { count: 1989,
    // limit: 1000, offset: 1001 } — an internal call the caller never made.
    expect(result.metadata?.resultset).toEqual({ count: 3, limit: 2, offset: 1 });
  });

  it('paginates the filtered array rather than the upstream fetch', async () => {
    const ctx = createMockContext({ errors: noaaClimateFindLocations.errors });
    const input = noaaClimateFindLocations.input.parse({
      locationCategoryId: 'CITY',
      nameContains: 'seattle',
      limit: 1,
      offset: 1,
    });

    const result = await noaaClimateFindLocations.handler(input, ctx);

    expect(result.results.map((l) => l.id)).toEqual(['CITY:US000002']);
    expect(getEnrichment(ctx).totalCount).toBe(3);
    expect(getEnrichment(ctx).exhausted).toBeUndefined();
  });

  it('returns fewer results than one page when the filter narrows a multi-page category', async () => {
    const ctx = createMockContext({ errors: noaaClimateFindLocations.errors });
    const input = noaaClimateFindLocations.input.parse({
      locationCategoryId: 'CITY',
      nameContains: 'seattle',
      limit: 25,
    });

    const result = await noaaClimateFindLocations.handler(input, ctx);

    expect(result.results).toHaveLength(3);
    expect(getEnrichment(ctx)).not.toHaveProperty('notice');
  });

  it('flags an offset past the end of the FILTERED set as exhausted', async () => {
    const ctx = createMockContext({ errors: noaaClimateFindLocations.errors });
    const input = noaaClimateFindLocations.input.parse({
      locationCategoryId: 'CITY',
      nameContains: 'seattle',
      offset: 3,
    });

    const result = await noaaClimateFindLocations.handler(input, ctx);

    expect(result.results).toEqual([]);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.exhausted).toBe(true);
    expect(enrichment.totalCount).toBe(3);
    expect(enrichment.notice as string).toMatch(/offset 3 is past the end of 3/i);
  });

  it('does not flag exhausted at an offset that is only past the raw category page', async () => {
    const ctx = createMockContext({ errors: noaaClimateFindLocations.errors });
    const input = noaaClimateFindLocations.input.parse({
      locationCategoryId: 'CITY',
      nameContains: 'seattle',
      offset: 2,
    });

    await noaaClimateFindLocations.handler(input, ctx);

    expect(getEnrichment(ctx).exhausted).toBeUndefined();
  });

  it('treats a filter matching nothing as the empty-result notice, not exhausted', async () => {
    const ctx = createMockContext({ errors: noaaClimateFindLocations.errors });
    const input = noaaClimateFindLocations.input.parse({
      locationCategoryId: 'CITY',
      nameContains: 'zzzznowhere',
      offset: 5,
    });

    const result = await noaaClimateFindLocations.handler(input, ctx);

    expect(result.results).toEqual([]);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalCount).toBe(0);
    expect(enrichment.exhausted).toBeUndefined();
    expect(enrichment.notice as string).toMatch(/No locations in category "CITY" contain/i);
    expect(enrichment.notice as string).toContain('zzzznowhere');
  });

  it('discloses the applied filter through the output schema, on both surfaces', async () => {
    const ctx = createMockContext({ errors: noaaClimateFindLocations.errors });
    const input = noaaClimateFindLocations.input.parse({
      locationCategoryId: 'CITY',
      nameContains: 'seattle',
    });

    const result = await noaaClimateFindLocations.handler(input, ctx);

    expect(result.appliedNameFilter).toBe('seattle');
    const text = firstText(noaaClimateFindLocations.format!(result));
    expect(text).toContain('seattle');
    expect(text).toContain('**Total:** 3');
    expect(text).toContain('CITY:US530018');
  });

  it('omits appliedNameFilter and its format() line on the unfiltered path', async () => {
    const ctx = createMockContext({ errors: noaaClimateFindLocations.errors });
    const input = noaaClimateFindLocations.input.parse({ locationCategoryId: 'CITY' });

    const result = await noaaClimateFindLocations.handler(input, ctx);

    expect(result.appliedNameFilter).toBeUndefined();
    expect(firstText(noaaClimateFindLocations.format!(result))).not.toContain('Name filter');
  });
});

describe('nameContains — declared failure modes', () => {
  it('rejects nameContains without a locationCategoryId, before any upstream call', async () => {
    const impl = installCategory(CITY_COUNT);

    const failure = await contractFailure(noaaClimateFindLocations, { nameContains: 'seattle' });

    expect(failure).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: {
        reason: 'name_filter_requires_category',
        recovery: { hint: expect.stringContaining('locationCategoryId') },
      },
    });
    expect(impl).not.toHaveBeenCalled();
  });

  it('rejects ZIP, whose live count exceeds the page budget', async () => {
    const impl = installCategory(ZIP_COUNT);

    const failure = await contractFailure(noaaClimateFindLocations, {
      locationCategoryId: 'ZIP',
      nameContains: 'seattle',
    });

    expect(failure).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: {
        reason: 'name_filter_category_too_large',
        categoryCount: ZIP_COUNT,
        maxEnumerable: 4000,
        recovery: { hint: expect.stringContaining('smaller category') },
      },
    });
    expect(impl).toHaveBeenCalledTimes(1); // the size probe is the only fetch
  });

  it('accepts a category sitting exactly on the page budget and rejects one past it', async () => {
    installCategory(4000);
    const ctx = createMockContext({ errors: noaaClimateFindLocations.errors });
    const atCap = noaaClimateFindLocations.input.parse({
      locationCategoryId: 'CITY',
      nameContains: 'seattle',
    });
    await expect(noaaClimateFindLocations.handler(atCap, ctx)).resolves.toBeDefined();

    installCategory(4001);
    const overCap = createMockContext({ errors: noaaClimateFindLocations.errors });
    await expect(noaaClimateFindLocations.handler(atCap, overCap)).rejects.toMatchObject({
      data: { reason: 'name_filter_category_too_large' },
    });
  });

  it('maps an upstream HTTP 400 on an enumeration fetch to validation_error', async () => {
    vi.mocked(getCdoService).mockReturnValue({
      findLocations: vi.fn().mockRejectedValue(
        new McpError(JsonRpcErrorCode.InvalidParams, 'NOAA CDO returned HTTP 400.', {
          status: 400,
        }),
      ),
    } as unknown as ReturnType<typeof getCdoService>);
    const ctx = createMockContext({ errors: noaaClimateFindLocations.errors });
    const input = noaaClimateFindLocations.input.parse({
      locationCategoryId: 'CITY',
      nameContains: 'seattle',
    });

    await expect(noaaClimateFindLocations.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'validation_error' },
    });
  });

  it('declares both name-filter reasons with actionable recovery hints', () => {
    const reasons = noaaClimateFindLocations.errors!.map((e) => e.reason);

    expect(reasons).toContain('name_filter_requires_category');
    expect(reasons).toContain('name_filter_category_too_large');
    for (const entry of noaaClimateFindLocations.errors!) {
      expect(entry.recovery.split(/\s+/).length).toBeGreaterThanOrEqual(5);
    }
  });
});

describe('nameContains — input schema', () => {
  it.each(['', '   ', '\t'])('rejects %j', (value) => {
    expect(() =>
      noaaClimateFindLocations.input.parse({ locationCategoryId: 'CITY', nameContains: value }),
    ).toThrow();
  });

  it('accepts a needle with surrounding spaces unmodified', () => {
    const parsed = noaaClimateFindLocations.input.parse({
      locationCategoryId: 'CITY',
      nameContains: ' seattle ',
    });

    expect(parsed.nameContains).toBe(' seattle ');
  });
});

describe('nameContains omitted — unfiltered path unchanged', () => {
  it('makes exactly one upstream fetch at the caller pagination and relays CDO metadata', async () => {
    const impl = installCategory(CITY_COUNT);
    const ctx = createMockContext({ errors: noaaClimateFindLocations.errors });
    const input = noaaClimateFindLocations.input.parse({
      locationCategoryId: 'CITY',
      limit: 5,
      offset: 10,
    });

    const result = await noaaClimateFindLocations.handler(input, ctx);

    expect(impl).toHaveBeenCalledTimes(1);
    expect(impl.mock.calls[0]![0]).toMatchObject({ limit: 5, offset: 10 });
    expect(result.results).toHaveLength(5);
    expect(result.metadata?.resultset).toEqual({ count: CITY_COUNT, limit: 5, offset: 11 });
    expect(getEnrichment(ctx).totalCount).toBe(CITY_COUNT);
  });
});
