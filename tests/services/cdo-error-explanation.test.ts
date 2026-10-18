/**
 * @fileoverview Tests for the CDO failure explanation path — CDO's own
 * `developerMessage` (XML) or `message` (JSON) reaching the thrown error, and
 * the request URL staying out of it.
 * @module tests/services/cdo-error-explanation.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: vi.fn().mockReturnValue({ token: 'test-token-1234' }),
}));

// Execute the retried function once, without backoff delays.
vi.mock('@cyanheads/mcp-ts-core/utils', async (importOriginal) => {
  const original = await importOriginal<typeof import('@cyanheads/mcp-ts-core/utils')>();
  return {
    ...original,
    withRetry: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  };
});

import { BillionDollarDisastersService } from '@/services/billion-dollar-disasters/billion-dollar-disasters-service.js';
import { CdoService } from '@/services/cdo/cdo-service.js';
import { StormEventsService } from '@/services/storm-events/storm-events-service.js';

const BASE_URL = 'https://mock-cdo.test/v2';

/** The fault document CDO returns for a rejected parameter. */
const xmlFault = (developerMessage: string, userMessage = 'There was an error with the request.') =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><response><statusCode>400</statusCode><userMessage>${userMessage}</userMessage><developerMessage>${developerMessage}</developerMessage></response>`;

const errorResponse = (status: number, body: string, contentType: string): Response =>
  new Response(body, { status, headers: { 'Content-Type': contentType } });

async function captureFailure(call: (service: CdoService) => Promise<unknown>): Promise<McpError> {
  const service = new CdoService(BASE_URL);
  try {
    await call(service);
  } catch (error) {
    if (error instanceof McpError) return error;
    throw error;
  }
  throw new Error('Expected the call to throw.');
}

describe('CdoService — upstream failure explanation', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('surfaces the XML developerMessage for an over-long date range', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      errorResponse(400, xmlFault('The date range must be less than 1 year.'), 'application/xml'),
    );

    const error = await captureFailure((service) =>
      service.fetchData(
        {
          datasetid: 'GHCND',
          startdate: '2020-03-10',
          enddate: '2021-04-01',
          stationid: 'GHCND:USW00024233',
        },
        createMockContext(),
      ),
    );

    expect(error.message).toContain('The date range must be less than 1 year.');
    expect(error.data?.upstreamMessage).toBe('The date range must be less than 1 year.');
  });

  it('surfaces a different developerMessage for a malformed date, so the two are distinguishable', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      errorResponse(
        400,
        xmlFault('Start date is required and must be in ISO format.'),
        'application/xml',
      ),
    );

    const error = await captureFailure((service) =>
      service.fetchData(
        { datasetid: 'GHCND', startdate: '03-10-2020', enddate: '2020-03-20' },
        createMockContext(),
      ),
    );

    expect(error.message).toContain('Start date is required and must be in ISO format.');
    expect(error.message).not.toContain('date range must be less than');
  });

  it('surfaces the JSON message CDO uses for token failures', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      errorResponse(
        400,
        '{"status" : "400", "message" : "The token parameter provided is not valid."}',
        'application/json;charset=utf-8',
      ),
    );

    const error = await captureFailure((service) => service.listDatasets({}, createMockContext()));

    expect(error.message).toContain('The token parameter provided is not valid.');
    expect(error.data?.upstreamMessage).toBe('The token parameter provided is not valid.');
  });

  it('never puts the request URL or the query string in the client-visible message', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      errorResponse(400, xmlFault('Limit may not exceed 1000.'), 'application/xml'),
    );

    const error = await captureFailure((service) =>
      service.findStations({ locationid: 'FIPS:37', limit: 9999 }, createMockContext()),
    );

    expect(error.message).not.toContain(BASE_URL);
    expect(error.message).not.toContain('mock-cdo.test');
    expect(error.message).not.toContain('locationid');
  });

  it('preserves the status-mapped error code and status for a rejected request', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      errorResponse(
        400,
        xmlFault('Data requests require exactly one datasetid.'),
        'application/xml',
      ),
    );

    const error = await captureFailure((service) =>
      service.fetchData({ startdate: '2020-03-10', enddate: '2020-03-20' }, createMockContext()),
    );

    expect(error.data?.status).toBe(400);
    expect(error.data?.path).toBe('data');
  });

  it('falls back to the userMessage when the fault carries no developerMessage', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      errorResponse(
        400,
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><response><statusCode>400</statusCode><userMessage>There was an error with the request.</userMessage></response>',
        'application/xml',
      ),
    );

    const error = await captureFailure((service) => service.listDataTypes({}, createMockContext()));

    expect(error.message).toContain('There was an error with the request.');
  });

  it('hands back an actionable hint when the failure body explains nothing', async () => {
    // Apache answers an over-long request URL with a 414 HTML page carrying no
    // developerMessage and no JSON message, so nothing but the status survives
    // the extraction — and 414 maps to InvalidRequest, past every tool's
    // InvalidParams routing, so the contract's recovery never reaches it.
    vi.mocked(fetch).mockResolvedValueOnce(
      errorResponse(
        414,
        '<!DOCTYPE HTML PUBLIC "-//IETF//DTD HTML 2.0//EN">\n<html><head>\n<title>414 Request-URI Too Long</title>\n</head><body>\n<h1>Request-URI Too Long</h1>\n</body></html>\n',
        'text/html',
      ),
    );

    const error = await captureFailure((service) =>
      service.fetchData(
        {
          datasetid: 'GHCND',
          startdate: '2023-01-01',
          enddate: '2023-01-05',
          datatypeid: Array.from({ length: 1_200 }, (_, i) => `DTYPE${i}`),
        },
        createMockContext(),
      ),
    );

    expect(error.data?.upstreamMessage).toBeUndefined();
    expect(error.message).toContain('HTTP 414');
    expect((error.data?.recovery as { hint?: string } | undefined)?.hint).toMatch(/fewer values/i);
  });

  it('leaves an unexplained failure body alone but still keeps the URL out of the message', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(errorResponse(503, 'upstream down', 'text/plain'));

    const error = await captureFailure((service) => service.listDatasets({}, createMockContext()));

    expect(error.message).not.toContain('mock-cdo.test');
    expect(error.data?.upstreamMessage).toBeUndefined();
  });
});

describe.each([
  {
    operation: 'NOAA CDO',
    timeoutMs: 15_000,
    run: () => new CdoService(BASE_URL).listDatasets({}, createMockContext()),
  },
  {
    operation: 'Storm Events directory',
    timeoutMs: 15_000,
    run: () => new StormEventsService(BASE_URL).resolveDetailsFile(2024, createMockContext()),
  },
  {
    operation: 'billion-dollar disasters export',
    timeoutMs: 20_000,
    run: () =>
      new BillionDollarDisastersService(BASE_URL).searchEvents(
        { limit: 1, offset: 0 },
        createMockContext(),
      ),
  },
])('$operation — transport explanation', ({ operation, timeoutMs, run }) => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('names the operation on a rejected fetch, preserving the network code', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    const error = await run().catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(McpError);
    expect(error).toMatchObject({ code: JsonRpcErrorCode.ServiceUnavailable });
    expect((error as McpError).message).toContain(operation);
    expect((error as McpError).message).not.toContain('https://');
  });

  it('names a timeout without changing its code or routing', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: unknown, init: RequestInit) =>
          new Promise((_resolve, reject) =>
            init.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
              once: true,
            }),
          ),
      ),
    );
    const pending = run().catch((cause: unknown) => cause);
    await vi.advanceTimersByTimeAsync(timeoutMs + 1);
    const error = (await pending) as McpError;
    expect(error.code).toBe(JsonRpcErrorCode.Timeout);
    expect(error.message).toContain(operation);
    expect(error.message).toContain('timed out');
    expect(error.message).not.toContain('https://');
    expect(error.data?.reason).toBeUndefined();
  });

  it('names HTTP failure while preserving status and body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('upstream down', { status: 503 })),
    );
    const error = (await run().catch((cause: unknown) => cause)) as McpError;
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.data?.status).toBe(503);
    expect(error.data?.body).toBe('upstream down');
    expect(error.message).toContain(operation);
    expect(error.message).toContain('503');
    expect(error.message).not.toContain('https://');
  });
});
