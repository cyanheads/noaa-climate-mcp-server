/**
 * @fileoverview Tests for the noaa_climate_list_location_categories tool.
 * @module tests/tools/noaa-climate-list-location-categories.tool.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { noaaClimateFindLocations } from '@/mcp-server/tools/definitions/noaa-climate-find-locations.tool.js';
import { noaaClimateListLocationCategories } from '@/mcp-server/tools/definitions/noaa-climate-list-location-categories.tool.js';
import { firstText } from '../helpers/content.js';

vi.mock('@/services/cdo/cdo-service.js', () => ({
  getCdoService: vi.fn(),
}));

import { getCdoService } from '@/services/cdo/cdo-service.js';

/** The live CDO set, verified against `/locationcategories`. */
const LIVE_CATEGORIES = [
  { id: 'CITY', name: 'City' },
  { id: 'CLIM_DIV', name: 'Climate Division' },
  { id: 'CLIM_REG', name: 'Climate Region' },
  { id: 'CNTRY', name: 'Country' },
  { id: 'CNTY', name: 'County' },
  { id: 'HYD_ACC', name: 'Hydrologic Accounting Unit' },
  { id: 'HYD_CAT', name: 'Hydrologic Cataloging Unit' },
  { id: 'HYD_REG', name: 'Hydrologic Region' },
  { id: 'HYD_SUB', name: 'Hydrologic Subregion' },
  { id: 'ST', name: 'State' },
  { id: 'US_TERR', name: 'US Territory' },
  { id: 'ZIP', name: 'Zip Code' },
];

function installPager() {
  const listLocationCategories = vi.fn(async (params: { limit?: number; offset?: number } = {}) => {
    const limit = params.limit ?? 25;
    const offset = params.offset ?? 0;
    if (offset >= LIVE_CATEGORIES.length) return {};
    return {
      results: LIVE_CATEGORIES.slice(offset, offset + limit),
      metadata: {
        resultset: { count: LIVE_CATEGORIES.length, limit, offset: offset + 1 },
      },
    };
  });
  vi.mocked(getCdoService).mockReturnValue({ listLocationCategories } as unknown as ReturnType<
    typeof getCdoService
  >);
  return listLocationCategories;
}

beforeEach(() => {
  vi.clearAllMocks();
  installPager();
});

describe('noaaClimateListLocationCategories — happy path', () => {
  it('returns every live category with the upstream metadata', async () => {
    const ctx = createMockContext({ errors: noaaClimateListLocationCategories.errors });
    const input = noaaClimateListLocationCategories.input.parse({ limit: 1000 });

    const result = await noaaClimateListLocationCategories.handler(input, ctx);

    expect(result.results).toHaveLength(12);
    expect(result.results.map((c) => c.id)).toContain('US_TERR');
    expect(result.results.map((c) => c.id)).toContain('HYD_REG');
    expect(result.metadata?.resultset.count).toBe(12);
  });

  it('enriches with the total and emits no notice', async () => {
    const ctx = createMockContext({ errors: noaaClimateListLocationCategories.errors });
    const input = noaaClimateListLocationCategories.input.parse({ limit: 1000 });

    await noaaClimateListLocationCategories.handler(input, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalCount).toBe(12);
    expect(enrichment).not.toHaveProperty('notice');
    expect(enrichment.exhausted).toBeUndefined();
  });

  it('converts pagination and sort but sends no domain filter upstream', async () => {
    const impl = installPager();
    const ctx = createMockContext({ errors: noaaClimateListLocationCategories.errors });
    const input = noaaClimateListLocationCategories.input.parse({
      limit: 5,
      offset: 5,
      sortField: 'name',
      sortOrder: 'desc',
    });

    await noaaClimateListLocationCategories.handler(input, ctx);

    const sent = impl.mock.calls[0]![0] as Record<string, unknown>;
    expect(sent).toEqual({ limit: 5, offset: 5, sortfield: 'name', sortorder: 'desc' });
    for (const forbidden of [
      'datasetid',
      'locationid',
      'stationid',
      'datacategoryid',
      'startdate',
      'enddate',
    ]) {
      expect(sent).not.toHaveProperty(forbidden);
    }
  });

  it('advertises no domain filters on its input schema', () => {
    const json = z.toJSONSchema(noaaClimateListLocationCategories.input, {
      io: 'input',
    }) as unknown as { properties: Record<string, unknown> };

    expect(Object.keys(json.properties).sort()).toEqual([
      'limit',
      'offset',
      'sortField',
      'sortOrder',
    ]);
  });
});

