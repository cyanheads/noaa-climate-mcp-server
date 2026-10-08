/**
 * @fileoverview List available NOAA CDO datasets with IDs, names, and temporal coverage.
 * @module mcp-server/tools/definitions/noaa-list-datasets
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { isUpstreamTokenRejection } from '@/mcp-server/tools/definitions/shared/upstream-auth.js';
import { upstreamOutageReason } from '@/mcp-server/tools/definitions/shared/upstream-availability.js';
import {
  identifierArrayFilter,
  identifierFilter,
  isoDateFilter,
  toCdoWireDate,
} from '@/mcp-server/tools/definitions/shared/validation.js';
import { getCdoService } from '@/services/cdo/cdo-service.js';
import { resolveCollectionTotal } from '@/services/cdo/pagination.js';

export const noaaClimateListDatasets = tool('noaa_climate_list_datasets', {
  title: 'List NOAA Climate Datasets',
  description:
    'List available NOAA CDO datasets with their IDs, names, and temporal coverage. Returns all ~11 datasets by default (no required parameters). Optionally filter to datasets that contain a specific data type, cover a location or station, or overlap a date range. Common datasets: GHCND (daily observations, 1763–present), GSOM (monthly summaries), GSOY (annual summaries), NORMAL_DLY/MLY/ANN/HLY (1981–2010 climate normals). Use this first to discover available datasets before calling noaa_climate_fetch_data.',
  annotations: { readOnlyHint: true, openWorldHint: false },
  input: z.object({
    datatypeId: identifierArrayFilter(
      'Filter to datasets containing these data type IDs (e.g., ["TMAX", "PRCP"]). Optional.',
    ).optional(),
    locationId: identifierFilter(
      'Filter to datasets covering this location ID (e.g., "FIPS:37" for NC). Optional.',
    ).optional(),
    stationId: identifierFilter(
      'Filter to datasets covering this station ID (e.g., "GHCND:USW00024233"). Optional.',
    ).optional(),
    startDate: isoDateFilter(
      'Filter to datasets with data on or after this ISO date (YYYY-MM-DD). Optional.',
    ).optional(),
    endDate: isoDateFilter(
      'Filter to datasets with data on or before this ISO date (YYYY-MM-DD). Optional.',
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
            id: z.string().describe('Dataset ID (e.g., GHCND, GSOM, GSOY).'),
            name: z.string().describe('Human-readable dataset name.'),
            datacoverage: z
              .number()
              .describe('Fractional data coverage (0–1). Higher is more complete.'),
            mindate: z.string().describe('Earliest date available in the dataset (YYYY-MM-DD).'),
            maxdate: z.string().describe('Latest date available in the dataset (YYYY-MM-DD).'),
          })
          .describe('A single CDO dataset entry.'),
      )
      .describe('Matching datasets.'),
    metadata: z
      .object({
        resultset: z
          .object({
            count: z.number().describe('Total number of matching datasets.'),
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
    totalCount: z.number().describe('Total number of matching datasets before the page limit.'),
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
        'Guidance when no datasets matched — echoes applied filters and suggests how to broaden.',
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
      when: 'Bad date format or unrecognized filter ID.',
      recovery: 'Check date format (YYYY-MM-DD) and verify filter IDs are valid CDO identifiers.',
    },
  ],

  async handler(input, ctx) {
    ctx.log.info('Listing datasets', {
      datatypeId: input.datatypeId,
      locationId: input.locationId,
      stationId: input.stationId,
    });

    const service = getCdoService();
    const params = {
      datatypeid: input.datatypeId,
      locationid: input.locationId,
      stationid: input.stationId,
      startdate: toCdoWireDate(input.startDate),
      enddate: toCdoWireDate(input.endDate),
      sortfield: input.sortField,
      sortorder: input.sortOrder,
      limit: input.limit,
      offset: input.offset,
    };
    let response: Awaited<ReturnType<typeof service.listDatasets>>;
    try {
      response = await service.listDatasets(params, ctx);
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
      (probeParams, probeCtx) => service.listDatasets(probeParams, probeCtx),
    );
    ctx.enrich.total(totalCount);
    // ctx.enrich.notice is last-wins — exactly one of these branches may fire.
    if (exhausted) {
      ctx.enrich({ exhausted: true });
      ctx.enrich.notice(
        `Page is empty because offset ${input.offset} is past the end of ${totalCount} matching datasets. Lower offset or reset it to 0.`,
      );
    } else if (results.length === 0) {
      ctx.enrich.notice(
        'No datasets matched the applied filters. Try removing datatypeId, locationId, or stationId filters, or broaden the date range.',
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
    for (const ds of result.results) {
      lines.push(`## ${ds.name} (\`${ds.id}\`)`);
      lines.push(
        `**Coverage:** ${(ds.datacoverage * 100).toFixed(0)}% | **Date range:** ${ds.mindate} – ${ds.maxdate}`,
      );
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
