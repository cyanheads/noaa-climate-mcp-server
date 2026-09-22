/**
 * @fileoverview Tests for StormEventsService — directory-listing filename
 * discovery, explicit gzip decompression, streaming CSV filtering, per-year
 * caching, and the error paths. The CSV fixture carries the real value shapes
 * from the live export: magnitude-suffixed damage including `B`, empty damage
 * cells, a confirmed `0.00K`, a malformed cell, and quoted narratives.
 * @module tests/services/storm-events-service.test
 */

import { gzipSync } from 'node:zlib';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Execute the retried body once, without backoff delays.
vi.mock('@cyanheads/mcp-ts-core/utils', async (importOriginal) => {
  const original = await importOriginal<typeof import('@cyanheads/mcp-ts-core/utils')>();
  return { ...original, withRetry: vi.fn(async (fn: () => Promise<unknown>) => fn()) };
});

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { noaaClimateSearchStormEvents } from '@/mcp-server/tools/definitions/noaa-climate-search-storm-events.tool.js';
import { StormEventsService } from '@/services/storm-events/storm-events-service.js';

const BASE = 'https://mock-ncei.test/csvfiles/';

/**
 * The recovery text the tool's error contract declares for a reason. The
 * service resolves the same entry through `ctx.recoveryFor`, so asserting
 * against this proves the hint is derived rather than written a second time.
 */
function declaredRecovery(reason: string): string {
  const entry = noaaClimateSearchStormEvents.errors?.find((e) => e.reason === reason);
  if (!entry) throw new Error(`The tool declares no error contract entry for ${reason}.`);
  return entry.recovery;
}

/** A context carrying the tool's contract, so service throws can resolve recovery hints. */
const contractContext = () => createMockContext({ errors: noaaClimateSearchStormEvents.errors });

/** Await a call that must reject, and hand back the error it threw. */
async function rejection(promise: Promise<unknown>): Promise<McpError> {
  try {
    await promise;
  } catch (error) {
    return error as McpError;
  }
  throw new Error('Expected the call to reject, but it resolved.');
}

/**
 * An Apache-style index. 2024 appears twice with different publish dates — the
 * live directory keeps a superseded entry after a republish — and the entries
 * are repeated in href and link text exactly as the real index renders them.
 */
const LISTING_HTML = `
<html><body><pre>
<a href="StormEvents_details-ftp_v1.0_d1950_c20260323.csv.gz">StormEvents_details-ftp_v1.0_d1950_c20260323.csv.gz</a>
<a href="StormEvents_details-ftp_v1.0_d2023_c20260323.csv.gz">StormEvents_details-ftp_v1.0_d2023_c20260323.csv.gz</a>
<a href="StormEvents_details-ftp_v1.0_d2024_c20260323.csv.gz">StormEvents_details-ftp_v1.0_d2024_c20260323.csv.gz</a>
<a href="StormEvents_details-ftp_v1.0_d2024_c20260728.csv.gz">StormEvents_details-ftp_v1.0_d2024_c20260728.csv.gz</a>
<a href="StormEvents_details-ftp_v1.0_d2025_c20260728.csv.gz">StormEvents_details-ftp_v1.0_d2025_c20260728.csv.gz</a>
<a href="StormEvents_fatalities-ftp_v1.0_d2024_c20260728.csv.gz">StormEvents_fatalities-ftp_v1.0_d2024_c20260728.csv.gz</a>
<a href="StormEvents_locations-ftp_v1.0_d2024_c20260728.csv.gz">StormEvents_locations-ftp_v1.0_d2024_c20260728.csv.gz</a>
</pre></body></html>`;

const HEADER =
  'BEGIN_YEARMONTH,EPISODE_ID,EVENT_ID,STATE,EVENT_TYPE,CZ_TYPE,CZ_NAME,BEGIN_DATE_TIME,CZ_TIMEZONE,END_DATE_TIME,' +
  'INJURIES_DIRECT,INJURIES_INDIRECT,DEATHS_DIRECT,DEATHS_INDIRECT,DAMAGE_PROPERTY,DAMAGE_CROPS,SOURCE,MAGNITUDE,' +
  'MAGNITUDE_TYPE,FLOOD_CAUSE,TOR_F_SCALE,TOR_LENGTH,TOR_WIDTH,BEGIN_LAT,BEGIN_LON,EPISODE_NARRATIVE,EVENT_NARRATIVE';

