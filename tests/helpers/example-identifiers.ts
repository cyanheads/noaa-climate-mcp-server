/**
 * @fileoverview Reads the example identifiers the server hands an agent off the
 * surfaces an agent actually copies from — tool descriptions, `.describe()`
 * prose, recovery hints, the README, and the design doc — and classifies each
 * by the CDO collection its prefix addresses.
 *
 * Extraction and classification live here, apart from the network check, so the
 * rules that decide *what counts as an identifier* are pinned by a hermetic
 * unit test while resolving them stays in the opt-in live lane.
 *
 * @module tests/helpers/example-identifiers
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Surfaces an agent reads an example identifier from.
 *
 * Test fixtures are deliberately absent: `tests/` mock IDs stand in for
 * upstream records and are not expected to resolve.
 */
export const DOCUMENTED_SOURCE_FILES = [
  'src/mcp-server/tools/definitions/noaa-climate-fetch-data.tool.ts',
  'src/mcp-server/tools/definitions/noaa-climate-find-locations.tool.ts',
  'src/mcp-server/tools/definitions/noaa-climate-find-stations.tool.ts',
  'src/mcp-server/tools/definitions/noaa-climate-get-billion-dollar-disasters.tool.ts',
  'src/mcp-server/tools/definitions/noaa-climate-get-normals.tool.ts',
  'src/mcp-server/tools/definitions/noaa-climate-get-station.tool.ts',
  'src/mcp-server/tools/definitions/noaa-climate-list-data-categories.tool.ts',
  'src/mcp-server/tools/definitions/noaa-climate-list-data-types.tool.ts',
  'src/mcp-server/tools/definitions/noaa-climate-list-datasets.tool.ts',
  'src/mcp-server/tools/definitions/noaa-climate-list-location-categories.tool.ts',
  'src/mcp-server/tools/definitions/noaa-climate-search-storm-events.tool.ts',
  'src/mcp-server/tools/definitions/shared/validation.ts',
  'src/mcp-server/resources/definitions/noaa-datasets.resource.ts',
  'src/mcp-server/resources/definitions/noaa-station.resource.ts',
  'src/index.ts',
  'README.md',
  'docs/design.md',
  'skills/noaa-climate-guide/SKILL.md',
];

/**
 * The design doc's decisions log is history, not instruction.
 *
 * It records the IDs that turned out *not* to resolve, and why they were
 * replaced — `GHCND:USC00450974` is there precisely because CDO answers it with
 * a bare `{}`. Reading that section as a source of examples would make the
 * record of a fixed bug fail the check that exists to prevent it.
 */
const DECISIONS_LOG_HEADING = '## Decisions Log';

/**
 * Prefixes that make a token an addressable CDO record, mapped to the
 * collection that resolves it.
 *
 * A prefix outside this map is a failure, not a token to skip. The prefix is
 * where these examples go wrong most cheaply: `CLIM_REG` is a location
 * *category* and never an ID prefix — the climate regions are `CLIM:104` — so a
 * documented `CLIM_REG:SOUTHATL` is unresolvable at the prefix, before its
 * value is even in question. Silently skipping what the map does not recognize
 * would let exactly that class through unchecked.
 */
export const ID_PREFIX_ENDPOINTS: Record<string, string> = {
  FIPS: 'locations',
  CITY: 'locations',
  ZIP: 'locations',
  CLIM: 'locations',
  GHCND: 'stations',
  COOP: 'stations',
  WBAN: 'stations',
  ICAO: 'stations',
  NEXRAD: 'stations',
};

/**
 * Any `PREFIX:VALUE` token, with the prefix constrained to three or more
 * letters and underscores and required to start a word.
 *
 * Both constraints exist to keep the date-format prose out. The length and
 * letters-only rule drops the clock in `T23:59:59`; the lookbehind drops
 * `DDTHH:MM`, the tail of `YYYY-MM-DDTHH:MM:SS`, which is otherwise a
 * five-letter prefix followed by a colon and would be reported as a dead
 * identifier every time a description spelled out the datetime form. Every real
 * CDO prefix is written after a quote, backtick, bracket, or space, so none of
 * them is affected.
 */
const IDENTIFIER_PATTERN = /(?<![\w-])([A-Z][A-Z_]{2,}):([A-Za-z0-9_]+)\b/g;

export type ExampleIdentifier = {
  /** The full token as written, e.g. `GHCND:USW00024233`. */
  id: string;
  /** The portion before the colon, e.g. `GHCND`. */
  prefix: string;
  /** Repo-relative paths this token was found on. */
  sources: string[];
};

const repoFile = (relative: string) => fileURLToPath(new URL(`../../${relative}`, import.meta.url));

/** One source file's text, with the decisions log's historical record dropped. */
export function readDocumentedText(relativePath: string): string {
  const text = readFileSync(repoFile(relativePath), 'utf8');
  const logStart = text.indexOf(DECISIONS_LOG_HEADING);
  return logStart === -1 ? text : text.slice(0, logStart);
}

/** Every prefixed identifier occurrence in `text`, in the order it appears. */
export function extractIdentifiers(text: string): { id: string; prefix: string }[] {
  return [...text.matchAll(IDENTIFIER_PATTERN)].map(([id, prefix = '']) => ({ id, prefix }));
}

/** Every distinct prefixed identifier an agent could copy off the documented surfaces. */
export function collectExampleIdentifiers(
  sourceFiles: string[] = DOCUMENTED_SOURCE_FILES,
): ExampleIdentifier[] {
  const found = new Map<string, ExampleIdentifier>();
  for (const relativePath of sourceFiles) {
    for (const { id, prefix } of extractIdentifiers(readDocumentedText(relativePath))) {
      const entry = found.get(id) ?? { id, prefix, sources: [] };
      if (!entry.sources.includes(relativePath)) entry.sources.push(relativePath);
      found.set(id, entry);
    }
  }
  return [...found.values()].sort((a, b) => a.id.localeCompare(b.id));
}
