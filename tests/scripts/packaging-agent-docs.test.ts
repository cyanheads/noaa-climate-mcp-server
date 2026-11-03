/**
 * @fileoverview Bundle cleanup preserves runtime skill modules while removing package-root agent docs.
 * @module tests/scripts/packaging-agent-docs
 */
import { describe, expect, it } from 'vitest';
import { AGENT_DOC_ENTRY as cleaner } from '../../scripts/clean-mcpb.js';
import { AGENT_DOC_ENTRY as linter } from '../../scripts/lint-packaging.js';

describe.each([
  ['cleaner', cleaner],
  ['linter', linter],
] as const)('%s agent-doc selector', (_name, pattern) => {
  it.each([
    'node_modules/@modelcontextprotocol/server/dist/ext/skills/index.js',
    'node_modules/@modelcontextprotocol/server/dist/ext/skills/loader.js',
    'node_modules/example/dist/skills/runtime.js',
    'node_modules/example/node_modules/@modelcontextprotocol/server/dist/ext/skills/index.js',
    'skills/noaa-climate-workflow/SKILL.md',
  ])('preserves runtime or published entry %s', (entry) => {
    expect(pattern.test(entry)).toBe(false);
  });

  it.each([
    'node_modules/@cyanheads/mcp-ts-core/framework-skills/add-tool/SKILL.md',
    'node_modules/example/skills/workflow/SKILL.md',
    'node_modules/example/.claude/config.json',
    'node_modules/example/.agents/config.json',
    'node_modules/example/SKILL.md',
    'node_modules/example/node_modules/@scope/nested/skills/workflow/SKILL.md',
  ])('removes package-root agent entry %s', (entry) => {
    expect(pattern.test(entry)).toBe(true);
  });
});