const ROWS = [
  // Billion-dollar hurricane row, quoted narrative with a comma and a doubled quote.
  '202409,195637,1209832,"FLORIDA","Hurricane (Typhoon)","Z","INLAND TAYLOR","26-SEP-24 16:00:00","EST-5","27-SEP-24 04:00:00",' +
    '"0","0","2","1","1.00B","75.00M","Official NWS Observations",,,,,,,29.9,-83.5,' +
    '"Helene made landfall as a Category 4, then weakened.","A gust ""over 100 mph"" was measured."',
  // Damage not reported at all — both cells empty.
  '202404,189851,1174463,"OKLAHOMA","Thunderstorm Wind","C","TILLMAN","30-APR-24 20:33:00","CST-6","30-APR-24 20:33:00",' +
    '"0","0","0","0",,,"ASOS","55.00","MG",,,,,34.3444,-98.983,"Widely scattered storms.","Airport observation."',
  // Confirmed zero damage.
  '202407,193486,1195301,"LOUISIANA","Excessive Heat","Z","NATCHITOCHES","01-JUL-24 00:00:00","CST-6","05-JUL-24 09:00:00",' +
    '"0","0","0","0","0.00K","0.00K","ASOS",,,,,,,,,"An upper ridge built in.",""',
  // Tornado with F-scale, length, and width; mid-range damage.
  '202405,190993,1182258,"TEXAS","Tornado","C","EASTLAND","25-MAY-24 16:42:00","CST-6","25-MAY-24 16:48:00",' +
    '"3","0","0","0","100.00K","0.00K","Trained Spotter",,,,"EF2","2.46","70",32.3,-98.8,"Supercells.","Barn destroyed."',
  // Malformed damage cell — a suffix with no number, as the 2000 file writes.
  '202406,191111,1190000,"ILLINOIS","Thunderstorm Wind","C","COOK","10-JUN-24 14:00:00","CST-6","10-JUN-24 14:05:00",' +
    '"0","0","0","0","K","","Public",,,,,,,41.8,-87.6,"Line of storms.","Tree down."',
  // Abbreviated fractional damage, as older years write it.
  '202408,192222,1191000,"TEXAS","Flash Flood","C","HARRIS","02-AUG-24 03:00:00","CST-6","02-AUG-24 06:00:00",' +
    '"0","0","0","0",".5M","0.00K","Emergency Manager",,,"Heavy Rain",,,,29.7,-95.3,"Training storms.","Roads closed."',
  // Second Texas tornado, a different month, so month filtering has something to separate.
  '202411,197838,1223377,"TEXAS","Tornado","C","DENTON","16-NOV-24 02:30:00","CST-6","16-NOV-24 02:41:00",' +
    '"0","0","0","0","25.00K","0.00K","Broadcast Media",,,,"EF0","0.5","50",33.2,-97.1,"Cold front.","Fence damage."',
];

const CSV_1950 =
  `${HEADER}\r\n` +
  '195004,,10096222,"OKLAHOMA","Tornado","C","WASHITA","28-APR-50 14:45:00","CST","28-APR-50 14:45:00",' +
  '"0","0","0","0","250K","0.00K","",,,,"F3","3.4","400",35.2,-99.0,"",""\r\n';

const CSV_2024 = `${HEADER}\r\n${ROWS.join('\r\n')}\r\n`;

const gzipOf = (csv: string) => new Uint8Array(gzipSync(Buffer.from(csv, 'utf8')));

/**
 * Serve the gzip bundle the way NCEI does: `Content-Type: application/gzip` and
 * no `Content-Encoding`, so nothing decompresses it on the way in.
 */
const gzipResponse = (csv: string): Response =>
  new Response(gzipOf(csv), {
    status: 200,
    headers: { 'Content-Type': 'application/gzip' },
  });

const listingResponse = (html = LISTING_HTML): Response =>
  new Response(html, { status: 200, headers: { 'Content-Type': 'text/html' } });

/** Route each mocked request by URL so call ordering never matters. */
function routeFetch(overrides: Record<string, () => Response> = {}) {
  vi.mocked(fetch).mockImplementation((input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    const override = overrides[url];
    if (override) return Promise.resolve(override());
    if (url === BASE) return Promise.resolve(listingResponse());
    if (url.includes('_d1950_')) return Promise.resolve(gzipResponse(CSV_1950));
    if (url.includes('_d2024_')) return Promise.resolve(gzipResponse(CSV_2024));
    if (url.includes('_d2023_') || url.includes('_d2025_')) {
      return Promise.resolve(gzipResponse(CSV_2024));
    }
    return Promise.resolve(new Response('not found', { status: 404 }));
  });
}

