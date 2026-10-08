/**
 * @fileoverview Tests for the noaa_climate_search_storm_events tool — both
 * consumption surfaces (`structuredContent` from the handler, `content[]` from
 * `format()`), the enrichment disclosures, the recovery notices, and the input
 * contract.
 * @module tests/tools/noaa-climate-search-storm-events.tool.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { noaaClimateSearchStormEvents } from '@/mcp-server/tools/definitions/noaa-climate-search-storm-events.tool.js';
import type { StormEvent, StormEventsSearchResult } from '@/services/storm-events/types.js';
import { firstText } from '../helpers/content.js';
import { contractFailure } from '../helpers/contract-failure.js';

vi.mock('@/services/storm-events/storm-events-service.js', () => ({
  getStormEventsService: vi.fn(),
}));

import { getStormEventsService } from '@/services/storm-events/storm-events-service.js';

const SOURCE_FILE = 'StormEvents_details-ftp_v1.0_d2024_c20260728.csv.gz';

const helene: StormEvent = {
  eventId: '1209832',
  episodeId: '195637',
  eventType: 'Hurricane (Typhoon)',
  state: 'FLORIDA',
  countyOrZone: 'INLAND TAYLOR',
  countyOrZoneType: 'Z',
  beginDateTime: '26-SEP-24 16:00:00',
  endDateTime: '27-SEP-24 04:00:00',
  timezone: 'EST-5',
  injuriesDirect: 4,
  injuriesIndirect: 1,
  deathsDirect: 2,
  deathsIndirect: 3,
  damageProperty: { raw: '1.00B', amountInUsd: 1_000_000_000 },
  damageCrops: { raw: '75.00M', amountInUsd: 75_000_000 },
  beginLatitude: 29.9,
  beginLongitude: -83.5,
  source: 'Official NWS Observations',
  episodeNarrative: 'Helene made landfall as a Category 4 hurricane.',
  eventNarrative: 'Numerous trees and power lines were blown down.',
};

const tornado: StormEvent = {
  eventId: '1182258',
  eventType: 'Tornado',
  state: 'TEXAS',
  beginDateTime: '25-MAY-24 16:42:00',
  magnitude: 55,
  magnitudeType: 'MG',
  torFScale: 'EF2',
  torLengthInMiles: 2.46,
  torWidthInYards: 70,
  floodCause: 'Heavy Rain',
  damageProperty: { raw: '0.00K', amountInUsd: 0 },
  damageCrops: { raw: 'K' },
};

/** A row with no damage reported and no optional detail at all. */
const sparse: StormEvent = {
  eventId: '1174463',
  eventType: 'Thunderstorm Wind',
  state: 'OKLAHOMA',
  beginDateTime: '30-APR-24 20:33:00',
};

function searchResult(overrides: Partial<StormEventsSearchResult> = {}): StormEventsSearchResult {
  return {
    events: [helene, tornado, sparse],
    totalCount: 3,
    scannedRowCount: 69_801,
    sourceFile: SOURCE_FILE,
    excludedUnknownDamage: 0,
    eventTypesInYear: ['Flash Flood', 'Flood', 'Hail', 'Hurricane (Typhoon)', 'Tornado'],
    statesInYear: ['FLORIDA', 'OKLAHOMA', 'TEXAS'],
    ...overrides,
  };
}

/** The stubbed `search` spy for the current test — replaced by every `mockSearch` call. */
let search: ReturnType<typeof vi.fn>;

function mockSearch(result: StormEventsSearchResult) {
  search = vi.fn().mockResolvedValue(result);
  vi.mocked(getStormEventsService).mockReturnValue({ search } as unknown as ReturnType<
    typeof getStormEventsService
  >);
}

beforeEach(() => {
  mockSearch(searchResult());
});

/** Parse an input, run the handler on a fresh mock context, and hand back both. */
async function run(input: unknown) {
  const ctx = createMockContext({ errors: noaaClimateSearchStormEvents.errors });
  const result = await noaaClimateSearchStormEvents.handler(
    noaaClimateSearchStormEvents.input.parse(input),
    ctx,
  );
  return { ctx, result };
}

