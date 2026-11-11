/**
 * @fileoverview Search the NCEI Storm Events Database — severe-weather events
 * with magnitude, casualty, damage, and narrative detail — for one calendar year.
 * @module mcp-server/tools/definitions/noaa-climate-search-storm-events
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  applyPageLimit,
  identifierFilter,
  pageLimitSchema,
  searchTextFilter,
} from '@/mcp-server/tools/definitions/shared/validation.js';
import { getStormEventsService } from '@/services/storm-events/storm-events-service.js';
import type { StormEventsSearchResult } from '@/services/storm-events/types.js';

/** How many candidate values a recovery notice names before it stops listing. */
const NOTICE_SUGGESTION_LIMIT = 12;

/**
 * Five digits, optionally behind the uppercase `FIPS:` a pasted cdoLocationId
 * carries. A case-insensitive prefix would need an `i` flag JSON Schema
 * `pattern` cannot advertise, so the advertised and runtime grammars would part.
 */
const COUNTY_FIPS_PATTERN = /^\s*(?:FIPS:)?\d{5}\s*$/;

/** Why a countyFips search can come back empty while the county had events. */
const COUNTY_COVERAGE_NOTE =
  'Only county rows (countyOrZoneType "C") outside Alaska and the territories carry county FIPS, so countyFips never matches an event NCEI filed under a forecast or marine zone; drop countyFips and filter by state to see those.';

const damageSchema = z
  .object({
    raw: z
      .string()
      .describe('The upstream cell verbatim, e.g. "0.00K", "1.20M", "1.00B" — never rewritten.'),
    amountInUsd: z
      .number()
      .optional()
      .describe(
        'Dollar value parsed from raw. Omitted when the cell did not parse (the live files carry a few malformed cells such as a bare "K"); the raw text is still returned.',
      ),
  })
  .describe(
    'A reported damage figure. The whole field is omitted when NCEI reported nothing — absent means "not reported", which is not the same as a reported "0.00K".',
  );

/**
 * Case-insensitive near matches from a known value set, for a zero-match notice.
 *
 * Containment is checked both ways. Forward alone ("Flash Flood" contains
 * "flood") misses every needle longer than the label it meant — "tornados"
 * never reaches "Tornado" — which is the exact miss this notice exists to
 * catch, so the reverse direction carries the plurals and trailing words.
 */
function suggest(candidates: string[], needle: string): string[] {
  const lowered = needle.trim().toLowerCase();
  return candidates
    .filter((c) => {
      const candidate = c.toLowerCase();
      return candidate.includes(lowered) || lowered.includes(candidate);
    })
    .slice(0, NOTICE_SUGGESTION_LIMIT);
}

/** Whether a value set already carries the caller's value, matched as the service matches it. */
function carriesValue(values: string[], needle: string): boolean {
  const lowered = needle.trim().toLowerCase();
  return values.some((value) => value.toLowerCase() === lowered);
}