const baseQuery = { limit: 50, offset: 0 };

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
  routeFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('StormEventsService — filename discovery', () => {
  it('resolves the year filename from the live directory listing', async () => {
    const service = new StormEventsService(BASE);
    await expect(service.resolveDetailsFile(1950, createMockContext())).resolves.toBe(
      'StormEvents_details-ftp_v1.0_d1950_c20260323.csv.gz',
    );
  });

  it('picks the most recent publish date when a year was republished', async () => {
    const service = new StormEventsService(BASE);
    await expect(service.resolveDetailsFile(2024, createMockContext())).resolves.toBe(
      'StormEvents_details-ftp_v1.0_d2024_c20260728.csv.gz',
    );
  });

  it('ignores the fatalities and locations tables when resolving a details file', async () => {
    const service = new StormEventsService(BASE);
    const file = await service.resolveDetailsFile(2024, createMockContext());
    expect(file).toContain('details-ftp');
    expect(file).not.toContain('fatalities');
    expect(file).not.toContain('locations');
  });

  it('requests the file the listing named, not a constructed filename', async () => {
    const service = new StormEventsService(BASE);
    await service.search({ ...baseQuery, year: 2024 }, createMockContext());
    const requested = vi.mocked(fetch).mock.calls.map(([url]) => String(url));
    expect(requested).toContain(`${BASE}StormEvents_details-ftp_v1.0_d2024_c20260728.csv.gz`);
    expect(requested).not.toContain(`${BASE}StormEvents_details-ftp_v1.0_d2024.csv.gz`);
  });

  it('throws a year_unavailable error naming the published range for an unlisted year', async () => {
    const service = new StormEventsService(BASE);
    await expect(service.resolveDetailsFile(2099, createMockContext())).rejects.toMatchObject({
      data: { reason: 'year_unavailable', year: 2099 },
    });
    await expect(service.resolveDetailsFile(2099, createMockContext())).rejects.toThrow(
      /1950–2025/,
    );
  });

  it('reports an index carrying no details files as the declared service_unavailable reason', async () => {
    routeFetch({ [BASE]: () => listingResponse('<html><body>nothing here</body></html>') });
    const service = new StormEventsService(BASE);
    const error = await rejection(service.search({ ...baseQuery, year: 2024 }, contractContext()));

    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.data).toMatchObject({ reason: 'service_unavailable' });
    expect(error.data?.recovery).toEqual({ hint: declaredRecovery('service_unavailable') });
  });

  it('carries the declared recovery hint for an unpublished year rather than a second copy of it', async () => {
    const service = new StormEventsService(BASE);
    const error = await rejection(service.resolveDetailsFile(2099, contractContext()));

    expect(error.data?.recovery).toEqual({ hint: declaredRecovery('year_unavailable') });
    // The live range stays in the message, which the declared hint points at.
    expect(error.message).toContain('1950–2025');
  });
});

