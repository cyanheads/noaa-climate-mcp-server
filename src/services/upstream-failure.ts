/**
 * @fileoverview Operation-level explanations for NOAA transport failures.
 * @module services/upstream-failure
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';

const HTML_PAGE_PATTERN = /^\s*<(!DOCTYPE\s+html|html[\s>])/i;
const HTML_TITLE_PATTERN = /<title[^>]*>([\s\S]*?)<\/title>/i;

/**
 * A tag, or one left unclosed through the end of the title. Every `<` starts a
 * match, so no `<` survives the strip; a pattern for closed tags alone would
 * pass `Blocked <script` through as the opening of an element.
 */
const TITLE_TAG_PATTERN = /<[^>]*(?:>|$)/g;

/** Whether a response body is an HTML page — a web server's or a proxy's, never an API payload. */
export function isHtmlPage(text: string): boolean {
  return HTML_PAGE_PATTERN.test(text);
}

/**
 * `HTTP <status>`, followed by the `<title>` of an HTML error page when the
 * captured body is one.
 *
 * `fetchWithTimeout` keeps the body it captures on the thrown error and off
 * every client envelope, so an error page reaches the caller only through what
 * the message quotes. Its title ("414 Request-URI Too Long") is the part a
 * caller can read; the markup around it never goes out.
 */
export function describeHttpStatus(status: number, body: unknown): string {
  if (typeof body !== 'string' || !isHtmlPage(body)) return `HTTP ${status}`;
  const title = HTML_TITLE_PATTERN.exec(body)?.[1]
    ?.replace(TITLE_TAG_PATTERN, '')
    .replace(/\s+/g, ' ')
    .trim();
  return title ? `HTTP ${status} (${title})` : `HTTP ${status}`;
}

/** Name the operation while preserving HTTP, cancellation, and retry semantics. */
export function explainUpstreamFailure(error: unknown, operation: string): unknown {
  if (!(error instanceof McpError) || error.code === JsonRpcErrorCode.RequestCancelled)
    return error;
  const status = error.data?.status;
  const cause =
    typeof status === 'number'
      ? `returned ${describeHttpStatus(status, error.data?.body)}`
      : error.code === JsonRpcErrorCode.Timeout
        ? 'timed out'
        : 'failed to reach the upstream service';
  return new McpError(error.code, `${operation} ${cause}.`, error.data, { cause: error });
}
