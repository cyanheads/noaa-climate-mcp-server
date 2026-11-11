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
import { StormEventsService } from '@/services/storm-events/storm-events-service.js';

const BASE = 'https://mock-ncei.test/csvfiles/';

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

/**
 * The county and location columns sit last so a row written before they were
 * read — the 1950 row, the H-magnitude row — leaves them absent, as an export
 * missing them would. The export itself writes `STATE_FIPS` and `CZ_FIPS` as
 * unquoted, unpadded integers.
 */
const HEADER =
  'BEGIN_YEARMONTH,EPISODE_ID,EVENT_ID,STATE,EVENT_TYPE,CZ_TYPE,CZ_NAME,BEGIN_DATE_TIME,CZ_TIMEZONE,END_DATE_TIME,' +
  'INJURIES_DIRECT,INJURIES_INDIRECT,DEATHS_DIRECT,DEATHS_INDIRECT,DAMAGE_PROPERTY,DAMAGE_CROPS,SOURCE,MAGNITUDE,' +
  'MAGNITUDE_TYPE,FLOOD_CAUSE,TOR_F_SCALE,TOR_LENGTH,TOR_WIDTH,BEGIN_LAT,BEGIN_LON,EPISODE_NARRATIVE,EVENT_NARRATIVE,' +
  'STATE_FIPS,CZ_FIPS,WFO,BEGIN_LOCATION,END_LAT,END_LON';

