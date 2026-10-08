/**
 * @fileoverview Read a resource through the framework's resource factory and
 * return the JSON-RPC error it answered with.
 * @module tests/helpers/resource-failure
 */

import type { AnyResourceDefinition } from '@cyanheads/mcp-ts-core';
import { createWorkerHandler } from '@cyanheads/mcp-ts-core/worker';

const PROTOCOL_VERSION = '2026-07-28';

/** The `error` member of a failed `resources/read` response. */
export interface ResourceFailure {
  code: number;
  data: Record<string, unknown> & { reason?: string; recovery?: { hint?: string } };
  message: string;
}

/**
 * Serve one resource definition and `resources/read` the given URI against it.
 *
 * A resource definition's `handler(...)` called directly returns the throw
 * site's `McpError` as built, with no recovery fill. Resources have no contract
 * runner, so assertions about what a client receives — the declared recovery
 * hint above all — go through the factory the server registers them with.
 * Throws when the read succeeds, which is a test failure either way.
 */
export async function resourceFailure(
  definition: AnyResourceDefinition,
  uri: string,
): Promise<ResourceFailure> {
  const worker = createWorkerHandler({
    name: 'resource-failure-test',
    title: 'resource-failure-test',
    resources: [definition],
  });
  const response = await worker.fetch(
    new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        Accept: 'application/json, text/event-stream',
        'Content-Type': 'application/json',
        'MCP-Protocol-Version': PROTOCOL_VERSION,
        'Mcp-Method': 'resources/read',
        'Mcp-Name': uri,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'resources/read',
        params: {
          uri,
          _meta: {
            'io.modelcontextprotocol/protocolVersion': PROTOCOL_VERSION,
            'io.modelcontextprotocol/clientInfo': {
              name: 'resource-failure-test',
              version: '1.0.0',
            },
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        },
      }),
    }),
    {},
    { waitUntil: () => {}, passThroughOnException: () => {} } as never,
  );
  const text = await response.text();
  const payload = (
    text.startsWith('event:') || text.startsWith('data:')
      ? JSON.parse(
          text
            .split('\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trim())
            .join('\n'),
        )
      : JSON.parse(text)
  ) as { error?: { code: number; message: string; data?: ResourceFailure['data'] } };
  if (!payload.error) throw new Error(`Expected resources/read to fail, got: ${text}`);
  return { ...payload.error, data: payload.error.data ?? {} };
}