describe('StormEventsService — parsing the gzip bundle', () => {
  it('decompresses the response body explicitly and parses every row', async () => {
    const service = new StormEventsService(BASE);
    const result = await service.search({ ...baseQuery, year: 2024 }, createMockContext());

    expect(result.scannedRowCount).toBe(ROWS.length);
    expect(result.totalCount).toBe(ROWS.length);
    expect(result.events).toHaveLength(ROWS.length);
    expect(result.sourceFile).toBe('StormEvents_details-ftp_v1.0_d2024_c20260728.csv.gz');
  });

  it('reads quoted narratives with embedded commas and doubled quotes', async () => {
    const service = new StormEventsService(BASE);
    const result = await service.search({ ...baseQuery, year: 2024 }, createMockContext());
    const helene = result.events.find((e) => e.eventId === '1209832');

    expect(helene?.episodeNarrative).toBe('Helene made landfall as a Category 4, then weakened.');
    expect(helene?.eventNarrative).toBe('A gust "over 100 mph" was measured.');
  });

  it('projects casualties, coordinates, and tornado fields', async () => {
    const service = new StormEventsService(BASE);
    const result = await service.search(
      { ...baseQuery, year: 2024, eventType: 'Tornado', month: 5 },
      createMockContext(),
    );
    const tornado = result.events[0];

    expect(tornado).toMatchObject({
      eventId: '1182258',
      state: 'TEXAS',
      countyOrZone: 'EASTLAND',
      countyOrZoneType: 'C',
      timezone: 'CST-6',
      torFScale: 'EF2',
      torLengthInMiles: 2.46,
      torWidthInYards: 70,
      injuriesDirect: 3,
      beginLatitude: 32.3,
      beginLongitude: -98.8,
    });
  });

  it('omits fields NCEI left blank instead of inventing values', async () => {
    const service = new StormEventsService(BASE);
    const result = await service.search(
      { ...baseQuery, year: 2024, eventType: 'Excessive Heat' },
      createMockContext(),
    );
    const heat = result.events[0];

    expect(heat?.magnitude).toBeUndefined();
    expect(heat?.torFScale).toBeUndefined();
    expect(heat?.floodCause).toBeUndefined();
    expect(heat?.eventNarrative).toBeUndefined();
  });

  it('omits episodeId for pre-1996 rows, which carry no episode', async () => {
    const service = new StormEventsService(BASE);
    const result = await service.search({ ...baseQuery, year: 1950 }, createMockContext());

    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.episodeId).toBeUndefined();
    expect(result.events[0]?.torFScale).toBe('F3');
  });

  it('throws a malformed_export error when required columns are missing', async () => {
    routeFetch({
      [`${BASE}StormEvents_details-ftp_v1.0_d2024_c20260728.csv.gz`]: () =>
        gzipResponse('COL_A,COL_B\r\n1,2\r\n'),
    });
    const service = new StormEventsService(BASE);
    await expect(service.search({ ...baseQuery, year: 2024 }, createMockContext())).rejects.toThrow(
      /missing expected columns/,
    );
    await expect(
      service.search({ ...baseQuery, year: 2024 }, createMockContext()),
    ).rejects.toMatchObject({ data: { reason: 'malformed_export' } });
  });

  it('throws when the file carries no rows at all', async () => {
    routeFetch({
      [`${BASE}StormEvents_details-ftp_v1.0_d2024_c20260728.csv.gz`]: () => gzipResponse(''),
    });
    const service = new StormEventsService(BASE);
    await expect(service.search({ ...baseQuery, year: 2024 }, createMockContext())).rejects.toThrow(
      /contained no rows/,
    );
    await expect(
      service.search({ ...baseQuery, year: 2024 }, createMockContext()),
    ).rejects.toMatchObject({ data: { reason: 'malformed_export' } });
  });

  it.each([
    ['required columns are missing', 'COL_A,COL_B\r\n1,2\r\n'],
    ['the file carries no rows', ''],
  ])('carries the declared malformed_export recovery hint when %s', async (_case, body) => {
    routeFetch({
      [`${BASE}StormEvents_details-ftp_v1.0_d2024_c20260728.csv.gz`]: () => gzipResponse(body),
    });
    const service = new StormEventsService(BASE);
    const error = await rejection(service.search({ ...baseQuery, year: 2024 }, contractContext()));

    expect(error.data).toMatchObject({ reason: 'malformed_export' });
    expect(error.data?.recovery).toEqual({ hint: declaredRecovery('malformed_export') });
  });
});

describe('StormEventsService — damage values', () => {
  it('parses a B-suffixed value to billions and keeps the raw cell', async () => {
    const service = new StormEventsService(BASE);
    const result = await service.search(
      { ...baseQuery, year: 2024, eventType: 'Hurricane (Typhoon)' },
      createMockContext(),
    );

    expect(result.events[0]?.damageProperty).toEqual({ raw: '1.00B', amountInUsd: 1_000_000_000 });
    expect(result.events[0]?.damageCrops).toEqual({ raw: '75.00M', amountInUsd: 75_000_000 });
  });

  it('omits an unreported damage figure rather than reporting zero', async () => {
    const service = new StormEventsService(BASE);
    const result = await service.search(
      { ...baseQuery, year: 2024, eventType: 'Thunderstorm Wind', state: 'OKLAHOMA' },
      createMockContext(),
    );

    expect(result.events[0]?.damageProperty).toBeUndefined();
    expect(result.events[0]?.damageCrops).toBeUndefined();
  });

  it('keeps a confirmed zero distinct from an unreported figure', async () => {
    const service = new StormEventsService(BASE);
    const result = await service.search({ ...baseQuery, year: 2024 }, createMockContext());
    const heat = result.events.find((e) => e.eventType === 'Excessive Heat');
    const unreported = result.events.find((e) => e.eventId === '1174463');

    expect(heat?.damageProperty).toEqual({ raw: '0.00K', amountInUsd: 0 });
    expect(unreported?.damageProperty).toBeUndefined();
  });

  it('preserves a malformed cell as raw text with no amount', async () => {
    const service = new StormEventsService(BASE);
    const result = await service.search(
      { ...baseQuery, year: 2024, state: 'ILLINOIS' },
      createMockContext(),
    );

    expect(result.events[0]?.damageProperty).toEqual({ raw: 'K' });
    expect(result.events[0]?.damageProperty?.amountInUsd).toBeUndefined();
  });
});

