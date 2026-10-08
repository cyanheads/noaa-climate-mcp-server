/**
 * @fileoverview Search for NOAA CDO geographic locations by category.
 * @module mcp-server/tools/definitions/noaa-find-locations
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { isUpstreamTokenRejection } from '@/mcp-server/tools/definitions/shared/upstream-auth.js';
import { upstreamOutageReason } from '@/mcp-server/tools/definitions/shared/upstream-availability.js';
import {
  identifierFilter,
  isoDateFilter,
  searchTextFilter,
  toCdoWireDate,
} from '@/mcp-server/tools/definitions/shared/validation.js';
import { getCdoService } from '@/services/cdo/cdo-service.js';
import { resolveCollectionTotal } from '@/services/cdo/pagination.js';
import type { CdoLocation } from '@/services/cdo/types.js';

/** Page size used to enumerate a category before applying `nameContains`. */
const ENUMERATION_PAGE_SIZE = 1000;

/**
 * Pages the handler will spend enumerating one category.
 *
 * CDO rate-limits a token to 5 requests per second and answers HTTP 429 past
 * that, so four is the largest burst that fits inside one second without pacing
 * the loop.
 */
const MAX_ENUMERATION_PAGES = 4;

/**
 * Largest category `nameContains` will enumerate.
 *
 * CDO exposes no name parameter, so a name search has to be synthesized from a
 * complete client-side enumeration — filtering a single upstream page would
 * make the reported total a lie about matches elsewhere in the category. The
 * bound is a live count, never a hardcoded category list: HYD_CAT (2,111) is
 * larger than CITY (1,989), so a name-based allowlist gets it wrong. Four pages
 * admits CNTY (3,178) — which a datasetId filter already brought under a
 * narrower bound, so refusing the unfiltered call read as arbitrary — and lands
 * in the 9.6x gap before ZIP (30,415), the 31-page category the bound exists to
 * refuse.
 */
const MAX_ENUMERABLE_CATEGORY = ENUMERATION_PAGE_SIZE * MAX_ENUMERATION_PAGES;

