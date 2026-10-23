/**
 * @fileoverview Shared input-validation schemas for NOAA CDO date and identifier
 * filters, plus the canonical wire form and UTC normalization every date
 * comparison and outbound request depends on.
 * @module mcp-server/tools/definitions/shared/validation
 */

import { type Context, z } from '@cyanheads/mcp-ts-core';
import { ATTR_MCP_TOOL_NAME, createCounter } from '@cyanheads/mcp-ts-core/utils';
import { getPaginationConfig } from '@/config/server-config.js';

/** A positive integer page size; disabled clamping restores the advertised maximum. */
export function pageLimitSchema(maximum: number) {
  const schema = z.number().int().min(1);
  return getPaginationConfig().clampLimits ? schema : schema.max(maximum);
}

let clampCounter: ReturnType<typeof createCounter> | undefined;

/** Apply the page ceiling and record each clamp; callers compose the notice at their final write. */
export function applyPageLimit(requested: number, maximum: number, toolName: string, ctx: Context) {
  const limit = Math.min(requested, maximum);
  if (requested === limit) return { limit, notice: undefined };
  ctx.log.info('Read page limit clamped', {
    toolName,
    requestedLimit: requested,
    appliedLimit: limit,
  });
  clampCounter ??= createCounter(
    'noaa.pagination.limit_clamped',
    'Read calls with a clamped page limit',
    '{calls}',
  );
  clampCounter.add(1, { [ATTR_MCP_TOOL_NAME]: toolName });
  return {
    limit,
    notice: `Requested limit ${requested} was clamped to ${limit}. Continue paging by increasing offset by the applied limit.`,
  };
}

/**
 * Date forms NOAA CDO accepts: a compact `YYYYMMDD`, a dashed calendar date
 * whose month and day may be unpadded, or a dashed date with a full ISO-8601
 * local time and optional fractional seconds. CDO rejects a `Z` suffix, a UTC
 * offset, and a space separator, so those are excluded deliberately rather than
 * by oversight. A minute-precision time (`T00:00`) is excluded on the same
 * grounds, though only `/data` rejects it — `/locations` and the other
 * collection endpoints answer it with a 200. Second-precision (`T00:00:00`) is
 * equivalent and accepted everywhere, so the schema keeps the stricter rule.
 *
 * CDO's parsers disagree on the other two forms: `/data` rejects a compact
 * `startdate` with a misleading range error and rejects the unpadded dashed
 * form outright, while every other endpoint accepts both. Tools therefore send
 * `toCdoWireDate()` output upstream rather than the caller's raw string, which
 * makes every form advertised here work on every endpoint without a
 * per-endpoint schema variant.
 *
 * Structural bounds (month, day, hour, minute, second ranges) live in the
 * pattern so they reach clients through the advertised JSON Schema; only
 * month-length overflow needs the refinement below.
 */
const ISO_DATE_PATTERN =
  /^(?:\d{4}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])|\d{4}-(?:0?[1-9]|1[0-2])-(?:0?[1-9]|[12]\d|3[01])(?:T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?)?)$/;

/** The compact, separator-free form. */
const COMPACT_DATE_PATTERN = /^\d{8}$/;

/** The dashed form, with the month and day possibly unpadded and an optional time tail. */
const DASHED_DATE_PATTERN = /^(\d{4})-(\d{1,2})-(\d{1,2})(.*)$/;

const DATE_FORMAT_MESSAGE =
  'Date must be YYYY-MM-DD, YYYYMMDD, or YYYY-MM-DDTHH:MM:SS (optionally with fractional seconds). In the dashed form the month and day may be unpadded.';

const CALENDAR_MESSAGE = 'Date is not a real calendar date.';

const BLANK_MESSAGE = 'Identifier must not be empty or whitespace-only.';

const BLANK_TEXT_MESSAGE = 'Search text must not be empty or whitespace-only.';

/** Comma-delimited decimal/scientific coordinates; disjoint digit branches keep matching linear. */
const EXTENT_NUMBER = '[+-]?(?:[0-9]+(?:\\.[0-9]*)?|\\.[0-9]+)(?:[eE][+-]?[0-9]+)?';
const EXTENT_PATTERN = new RegExp(
  `^\\s*${EXTENT_NUMBER}\\s*,\\s*${EXTENT_NUMBER}\\s*,\\s*${EXTENT_NUMBER}\\s*,\\s*${EXTENT_NUMBER}\\s*$`,
);
const EXTENT_MESSAGE =
  'Extent must be minLat,minLon,maxLat,maxLon: four finite decimal or scientific numbers, with latitude between -90 and 90 and longitude between -180 and 180.';

/** Advertise extent syntax and reject nonfinite or geographically invalid coordinates without reordering axes. */
export function extentFilter(description: string) {
  return z
    .string()
    .regex(EXTENT_PATTERN, { error: EXTENT_MESSAGE, abort: true })
    .refine(
      (value) =>
        value.split(',').every((part, index) => {
          const coordinate = Number(part);
          return (
            Number.isFinite(coordinate) && Math.abs(coordinate) <= (index % 2 === 0 ? 90 : 180)
          );
        }),
      EXTENT_MESSAGE,
    )
    .describe(description);
}

