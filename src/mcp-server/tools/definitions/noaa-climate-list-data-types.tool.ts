/**
 * @fileoverview List available NOAA CDO data types (measurement labels) for a dataset or category.
 * @module mcp-server/tools/definitions/noaa-list-data-types
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { isUpstreamTokenRejection } from '@/mcp-server/tools/definitions/shared/upstream-auth.js';
import { upstreamOutageReason } from '@/mcp-server/tools/definitions/shared/upstream-availability.js';
import {
  identifierFilter,
  isoDateFilter,
  toCdoWireDate,
} from '@/mcp-server/tools/definitions/shared/validation.js';
import { getCdoService } from '@/services/cdo/cdo-service.js';
import { resolveCollectionTotal } from '@/services/cdo/pagination.js';

export const noaaClimateListDataTypes = tool('noaa_climate_list_data_types', {
  title: 'List NOAA Climate Data Types',
  description:
    'List available data types (measurement labels like TMAX, TMIN, PRCP, SNOW) for a given dataset or category. Pass a datasetId to see what is measured in that dataset, or a datacategoryId (e.g., "TEMP") to see all temperature-related types. Hundreds of types exist across all datasets. Use this before calling noaa_climate_fetch_data when the data type IDs are unknown. Common GHCND types: TMAX (max temperature), TMIN (min temperature), PRCP (precipitation), SNOW (snowfall), SNWD (snow depth), AWND (average wind speed).',
  annotations: { readOnlyHint: true, openWorldHint: false },
  input: z.object({
    datasetId: identifierFilter(
      'Filter to data types available in this dataset (e.g., "GHCND", "GSOM"). Optional.',
    ).optional(),
    datacategoryId: identifierFilter(
      'Filter to data types in this category (e.g., "TEMP" for temperature types, "PRCP" for precipitation). Optional.',
    ).optional(),
    locationId: identifierFilter(
      'Filter to data types available at this location ID. Optional.',
    ).optional(),
    stationId: identifierFilter(
      'Filter to data types available at this station ID. Optional.',
    ).optional(),
    startDate: isoDateFilter(
      'Filter to data types with data on or after this ISO date (YYYY-MM-DD). Optional.',
    ).optional(),
    endDate: isoDateFilter(
      'Filter to data types with data on or before this ISO date (YYYY-MM-DD). Optional.',
    ).optional(),
    sortField: z
      .enum(['id', 'name', 'mindate', 'maxdate', 'datacoverage'])
      .optional()
      .describe('Sort results by this field. Optional.'),
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
            id: z.string().describe('Data type ID (e.g., TMAX, TMIN, PRCP).'),
            name: z.string().describe('Human-readable data type name.'),
            datacoverage: z
              .number()
              .optional()
              .describe('Fractional data coverage (0–1). Omitted when not provided by the API.'),
            mindate: z
              .string()
              .optional()
              .describe(
                'Earliest date this data type is available (YYYY-MM-DD). Omitted when not provided.',
              ),
            maxdate: z
              .string()
              .optional()
              .describe(
                'Latest date this data type is available (YYYY-MM-DD). Omitted when not provided.',
              ),
          })
          .describe('A single data type entry.'),
      )
      .describe('Matching data types.'),
    metadata: z
      .object({
        resultset: z
          .object({
            count: z.number().describe('Total number of matching data types.'),
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
    totalCount: z.number().describe('Total number of matching data types before the page limit.'),
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
        'Guidance when no data types matched — echoes applied filters and suggests how to broaden.',
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
  ],

  async handler(input, ctx) {
    ctx.log.info('Listing data types', {
      datasetId: input.datasetId,
      datacategoryId: input.datacategoryId,
    });

    const service = getCdoService();
    const params = {
      datasetid: input.datasetId,
      datacategoryid: input.datacategoryId,
      locationid: input.locationId,
      stationid: input.stationId,
      startdate: toCdoWireDate(input.startDate),
      enddate: toCdoWireDate(input.endDate),
      sortfield: input.sortField,
      sortorder: input.sortOrder,
      limit: input.limit,
      offset: input.offset,
    };
    let response: Awaited<ReturnType<typeof service.listDataTypes>>;
    try {
      response = await service.listDataTypes(params, ctx);
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

    const results = (response.results ?? []).map((dt) => ({
      id: dt.id,
      name: dt.name,
      ...(typeof dt.datacoverage === 'number' && { datacoverage: dt.datacoverage }),
      ...(dt.mindate && { mindate: dt.mindate }),
      ...(dt.maxdate && { maxdate: dt.maxdate }),
    }));

    const { totalCount, exhausted } = await resolveCollectionTotal(
      response,
      params,
      ctx,
      (probeParams, probeCtx) => service.listDataTypes(probeParams, probeCtx),
    );
    ctx.enrich.total(totalCount);
    // ctx.enrich.notice is last-wins — exactly one of these branches may fire.
    if (exhausted) {
      ctx.enrich({ exhausted: true });
      ctx.enrich.notice(
        `Page is empty because offset ${input.offset} is past the end of ${totalCount} matching data types. Lower offset or reset it to 0.`,
      );
    } else if (results.length === 0) {
      const filterHints: string[] = [];
      if (input.datasetId) filterHints.push(`datasetId="${input.datasetId}"`);
      if (input.datacategoryId) filterHints.push(`datacategoryId="${input.datacategoryId}"`);
      const filterStr = filterHints.length > 0 ? ` with ${filterHints.join(', ')}` : '';
      ctx.enrich.notice(
        `No data types matched${filterStr}. Try a different datasetId (e.g., GHCND, GSOM) or datacategoryId (e.g., TEMP, PRCP, WIND).`,
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
    for (const dt of result.results) {
      const coveragePart =
        typeof dt.datacoverage === 'number'
          ? ` | **Coverage:** ${(dt.datacoverage * 100).toFixed(0)}%`
          : '';
      const datePart =
        dt.mindate && dt.maxdate ? ` | **Range:** ${dt.mindate} – ${dt.maxdate}` : '';
      lines.push(`- **\`${dt.id}\`** — ${dt.name}${coveragePart}${datePart}`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
