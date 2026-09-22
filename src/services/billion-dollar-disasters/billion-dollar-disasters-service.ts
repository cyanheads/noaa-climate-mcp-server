/**
 * @fileoverview NCEI Billion-Dollar Weather and Climate Disasters client.
 *
 * Reads the two small static CSV exports NCEI publishes for the corpus — the
 * per-event `events-*.csv` and the per-year `time-series-*.csv` — in their
 * national form and in their per-state form, and converts every cost to whole
 * US dollars on the way through.
 *
 * The conversion is the point of this module. NCEI states a cost unit in each
 * file's own preamble and does not use the same one twice: `events-US.csv` is
 * millions, `time-series-US.csv` is billions, and `time-series-CA.csv` is
 * millions again, as a binned range rather than a point estimate. Reading the
 * declared unit out of the file, rather than assuming one per endpoint, is what
 * keeps a figure from landing three orders of magnitude wrong while still
 * looking entirely plausible.
 *
 * @module services/billion-dollar-disasters/billion-dollar-disasters-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { McpError, notFound, serializationError } from '@cyanheads/mcp-ts-core/errors';
import { fetchWithTimeout, requestContextService, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { CsvStreamReader } from '@/services/csv/csv-stream-reader.js';
import {
  ALL_DISASTERS,
  type BillionDollarDisaster,
  type CostConfidenceBounds,
  DISASTER_TYPES,
  type DisasterEventsResult,
  type DisasterQuery,
  type DisasterSummaryResult,
  type DisasterTypeTally,
  type DisasterYearSummary,
} from './types.js';

const BASE_URL = 'https://www.ncei.noaa.gov/access/billions/';

/** Both exports are under 40 KB and served as plain `text/csv`. */
const REQUEST_TIMEOUT_MS = 20_000;

/**
 * How long a downloaded export stays usable.
 *
 * NCEI revises the corpus on its own schedule — a year is added once its
 * assessments settle, and prior years' CPI adjustments move with them — so the
 * cache expires rather than living for the process lifetime.
 */
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * Exports held at once.
 *
 * A file is a few hundred parsed rows, so the bound is about not accumulating
 * one entry per US state and territory over a long-lived process, not about
 * bytes. Eight covers the national pair plus a handful of states.
 */
const MAX_CACHED_FILES = 8;

/** The cost units NCEI declares, and what each is worth in dollars. */
const COST_UNIT_MULTIPLIERS: Record<string, number> = {
  millions: 1_000_000,
  billions: 1_000_000_000,
};

/**
 * The unit sentence NCEI puts in each file's preamble.
 *
 * Both wordings occur: `events-*.csv` says "Cost values are in millions of
 * dollars", the per-state `time-series-*.csv` says "Cost ranges are in millions
 * of dollars". Only the unit itself is captured; an unrecognized one is a
 * malformed export rather than a value to guess at.
 */
const DECLARED_UNIT_PATTERN =
  /\b(?:cost\s+\w+\s+are|values?\s+are|costs?\s+are)\s+in\s+(\w+)\s+of\s+dollars/i;

/** The export's compact date form, e.g. `20240924`. */
const COMPACT_DATE_PATTERN = /^(\d{4})(\d{2})(\d{2})$/;

