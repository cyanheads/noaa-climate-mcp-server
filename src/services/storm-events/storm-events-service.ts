/**
 * @fileoverview NCEI Storm Events Database client. Resolves the per-year
 * `details` filename from the live directory listing, downloads the gzip bundle,
 * and streams it through a CSV reader so a year is filtered without ever holding
 * the decompressed file.
 * @module services/storm-events/storm-events-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import {
  McpError,
  notFound,
  serializationError,
  serviceUnavailable,
} from '@cyanheads/mcp-ts-core/errors';
import { fetchWithTimeout, requestContextService, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { CsvStreamReader } from '@/services/csv/csv-stream-reader.js';
import { parseDamageEstimate } from './damage.js';
import type { StormEvent, StormEventsQuery, StormEventsSearchResult } from './types.js';

const BASE_URL = 'https://www.ncei.noaa.gov/pub/data/swdi/stormevents/csvfiles/';

const LISTING_TIMEOUT_MS = 15_000;
/** A year's `details` bundle runs 12–15 MB; the CDO client's 15 s is not enough. */
const DOWNLOAD_TIMEOUT_MS = 120_000;

/**
 * How long a resolved listing and a downloaded year stay usable.
 *
 * NCEI republishes a year on its own schedule — corrections and late-reported
 * events land under a new `_c<publishDate>` suffix — so both caches expire
 * rather than persisting for the process lifetime.
 */
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * Years held as compressed bytes at once. Two covers the common "compare this
 * year against last" follow-up while keeping the cache under 30 MB: recent
 * bundles run about 12 MB and the largest, 2011, is 15 MB.
 *
 * That bound is the *retained* set, not the process's memory envelope.
 * Decompression is streamed per call, so the decompressed form is never
 * materialized — 2024 arrives as 4,272 chunks of 16 KB, 66.6 MB in total — but
 * the transient chunk strings still cost real headroom: a cold full-year 2024
 * scan took RSS from a 129 MB baseline to a 269 MB peak, and repeated scans
 * climb further before the collector reclaims them. Bounded garbage, not
 * retention, but not a 30 MB envelope either.
 */
const MAX_CACHED_YEARS = 2;

/**
 * Filenames carry a publish date that is not a function of the year — 2024 and
 * 2025 sit at `_c20260728` while 2023 is `_c20260323` — so the listing is the
 * only way to name a file. Matched globally: the Apache index repeats each entry
 * in the link href and its text.
 */
const DETAILS_FILE_PATTERN = /StormEvents_details-ftp_v1\.0_d(\d{4})_c(\d{8})\.csv\.gz/g;

/** Columns the search reads. Absence of any of these means the export changed shape. */
const REQUIRED_COLUMNS = [
  'EVENT_ID',
  'EVENT_TYPE',
  'STATE',
  'BEGIN_YEARMONTH',
  'BEGIN_DATE_TIME',
  'DAMAGE_PROPERTY',
] as const;

type CachedListing = { files: Map<number, string>; fetchedAtMs: number };
type CachedYear = { bytes: Uint8Array<ArrayBuffer>; fetchedAtMs: number };
type YearBundle = { year: number; sourceFile: string; bytes: Uint8Array<ArrayBuffer> };

/**
 * True when a fetch came back 404.
 *
 * `data.status` is what separates an HTTP 404 from the `notFound()` this service
 * throws for a year the directory never listed: only the framework's fetch
 * helper sets it. A 404 on a file the listing named is an upstream republish,
 * not a missing year.
 */
function isMissingUpstreamFile(error: unknown): boolean {
  return error instanceof McpError && error.data?.status === 404;
}

