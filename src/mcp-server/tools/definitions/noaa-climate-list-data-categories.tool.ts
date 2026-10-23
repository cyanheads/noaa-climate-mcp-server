/**
 * @fileoverview List NOAA CDO data categories that group related data types.
 * @module mcp-server/tools/definitions/noaa-list-data-categories
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { isUpstreamTokenRejection } from '@/mcp-server/tools/definitions/shared/upstream-auth.js';
import { upstreamOutageReason } from '@/mcp-server/tools/definitions/shared/upstream-availability.js';
import {
  applyPageLimit,
  identifierFilter,
  isoDateFilter,
  pageLimitSchema,
  toCdoWireDate,
  toUtcMillis,
} from '@/mcp-server/tools/definitions/shared/validation.js';
import { getCdoService } from '@/services/cdo/cdo-service.js';
import { resolveCollectionTotal } from '@/services/cdo/pagination.js';

export const noaaClimateListDataCategories = tool('noaa_climate_list_data_categories', {
  title: 'List NOAA Climate Data Categories',
  description:
    'List data categories that group related data types — Temperature, Precipitation, Wind, Pressure, Sunshine, Sky cover, Weather Type, and more. Use to discover what types of measurements are available before calling noaa_climate_list_data_types. Optionally filter by dataset, location, station, or date range. There are 42 categories in total.',
  annotations: { readOnlyHint: true, openWorldHint: false },
  input: z.object({
    datasetId: identifierFilter(
      'Filter to categories available in this dataset (e.g., "GHCND", "GSOM"). Optional.',
    ).optional(),
    locationId: identifierFilter(
      'Filter to categories available at this location ID. Optional.',
    ).optional(),
    stationId: identifierFilter(
      'Filter to categories available at this station ID. Optional.',
    ).optional(),
    startDate: isoDateFilter(
      'Filter to categories with data on or after this ISO date (YYYY-MM-DD). Optional.',
    ).optional(),
    endDate: isoDateFilter(
      'Filter to categories with data on or before this ISO date (YYYY-MM-DD). Optional.',
    ).optional(),
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
            id: z.string().describe('Data category ID (e.g., TEMP, PRCP, WIND).'),
            name: z.string().describe('Human-readable category name.'),
          })
          .describe('A single data category entry.'),
      )
      .describe('Matching data categories.'),
    metadata: z
      .object({
        resultset: z
          .object({
            count: z.number().describe('Total number of matching categories.'),
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
    totalCount: z
      .number()
      .describe('Total number of matching data categories before the page limit.'),
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
      when: 'startDate is after endDate, or a filter parameter is not recognized by NOAA CDO (e.g., unknown datasetId).',
      recovery:
        'Verify filter IDs — use noaa_climate_list_datasets to list valid datasetId values.',
    },
  ],

  async handler(input, ctx) {
    if (
      input.startDate &&
      input.endDate &&
      toUtcMillis(input.startDate) > toUtcMillis(input.endDate)
    ) {
      throw ctx.fail(
        'validation_error',
        `startDate "${input.startDate}" is after endDate "${input.endDate}".`,
        {
          startDate: input.startDate,
          endDate: input.endDate,
          recovery: { hint: 'Swap the values so startDate is on or before endDate, then retry.' },
        },
      );
    }
    const { limit, notice: clampNotice } = applyPageLimit(
      input.limit,
      1000,
      'noaa_climate_list_data_categories',
      ctx,
    );
    const notices: string[] = [];
    if (clampNotice) notices.push(clampNotice);
    ctx.log.info('Listing data categories', {
      datasetId: input.datasetId,
      locationId: input.locationId,
    });

    const service = getCdoService();
    const params = {
      datasetid: input.datasetId,
      locationid: input.locationId,
      stationid: input.stationId,
      startdate: toCdoWireDate(input.startDate),
      enddate: toCdoWireDate(input.endDate),
      sortfield: input.sortField,
      sortorder: input.sortOrder,
      limit,
      offset: input.offset,
    };
    let response: Awaited<ReturnType<typeof service.listDataCategories>>;
    try {
      response = await service.listDataCategories(params, ctx);
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
      (probeParams, probeCtx) => service.listDataCategories(probeParams, probeCtx),
    );
    ctx.enrich.total(totalCount);
    // Compose every notice before the single last-wins enrichment write.
    if (exhausted) {
      ctx.enrich({ exhausted: true });
      notices.push(
        `Page is empty because offset ${input.offset} is past the end of ${totalCount} matching data categories. Lower offset or reset it to 0.`,
      );
    } else if (results.length === 0) {
      notices.push(
        'No data categories matched the applied filters. Try removing location, station, or date range filters to see all available categories.',
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
