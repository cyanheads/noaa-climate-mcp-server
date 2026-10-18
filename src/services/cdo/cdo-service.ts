/**
 * @fileoverview NOAA CDO API v2 client. Handles all HTTP requests, parameter
 * translation (camelCase → CDO lowercase), retry logic, and response parsing.
 * @module services/cdo/cdo-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { McpError } from '@cyanheads/mcp-ts-core/errors';
import { fetchWithTimeout, requestContextService, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import { explainUpstreamFailure } from '@/services/upstream-failure.js';
import type {
  CdoCollectionResponse,
  CdoDataCategory,
  CdoDataRecord,
  CdoDataset,
  CdoDataType,
  CdoListParams,
  CdoLocation,
  CdoLocationCategory,
  CdoPaginationParams,
  CdoStation,
} from './types.js';

const BASE_URL = 'https://www.ncei.noaa.gov/cdo-web/api/v2';
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Bytes of a rejection body kept for the explanation below.
 *
 * CDO's XML fault runs about 230 bytes and its longest observed
 * `developerMessage` — the `sortfield` allowed-values list — pushes past 300.
 * The framework's 500-byte default already clears both; the explicit budget
 * leaves room for a longer enumeration without truncating mid-message.
 */
const ERROR_BODY_LIMIT = 2_000;

/**
 * CDO's own explanation of a rejected request, in the two shapes it sends.
 *
 * Every parameter rejection comes back as an XML fault carrying
 * `<developerMessage>` — "The date range must be less than 1 year.", "Required
 * parameter 'startdate' is missing.", "sortfield must be one of the following
 * allowed values: […]". The token failures are the exception: those are JSON
 * with a `message` key. Both are matched by pattern rather than parsed, so a
 * body clipped at the byte budget still yields its message.
 */
const DEVELOPER_MESSAGE_PATTERN = /<developerMessage>([\s\S]*?)<\/developerMessage>/;
const USER_MESSAGE_PATTERN = /<userMessage>([\s\S]*?)<\/userMessage>/;
const JSON_MESSAGE_PATTERN = /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/;

function extractUpstreamMessage(body: unknown): string | undefined {
  if (typeof body !== 'string') return undefined;
  const matched =
    DEVELOPER_MESSAGE_PATTERN.exec(body) ??
    USER_MESSAGE_PATTERN.exec(body) ??
    JSON_MESSAGE_PATTERN.exec(body);
  const message = matched?.[1]?.trim();
  return message ? message : undefined;
}

/**
 * What to try when CDO rejects a request and explains nothing.
 *
 * The reachable case is an over-long request URL: a large `datatypeId`,
 * `stationId`, or `locationId` array pushes past what CDO's front end accepts
 * and it answers HTTP 414 with an Apache error page — no `developerMessage`, no
 * JSON `message`. 414 maps to `InvalidRequest`, past every tool's
 * `InvalidParams` routing, so without this the caller gets a bare status and no
 * next move.
 */
const UNEXPLAINED_FAILURE_HINT =
  'NOAA CDO gave no explanation for this status. If the request carried long stationId, locationId, or datatypeId arrays, send fewer values — an over-long request URL is rejected exactly this way; otherwise retry once, then check whether NOAA CDO is up.';

/**
 * Rewrite an upstream failure into one the caller can act on.
 *
 * `fetchWithTimeout` throws before anything reads the body, so its message is
 * only `Fetch failed for <url>. Status: 400` — which drops the one sentence
 * that separates a bad date form from an over-long range from a missing
 * parameter, and puts the fully-parameterized request URL in front of the
 * client. The body is not lost, though: the helper captures it under
 * `data.body`, so the explanation is recoverable here.
 *
 * The status-mapped code and every `data` field are carried through unchanged
 * — the retry predicate and each tool's `InvalidParams` routing both read them
 * — and `data.upstreamMessage` records what CDO said. A body with no
 * recognizable message still gets the URL stripped: naming the endpoint path is
 * all the caller can use, and {@link UNEXPLAINED_FAILURE_HINT} carries the rest.
 */
function explainCdoFailure(error: unknown, path: string): unknown {
  if (!(error instanceof McpError)) return error;
  const status = error.data?.status;
  if (typeof status !== 'number') return explainUpstreamFailure(error, `NOAA CDO /${path}`);

  const upstreamMessage = extractUpstreamMessage(error.data?.body);
  const message = upstreamMessage
    ? `NOAA CDO rejected the request to /${path} (HTTP ${status}): ${upstreamMessage}`
    : `NOAA CDO returned HTTP ${status} for /${path}.`;

  return new McpError(
    error.code,
    message,
    {
      ...error.data,
      path,
      ...(upstreamMessage ? { upstreamMessage } : { recovery: { hint: UNEXPLAINED_FAILURE_HINT } }),
    },
    { cause: error },
  );
}

/** Serialize a value that may be an array to repeated query param entries. */
function appendParam(
  params: URLSearchParams,
  key: string,
  value: string | string[] | number | boolean | undefined,
): void {
  if (value == null) return;
  if (Array.isArray(value)) {
    for (const v of value) {
      if (v) params.append(key, v);
    }
  } else {
    params.append(key, String(value));
  }
}

