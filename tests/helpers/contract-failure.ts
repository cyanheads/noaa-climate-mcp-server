/**
 * @fileoverview Run a tool through the framework's contract runner and return
 * the error envelope it produced.
 * @module tests/helpers/contract-failure
 */

import { runToolContract } from '@cyanheads/mcp-ts-core/testing';

/** The `structuredContent.error` a failed tool call carries, plus its rendered text. */
export interface ContractFailure {
  code: number;
  data: Record<string, unknown> & {
    reason?: string;
    recovery?: { hint?: string };
    retryable?: boolean;
  };
  message: string;
  /** The `content[]` text a client that reads only the rendered surface sees. */
  text: string;
}

/**
 * Call a tool the way the production handler factory does and read back its
 * failure.
 *
 * A direct `definition.handler(...)` call returns the `McpError` exactly as the
 * throw site built it. The contract runner applies what the wire carries on
 * top: the declared `recovery` hint for a reason thrown without one. Assertions
 * about what a caller receives go through here. Throws when the call succeeds,
 * which is a test failure either way.
 */
export async function contractFailure(
  ...args: Parameters<typeof runToolContract>
): Promise<ContractFailure> {
  const result = await runToolContract(...args);
  if (!result.isError) throw new Error('Expected the tool call to fail.');
  const { error } = result.structuredContent as {
    error: { code: number; message: string; data?: ContractFailure['data'] };
  };
  const text = result.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n');
  return { code: error.code, message: error.message, data: error.data ?? {}, text };
}