/** Parse a numeric cell, treating blank and non-numeric text as absent. */
function toNumber(value: string | undefined): number | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Parse a text cell, treating blank as absent. */
function toText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export class StormEventsService {
  private readonly baseUrl: string;
  private listing: CachedListing | undefined;
  /** Insertion-ordered so the oldest entry is the eviction candidate. */
  private readonly years = new Map<number, CachedYear>();

  constructor(baseUrl = BASE_URL) {
    this.baseUrl = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  }

  /**
   * Resolve the current `details` filename for a year from the directory index.
   *
   * When a year appears more than once the highest `_c` date wins: NCEI leaves
   * the superseded entry in place after a republish.
   */
  async resolveDetailsFile(year: number, ctx: Context): Promise<string> {
    const files = await this.loadListing(ctx);
    const file = files.get(year);
    if (!file) {
      const years = [...files.keys()].sort((a, b) => a - b);
      const range = years.length > 0 ? `${years[0]}–${years.at(-1)}` : 'none';
      // The live range goes in the message; the recovery hint is resolved from
      // the tool's declared contract rather than written a second time here.
      throw notFound(
        `The NCEI Storm Events directory has no details file for ${year}. Published years: ${range}.`,
        { reason: 'year_unavailable', year, ...ctx.recoveryFor('year_unavailable') },
      );
    }
    return file;
  }

  /**
   * Search one year's `details` table.
   *
   * The scan is single-pass: every row is read so `totalCount` is the true match
   * count, but only rows inside the requested page are materialized, so the
   * retained set never exceeds `limit` regardless of how many rows match.
   */
  async search(query: StormEventsQuery, ctx: Context): Promise<StormEventsSearchResult> {
    const bundle = await this.loadYearBundle(query.year, ctx);
    const sourceFile = bundle.sourceFile;

    const stateNeedle = query.state?.trim().toLowerCase();
    const eventTypeNeedle = query.eventType?.trim().toLowerCase();

    const events: StormEvent[] = [];
    const eventTypesInYear = new Set<string>();
    const statesInYear = new Set<string>();
    let columns: Map<string, number> | undefined;
    let scannedRowCount = 0;
    let totalCount = 0;
    let excludedUnknownDamage = 0;

    await this.readRecords(bundle, ctx, (record) => {
      if (!columns) {
        columns = indexHeader(record, sourceFile, ctx);
        return;
      }
      // A blank line parses to a single empty field; it is not a row.
      if (record.length < 2) return;

      const index = columns;
      scannedRowCount++;
      const cell = (name: string) => record[index.get(name) ?? -1] ?? '';

      const eventType = cell('EVENT_TYPE');
      const state = cell('STATE');
      if (eventType) eventTypesInYear.add(eventType);
      if (state) statesInYear.add(state);

      if (stateNeedle !== undefined && state.toLowerCase() !== stateNeedle) return;
      if (eventTypeNeedle !== undefined && eventType.toLowerCase() !== eventTypeNeedle) return;
      if (
        query.month !== undefined &&
        Number(cell('BEGIN_YEARMONTH').slice(4, 6)) !== query.month
      ) {
        return;
      }

      const damageProperty = parseDamageEstimate(cell('DAMAGE_PROPERTY'));
      if (query.minDamageInUsd !== undefined) {
        if (damageProperty?.amountInUsd === undefined) {
          excludedUnknownDamage++;
          return;
        }
        if (damageProperty.amountInUsd < query.minDamageInUsd) return;
      }

      totalCount++;
      if (totalCount > query.offset && events.length < query.limit) {
        events.push(projectEvent(cell, damageProperty));
      }
    });

    if (!columns) {
      throw serializationError(`Storm Events file ${sourceFile} contained no rows.`, {
        reason: 'malformed_export',
        sourceFile,
        ...ctx.recoveryFor('malformed_export'),
      });
    }

    ctx.log.debug('Storm Events scan complete', {
      sourceFile,
      scannedRowCount,
      totalCount,
      returned: events.length,
    });

    return {
      events,
      totalCount,
      scannedRowCount,
      sourceFile,
      excludedUnknownDamage,
      eventTypesInYear: [...eventTypesInYear].sort(),
      statesInYear: [...statesInYear].sort(),
    };
  }

  /**
   * Resolve a year's filename and fetch its bundle, re-resolving once when the
   * name the listing gave is gone.
   *
   * NCEI republishes a year under a new `_c<publishDate>` suffix and deletes the
   * file it supersedes, so a listing cached up to six hours ago can name a file
   * that no longer exists. That 404 is an upstream republish, not a year the
   * corpus lacks: drop the listing, resolve again, and fail only if the freshly
   * named file is missing too. One retry, never a loop.
   */
  private async loadYearBundle(year: number, ctx: Context): Promise<YearBundle> {
    const sourceFile = await this.resolveDetailsFile(year, ctx);
    try {
      return { year, sourceFile, bytes: await this.loadYear(year, sourceFile, ctx) };
    } catch (error) {
      if (!isMissingUpstreamFile(error)) throw error;
      ctx.log.debug('Cached Storm Events filename is gone; re-resolving the listing', {
        year,
        sourceFile,
      });
      this.listing = undefined;
    }

    const republished = await this.resolveDetailsFile(year, ctx);
    try {
      return { year, sourceFile: republished, bytes: await this.loadYear(year, republished, ctx) };
    } catch (error) {
      if (!isMissingUpstreamFile(error)) throw error;
      throw serviceUnavailable(
        `The NCEI Storm Events directory lists a ${year} details file that the server will not serve. The year is published but its bundle is not downloadable right now.`,
        {
          reason: 'service_unavailable',
          year,
          sourceFile: republished,
          ...ctx.recoveryFor('service_unavailable'),
        },
        { cause: error },
      );
    }
  }

  /** Fetch and cache the directory index as a year → filename map. */
  private async loadListing(ctx: Context): Promise<Map<number, string>> {
    const cached = this.listing;
    if (cached && Date.now() - cached.fetchedAtMs < CACHE_TTL_MS) return cached.files;

    const retryCtx = this.retryContext('stormEvents.listing', ctx);
    let html: string;
    try {
      html = await withRetry(
        async () => {
          ctx.log.debug('Fetching Storm Events directory listing', { url: this.baseUrl });
          const response = await fetchWithTimeout(this.baseUrl, LISTING_TIMEOUT_MS, retryCtx, {
            signal: ctx.signal,
          });
          return response.text();
        },
        {
          operation: 'stormEvents.listing',
          context: retryCtx,
          baseDelayMs: 1000,
          signal: ctx.signal,
        },
      );
    } catch (error) {
      // A 404 on the index is the bulk server being unavailable, not a missing
      // resource the caller asked for — and the raw message names the internal
      // URL, which is no use to an agent deciding what to do next.
      if (!isMissingUpstreamFile(error)) throw error;
      throw serviceUnavailable(
        'The NCEI Storm Events directory index is not being served right now, so no year can be resolved.',
        { reason: 'service_unavailable', ...ctx.recoveryFor('service_unavailable') },
        { cause: error },
      );
    }

    const files = new Map<number, string>();
    const published = new Map<number, string>();
    for (const [file, year = '', publishDate = ''] of html.matchAll(DETAILS_FILE_PATTERN)) {
      const parsedYear = Number(year);
      const previous = published.get(parsedYear);
      if (previous !== undefined && previous >= publishDate) continue;
      published.set(parsedYear, publishDate);
      files.set(parsedYear, file);
    }

    if (files.size === 0) {
      throw serviceUnavailable(
        'The NCEI Storm Events directory listing carried no details files — the index may be unavailable or its layout may have changed.',
        { reason: 'service_unavailable', ...ctx.recoveryFor('service_unavailable') },
      );
    }

    this.listing = { files, fetchedAtMs: Date.now() };
    return files;
  }

  /** Fetch and cache one year's compressed bundle, evicting the oldest cached year. */
  private async loadYear(
    year: number,
    file: string,
    ctx: Context,
  ): Promise<Uint8Array<ArrayBuffer>> {
    const cached = this.years.get(year);
    if (cached && Date.now() - cached.fetchedAtMs < CACHE_TTL_MS) {
      // Re-insert so the least recently used year stays at the front.
      this.years.delete(year);
      this.years.set(year, cached);
      return cached.bytes;
    }

    const url = `${this.baseUrl}${file}`;
    const retryCtx = this.retryContext('stormEvents.download', ctx);
    const bytes = await withRetry(
      async () => {
        ctx.log.debug('Downloading Storm Events year', { url });
        const response = await fetchWithTimeout(url, DOWNLOAD_TIMEOUT_MS, retryCtx, {
          signal: ctx.signal,
        });
        return new Uint8Array(await response.arrayBuffer());
      },
      {
        operation: 'stormEvents.download',
        context: retryCtx,
        baseDelayMs: 1000,
        signal: ctx.signal,
      },
    );

    this.years.delete(year);
    this.years.set(year, { bytes, fetchedAtMs: Date.now() });
    while (this.years.size > MAX_CACHED_YEARS) {
      const oldest = this.years.keys().next().value;
      if (oldest === undefined) break;
      this.years.delete(oldest);
    }
    return bytes;
  }

  /**
   * Decompress and parse the bundle, handing each record to `onRecord`.
   *
   * NCEI serves these files as `Content-Type: application/gzip` with no
   * `Content-Encoding` header, so `fetch` hands back the compressed bytes
   * untouched and the gunzip has to be explicit. Decompressing through a stream
   * rather than in one shot keeps the ~70 MB decompressed form out of memory —
   * only the current chunk is live.
   *
   * A body that will not decompress — an HTML error page served under HTTP 200,
   * a transfer cut short — surfaces from `read()` as a bare Node `TypeError`
   * with an empty message, which reaches the client as `-32603` with nothing to
   * act on. It is an upstream availability failure, so it is reclassified. The
   * bytes are dropped first: cached before they were proven readable, they
   * would otherwise be replayed for the rest of the six-hour TTL and keep
   * failing long after NCEI recovered.
   */
  private async readRecords(
    bundle: YearBundle,
    ctx: Context,
    onRecord: (record: string[]) => void,
  ): Promise<void> {
    const reader = new Blob([bundle.bytes])
      .stream()
      .pipeThrough(new DecompressionStream('gzip'))
      .pipeThrough(new TextDecoderStream())
      .getReader();

    const csv = new CsvStreamReader();
    try {
      for (;;) {
        let chunk: Awaited<ReturnType<typeof reader.read>>;
        try {
          chunk = await reader.read();
        } catch (cause) {
          this.years.delete(bundle.year);
          throw serviceUnavailable(
            `The NCEI Storm Events bundle for ${bundle.year} did not decompress — the download was truncated, or the server returned something other than the gzip file. The copy that failed has been discarded.`,
            {
              reason: 'service_unavailable',
              year: bundle.year,
              sourceFile: bundle.sourceFile,
              ...ctx.recoveryFor('service_unavailable'),
            },
            { cause },
          );
        }
        if (chunk.done) break;
        if (ctx.signal.aborted) break;
        for (const record of csv.push(chunk.value)) onRecord(record);
      }
    } finally {
      reader.releaseLock();
    }
    for (const record of csv.end()) onRecord(record);
  }

  private retryContext(operation: string, ctx: Context) {
    return requestContextService.createRequestContext({
      operation,
      parentContext: ctx,
    });
  }
}