describe('noaaClimateSearchStormEvents — input contract', () => {
  it('rejects a call that omits year rather than fetching every year', () => {
    expect(noaaClimateSearchStormEvents.input.safeParse({}).success).toBe(false);
  });

  it('rejects a year before the corpus begins', () => {
    expect(noaaClimateSearchStormEvents.input.safeParse({ year: 1949 }).success).toBe(false);
  });

  it('accepts the first published year', () => {
    expect(noaaClimateSearchStormEvents.input.safeParse({ year: 1950 }).success).toBe(true);
  });

  it('rejects a non-integer year', () => {
    expect(noaaClimateSearchStormEvents.input.safeParse({ year: 2024.5 }).success).toBe(false);
  });

  it('rejects a blank or whitespace-only state', () => {
    expect(noaaClimateSearchStormEvents.input.safeParse({ year: 2024, state: '' }).success).toBe(
      false,
    );
    expect(noaaClimateSearchStormEvents.input.safeParse({ year: 2024, state: '   ' }).success).toBe(
      false,
    );
  });

  it('rejects a blank or whitespace-only eventType', () => {
    expect(
      noaaClimateSearchStormEvents.input.safeParse({ year: 2024, eventType: '' }).success,
    ).toBe(false);
    expect(
      noaaClimateSearchStormEvents.input.safeParse({ year: 2024, eventType: '  ' }).success,
    ).toBe(false);
  });

  it('rejects a month outside 1–12', () => {
    expect(noaaClimateSearchStormEvents.input.safeParse({ year: 2024, month: 0 }).success).toBe(
      false,
    );
    expect(noaaClimateSearchStormEvents.input.safeParse({ year: 2024, month: 13 }).success).toBe(
      false,
    );
  });

  it('rejects a negative minDamageInUsd', () => {
    expect(
      noaaClimateSearchStormEvents.input.safeParse({ year: 2024, minDamageInUsd: -1 }).success,
    ).toBe(false);
  });

  it('rejects a limit above the page cap and a negative offset', () => {
    expect(noaaClimateSearchStormEvents.input.safeParse({ year: 2024, limit: 101 }).success).toBe(
      false,
    );
    expect(noaaClimateSearchStormEvents.input.safeParse({ year: 2024, offset: -1 }).success).toBe(
      false,
    );
  });

  it('defaults limit to 50 and offset to 0', () => {
    const parsed = noaaClimateSearchStormEvents.input.parse({ year: 2024 });
    expect(parsed.limit).toBe(50);
    expect(parsed.offset).toBe(0);
  });

  it('forwards only the filters the caller supplied', async () => {
    await run({ year: 2024, state: 'TEXAS' });

    expect(search).toHaveBeenCalledWith(
      { year: 2024, state: 'TEXAS', limit: 50, offset: 0 },
      expect.anything(),
    );
  });

  it('forwards every filter when all are supplied', async () => {
    await run({
      year: 2024,
      state: 'TEXAS',
      eventType: 'Tornado',
      month: 5,
      minDamageInUsd: 1000,
      limit: 10,
      offset: 20,
    });

    expect(search).toHaveBeenCalledWith(
      {
        year: 2024,
        state: 'TEXAS',
        eventType: 'Tornado',
        month: 5,
        minDamageInUsd: 1000,
        limit: 10,
        offset: 20,
      },
      expect.anything(),
    );
  });
});

describe('noaaClimateSearchStormEvents — structuredContent', () => {
  it('returns the year, the exact source file, and the matching events', async () => {
    const { result } = await run({ year: 2024 });

    expect(result.year).toBe(2024);
    expect(result.sourceFile).toBe(SOURCE_FILE);
    expect(result.events).toHaveLength(3);
  });

  it('carries a B-suffixed damage figure as both the raw cell and a billion-dollar amount', async () => {
    const { result } = await run({ year: 2024 });

    expect(result.events[0]?.damageProperty).toEqual({
      raw: '1.00B',
      amountInUsd: 1_000_000_000,
    });
  });

  it('omits damage entirely for an unreported row, so it cannot read as zero', async () => {
    const { result } = await run({ year: 2024 });
    const unreported = result.events.find((e) => e.eventId === '1174463');
    const confirmedZero = result.events.find((e) => e.eventId === '1182258');

    expect(unreported?.damageProperty).toBeUndefined();
    expect(confirmedZero?.damageProperty?.amountInUsd).toBe(0);
  });

  it('validates against the declared output schema', async () => {
    const { result } = await run({ year: 2024 });

    expect(noaaClimateSearchStormEvents.output.safeParse(result).success).toBe(true);
  });
});

