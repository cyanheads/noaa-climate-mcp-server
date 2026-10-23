/**
 * @fileoverview Exhausted-page vs no-match tests across every collection tool.
 * NOAA CDO answers an offset past the final page with a bare `{}` — no `results`
 * key and no `metadata` — which is byte-identical to its genuine no-match reply.
 * @module tests/tools/pagination-exhausted.test
 */

import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { noaaClimateFetchData } from '@/mcp-server/tools/definitions/noaa-climate-fetch-data.tool.js';
import { noaaClimateFindLocations } from '@/mcp-server/tools/definitions/noaa-climate-find-locations.tool.js';
import { noaaClimateFindStations } from '@/mcp-server/tools/definitions/noaa-climate-find-stations.tool.js';
import { noaaClimateListDataCategories } from '@/mcp-server/tools/definitions/noaa-climate-list-data-categories.tool.js';
import { noaaClimateListDataTypes } from '@/mcp-server/tools/definitions/noaa-climate-list-data-types.tool.js';
import { noaaClimateListDatasets } from '@/mcp-server/tools/definitions/noaa-climate-list-datasets.tool.js';
import { noaaClimateListLocationCategories } from '@/mcp-server/tools/definitions/noaa-climate-list-location-categories.tool.js';

vi.mock('@/services/cdo/cdo-service.js', () => ({
  getCdoService: vi.fn(),
}));

import { getCdoService } from '@/services/cdo/cdo-service.js';
import { firstText } from '../helpers/content.js';

const TOTAL = 51;

/** A record satisfying every collection tool's output schema. */
const RECORD = {
  id: 'FIPS:37',
  name: 'North Carolina',
  datacoverage: 1,
  mindate: '1869-03-01',
  maxdate: '2024-12-31',
  date: '2024-07-01T00:00:00',
  datatype: 'TMAX',
  station: 'GHCND:USC00450974',
  value: 25.6,
};

/**
 * Mirrors live CDO paging: a page within range carries results + metadata; an
 * offset at or past the end returns a bare `{}`.
 */
function cdoPager(total = TOTAL) {
  return vi.fn(async (params: { limit?: number; offset?: number }) => {
    const limit = params.limit ?? 25;
    const offset = params.offset ?? 0;
    if (offset >= total) return {};
    const n = Math.max(0, Math.min(limit, total - offset));
    return {
      results: Array.from({ length: n }, (_, index) => ({
        ...RECORD,
        id: `record-${offset + index}`,
        station: `GHCND:record-${offset + index}`,
      })),
      metadata: { resultset: { count: total, limit, offset: offset + 1 } },
    };
  });
}

/** A filter combination with zero real matches — bare `{}` at every offset. */
function cdoEmpty() {
  return vi.fn(async () => ({}));
}

const DATE_ARGS = { datasetId: 'GHCND', startDate: '2024-07-01', endDate: '2024-07-07' };

const TOOLS = [
  {
    name: 'noaa_climate_find_locations',
    def: noaaClimateFindLocations,
    method: 'findLocations',
    args: { locationCategoryId: 'ST' },
    noticeMatch: /No locations/i,
  },
  {
    name: 'noaa_climate_find_stations',
    def: noaaClimateFindStations,
    method: 'findStations',
    args: { locationId: 'FIPS:53' },
    noticeMatch: /No stations/i,
  },
  {
    name: 'noaa_climate_list_data_types',
    def: noaaClimateListDataTypes,
    method: 'listDataTypes',
    args: { datasetId: 'GHCND' },
    noticeMatch: /No data types/i,
  },
  {
    name: 'noaa_climate_list_datasets',
    def: noaaClimateListDatasets,
    method: 'listDatasets',
    args: {},
    noticeMatch: /No datasets/i,
  },
  {
    name: 'noaa_climate_list_data_categories',
    def: noaaClimateListDataCategories,
    method: 'listDataCategories',
    args: {},
    noticeMatch: /No data categories/i,
  },
  {
    name: 'noaa_climate_list_location_categories',
    def: noaaClimateListLocationCategories,
    method: 'listLocationCategories',
    args: {},
    noticeMatch: /No location categories/i,
  },
  {
    name: 'noaa_climate_fetch_data',
    def: noaaClimateFetchData,
    method: 'fetchData',
    args: DATE_ARGS,
    noticeMatch: /No observation records/i,
  },
] as const;