describe('StormEventsService — filtering', () => {
  it('filters by state case-insensitively', async () => {
    const service = new StormEventsService(BASE);
    const upper = await service.search(
      { ...baseQuery, year: 2024, state: 'TEXAS' },
      createMockContext(),
    );
    const lower = await service.search(
      { ...baseQuery, year: 2024, state: 'texas' },
      createMockContext(),
    );

    expect(upper.totalCount).toBe(3);
    expect(lower.totalCount).toBe(3);
    expect(upper.events.every((e) => e.state === 'TEXAS')).toBe(true);
  });

  it('matches a postal code against nothing, since STATE holds full names', async () => {
    const service = new StormEventsService(BASE);
    const result = await service.search(
      { ...baseQuery, year: 2024, state: 'TX' },
      createMockContext(),
    );

    expect(result.totalCount).toBe(0);
    expect(result.events).toEqual([]);
  });

  it('filters by event type case-insensitively and exactly', async () => {
    const service = new StormEventsService(BASE);
    const exact = await service.search(
      { ...baseQuery, year: 2024, eventType: 'tornado' },
      createMockContext(),
    );
    const partial = await service.search(
      { ...baseQuery, year: 2024, eventType: 'torn' },
      createMockContext(),
    );

    expect(exact.totalCount).toBe(2);
    expect(partial.totalCount).toBe(0);
  });

  it('filters by the begin month', async () => {
    const service = new StormEventsService(BASE);
    const may = await service.search(
      { ...baseQuery, year: 2024, eventType: 'Tornado', month: 5 },
      createMockContext(),
    );
    const november = await service.search(
      { ...baseQuery, year: 2024, eventType: 'Tornado', month: 11 },
      createMockContext(),
    );

    expect(may.events.map((e) => e.eventId)).toEqual(['1182258']);
    expect(november.events.map((e) => e.eventId)).toEqual(['1223377']);
  });

  it('combines filters', async () => {
    const service = new StormEventsService(BASE);
    const result = await service.search(
      { ...baseQuery, year: 2024, state: 'TEXAS', eventType: 'Tornado', month: 11 },
      createMockContext(),
    );

    expect(result.events.map((e) => e.eventId)).toEqual(['1223377']);
  });

  it('filters min damage on the parsed number, not the raw string', async () => {
    const service = new StormEventsService(BASE);
    const result = await service.search(
      { ...baseQuery, year: 2024, minDamageInUsd: 500_000 },
      createMockContext(),
    );

    expect(result.events.map((e) => e.damageProperty?.raw).sort()).toEqual(['.5M', '1.00B']);
  });

  it('counts a B-suffixed value above a million-dollar threshold', async () => {
    const service = new StormEventsService(BASE);
    const result = await service.search(
      { ...baseQuery, year: 2024, minDamageInUsd: 1_000_000 },
      createMockContext(),
    );

    expect(result.events.map((e) => e.eventId)).toEqual(['1209832']);
  });

  it('excludes unreported and malformed damage from a min-damage query and counts the exclusions', async () => {
    const service = new StormEventsService(BASE);
    const result = await service.search(
      { ...baseQuery, year: 2024, minDamageInUsd: 0 },
      createMockContext(),
    );

    // The empty-damage row and the malformed `K` row are the two dropped.
    expect(result.excludedUnknownDamage).toBe(2);
    expect(result.events.every((e) => e.damageProperty?.amountInUsd !== undefined)).toBe(true);
  });

  it('keeps a confirmed zero when the threshold is zero', async () => {
    const service = new StormEventsService(BASE);
    const result = await service.search(
      { ...baseQuery, year: 2024, minDamageInUsd: 0 },
      createMockContext(),
    );

    expect(result.events.map((e) => e.damageProperty?.raw)).toContain('0.00K');
  });

  it('reports no exclusions when min damage was not requested', async () => {
    const service = new StormEventsService(BASE);
    const result = await service.search({ ...baseQuery, year: 2024 }, createMockContext());

    expect(result.excludedUnknownDamage).toBe(0);
  });

  it('collects the distinct event types and states of the whole file, not just the matches', async () => {
    const service = new StormEventsService(BASE);
    const result = await service.search(
      { ...baseQuery, year: 2024, state: 'TEXAS' },
      createMockContext(),
    );

    expect(result.eventTypesInYear).toEqual([
      'Excessive Heat',
      'Flash Flood',
      'Hurricane (Typhoon)',
      'Thunderstorm Wind',
      'Tornado',
    ]);
    expect(result.statesInYear).toContain('FLORIDA');
    expect(result.statesInYear).toContain('OKLAHOMA');
  });
});