describe('noaaClimateSearchStormEvents — enrichment', () => {
  it('reports the true match total and the rows scanned', async () => {
    const { ctx } = await run({ year: 2024 });

    expect(getEnrichment(ctx)).toMatchObject({ totalCount: 3, scannedRowCount: 69_801 });
  });

  it('discloses truncation when matches run past the page', async () => {
    mockSearch(searchResult({ totalCount: 149 }));
    const { ctx } = await run({ year: 2024, limit: 3 });

    const enrichment = getEnrichment(ctx);
    expect(enrichment).toMatchObject({ truncated: true, shown: 3, cap: 3, totalCount: 149 });
    expect(enrichment.notice as string).toContain('149');
  });

  it('does not claim truncation when the page holds every match', async () => {
    const { ctx } = await run({ year: 2024 });

    const enrichment = getEnrichment(ctx);
    expect(enrichment.truncated).toBeUndefined();
    expect(enrichment.notice).toBeUndefined();
  });

  it('names the page window when disclosing truncation past the first page', async () => {
    mockSearch(searchResult({ totalCount: 149 }));
    const { ctx } = await run({ year: 2024, limit: 3, offset: 40 });

    expect(getEnrichment(ctx).notice as string).toContain('41–43');
  });

  it('flags an exhausted page instead of reporting a genuine no-match', async () => {
    mockSearch(searchResult({ events: [], totalCount: 149 }));
    const { ctx } = await run({ year: 2024, offset: 500 });

    const enrichment = getEnrichment(ctx);
    expect(enrichment.exhausted).toBe(true);
    expect(enrichment.totalCount).toBe(149);
    expect(enrichment.notice as string).toContain('past the end');
  });

  it('reports how many rows a min-damage filter dropped for unreported damage', async () => {
    mockSearch(searchResult({ excludedUnknownDamage: 15_046 }));
    const { ctx } = await run({ year: 2024, minDamageInUsd: 1000 });

    expect(getEnrichment(ctx).excludedUnknownDamage).toBe(15_046);
  });

  it('omits the exclusion count when min damage was not requested', async () => {
    const { ctx } = await run({ year: 2024 });

    expect(getEnrichment(ctx).excludedUnknownDamage).toBeUndefined();
  });
});