function install(method: string, impl: ReturnType<typeof cdoPager> | ReturnType<typeof cdoEmpty>) {
  vi.mocked(getCdoService).mockReturnValue({ [method]: impl } as unknown as ReturnType<
    typeof getCdoService
  >);
  return impl;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe.each(TOOLS)('$name — applied page limit', ({ def, method, args, noticeMatch }) => {
  it('clamps before the request and preserves consecutive pages on both surfaces', async () => {
    const impl = install(method, cdoPager(1002));
    const first = await runToolContract(def, { ...args, limit: 1001, offset: 0 });
    const next = await runToolContract(def, { ...args, limit: 1001, offset: 1000 });
    for (const [result, offset, length] of [
      [first, 0, 1000],
      [next, 1000, 2],
    ] as const) {
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        totalCount: 1002,
        metadata: { resultset: { count: 1002, limit: 1000, offset } },
        notice: expect.stringContaining('Requested limit 1001 was clamped to 1000'),
      });
      expect(def.output.parse(result.structuredContent).results).toHaveLength(length);
      const text = result.content
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('\n');
      expect(text).toContain('Requested limit 1001 was clamped to 1000');
      expect(text).toContain('**Limit:** 1000');
      expect(text).toContain(`**Offset:** ${offset}`);
      expect(text).toContain(`record-${offset}`);
      expect(text).toContain(`record-${offset + length - 1}`);
      expect(text).not.toContain(`record-${offset + length}`);
    }
    expect(impl.mock.calls.map(([params]) => params)).toEqual([
      expect.objectContaining({ limit: 1000, offset: 0 }),
      expect.objectContaining({ limit: 1000, offset: 1000 }),
    ]);
  });

  it.each([false, true])(
    'composes the clamp with an empty page (exhausted=%s)',
    async (exhausted) => {
      const impl = exhausted ? install(method, cdoPager()) : install(method, cdoEmpty());
      const result = await runToolContract(def, { ...args, limit: 1001, offset: 1000 });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        results: [],
        totalCount: exhausted ? 51 : 0,
        notice: expect.stringContaining('Requested limit 1001 was clamped to 1000'),
      });
      if (exhausted) expect(result.structuredContent).toHaveProperty('exhausted', true);
      else expect(result.structuredContent).not.toHaveProperty('exhausted');
      const text = result.content
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('\n');
      expect(text).toContain('Requested limit 1001 was clamped to 1000');
      if (exhausted) {
        expect(text).toContain('offset 1000 is past the end of 51');
        expect(text).not.toMatch(noticeMatch);
      } else {
        expect(text).toMatch(noticeMatch);
      }
      expect(impl).toHaveBeenCalledTimes(2);
      expect(impl.mock.calls[0]?.[0]).toMatchObject({ limit: 1000, offset: 1000 });
      expect(impl.mock.calls[1]?.[0]).toMatchObject({ limit: 1, offset: 0 });
    },
  );

  it.each([0, -1, 1.5, 'many'])(
    'rejects invalid limit %j before calling the service',
    async (limit) => {
      const impl = install(method, cdoPager());
      const result = await runToolContract(def, { ...args, limit } as never);
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({ error: { code: -32602 } });
      expect(firstText(result.content)).toContain('limit');
      expect(impl).not.toHaveBeenCalled();
    },
  );
});

describe.each(TOOLS)('$name — exhausted page', ({ def, method, args, noticeMatch }) => {
  it('reports the true total instead of zero', async () => {
    install(method, cdoPager());
    const ctx = createMockContext({ errors: def.errors });
    const input = def.input.parse({ ...args, limit: 5, offset: 55 });

    await def.handler(input as never, ctx as never);

    expect(getEnrichment(ctx).totalCount).toBe(TOTAL);
  });

  it('flags the page as exhausted', async () => {
    install(method, cdoPager());
    const ctx = createMockContext({ errors: def.errors });
    const input = def.input.parse({ ...args, limit: 5, offset: 55 });

    await def.handler(input as never, ctx as never);

    expect(getEnrichment(ctx).exhausted).toBe(true);
  });

  it('advises resetting or lowering offset, and does not claim a no-match', async () => {
    install(method, cdoPager());
    const ctx = createMockContext({ errors: def.errors });
    const input = def.input.parse({ ...args, limit: 5, offset: 55 });

    await def.handler(input as never, ctx as never);

    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toMatch(/offset/i);
    expect(notice).not.toMatch(noticeMatch);
  });

  it('makes exactly one bounded probe, reusing the filters and resetting only pagination', async () => {
    const impl = install(method, cdoPager());
    const ctx = createMockContext({ errors: def.errors });
    const input = def.input.parse({ ...args, limit: 5, offset: 55 });

    await def.handler(input as never, ctx as never);

    expect(impl).toHaveBeenCalledTimes(2);
    const probe = impl.mock.calls[1]![0] as Record<string, unknown>;
    const original = impl.mock.calls[0]![0] as Record<string, unknown>;
    expect(probe.offset).toBe(0);
    for (const [key, value] of Object.entries(original)) {
      if (['offset', 'limit', 'includemetadata'].includes(key)) continue;
      expect(probe[key]).toEqual(value);
    }
  });

  it('declares exhausted in its enrichment block', () => {
    expect(def.enrichment).toHaveProperty('exhausted');
  });
});

