/**
 * @fileoverview List the NOAA CDO location categories that scope location search.
 * @module mcp-server/tools/definitions/noaa-list-location-categories
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { isUpstreamTokenRejection } from '@/mcp-server/tools/definitions/shared/upstream-auth.js';
import { upstreamOutageReason } from '@/mcp-server/tools/definitions/shared/upstream-availability.js';
import {
  applyPageLimit,
  pageLimitSchema,
} from '@/mcp-server/tools/definitions/shared/validation.js';
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
    limit: pageLimitSchema(1000)
      .default(25)
      .describe(
        'Maximum number of results to return (1–1000). Defaults to 25. Larger positive integers are clamped to 1000 with a notice unless NOAA_CLAMP_LIMITS=false.',
      ),
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
              .describe('Zero-based starting index of this page, echoing the requested offset.'),
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
      .describe(
        'Page-limit adjustment and empty or exhausted-page guidance. Omitted when no guidance applies.',
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
      when: 'A pagination or sort parameter is not recognized by the NOAA CDO API.',
      recovery: 'Reset limit and offset to their defaults, then retry without a sort field.',
    },
  ],

  async handler(input, ctx) {
    const { limit, notice: clampNotice } = applyPageLimit(
      input.limit,
      1000,
      'noaa_climate_list_location_categories',
      ctx,
    );
    const notices: string[] = [];
    if (clampNotice) notices.push(clampNotice);
    ctx.log.info('Listing location categories', { limit: input.limit, offset: input.offset });

    const service = getCdoService();
    const params = {
      sortfield: input.sortField,
      sortorder: input.sortOrder,
      limit,
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
    // Compose every notice before the single last-wins enrichment write.
    if (exhausted) {
      ctx.enrich({ exhausted: true });
      notices.push(
        `Page is empty because offset ${input.offset} is past the end of ${totalCount} location categories. Lower offset or reset it to 0.`,
      );
    } else if (results.length === 0) {
      notices.push(
        'No location categories were returned. This endpoint takes no filters, so retry with limit and offset at their defaults.',
      );
    }

    if (notices.length > 0) ctx.enrich.notice(notices.join(' '));

    return {
      results,
      ...(response.metadata && {
        metadata: { resultset: { ...response.metadata.resultset, limit, offset: input.offset } },
      }),
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
