/**
 * @fileoverview Fetch full metadata for a single NOAA CDO weather station by ID.
 * @module mcp-server/tools/definitions/noaa-get-station
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { isUpstreamTokenRejection } from '@/mcp-server/tools/definitions/shared/upstream-auth.js';
import { upstreamOutageReason } from '@/mcp-server/tools/definitions/shared/upstream-availability.js';
import { identifierFilter } from '@/mcp-server/tools/definitions/shared/validation.js';
import { getCdoService } from '@/services/cdo/cdo-service.js';

export const noaaClimateGetStation = tool('noaa_climate_get_station', {
  title: 'Get NOAA Climate Station',
  description:
    'Fetch full metadata for a single weather station by its ID (e.g., "GHCND:USW00024233", "COOP:010008"). Returns name, coordinates, elevation, and the full date range for which data is available. Use when you have a station ID from noaa_climate_find_stations and want its complete details, or to verify a station before querying data.',
  annotations: { readOnlyHint: true, openWorldHint: false },
  input: z.object({
    stationId: identifierFilter(
      'Station ID to fetch (e.g., "GHCND:USW00024233", "COOP:010008"). Obtain from noaa_climate_find_stations.',
    ),
  }),
  output: z.object({
    id: z.string().describe('Station ID.'),
    name: z.string().describe('Station name.'),
    latitude: z
      .number()
      .optional()
      .describe('Station latitude in decimal degrees. Omitted when not provided by the API.'),
    longitude: z
      .number()
      .optional()
      .describe('Station longitude in decimal degrees. Omitted when not provided by the API.'),
    elevation: z
      .number()
      .optional()
      .describe('Station elevation. Unit depends on elevationUnit. Omitted when not provided.'),
    elevationUnit: z
      .string()
      .optional()
      .describe('Unit for elevation (e.g., "Meters"). Omitted when not provided.'),
    mindate: z
      .string()
      .optional()
      .describe(
        'Earliest date data is available at this station (YYYY-MM-DD). Omitted when not provided.',
      ),
    maxdate: z
      .string()
      .optional()
      .describe(
        'Latest date data is available at this station (YYYY-MM-DD). Omitted when not provided.',
      ),
    datacoverage: z
      .number()
      .optional()
      .describe('Fractional data coverage (0–1). Omitted when not provided by the API.'),
  }),

  errors: [
    {
      reason: 'not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'Station ID format is valid but no station exists with that ID.',
      recovery:
        'Verify the station ID format (e.g., GHCND:USW00024233) and use noaa_climate_find_stations to discover valid IDs.',
    },
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
  ],

  async handler(input, ctx) {
    ctx.log.info('Getting station', { stationId: input.stationId });

    const service = getCdoService();
    let st: Awaited<ReturnType<typeof service.getStation>>;
    try {
      st = await service.getStation(input.stationId, ctx);
    } catch (err) {
      // The rejected token is the only HTTP 400 this route raises that the
      // caller can act on, and the move is a deployment fix rather than a
      // different stationId. No other 400 is rerouted: CDO answers an unknown
      // ID with HTTP 200 and a bare `{}`, so there is no input-fault reason
      // here to land a status on. An unreachable or throttled upstream is a
      // separate matter — nothing about the input caused it, and both carry a
      // next move the caller can take.
      if (err instanceof McpError) {
        const outage = upstreamOutageReason(err);
        if (outage === 'rate_limited') throw ctx.fail('rate_limited', err.message);
        if (outage === 'service_unavailable') throw ctx.fail('service_unavailable', err.message);
        if (err.code === JsonRpcErrorCode.InvalidParams && isUpstreamTokenRejection(err)) {
          throw ctx.fail('upstream_auth_failed', err.message);
        }
      }
      throw err;
    }

    if (!st.id) throw ctx.fail('not_found', `Station "${input.stationId}" not found.`);

    return {
      id: st.id,
      name: st.name,
      ...(typeof st.latitude === 'number' && { latitude: st.latitude }),
      ...(typeof st.longitude === 'number' && { longitude: st.longitude }),
      ...(typeof st.elevation === 'number' && { elevation: st.elevation }),
      ...(st.elevationUnit && { elevationUnit: st.elevationUnit }),
      ...(st.mindate && { mindate: st.mindate }),
      ...(st.maxdate && { maxdate: st.maxdate }),
      ...(typeof st.datacoverage === 'number' && { datacoverage: st.datacoverage }),
    };
  },

  format(result) {
    const lines: string[] = [];
    lines.push(`## ${result.name} (\`${result.id}\`)`);

    if (typeof result.latitude === 'number' && typeof result.longitude === 'number') {
      lines.push(`**Coordinates:** ${result.latitude.toFixed(4)}, ${result.longitude.toFixed(4)}`);
    } else {
      lines.push('**Coordinates:** Not available');
    }

    if (typeof result.elevation === 'number') {
      lines.push(
        `**Elevation:** ${result.elevation}${result.elevationUnit ? ` ${result.elevationUnit}` : ''}`,
      );
    } else {
      lines.push('**Elevation:** Not available');
    }

    if (result.mindate && result.maxdate) {
      lines.push(`**Data range:** ${result.mindate} – ${result.maxdate}`);
    } else {
      lines.push('**Data range:** Not available');
    }

    if (typeof result.datacoverage === 'number') {
      lines.push(`**Coverage:** ${(result.datacoverage * 100).toFixed(0)}%`);
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