export const noaaClimateSearchStormEvents = tool('noaa_climate_search_storm_events', {
  title: 'Search NOAA Storm Events',
  description:
    'Search the NCEI Storm Events Database for one calendar year — tornadoes, hail, floods, hurricanes, winter storms, heat, and every other NWS Storm Data event type, with magnitude, direct and indirect casualties, property and crop damage, and narratives. This corpus carries discrete severe-weather events rather than CDO station observations, needs no token, and publishes one bulk file per year, so year is required. Filter by episodeId from a returned event, state (full NCEI name such as "FLORIDA", not "FL"), countyFips (five-digit county FIPS such as "53043", county rows only), eventType (exact NWS label such as "Tornado", "Flash Flood", or "Hurricane (Typhoon)", case-insensitive), begin month, inclusive local-calendar startDate/endDate overlap, and minDamageInUsd. County rows outside Alaska and the territories carry cdoLocationId (e.g. "FIPS:53043"), the locationId noaa_climate_find_stations and noaa_climate_fetch_data take; events also carry stateFips and czFips codes, the NWS forecast office (wfo), beginLocation, and end coordinates when NCEI filled them. Date bounds exclude missing, invalid, or reversed source spans before damage accounting, totals, and paging; cross-year bounds still search only the selected year export. Damage retains its raw magnitude-suffixed cell and parsed dollar amount; unreported figures are omitted, and minDamageInUsd discloses how many unknown figures it excluded. Events reference distinct page-local episodeNarratives by episodeNarrativeRef; eventNarrative stays on each event, and rendered narratives preserve literal source text. Optional local ISO beginDate/endDate values can feed CDO date filters; raw NCEI date-time and timezone remain available. Source row order, limit/offset pagination, and filtered totalCount are preserved; appliedDateRange echoes supplied bounds.',
  annotations: { readOnlyHint: true, openWorldHint: true },

  input: z.object({
    episodeId: z
      .string()
      .regex(/^\s*(?:\d+\s*)?$/, 'Episode ID must contain only digits, or be blank.')
      .optional()
      .describe(
        'Exact EPISODE_ID from a returned event. Surrounding whitespace is trimmed; blank means no filter. Leading zeros are significant. Keep year supplied.',
      ),
    year: z
      .number()
      .int()
      .min(1950)
      .describe(
        'Calendar year to search (1950 through the current partial year). Required — NCEI publishes one file per year, so an unscoped search would download every year back to 1950.',
      ),
    state: identifierFilter(
      'Filter to this state or territory, written as the full name NCEI uses (e.g. "FLORIDA", "PUERTO RICO"), matched case-insensitively. Postal codes like "FL" match nothing. Optional.',
    ).optional(),
    countyFips: z
      .string()
      .regex(
        COUNTY_FIPS_PATTERN,
        'County FIPS must be five digits (two-digit state, three-digit county), optionally prefixed "FIPS:".',
      )
      .optional()
      .describe(
        'Filter to one county by its five-digit Census FIPS code, state then county (e.g. "53043" for Lincoln County, WA), or by a returned cdoLocationId ("FIPS:53043"). Surrounding whitespace is trimmed; leading zeros are significant. Matches exactly the events whose cdoLocationId it names, so county rows outside Alaska and the territories only: an event NCEI filed under a forecast or marine zone never matches. Optional.',
      ),
    eventType: searchTextFilter(
      'Filter to this NWS event type, matched case-insensitively against the exact label (e.g. "Tornado", "Hail", "Flash Flood", "Hurricane (Typhoon)"). A miss returns the labels present in that year. Optional.',
    ).optional(),
    month: z
      .number()
      .int()
      .min(1)
      .max(12)
      .optional()
      .describe('Filter to events whose begin date falls in this month (1–12). Optional.'),
    startDate: z.iso
      .date()
      .optional()
      .describe(
        'Inclusive local-calendar lower bound (YYYY-MM-DD): an event must end on or after this date. Rows without both valid ordered endpoints are excluded. Only the selected year export is searched.',
      ),
    endDate: z.iso
      .date()
      .optional()
      .describe(
        'Inclusive local-calendar upper bound (YYYY-MM-DD): an event must begin on or before this date. Rows without both valid ordered endpoints are excluded. Cross-year intervals are allowed; only year selects the export.',
      ),
    minDamageInUsd: z
      .number()
      .min(0)
      .optional()
      .describe(
        'Filter to events whose property damage parses to at least this many dollars. Excludes every row whose damage NCEI did not report — about a fifth of a recent year — since an unreported figure cannot be shown to clear the threshold. Optional.',
      ),
    limit: pageLimitSchema(100)
      .default(10)
      .describe(
        'Maximum events per page (1–100, default 10). Oversized positive integers are clamped to 100 with a notice; NOAA_CLAMP_LIMITS=false restores rejection above 100.',
      ),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe('Zero-based index of the first matching event to return. Defaults to 0.'),
  }),

  output: z.object({
    year: z.number().describe('The calendar year searched.'),
    appliedDateRange: z
      .object({
        startDate: z.iso
          .date()
          .optional()
          .describe('Inclusive lower overlap bound supplied by the caller.'),
        endDate: z.iso
          .date()
          .optional()
          .describe('Inclusive upper overlap bound supplied by the caller.'),
      })
      .optional()
      .describe(
        'The applied inclusive local-calendar overlap interval. Omitted when neither bound was supplied; year still selects one export.',
      ),
    sourceFile: z
      .string()
      .describe(
        'The exact NCEI file this page was read from, including its `_c<publishDate>` suffix — the suffix changes whenever NCEI republishes a year.',
      ),
    events: z
      .array(
        z
          .object({
            eventId: z.string().describe('NCEI EVENT_ID — unique within the Storm Events corpus.'),
            episodeId: z
              .string()
              .optional()
              .describe(
                'NCEI EPISODE_ID grouping events from one storm system. Omitted for pre-1996 records, which carry no episode.',
              ),
            eventType: z.string().describe('NWS event type label, e.g. "Tornado", "Hail".'),
            state: z.string().describe('Full upper-case state or territory name, e.g. "FLORIDA".'),
            countyOrZone: z
              .string()
              .optional()
              .describe(
                'County/parish, NWS forecast zone, or marine zone name. Omitted when not provided.',
              ),
            countyOrZoneType: z
              .string()
              .optional()
              .describe(
                'What countyOrZone names: "C" county/parish, "Z" NWS forecast zone, "M" marine zone. Relayed as NCEI wrote it, so a stray value passes through unchanged. Omitted when not provided.',
              ),
            stateFips: z
              .string()
              .optional()
              .describe(
                'NCEI STATE_FIPS zero-padded to two digits, e.g. "53". A Census state code for the 50 states and DC; NCEI writes territories as 96–99 (Puerto Rico is 99) and marine areas as 81–95. Omitted when blank.',
              ),
            czFips: z
              .string()
              .optional()
              .describe(
                'NCEI CZ_FIPS zero-padded to three digits: the county code on a county row (countyOrZoneType "C"), an NWS zone number on any other row. Omitted when blank.',
              ),
            cdoLocationId: z
              .string()
              .optional()
              .describe(
                'CDO county location ID composed from stateFips and czFips, e.g. "FIPS:53043": pass it as locationId to noaa_climate_find_stations or noaa_climate_fetch_data, or as countyFips here. Present only on county rows in DC and every state but Alaska. Zone and marine rows, Alaska (whose county rows carry NWS zone numbers), and the territories carry none. CDO’s county catalog can lag Census changes (the export writes Oglala Lakota County, SD as 46102, which CDO still lists as Shannon County, 46113), so when it returns no stations, search stations by extent around the event coordinates.',
              ),
            wfo: z
              .string()
              .optional()
              .describe(
                'NWS Weather Forecast Office whose warning area the event occurred in, e.g. "OTX". Omitted when blank.',
              ),
            beginDateTime: z
              .string()
              .describe('Event start as NCEI writes it, e.g. "30-APR-24 20:33:00".'),
            endDateTime: z.string().optional().describe('Event end. Omitted when not provided.'),
            beginDate: z
              .string()
              .optional()
              .describe(
                'Local ISO calendar start date (YYYY-MM-DD), usable with CDO date filters. Omitted when source components are missing or invalid.',
              ),
            endDate: z
              .string()
              .optional()
              .describe(
                'Local ISO calendar end date (YYYY-MM-DD). Omitted when source components are missing or invalid; not a UTC conversion.',
              ),
            timezone: z
              .string()
              .optional()
              .describe('Local time zone of the date fields, e.g. "CST-6". Omitted when absent.'),
            magnitude: z
              .number()
              .optional()
              .describe(
                'Wind speed in knots or hail size in inches, depending on the event type — NCEI populates it only for wind and hail events. Omitted otherwise.',
              ),
            magnitudeType: z
              .string()
              .optional()
              .describe(
                'How a wind magnitude was determined: "EG" estimated gust, "ES" estimated sustained, "MG" measured gust, "MS" measured sustained. Omitted for non-wind events.',
              ),
            torFScale: z
              .string()
              .optional()
              .describe(
                'Tornado intensity — Enhanced Fujita ("EF1", or "EFU" when unrated) from 2007 on, original Fujita ("F3") before that. Omitted for non-tornado events.',
              ),
            torLengthInMiles: z
              .number()
              .optional()
              .describe('Tornado track length in miles. Omitted for non-tornado events.'),
            torWidthInYards: z
              .number()
              .optional()
              .describe('Tornado track width in yards. Omitted for non-tornado events.'),
            injuriesDirect: z
              .number()
              .optional()
              .describe('Injuries caused directly by the event. Omitted when not reported.'),
            injuriesIndirect: z
              .number()
              .optional()
              .describe('Injuries indirectly attributed to the event. Omitted when not reported.'),
            deathsDirect: z
              .number()
              .optional()
              .describe('Deaths caused directly by the event. Omitted when not reported.'),
            deathsIndirect: z
              .number()
              .optional()
              .describe('Deaths indirectly attributed to the event. Omitted when not reported.'),
            damageProperty: damageSchema
              .optional()
              .describe('Property damage. Omitted when NCEI reported no figure.'),
            damageCrops: damageSchema
              .optional()
              .describe('Crop damage. Omitted when NCEI reported no figure.'),
            floodCause: z
              .string()
              .optional()
              .describe('Reported flood cause, e.g. "Heavy Rain". Omitted for non-flood events.'),
            beginLocation: z
              .string()
              .optional()
              .describe(
                'The reference place, usually a town, that NWS measures the event start from. The start usually lies some distance and direction from it, so it is not the start point; beginLatitude/beginLongitude locate the start. Omitted when blank.',
              ),
            beginLatitude: z
              .number()
              .optional()
              .describe('Latitude of the event start in decimal degrees. Omitted when absent.'),
            beginLongitude: z
              .number()
              .optional()
              .describe('Longitude of the event start in decimal degrees. Omitted when absent.'),
            endLatitude: z
              .number()
              .optional()
              .describe(
                'Latitude of the event end in decimal degrees: a tornado’s track end, and the begin point again on most other events. Omitted when absent.',
              ),
            endLongitude: z
              .number()
              .optional()
              .describe(
                'Longitude of the event end in decimal degrees: a tornado’s track end, and the begin point again on most other events. Omitted when absent.',
              ),
            source: z
              .string()
              .optional()
              .describe(
                'Who reported the event, e.g. "ASOS", "Trained Spotter". Omitted when absent.',
              ),
            episodeNarrativeRef: z
              .string()
              .optional()
              .describe(
                'Reference to this page’s episodeNarratives text. Omitted when no narrative was reported.',
              ),
            eventNarrative: z
              .string()
              .optional()
              .describe('Narrative for this individual event. Omitted when absent.'),
          })
          .describe('A single storm event.'),
      )
      .describe('Matching events for the requested page, in the source file’s own row order.'),
    episodeNarratives: z
      .array(
        z
          .object({
            ref: z.string().describe('Page-local narrative reference, e.g. n1.'),
            text: z
              .string()
              .describe('Distinct nonblank episode narrative text, preserved from the service.'),
          })
          .describe('One distinct episode narrative on this page.'),
      )
      .describe(
        'Each distinct episode narrative on this page, once; referenced by events[].episodeNarrativeRef.',
      ),
  }),

  enrichment: {
    totalCount: z
      .number()
      .describe('Events matching every filter across the whole year, before offset and limit.'),
    truncated: z
      .boolean()
      .optional()
      .describe('True when more matches exist beyond this page. Omitted otherwise.'),
    shown: z.number().optional().describe('Events returned on this page. Omitted otherwise.'),
    cap: z.number().optional().describe('The limit that was applied. Omitted otherwise.'),
    exhausted: z
      .boolean()
      .optional()
      .describe(
        'True when offset is past the end of a non-empty match set — the page is empty but matches exist. Omitted otherwise.',
      ),
    excludedUnknownDamage: z
      .number()
      .optional()
      .describe(
        'Rows that satisfied every other filter but were dropped by minDamageInUsd because NCEI reported no property-damage figure for them. Omitted when minDamageInUsd was not supplied.',
      ),
    scannedRowCount: z
      .number()
      .optional()
      .describe('Rows read from the source file, matched or not. Omitted when unavailable.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Clamp disclosure and guidance for truncation, no matches, or exhausted pages. Omitted when none applies.',
      ),
  },

  errors: [
    {
      reason: 'invalid_date_range',
      code: JsonRpcErrorCode.ValidationError,
      when: 'startDate is later than endDate.',
      recovery:
        'Set startDate on or before endDate, or omit either bound for a one-sided interval.',
    },
    {
      reason: 'year_unavailable',
      code: JsonRpcErrorCode.NotFound,
      when: 'The NCEI directory listing has no details file for the requested year.',
      recovery:
        'Request a year inside the published range named in the error; the current year appears only after NCEI issues its first batch.',
      thrownBy: 'service',
    },
    {
      reason: 'service_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The NCEI bulk file server would not hand back a usable file: the directory index is unreachable or carried no details files, the year bundle it names is gone, or the downloaded bundle did not decompress.',
      retryable: true,
      recovery:
        'Wait a moment and retry the same year; the NCEI bulk file server may be temporarily unavailable.',
      thrownBy: 'service',
    },
    {
      reason: 'malformed_export',
      code: JsonRpcErrorCode.SerializationError,
      when: 'The year decompressed but is not the expected table — required columns are missing, or the file carried no rows.',
      recovery:
        'The NCEI export changed shape; try another year, and report the file named in the error if every year fails.',
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    if (
      input.startDate !== undefined &&
      input.endDate !== undefined &&
      input.startDate > input.endDate
    ) {
      throw ctx.fail('invalid_date_range', 'startDate must be on or before endDate.');
    }
    const { limit, notice: clampNotice } = applyPageLimit(
      input.limit,
      100,
      'noaa_climate_search_storm_events',
      ctx,
    );
    const notices: string[] = clampNotice ? [clampNotice] : [];
    const episodeId = input.episodeId?.trim();
    const countyFips = input.countyFips?.trim().replace(/^FIPS:/, '');
    ctx.log.info('Searching storm events', {
      year: input.year,
      state: input.state,
      countyFips,
      eventType: input.eventType,
      month: input.month,
    });

    const result = await getStormEventsService().search(
      {
        year: input.year,
        ...(episodeId && { episodeId }),
        ...(input.state !== undefined && { state: input.state }),
        ...(countyFips !== undefined && { countyFips }),
        ...(input.eventType !== undefined && { eventType: input.eventType }),
        ...(input.month !== undefined && { month: input.month }),
        ...(input.startDate !== undefined && { startDate: input.startDate }),
        ...(input.endDate !== undefined && { endDate: input.endDate }),
        ...(input.minDamageInUsd !== undefined && { minDamageInUsd: input.minDamageInUsd }),
        limit,
        offset: input.offset,
      },
      ctx,
    );

    ctx.enrich.total(result.totalCount);
    ctx.enrich({ scannedRowCount: result.scannedRowCount });
    if (input.minDamageInUsd !== undefined) {
      ctx.enrich({ excludedUnknownDamage: result.excludedUnknownDamage });
    }

    if (result.totalCount > 0 && input.offset >= result.totalCount) {
      ctx.enrich({ exhausted: true });
      notices.push(
        `Page is empty because offset ${input.offset} is past the end of ${result.totalCount} matching events in ${input.year}. Lower offset or reset it to 0.`,
      );
    } else if (result.totalCount === 0) {
      notices.push(emptyNotice({ ...input, episodeId, countyFips }, result));
    } else if (result.totalCount > input.offset + result.events.length) {
      const guidance = `Showing events ${input.offset + 1}–${input.offset + result.events.length} of ${result.totalCount} matches in ${input.year}. Raise offset to page forward, or narrow with state, countyFips, eventType, month, startDate, endDate, or minDamageInUsd.`;
      ctx.enrich.truncated({
        shown: result.events.length,
        cap: limit,
        guidance,
      });
      notices.push(guidance);
    }
    if (notices.length > 0) ctx.enrich.notice(notices.join(' '));

    const refs = new Map<string, string>();
    const episodeNarratives: { ref: string; text: string }[] = [];
    const events = result.events.map(({ episodeNarrative, ...event }) => {
      if (!episodeNarrative?.trim()) return event;
      let ref = refs.get(episodeNarrative);
      if (!ref) {
        ref = `n${refs.size + 1}`;
        refs.set(episodeNarrative, ref);
        episodeNarratives.push({ ref, text: episodeNarrative });
      }
      return { ...event, episodeNarrativeRef: ref };
    });
    const appliedDateRange =
      input.startDate !== undefined || input.endDate !== undefined
        ? {
            ...(input.startDate !== undefined && { startDate: input.startDate }),
            ...(input.endDate !== undefined && { endDate: input.endDate }),
          }
        : undefined;
    return {
      year: input.year,
      sourceFile: result.sourceFile,
      events,
      episodeNarratives,
      ...(appliedDateRange && { appliedDateRange }),
    };
  },

  format(result) {
    const lines: string[] = [`**Year:** ${result.year} | **Source file:** ${result.sourceFile}`];
    if (result.appliedDateRange) {
      const { startDate, endDate } = result.appliedDateRange;
      lines.push(
        `**Applied date range (inclusive overlap):** ${startDate ?? 'unbounded start'} – ${endDate ?? 'unbounded end'}`,
      );
    }

    if (result.events.length === 0) {
      lines.push('', '_No records on this page._');
      return [{ type: 'text', text: lines.join('\n') }];
    }

    for (const event of result.events) {
      lines.push('', `## ${event.eventType} — ${event.state} (\`${event.eventId}\`)`);
      if (event.episodeId) lines.push(`**Episode:** ${event.episodeId}`);

      const area: string[] = [];
      if (event.countyOrZone) area.push(event.countyOrZone);
      if (event.countyOrZoneType) area.push(`area type ${event.countyOrZoneType}`);
      if (event.stateFips) area.push(`stateFips ${event.stateFips}`);
      if (event.czFips) area.push(`czFips ${event.czFips}`);
      if (event.cdoLocationId) area.push(`cdoLocationId ${event.cdoLocationId}`);
      if (area.length > 0) lines.push(`**Area:** ${area.join(' | ')}`);
      if (event.wfo) lines.push(`**WFO:** ${event.wfo}`);

      const when = [`**When:** ${event.beginDateTime}`];
      if (event.endDateTime) when.push(`– ${event.endDateTime}`);
      if (event.timezone) when.push(`(${event.timezone})`);
      lines.push(when.join(' '));
      if (event.beginDate) lines.push(`**Begin date (local):** ${event.beginDate}`);
      if (event.endDate) lines.push(`**End date (local):** ${event.endDate}`);

      if (event.magnitude !== undefined) {
        lines.push(`**Magnitude:** ${event.magnitude} (knots for wind, inches for hail)`);
      }
      if (event.magnitudeType) lines.push(`**Magnitude type:** ${event.magnitudeType}`);

      const tornado: string[] = [];
      if (event.torFScale) tornado.push(event.torFScale);
      if (event.torLengthInMiles !== undefined) tornado.push(`${event.torLengthInMiles} mi long`);
      if (event.torWidthInYards !== undefined) tornado.push(`${event.torWidthInYards} yd wide`);
      if (tornado.length > 0) lines.push(`**Tornado:** ${tornado.join(', ')}`);

      lines.push(
        `**Deaths:** ${count(event.deathsDirect)} direct, ${count(event.deathsIndirect)} indirect | **Injuries:** ${count(event.injuriesDirect)} direct, ${count(event.injuriesIndirect)} indirect`,
      );
      lines.push(`**Property damage:** ${renderDamage(event.damageProperty)}`);
      lines.push(`**Crop damage:** ${renderDamage(event.damageCrops)}`);

      if (event.floodCause) lines.push(`**Flood cause:** ${event.floodCause}`);
      if (event.beginLocation) lines.push(`**Begin reference place:** ${event.beginLocation}`);
      if (event.beginLatitude !== undefined || event.beginLongitude !== undefined) {
        lines.push(
          `**Begin coords:** ${event.beginLatitude ?? 'unknown'}, ${event.beginLongitude ?? 'unknown'}`,
        );
      }
      if (event.endLatitude !== undefined || event.endLongitude !== undefined) {
        lines.push(
          `**End coords:** ${event.endLatitude ?? 'unknown'}, ${event.endLongitude ?? 'unknown'}`,
        );
      }
      if (event.source) lines.push(`**Reported by:** ${event.source}`);
      if (event.episodeNarrativeRef)
        lines.push(`**Episode narrative:** ${event.episodeNarrativeRef}`);
      if (event.eventNarrative)
        lines.push(`**Event narrative:** ${literalNarrative(event.eventNarrative)}`);
    }

    for (const narrative of result.episodeNarratives) {
      lines.push('', `**Episode narrative ${narrative.ref}:** ${literalNarrative(narrative.text)}`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});

/** Preserve source punctuation as literal CommonMark text and each source line break. */
function literalNarrative(text: string): string {
  return text.replace(/[!-/:-@[-`{-~\r\n]/g, (character) => {
    if (character === '\n') return '<br>\n';
    // CommonMark normalizes literal carriage returns before parsing.
    if (character === '\r') return '&#13;';
    return `\\${character}`;
  });
}

/** Render a count that NCEI may not have reported at all. */
function count(value: number | undefined): string {
  return value === undefined ? 'not reported' : String(value);
}

/**
 * Render a damage figure so an unreported one can never read as a confirmed
 * zero, on the `content[]` surface as well as in `structuredContent`.
 */
function renderDamage(damage: z.infer<typeof damageSchema> | undefined): string {
  if (!damage) return 'Not reported';
  if (damage.amountInUsd === undefined) {
    return `unparseable upstream value "${damage.raw}"`;
  }
  return `${damage.amountInUsd} USD (reported as "${damage.raw}")`;
}

/** Compose the zero-match notice, naming what the year actually contains. */
function emptyNotice(
  input: {
    year: number;
    episodeId?: string | undefined;
    state?: string | undefined;
    countyFips?: string | undefined;
    eventType?: string | undefined;
    month?: number | undefined;
    startDate?: string | undefined;
    endDate?: string | undefined;
    minDamageInUsd?: number | undefined;
  },
  result: Pick<
    StormEventsSearchResult,
    'eventTypesInYear' | 'statesInYear' | 'excludedUnknownDamage'
  >,
): string {
  const applied: string[] = [];
  if (input.episodeId) applied.push(`episodeId="${input.episodeId}"`);
  if (input.state) applied.push(`state="${input.state}"`);
  if (input.countyFips) applied.push(`countyFips="${input.countyFips}"`);
  if (input.eventType) applied.push(`eventType="${input.eventType}"`);
  if (input.month !== undefined) applied.push(`month=${input.month}`);
  if (input.startDate !== undefined) applied.push(`startDate="${input.startDate}"`);
  if (input.endDate !== undefined) applied.push(`endDate="${input.endDate}"`);
  if (input.minDamageInUsd !== undefined) applied.push(`minDamageInUsd=${input.minDamageInUsd}`);

  const parts = [
    `No storm events in ${input.year} matched${applied.length > 0 ? ` ${applied.join(', ')}` : ''}.`,
  ];

  // A value the year actually carries needs no suggestion: handing the caller
  // their own correct spelling back reads as the diagnosis and buries the
  // filter that really emptied the page.
  const eventTypeMissing =
    input.eventType !== undefined && !carriesValue(result.eventTypesInYear, input.eventType);
  const stateMissing = input.state !== undefined && !carriesValue(result.statesInYear, input.state);

  if (input.eventType && eventTypeMissing) {
    const near = suggest(result.eventTypesInYear, input.eventType);
    parts.push(
      near.length > 0
        ? `eventType is matched exactly — did you mean: ${near.join(', ')}?`
        : `${input.year} carries these event types: ${result.eventTypesInYear.slice(0, NOTICE_SUGGESTION_LIMIT).join(', ')}${result.eventTypesInYear.length > NOTICE_SUGGESTION_LIMIT ? ', …' : ''}.`,
    );
  }

  if (input.state && stateMissing) {
    const near = suggest(result.statesInYear, input.state);
    if (/^[a-z]{2}$/i.test(input.state.trim())) {
      parts.push(
        `state takes the full name NCEI writes, not a postal code — "WA" is "WASHINGTON", "FL" is "FLORIDA".`,
      );
    } else if (near.length > 0) {
      parts.push(`Did you mean: ${near.join(', ')}?`);
    }
  }

  // Every named value exists in the year, so what emptied the page is one of
  // the filters whose reach the year listing cannot show — say which.
  if (!eventTypeMissing && !stateMissing) {
    const present: string[] = [];
    if (input.eventType) present.push(`eventType="${input.eventType}"`);
    if (input.state) present.push(`state="${input.state}"`);

    const narrowing: string[] = [];
    if (input.episodeId) narrowing.push(`episodeId="${input.episodeId}"`);
    if (input.countyFips) narrowing.push(`countyFips="${input.countyFips}"`);
    if (input.month !== undefined) narrowing.push(`month=${input.month}`);
    if (input.startDate !== undefined) narrowing.push(`startDate="${input.startDate}"`);
    if (input.endDate !== undefined) narrowing.push(`endDate="${input.endDate}"`);
    if (input.minDamageInUsd !== undefined)
      narrowing.push(`minDamageInUsd=${input.minDamageInUsd}`);

    if (narrowing.length > 0) {
      const context =
        present.length > 0
          ? `${present.join(' and ')} occur${present.length === 1 ? 's' : ''} in ${input.year}, so `
          : '';
      parts.push(
        `${context}${narrowing.join(' and ')} left nothing — relax ${narrowing.length === 1 ? 'it' : 'them'} first.`,
      );
    }
  }

  if (input.countyFips) parts.push(COUNTY_COVERAGE_NOTE);

  if (input.minDamageInUsd !== undefined && result.excludedUnknownDamage > 0) {
    parts.push(
      `${result.excludedUnknownDamage} rows matched the other filters but were excluded because NCEI reported no property-damage figure for them; drop minDamageInUsd to see them.`,
    );
  }

  return parts.join(' ');
}