/** A per-state binned cost, e.g. `2000-5000`. */
const COST_RANGE_PATTERN = /^\s*(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*$/;

/** Two-letter US postal code, the only form the per-state exports are named by. */
const STATE_CODE_PATTERN = /^[A-Za-z]{2}$/;

type ParsedExport = {
  sourceFile: string;
  /** The unit word NCEI declared, e.g. `millions`. */
  declaredUnit: string;
  /** Dollars per declared unit — the single place a cost is scaled. */
  costMultiplier: number;
  header: string[];
  rows: string[][];
};

type CachedExport = { parsed: ParsedExport; fetchedAtMs: number };

/** True when a fetch came back 404 — NCEI publishes no export under that name. */
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

/**
 * Rewrite the export's `YYYYMMDD` to an ISO calendar date.
 *
 * Lossless and unambiguous, unlike the Storm Events export's `30-APR-24` form,
 * so the conversion happens here rather than handing the caller a shape they
 * have to parse themselves.
 */
function toIsoDate(value: string): string {
  const matched = COMPACT_DATE_PATTERN.exec(value.trim());
  if (!matched) return value.trim();
  const [, year, month, day] = matched;
  return `${year}-${month}-${day}`;
}

export class BillionDollarDisastersService {
  private readonly baseUrl: string;
  /** Insertion-ordered so the least recently used export is the eviction candidate. */
  private readonly exports = new Map<string, CachedExport>();

  constructor(baseUrl = BASE_URL) {
    this.baseUrl = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  }

  /** Individual disasters, filtered and paged. */
  async searchEvents(query: DisasterQuery, ctx: Context): Promise<DisasterEventsResult> {
    const parsed = await this.loadExport(exportName('events', query.state), query.state, ctx);
    const column = columnIndex(parsed, ['Name', 'Disaster', 'Begin Date', 'End Date'], ctx);

    const disasterTypesInFile = new Set<string>();
    const years: number[] = [];
    const disasters: BillionDollarDisaster[] = [];
    let totalCount = 0;

    for (const row of parsed.rows) {
      const cell = (name: string) => row[column.get(name) ?? -1] ?? '';
      const beginDate = toIsoDate(cell('Begin Date'));
      const endDate = toIsoDate(cell('End Date'));
      const beginYear = Number(beginDate.slice(0, 4));
      const endYear = Number(endDate.slice(0, 4));
      const disasterType = cell('Disaster').trim();

      if (disasterType) disasterTypesInFile.add(disasterType);
      // Both ends, because the year filter below matches on overlap. A span
      // read from begin years alone reports the file as ending before a row
      // the same response returned.
      if (Number.isFinite(beginYear)) years.push(beginYear);
      if (Number.isFinite(endYear)) years.push(endYear);

      if (query.disasterType !== undefined && disasterType !== query.disasterType) continue;
      // Overlap, not begin-year: four disasters in the corpus run across a New
      // Year, and a range that covers either end of one should return it.
      if (query.startYear !== undefined && endYear < query.startYear) continue;
      if (query.endYear !== undefined && beginYear > query.endYear) continue;

      const cpiAdjustedCostInUsd = this.toUsd(parsed, cell('CPI-Adjusted Cost'));
      const unadjustedCostInUsd = this.toUsd(parsed, cell('Unadjusted Cost'));
      if (query.minCostInUsd !== undefined && cpiAdjustedCostInUsd < query.minCostInUsd) continue;

      totalCount++;
      if (totalCount > query.offset && disasters.length < query.limit) {
        disasters.push({
          name: cell('Name').trim(),
          disasterType,
          beginDate,
          endDate,
          cpiAdjustedCostInUsd,
          unadjustedCostInUsd,
          deaths: toNumber(cell('Deaths')) ?? 0,
        });
      }
    }

    ctx.log.debug('Billion-dollar disasters scan complete', {
      sourceFile: parsed.sourceFile,
      declaredUnit: parsed.declaredUnit,
      totalCount,
      returned: disasters.length,
    });

    return {
      ...describeSource(parsed, years),
      disasters,
      totalCount,
      disasterTypesInFile: [...disasterTypesInFile].sort(),
    };
  }

  /** Per-year counts and costs by disaster class, filtered and paged. */
  async searchSummaries(query: DisasterQuery, ctx: Context): Promise<DisasterSummaryResult> {
    const parsed = await this.loadExport(exportName('time-series', query.state), query.state, ctx);
    const column = columnIndex(parsed, ['State', 'Year'], ctx);

    const years: number[] = [];
    const summaries: DisasterYearSummary[] = [];
    let totalCount = 0;

    for (const row of parsed.rows) {
      const cell = (name: string) => row[column.get(name) ?? -1] ?? '';
      const year = toNumber(cell('Year'));
      if (year === undefined) continue;
      years.push(year);

      if (query.startYear !== undefined && year < query.startYear) continue;
      if (query.endYear !== undefined && year > query.endYear) continue;

      const tallies = [...DISASTER_TYPES, ALL_DISASTERS]
        .filter((type) => query.disasterType === undefined || type === query.disasterType)
        .map((type) => this.readTally(parsed, column, cell, type))
        .filter((tally) => tally !== undefined);
      if (tallies.length === 0) continue;

      if (query.minCostInUsd !== undefined && !reachesCost(tallies, query, query.minCostInUsd)) {
        continue;
      }

      totalCount++;
      if (totalCount > query.offset && summaries.length < query.limit) {
        summaries.push({ year, byDisasterType: tallies });
      }
    }

    ctx.log.debug('Billion-dollar summary scan complete', {
      sourceFile: parsed.sourceFile,
      declaredUnit: parsed.declaredUnit,
      totalCount,
      returned: summaries.length,
    });

    return { ...describeSource(parsed, years), summaries, totalCount };
  }

  /**
   * Scale one cost cell from the unit its file declares to whole dollars.
   *
   * The single conversion site in the module. Rounding is safe rather than
   * lossy: NCEI writes at most one decimal place, so the smallest step is
   * 100,000 dollars in a millions file and 100,000,000 in a billions one, and
   * the rounding only removes binary-float dust.
   */
  private toUsd(parsed: ParsedExport, value: string): number {
    return Math.round((toNumber(value) ?? 0) * parsed.costMultiplier);
  }

  /** Read one disaster class's columns out of a per-year row. */
  private readTally(
    parsed: ParsedExport,
    column: Map<string, number>,
    cell: (name: string) => string,
    type: string,
  ): DisasterTypeTally | undefined {
    const eventCount = column.has(`${type} Count`) ? toNumber(cell(`${type} Count`)) : undefined;
    if (eventCount === undefined) return undefined;

    const tally: DisasterTypeTally = { disasterType: type, eventCount };

    // The national export publishes a point estimate with confidence bands; the
    // per-state exports publish a binned range and no point estimate at all.
    // Which one a file carries is read off its header, not off the scope.
    if (column.has(`${type} Cost`)) {
      tally.costInUsd = this.toUsd(parsed, cell(`${type} Cost`));
      const bounds = this.readConfidenceBounds(parsed, column, cell, type);
      if (bounds) tally.confidenceBoundsInUsd = bounds;
    }

    if (column.has(`${type} Cost Range`)) {
      const matched = COST_RANGE_PATTERN.exec(cell(`${type} Cost Range`));
      if (matched) {
        tally.costRangeInUsd = {
          low: this.toUsd(parsed, matched[1] as string),
          high: this.toUsd(parsed, matched[2] as string),
        };
      }
    }

    return tally;
  }

  /**
   * Read one class's six confidence-bound columns, or nothing when the export
   * does not publish them — the per-state files carry a binned range instead.
   */
  private readConfidenceBounds(
    parsed: ParsedExport,
    column: Map<string, number>,
    cell: (name: string) => string,
    type: string,
  ): CostConfidenceBounds | undefined {
    const bound = (edge: 'Lower' | 'Upper', level: number) => {
      const name = `${type} ${edge} ${level}`;
      return column.has(name) ? this.toUsd(parsed, cell(name)) : undefined;
    };

    const [lower75, upper75, lower90, upper90, lower95, upper95] = [
      bound('Lower', 75),
      bound('Upper', 75),
      bound('Lower', 90),
      bound('Upper', 90),
      bound('Lower', 95),
      bound('Upper', 95),
    ];
    if (
      lower75 === undefined ||
      upper75 === undefined ||
      lower90 === undefined ||
      upper90 === undefined ||
      lower95 === undefined ||
      upper95 === undefined
    ) {
      return undefined;
    }
    return { lower75, upper75, lower90, upper90, lower95, upper95 };
  }

  /** Fetch, parse, and cache one export, evicting the least recently used. */
  private async loadExport(
    file: string,
    state: string | undefined,
    ctx: Context,
  ): Promise<ParsedExport> {
    const cached = this.exports.get(file);
    if (cached && Date.now() - cached.fetchedAtMs < CACHE_TTL_MS) {
      this.exports.delete(file);
      this.exports.set(file, cached);
      return cached.parsed;
    }

    const url = `${this.baseUrl}${file}`;
    const retryCtx = requestContextService.createRequestContext({
      operation: 'billionDollarDisasters.download',
      parentContext: ctx,
    });

    let text: string;
    try {
      text = await withRetry(
        async () => {
          ctx.log.debug('Downloading billion-dollar disasters export', { file });
          const response = await fetchWithTimeout(url, REQUEST_TIMEOUT_MS, retryCtx, {
            signal: ctx.signal,
            expectedStatuses: [404],
          });
          return response.text();
        },
        {
          operation: 'billionDollarDisasters.download',
          context: retryCtx,
          baseDelayMs: 1000,
          signal: ctx.signal,
        },
      );
    } catch (error) {
      // NCEI answers an unpublished scope with a 404 HTML page. The state code
      // is the only thing the caller can change, so it is named rather than the
      // internal URL.
      if (!isMissingUpstreamFile(error)) throw error;
      throw notFound(
        state === undefined
          ? `NCEI is not publishing the national billion-dollar disasters export "${file}" right now.`
          : `NCEI publishes no billion-dollar disasters export for state "${state}". Not every two-letter code has one — American Samoa (AS) and the Northern Mariana Islands (MP) have no export, while the 50 states, DC, PR, VI, and GU do.`,
        { reason: 'unknown_state', sourceFile: file, ...ctx.recoveryFor('unknown_state') },
        { cause: error },
      );
    }

    const parsed = parseExport(file, text, ctx);
    this.exports.delete(file);
    this.exports.set(file, { parsed, fetchedAtMs: Date.now() });
    while (this.exports.size > MAX_CACHED_FILES) {
      const oldest = this.exports.keys().next().value;
      if (oldest === undefined) break;
      this.exports.delete(oldest);
    }
    return parsed;
  }
}

/** The export filename for a scope — national when no state code is given. */
function exportName(kind: 'events' | 'time-series', state: string | undefined): string {
  return `${kind}-${state === undefined ? 'US' : state.trim().toUpperCase()}.csv`;
}

/** Whether a string is shaped like the postal code the per-state exports are named by. */
export function isStateCodeShape(value: string): boolean {
  return STATE_CODE_PATTERN.test(value.trim());
}

/**
 * Split an export into its declared unit, its header, and its rows.
 *
 * Both files open with lines that are not data and not the header — a title and
 * a unit note on `events-*.csv`, two `#` comments and a blank line on
 * `time-series-*.csv`. Feeding row 1 to a CSV reader as the header silently
 * mis-keys every column, so the header is found by name and everything above it
 * is read only for the unit.
 */
function parseExport(sourceFile: string, text: string, ctx: Context): ParsedExport {
  const reader = new CsvStreamReader();
  const records = [...reader.push(text), ...reader.end()];

  const headerIndex = records.findIndex(
    (record) => record[0]?.trim() === 'Name' || record[0]?.trim() === 'State',
  );
  if (headerIndex === -1) {
    throw serializationError(
      `Billion-dollar disasters export ${sourceFile} has no recognizable header row — the export changed shape.`,
      { reason: 'malformed_export', sourceFile, ...ctx.recoveryFor('malformed_export') },
    );
  }

  const preamble = records
    .slice(0, headerIndex)
    .map((record) => record.join(','))
    .join('\n');
  const declaredUnit = DECLARED_UNIT_PATTERN.exec(preamble)?.[1]?.toLowerCase();
  const costMultiplier = declaredUnit ? COST_UNIT_MULTIPLIERS[declaredUnit] : undefined;
  if (!declaredUnit || costMultiplier === undefined) {
    throw serializationError(
      `Billion-dollar disasters export ${sourceFile} does not declare a cost unit this server recognizes. NCEI states the unit in the file's own preamble, and it differs between the per-event and per-year exports, so no default can be assumed.`,
      {
        reason: 'malformed_export',
        sourceFile,
        declaredUnit,
        ...ctx.recoveryFor('malformed_export'),
      },
    );
  }

  const header = (records[headerIndex] as string[]).map((name) => name.trim());
  // A blank line parses to a single empty field; it is not a row.
  const rows = records.slice(headerIndex + 1).filter((record) => record.length > 1);
  if (rows.length === 0) {
    throw serializationError(
      `Billion-dollar disasters export ${sourceFile} carried a header but no rows.`,
      { reason: 'malformed_export', sourceFile, ...ctx.recoveryFor('malformed_export') },
    );
  }

  return { sourceFile, declaredUnit, costMultiplier, header, rows };
}

/** Map header names to column positions, failing loudly if the export changed shape. */
function columnIndex(parsed: ParsedExport, required: string[], ctx: Context): Map<string, number> {
  const column = new Map(parsed.header.map((name, index) => [name, index] as const));
  const missing = required.filter((name) => !column.has(name));
  if (missing.length > 0) {
    throw serializationError(
      `Billion-dollar disasters export ${parsed.sourceFile} is missing expected columns: ${missing.join(', ')}.`,
      {
        reason: 'malformed_export',
        sourceFile: parsed.sourceFile,
        missing,
        ...ctx.recoveryFor('malformed_export'),
      },
    );
  }
  return column;
}

/** What every read reports about the file it came from, including its real year span. */
function describeSource(parsed: ParsedExport, years: number[]) {
  const sorted = [...years].sort((a, b) => a - b);
  return {
    sourceFile: parsed.sourceFile,
    declaredCostUnit: `${parsed.declaredUnit} of dollars`,
    firstYear: sorted[0] ?? 0,
    lastYear: sorted.at(-1) ?? 0,
  };
}

/**
 * Whether a year's reported cost reaches the caller's floor.
 *
 * Compared against the tally the caller asked about — the named disaster class
 * when one was given, the year's `All Disasters` total otherwise. A per-state
 * export carries only a bin, so its upper end is what has to clear the floor: a
 * year whose bin spans the threshold could be above it, and dropping it would
 * hide a real match behind NCEI's own rounding.
 */
function reachesCost(
  tallies: DisasterTypeTally[],
  query: DisasterQuery,
  minCostInUsd: number,
): boolean {
  const target =
    query.disasterType === undefined
      ? tallies.find((tally) => tally.disasterType === ALL_DISASTERS)
      : tallies.find((tally) => tally.disasterType === query.disasterType);
  if (!target) return false;
  const cost = target.costInUsd ?? target.costRangeInUsd?.high;
  return cost !== undefined && cost >= minCostInUsd;
}

// --- Init/accessor pattern ---

let _service: BillionDollarDisastersService | undefined;

export function initBillionDollarDisastersService(): void {
  _service = new BillionDollarDisastersService();
}

export function getBillionDollarDisastersService(): BillionDollarDisastersService {
  if (!_service) {
    throw new Error(
      'BillionDollarDisastersService not initialized — call initBillionDollarDisastersService() in setup()',
    );
  }
  return _service;
}
