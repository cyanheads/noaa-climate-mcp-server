/**
 * @fileoverview Pins what a caller receives from a CDO rejection end to end —
 * real `CdoService`, stubbed `fetch`, read through the framework's contract
 * runner: CDO's explanation reaches the caller in the message, while the
 * captured response body, XML fault or HTML error page alike, never does.
 * @module tests/tools/cdo-upstream-body-wire.test
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: vi.fn().mockReturnValue({ token: 'test-token-1234' }),
  getPaginationConfig: vi.fn().mockReturnValue({ clampLimits: true }),
}));

// Execute the retried function once, without backoff delays.
vi.mock('@cyanheads/mcp-ts-core/utils', async (importOriginal) => {
  const original = await importOriginal<typeof import('@cyanheads/mcp-ts-core/utils')>();
  return {
    ...original,
    withRetry: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  };
});

import { noaaClimateListDatasets } from '@/mcp-server/tools/definitions/noaa-climate-list-datasets.tool.js';
import { initCdoService } from '@/services/cdo/cdo-service.js';
import { contractFailure } from '../helpers/contract-failure.js';

const DEVELOPER_MESSAGE = 'Limit may not exceed 1000.';

const XML_FAULT = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><response><statusCode>400</statusCode><userMessage>There was an error with the request.</userMessage><developerMessage>${DEVELOPER_MESSAGE}</developerMessage></response>`;

const APACHE_414_PAGE =
  '<!DOCTYPE HTML PUBLIC "-//IETF//DTD HTML 2.0//EN">\n<html><head>\n<title>414 Request-URI Too Long</title>\n</head><body>\n<h1>Request-URI Too Long</h1>\n</body></html>\n';

function respondWith(status: number, body: string, contentType: string): void {
  vi.mocked(fetch).mockResolvedValueOnce(
    new Response(body, { status, headers: { 'Content-Type': contentType } }),
  );
}

describe('noaa_climate_list_datasets — a captured CDO body on the wire', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    initCdoService();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('carries the XML fault’s developerMessage, not the fault document', async () => {
    respondWith(400, XML_FAULT, 'application/xml');

    const failure = await contractFailure(noaaClimateListDatasets, {});

    expect(failure.data.reason).toBe('validation_error');
    expect(failure.message).toContain(DEVELOPER_MESSAGE);
    expect(failure.text).toContain(DEVELOPER_MESSAGE);
    expect(failure.data).not.toHaveProperty('body');
    expect(failure.data).not.toHaveProperty('responseBody');
    expect(failure.text).not.toContain('<developerMessage>');
  });

  it('names an HTML error page by its title and keeps the markup off both surfaces', async () => {
    respondWith(414, APACHE_414_PAGE, 'text/html');

    const failure = await contractFailure(noaaClimateListDatasets, {});

    expect(failure.message).toBe(
      'NOAA CDO returned HTTP 414 (414 Request-URI Too Long) for /datasets.',
    );
    expect(failure.data.recovery?.hint).toMatch(/fewer values/i);
    expect(failure.data).not.toHaveProperty('body');
    expect(failure.data).not.toHaveProperty('responseBody');
    expect(JSON.stringify(failure.data)).not.toMatch(/<(!DOCTYPE|html|title|h1)/i);
    expect(failure.text).not.toMatch(/<(!DOCTYPE|html|title|h1)/i);
  });
});
