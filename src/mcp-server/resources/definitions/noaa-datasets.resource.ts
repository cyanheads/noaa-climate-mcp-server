/**
 * @fileoverview Static resource exposing all NOAA CDO datasets with IDs and temporal coverage.
 * @module mcp-server/resources/definitions/noaa-datasets
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { getCdoService } from '@/services/cdo/cdo-service.js';

export const noaaDatasetsResource = resource('noaa://datasets', {
  name: 'NOAA Climate Datasets',
  description:
    'All available NOAA CDO datasets with IDs, names, and temporal coverage. Use as injectable context to orient an agent on which datasets exist before querying data. Returns a small stable list (~11–13 datasets). Equivalent to calling noaa_climate_list_datasets with no filters and a high limit. Its NORMAL_* entries are the superseded 1981–2010 normals; noaa_climate_get_normals serves the current 1991–2020 normals.',
  params: z.object({}),

  async handler(_params, ctx) {
    ctx.log.debug('Fetching datasets resource');
    const service = getCdoService();
    const response = await service.listDatasets({ limit: 1000 }, ctx);
    const datasets = response.results ?? [];
    return { datasets };
  },
});
