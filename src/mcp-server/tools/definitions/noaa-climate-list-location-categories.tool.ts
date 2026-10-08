/**
 * @fileoverview List the NOAA CDO location categories that scope location search.
 * @module mcp-server/tools/definitions/noaa-list-location-categories
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { isUpstreamTokenRejection } from '@/mcp-server/tools/definitions/shared/upstream-auth.js';
import { upstreamOutageReason } from '@/mcp-server/tools/definitions/shared/upstream-availability.js';
import { getCdoService } from '@/services/cdo/cdo-service.js';
import { resolveCollectionTotal } from '@/services/cdo/pagination.js';

export const noaaClimateListLocationCategories = tool('noaa_climate_list_location_categories', {
  title: 'List NOAA Climate Location Categories',
  description:
    'List the location categories that scope noaa_climate_find_locations — CITY, CLIM_DIV, CLIM_REG, CNTRY, CNTY, HYD_ACC, HYD_CAT, HYD_REG, HYD_SUB, ST, US_TERR, and ZIP. Call this first when you do not know which locationCategoryId to pass, including the hydrological categories needed to reach a basin or region. There are 12 categories in total. This endpoint takes pagination and sort only — NOAA CDO ignores dataset, location, station, and date filters here, so none are offered.',
  annotations: { readOnlyHint: true, openWorldHint: false },
  input: z.object({
    sortField: z.enum(['id', 'name']).optional().describe('Sort results by this field. Optional.'),
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
            id: z
              .string()
              .describe(
                'Location category ID, passed as locationCategoryId to noaa_climate_find_locations (e.g., CITY, ST, HYD_REG).',
              ),
            name: z.string().describe('Human-readable category name.'),
          })
          .describe('A single location category entry.'),
      )
      .describe('Matching location categories.'),
    metadata: z
      .object({
        resultset: z
          .object({
            count: z.number().describe('Total number of matching location categories.'),
            limit: z.number().describe('Page size used for this response.'),
            offset: z
              .number()
              .describe('1-based starting index of this page as returned by the NOAA CDO API.'),
          })
          .describe('Pagination cursor fields for this response.'),
      })
      .optional()
      .describe('Pagination metadata. Present when the API returns it.'),
  }),

  enrichment: {
    totalCount: z.number().describe('Total number of location categories before the page limit.'),
    exhausted: z
      .boolean()
      .optional()
      .describe(
        'True when the requested offset is past the end of a non-empty result set — the page is empty but matches exist. Omitted otherwise.',
      ),
    notice: z
      .string()
      .optional()
      .describe('Guidance when no location categories were returned. Omitted otherwise.'),
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
      when: 'A pagination or sort parameter is not recognized by the NOAA CDO API.',
      recovery: 'Reset limit and offset to their defaults, then retry without a sort field.',
    },
  ],

  async handler(input, ctx) {
    ctx.log.info('Listing location categories', { limit: input.limit, offset: input.offset });

    const service = getCdoService();
    const params = {
      sortfield: input.sortField,
      sortorder: input.sortOrder,
      limit: input.limit,
      offset: input.offset,
    };
    let response: Awaited<ReturnType<typeof service.listLocationCategories>>;
    try {
      response = await service.listLocationCategories(params, ctx);
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

    const results = response.results ?? [];
    const { totalCount, exhausted } = await resolveCollectionTotal(
      response,
      params,
      ctx,
      (probeParams, probeCtx) => service.listLocationCategories(probeParams, probeCtx),
    );
    ctx.enrich.total(totalCount);
    // ctx.enrich.notice is last-wins — exactly one of these branches may fire.
    if (exhausted) {
      ctx.enrich({ exhausted: true });
      ctx.enrich.notice(
        `Page is empty because offset ${input.offset} is past the end of ${totalCount} location categories. Lower offset or reset it to 0.`,
      );
    } else if (results.length === 0) {
      ctx.enrich.notice(
        'No location categories were returned. This endpoint takes no filters, so retry with limit and offset at their defaults.',
      );
    }

    return {
      results,
      metadata: response.metadata,
    };
  },

  format(result) {
    const lines: string[] = [];
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
    for (const cat of result.results) {
      lines.push(`- **\`${cat.id}\`** — ${cat.name}`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
