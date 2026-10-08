/**
 * @fileoverview Pins what a caller receives when NOAA CDO throttles or drops a
 * request: the code, the declared reason, and the exact declared recovery hint,
 * read through the framework's contract runner rather than off the throw site.
 *
 * Each CDO tool throws the two outage reasons as separate literal `ctx.fail`
 * branches so the error-contract lint rules can resolve them. These cases hold
 * the wire result fixed across that shape: the hint a caller gets is the one
 * the tool declares, never the explanation the upstream failure carried in.
 *
 * @module tests/tools/cdo-upstream-outage-contract.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { noaaClimateFetchData } from '@/mcp-server/tools/definitions/noaa-climate-fetch-data.tool.js';
import { noaaClimateFindLocations } from '@/mcp-server/tools/definitions/noaa-climate-find-locations.tool.js';
import { noaaClimateFindStations } from '@/mcp-server/tools/definitions/noaa-climate-find-stations.tool.js';
import { noaaClimateGetStation } from '@/mcp-server/tools/definitions/noaa-climate-get-station.tool.js';
import { noaaClimateListDataCategories } from '@/mcp-server/tools/definitions/noaa-climate-list-data-categories.tool.js';
import { noaaClimateListDataTypes } from '@/mcp-server/tools/definitions/noaa-climate-list-data-types.tool.js';
import { noaaClimateListDatasets } from '@/mcp-server/tools/definitions/noaa-climate-list-datasets.tool.js';
import { noaaClimateListLocationCategories } from '@/mcp-server/tools/definitions/noaa-climate-list-location-categories.tool.js';
import { contractFailure } from '../helpers/contract-failure.js';

vi.mock('@/services/cdo/cdo-service.js', () => ({
  getCdoService: vi.fn(),
}));

import { getCdoService } from '@/services/cdo/cdo-service.js';

const RATE_LIMITED_HINT =
  'Space the calls out — NOAA CDO allows 5 requests per second per token, so several climate tools running concurrently is the usual cause. Pause a second, drop the concurrency, then retry.';

const SERVICE_UNAVAILABLE_HINT =
  'Wait a moment and retry; NOAA CDO may be temporarily unavailable.';

/** The explanation CdoService attaches to a status it has no body for. */
const UPSTREAM_HINT = 'NOAA CDO gave no explanation for this status.';

/** A status-mapped failure, shaped as CdoService rethrows it. */
function cdoStatusFailure(code: JsonRpcErrorCode, status: number): McpError {
  return new McpError(code, `NOAA CDO returned HTTP ${status} for /any.`, {
    status,
    path: 'any',
    recovery: { hint: UPSTREAM_HINT },
  });
}

function mockCdoRejection(method: string, error: McpError): void {
  vi.mocked(getCdoService).mockReturnValue({
    [method]: vi.fn().mockRejectedValue(error),
  } as unknown as ReturnType<typeof getCdoService>);
}

/** Every CDO-backed tool, the CdoService method it calls, and input its schema accepts. */
const CDO_TOOLS = [
  {
    label: 'noaa_climate_fetch_data',
    method: 'fetchData',
    run: () =>
      contractFailure(noaaClimateFetchData, {
        datasetId: 'GHCND',
        startDate: '2023-01-01',
        endDate: '2023-01-31',
      }),
  },
  {
    label: 'noaa_climate_find_locations',
    method: 'findLocations',
    run: () => contractFailure(noaaClimateFindLocations, { locationCategoryId: 'ST' }),
  },
  {
    label: 'noaa_climate_find_stations',
    method: 'findStations',
    run: () => contractFailure(noaaClimateFindStations, { locationId: 'FIPS:37' }),
  },
  {
    label: 'noaa_climate_get_station',
    method: 'getStation',
    run: () => contractFailure(noaaClimateGetStation, { stationId: 'GHCND:USW00024233' }),
  },
  {
    label: 'noaa_climate_list_data_categories',
    method: 'listDataCategories',
    run: () => contractFailure(noaaClimateListDataCategories, {}),
  },
  {
    label: 'noaa_climate_list_data_types',
    method: 'listDataTypes',
    run: () => contractFailure(noaaClimateListDataTypes, { datasetId: 'GHCND' }),
  },
  {
    label: 'noaa_climate_list_datasets',
    method: 'listDatasets',
    run: () => contractFailure(noaaClimateListDatasets, {}),
  },
  {
    label: 'noaa_climate_list_location_categories',
    method: 'listLocationCategories',
    run: () => contractFailure(noaaClimateListLocationCategories, {}),
  },
] as const;

beforeEach(() => {
  vi.restoreAllMocks();
});

describe.each(CDO_TOOLS)('$label — a throttled token on the wire', ({ method, run }) => {
  beforeEach(() => {
    mockCdoRejection(method, cdoStatusFailure(JsonRpcErrorCode.RateLimited, 429));
  });

  it('fails as RateLimited with reason rate_limited', async () => {
    const failure = await run();

    expect(failure.code).toBe(JsonRpcErrorCode.RateLimited);
    expect(failure.data.reason).toBe('rate_limited');
    expect(failure.data.retryable).toBe(true);
  });

  it('carries the declared rate_limited hint, not the upstream explanation', async () => {
    const failure = await run();

    expect(failure.data.recovery?.hint).toBe(RATE_LIMITED_HINT);
    expect(failure.text).toContain(`Recovery: ${RATE_LIMITED_HINT}`);
    expect(failure.text).not.toContain(UPSTREAM_HINT);
  });

  it('keeps the upstream message', async () => {
    expect((await run()).message).toBe('NOAA CDO returned HTTP 429 for /any.');
  });
});

describe.each(CDO_TOOLS)('$label — an unavailable upstream on the wire', ({ method, run }) => {
  beforeEach(() => {
    mockCdoRejection(method, cdoStatusFailure(JsonRpcErrorCode.ServiceUnavailable, 503));
  });

  it('fails as ServiceUnavailable with reason service_unavailable', async () => {
    const failure = await run();

    expect(failure.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(failure.data.reason).toBe('service_unavailable');
    expect(failure.data.retryable).toBe(true);
  });

  it('carries the declared service_unavailable hint, not the upstream explanation', async () => {
    const failure = await run();

    expect(failure.data.recovery?.hint).toBe(SERVICE_UNAVAILABLE_HINT);
    expect(failure.text).toContain(`Recovery: ${SERVICE_UNAVAILABLE_HINT}`);
    expect(failure.text).not.toContain(UPSTREAM_HINT);
  });

  it('keeps the upstream message', async () => {
    expect((await run()).message).toBe('NOAA CDO returned HTTP 503 for /any.');
  });
});
