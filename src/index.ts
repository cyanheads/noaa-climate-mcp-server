#!/usr/bin/env node
/**
 * @fileoverview noaa-climate-mcp-server MCP server entry point.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { noaaDatasetsResource } from './mcp-server/resources/definitions/noaa-datasets.resource.js';
import { noaaStationResource } from './mcp-server/resources/definitions/noaa-station.resource.js';
import { noaaClimateFetchData } from './mcp-server/tools/definitions/noaa-climate-fetch-data.tool.js';
import { noaaClimateFindLocations } from './mcp-server/tools/definitions/noaa-climate-find-locations.tool.js';
import { noaaClimateFindStations } from './mcp-server/tools/definitions/noaa-climate-find-stations.tool.js';
import { noaaClimateGetBillionDollarDisasters } from './mcp-server/tools/definitions/noaa-climate-get-billion-dollar-disasters.tool.js';
import { noaaClimateGetStation } from './mcp-server/tools/definitions/noaa-climate-get-station.tool.js';
import { noaaClimateListDataCategories } from './mcp-server/tools/definitions/noaa-climate-list-data-categories.tool.js';
import { noaaClimateListDataTypes } from './mcp-server/tools/definitions/noaa-climate-list-data-types.tool.js';
import { noaaClimateListDatasets } from './mcp-server/tools/definitions/noaa-climate-list-datasets.tool.js';
import { noaaClimateListLocationCategories } from './mcp-server/tools/definitions/noaa-climate-list-location-categories.tool.js';
import { noaaClimateSearchStormEvents } from './mcp-server/tools/definitions/noaa-climate-search-storm-events.tool.js';
import { initBillionDollarDisastersService } from './services/billion-dollar-disasters/billion-dollar-disasters-service.js';
import { initCdoService } from './services/cdo/cdo-service.js';
import { initStormEventsService } from './services/storm-events/storm-events-service.js';

await createApp({
  name: 'noaa-climate-mcp-server',
  title: 'noaa-climate-mcp-server',
  sessionMode: 'stateless',
  tools: [
    noaaClimateListDatasets,
    noaaClimateListDataCategories,
    noaaClimateListDataTypes,
    noaaClimateListLocationCategories,
    noaaClimateFindLocations,
    noaaClimateFindStations,
    noaaClimateGetStation,
    noaaClimateFetchData,
    noaaClimateSearchStormEvents,
    noaaClimateGetBillionDollarDisasters,
  ],
  resources: [noaaDatasetsResource, noaaStationResource],
  prompts: [],
  instructions: `NOAA Climate Data Online (CDO) API v2 — historical weather observations and climate data.
Primary workflow: noaa_climate_find_locations → noaa_climate_find_stations → noaa_climate_fetch_data.
Discovery: noaa_climate_list_datasets → noaa_climate_list_data_categories → noaa_climate_list_data_types.
Location categories: noaa_climate_list_location_categories enumerates the 12 valid locationCategoryId values.
Date range limits: daily datasets (GHCND etc.) max 1 year per request; monthly/annual (GSOM, GSOY) max 10 years.
Always pass units=metric or units=standard to noaa_climate_fetch_data — raw GHCND values are tenths-of-unit integers.
Severe-weather events are a separate corpus: noaa_climate_search_storm_events reads the NCEI Storm Events Database (tornado, hail, flood, hurricane damage and casualties), needs no token, and requires a year.
Disaster costs are a third corpus: noaa_climate_get_billion_dollar_disasters reads NCEI's Billion-Dollar Weather and Climate Disasters (1980 through the last fully assessed year), needs no token, and reports every cost in whole US dollars.`,
  landing: { requireAuth: false },
  setup() {
    initCdoService();
    initStormEventsService();
    initBillionDollarDisastersService();
  },
});