describe('noaaClimateListLocationCategories — boundaries', () => {
  it('flags an offset past the end as exhausted rather than a no-match', async () => {
    const impl = installPager();
    const ctx = createMockContext({ errors: noaaClimateListLocationCategories.errors });
    const input = noaaClimateListLocationCategories.input.parse({ offset: 20 });

    const result = await noaaClimateListLocationCategories.handler(input, ctx);

    expect(result.results).toEqual([]);
    expect(impl).toHaveBeenCalledTimes(2); // one page, one bounded probe
    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalCount).toBe(12);
    expect(enrichment.exhausted).toBe(true);
    expect(enrichment.notice as string).toMatch(/offset/i);
  });

  it('reports an empty upstream response at offset 0 as a genuine empty result', async () => {
    vi.mocked(getCdoService).mockReturnValue({
      listLocationCategories: vi.fn().mockResolvedValue({}),
    } as unknown as ReturnType<typeof getCdoService>);
    const ctx = createMockContext({ errors: noaaClimateListLocationCategories.errors });
    const input = noaaClimateListLocationCategories.input.parse({});

    await noaaClimateListLocationCategories.handler(input, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalCount).toBe(0);
    expect(enrichment.exhausted).toBeUndefined();
    expect(enrichment.notice as string).toMatch(/No location categories/i);
  });

  it('rejects out-of-range pagination at the schema', () => {
    expect(() => noaaClimateListLocationCategories.input.parse({ limit: 0 })).toThrow();
    expect(noaaClimateListLocationCategories.input.parse({ limit: 1001 }).limit).toBe(1001);
    expect(() => noaaClimateListLocationCategories.input.parse({ offset: -1 })).toThrow();
    expect(() => noaaClimateListLocationCategories.input.parse({ sortField: 'count' })).toThrow();
  });

  it('defaults limit to 25 and offset to 0', () => {
    expect(noaaClimateListLocationCategories.input.parse({})).toMatchObject({
      limit: 25,
      offset: 0,
    });
  });
});

describe('noaaClimateListLocationCategories — error propagation', () => {
  it('maps an upstream HTTP 400 to the declared validation_error reason', async () => {
    vi.mocked(getCdoService).mockReturnValue({
      listLocationCategories: vi.fn().mockRejectedValue(
        new McpError(JsonRpcErrorCode.InvalidParams, 'NOAA CDO returned HTTP 400.', {
          status: 400,
        }),
      ),
    } as unknown as ReturnType<typeof getCdoService>);
    const ctx = createMockContext({ errors: noaaClimateListLocationCategories.errors });
    const input = noaaClimateListLocationCategories.input.parse({});

    await expect(noaaClimateListLocationCategories.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'validation_error' },
    });
  });

  // Uses a 500: the transient codes are routed onto declared reasons (see
  // cdo-upstream-rejection-routing), so an unrouted code is what still proves
  // the catch does not swallow whatever it was not built to answer.
  it('passes an unrouted McpError through unchanged', async () => {
    const serviceError = new McpError(
      JsonRpcErrorCode.InternalError,
      'NOAA CDO returned HTTP 500.',
      { status: 500 },
    );
    vi.mocked(getCdoService).mockReturnValue({
      listLocationCategories: vi.fn().mockRejectedValue(serviceError),
    } as unknown as ReturnType<typeof getCdoService>);
    const ctx = createMockContext({ errors: noaaClimateListLocationCategories.errors });
    const input = noaaClimateListLocationCategories.input.parse({});

    await expect(noaaClimateListLocationCategories.handler(input, ctx)).rejects.toBe(serviceError);
  });
});

describe('noaaClimateListLocationCategories — format()', () => {
  it('renders every category ID and name alongside the pagination line', () => {
    const blocks = noaaClimateListLocationCategories.format!({
      results: LIVE_CATEGORIES,
      metadata: { resultset: { count: 12, limit: 25, offset: 1 } },
    });
    const text = firstText(blocks);

    for (const cat of LIVE_CATEGORIES) {
      expect(text).toContain(cat.id);
      expect(text).toContain(cat.name);
    }
    expect(text).toContain('**Total:** 12');
  });

  it('renders the neutral empty-page line without pagination metadata', () => {
    const blocks = noaaClimateListLocationCategories.format!({ results: [] });

    expect(firstText(blocks)).toContain('_No records on this page._');
  });
});

describe('noaa_climate_find_locations — discovery cross-reference', () => {
  it('points at the new tool and names every live category, US_TERR included', () => {
    const json = z.toJSONSchema(noaaClimateFindLocations.input, {
      io: 'input',
    }) as unknown as { properties: { locationCategoryId: { description: string } } };
    const description = json.properties.locationCategoryId.description;

    expect(description).toContain('noaa_climate_list_location_categories');
    for (const cat of LIVE_CATEGORIES) {
      expect(description).toContain(cat.id);
    }
  });
});