describe('StormEventsService — pagination', () => {
  it('returns the requested page while counting every match', async () => {
    const service = new StormEventsService(BASE);
    const page = await service.search({ year: 2024, limit: 2, offset: 0 }, createMockContext());

    expect(page.events).toHaveLength(2);
    expect(page.totalCount).toBe(ROWS.length);
  });

  it('advances past the first page without repeating rows', async () => {
    const service = new StormEventsService(BASE);
    const first = await service.search({ year: 2024, limit: 3, offset: 0 }, createMockContext());
    const second = await service.search({ year: 2024, limit: 3, offset: 3 }, createMockContext());

    const firstIds = first.events.map((e) => e.eventId);
    const secondIds = second.events.map((e) => e.eventId);
    expect(secondIds).toHaveLength(3);
    expect(firstIds.some((id) => secondIds.includes(id))).toBe(false);
  });

  it('returns an empty page past the end while still reporting the true total', async () => {
    const service = new StormEventsService(BASE);
    const result = await service.search(
      { year: 2024, limit: 10, offset: 500 },
      createMockContext(),
    );

    expect(result.events).toEqual([]);
    expect(result.totalCount).toBe(ROWS.length);
  });

  it('applies offset to filtered matches, not to raw file rows', async () => {
    const service = new StormEventsService(BASE);
    const result = await service.search(
      { year: 2024, eventType: 'Tornado', limit: 5, offset: 1 },
      createMockContext(),
    );

    expect(result.totalCount).toBe(2);
    expect(result.events.map((e) => e.eventId)).toEqual(['1223377']);
  });
});

describe('StormEventsService — caching', () => {
  it('downloads a year once and serves later searches from the cached bytes', async () => {
    const service = new StormEventsService(BASE);
    await service.search({ ...baseQuery, year: 2024 }, createMockContext());
    const afterFirst = vi.mocked(fetch).mock.calls.length;
    await service.search({ ...baseQuery, year: 2024, state: 'TEXAS' }, createMockContext());

    expect(afterFirst).toBe(2); // listing + file
    expect(vi.mocked(fetch).mock.calls.length).toBe(afterFirst);
  });

  it('re-downloads the listing and the year once the cache TTL lapses', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-18T00:00:00Z'));
    const service = new StormEventsService(BASE);
    await service.search({ ...baseQuery, year: 2024 }, createMockContext());

    vi.setSystemTime(new Date('2026-08-18T07:00:00Z'));
    await service.search({ ...baseQuery, year: 2024 }, createMockContext());

    expect(vi.mocked(fetch).mock.calls.length).toBe(4);
  });

  it('evicts the least recently used year once the cache bound is exceeded', async () => {
    const service = new StormEventsService(BASE);
    await service.search({ ...baseQuery, year: 2023 }, createMockContext());
    await service.search({ ...baseQuery, year: 2024 }, createMockContext());
    await service.search({ ...baseQuery, year: 2025 }, createMockContext());
    const beforeRefetch = vi.mocked(fetch).mock.calls.length;

    await service.search({ ...baseQuery, year: 2023 }, createMockContext());

    expect(vi.mocked(fetch).mock.calls.length).toBe(beforeRefetch + 1);
  });

  it('keeps a recently used year resident when a third year is loaded', async () => {
    const service = new StormEventsService(BASE);
    await service.search({ ...baseQuery, year: 2023 }, createMockContext());
    await service.search({ ...baseQuery, year: 2024 }, createMockContext());
    await service.search({ ...baseQuery, year: 2025 }, createMockContext());
    const beforeRefetch = vi.mocked(fetch).mock.calls.length;

    await service.search({ ...baseQuery, year: 2025 }, createMockContext());

    expect(vi.mocked(fetch).mock.calls.length).toBe(beforeRefetch);
  });
});

