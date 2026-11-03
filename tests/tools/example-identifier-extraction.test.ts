/**
 * @fileoverview Pins the rules that decide which strings in the server's prose
 * count as example identifiers, and which of those address a real CDO
 * collection.
 *
 * The resolving half runs against the live API in the opt-in `live` project.
 * This half is hermetic and guards the classifier itself — a rule that quietly
 * stopped matching would make that lane pass by checking nothing.
 *
 * @module tests/tools/example-identifier-extraction.test
 */

import { describe, expect, it } from 'vitest';
import {
  collectExampleIdentifiers,
  DOCUMENTED_SOURCE_FILES,
  extractIdentifiers,
  ID_PREFIX_ENDPOINTS,
  readDocumentedText,
} from '../helpers/example-identifiers.js';

const idsIn = (text: string) => extractIdentifiers(text).map((entry) => entry.id);

describe('identifier extraction', () => {
  it('picks up every CDO identifier form the surfaces use', () => {
    expect(
      idsIn(
        'Location IDs: states as FIPS:37 (NC), cities as CITY:US530018, zips as ZIP:98101, countries as FIPS:US, climate regions as CLIM:104.',
      ),
    ).toEqual(['FIPS:37', 'CITY:US530018', 'ZIP:98101', 'FIPS:US', 'CLIM:104']);
  });

  it('picks up station identifier forms', () => {
    expect(idsIn('e.g. "GHCND:USW00024233", "COOP:010008", "NEXRAD:KATX"')).toEqual([
      'GHCND:USW00024233',
      'COOP:010008',
      'NEXRAD:KATX',
    ]);
  });

  it('does not mistake a clock time in date-format prose for an identifier', () => {
    expect(idsIn('a `T23:59:59` end that CDO accepts, or YYYY-MM-DDTHH:MM:SS')).toEqual([]);
  });

  it('extracts a token whose prefix names a location category rather than an ID prefix', () => {
    // The exact shape of the bug this whole check exists for: `CLIM_REG` is a
    // location category, so `CLIM_REG:SOUTHATL` addresses nothing. It has to be
    // extracted before it can be reported as unaddressable.
    expect(idsIn('| `CLIM_REG:{id}` | `CLIM_REG:SOUTHATL` | NOAA climate region |')).toContain(
      'CLIM_REG:SOUTHATL',
    );
  });

  it('classifies a location-category prefix as addressing no CDO collection', () => {
    const [extracted] = extractIdentifiers('CLIM_REG:SOUTHATL');
    expect(extracted?.prefix).toBe('CLIM_REG');
    expect(ID_PREFIX_ENDPOINTS[extracted?.prefix ?? '']).toBeUndefined();
  });

  it('routes each addressable prefix to the collection that resolves it', () => {
    expect(ID_PREFIX_ENDPOINTS.FIPS).toBe('locations');
    expect(ID_PREFIX_ENDPOINTS.CITY).toBe('locations');
    expect(ID_PREFIX_ENDPOINTS.ZIP).toBe('locations');
    expect(ID_PREFIX_ENDPOINTS.CLIM).toBe('locations');
    expect(ID_PREFIX_ENDPOINTS.GHCND).toBe('stations');
    expect(ID_PREFIX_ENDPOINTS.COOP).toBe('stations');
    expect(ID_PREFIX_ENDPOINTS.NEXRAD).toBe('stations');
  });
});

describe('documented surfaces', () => {
  it('reads every listed source file', () => {
    for (const relativePath of DOCUMENTED_SOURCE_FILES) {
      expect(readDocumentedText(relativePath).length).toBeGreaterThan(0);
    }
  });

  it('stops reading the design doc at its decisions log', () => {
    const text = readDocumentedText('docs/design.md');
    expect(text).not.toContain('## Decisions Log');
    // The log records a station ID that never resolved; it is history, and must
    // not be read back as an example to check.
    expect(text).not.toContain('GHCND:USC00450974');
  });

  it('finds identifiers to check, and every one addresses a CDO collection', () => {
    const identifiers = collectExampleIdentifiers();
    expect(identifiers.length).toBeGreaterThan(0);

    const unaddressable = identifiers.filter((entry) => !ID_PREFIX_ENDPOINTS[entry.prefix]);
    expect(
      unaddressable,
      `These example identifiers carry a prefix that addresses no CDO collection: ${unaddressable
        .map((entry) => `${entry.id} (${entry.sources.join(', ')})`)
        .join('; ')}`,
    ).toEqual([]);
  });
});
