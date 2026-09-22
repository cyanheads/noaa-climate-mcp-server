/**
 * @fileoverview Query NOAA's Billion-Dollar Weather and Climate Disasters —
 * the curated, CPI-adjusted record of US disasters that passed $1B in damage.
 * @module mcp-server/tools/definitions/noaa-climate-get-billion-dollar-disasters
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { identifierFilter } from '@/mcp-server/tools/definitions/shared/validation.js';
import {
  getBillionDollarDisastersService,
  isStateCodeShape,
} from '@/services/billion-dollar-disasters/billion-dollar-disasters-service.js';
import { DISASTER_TYPES } from '@/services/billion-dollar-disasters/types.js';

/** The first year NCEI's assessment covers. */
const FIRST_COVERED_YEAR = 1980;

/** Render whole dollars with thousands separators, without depending on locale data. */
function usd(value: number): string {
  return `$${value.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
}

const confidenceBoundsSchema = z
  .object({
    lower75: z
      .number()
      .describe('Lower bound of the 75% confidence interval, in whole US dollars.'),
    upper75: z
      .number()
      .describe('Upper bound of the 75% confidence interval, in whole US dollars.'),
    lower90: z
      .number()
      .describe('Lower bound of the 90% confidence interval, in whole US dollars.'),
    upper90: z
      .number()
      .describe('Upper bound of the 90% confidence interval, in whole US dollars.'),
    lower95: z
      .number()
      .describe('Lower bound of the 95% confidence interval, in whole US dollars.'),
    upper95: z
      .number()
      .describe('Upper bound of the 95% confidence interval, in whole US dollars.'),
  })
  .describe(
    'NCEI’s uncertainty bands around costInUsd, in whole US dollars. Published on the national export only; omitted for a state scope, which reports costRangeInUsd instead.',
  );

export const noaaClimateGetBillionDollarDisasters = tool(
  'noaa_climate_get_billion_dollar_disasters',
  {
    title: 'Get NOAA Billion-Dollar Disasters',
    description:
      'Query NOAA/NCEI’s Billion-Dollar Weather and Climate Disasters — the curated record of US disasters whose damage passed $1 billion, with CPI-adjusted and unadjusted costs, deaths, and one of seven classes (Drought, Flooding, Freeze, Severe Storm, Tropical Cyclone, Wildfire, Winter Storm). Every cost returned is in WHOLE US DOLLARS: NCEI declares a different unit in each export — millions for the per-event file, billions for the national per-year file — and this server converts from whichever unit the file declares, echoing it back as declaredCostUnit. Default calls return individual disasters; summary=true returns per-year counts and costs by class plus an "All Disasters" total. Filter with startYear/endYear (a disaster overlapping either end is included), disasterType (exactly as NCEI writes it, e.g. "Tropical Cyclone"), minCostInUsd, and state (a two-letter US postal code). Coverage runs from 1980 to the last year NCEI has finished assessing — currently 2024, not the current calendar year — and coveredYears reports what the export holds. Under a state scope, per-event rows are national disasters that reached that state and carry the NATIONAL cost, never a state share, so summing states double-counts; per-year rows carry a binned cost range instead of a point estimate. This is a different NOAA corpus from the CDO tools and from noaa_climate_search_storm_events: no token, and the curated set of major disasters rather than every severe-weather event.',
    annotations: { readOnlyHint: true, openWorldHint: true },

    input: z.object({
      startYear: z
        .number()
        .int()
        .min(FIRST_COVERED_YEAR)
        .optional()
        .describe(
          'Earliest year to include (1980 or later). A disaster whose span reaches into the range is included even when it began earlier. Optional — omit for the whole record.',
        ),
      endYear: z
        .number()
        .int()
        .min(FIRST_COVERED_YEAR)
        .optional()
        .describe(
          'Latest year to include (1980 or later). NCEI publishes a year only once its assessment settles, so a year past coveredYears.last returns nothing rather than an error. Optional.',
        ),
      disasterType: z
        .enum(DISASTER_TYPES)
        .optional()
        .describe(
          'Restrict to one NCEI disaster class, written exactly as NCEI writes it. In summary mode this also drops the "All Disasters" total from each year, leaving only the named class. Optional.',
        ),
      state: identifierFilter(
        'Two-letter US postal code (e.g. "CA", "TX", "PR") scoping the query to NCEI’s per-state export instead of the national one. Per-event rows then carry the national cost of each disaster that reached the state, not a state share; per-year rows carry a binned cost range instead of a point estimate. Optional.',
      ).optional(),
      minCostInUsd: z
        .number()
        .min(0)
        .optional()
        .describe(
          'Floor on CPI-adjusted cost in whole US dollars — 1e9 is one billion. In summary mode this is compared against the year’s "All Disasters" total, or against the named disasterType when one is given; where only a binned range exists, the top of the bin has to clear the floor. Optional.',
        ),
      summary: z
        .boolean()
        .default(false)
        .describe(
          'Return per-year counts and costs by disaster class instead of individual disasters. Defaults to false.',
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(50)
        .describe('Maximum number of disasters or years to return (1–100). Defaults to 50.'),
      offset: z
        .number()
        .int()
        .min(0)
        .default(0)
        .describe('Zero-based index of the first matching record to return. Defaults to 0.'),
    }),

    output: z.object({
      mode: z
        .enum(['events', 'summary'])
        .describe(
          'Which shape this response carries: "events" populates disasters, "summary" populates summaries.',
        ),
      scope: z
        .string()
        .describe('"US" for the national record, or the two-letter state code that was requested.'),
      sourceFile: z
        .string()
        .describe('The exact NCEI export this response was read from, e.g. "events-US.csv".'),
      declaredCostUnit: z
        .string()
        .describe(
          'The cost unit this export declares in its own preamble, e.g. "millions of dollars". Every cost below is already in whole US dollars; this names the unit it was converted from.',
        ),
      coveredYears: z
        .object({
          first: z.number().describe('Earliest year present in the export.'),
          last: z
            .number()
            .describe(
              'Latest year present in the export — the last year NCEI has finished assessing, which trails the current calendar year.',
            ),
        })
        .describe('The year span the export actually holds, read from its rows.'),
      costBasis: z
        .literal('national')
        .optional()
        .describe(
          'Present when a state scope is queried in events mode: every cost below is the NATIONAL cost of a disaster that reached the state, not that state’s share of it, so adding states together double-counts. Omitted for the national scope and in summary mode.',
        ),
      disasters: z
        .array(
          z
            .object({
              name: z
                .string()
                .describe('NCEI’s event name, e.g. "Hurricane Helene (September 2024)".'),
              disasterType: z
                .string()
                .describe('One of NCEI’s seven disaster classes, e.g. "Tropical Cyclone".'),
              beginDate: z.string().describe('Event start as an ISO calendar date (YYYY-MM-DD).'),
              endDate: z.string().describe('Event end as an ISO calendar date (YYYY-MM-DD).'),
              cpiAdjustedCostInUsd: z
                .number()
                .describe(
                  'Damage in whole US dollars, adjusted to present-day prices. This is the figure comparable across years.',
                ),
              unadjustedCostInUsd: z
                .number()
                .describe('Damage in whole US dollars of the year the disaster occurred.'),
              deaths: z.number().describe('Deaths NCEI attributes to the disaster.'),
            })
            .describe('A single billion-dollar disaster.'),
        )
        .optional()
        .describe('Individual disasters for the requested page. Present when mode is "events".'),
      summaries: z
        .array(
          z
            .object({
              year: z.number().describe('The calendar year these tallies cover.'),
              byDisasterType: z
                .array(
                  z
                    .object({
                      disasterType: z
                        .string()
                        .describe(
                          'One of the seven disaster classes, or "All Disasters" for the year’s total.',
                        ),
                      eventCount: z
                        .number()
                        .describe('Billion-dollar disasters of this class in the year.'),
                      costInUsd: z
                        .number()
                        .optional()
                        .describe(
                          'CPI-adjusted cost in whole US dollars. Omitted for a state scope, where NCEI publishes costRangeInUsd instead of a point estimate.',
                        ),
                      confidenceBoundsInUsd: confidenceBoundsSchema.optional(),
                      costRangeInUsd: z
                        .object({
                          low: z.number().describe('Bottom of the bin, in whole US dollars.'),
                          high: z.number().describe('Top of the bin, in whole US dollars.'),
                        })
                        .optional()
                        .describe(
                          'The cost bin NCEI publishes for a state scope in place of a point estimate. Omitted on the national export.',
                        ),
                    })
                    .describe('One disaster class’s tally within the year.'),
                )
                .describe(
                  'One entry per class the year’s row carries: the seven disaster classes plus the "All Disasters" total, or only the named class when disasterType was set.',
                ),
            })
            .describe('One year of the per-year record.'),
        )
        .optional()
        .describe('Per-year tallies for the requested page. Present when mode is "summary".'),
    }),

    enrichment: {
      totalCount: z
        .number()
        .describe(
          'Records matching every filter across the whole export, before offset and limit.',
        ),
      truncated: z
        .boolean()
        .optional()
        .describe('True when more matches exist beyond this page. Omitted otherwise.'),
      shown: z.number().optional().describe('Records returned on this page. Omitted otherwise.'),
      cap: z.number().optional().describe('The limit that was applied. Omitted otherwise.'),
      exhausted: z
        .boolean()
        .optional()
        .describe(
          'True when offset is past the end of a non-empty match set — the page is empty but matches exist. Omitted otherwise.',
        ),
      notice: z
        .string()
        .optional()
        .describe('Guidance when nothing matched or the page ran past the end. Omitted otherwise.'),
    },

    errors: [
      {
        reason: 'invalid_state_code',
        code: JsonRpcErrorCode.ValidationError,
        when: 'state was supplied in a form other than a two-letter US postal code.',
        recovery:
          'Pass the two-letter postal code — "CA" for California, "NY" for New York — or omit state for the national record.',
      },
      {
        reason: 'unknown_state',
        code: JsonRpcErrorCode.NotFound,
        when: 'The state code is well formed but NCEI publishes no export under it.',
        recovery:
          'Try another two-letter code or omit state entirely; the 50 states, DC, PR, VI, and GU have exports.',
        thrownBy: 'service',
      },
      {
        reason: 'invalid_year_range',
        code: JsonRpcErrorCode.ValidationError,
        when: 'startYear is later than endYear, so the range can never match a record.',
        recovery: 'Swap the two values so startYear is the earlier one, then retry the query.',
      },
      {
        reason: 'malformed_export',
        code: JsonRpcErrorCode.SerializationError,
        when: 'The export downloaded but is not the expected table — no header row, no rows, missing columns, or no declared cost unit.',
        recovery:
          'The NCEI export changed shape; retry without a state scope, and report the file named in the error if the national export fails too.',
        thrownBy: 'service',
      },
    ],

    async handler(input, ctx) {
      ctx.log.info('Querying billion-dollar disasters', {
        summary: input.summary,
        state: input.state,
        disasterType: input.disasterType,
        startYear: input.startYear,
        endYear: input.endYear,
      });

      // Cross-field and format rules live here rather than in a schema
      // .refine(): input parsing runs before ctx exists, so a schema-level
      // rejection arrives as a bare InvalidParams and cannot carry the declared
      // recovery hint.
      if (input.state !== undefined && !isStateCodeShape(input.state)) {
        throw ctx.fail(
          'invalid_state_code',
          `state "${input.state}" is not a two-letter US postal code. NCEI names its per-state exports by postal code, so a full state name or an abbreviation of another length addresses no export.`,
          { state: input.state, ...ctx.recoveryFor('invalid_state_code') },
        );
      }

      if (
        input.startYear !== undefined &&
        input.endYear !== undefined &&
        input.startYear > input.endYear
      ) {
        throw ctx.fail(
          'invalid_year_range',
          `startYear ${input.startYear} is after endYear ${input.endYear}.`,
          {
            startYear: input.startYear,
            endYear: input.endYear,
            ...ctx.recoveryFor('invalid_year_range'),
          },
        );
      }

      const query = {
        ...(input.state !== undefined && { state: input.state }),
        ...(input.startYear !== undefined && { startYear: input.startYear }),
        ...(input.endYear !== undefined && { endYear: input.endYear }),
        ...(input.disasterType !== undefined && { disasterType: input.disasterType }),
        ...(input.minCostInUsd !== undefined && { minCostInUsd: input.minCostInUsd }),
        limit: input.limit,
        offset: input.offset,
      };

      const service = getBillionDollarDisastersService();
      const scope = input.state === undefined ? 'US' : input.state.trim().toUpperCase();

      const result = input.summary
        ? await service.searchSummaries(query, ctx)
        : await service.searchEvents(query, ctx);
      const shown = 'summaries' in result ? result.summaries.length : result.disasters.length;

      ctx.enrich.total(result.totalCount);

      // Exactly one of these branches may run: ctx.enrich.notice is last-wins,
      // and ctx.enrich.truncated writes a notice of its own.
      if (result.totalCount > 0 && input.offset >= result.totalCount) {
        ctx.enrich({ exhausted: true });
        ctx.enrich.notice(
          `Page is empty because offset ${input.offset} is past the end of ${result.totalCount} matching records in ${result.sourceFile}. Lower offset or reset it to 0.`,
        );
      } else if (result.totalCount === 0) {
        ctx.enrich.notice(emptyNotice(input, result));
      } else if (result.totalCount > input.offset + shown) {
        ctx.enrich.truncated({
          shown,
          cap: input.limit,
          guidance: `Showing records ${input.offset + 1}–${input.offset + shown} of ${result.totalCount} matches in ${result.sourceFile}. Raise offset to page forward, or narrow with startYear/endYear, disasterType, or minCostInUsd.`,
        });
      }

      const source = {
        mode: input.summary ? ('summary' as const) : ('events' as const),
        scope,
        sourceFile: result.sourceFile,
        declaredCostUnit: result.declaredCostUnit,
        coveredYears: { first: result.firstYear, last: result.lastYear },
        // Only the per-event rows carry a national figure under a state scope.
        // The per-year state export publishes that state's own binned range.
        ...(input.state !== undefined && !input.summary && { costBasis: 'national' as const }),
      };

      return 'summaries' in result
        ? { ...source, summaries: result.summaries }
        : { ...source, disasters: result.disasters };
    },

    format(result) {
      const lines: string[] = [
        `**Scope:** ${result.scope} | **Mode:** ${result.mode} | **Source file:** ${result.sourceFile}`,
        `**Coverage:** ${result.coveredYears.first}–${result.coveredYears.last} | **Costs below are whole US dollars,** converted from the ${result.declaredCostUnit} this export declares.`,
      ];

      if (result.costBasis) {
        lines.push(
          `**Cost basis:** ${result.costBasis} — each cost below is the whole disaster's cost across every state it reached, not a ${result.scope} share, so summing states double-counts.`,
        );
      }

      // Exactly one of the two arrays is populated, per mode.
      const records = result.disasters ?? result.summaries;
      if (records?.length === 0) {
        lines.push('', '_No records on this page._');
      }

      for (const disaster of result.disasters ?? []) {
        lines.push('', `## ${disaster.name}`);
        lines.push(
          `**Type:** ${disaster.disasterType} | **When:** ${disaster.beginDate} – ${disaster.endDate}`,
        );
        lines.push(
          `**CPI-adjusted cost:** ${usd(disaster.cpiAdjustedCostInUsd)} USD | **Unadjusted cost:** ${usd(disaster.unadjustedCostInUsd)} USD`,
        );
        lines.push(`**Deaths:** ${disaster.deaths}`);
      }

      for (const summary of result.summaries ?? []) {
        lines.push('', `## ${summary.year}`);
        for (const tally of summary.byDisasterType) {
          const parts = [
            `**${tally.disasterType}:** ${tally.eventCount} ${tally.eventCount === 1 ? 'event' : 'events'}`,
          ];
          if (tally.costInUsd !== undefined) parts.push(`${usd(tally.costInUsd)} USD`);
          if (tally.costRangeInUsd) {
            parts.push(
              `${usd(tally.costRangeInUsd.low)}–${usd(tally.costRangeInUsd.high)} USD (NCEI publishes a range, not a point estimate, at state scope)`,
            );
          }
          if (tally.confidenceBoundsInUsd) {
            const bounds = tally.confidenceBoundsInUsd;
            parts.push(
              `75% ${usd(bounds.lower75)}–${usd(bounds.upper75)}, 90% ${usd(bounds.lower90)}–${usd(bounds.upper90)}, 95% ${usd(bounds.lower95)}–${usd(bounds.upper95)}`,
            );
          }
          lines.push(parts.join(' | '));
        }
      }

      return [{ type: 'text', text: lines.join('\n') }];
    },
  },
);

