/**
 * @fileoverview List available NOAA CDO datasets with IDs, names, and temporal coverage.
 * @module mcp-server/tools/definitions/noaa-list-datasets
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { isUpstreamTokenRejection } from '@/mcp-server/tools/definitions/shared/upstream-auth.js';
import { upstreamOutageReason } from '@/mcp-server/tools/definitions/shared/upstream-availability.js';
import {
  applyPageLimit,
  identifierArrayFilter,
  identifierFilter,
  isoDateFilter,
  pageLimitSchema,
  toUtcMillis,
} from '@/mcp-server/tools/definitions/shared/validation.js';
import { getCdoService } from '@/services/cdo/cdo-service.js';
import { type CollectionTotal, resolveCollectionTotal } from '@/services/cdo/pagination.js';

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
      'Inclusive lower coverage bound: dataset maxdate must be on or after this date. Applied locally to the complete matching catalog before pagination. Optional.',
    ).optional(),
    endDate: isoDateFilter(
      'Inclusive upper coverage bound: dataset mindate must be on or before this date. Applied locally before pagination. Optional.',
    ).optional(),
    sortField: z
      .enum(['id', 'name', 'mindate', 'maxdate', 'datacoverage'])
      .optional()
      .describe('Sort results by this field. Optional.'),
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
              .describe('Zero-based starting index of this page, echoing the requested offset.'),
          })
          .describe('Pagination cursor fields for this response.'),
      })
      .optional()
      .describe(
        'Pagination metadata. Synthesized for date-filtered views; otherwise present when the API returns it.',
      ),
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
      when: 'Bad date format, startDate after endDate, or unrecognized filter ID.',
      recovery: 'Check date format (YYYY-MM-DD) and verify filter IDs are valid CDO identifiers.',
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
      'noaa_climate_list_datasets',
      ctx,
    );
    const notices: string[] = [];
    if (clampNotice) notices.push(clampNotice);
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
      sortfield: input.sortField,
      sortorder: input.sortOrder,
      limit,
      offset: input.offset,
    };
    let response: Awaited<ReturnType<typeof service.listDatasets>>;
    const filterDates = input.startDate !== undefined || input.endDate !== undefined;
    const catalogCtx = filterDates
      ? { ...ctx, signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(45_000)]) }
      : ctx;
    try {
      response = await service.listDatasets(
        filterDates ? { ...params, limit: 1000, offset: 0 } : params,
        catalogCtx,
      );
      if (filterDates) {
        const all = [...(response.results ?? [])];
        const count = response.metadata?.resultset.count ?? all.length;
        while (all.length < count) {
          catalogCtx.signal.throwIfAborted();
          const page = await service.listDatasets(
            { ...params, limit: 1000, offset: all.length },
            catalogCtx,
          );
          const batch = page.results ?? [];
          if (batch.length === 0) {
            throw ctx.fail(
              'service_unavailable',
              'NOAA CDO returned an incomplete dataset catalog; retry the catalog query.',
            );
          }
          all.push(...batch);
        }
        catalogCtx.signal.throwIfAborted();
        response = { ...response, results: all };
      }
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

    let results = response.results ?? [];
    let totals: CollectionTotal;
    if (filterDates) {
      const start = input.startDate === undefined ? undefined : toUtcMillis(input.startDate);
      const end = input.endDate === undefined ? undefined : toUtcMillis(input.endDate);
      const filtered = results.filter(
        (dataset) =>
          (start === undefined || toUtcMillis(dataset.maxdate) >= start) &&
          (end === undefined || toUtcMillis(dataset.mindate) <= end),
      );
      totals = {
        totalCount: filtered.length,
        exhausted: filtered.length > 0 && input.offset >= filtered.length,
      };
      results = filtered.slice(input.offset, input.offset + limit);
      response = {
        metadata: { resultset: { count: filtered.length, limit, offset: input.offset } },
      };
    } else {
      totals = await resolveCollectionTotal(response, params, ctx, (probeParams, probeCtx) =>
        service.listDatasets(probeParams, probeCtx),
      );
    }
    const { totalCount, exhausted } = totals;
    ctx.enrich.total(totalCount);
    // Compose every notice before the single last-wins enrichment write.
    if (exhausted) {
      ctx.enrich({ exhausted: true });
      notices.push(
        `Page is empty because offset ${input.offset} is past the end of ${totalCount} matching datasets. Lower offset or reset it to 0.`,
      );
    } else if (results.length === 0) {
      notices.push(
        'No datasets matched the applied filters. Try removing datatypeId, locationId, or stationId filters, or broaden the date range.',
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
    for (const ds of result.results) {
      lines.push(`## ${ds.name} (\`${ds.id}\`)`);
      lines.push(
        `**Coverage (0–1):** ${ds.datacoverage} | **Date range:** ${ds.mindate} – ${ds.maxdate}`,
      );
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
