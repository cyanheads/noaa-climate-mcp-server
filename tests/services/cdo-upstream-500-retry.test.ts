/**
 * @fileoverview Tests that a CDO 500 is treated as a transient outage — the
 * real retry loop runs, and what the caller finally sees carries the code the
 * tools route onto `service_unavailable`.
 *
 * Every other CdoService suite stubs `withRetry` out to run its body once, so
 * none of them can observe this: a 500 used to classify `InternalError`, which
 * sat outside the default transient set and failed on the first attempt while
 * the 502 beside it retried. It is now `ServiceUnavailable`, so the request is
 * retried and — since {@link upstreamOutageReason} keys on the code alone — a
 * caller gets the declared `service_unavailable` reason rather than a bare
 * internal failure.
 *
 * The real `withRetry` is what makes the attempt count meaningful, so the clock
 * is faked: the default backoff is 1s, 2s, 4s across four attempts, which would
 * otherwise outlast the test timeout.
 *
 * @module tests/services/cdo-upstream-500-retry.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { upstreamOutageReason } from '@/mcp-server/tools/definitions/shared/upstream-availability.js';
import { CdoService } from '@/services/cdo/cdo-service.js';

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: vi.fn().mockReturnValue({ token: 'test-token-1234' }),
}));

/** Total attempts the retry loop makes at `withRetry`'s default `maxRetries: 3`. */
const TOTAL_ATTEMPTS = 4;

/** Past the summed 1s + 2s + 4s backoff, so every retry has been released. */
const BACKOFF_WINDOW_MS = 30_000;

const serverError = () =>
  new Response('<html><body>500</body></html>', {
    status: 500,
    headers: { 'Content-Type': 'text/html' },
  });

/**
 * Drive the call to rejection with the backoff clock wound forward.
 *
 * The promise is created before the clock moves so the first attempt is already
 * in flight, and the rejection is captured up front — an unhandled rejection
 * would otherwise surface while the timers are being advanced.
 */
async function rejectionAfterRetries(run: () => Promise<unknown>): Promise<McpError> {
  const settled = run().then(
    () => undefined,
    (error: unknown) => error,
  );
  await vi.advanceTimersByTimeAsync(BACKOFF_WINDOW_MS);
  const error = await settled;
  if (error instanceof McpError) return error;
  throw new Error(`Expected an McpError, got: ${String(error)}`);
}

describe('CdoService — an upstream 500', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(serverError())),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('classifies as ServiceUnavailable rather than InternalError', async () => {
    const service = new CdoService('https://mock-cdo.test/v2');

    const error = await rejectionAfterRetries(() => service.listDatasets({}, createMockContext()));

    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.code).not.toBe(JsonRpcErrorCode.InternalError);
  });

  it('retries the request instead of failing on the first attempt', async () => {
    const service = new CdoService('https://mock-cdo.test/v2');

    await rejectionAfterRetries(() => service.listDatasets({}, createMockContext()));

    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(TOTAL_ATTEMPTS);
  });

  it('reaches the reason every CDO-backed tool declares for an outage', async () => {
    const service = new CdoService('https://mock-cdo.test/v2');

    const error = await rejectionAfterRetries(() => service.findStations({}, createMockContext()));

    expect(upstreamOutageReason(error)).toBe('service_unavailable');
  });

  it('names the status and the endpoint without the request URL', async () => {
    const service = new CdoService('https://mock-cdo.test/v2');

    const error = await rejectionAfterRetries(() => service.listDatasets({}, createMockContext()));

    expect(error.message).toContain('HTTP 500');
    expect(error.message).toContain('/datasets');
    expect(error.message).not.toContain('mock-cdo.test');
  });
});