/** Compose the zero-match notice, naming what the export actually holds. */
function emptyNotice(
  input: {
    startYear?: number | undefined;
    endYear?: number | undefined;
    disasterType?: string | undefined;
    state?: string | undefined;
    minCostInUsd?: number | undefined;
    summary: boolean;
  },
  result: {
    sourceFile: string;
    firstYear: number;
    lastYear: number;
    disasterTypesInFile?: string[] | undefined;
  },
): string {
  const applied: string[] = [];
  if (input.startYear !== undefined) applied.push(`startYear=${input.startYear}`);
  if (input.endYear !== undefined) applied.push(`endYear=${input.endYear}`);
  if (input.disasterType !== undefined) applied.push(`disasterType="${input.disasterType}"`);
  if (input.minCostInUsd !== undefined) applied.push(`minCostInUsd=${input.minCostInUsd}`);

  const parts = [
    `No records in ${result.sourceFile} matched${applied.length > 0 ? ` ${applied.join(', ')}` : ''}.`,
  ];

  // disasterType is an enum, so a misspelling never reaches here — an unmatched
  // class means this export holds no rows of it, and the year range is the
  // wrong thing to widen. Said first, ahead of the coverage span, so the
  // diagnosis leads. The per-year exports carry a column for every class, so
  // the field is absent in summary mode and no sentence is composed.
  const classesInFile = result.disasterTypesInFile;
  if (
    input.disasterType !== undefined &&
    classesInFile !== undefined &&
    classesInFile.length > 0 &&
    !classesInFile.includes(input.disasterType)
  ) {
    parts.push(
      `${result.sourceFile} carries no ${input.disasterType} at all — the classes it holds are ${classesInFile.join(', ')}.`,
    );
  }

  // A range that starts after the export ends is the common miss: NCEI adds a
  // year only once its assessment settles, so "this year" is normally absent.
  if (input.startYear !== undefined && input.startYear > result.lastYear) {
    parts.push(
      `The export covers ${result.firstYear}–${result.lastYear}; startYear=${input.startYear} is past the end of it, because NCEI publishes a year only after finishing its assessment.`,
    );
  } else if (input.endYear !== undefined && input.endYear < result.firstYear) {
    parts.push(
      `The export begins at ${result.firstYear}; endYear=${input.endYear} is earlier than anything it holds.`,
    );
  } else {
    parts.push(`The export covers ${result.firstYear}–${result.lastYear}.`);
  }

  if (input.minCostInUsd !== undefined) {
    parts.push(
      `minCostInUsd is in whole US dollars — ${input.minCostInUsd} is ${usd(input.minCostInUsd)}, so pass 1e9 for one billion rather than 1 or 1000.`,
    );
  }

  if (input.state !== undefined && input.summary) {
    parts.push(
      `A state scope reports binned cost ranges rather than point estimates, so a cost filter is compared against the top of the bin.`,
    );
  }

  return parts.join(' ');
}
