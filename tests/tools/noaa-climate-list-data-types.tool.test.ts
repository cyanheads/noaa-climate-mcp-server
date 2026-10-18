/**
 * @fileoverview Tests for the noaa_climate_list_data_types tool.
 * @module tests/tools/noaa-climate-list-data-types.tool.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { noaaClimateListDataTypes } from '@/mcp-server/tools/definitions/noaa-climate-list-data-types.tool.js';
import { firstText } from '../helpers/content.js';

vi.mock('@/services/cdo/cdo-service.js', () => ({
  getCdoService: vi.fn(),
}));

import { getCdoService } from '@/services/cdo/cdo-service.js';

const mockDataTypes = [
  {
    id: 'TMAX',
    name: 'Maximum temperature',
    datacoverage: 0.99,
    mindate: '1763-01-01',
    maxdate: '2024-12-31',
  },
  { id: 'PRCP', name: 'Precipitation' }, // sparse — omit optional fields
];

beforeEach(() => {
  vi.mocked(getCdoService).mockReturnValue({
    listDataTypes: vi.fn().mockResolvedValue({
      results: mockDataTypes,
      metadata: { resultset: { count: 2, limit: 25, offset: 0 } },
    }),
  } as unknown as ReturnType<typeof getCdoService>);
});

describe('noaaClimateListDataTypes', () => {
  it.each([0, 0.9969, 1])('preserves fractional coverage %s', (datacoverage) => {
    expect(
      firstText(
        noaaClimateListDataTypes.format!({
          results: [{ id: 'TMAX', name: 'Maximum temperature', datacoverage }],
        }),
      ),
    ).toContain(`**Coverage (0–1):** ${datacoverage}`);
  });
  it('returns data type results with optional fields', async () => {
    const ctx = createMockContext({ errors: noaaClimateListDataTypes.errors });
    const input = noaaClimateListDataTypes.input.parse({ datasetId: 'GHCND' });
    const result = await noaaClimateListDataTypes.handler(input, ctx);

    expect(result.results).toHaveLength(2);
    expect(result.results[0]).toMatchObject({
      id: 'TMAX',
      name: 'Maximum temperature',
      datacoverage: 0.99,
    });
    expect(result.results[0]!.mindate).toBe('1763-01-01');
    expect(getEnrichment(ctx)).toMatchObject({ totalCount: 2 });
    expect(getEnrichment(ctx)).not.toHaveProperty('notice');
  });

  it('enriches with notice when no data types matched', async () => {
    vi.mocked(getCdoService).mockReturnValue({
      listDataTypes: vi.fn().mockResolvedValue({
        results: [],
        metadata: { resultset: { count: 0, limit: 25, offset: 0 } },
      }),
    } as unknown as ReturnType<typeof getCdoService>);
    const ctx = createMockContext({ errors: noaaClimateListDataTypes.errors });
    const input = noaaClimateListDataTypes.input.parse({ datasetId: 'UNKNOWN' });
    await noaaClimateListDataTypes.handler(input, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalCount).toBe(0);
    expect(typeof enrichment.notice).toBe('string');
    expect(enrichment.notice as string).toContain('No data types matched');
  });

  it('preserves sparse upstream payloads — omits optional fields when absent', async () => {
    const ctx = createMockContext({ errors: noaaClimateListDataTypes.errors });
    const input = noaaClimateListDataTypes.input.parse({});
    const result = await noaaClimateListDataTypes.handler(input, ctx);

    const prcp = result.results.find((dt) => dt.id === 'PRCP');
    expect(prcp).toBeDefined();
    expect(prcp!.datacoverage).toBeUndefined();
    expect(prcp!.mindate).toBeUndefined();
    expect(prcp!.maxdate).toBeUndefined();
  });

  it('formats output with IDs, names, and optional coverage/dates', () => {
    const blocks = noaaClimateListDataTypes.format!({
      results: [
        {
          id: 'TMAX',
          name: 'Maximum temperature',
          datacoverage: 0.99,
          mindate: '1763-01-01',
          maxdate: '2024-12-31',
        },
      ],
      metadata: { resultset: { count: 1, limit: 25, offset: 0 } },
    });
    const text = firstText(blocks);
    expect(text).toContain('TMAX');
    expect(text).toContain('Maximum temperature');
    expect(text).toContain('**Coverage (0–1):** 0.99');
    expect(text).toContain('0'); // offset
  });

  it('formats sparse entries without fabricating unknown values', () => {
    const blocks = noaaClimateListDataTypes.format!({
      results: [{ id: 'PRCP', name: 'Precipitation' }],
    });
    const text = firstText(blocks);
    expect(text).toContain('PRCP');
    expect(text).not.toContain('Coverage');
    expect(text).not.toContain('Range');
  });
});
