/**
 * @fileoverview Tests for the shared CDO input-validation schemas and the UTC
 * date normalization the range and ordering checks depend on.
 * @module tests/tools/validation-helpers.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it, vi } from 'vitest';
import {
  applyPageLimit,
  identifierArrayFilter,
  identifierFilter,
  isoDateFilter,
  normalizeStationId,
  stationIdArrayFilter,
  stationIdFilter,
  stationNormalizationNotice,
  toCdoWireDate,
  toUtcMillis,
} from '@/mcp-server/tools/definitions/shared/validation.js';

const metric = vi.hoisted(() => ({ add: vi.fn() }));
vi.mock('@cyanheads/mcp-ts-core/utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cyanheads/mcp-ts-core/utils')>()),
  createCounter: vi.fn(() => metric),
}));

describe('station identifiers', () => {
  const schema = stationIdFilter('Station.');
  it.each([
    ['USW00024233', 'GHCND:USW00024233'],
    [' usw00024233 ', 'GHCND:USW00024233'],
    ['ghcnd:usw00024233', 'GHCND:USW00024233'],
    [' \tGHCND:USW00024233\r\n', 'GHCND:USW00024233'],
    ['coop:454769', 'COOP:454769'],
    ['nexrad:katx', 'NEXRAD:KATX'],
    ['unfamiliar:abc-123', 'UNFAMILIAR:ABC-123'],
    ['unfamiliar:abc:123', 'UNFAMILIAR:ABC:123'],
  ])('accepts and canonicalizes %j as %s', (input, canonical) => {
    expect(schema.parse(input)).toBe(input);
    expect(normalizeStationId(input)).toBe(canonical);
    const json = z.toJSONSchema(schema, { io: 'input' });
    expect(new RegExp(json.pattern!).test(input)).toBe(true);
  });
  it.each([
    '',
    ' ',
    'KATX',
    '454769',
    'USW0002423',
    '12345678901',
    ':ABC',
    'COOP:',
    ' : ',
    'N:A B',
  ])('rejects ambiguous or malformed %j', (input) => {
    expect(schema.safeParse(input).success).toBe(false);
    expect(stationIdArrayFilter('Stations.').safeParse(['GHCND:USW00024233', input]).success).toBe(
      false,
    );
  });
  it('keeps canonical inputs silent and names changed inputs without altering other filters', () => {
    expect(stationNormalizationNotice(['GHCND:USW00024233', 'COOP:454769'])).toBeUndefined();
    expect(stationNormalizationNotice(['usw00024233'])).toBe(
      'Normalized station IDs: "usw00024233" → GHCND:USW00024233.',
    );
    expect(identifierFilter('Location.').parse(' lower:place ')).toBe(' lower:place ');
    expect(stationIdArrayFilter('Stations.').safeParse([]).success).toBe(false);
  });

  it.each([
    ['digits', (n: number) => '1'.repeat(n), 320_000],
    ['openers', (n: number) => '<a'.repeat(n / 2), 80_000],
    ['nested', (n: number) => '<a'.repeat(n / 4) + '>'.repeat(n / 2), 80_000],
    ['trailing break', (n: number) => `${'X'.repeat(n)}\ny`, 80_000],
    ['embedded breaks', (n: number) => '  \r\n'.repeat(n / 4), 80_000],
  ] as const)('station syntax timing stays bounded for %s', (_label, shape, maximum) => {
    const measure = (length: number) => {
      const input = shape(length);
      let least = Number.POSITIVE_INFINITY;
      for (let sample = 0; sample < 3; sample++) {
        const before = process.threadCpuUsage();
        for (let iteration = 0; iteration < 20; iteration++) schema.safeParse(input);
        const cpu = process.threadCpuUsage(before);
        least = Math.min(least, (cpu.user + cpu.system) / 20);
      }
      return least;
    };
    const baseline = measure(5000);
    for (let length = 10_000; length <= maximum; length *= 2) {
      const cpuMicros = measure(length);
      expect(cpuMicros).toBeLessThan(100_000);
      expect(cpuMicros / baseline).toBeLessThan(256);
    }
  });
});

describe('applyPageLimit', () => {
  it.each([
    [25, 1000, 25, false],
    [1000, 1000, 1000, false],
    [1001, 1000, 1000, true],
    [50, 100, 50, false],
    [100, 100, 100, false],
    [101, 100, 100, true],
    [Number.MAX_SAFE_INTEGER, 100, 100, true],
  ])('applies requested=%s maximum=%s as %s', (requested, maximum, applied, clamped) => {
    metric.add.mockClear();
    const ctx = createMockContext();
    const info = vi.spyOn(ctx.log, 'info');
    const result = applyPageLimit(requested, maximum, 'noaa_climate_list_datasets', ctx);
    expect(result.limit).toBe(applied);
    expect(metric.add).toHaveBeenCalledTimes(clamped ? 1 : 0);
    expect(info).toHaveBeenCalledTimes(clamped ? 1 : 0);
    if (clamped) {
      expect(result.notice).toContain(`Requested limit ${requested} was clamped to ${applied}`);
      expect(result.notice).toContain('increasing offset by the applied limit');
      expect(metric.add).toHaveBeenCalledWith(1, { 'mcp.tool.name': 'noaa_climate_list_datasets' });
      expect(info).toHaveBeenCalledWith('Read page limit clamped', {
        toolName: 'noaa_climate_list_datasets',
        requestedLimit: requested,
        appliedLimit: applied,
      });
    } else {
      expect(result.notice).toBeUndefined();
    }
  });
});

describe('isoDateFilter', () => {
  const schema = isoDateFilter('A date.');

  it.each([
    '2024-07-01',
    '2024-07-01T00:00:00',
    '2024-07-01T23:59:59',
    '2024-07-01T00:00:00.0',
    '2024-07-01T00:00:00.123456',
    '2024-02-29',
    '2000-02-29',
    // Compact, separator-free — live CDO accepts it everywhere but /data.
    '20240701',
    '20240229',
    // Unpadded month/day — live CDO accepts it everywhere but /data.
    '2024-7-1',
    '2024-7-01',
    '2024-07-1',
    '2024-7-1T12:30:45',
  ])('accepts %s', (v) => {
    expect(schema.parse(v)).toBe(v);
  });

  // Rewriting to the form CDO parses everywhere is toCdoWireDate's job, applied
  // where a tool builds its upstream params — the schema returns what it got.
  it('never rewrites an accepted value', () => {
    expect(schema.parse('20240701')).toBe('20240701');
    expect(schema.parse('2024-7-1')).toBe('2024-7-1');
  });

  it.each([
    'not-a-date',
    '',
    '   ',
    '2024-13-01',
    '2024-00-01',
    '2024-07-00',
    '2024-07-32',
    '2024-02-30',
    '2024-06-31',
    '2023-02-29',
    '2024-07-01T24:00:00',
    '2024-07-01T00:60:00',
    '2024-07-01T00:00:60',
    '2024-07-01T00:00',
    '2024-07-01 00:00:00',
    '2024-07-01T00:00:00Z',
    '2024-07-01T00:00:00-07:00',
    '2024/07/01',
    // Calendar overflow survives into the compact form.
    '20241301',
    '20240230',
    '20240631',
    '20230229',
    '20240001',
    '20240700',
    // ...and into the unpadded form.
    '2024-13-1',
    '2024-2-30',
    '2024-6-31',
    '2023-2-29',
    // Neither new form loosens the surrounding shape.
    '2024070',
    '202407011',
    '20240701T00:00:00',
    '2024-7-1T00:00',
  ])('rejects %j', (v) => {
    expect(() => schema.parse(v)).toThrow();
  });

  it('reports the format rule alone when the shape is wrong — no contradictory calendar message', () => {
    const result = schema.safeParse('2024/07/01');

    expect(result.success).toBe(false);
    const messages = result.error!.issues.map((i) => i.message);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(/must be YYYY-MM-DD/);
    expect(messages[0]).not.toMatch(/calendar/i);
  });

  it('reports the calendar rule alone when the shape is right but the day does not exist', () => {
    const result = schema.safeParse('2024-02-30');

    expect(result.success).toBe(false);
    const messages = result.error!.issues.map((i) => i.message);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(/calendar/i);
  });

  it('advertises the pattern to clients through JSON Schema', () => {
    const json = z.toJSONSchema(z.object({ d: schema }), { io: 'input' }) as unknown as {
      properties: { d: { pattern?: string; description?: string } };
    };
    expect(json.properties.d.pattern).toBeDefined();
    expect(json.properties.d.description).toBe('A date.');
  });
});

describe('identifierFilter', () => {
  const schema = identifierFilter('An ID.');

  it.each(['GHCND', 'GHCND:USC00450974', 'FIPS:37', 'ZIP:98101', 'a'])(
    'accepts %s unmodified',
    (v) => {
      expect(schema.parse(v)).toBe(v);
    },
  );

  it.each(['', ' ', '   ', '\t', '\n', ' \t\n '])('rejects %j', (v) => {
    expect(() => schema.parse(v)).toThrow();
  });

  it('reports a single message for an empty string — min-length and blank-check must not both fire', () => {
    const result = schema.safeParse('');

    expect(result.success).toBe(false);
    expect(result.error!.issues).toHaveLength(1);
  });

  it('reports a single message for a whitespace-only string', () => {
    const result = schema.safeParse('   ');

    expect(result.success).toBe(false);
    expect(result.error!.issues).toHaveLength(1);
  });

  it('preserves surrounding whitespace on an otherwise real ID rather than trimming it', () => {
    expect(schema.parse(' GHCND ')).toBe(' GHCND ');
  });
});

describe('identifierArrayFilter', () => {
  const schema = identifierArrayFilter('IDs.');

  it('accepts a populated array unmodified', () => {
    expect(schema.parse(['TMAX', 'TMIN'])).toEqual(['TMAX', 'TMIN']);
  });

  it.each([[[]], [['']], [['   ']], [['TMAX', '']], [['', 'TMAX']], [['TMAX', '  ']]])(
    'rejects %j',
    (v) => {
      expect(() => schema.parse(v)).toThrow();
    },
  );

  it('advertises minItems and minLength to clients', () => {
    const json = z.toJSONSchema(z.object({ ids: schema }), { io: 'input' }) as unknown as {
      properties: { ids: { minItems?: number; items?: { minLength?: number } } };
    };
    expect(json.properties.ids.minItems).toBe(1);
    expect(json.properties.ids.items?.minLength).toBe(1);
  });
});

describe('toUtcMillis', () => {
  it('reads a bare date as UTC midnight', () => {
    expect(toUtcMillis('2024-07-01')).toBe(Date.UTC(2024, 6, 1));
  });

  it('reads the compact form as the same instant as the dashed form', () => {
    expect(toUtcMillis('20240701')).toBe(Date.UTC(2024, 6, 1));
    expect(toUtcMillis('20240701')).toBe(toUtcMillis('2024-07-01'));
  });

  it('reads the unpadded form as the same instant as the dashed form', () => {
    expect(toUtcMillis('2024-7-1')).toBe(Date.UTC(2024, 6, 1));
    expect(toUtcMillis('2024-7-1')).toBe(toUtcMillis('2024-07-01'));
    expect(toUtcMillis('2024-7-1T12:30:45')).toBe(Date.UTC(2024, 6, 1, 12, 30, 45));
  });

  it('returns a finite number for every accepted form — NaN would silently disable the range and ordering guards', () => {
    for (const v of ['2024-07-01', '2024-07-01T12:30:45', '20240701', '2024-7-1', '2024-7-01']) {
      expect(Number.isNaN(toUtcMillis(v))).toBe(false);
    }
  });

  it('measures an equal span across mixed forms', () => {
    const day = 86_400_000;
    expect(toUtcMillis('20240708') - toUtcMillis('20240701')).toBe(7 * day);
    expect(toUtcMillis('2024-07-08') - toUtcMillis('20240701')).toBe(7 * day);
    expect(toUtcMillis('2024-7-8') - toUtcMillis('2024-7-1')).toBe(7 * day);
  });

  it('orders the compact and unpadded forms against each other correctly', () => {
    expect(toUtcMillis('20240710')).toBeGreaterThan(toUtcMillis('20240701'));
    expect(toUtcMillis('2024-7-10')).toBeGreaterThan(toUtcMillis('2024-7-1'));
    expect(toUtcMillis('20240710')).toBeGreaterThan(toUtcMillis('2024-07-01'));
  });

  it('puts the bare-date and datetime-midnight forms on the same instant', () => {
    expect(toUtcMillis('2024-07-01T00:00:00')).toBe(toUtcMillis('2024-07-01'));
  });

  it('is independent of the host timezone', () => {
    expect(toUtcMillis('2024-01-01T00:00:00')).toBe(Date.UTC(2024, 0, 1));
    expect(toUtcMillis('2024-07-01T12:30:45')).toBe(Date.UTC(2024, 6, 1, 12, 30, 45));
  });

  it('measures an equal span regardless of which form each end uses', () => {
    const day = 86_400_000;
    expect(toUtcMillis('2024-07-08') - toUtcMillis('2024-07-01')).toBe(7 * day);
    expect(toUtcMillis('2024-07-08') - toUtcMillis('2024-07-01T00:00:00')).toBe(7 * day);
    expect(toUtcMillis('2024-07-08T00:00:00') - toUtcMillis('2024-07-01')).toBe(7 * day);
  });

  it('orders a datetime after the bare date of the same day', () => {
    expect(toUtcMillis('2024-07-01T00:00:01')).toBeGreaterThan(toUtcMillis('2024-07-01'));
  });
});

describe('toCdoWireDate', () => {
  it.each([
    ['20240701', '2024-07-01'],
    ['20240229', '2024-02-29'],
    ['2024-7-1', '2024-07-01'],
    ['2024-7-01', '2024-07-01'],
    ['2024-07-1', '2024-07-01'],
    ['2024-7-1T12:30:45', '2024-07-01T12:30:45'],
  ])('rewrites %s to %s', (input, canonical) => {
    expect(toCdoWireDate(input)).toBe(canonical);
  });

  it.each(['2024-07-01', '2024-07-01T12:30:45', '2024-07-01T23:59:59.123'])(
    'leaves the already-canonical %s untouched',
    (v) => {
      expect(toCdoWireDate(v)).toBe(v);
    },
  );

  it('passes undefined through so an optional filter needs no call-site guard', () => {
    expect(toCdoWireDate(undefined)).toBeUndefined();
  });

  it('agrees with toUtcMillis on the instant every accepted form names', () => {
    for (const v of ['20240701', '2024-7-1', '2024-07-01', '2024-7-1T12:30:45']) {
      expect(toUtcMillis(toCdoWireDate(v) as string)).toBe(toUtcMillis(v));
    }
  });
});