describe.each(TOOLS)('$name — genuine no-match', ({ def, method, args, noticeMatch }) => {
  it('reports zero and keeps the no-match guidance', async () => {
    install(method, cdoEmpty());
    const ctx = createMockContext({ errors: def.errors });
    const input = def.input.parse({ ...args });

    await def.handler(input as never, ctx as never);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalCount).toBe(0);
    expect(enrichment.notice as string).toMatch(noticeMatch);
  });

  it('does not flag an exhausted page', async () => {
    install(method, cdoEmpty());
    const ctx = createMockContext({ errors: def.errors });
    const input = def.input.parse({ ...args });

    await def.handler(input as never, ctx as never);

    expect(getEnrichment(ctx).exhausted).toBeUndefined();
  });

  it('makes no probe at offset 0 — the bare response is already authentic', async () => {
    const impl = install(method, cdoEmpty());
    const ctx = createMockContext({ errors: def.errors });
    const input = def.input.parse({ ...args });

    await def.handler(input as never, ctx as never);

    expect(impl).toHaveBeenCalledTimes(1);
  });

  it('probes at a nonzero offset but still reports zero when nothing matches', async () => {
    const impl = install(method, cdoEmpty());
    const ctx = createMockContext({ errors: def.errors });
    const input = def.input.parse({ ...args, offset: 20 });

    await def.handler(input as never, ctx as never);

    expect(impl).toHaveBeenCalledTimes(2);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalCount).toBe(0);
    expect(enrichment.exhausted).toBeUndefined();
    expect(enrichment.notice as string).toMatch(noticeMatch);
  });
});

describe.each(TOOLS)('$name — populated page', ({ def, method, args }) => {
  it('preserves an in-range page and its total on both contract surfaces', async () => {
    install(method, cdoPager());
    const result = await runToolContract(def, { ...args, limit: 3, offset: 10 });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      totalCount: 51,
      metadata: { resultset: { count: 51, limit: 3, offset: 10 } },
    });
    expect(result.structuredContent).not.toHaveProperty('notice');
    const text = firstText(result.content);
    expect(text).toContain('**Limit:** 3');
    expect(text).toContain('**Offset:** 10');
    expect(text).toContain('record-10');
    expect(text).toContain('record-12');
  });

  it.each([0, 10])(
    'echoes zero-based offset %s on both surfaces without changing the page',
    async (offset) => {
      const impl = install(method, cdoPager());
      const ctx = createMockContext({ errors: def.errors });
      const input = def.input.parse({ ...args, limit: 3, offset });
      const result = await def.handler(input as never, ctx as never);
      expect(result.metadata?.resultset).toEqual({ count: TOTAL, limit: 3, offset });
      expect(result.results.map((record) => ('id' in record ? record.id : record.station))).toEqual(
        Array.from({ length: 3 }, (_, index) =>
          method === 'fetchData' ? `GHCND:record-${offset + index}` : `record-${offset + index}`,
        ),
      );
      expect(firstText(def.format!(result as never))).toContain(`**Offset:** ${offset}`);
      expect(impl).toHaveBeenCalledTimes(1);
    },
  );

  it('keeps metadata absent on populated metadata-less pages', async () => {
    const impl = vi.fn(async () => ({ results: [RECORD] }));
    vi.mocked(getCdoService).mockReturnValue({ [method]: impl } as unknown as ReturnType<
      typeof getCdoService
    >);
    const input = def.input.parse({ ...args, limit: 3, offset: 10 });
    const result = await def.handler(
      input as never,
      createMockContext({ errors: def.errors }) as never,
    );
    expect(result.metadata).toBeUndefined();
    expect(firstText(def.format!(result as never))).not.toContain('**Offset:**');
    expect(impl).toHaveBeenCalledTimes(1);
  });
  it('makes no probe and emits no notice', async () => {
    const impl = install(method, cdoPager());
    const ctx = createMockContext({ errors: def.errors });
    const input = def.input.parse({ ...args, limit: 5, offset: 0 });

    await def.handler(input as never, ctx as never);

    expect(impl).toHaveBeenCalledTimes(1);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalCount).toBe(TOTAL);
    expect(enrichment).not.toHaveProperty('notice');
    expect(enrichment.exhausted).toBeUndefined();
  });

  it('makes no probe on a mid-range page at a nonzero offset', async () => {
    const impl = install(method, cdoPager());
    const ctx = createMockContext({ errors: def.errors });
    const input = def.input.parse({ ...args, limit: 5, offset: 10 });

    await def.handler(input as never, ctx as never);

    expect(impl).toHaveBeenCalledTimes(1);
    expect(getEnrichment(ctx).totalCount).toBe(TOTAL);
  });
});

describe('noaa_climate_fetch_data — #19 and #21 layered', () => {
  it('probes for the total on an exhausted page while still omitting output metadata', async () => {
    const impl = install('fetchData', cdoPager(7));
    const ctx = createMockContext({ errors: noaaClimateFetchData.errors });
    const input = noaaClimateFetchData.input.parse({
      ...DATE_ARGS,
      limit: 2,
      offset: 9,
      includemetadata: false,
    });

    const result = await noaaClimateFetchData.handler(input, ctx);

    expect(impl).toHaveBeenCalledTimes(2);
    expect(result.metadata).toBeUndefined();
    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalCount).toBe(7);
    expect(enrichment.exhausted).toBe(true);
  });
});