/** Map header names to column positions, failing loudly if the export changed shape. */
function indexHeader(record: string[], sourceFile: string, ctx: Context): Map<string, number> {
  const columns = new Map(record.map((name, index) => [name.trim(), index] as const));
  const missing = REQUIRED_COLUMNS.filter((name) => !columns.has(name));
  if (missing.length > 0) {
    throw serializationError(
      `Storm Events file ${sourceFile} is missing expected columns: ${missing.join(', ')}.`,
      { reason: 'malformed_export', sourceFile, missing, ...ctx.recoveryFor('malformed_export') },
    );
  }
  return columns;
}

/** Build the surfaced event from one row, omitting every cell NCEI left blank. */
function projectEvent(
  cell: (name: string) => string,
  damageProperty: ReturnType<typeof parseDamageEstimate>,
): StormEvent {
  const damageCrops = parseDamageEstimate(cell('DAMAGE_CROPS'));
  const episodeId = toText(cell('EPISODE_ID'));
  const countyOrZone = toText(cell('CZ_NAME'));
  const countyOrZoneType = toText(cell('CZ_TYPE'));
  const endDateTime = toText(cell('END_DATE_TIME'));
  const timezone = toText(cell('CZ_TIMEZONE'));
  const magnitude = toNumber(cell('MAGNITUDE'));
  const magnitudeType = toText(cell('MAGNITUDE_TYPE'));
  const torFScale = toText(cell('TOR_F_SCALE'));
  const torLengthInMiles = toNumber(cell('TOR_LENGTH'));
  const torWidthInYards = toNumber(cell('TOR_WIDTH'));
  const injuriesDirect = toNumber(cell('INJURIES_DIRECT'));
  const injuriesIndirect = toNumber(cell('INJURIES_INDIRECT'));
  const deathsDirect = toNumber(cell('DEATHS_DIRECT'));
  const deathsIndirect = toNumber(cell('DEATHS_INDIRECT'));
  const floodCause = toText(cell('FLOOD_CAUSE'));
  const beginLatitude = toNumber(cell('BEGIN_LAT'));
  const beginLongitude = toNumber(cell('BEGIN_LON'));
  const source = toText(cell('SOURCE'));
  const episodeNarrative = toText(cell('EPISODE_NARRATIVE'));
  const eventNarrative = toText(cell('EVENT_NARRATIVE'));

  return {
    eventId: cell('EVENT_ID'),
    eventType: cell('EVENT_TYPE'),
    state: cell('STATE'),
    beginDateTime: cell('BEGIN_DATE_TIME'),
    ...(episodeId && { episodeId }),
    ...(countyOrZone && { countyOrZone }),
    ...(countyOrZoneType && { countyOrZoneType }),
    ...(endDateTime && { endDateTime }),
    ...(timezone && { timezone }),
    ...(magnitude !== undefined && { magnitude }),
    ...(magnitudeType && { magnitudeType }),
    ...(torFScale && { torFScale }),
    ...(torLengthInMiles !== undefined && { torLengthInMiles }),
    ...(torWidthInYards !== undefined && { torWidthInYards }),
    ...(injuriesDirect !== undefined && { injuriesDirect }),
    ...(injuriesIndirect !== undefined && { injuriesIndirect }),
    ...(deathsDirect !== undefined && { deathsDirect }),
    ...(deathsIndirect !== undefined && { deathsIndirect }),
    ...(damageProperty && { damageProperty }),
    ...(damageCrops && { damageCrops }),
    ...(floodCause && { floodCause }),
    ...(beginLatitude !== undefined && { beginLatitude }),
    ...(beginLongitude !== undefined && { beginLongitude }),
    ...(source && { source }),
    ...(episodeNarrative && { episodeNarrative }),
    ...(eventNarrative && { eventNarrative }),
  };
}

// --- Init/accessor pattern ---

let _service: StormEventsService | undefined;

export function initStormEventsService(): void {
  _service = new StormEventsService();
}

export function getStormEventsService(): StormEventsService {
  if (!_service) {
    throw new Error(
      'StormEventsService not initialized — call initStormEventsService() in setup()',
    );
  }
  return _service;
}
