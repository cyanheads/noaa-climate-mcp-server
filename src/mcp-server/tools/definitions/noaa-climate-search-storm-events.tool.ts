/**
 * @fileoverview Search the NCEI Storm Events Database — severe-weather events
 * with magnitude, casualty, damage, and narrative detail — for one calendar year.
 * @module mcp-server/tools/definitions/noaa-climate-search-storm-events
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  identifierFilter,
  searchTextFilter,
} from '@/mcp-server/tools/definitions/shared/validation.js';
import { getStormEventsService } from '@/services/storm-events/storm-events-service.js';
import type { StormEventsSearchResult } from '@/services/storm-events/types.js';

/** How many candidate values a recovery notice names before it stops listing. */
const NOTICE_SUGGESTION_LIMIT = 12;

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
    'Search the NCEI Storm Events Database for one calendar year — tornadoes, hail, floods, hurricanes, winter storms, heat, and every other NWS Storm Data event type, with magnitude, direct and indirect deaths and injuries, property and crop damage, and the episode and event narratives. This is a different NOAA corpus from the CDO tools on this server: it carries discrete severe-weather events rather than station observations, needs no token, and is published as one bulk file per year, so year is required. Filter with state (the full upper-case name NCEI writes, e.g. "FLORIDA" — not the postal code "FL"), eventType (the exact NWS label, e.g. "Tornado", "Hail", "Flash Flood", "Hurricane (Typhoon)", matched case-insensitively), month, and minDamageInUsd. Damage arrives from NCEI as a magnitude-suffixed string ("75.00K", "1.20M", "1.00B") and is returned as both the raw cell and a parsed dollar amount; an unreported figure is omitted entirely rather than reported as zero, and minDamageInUsd therefore excludes those rows and says how many it dropped. Results come back in the source file\'s own row order, paged with limit and offset, and totalCount is the true match count for the whole year.',
  annotations: { readOnlyHint: true, openWorldHint: true },

  input: z.object({
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
    minDamageInUsd: z
      .number()
      .min(0)
      .optional()
      .describe(
        'Filter to events whose property damage parses to at least this many dollars. Excludes every row whose damage NCEI did not report — about a fifth of a recent year — since an unreported figure cannot be shown to clear the threshold. Optional.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(50)
      .describe('Maximum number of events to return (1–100). Defaults to 50.'),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe('Zero-based index of the first matching event to return. Defaults to 0.'),
  }),

  output: z.object({
    year: z.number().describe('The calendar year searched.'),
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
              .describe('County/parish or NWS forecast zone name. Omitted when not provided.'),
            countyOrZoneType: z
              .string()
              .optional()
              .describe(
                'Whether countyOrZone is a county ("C") or an NWS forecast zone ("Z"). Omitted when not provided.',
              ),
            beginDateTime: z
              .string()
              .describe('Event start as NCEI writes it, e.g. "30-APR-24 20:33:00".'),
            endDateTime: z.string().optional().describe('Event end. Omitted when not provided.'),
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
            beginLatitude: z
              .number()
              .optional()
              .describe('Latitude of the event start in decimal degrees. Omitted when absent.'),
            beginLongitude: z
              .number()
              .optional()
              .describe('Longitude of the event start in decimal degrees. Omitted when absent.'),
            source: z
              .string()
              .optional()
              .describe(
                'Who reported the event, e.g. "ASOS", "Trained Spotter". Omitted when absent.',
              ),
            episodeNarrative: z
              .string()
              .optional()
              .describe(
                'Narrative for the whole storm episode, shared by every event in it. Omitted when absent.',
              ),
            eventNarrative: z
              .string()
              .optional()
              .describe('Narrative for this individual event. Omitted when absent.'),
          })
          .describe('A single storm event.'),
      )
      .describe('Matching events for the requested page, in the source file’s own row order.'),
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
      .describe('Guidance when nothing matched or the page ran past the end. Omitted otherwise.'),
  },

  errors: [
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
    ctx.log.info('Searching storm events', {
      year: input.year,
      state: input.state,
      eventType: input.eventType,
      month: input.month,
    });

    const result = await getStormEventsService().search(
      {
        year: input.year,
        ...(input.state !== undefined && { state: input.state }),
        ...(input.eventType !== undefined && { eventType: input.eventType }),
        ...(input.month !== undefined && { month: input.month }),
        ...(input.minDamageInUsd !== undefined && { minDamageInUsd: input.minDamageInUsd }),
        limit: input.limit,
        offset: input.offset,
      },
      ctx,
    );

    ctx.enrich.total(result.totalCount);
    ctx.enrich({ scannedRowCount: result.scannedRowCount });
    if (input.minDamageInUsd !== undefined) {
      ctx.enrich({ excludedUnknownDamage: result.excludedUnknownDamage });
    }

    // Exactly one of these branches may run: ctx.enrich.notice is last-wins, and
    // ctx.enrich.truncated writes a notice of its own.
    if (result.totalCount > 0 && input.offset >= result.totalCount) {
      ctx.enrich({ exhausted: true });
      ctx.enrich.notice(
        `Page is empty because offset ${input.offset} is past the end of ${result.totalCount} matching events in ${input.year}. Lower offset or reset it to 0.`,
      );
    } else if (result.totalCount === 0) {
      ctx.enrich.notice(emptyNotice(input, result));
    } else if (result.totalCount > input.offset + result.events.length) {
      ctx.enrich.truncated({
        shown: result.events.length,
        cap: input.limit,
        guidance: `Showing events ${input.offset + 1}–${input.offset + result.events.length} of ${result.totalCount} matches in ${input.year}. Raise offset to page forward, or narrow with state, eventType, month, or minDamageInUsd.`,
      });
    }

    return { year: input.year, sourceFile: result.sourceFile, events: result.events };
  },

  format(result) {
    const lines: string[] = [`**Year:** ${result.year} | **Source file:** ${result.sourceFile}`];

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
      if (area.length > 0) lines.push(`**Area:** ${area.join(' | ')}`);

      const when = [`**When:** ${event.beginDateTime}`];
      if (event.endDateTime) when.push(`– ${event.endDateTime}`);
      if (event.timezone) when.push(`(${event.timezone})`);
      lines.push(when.join(' '));

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
      if (event.beginLatitude !== undefined || event.beginLongitude !== undefined) {
        lines.push(
          `**Begin coords:** ${event.beginLatitude ?? 'unknown'}, ${event.beginLongitude ?? 'unknown'}`,
        );
      }
      if (event.source) lines.push(`**Reported by:** ${event.source}`);
      if (event.episodeNarrative) lines.push(`**Episode narrative:** ${event.episodeNarrative}`);
      if (event.eventNarrative) lines.push(`**Event narrative:** ${event.eventNarrative}`);
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});

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
    state?: string | undefined;
    eventType?: string | undefined;
    month?: number | undefined;
    minDamageInUsd?: number | undefined;
  },
  result: Pick<
    StormEventsSearchResult,
    'eventTypesInYear' | 'statesInYear' | 'excludedUnknownDamage'
  >,
): string {
  const applied: string[] = [];
  if (input.state) applied.push(`state="${input.state}"`);
  if (input.eventType) applied.push(`eventType="${input.eventType}"`);
  if (input.month !== undefined) applied.push(`month=${input.month}`);
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
    if (input.month !== undefined) narrowing.push(`month=${input.month}`);
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

  if (input.minDamageInUsd !== undefined && result.excludedUnknownDamage > 0) {
    parts.push(
      `${result.excludedUnknownDamage} rows matched the other filters but were excluded because NCEI reported no property-damage figure for them; drop minDamageInUsd to see them.`,
    );
  }

  return parts.join(' ');
}
