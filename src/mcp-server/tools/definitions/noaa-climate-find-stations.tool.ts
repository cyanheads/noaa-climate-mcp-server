/**
 * @fileoverview Search for NOAA CDO weather stations by location, bounding box, dataset, and data type.
 * @module mcp-server/tools/definitions/noaa-find-stations
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

export const noaaClimateFindStations = tool('noaa_climate_find_stations', {
  title: 'Find NOAA Climate Stations',
  description:
    'Search for weather observation stations by location, bounding box, dataset, and data type. Returns station IDs, names, coordinates, elevation, and data coverage dates. Filter by locationId (e.g., "FIPS:37" for all NC stations), extent (lat/lon bounding box), datasetId, datatypeId, and date range. Station IDs returned here are used as stationId in noaa_climate_fetch_data. A station must have data for the dataset and date range you want — filter by datasetId and startDate/endDate to ensure compatibility. Common station ID formats: GHCND:USW00024233, COOP:010008.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    locationId: identifierFilter(
      'Filter to stations within this location ID (e.g., "FIPS:37" for NC, "CITY:US530018" for Seattle). Obtain from noaa_climate_find_locations. Optional.',
    ).optional(),
    extent: identifierFilter(
      'Bounding box filter as "minLat,minLon,maxLat,maxLon" (e.g., "47.5,-122.4,47.7,-122.1" for central Seattle). Optional.',
    ).optional(),
    datasetId: identifierFilter(
      'Filter to stations that have data in this dataset (e.g., "GHCND" for daily observations). Optional.',
    ).optional(),
    datatypeId: identifierArrayFilter(
      'Filter to stations that record these data types (e.g., ["TMAX", "TMIN", "PRCP"]). Optional.',
    ).optional(),
    datacategoryId: identifierFilter(
      'Filter to stations with data in this category (e.g., "TEMP"). Optional.',
    ).optional(),
    startDate: isoDateFilter(
      'Filter to stations with data on or after this ISO date (YYYY-MM-DD). Optional.',
    ).optional(),
    endDate: isoDateFilter(
      'Filter to stations with data on or before this ISO date (YYYY-MM-DD). Optional.',
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
            id: z.string().describe('Station ID (e.g., GHCND:USW00024233, COOP:010008).'),
            name: z.string().describe('Station name.'),
            latitude: z
              .number()
              .optional()
              .describe('Station latitude in decimal degrees. Omitted when not provided.'),
            longitude: z
              .number()
              .optional()
              .describe('Station longitude in decimal degrees. Omitted when not provided.'),
            elevation: z
              .number()
              .optional()
              .describe(
                'Station elevation. Unit depends on elevationUnit. Omitted when not provided.',
              ),
            elevationUnit: z
              .string()
              .optional()
              .describe('Unit for elevation (e.g., "Meters"). Omitted when not provided.'),
            mindate: z
              .string()
              .optional()
              .describe(
                'Earliest date data is available at this station. Omitted when not provided.',
              ),
            maxdate: z
              .string()
              .optional()
              .describe(
                'Latest date data is available at this station. Omitted when not provided.',
              ),
            datacoverage: z
              .number()
              .optional()
              .describe('Fractional data coverage (0–1). Omitted when not provided.'),
          })
          .describe('A single station entry.'),
      )
      .describe('Matching stations.'),
    metadata: z
      .object({
        resultset: z
          .object({
            count: z.number().describe('Total number of matching stations.'),
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
    totalCount: z.number().describe('Total number of matching stations before the page limit.'),
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
        'Guidance when no stations matched — echoes applied filters and suggests how to broaden.',
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
      when: 'A filter parameter is not recognized by the NOAA CDO API (e.g., unknown locationId or datacategoryId).',
      recovery:
        'Verify filter IDs — use noaa_climate_find_locations to list valid locationId values and noaa_climate_list_data_categories to list valid datacategoryId values.',
    },
  ],

  async handler(input, ctx) {
    ctx.log.info('Finding stations', {
      locationId: input.locationId,
      datasetId: input.datasetId,
      datatypeId: input.datatypeId,
    });

    const service = getCdoService();
    const params = {
      locationid: input.locationId,
      extent: input.extent,
      datasetid: input.datasetId,
      datatypeid: input.datatypeId,
      datacategoryid: input.datacategoryId,
      startdate: toCdoWireDate(input.startDate),
      enddate: toCdoWireDate(input.endDate),
      sortfield: input.sortField,
      sortorder: input.sortOrder,
      limit: input.limit,
      offset: input.offset,
    };
    let response: Awaited<ReturnType<typeof service.findStations>>;
    try {
      response = await service.findStations(params, ctx);
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

    const results = (response.results ?? []).map((st) => ({
      id: st.id,
      name: st.name,
      ...(typeof st.latitude === 'number' && { latitude: st.latitude }),
      ...(typeof st.longitude === 'number' && { longitude: st.longitude }),
      ...(typeof st.elevation === 'number' && { elevation: st.elevation }),
      ...(st.elevationUnit && { elevationUnit: st.elevationUnit }),
      ...(st.mindate && { mindate: st.mindate }),
      ...(st.maxdate && { maxdate: st.maxdate }),
      ...(typeof st.datacoverage === 'number' && { datacoverage: st.datacoverage }),
    }));

    const { totalCount, exhausted } = await resolveCollectionTotal(
      response,
      params,
      ctx,
      (probeParams, probeCtx) => service.findStations(probeParams, probeCtx),
    );
    ctx.enrich.total(totalCount);
    // ctx.enrich.notice is last-wins — exactly one of these branches may fire.
    if (exhausted) {
      ctx.enrich({ exhausted: true });
      ctx.enrich.notice(
        `Page is empty because offset ${input.offset} is past the end of ${totalCount} matching stations. Lower offset or reset it to 0.`,
      );
    } else if (results.length === 0) {
      const filterHints: string[] = [];
      if (input.locationId) filterHints.push(`locationId="${input.locationId}"`);
      if (input.datasetId) filterHints.push(`datasetId="${input.datasetId}"`);
      if (input.datatypeId?.length) filterHints.push(`datatypeId=[${input.datatypeId.join(', ')}]`);
      if (input.extent) filterHints.push(`extent="${input.extent}"`);
      const filterStr = filterHints.length > 0 ? ` with ${filterHints.join(', ')}` : '';
      ctx.enrich.notice(
        `No stations matched${filterStr}. Try broadening the bounding box, removing datatypeId filters, or using a different locationId.`,
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
    for (const st of result.results) {
      lines.push(`## ${st.name} (\`${st.id}\`)`);
      const coordParts: string[] = [];
      if (typeof st.latitude === 'number' && typeof st.longitude === 'number') {
        coordParts.push(`${st.latitude.toFixed(4)}, ${st.longitude.toFixed(4)}`);
      }
      if (typeof st.elevation === 'number') {
        coordParts.push(`elev ${st.elevation}${st.elevationUnit ? ` ${st.elevationUnit}` : ''}`);
      }
      if (coordParts.length > 0) lines.push(`**Coords/Elevation:** ${coordParts.join(' | ')}`);
      if (st.mindate && st.maxdate) {
        lines.push(`**Data range:** ${st.mindate} – ${st.maxdate}`);
      }
      if (typeof st.datacoverage === 'number') {
        lines.push(`**Coverage:** ${(st.datacoverage * 100).toFixed(0)}%`);
      }
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