/**
 * Rewrite any accepted date form to the canonical zero-padded, dashed one.
 *
 * Every comparison below indexes fixed offsets or hands the value to
 * `Date.parse`, and both read the compact and unpadded forms as garbage —
 * `Date.parse('20240701Z')` is `NaN`, which would make the range and ordering
 * guards evaluate false and stop firing without ever erroring. Normalizing
 * first is what keeps those guards honest for every form the schema admits.
 */
function normalizeCdoDate(value: string): string {
  if (COMPACT_DATE_PATTERN.test(value)) {
    return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
  }
  const [, year = '', month = '', day = '', time = ''] = DASHED_DATE_PATTERN.exec(value) ?? [];
  if (!year) return value;
  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}${time}`;
}

/**
 * Reject day-of-month values the month cannot hold (e.g. 2024-02-30,
 * 2024-06-31). Accepts any form the date pattern admits.
 */
function isRealCalendarDate(value: string): boolean {
  const normalized = normalizeCdoDate(value);
  const year = Number(normalized.slice(0, 4));
  const month = Number(normalized.slice(5, 7));
  const day = Number(normalized.slice(8, 10));
  const utc = new Date(Date.UTC(year, month - 1, day));
  return (
    utc.getUTCFullYear() === year && utc.getUTCMonth() === month - 1 && utc.getUTCDate() === day
  );
}

/**
 * Parse a validated CDO date to epoch milliseconds on a single timeline.
 * Accepts any form the date pattern admits.
 *
 * `new Date()` reads a bare date as UTC midnight but a bare datetime as *local*
 * midnight, so comparing the two forms directly is off by the host's UTC offset.
 * Anchoring both to UTC keeps ordering and range-length checks stable wherever
 * the server runs.
 */
export function toUtcMillis(value: string): number {
  const normalized = normalizeCdoDate(value);
  return Date.parse(normalized.length === 10 ? `${normalized}T00:00:00Z` : `${normalized}Z`);
}

/**
 * The form a validated CDO date takes on the wire: canonical, zero-padded and
 * dashed, with any time-of-day preserved.
 *
 * Every tool forwarding a date filter sends this rather than the caller's raw
 * string. `/data` is stricter than the rest of CDO — it rejects a compact
 * `startdate` and the unpadded dashed form — so relaying the caller's own text
 * makes an advertised input form fail on one endpoint and work on the others.
 * The canonical form is accepted everywhere, which is what makes one schema
 * correct across the whole surface.
 *
 * Takes and returns `undefined` so an optional filter needs no call-site guard.
 */
export function toCdoWireDate(value: string | undefined): string | undefined {
  return value === undefined ? undefined : normalizeCdoDate(value);
}

/**
 * A NOAA CDO date filter — compact date, bare date, or full ISO-8601 datetime.
 *
 * `abort` stops the chain at a shape failure so the calendar refinement never
 * reports on input that never matched the pattern: its verdict would be read
 * off the wrong offsets, and one bad value would draw two messages, the second
 * of them false.
 */
export function isoDateFilter(description: string) {
  return z
    .string()
    .regex(ISO_DATE_PATTERN, { error: DATE_FORMAT_MESSAGE, abort: true })
    .refine(isRealCalendarDate, CALENDAR_MESSAGE)
    .describe(description);
}

/**
 * The single blank-rejection rule every filter below builds on. `min(1)`
 * carries the constraint to clients as JSON Schema `minLength`; the refinement
 * catches whitespace-only input, which `minLength` alone admits. `abort` keeps
 * an empty string from drawing both messages, which carry identical text. The
 * message is a parameter so identifier and search wording stay distinct without
 * the rule itself being restated.
 */
function nonBlank(message: string) {
  return z
    .string()
    .min(1, { error: message, abort: true })
    .refine((v) => v.trim().length > 0, message);
}

/**
 * A scalar CDO identifier filter. Values stay opaque — the check only rejects
 * empty and whitespace-only input, and never trims or rewrites a real ID.
 */
export function identifierFilter(description: string) {
  return nonBlank(BLANK_MESSAGE).describe(description);
}

/**
 * A repeated CDO identifier filter. An empty array and blank entries are both
 * rejected: the service layer drops falsy entries when building the query
 * string, so either one silently widens the query instead of narrowing it.
 */
export function identifierArrayFilter(description: string) {
  return z
    .array(nonBlank(BLANK_MESSAGE))
    .min(1, 'Provide at least one identifier, or omit the filter entirely.')
    .describe(description);
}

/**
 * A client-side free-text filter. Shares the identifier filters' blank
 * rejection — a whitespace-only needle matches every candidate, which widens
 * the result set the caller asked to narrow — but carries search wording rather
 * than identifier wording, and stays untrimmed so leading or trailing spaces
 * remain part of the substring the caller asked for.
 */
export function searchTextFilter(description: string) {
  return nonBlank(BLANK_TEXT_MESSAGE).describe(description);
}
