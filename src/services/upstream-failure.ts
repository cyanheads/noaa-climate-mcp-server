/**
 * @fileoverview Operation-level explanations for NOAA transport failures.
 * @module services/upstream-failure
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';

/** Name the operation while preserving HTTP, cancellation, and retry semantics. */
export function explainUpstreamFailure(error: unknown, operation: string): unknown {
  if (!(error instanceof McpError) || error.code === JsonRpcErrorCode.RequestCancelled)
    return error;
  const status = error.data?.status;
  const cause =
    typeof status === 'number'
      ? `returned HTTP ${status}`
      : error.code === JsonRpcErrorCode.Timeout
        ? 'timed out'
        : 'failed to reach the upstream service';
  return new McpError(error.code, `${operation} ${cause}.`, error.data, { cause: error });
}