describe('noaaClimateSearchStormEvents — empty-result guidance', () => {
  it('echoes the applied filters', async () => {
    mockSearch(searchResult({ events: [], totalCount: 0 }));
    const { ctx } = await run({ year: 2024, state: 'WYOMING', month: 3 });

    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toContain('state="WYOMING"');
    expect(notice).toContain('month=3');
  });

  it('explains the postal-code trap when a two-letter state matched nothing', async () => {
    mockSearch(searchResult({ events: [], totalCount: 0 }));
    const { ctx } = await run({ year: 2024, state: 'FL' });

    expect(getEnrichment(ctx).notice as string).toContain('FLORIDA');
  });

  it('lists the year’s event types when the caller’s text resembles none of them', async () => {
    mockSearch(searchResult({ events: [], totalCount: 0 }));
    const { ctx } = await run({ year: 2024, eventType: 'derecho' });

    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toContain('event types');
    expect(notice).toContain('Flash Flood');
  });

  it('offers near matches when the event type contains a label the year carries', async () => {
    mockSearch(searchResult({ events: [], totalCount: 0 }));
    const { ctx } = await run({ year: 2024, eventType: 'flash flooding' });

    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toContain('did you mean');
    expect(notice).toContain('Flash Flood');
  });

  it('resolves a plural the year does not carry to the label it does', async () => {
    mockSearch(searchResult({ events: [], totalCount: 0 }));
    const { ctx } = await run({ year: 2024, eventType: 'tornados' });

    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toContain('did you mean');
    expect(notice).toContain('Tornado');
  });

  it('does not suggest a value back to the caller when the year already carries it', async () => {
    mockSearch(searchResult({ events: [], totalCount: 0 }));
    const { ctx } = await run({
      year: 2024,
      state: 'FLORIDA',
      eventType: 'Tornado',
      minDamageInUsd: 999_999_999_999,
    });

    const notice = getEnrichment(ctx).notice as string;
    expect(notice).not.toMatch(/did you mean/i);
    expect(notice).toContain('occur in 2024');
    expect(notice).toContain('minDamageInUsd=999999999999');
  });

  it('leads with the filter that emptied the result, not with the excluded-row footnote', async () => {
    mockSearch(searchResult({ events: [], totalCount: 0, excludedUnknownDamage: 42 }));
    const { ctx } = await run({
      year: 2024,
      state: 'FLORIDA',
      eventType: 'Tornado',
      minDamageInUsd: 999_999_999_999,
    });

    const notice = getEnrichment(ctx).notice as string;
    expect(notice.indexOf('relax it first')).toBeGreaterThan(-1);
    expect(notice.indexOf('relax it first')).toBeLessThan(notice.indexOf('42 rows'));
  });

  it('still names an absent state before the threshold, since that is the cause', async () => {
    mockSearch(searchResult({ events: [], totalCount: 0 }));
    const { ctx } = await run({ year: 2024, state: 'FL', minDamageInUsd: 1_000 });

    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toContain('FLORIDA');
    expect(notice).not.toContain('relax it first');
  });

  it('points at the excluded unreported-damage rows when min damage emptied the result', async () => {
    mockSearch(searchResult({ events: [], totalCount: 0, excludedUnknownDamage: 42 }));
    const { ctx } = await run({ year: 2024, minDamageInUsd: 5_000_000 });

    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toContain('42 rows');
    expect(notice).toContain('no property-damage figure');
  });
});

describe('noaaClimateSearchStormEvents — an H-magnitude damage figure', () => {
  const hundreds: StormEvent = {
    eventId: '10123456',
    eventType: 'Thunderstorm Wind',
    state: 'WYOMING',
    beginDateTime: '12-JUL-95 16:30:00',
    damageProperty: { raw: '5H', amountInUsd: 500 },
  };

  it('carries hundreds through structuredContent', async () => {
    mockSearch(searchResult({ events: [hundreds], totalCount: 1 }));
    const { result } = await run({ year: 1995 });

    expect(result.events[0]?.damageProperty).toEqual({ raw: '5H', amountInUsd: 500 });
    expect(noaaClimateSearchStormEvents.output.safeParse(result).success).toBe(true);
  });

  it('renders hundreds as dollars in content[], not as an unparseable cell', () => {
    const text = firstText(
      noaaClimateSearchStormEvents.format!({
        year: 1995,
        sourceFile: 'StormEvents_details-ftp_v1.0_d1995_c20260323.csv.gz',
        events: [hundreds],
      }),
    );

    expect(text).toContain('**Property damage:** 500 USD (reported as "5H")');
    expect(text).not.toContain('unparseable');
  });
});