export const noaaClimateFindLocations = tool('noaa_climate_find_locations', {
  title: 'Find NOAA Climate Locations',
  description:
    'Search for geographic locations by category (CITY, ST, CNTY, CNTRY, ZIP, CLIM_REG, etc.). Returns location IDs used in station search and data queries. Without locationCategoryId, returns all location types; noaa_climate_list_location_categories lists the valid values. Use locationCategoryId=ST to list US states (51 entries — small enough to retrieve completely). To find a location by name, pass nameContains alongside locationCategoryId — the CDO API has no name parameter, so this server enumerates the category and matches the substring itself. It works for any category under the size limit stated on nameContains, which is every category except ZIP; a datasetId or datacategoryId filter can bring a category back under that limit. For a category still too large, sort alphabetically with sortField=name and page through results. Location IDs: states as FIPS:37 (NC), cities as CITY:US530018 (Seattle), zip codes as ZIP:98101, countries as FIPS:US. Obtain location IDs here, then pass them to noaa_climate_find_stations or noaa_climate_fetch_data.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    locationCategoryId: identifierFilter(
      'Category filter. Use ST for states (51 entries), CNTY for counties, CITY for cities (large set — thousands of entries), CNTRY for countries, ZIP for zip codes, US_TERR for US territories, CLIM_REG for NOAA climate regions, CLIM_DIV for climate divisions, HYD_ACC/HYD_CAT/HYD_REG/HYD_SUB for hydrological categories. Call noaa_climate_list_location_categories when you do not know which category to use — it returns the authoritative set. Optional — omit to return all location types.',
    ).optional(),
    nameContains: searchTextFilter(
      `Case-insensitive substring match on the location name. The CDO API has no name parameter, so this server applies the match itself, across the whole category rather than one page — which bounds it to a category holding at most ${MAX_ENUMERABLE_CATEGORY} locations. Requires locationCategoryId; adding datasetId or datacategoryId narrows a category that is otherwise too large. Example: locationCategoryId="CITY" with nameContains="seattle". Optional.`,
    ).optional(),
    datasetId: identifierFilter(
      'Filter to locations covered by this dataset (e.g., "GHCND"). Optional.',
    ).optional(),
    datacategoryId: identifierFilter(
      'Filter to locations with this data category (e.g., "TEMP"). Optional.',
    ).optional(),
    startDate: isoDateFilter(
      'Filter to locations with data on or after this ISO date (YYYY-MM-DD). Optional.',
    ).optional(),
    endDate: isoDateFilter(
      'Filter to locations with data on or before this ISO date (YYYY-MM-DD). Optional.',
    ).optional(),
    sortField: z
      .enum(['id', 'name', 'mindate', 'maxdate', 'datacoverage'])
      .optional()
      .describe(
        'Sort results by this field. Use name with sortOrder=asc to browse alphabetically when searching for a specific city or location name. Optional.',
      ),
    sortOrder: z
      .enum(['asc', 'desc'])
      .optional()
      .describe('Sort direction. Optional; defaults to asc.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .default(25)
      .describe('Maximum number of results to return (1–1000). Defaults to 25.'),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe('Zero-based index of the first result to return for pagination. Defaults to 0.'),
  }),
  output: z.object({
    results: z
      .array(
        z
          .object({
            id: z.string().describe('Location ID (e.g., FIPS:37, CITY:US530018, ZIP:98101).'),
            name: z.string().describe('Human-readable location name.'),
            datacoverage: z
              .number()
              .optional()
              .describe('Fractional data coverage (0–1). Omitted when not provided by the API.'),
            mindate: z
              .string()
              .optional()
              .describe(
                'Earliest date data is available for this location. Omitted when not provided.',
              ),
            maxdate: z
              .string()
              .optional()
              .describe(
                'Latest date data is available for this location. Omitted when not provided.',
              ),
          })
          .describe('A single location entry.'),
      )
      .describe('Matching locations.'),
    appliedNameFilter: z
      .string()
      .optional()
      .describe(
        'The nameContains value this response was filtered by. Present only when nameContains was supplied; every count below then describes the filtered set, not the whole category.',
      ),
    metadata: z
      .object({
        resultset: z
          .object({
            count: z
              .number()
              .describe(
                'Total number of matching locations — the post-filter match count when appliedNameFilter is present.',
              ),
            limit: z.number().describe('Page size used for this response.'),
            offset: z
              .number()
              .describe(
                'Starting index of this page: 1-based as returned by the NOAA CDO API, or the zero-based offset you supplied when appliedNameFilter is present.',
              ),
          })
          .describe('Pagination cursor fields for this response.'),
      })
      .optional()
      .describe('Pagination metadata. Present when the API returns it.'),
  }),

  enrichment: {
    totalCount: z.number().describe('Total number of matching locations before the page limit.'),
    exhausted: z
      .boolean()
      .optional()
      .describe(
        'True when the requested offset is past the end of a non-empty result set — the page is empty but matches exist. Omitted otherwise.',
      ),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when no locations matched — echoes applied filters and suggests how to broaden.',
      ),
  },

  errors: [
    {
      reason: 'service_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'NOAA CDO API is unreachable or returning errors.',
      retryable: true,
      recovery: 'Wait a moment and retry; NOAA CDO may be temporarily unavailable.',
    },
    {
      reason: 'rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: 'NOAA CDO throttled the request — the configured token went over its rate limit.',
      retryable: true,
      recovery:
        'Space the calls out — NOAA CDO allows 5 requests per second per token, so several climate tools running concurrently is the usual cause. Pause a second, drop the concurrency, then retry.',
    },
    {
      reason: 'upstream_auth_failed',
      code: JsonRpcErrorCode.ConfigurationError,
      when: 'NOAA CDO rejected the API token this server is configured with.',
      recovery:
        'The inputs are not at fault — this deployment’s NOAA_CDO_TOKEN is missing or no longer valid. Set it to a working token (free at https://www.ncdc.noaa.gov/cdo-web/token) and restart the server; every retry fails identically until then.',
    },
    {
      reason: 'validation_error',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A filter parameter is not recognized by the NOAA CDO API (e.g., unknown datacategoryId or datasetId).',
      recovery:
        'Verify filter IDs — use noaa_climate_list_data_categories to list valid datacategoryId values and noaa_climate_list_datasets to list valid datasetId values.',
    },
    {
      reason: 'name_filter_requires_category',
      code: JsonRpcErrorCode.ValidationError,
      when: 'nameContains was supplied without a locationCategoryId to scope the enumeration.',
      recovery:
        'Add a locationCategoryId alongside nameContains — noaa_climate_list_location_categories lists the valid values.',
    },
    {
      reason: 'name_filter_category_too_large',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The requested locationCategoryId holds more locations than nameContains can enumerate.',
      recovery:
        'Narrow the category with datasetId or datacategoryId, search a smaller category, or drop nameContains and page through results with sortField=name.',
    },
  ],

  async handler(input, ctx) {
    ctx.log.info('Finding locations', {
      locationCategoryId: input.locationCategoryId,
      datasetId: input.datasetId,
      nameContains: input.nameContains,
    });

    const service = getCdoService();
    const domainParams = {
      locationcategoryid: input.locationCategoryId,
      datasetid: input.datasetId,
      datacategoryid: input.datacategoryId,
      startdate: toCdoWireDate(input.startDate),
      enddate: toCdoWireDate(input.endDate),
      sortfield: input.sortField,
      sortorder: input.sortOrder,
    };

    /**
     * Map an upstream failure onto the declared reason that matches its cause.
     *
     * Every page of an enumeration runs through here, so a category this tool
     * walks in a burst reports a throttled token from whichever page hit the
     * limit rather than from the first one alone.
     */
    const fetchPage = async (limit: number, offset: number) => {
      try {
        return await service.findLocations({ ...domainParams, limit, offset }, ctx);
      } catch (err) {
        if (err instanceof McpError) {
          // Checked ahead of the InvalidParams branch: an unreachable or
          // throttled upstream is not a parameter fault, and its codes never
          // enter that branch anyway.
          const outage = upstreamOutageReason(err);
          if (outage === 'rate_limited') throw ctx.fail('rate_limited', err.message);
          if (outage === 'service_unavailable') throw ctx.fail('service_unavailable', err.message);
          if (err.code === JsonRpcErrorCode.InvalidParams) {
            if (isUpstreamTokenRejection(err)) throw ctx.fail('upstream_auth_failed', err.message);
            throw ctx.fail('validation_error', err.message);
          }
        }
        throw err;
      }
    };

    const toOutput = (loc: CdoLocation) => ({
      id: loc.id,
      name: loc.name,
      ...(typeof loc.datacoverage === 'number' && { datacoverage: loc.datacoverage }),
      ...(loc.mindate && { mindate: loc.mindate }),
      ...(loc.maxdate && { maxdate: loc.maxdate }),
    });

    if (input.nameContains !== undefined) {
      // Cross-field rules live here rather than in a schema .refine(): input
      // parsing runs before ctx exists, so a schema-level rejection arrives as a
      // bare InvalidParams and cannot carry the declared recovery hint.
      if (!input.locationCategoryId) {
        throw ctx.fail(
          'name_filter_requires_category',
          'nameContains needs a locationCategoryId — the name match is applied to one enumerated category, not to every location type.',
        );
      }

      // The first page doubles as the size probe: CDO reports the category's
      // full count in its metadata, so eligibility is decided from a live
      // number rather than from a category name.
      const first = await fetchPage(ENUMERATION_PAGE_SIZE, 0);
      const categoryCount = first.metadata?.resultset.count ?? first.results?.length ?? 0;
      if (categoryCount > MAX_ENUMERABLE_CATEGORY) {
        throw ctx.fail(
          'name_filter_category_too_large',
          `Category "${input.locationCategoryId}" holds ${categoryCount} locations, more than the ${MAX_ENUMERABLE_CATEGORY} nameContains can enumerate.`,
          {
            locationCategoryId: input.locationCategoryId,
            categoryCount,
            maxEnumerable: MAX_ENUMERABLE_CATEGORY,
          },
        );
      }

      const all: CdoLocation[] = [...(first.results ?? [])];
      for (let page = 1; page < MAX_ENUMERATION_PAGES && all.length < categoryCount; page++) {
        const next = await fetchPage(ENUMERATION_PAGE_SIZE, page * ENUMERATION_PAGE_SIZE);
        const batch = next.results ?? [];
        if (batch.length === 0) break;
        all.push(...batch);
      }

      const needle = input.nameContains.toLowerCase();
      const filtered = all.filter((loc) => loc.name.toLowerCase().includes(needle));
      const filteredCount = filtered.length;
      const page = filtered.slice(input.offset, input.offset + input.limit).map(toOutput);

      ctx.enrich.total(filteredCount);
      // ctx.enrich.notice is last-wins — exactly one of these branches may fire.
      if (filteredCount > 0 && input.offset >= filteredCount) {
        ctx.enrich({ exhausted: true });
        ctx.enrich.notice(
          `Page is empty because offset ${input.offset} is past the end of ${filteredCount} locations matching nameContains="${input.nameContains}". Lower offset or reset it to 0.`,
        );
      } else if (filteredCount === 0) {
        ctx.enrich.notice(
          `No locations in category "${input.locationCategoryId}" contain "${input.nameContains}". Try a shorter or differently spelled fragment, or drop nameContains to browse the ${categoryCount} locations in this category.`,
        );
      }

      return {
        results: page,
        appliedNameFilter: input.nameContains,
        // Synthesized from the filtered view. CDO's own echo describes the
        // internal enumeration fetch the caller never made, so relaying it
        // would report a total that is not the one this response answers.
        metadata: {
          resultset: { count: filteredCount, limit: input.limit, offset: input.offset },
        },
      };
    }

    const params = { ...domainParams, limit: input.limit, offset: input.offset };
    const response = await fetchPage(input.limit, input.offset);
    const results = (response.results ?? []).map(toOutput);

    const { totalCount, exhausted } = await resolveCollectionTotal(
      response,
      params,
      ctx,
      (probeParams, probeCtx) => service.findLocations(probeParams, probeCtx),
    );
    ctx.enrich.total(totalCount);
    // ctx.enrich.notice is last-wins — exactly one of these branches may fire.
    if (exhausted) {
      ctx.enrich({ exhausted: true });
      ctx.enrich.notice(
        `Page is empty because offset ${input.offset} is past the end of ${totalCount} matching locations. Lower offset or reset it to 0.`,
      );
    } else if (results.length === 0) {
      const filterHints: string[] = [];
      if (input.locationCategoryId) filterHints.push(`category="${input.locationCategoryId}"`);
      if (input.datasetId) filterHints.push(`datasetId="${input.datasetId}"`);
      const filterStr = filterHints.length > 0 ? ` with ${filterHints.join(', ')}` : '';
      ctx.enrich.notice(
        `No locations matched${filterStr}. Try a different locationCategoryId (e.g., ST, CITY, CNTRY) or remove date range filters.`,
      );
    }

    return {
      results,
      metadata: response.metadata,
    };
  },

  format(result) {
    const lines: string[] = [];
    if (result.appliedNameFilter !== undefined) {
      lines.push(
        `**Name filter:** \`${result.appliedNameFilter}\` — counts below are post-filter.`,
      );
    }
    const meta = result.metadata?.resultset;
    if (meta) {
      lines.push(
        `**Total:** ${meta.count} | **Limit:** ${meta.limit} | **Offset:** ${meta.offset}`,
      );
    }
    if (result.results.length === 0) {
      lines.push('\n_No records on this page._');
      return [{ type: 'text', text: lines.join('\n') }];
    }
    lines.push('');
    for (const loc of result.results) {
      const datePart = loc.mindate && loc.maxdate ? ` | ${loc.mindate} – ${loc.maxdate}` : '';
      const coveragePart =
        typeof loc.datacoverage === 'number'
          ? ` | Coverage: ${(loc.datacoverage * 100).toFixed(0)}%`
          : '';
      lines.push(`- **\`${loc.id}\`** — ${loc.name}${datePart}${coveragePart}`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
