/**
 * @fileoverview Resource exposing NOAA CDO station metadata by station ID.
 * @module mcp-server/resources/definitions/noaa-station
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { identifierFilter } from '@/mcp-server/tools/definitions/shared/validation.js';
import { getCdoService } from '@/services/cdo/cdo-service.js';

export const noaaStationResource = resource('noaa://stations/{stationId}', {
  name: 'NOAA Climate Station',
  description:
    'Station metadata by ID — name, coordinates, elevation, and the full date range for which data is available. Mirrors noaa_climate_get_station as an injectable resource. URI format: noaa://stations/GHCND:USW00024233.',
  params: z.object({
    stationId: identifierFilter('Station ID (e.g., GHCND:USW00024233, COOP:010008).'),
  }),

  errors: [
    {
      reason: 'not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'Station ID format is valid but no station exists with that ID.',
      recovery:
        'Verify the station ID format (e.g., GHCND:USW00024233) and use noaa_climate_find_stations to discover valid IDs.',
    },
  ],

  async handler(params, ctx) {
    ctx.log.debug('Fetching station resource', { stationId: params.stationId });
    const service = getCdoService();
    const station = await service.getStation(params.stationId, ctx);
    if (!station.id) {
      throw ctx.fail('not_found', `Station "${params.stationId}" not found.`, {
        stationId: params.stationId,
      });
    }
    return station;
  },
});