describe('noaaClimateSearchStormEvents — format()', () => {
  const rendered = (events: StormEvent[] = [helene, tornado, sparse]) =>
    firstText(
      noaaClimateSearchStormEvents.format!({ year: 2024, sourceFile: SOURCE_FILE, events }),
    );

  it('names the year and the exact source file', () => {
    const text = rendered();
    expect(text).toContain('2024');
    expect(text).toContain(SOURCE_FILE);
  });

  it('renders identity, place, and timing for each event', () => {
    const text = rendered();
    expect(text).toContain('Hurricane (Typhoon) — FLORIDA');
    expect(text).toContain('1209832');
    expect(text).toContain('195637');
    expect(text).toContain('INLAND TAYLOR');
    expect(text).toContain('area type Z');
    expect(text).toContain('26-SEP-24 16:00:00');
    expect(text).toContain('27-SEP-24 04:00:00');
    expect(text).toContain('EST-5');
  });

  it('renders casualties split into direct and indirect', () => {
    const text = rendered();
    expect(text).toContain('**Deaths:** 2 direct, 3 indirect');
    expect(text).toContain('**Injuries:** 4 direct, 1 indirect');
  });

  it('renders a billion-dollar figure as dollars alongside the raw cell', () => {
    const text = rendered();
    expect(text).toContain('1000000000 USD (reported as "1.00B")');
    expect(text).toContain('75000000 USD (reported as "75.00M")');
  });

  it('renders an unreported figure as "Not reported", never as zero', () => {
    const text = rendered([sparse]);
    expect(text).toContain('**Property damage:** Not reported');
    expect(text).toContain('**Crop damage:** Not reported');
    expect(text).not.toContain('0 USD');
  });

  it('renders a confirmed zero as an actual zero, distinct from "Not reported"', () => {
    const text = rendered([tornado]);
    expect(text).toContain('**Property damage:** 0 USD (reported as "0.00K")');
  });

  it('surfaces a malformed cell as unparseable rather than dropping or zeroing it', () => {
    const text = rendered();
    expect(text).toContain('unparseable upstream value "K"');
  });

  it('renders magnitude, tornado geometry, flood cause, coordinates, and reporter', () => {
    const text = rendered();
    expect(text).toContain('**Magnitude:** 55');
    expect(text).toContain('**Magnitude type:** MG');
    expect(text).toContain('EF2');
    expect(text).toContain('2.46 mi long');
    expect(text).toContain('70 yd wide');
    expect(text).toContain('**Flood cause:** Heavy Rain');
    expect(text).toContain('29.9, -83.5');
    expect(text).toContain('Official NWS Observations');
  });

  it('renders both narratives', () => {
    const text = rendered();
    expect(text).toContain('Helene made landfall as a Category 4 hurricane.');
    expect(text).toContain('Numerous trees and power lines were blown down.');
  });

  it('renders casualties as "not reported" when NCEI left them blank', () => {
    const text = rendered([sparse]);
    expect(text).toContain('**Deaths:** not reported direct, not reported indirect');
  });

  it('uses the server’s empty-page convention when nothing is on the page', () => {
    const text = rendered([]);
    expect(text).toContain('_No records on this page._');
  });
});

describe('noaaClimateSearchStormEvents — error contract', () => {
  it('declares a recovery path for an unpublished year', () => {
    const entry = noaaClimateSearchStormEvents.errors?.find((e) => e.reason === 'year_unavailable');
    expect(entry?.recovery).toBeTruthy();
  });

  it('declares the upstream outage as retryable', () => {
    const entry = noaaClimateSearchStormEvents.errors?.find(
      (e) => e.reason === 'service_unavailable',
    );
    expect(entry?.retryable).toBe(true);
  });

  it('declares every reason the service can emit, and no reason it cannot', () => {
    const declared = noaaClimateSearchStormEvents.errors?.map((e) => e.reason).sort();

    expect(declared).toEqual(['malformed_export', 'service_unavailable', 'year_unavailable']);
  });

  it('bubbles a service throw without rewriting it', async () => {
    search.mockRejectedValue(
      Object.assign(new Error('The NCEI Storm Events directory has no details file for 2099.'), {
        data: { reason: 'year_unavailable' },
      }),
    );

    await expect(run({ year: 2099 })).rejects.toThrow(/no details file for 2099/);
  });

  it.each([
    ['year_unavailable', JsonRpcErrorCode.NotFound],
    ['service_unavailable', JsonRpcErrorCode.ServiceUnavailable],
    ['malformed_export', JsonRpcErrorCode.SerializationError],
  ] as const)('puts the declared %s hint on the wire for a service throw', async (reason, code) => {
    // The service throws `{ reason }` alone; the hint the caller reads comes
    // from this tool's declared contract.
    search.mockRejectedValue(new McpError(code, `NCEI failure (${reason}).`, { reason }));
    const declared = noaaClimateSearchStormEvents.errors?.find((e) => e.reason === reason);

    const failure = await contractFailure(noaaClimateSearchStormEvents, { year: 2024 });

    expect(failure.code).toBe(code);
    expect(failure.data.reason).toBe(reason);
    expect(failure.data.recovery?.hint).toBe(declared?.recovery);
  });
});