/** Build URLSearchParams from CdoListParams, translating camelCase → CDO lowercase keys. */
function buildParams(p: CdoListParams): URLSearchParams {
  const q = new URLSearchParams();
  appendParam(q, 'datasetid', p.datasetid);
  appendParam(q, 'datacategoryid', p.datacategoryid);
  appendParam(q, 'locationid', p.locationid);
  appendParam(q, 'stationid', p.stationid);
  appendParam(q, 'datatypeid', p.datatypeid);
  appendParam(q, 'locationcategoryid', p.locationcategoryid);
  appendParam(q, 'startdate', p.startdate);
  appendParam(q, 'enddate', p.enddate);
  appendParam(q, 'sortfield', p.sortfield);
  appendParam(q, 'sortorder', p.sortorder);
  appendParam(q, 'extent', p.extent);
  appendParam(q, 'units', p.units);
  if (p.limit !== undefined) appendParam(q, 'limit', p.limit);
  // NOAA CDO API uses 1-based offset; convert 0-based client input (+1).
  if (p.offset !== undefined) appendParam(q, 'offset', p.offset + 1);
  if (p.includemetadata !== undefined) appendParam(q, 'includemetadata', p.includemetadata);
  return q;
}

export class CdoService {
  private readonly baseUrl: string;

  constructor(baseUrl = BASE_URL) {
    this.baseUrl = baseUrl;
  }

  /**
   * Make a single authenticated GET request to the CDO API, with retry.
   *
   * `expectedStatuses` lists non-2xx statuses that are an ordinary outcome for
   * the endpoint rather than a fault — they log at `debug` instead of `error`.
   * The status-mapped `McpError` is thrown either way. No CDO route needs it
   * today; it stays for an endpoint that maps a status to an ordinary result.
   */
  private get<T>(
    path: string,
    params: CdoListParams,
    ctx: Context,
    expectedStatuses?: number[],
  ): Promise<T> {
    const { token } = getServerConfig();
    const retryCtx = requestContextService.createRequestContext({
      operation: `cdo.${path}`,
      parentContext: ctx,
    });

    return withRetry(
      async () => {
        const qs = buildParams(params).toString();
        const url = `${this.baseUrl}/${path}${qs ? `?${qs}` : ''}`;
        ctx.log.debug('CDO API request', { url });

        let response: Response;
        try {
          response = await fetchWithTimeout(url, REQUEST_TIMEOUT_MS, retryCtx, {
            headers: { token },
            signal: ctx.signal,
            errorBodyLimit: ERROR_BODY_LIMIT,
            ...(expectedStatuses ? { expectedStatuses } : {}),
          });
        } catch (error) {
          throw explainCdoFailure(error, path);
        }

        const text = await response.text();
        if (/^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(text)) {
          const { serviceUnavailable } = await import('@cyanheads/mcp-ts-core/errors');
          throw serviceUnavailable(
            'NOAA CDO returned HTML instead of JSON — likely rate-limited.',
            { path },
          );
        }

        return JSON.parse(text) as T;
      },
      {
        operation: `cdo.${path}`,
        context: retryCtx,
        baseDelayMs: 1000,
        signal: ctx.signal,
      },
    );
  }

  /** Fetch datasets, optionally filtered. */
  listDatasets(params: CdoListParams, ctx: Context): Promise<CdoCollectionResponse<CdoDataset>> {
    return this.get<CdoCollectionResponse<CdoDataset>>('datasets', params, ctx);
  }

  /** Fetch data categories, optionally filtered. */
  listDataCategories(
    params: CdoListParams,
    ctx: Context,
  ): Promise<CdoCollectionResponse<CdoDataCategory>> {
    return this.get<CdoCollectionResponse<CdoDataCategory>>('datacategories', params, ctx);
  }

  /**
   * Fetch the location categories that scope `/locations`.
   *
   * Pagination and sort only: CDO ignores every domain filter on this endpoint,
   * so the narrower param type keeps one from being sent and read as applied.
   */
  listLocationCategories(
    params: CdoPaginationParams,
    ctx: Context,
  ): Promise<CdoCollectionResponse<CdoLocationCategory>> {
    return this.get<CdoCollectionResponse<CdoLocationCategory>>('locationcategories', params, ctx);
  }

  /** Fetch data types, optionally filtered. */
  listDataTypes(params: CdoListParams, ctx: Context): Promise<CdoCollectionResponse<CdoDataType>> {
    return this.get<CdoCollectionResponse<CdoDataType>>('datatypes', params, ctx);
  }

  /** Fetch locations, optionally filtered. */
  findLocations(params: CdoListParams, ctx: Context): Promise<CdoCollectionResponse<CdoLocation>> {
    return this.get<CdoCollectionResponse<CdoLocation>>('locations', params, ctx);
  }

  /** Fetch stations, optionally filtered. */
  findStations(params: CdoListParams, ctx: Context): Promise<CdoCollectionResponse<CdoStation>> {
    return this.get<CdoCollectionResponse<CdoStation>>('stations', params, ctx);
  }

  /**
   * Fetch a single station by ID.
   *
   * CDO answers an unknown ID with HTTP 200 and a bare `{}`, never a 404, so
   * this route declares no expected non-2xx statuses. The not-found path is the
   * callers' `!station.id` check.
   */
  getStation(stationId: string, ctx: Context): Promise<CdoStation> {
    return this.get<CdoStation>(`stations/${encodeURIComponent(stationId)}`, {}, ctx);
  }

  /** Fetch observation data. */
  fetchData(params: CdoListParams, ctx: Context): Promise<CdoCollectionResponse<CdoDataRecord>> {
    return this.get<CdoCollectionResponse<CdoDataRecord>>('data', params, ctx);
  }
}

// --- Init/accessor pattern ---

let _service: CdoService | undefined;

export function initCdoService(): void {
  _service = new CdoService();
}

export function getCdoService(): CdoService {
  if (!_service) {
    throw new Error('CdoService not initialized — call initCdoService() in setup()');
  }
  return _service;
}