describe('StormEventsService — an H-magnitude damage cell', () => {
  const H_ROW =
    '199507,,10123456,"WYOMING","Thunderstorm Wind","C","BIG HORN","12-JUL-95 16:30:00","MST-7","12-JUL-95 16:30:00",' +
    '"0","0","0","0","5H","","Public",,,,,,,44.5,-108.0,"Strong thunderstorm winds.","Knocked down a tree and a flagpole."';

  beforeEach(() => {
    routeFetch({
      [`${BASE}StormEvents_details-ftp_v1.0_d2024_c20260728.csv.gz`]: () =>
        gzipResponse(`${HEADER}\r\n${H_ROW}\r\n`),
    });
  });

  it('parses hundreds through the full scan, not just in isolation', async () => {
    const service = new StormEventsService(BASE);
    const result = await service.search({ ...baseQuery, year: 2024 }, createMockContext());

    expect(result.events[0]?.damageProperty).toEqual({ raw: '5H', amountInUsd: 500 });
  });

  it('counts an H-magnitude row toward minDamageInUsd instead of dropping it as unknown', async () => {
    const service = new StormEventsService(BASE);
    const result = await service.search(
      { ...baseQuery, year: 2024, minDamageInUsd: 100 },
      createMockContext(),
    );

    expect(result.totalCount).toBe(1);
    expect(result.excludedUnknownDamage).toBe(0);
  });

  it('still excludes it from a threshold it does not clear', async () => {
    const service = new StormEventsService(BASE);
    const result = await service.search(
      { ...baseQuery, year: 2024, minDamageInUsd: 1_000 },
      createMockContext(),
    );

    expect(result.totalCount).toBe(0);
    expect(result.excludedUnknownDamage).toBe(0);
  });
});

describe('StormEventsService — a body that does not decompress', () => {
  const FILE = `${BASE}StormEvents_details-ftp_v1.0_d2024_c20260728.csv.gz`;

  /** What an upstream error page looks like on the wire: HTML under HTTP 200. */
  const htmlErrorPage = () =>
    new Response('<html><body><h1>503 Service Unavailable</h1></body></html>', {
      status: 200,
      headers: { 'Content-Type': 'application/gzip' },
    });

  /** A transfer cut short — valid gzip bytes that stop before the stream ends. */
  const truncatedGzip = () =>
    new Response(gzipOf(CSV_2024).slice(0, 200), {
      status: 200,
      headers: { 'Content-Type': 'application/gzip' },
    });

  const fileFetches = () =>
    vi.mocked(fetch).mock.calls.filter(([url]) => String(url) === FILE).length;

  it('reports an HTML error page as a typed service_unavailable, not an empty TypeError', async () => {
    routeFetch({ [FILE]: htmlErrorPage });
    const service = new StormEventsService(BASE);
    const error = await rejection(service.search({ ...baseQuery, year: 2024 }, contractContext()));

    expect(error).toBeInstanceOf(McpError);
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.message).not.toBe('');
    expect(error.message).toMatch(/decompress/i);
    expect(error.data).toMatchObject({ reason: 'service_unavailable', year: 2024 });
    expect(error.data?.recovery).toEqual({ hint: declaredRecovery('service_unavailable') });
  });

  it('reports a truncated transfer the same way', async () => {
    routeFetch({ [FILE]: truncatedGzip });
    const service = new StormEventsService(BASE);
    const error = await rejection(service.search({ ...baseQuery, year: 2024 }, contractContext()));

    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.data).toMatchObject({ reason: 'service_unavailable' });
  });

  it('does not replay the corrupt payload once the upstream recovers', async () => {
    let corrupt = true;
    routeFetch({ [FILE]: () => (corrupt ? htmlErrorPage() : gzipResponse(CSV_2024)) });
    const service = new StormEventsService(BASE);

    await expect(
      service.search({ ...baseQuery, year: 2024 }, createMockContext()),
    ).rejects.toThrow();
    const afterFailure = fileFetches();

    corrupt = false;
    const result = await service.search({ ...baseQuery, year: 2024 }, createMockContext());

    expect(result.totalCount).toBe(ROWS.length);
    // The recovered call re-fetched: the bad bytes did not outlive the request.
    expect(fileFetches()).toBe(afterFailure + 1);
  });

  it('keeps the good bytes cached when decompression succeeds', async () => {
    const service = new StormEventsService(BASE);
    await service.search({ ...baseQuery, year: 2024 }, createMockContext());
    const afterFirst = fileFetches();
    await service.search({ ...baseQuery, year: 2024 }, createMockContext());

    expect(fileFetches()).toBe(afterFirst);
  });
});