const ROWS = [
  // Billion-dollar hurricane row, quoted narrative with a comma and a doubled quote. A zone row.
  '202409,195637,1209832,"FLORIDA","Hurricane (Typhoon)","Z","INLAND TAYLOR","26-SEP-24 16:00:00","EST-5","27-SEP-24 04:00:00",' +
    '"0","0","2","1","1.00B","75.00M","Official NWS Observations",,,,,,,29.9,-83.5,' +
    '"Helene made landfall as a Category 4, then weakened.","A gust ""over 100 mph"" was measured.",12,28,"TAE","",,',
  // Damage not reported at all — both cells empty.
  '202404,189851,1174463,"OKLAHOMA","Thunderstorm Wind","C","TILLMAN","30-APR-24 20:33:00","CST-6","30-APR-24 20:33:00",' +
    '"0","0","0","0",,,"ASOS","55.00","MG",,,,,34.3444,-98.983,"Widely scattered storms.","Airport observation.",' +
    '40,141,"OUN","FREDERICK ARPT",34.3444,-98.983',
  // Confirmed zero damage.
  '202407,193486,1195301,"LOUISIANA","Excessive Heat","Z","NATCHITOCHES","01-JUL-24 00:00:00","CST-6","05-JUL-24 09:00:00",' +
    '"0","0","0","0","0.00K","0.00K","ASOS",,,,,,,,,"An upper ridge built in.","",22,18,"SHV","",,',
  // Tornado with F-scale, length, and width; mid-range damage.
  '202405,190993,1182258,"TEXAS","Tornado","C","EASTLAND","25-MAY-24 16:42:00","CST-6","25-MAY-24 16:48:00",' +
    '"3","0","0","0","100.00K","0.00K","Trained Spotter",,,,"EF2","2.46","70",32.3,-98.8,"Supercells.","Barn destroyed.",' +
    '48,133,"FWD","PIONEER",32.1654,-99.0667',
  // Malformed damage cell — a suffix with no number, as the 2000 file writes.
  '202406,191111,1190000,"ILLINOIS","Thunderstorm Wind","C","COOK","10-JUN-24 14:00:00","CST-6","10-JUN-24 14:05:00",' +
    '"0","0","0","0","K","","Public",,,,,,,41.8,-87.6,"Line of storms.","Tree down.",17,31,"LOT","CHICAGO",41.8,-87.6',
  // Abbreviated fractional damage, as older years write it.
  '202408,192222,1191000,"TEXAS","Flash Flood","C","HARRIS","02-AUG-24 03:00:00","CST-6","02-AUG-24 06:00:00",' +
    '"0","0","0","0",".5M","0.00K","Emergency Manager",,,"Heavy Rain",,,,29.7,-95.3,"Training storms.","Roads closed.",' +
    '48,201,"HGX","HOUSTON",29.7,-95.3',
  // Second Texas tornado, a different month, so month filtering has something to separate.
  '202411,197838,1223377,"TEXAS","Tornado","C","DENTON","16-NOV-24 02:30:00","CST-6","16-NOV-24 02:41:00",' +
    '"0","0","0","0","25.00K","0.00K","Broadcast Media",,,,"EF0","0.5","50",33.2,-97.1,"Cold front.","Fence damage.",' +
    '48,121,"FWD","DENTON",33.21,-97.08',
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

/** Complete span fixtures exercise the streaming CSV path rather than a service stub. */
function serveSpans() {
  const header =
    'EVENT_ID,EVENT_TYPE,STATE,EPISODE_ID,BEGIN_DATE_TIME,BEGIN_YEARMONTH,BEGIN_DAY,END_YEARMONTH,END_DAY,DAMAGE_PROPERTY';
  const rows = [
    'before,Flash Flood,NORTH CAROLINA,00123,raw,202409,20,202409,24,1K',
    'inside,Flash Flood,NORTH CAROLINA,00123,raw,202409,25,202409,26,2K',
    'after,Flash Flood,NORTH CAROLINA,00123,raw,202409,29,202410,2,3K',
    'enclosing,Flash Flood,NORTH CAROLINA,00123,raw,202408,1,202410,1,4K',
    'disjoint,Flash Flood,NORTH CAROLINA,00123,raw,202409,30,202410,1,',
    'unknown,Flash Flood,NORTH CAROLINA,00123,raw,202409,25,202409,26,',
    'missing,Flash Flood,NORTH CAROLINA,00123,raw,202409,25,,,',
    'invalid,Flash Flood,NORTH CAROLINA,00123,raw,202409,31,202410,1,',
    'reversed,Flash Flood,NORTH CAROLINA,00123,raw,202409,27,202409,25,',
    'otherState,Flash Flood,TEXAS,00123,raw,202409,25,202409,26,',
    'otherType,Flood,NORTH CAROLINA,00123,raw,202409,25,202409,26,',
    'otherEpisode,Flash Flood,NORTH CAROLINA,00001,raw,202409,25,202409,26,',
  ];
  routeFetch({
    [`${BASE}StormEvents_details-ftp_v1.0_d2024_c20260728.csv.gz`]: () =>
      gzipResponse(`${header}\n${rows.join('\n')}\n`),
  });
}

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
    const error = await rejection(
      service.search({ ...baseQuery, year: 2024 }, createMockContext()),
    );

    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.data).toMatchObject({ reason: 'service_unavailable' });
    expect(error.data?.recovery).toBeUndefined();
  });

  it('leaves an unpublished year’s recovery hint to the declared contract', async () => {
    const service = new StormEventsService(BASE);
    const error = await rejection(service.resolveDetailsFile(2099, createMockContext()));

    // The framework fills the declared hint from `data.reason`; a hint written
    // here would be a second copy to drift.
    expect(error.data?.reason).toBe('year_unavailable');
    expect(error.data?.recovery).toBeUndefined();
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

  it('projects a row lacking the county and location cells to exactly the fields it carries', async () => {
    const service = new StormEventsService(BASE);
    const result = await service.search({ ...baseQuery, year: 1950 }, createMockContext());

    // Strict: a key present with an undefined value, an empty string, or a zero fails it.
    expect(result.events[0]).toStrictEqual({
      eventId: '10096222',
      eventType: 'Tornado',
      state: 'OKLAHOMA',
      beginDateTime: '28-APR-50 14:45:00',
      countyOrZone: 'WASHITA',
      countyOrZoneType: 'C',
      endDateTime: '28-APR-50 14:45:00',
      timezone: 'CST',
      torFScale: 'F3',
      torLengthInMiles: 3.4,
      torWidthInYards: 400,
      injuriesDirect: 0,
      injuriesIndirect: 0,
      deathsDirect: 0,
      deathsIndirect: 0,
      damageProperty: { raw: '250K', amountInUsd: 250_000 },
      damageCrops: { raw: '0.00K', amountInUsd: 0 },
      beginLatitude: 35.2,
      beginLongitude: -99,
    });
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
  ])(
    'throws malformed_export, leaving its hint to the declared contract, when %s',
    async (_case, body) => {
      routeFetch({
        [`${BASE}StormEvents_details-ftp_v1.0_d2024_c20260728.csv.gz`]: () => gzipResponse(body),
      });
      const service = new StormEventsService(BASE);
      const error = await rejection(
        service.search({ ...baseQuery, year: 2024 }, createMockContext()),
      );

      expect(error.data).toMatchObject({ reason: 'malformed_export' });
      expect(error.data?.recovery).toBeUndefined();
    },
  );
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
  it('filters inclusive valid-span overlap before damage counts and paging', async () => {
    serveSpans();
    const service = new StormEventsService(BASE);
    const query = {
      year: 2024,
      state: 'north carolina',
      eventType: 'flash flood',
      episodeId: '00123',
      month: 9,
      startDate: '2024-09-24',
      endDate: '2024-09-29',
      minDamageInUsd: 0,
      limit: 2,
      offset: 0,
    };
    const first = await service.search(query, createMockContext());
    expect(first.totalCount).toBe(3);
    expect(first.excludedUnknownDamage).toBe(1);
    expect(first.events.map((event) => event.eventId)).toEqual(['before', 'inside']);
    const second = await service.search({ ...query, offset: 2 }, createMockContext());
    expect(second.events.map((event) => event.eventId)).toEqual(['after']);
    expect(second.totalCount).toBe(3);
    const exhausted = await service.search({ ...query, offset: 3 }, createMockContext());
    expect(exhausted.events).toEqual([]);
    expect(exhausted.totalCount).toBe(3);
    expect(vi.mocked(fetch).mock.calls).toHaveLength(2);
  });

  it.each([
    [{ startDate: '2024-09-29' }, ['after', 'enclosing', 'disjoint']],
    [{ endDate: '2024-09-20' }, ['before', 'enclosing']],
    [{ startDate: '2024-09-24', endDate: '2024-09-24' }, ['before', 'enclosing']],
    [
      { startDate: '2023-01-01', endDate: '2025-12-31' },
      ['before', 'inside', 'after', 'enclosing', 'disjoint', 'unknown'],
    ],
    [{ startDate: '2025-01-01' }, []],
  ])('supports inclusive one-sided/equal/cross-year and disjoint ranges %j', async (range, ids) => {
    serveSpans();
    const result = await new StormEventsService(BASE).search(
      {
        ...baseQuery,
        year: 2024,
        state: 'NORTH CAROLINA',
        eventType: 'Flash Flood',
        episodeId: '00123',
        ...range,
      },
      createMockContext(),
    );
    expect(result.events.map((event) => event.eventId)).toEqual(ids);
    expect(result.totalCount).toBe(ids.length);
    expect(vi.mocked(fetch).mock.calls).toHaveLength(2);
    expect(String(vi.mocked(fetch).mock.calls[1]?.[0])).toContain('_d2024_');
  });

  it('preserves missing, invalid and reversed spans without date filters', async () => {
    serveSpans();
    const result = await new StormEventsService(BASE).search(
      { ...baseQuery, year: 2024 },
      createMockContext(),
    );
    expect(result.totalCount).toBe(12);
    expect(result.events.find((event) => event.eventId === 'missing')).toMatchObject({
      eventId: 'missing',
      beginDate: '2024-09-25',
    });
    expect(result.events.find((event) => event.eventId === 'missing')?.endDate).toBeUndefined();
    expect(result.events.find((event) => event.eventId === 'invalid')).toMatchObject({
      eventId: 'invalid',
      endDate: '2024-10-01',
    });
    expect(result.events.find((event) => event.eventId === 'invalid')?.beginDate).toBeUndefined();
    expect(result.events.find((event) => event.eventId === 'reversed')).toMatchObject({
      beginDate: '2024-09-27',
      endDate: '2024-09-25',
    });
  });
  it('retains rows with absent source span endpoints when no interval is supplied', async () => {
    const result = await new StormEventsService(BASE).search(
      { ...baseQuery, year: 2024 },
      createMockContext(),
    );
    expect(result.events.map((event) => event.eventId)).toEqual([
      '1209832',
      '1174463',
      '1195301',
      '1182258',
      '1190000',
      '1191000',
      '1223377',
    ]);
    expect(
      result.events.every((event) => event.beginDate === undefined && event.endDate === undefined),
    ).toBe(true);
  });
  it('matches episode IDs literally before counts and pagination', async () => {
    const service = new StormEventsService(BASE);
    const result = await service.search(
      { ...baseQuery, year: 2024, episodeId: '190993', state: 'TEXAS', limit: 1 },
      createMockContext(),
    );
    expect(result.totalCount).toBe(1);
    expect(result.events.map((event) => event.eventId)).toEqual(['1182258']);
    const unmatched = await service.search(
      { ...baseQuery, year: 2024, episodeId: '0190993' },
      createMockContext(),
    );
    expect(unmatched.totalCount).toBe(0);
    expect(unmatched.events).toEqual([]);
  });

  it.each([
    ['202402', '9', '202403', '1', '2024-02-09', '2024-03-01'],
    ['199512', '31', '199601', '1', '1995-12-31', '1996-01-01'],
    ['202402', '29', '', '', '2024-02-29', undefined],
    ['202302', '29', '202413', '1', undefined, undefined],
    ['202404', '31', '202401', '0', undefined, undefined],
    ['', '1', '202401', '', undefined, undefined],
  ])(
    'projects valid local calendar pairs %s/%s through %s/%s',
    async (ym, day, endYm, endDay, beginDate, endDate) => {
      const header = `${HEADER},BEGIN_DAY,END_YEARMONTH,END_DAY`;
      const row = `${ROWS[0]?.replace(/^202409/, ym)},${day},${endYm},${endDay}`;
      routeFetch({
        [`${BASE}StormEvents_details-ftp_v1.0_d2024_c20260728.csv.gz`]: () =>
          gzipResponse(`${header}\r\n${row}\r\n`),
      });
      const result = await new StormEventsService(BASE).search(
        { ...baseQuery, year: 2024 },
        createMockContext(),
      );
      expect(result.events[0]?.beginDate).toBe(beginDate);
      expect(result.events[0]?.endDate).toBe(endDate);
      expect(result.events[0]?.beginDateTime).toBe('26-SEP-24 16:00:00');
      expect(result.events[0]?.timezone).toBe('EST-5');
    },
  );
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

describe('StormEventsService — county FIPS and location columns', () => {
  const FILE = `${BASE}StormEvents_details-ftp_v1.0_d2024_c20260728.csv.gz`;
  const LOCATION_FIELDS = [
    'stateFips',
    'czFips',
    'cdoLocationId',
    'wfo',
    'beginLocation',
    'endLatitude',
    'endLongitude',
  ] as const;

  /**
   * One row per `CZ_TYPE` and `STATE_FIPS` class the exports carry, cut from the
   * 2024, 2005, and 2026 files: county rows in a state, at both ends of the
   * Census range, in Alaska and three territories; a forecast-zone row whose
   * codes compose the same digits as a county; a marine row; the stray `5`
   * type; blank cells; and two cells that are not 1–2 / 1–3 digit codes.
   * Damage is blank on five rows so exclusion counting can be scoped.
   */
  const COUNTY_HEADER =
    'EVENT_ID,EVENT_TYPE,STATE,STATE_FIPS,CZ_TYPE,CZ_FIPS,CZ_NAME,WFO,BEGIN_DATE_TIME,BEGIN_YEARMONTH,' +
    'BEGIN_LOCATION,BEGIN_LAT,BEGIN_LON,END_LAT,END_LON,DAMAGE_PROPERTY';
  const COUNTY_ROWS = [
    '1169616,"Tornado","WASHINGTON",53,"C",43,"LINCOLN","OTX","26-MAR-24 16:45:00",202403,"ROCKLYN","47.6507","-118.2383","47.6506","-118.2383","0.00K"',
    'lincolnUnreported,"Hail","WASHINGTON",53,"C",43,"LINCOLN","OTX","18-MAY-24 15:10:00",202405,"DAVENPORT","47.65","-118.15","47.65","-118.15",',
    'lincolnZone,"Winter Storm","WASHINGTON",53,"Z",43,"WASHINGTON PALOUSE","OTX","05-JAN-24 08:00:00",202401,"",,,,,',
    'spokane,"Hail","WASHINGTON",53,"C",63,"SPOKANE","OTX","18-MAY-24 15:30:00",202405,"SPOKANE","47.66","-117.43","47.66","-117.43",',
    'autauga,"Thunderstorm Wind","ALABAMA",1,"C",1,"AUTAUGA","BMX","09-MAY-24 18:00:00",202405,"PRATTVILLE","32.46","-86.47","32.47","-86.45","1.00K"',
    'campbell,"Hail","WYOMING",56,"C",5,"CAMPBELL","UNR","14-JUN-24 17:20:00",202406,"WRIGHT","43.93","-105.45","43.93","-105.45","0.00K"',
    'aleutians,"Heavy Rain","ALASKA",2,"C",185,"EASTERN ALEUTIANS","AFC","02-OCT-24 06:00:00",202410,"UNALASKA","53.88","-166.53","53.88","-166.53","0.00K"',
    'adjuntas,"Flood","PUERTO RICO",99,"C",1,"ADJUNTAS","SJU","11-SEP-24 14:00:00",202409,"ADJUNTAS","18.16","-66.72","18.16","-66.72","10.00K"',
    'stCroix,"Flash Flood","VIRGIN ISLANDS",96,"C",10,"ST. CROIX","SJU","20-OCT-24 09:00:00",202410,"ST CROIX","17.76","-64.62","17.76","-64.62","1.00K"',
    'guam,"Dust Devil","GUAM",98,"C",6,"GUAM","GUM","03-MAR-24 13:00:00",202403,"MANGILAO","13.46","144.80","13.46","144.80","0.20K"',
    'marine,"Marine Thunderstorm Wind","LAKE MICHIGAN",91,"M",745,"BURN HBR TO MICHIGAN CITY IN","LOT","13-JUL-24 21:00:00",202407,"MICHIGAN CITY","41.71667","-86.9","41.71667","-86.9",',
    'lakeMead,"High Wind","ARIZONA",4,"5",70,"LAKE MEAD - AZ SIDE","VEF","12-FEB-24 11:00:00",202402,"",,,,,"0.00K"',
    'blank,"Drought","TEXAS",,"C",,"","","01-AUG-24 00:00:00",202408,"",,,,,',
    'overwide,"Hail","TEXAS",123,"C",1000,"HARRIS","HGX","04-APR-24 19:00:00",202404,"HOUSTON","29.7","-95.3","29.7","-95.3","5.00K"',
    'nonDigit,"Hail","TEXAS",4x,"C",-1,"HARRIS","HGX","04-APR-24 19:05:00",202404,"HOUSTON","29.7","-95.3","29.7","-95.3","5.00K"',
  ];

  beforeEach(() => {
    routeFetch({ [FILE]: () => gzipResponse(`${COUNTY_HEADER}\n${COUNTY_ROWS.join('\n')}\n`) });
  });

  const searchCounties = (filters: Partial<Parameters<StormEventsService['search']>[0]> = {}) =>
    new StormEventsService(BASE).search(
      { ...baseQuery, year: 2024, ...filters },
      createMockContext(),
    );

  /** The county-code keys an event carries, including any present with an undefined value. */
  const countyCodes = (event: object | undefined) =>
    Object.fromEntries(
      Object.entries(event ?? {}).filter(([key]) =>
        ['stateFips', 'czFips', 'cdoLocationId'].includes(key),
      ),
    );

  it('projects all seven fields for the 2024 Lincoln County tornado', async () => {
    const result = await searchCounties();
    const lincoln = result.events.find((event) => event.eventId === '1169616');

    expect(lincoln).toMatchObject({
      stateFips: '53',
      czFips: '043',
      cdoLocationId: 'FIPS:53043',
      wfo: 'OTX',
      beginLocation: 'ROCKLYN',
      endLatitude: 47.6506,
      endLongitude: -118.2383,
    });
    // The end coordinates are their own cells, not a copy of the begin point.
    expect(lincoln?.beginLatitude).toBe(47.6507);
  });

  it.each([
    ['1169616', { stateFips: '53', czFips: '043', cdoLocationId: 'FIPS:53043' }],
    ['autauga', { stateFips: '01', czFips: '001', cdoLocationId: 'FIPS:01001' }],
    ['campbell', { stateFips: '56', czFips: '005', cdoLocationId: 'FIPS:56005' }],
    ['lincolnZone', { stateFips: '53', czFips: '043' }],
    ['aleutians', { stateFips: '02', czFips: '185' }],
    ['adjuntas', { stateFips: '99', czFips: '001' }],
    ['stCroix', { stateFips: '96', czFips: '010' }],
    ['guam', { stateFips: '98', czFips: '006' }],
    ['marine', { stateFips: '91', czFips: '745' }],
    ['lakeMead', { stateFips: '04', czFips: '070' }],
    ['blank', {}],
    ['overwide', {}],
    ['nonDigit', {}],
  ])('composes the county codes of row %s as %j', async (eventId, expected) => {
    const result = await searchCounties();
    expect(countyCodes(result.events.find((event) => event.eventId === eventId))).toStrictEqual(
      expected,
    );
  });

  it('omits every location field whose cell is blank, never writing 0 or an empty string', async () => {
    const result = await searchCounties();
    const blank = result.events.find((event) => event.eventId === 'blank');
    const zone = result.events.find((event) => event.eventId === 'lincolnZone');

    for (const field of LOCATION_FIELDS) expect(blank).not.toHaveProperty(field);
    for (const field of ['beginLocation', 'endLatitude', 'endLongitude', 'cdoLocationId']) {
      expect(zone).not.toHaveProperty(field);
    }
    expect(zone?.wfo).toBe('OTX');
  });

  it('matches countyFips before damage accounting, totals, and paging', async () => {
    const all = await searchCounties({ countyFips: '53043' });
    expect(all.events.map((event) => event.eventId)).toEqual(['1169616', 'lincolnUnreported']);
    expect(all.totalCount).toBe(2);

    const second = await searchCounties({ countyFips: '53043', limit: 1, offset: 1 });
    expect(second.events.map((event) => event.eventId)).toEqual(['lincolnUnreported']);
    expect(second.totalCount).toBe(2);

    const pastEnd = await searchCounties({ countyFips: '53043', offset: 2 });
    expect(pastEnd.events).toEqual([]);
    expect(pastEnd.totalCount).toBe(2);

    // Five rows in the file have no damage figure; only one of them is in the county.
    const unscoped = await searchCounties({ minDamageInUsd: 0 });
    expect(unscoped.excludedUnknownDamage).toBe(5);
    const scoped = await searchCounties({ countyFips: '53043', minDamageInUsd: 0 });
    expect(scoped.events.map((event) => event.eventId)).toEqual(['1169616']);
    expect(scoped.totalCount).toBe(1);
    expect(scoped.excludedUnknownDamage).toBe(1);
  });

  it('keeps leading zeros significant in countyFips', async () => {
    const result = await searchCounties({ countyFips: '01001' });
    expect(result.events.map((event) => event.eventId)).toEqual(['autauga']);
  });

  it.each([
    ['02185', 'an Alaska county row carrying an NWS zone number'],
    ['99001', 'a Puerto Rico county row'],
    ['96010', 'a Virgin Islands county row'],
    ['98006', 'a Guam county row'],
    ['91745', 'a marine row'],
    ['04070', 'a CZ_TYPE 5 row'],
  ])('matches nothing for %s, which only %s would compose', async (countyFips) => {
    const result = await searchCounties({ countyFips });
    expect(result.totalCount).toBe(0);
    expect(result.events).toEqual([]);
  });

  it('ANDs countyFips with the other filters', async () => {
    const tornado = await searchCounties({ countyFips: '53043', eventType: 'tornado' });
    expect(tornado.events.map((event) => event.eventId)).toEqual(['1169616']);

    const may = await searchCounties({ countyFips: '53043', month: 5 });
    expect(may.events.map((event) => event.eventId)).toEqual(['lincolnUnreported']);

    const contradiction = await searchCounties({ countyFips: '53043', state: 'TEXAS' });
    expect(contradiction.totalCount).toBe(0);
  });
});

describe('StormEventsService — the shared fixture’s location columns', () => {
  it('projects the county and location columns on a county row', async () => {
    const result = await new StormEventsService(BASE).search(
      { ...baseQuery, year: 2024, eventType: 'Tornado', month: 5 },
      createMockContext(),
    );
    expect(result.events[0]).toMatchObject({
      eventId: '1182258',
      stateFips: '48',
      czFips: '133',
      cdoLocationId: 'FIPS:48133',
      wfo: 'FWD',
      beginLocation: 'PIONEER',
      endLatitude: 32.1654,
      endLongitude: -99.0667,
    });
  });

  it('keeps the codes but composes no county ID on a forecast-zone row', async () => {
    const result = await new StormEventsService(BASE).search(
      { ...baseQuery, year: 2024, eventType: 'Hurricane (Typhoon)' },
      createMockContext(),
    );
    const helene = result.events[0];
    expect(helene).toMatchObject({ stateFips: '12', czFips: '028', wfo: 'TAE' });
    expect(helene).not.toHaveProperty('cdoLocationId');
    expect(helene).not.toHaveProperty('beginLocation');
    expect(helene).not.toHaveProperty('endLatitude');
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
    const error = await rejection(
      service.search({ ...baseQuery, year: 2024 }, createMockContext()),
    );

    expect(error).toBeInstanceOf(McpError);
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.message).not.toBe('');
    expect(error.message).toMatch(/decompress/i);
    expect(error.data).toMatchObject({ reason: 'service_unavailable', year: 2024 });
    expect(error.data?.recovery).toBeUndefined();
  });

  it('reports a truncated transfer the same way', async () => {
    routeFetch({ [FILE]: truncatedGzip });
    const service = new StormEventsService(BASE);
    const error = await rejection(
      service.search({ ...baseQuery, year: 2024 }, createMockContext()),
    );

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

    const error = await rejection(
      service.search({ ...baseQuery, year: 2024 }, createMockContext()),
    );

    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.data).toMatchObject({ reason: 'service_unavailable', year: 2024 });
    expect(error.data?.recovery).toBeUndefined();
    // Listing, file, listing again, file again — and then it stops.
    expect(vi.mocked(fetch).mock.calls.length).toBe(4);
  });

  it('does not report a removed file as the year being unpublished', async () => {
    routeFetch({
      [BASE]: () => listingResponse(indexNaming(STALE)),
      [`${BASE}${STALE}`]: gone,
    });
    const service = new StormEventsService(BASE);

    const error = await rejection(
      service.search({ ...baseQuery, year: 2024 }, createMockContext()),
    );

    expect(error.code).not.toBe(JsonRpcErrorCode.NotFound);
    expect(error.data?.reason).not.toBe('year_unavailable');
    expect(error.message).not.toContain(BASE);
  });

  it('surfaces a 404 on the directory index itself as a retryable service_unavailable', async () => {
    routeFetch({ [BASE]: gone });
    const service = new StormEventsService(BASE);

    const error = await rejection(
      service.search({ ...baseQuery, year: 2024 }, createMockContext()),
    );

    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.data).toMatchObject({ reason: 'service_unavailable' });
    expect(error.data?.recovery).toBeUndefined();
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