describe('StormEventsService — a republished year', () => {
  const STALE = 'StormEvents_details-ftp_v1.0_d2024_c20260323.csv.gz';
  const CURRENT = 'StormEvents_details-ftp_v1.0_d2024_c20260728.csv.gz';

  /** An index naming exactly one details file, so the resolved name is unambiguous. */
  const indexNaming = (file: string) =>
    `<html><body><pre><a href="${file}">${file}</a></pre></body></html>`;

  const gone = () => new Response('Not Found', { status: 404 });

  it('re-resolves once when the cached listing names a file NCEI has removed', async () => {
    let indexesServed = 0;
    routeFetch({
      [BASE]: () => {
        indexesServed++;
        return listingResponse(indexNaming(indexesServed === 1 ? STALE : CURRENT));
      },
      [`${BASE}${STALE}`]: gone,
      [`${BASE}${CURRENT}`]: () => gzipResponse(CSV_2024),
    });
    const service = new StormEventsService(BASE);

    const result = await service.search({ ...baseQuery, year: 2024 }, createMockContext());

    expect(result.sourceFile).toBe(CURRENT);
    expect(indexesServed).toBe(2);
  });

  it('fails once, without looping, when the re-resolved file is also gone', async () => {
    routeFetch({
      [BASE]: () => listingResponse(indexNaming(STALE)),
      [`${BASE}${STALE}`]: gone,
    });
    const service = new StormEventsService(BASE);

    const error = await rejection(service.search({ ...baseQuery, year: 2024 }, contractContext()));

    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.data).toMatchObject({ reason: 'service_unavailable', year: 2024 });
    expect(error.data?.recovery).toEqual({ hint: declaredRecovery('service_unavailable') });
    // Listing, file, listing again, file again — and then it stops.
    expect(vi.mocked(fetch).mock.calls.length).toBe(4);
  });

  it('does not report a removed file as the year being unpublished', async () => {
    routeFetch({
      [BASE]: () => listingResponse(indexNaming(STALE)),
      [`${BASE}${STALE}`]: gone,
    });
    const service = new StormEventsService(BASE);

    const error = await rejection(service.search({ ...baseQuery, year: 2024 }, contractContext()));

    expect(error.code).not.toBe(JsonRpcErrorCode.NotFound);
    expect(error.data?.reason).not.toBe('year_unavailable');
    expect(error.message).not.toContain(BASE);
  });

  it('surfaces a 404 on the directory index itself as a retryable service_unavailable', async () => {
    routeFetch({ [BASE]: gone });
    const service = new StormEventsService(BASE);

    const error = await rejection(service.search({ ...baseQuery, year: 2024 }, contractContext()));

    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.data).toMatchObject({ reason: 'service_unavailable' });
    expect(error.data?.recovery).toEqual({ hint: declaredRecovery('service_unavailable') });
    expect(error.message).not.toContain(BASE);
  });
});

describe('StormEventsService — file hygiene', () => {
  it('ignores a stray blank line rather than counting it as an event', async () => {
    routeFetch({
      [`${BASE}StormEvents_details-ftp_v1.0_d2024_c20260728.csv.gz`]: () =>
        gzipResponse(`${HEADER}\r\n\r\n${ROWS[0]}\r\n\r\n`),
    });
    const service = new StormEventsService(BASE);
    const result = await service.search({ ...baseQuery, year: 2024 }, createMockContext());

    expect(result.scannedRowCount).toBe(1);
    expect(result.totalCount).toBe(1);
    expect(result.events[0]?.eventId).toBe('1209832');
  });
});
