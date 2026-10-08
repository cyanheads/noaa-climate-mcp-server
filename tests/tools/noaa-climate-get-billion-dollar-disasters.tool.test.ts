/**
 * @fileoverview Tests for the noaa_climate_get_billion_dollar_disasters tool —
 * both consumption surfaces, the declared error contract, and the boundaries
 * (empty result, cap reached, offset past the end, rejected input).
 * @module tests/tools/noaa-climate-get-billion-dollar-disasters.tool.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { noaaClimateGetBillionDollarDisasters as billionDollarDisasters } from '@/mcp-server/tools/definitions/noaa-climate-get-billion-dollar-disasters.tool.js';
import { firstText } from '../helpers/content.js';
import { contractFailure } from '../helpers/contract-failure.js';

vi.mock(
  '@/services/billion-dollar-disasters/billion-dollar-disasters-service.js',
  async (importOriginal) => {
    const original =
      await importOriginal<
        typeof import('@/services/billion-dollar-disasters/billion-dollar-disasters-service.js')
      >();
    return { ...original, getBillionDollarDisastersService: vi.fn() };
  },
);

import { getBillionDollarDisastersService } from '@/services/billion-dollar-disasters/billion-dollar-disasters-service.js';

const ONE_BILLION = 1_000_000_000;

const NATIONAL_SOURCE = {
  sourceFile: 'events-US.csv',
  declaredCostUnit: 'millions of dollars',
  firstYear: 1980,
  lastYear: 2024,
};

const HELENE = {
  name: 'Hurricane Helene (September 2024)',
  disasterType: 'Tropical Cyclone',
  beginDate: '2024-09-24',
  endDate: '2024-09-29',
  cpiAdjustedCostInUsd: 78_721_000_000,
  unadjustedCostInUsd: 78_721_000_000,
  deaths: 219,
};

const MILTON = {
  name: 'Hurricane Milton (October 2024)',
  disasterType: 'Tropical Cyclone',
  beginDate: '2024-10-09',
  endDate: '2024-10-10',
  cpiAdjustedCostInUsd: 34_250_000_000,
  unadjustedCostInUsd: 34_250_000_000,
  deaths: 32,
};

const NATIONAL_SUMMARY_SOURCE = {
  sourceFile: 'time-series-US.csv',
  declaredCostUnit: 'billions of dollars',
  firstYear: 1980,
  lastYear: 2024,
};

const YEAR_2024 = {
  year: 2024,
  byDisasterType: [
    {
      disasterType: 'Tropical Cyclone',
      eventCount: 5,
      costInUsd: 124 * ONE_BILLION,
      confidenceBoundsInUsd: {
        lower75: 104.2 * ONE_BILLION,
        upper75: 143.5 * ONE_BILLION,
        lower90: 100.1 * ONE_BILLION,
        upper90: 147.9 * ONE_BILLION,
        lower95: 96.9 * ONE_BILLION,
        upper95: 152.4 * ONE_BILLION,
      },
    },
    { disasterType: 'All Disasters', eventCount: 27, costInUsd: 182.7 * ONE_BILLION },
  ],
};

const STATE_YEAR_2022 = {
  year: 2022,
  byDisasterType: [
    {
      disasterType: 'Wildfire',
      eventCount: 1,
      costRangeInUsd: { low: 1_000_000_000, high: 2_000_000_000 },
    },
  ],
};

function mockService(overrides: { searchEvents?: unknown; searchSummaries?: unknown }): void {
  vi.mocked(getBillionDollarDisastersService).mockReturnValue({
    searchEvents: vi.fn().mockResolvedValue({
      ...NATIONAL_SOURCE,
      disasters: [HELENE, MILTON],
      totalCount: 2,
      disasterTypesInFile: ['Drought', 'Flooding', 'Tropical Cyclone'],
    }),
    searchSummaries: vi.fn().mockResolvedValue({
      ...NATIONAL_SUMMARY_SOURCE,
      summaries: [YEAR_2024],
      totalCount: 1,
    }),
    ...overrides,
  } as unknown as ReturnType<typeof getBillionDollarDisastersService>);
}

const parse = (input: Record<string, unknown>) => billionDollarDisasters.input.parse(input);

const run = (input: Record<string, unknown>) => {
  const ctx = createMockContext({ errors: billionDollarDisasters.errors });
  return { ctx, result: billionDollarDisasters.handler(parse(input), ctx) };
};

async function captureFailure(input: Record<string, unknown>): Promise<McpError> {
  try {
    await run(input).result;
  } catch (error) {
    if (error instanceof McpError) return error;
    throw error;
  }
  throw new Error('Expected the handler to throw.');
}

beforeEach(() => {
  mockService({});
});

describe('events mode — structuredContent', () => {
  it('returns individual disasters with costs in whole US dollars', async () => {
    const { result } = run({});
    const output = await result;

    expect(output.mode).toBe('events');
    expect(output.scope).toBe('US');
    expect(output.sourceFile).toBe('events-US.csv');
    expect(output.declaredCostUnit).toBe('millions of dollars');
    expect(output.coveredYears).toEqual({ first: 1980, last: 2024 });
    expect(output.summaries).toBeUndefined();
    expect(output.disasters?.[0]).toEqual(HELENE);
    // The 1000x trap: Helene is 78,721 million, never 78,721 billion.
    expect(output.disasters?.[0]?.cpiAdjustedCostInUsd).toBe(78_721_000_000);
    expect(output.disasters?.[0]?.cpiAdjustedCostInUsd).not.toBe(78_721_000_000_000);
  });

  it('reports the match total through enrichment', async () => {
    const { ctx, result } = run({});
    await result;

    expect(getEnrichment(ctx).totalCount).toBe(2);
    expect(getEnrichment(ctx)).not.toHaveProperty('notice');
  });
});

describe('events mode — rendered content', () => {
  it('renders every disaster field, with the unit stated unambiguously', async () => {
    const { result } = run({});
    const text = firstText(billionDollarDisasters.format!(await result));

    expect(text).toContain('Hurricane Helene (September 2024)');
    expect(text).toContain('Tropical Cyclone');
    expect(text).toContain('2024-09-24 – 2024-09-29');
    expect(text).toContain('$78,721,000,000 USD');
    expect(text).toContain('**Deaths:** 219');
    expect(text).toContain('whole US dollars');
    expect(text).toContain('millions of dollars');
    expect(text).toContain('**Coverage:** 1980–2024');
    expect(text).toContain('events-US.csv');
  });

  it('never renders a per-event cost as though it were billions', async () => {
    const { result } = run({});
    const text = firstText(billionDollarDisasters.format!(await result));

    expect(text).not.toContain('78,721 billion');
    expect(text).not.toContain('$78,721 ');
  });

  it('renders the empty-page marker when nothing is on the page', async () => {
    mockService({
      searchEvents: vi.fn().mockResolvedValue({
        ...NATIONAL_SOURCE,
        disasters: [],
        totalCount: 0,
        disasterTypesInFile: [],
      }),
    });
    const { result } = run({});
    const text = firstText(billionDollarDisasters.format!(await result));

    expect(text).toContain('_No records on this page._');
  });
});

describe('summary mode', () => {
  it('returns per-year tallies instead of disasters', async () => {
    const { result } = run({ summary: true });
    const output = await result;

    expect(output.mode).toBe('summary');
    expect(output.sourceFile).toBe('time-series-US.csv');
    expect(output.declaredCostUnit).toBe('billions of dollars');
    expect(output.disasters).toBeUndefined();
    expect(output.summaries?.[0]?.year).toBe(2024);
    expect(
      output.summaries?.[0]?.byDisasterType.find((t) => t.disasterType === 'All Disasters')
        ?.costInUsd,
    ).toBe(182_700_000_000);
  });

  it('renders counts, costs, and confidence bands', async () => {
    const { result } = run({ summary: true });
    const text = firstText(billionDollarDisasters.format!(await result));

    expect(text).toContain('## 2024');
    expect(text).toContain('**Tropical Cyclone:** 5 events');
    expect(text).toContain('**All Disasters:** 27 events');
    expect(text).toContain('$124,000,000,000 USD');
    expect(text).toContain('$182,700,000,000 USD');
    expect(text).toContain('95% $96,900,000,000–$152,400,000,000');
  });

  it('renders a state scope’s binned range and says it is not a point estimate', async () => {
    mockService({
      searchSummaries: vi.fn().mockResolvedValue({
        sourceFile: 'time-series-CA.csv',
        declaredCostUnit: 'millions of dollars',
        firstYear: 1980,
        lastYear: 2024,
        summaries: [STATE_YEAR_2022],
        totalCount: 1,
      }),
    });
    const { result } = run({ summary: true, state: 'CA' });
    const output = await result;
    const text = firstText(billionDollarDisasters.format!(output));

    expect(output.scope).toBe('CA');
    expect(output.summaries?.[0]?.byDisasterType[0]?.costRangeInUsd).toEqual({
      low: 1_000_000_000,
      high: 2_000_000_000,
    });
    // A single disaster reads as "1 event", never "1 events".
    expect(text).toContain('**Wildfire:** 1 event |');
    expect(text).toContain('$1,000,000,000–$2,000,000,000 USD');
    expect(text).toContain('range, not a point estimate');
  });

  it('renders the empty-page marker in summary mode too', async () => {
    mockService({
      searchSummaries: vi
        .fn()
        .mockResolvedValue({ ...NATIONAL_SUMMARY_SOURCE, summaries: [], totalCount: 0 }),
    });
    const { result } = run({ summary: true });
    const text = firstText(billionDollarDisasters.format!(await result));

    expect(text).toContain('_No records on this page._');
  });
});

describe('scope and filter forwarding', () => {
  it('upper-cases the state on the response and forwards it to the service', async () => {
    const searchEvents = vi.fn().mockResolvedValue({
      ...NATIONAL_SOURCE,
      sourceFile: 'events-CA.csv',
      disasters: [],
      totalCount: 0,
      disasterTypesInFile: [],
    });
    mockService({ searchEvents });

    const output = await run({ state: 'ca' }).result;

    expect(output.scope).toBe('CA');
    expect(searchEvents.mock.calls[0]?.[0]).toMatchObject({ state: 'ca' });
  });

  it('forwards every filter to the service', async () => {
    const searchEvents = vi.fn().mockResolvedValue({
      ...NATIONAL_SOURCE,
      disasters: [HELENE],
      totalCount: 1,
      disasterTypesInFile: ['Tropical Cyclone'],
    });
    mockService({ searchEvents });

    await run({
      startYear: 2000,
      endYear: 2024,
      disasterType: 'Tropical Cyclone',
      minCostInUsd: ONE_BILLION,
      limit: 10,
      offset: 5,
    }).result;

    expect(searchEvents.mock.calls[0]?.[0]).toEqual({
      startYear: 2000,
      endYear: 2024,
      disasterType: 'Tropical Cyclone',
      minCostInUsd: ONE_BILLION,
      limit: 10,
      offset: 5,
    });
  });

  it('omits filters the caller did not supply rather than sending defaults', async () => {
    const searchEvents = vi.fn().mockResolvedValue({
      ...NATIONAL_SOURCE,
      disasters: [],
      totalCount: 0,
      disasterTypesInFile: [],
    });
    mockService({ searchEvents });

    await run({}).result;

    expect(searchEvents.mock.calls[0]?.[0]).toEqual({ limit: 50, offset: 0 });
  });
});

describe('input validation', () => {
  it('accepts the seven disaster classes exactly as NCEI writes them', () => {
    for (const type of [
      'Drought',
      'Flooding',
      'Freeze',
      'Severe Storm',
      'Tropical Cyclone',
      'Wildfire',
      'Winter Storm',
    ]) {
      expect(parse({ disasterType: type }).disasterType).toBe(type);
    }
  });

  it('rejects a lower-case disaster class instead of coercing it', () => {
    expect(() => parse({ disasterType: 'tropical cyclone' })).toThrow();
  });

  it('rejects a kebab-case disaster class instead of ignoring it', () => {
    expect(() => parse({ disasterType: 'tropical-cyclone' })).toThrow();
  });

  it('rejects a year before the corpus begins', () => {
    expect(() => parse({ startYear: 1979 })).toThrow();
    expect(() => parse({ endYear: 1979 })).toThrow();
  });

  it('rejects a fractional year', () => {
    expect(() => parse({ startYear: 2024.5 })).toThrow();
  });

  it('rejects a blank state code', () => {
    expect(() => parse({ state: '   ' })).toThrow();
  });

  it('rejects a negative cost floor', () => {
    expect(() => parse({ minCostInUsd: -1 })).toThrow();
  });

  it('rejects a limit outside 1–100', () => {
    expect(() => parse({ limit: 0 })).toThrow();
    expect(() => parse({ limit: 101 })).toThrow();
  });

  it('defaults to the events mode, a 50-record page, and no offset', () => {
    expect(parse({})).toMatchObject({ summary: false, limit: 50, offset: 0 });
  });
});

describe('declared error contract', () => {
  it('declares exactly the reasons the handler and service can emit', () => {
    expect(billionDollarDisasters.errors?.map((entry) => entry.reason).sort()).toEqual([
      'invalid_state_code',
      'invalid_year_range',
      'malformed_export',
      'unknown_state',
    ]);
  });

  it('fails with invalid_state_code for a full state name', async () => {
    const failure = await contractFailure(billionDollarDisasters, { state: 'California' });

    expect(failure.data.reason).toBe('invalid_state_code');
    expect(failure.data.recovery).toMatchObject({ hint: expect.stringContaining('two-letter') });
  });

  it('fails with invalid_state_code for a three-letter code', async () => {
    expect((await captureFailure({ state: 'CAL' })).data?.reason).toBe('invalid_state_code');
  });

  it('fails with invalid_year_range when the range is inverted', async () => {
    const failure = await contractFailure(billionDollarDisasters, {
      startYear: 2024,
      endYear: 2000,
    });

    expect(failure.data.reason).toBe('invalid_year_range');
    expect(failure.message).toContain('2024');
    expect(failure.message).toContain('2000');
    expect(failure.data.recovery).toMatchObject({ hint: expect.stringContaining('Swap') });
  });

  it('accepts a range whose ends are equal', async () => {
    await expect(run({ startYear: 2024, endYear: 2024 }).result).resolves.toBeDefined();
  });

  it('lets a service failure through with its reason intact', async () => {
    mockService({
      searchEvents: vi.fn().mockRejectedValue(
        new McpError(JsonRpcErrorCode.SerializationError, 'export changed shape', {
          reason: 'malformed_export',
          sourceFile: 'events-US.csv',
        }),
      ),
    });

    expect((await captureFailure({})).data?.reason).toBe('malformed_export');
  });

  it.each([
    ['unknown_state', JsonRpcErrorCode.NotFound],
    ['malformed_export', JsonRpcErrorCode.SerializationError],
  ] as const)('puts the declared %s hint on the wire for a service throw', async (reason, code) => {
    // The service throws `{ reason }` alone; the hint the caller reads comes
    // from this tool's declared contract.
    mockService({
      searchEvents: vi
        .fn()
        .mockRejectedValue(new McpError(code, `NCEI failure (${reason}).`, { reason })),
    });
    const declared = billionDollarDisasters.errors?.find((entry) => entry.reason === reason);

    const failure = await contractFailure(billionDollarDisasters, {});

    expect(failure.code).toBe(code);
    expect(failure.data.reason).toBe(reason);
    expect(failure.data.recovery?.hint).toBe(declared?.recovery);
  });
});

describe('zero-match notice — a valid class the scope does not carry', () => {
  // disasterType is a z.enum, so a misspelling never reaches the handler. What
  // does reach it is a real NCEI class that this export holds no rows of, and
  // the year range is the wrong thing to widen in response.
  const CA_WITHOUT_TROPICAL_CYCLONE = {
    sourceFile: 'events-CA.csv',
    declaredCostUnit: 'millions of dollars',
    firstYear: 1982,
    lastYear: 2023,
    disasters: [],
    totalCount: 0,
    disasterTypesInFile: ['Drought', 'Flooding', 'Freeze', 'Severe Storm', 'Wildfire'],
  };

  beforeEach(() => {
    mockService({ searchEvents: vi.fn().mockResolvedValue(CA_WITHOUT_TROPICAL_CYCLONE) });
  });

  it('names the classes the export actually holds', async () => {
    const { ctx, result } = run({ state: 'CA', disasterType: 'Tropical Cyclone' });
    await result;

    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toContain('events-CA.csv carries no Tropical Cyclone');
    expect(notice).toContain('Drought, Flooding, Freeze, Severe Storm, Wildfire');
  });

  it('says so ahead of the coverage span, which is not what emptied the page', async () => {
    const { ctx, result } = run({ state: 'CA', disasterType: 'Tropical Cyclone' });
    await result;

    const notice = getEnrichment(ctx).notice as string;
    const classSentence = notice.indexOf('carries no Tropical Cyclone');
    const coverageSentence = notice.indexOf('The export covers');
    expect(classSentence).toBeGreaterThan(-1);
    expect(coverageSentence).toBeGreaterThan(-1);
    expect(classSentence).toBeLessThan(coverageSentence);
  });

  it('reaches the rendered content surface, not just structuredContent', async () => {
    const rendered = await runToolContract(billionDollarDisasters, {
      state: 'CA',
      disasterType: 'Tropical Cyclone',
    });

    const text = rendered.content
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('\n');
    expect(text).toContain('events-CA.csv carries no Tropical Cyclone');
    expect(text).toContain('Drought, Flooding, Freeze, Severe Storm, Wildfire');
  });

  it('stays quiet when the class is present and a narrowing filter is what missed', async () => {
    mockService({
      searchEvents: vi.fn().mockResolvedValue({
        ...CA_WITHOUT_TROPICAL_CYCLONE,
        disasterTypesInFile: ['Drought', 'Flooding', 'Tropical Cyclone'],
      }),
    });
    const { ctx, result } = run({ state: 'CA', disasterType: 'Tropical Cyclone', startYear: 2026 });
    await result;

    const notice = getEnrichment(ctx).notice as string;
    expect(notice).not.toContain('carries no');
    expect(notice).toContain('past the end');
  });

  it('stays quiet in summary mode, where every class has a column', async () => {
    mockService({
      searchSummaries: vi
        .fn()
        .mockResolvedValue({ ...NATIONAL_SUMMARY_SOURCE, summaries: [], totalCount: 0 }),
    });
    const { ctx, result } = run({ summary: true, disasterType: 'Tropical Cyclone' });
    await result;

    expect(getEnrichment(ctx).notice as string).not.toContain('carries no');
  });
});

describe('cost basis on a state scope', () => {
  // Per-state event rows are national disasters that reached the state and
  // carry the national figure, so summing states double-counts. A caller who
  // pages results only ever sees the response, never the tool description.
  const CA_EVENTS = {
    sourceFile: 'events-CA.csv',
    declaredCostUnit: 'millions of dollars',
    firstYear: 1982,
    lastYear: 2023,
    disasters: [
      {
        name: 'California Firestorm (November 2018)',
        disasterType: 'Wildfire',
        beginDate: '2018-11-08',
        endDate: '2018-11-25',
        cpiAdjustedCostInUsd: 30_000_000_000,
        unadjustedCostInUsd: 24_000_000_000,
        deaths: 106,
      },
    ],
    totalCount: 1,
    disasterTypesInFile: ['Flooding', 'Wildfire'],
  };

  beforeEach(() => {
    mockService({ searchEvents: vi.fn().mockResolvedValue(CA_EVENTS) });
  });

  it('declares the basis in structuredContent', async () => {
    const output = await run({ state: 'CA', startYear: 2018, endYear: 2018 }).result;

    expect(output.scope).toBe('CA');
    expect(output.costBasis).toBe('national');
  });

  it('says in the rendered text that the figure is not a state share', async () => {
    const output = await run({ state: 'CA', startYear: 2018, endYear: 2018 }).result;
    const text = firstText(billionDollarDisasters.format!(output));

    expect(text).toContain('national');
    expect(text).toContain('not a CA share');
    expect(text).toMatch(/summing states double-counts/i);
    // The disclosure has to sit beside the figure it qualifies.
    expect(text).toContain('$30,000,000,000 USD');
  });

  it('omits the basis for the national scope, where the distinction cannot arise', async () => {
    mockService({});
    const output = await run({}).result;
    const text = firstText(billionDollarDisasters.format!(output));

    expect(output.costBasis).toBeUndefined();
    expect(text).not.toContain('not a US share');
  });

  it('omits the basis in summary mode, whose state rows are not national costs', async () => {
    mockService({
      searchSummaries: vi.fn().mockResolvedValue({
        sourceFile: 'time-series-CA.csv',
        declaredCostUnit: 'millions of dollars',
        firstYear: 1980,
        lastYear: 2024,
        summaries: [STATE_YEAR_2022],
        totalCount: 1,
      }),
    });
    const output = await run({ summary: true, state: 'CA' }).result;

    expect(output.costBasis).toBeUndefined();
  });
});

describe('definition language', () => {
  /** Walk the serialized output schema, which carries every nested `.describe()`. */
  type JsonSchemaNode = {
    description?: string;
    properties?: Record<string, JsonSchemaNode>;
    items?: JsonSchemaNode;
  };
  const outputSchema = z.toJSONSchema(billionDollarDisasters.output) as JsonSchemaNode;
  const field = (...path: string[]): string => {
    let node: JsonSchemaNode | undefined = outputSchema;
    for (const key of path) {
      node = key === '[]' ? node?.items : node?.properties?.[key];
    }
    if (node?.description === undefined) {
      throw new Error(`No description at ${path.join('.')}`);
    }
    return node.description;
  };

  it('does not promise seven byDisasterType entries a disasterType filter cannot deliver', () => {
    // With disasterType set the service returns exactly one entry, which the
    // input describe already says — the two must not contradict each other.
    const description = field('summaries', '[]', 'byDisasterType');

    expect(description).toContain('disasterType');
    expect(description).not.toMatch(
      /^The seven disaster classes plus the "All Disasters" total\.$/,
    );
  });

  it('states what declaredCostUnit is without coaching the reader on using it', () => {
    const description = field('declaredCostUnit');

    expect(description).not.toContain('can be checked');
    expect(description).not.toContain('applied again');
    expect(description).toContain('whole US dollars');
  });

  it('states the response shape without coaching the reader on when to ask for it', () => {
    expect(billionDollarDisasters.description).not.toContain('shape for trend questions');
  });

  it('keeps the caveats that stop a wrong reading while staying under 1,500 characters', () => {
    const description = billionDollarDisasters.description ?? '';

    expect(description).toContain('WHOLE US DOLLARS');
    expect(description).toContain('declaredCostUnit');
    expect(description).toContain('NATIONAL cost');
    expect(description).toContain('double-counts');
    expect(description.length).toBeLessThan(1_500);
  });
});

describe('boundaries', () => {
  it('notices an empty result and says what the export covers', async () => {
    mockService({
      searchEvents: vi.fn().mockResolvedValue({
        ...NATIONAL_SOURCE,
        disasters: [],
        totalCount: 0,
        disasterTypesInFile: ['Drought'],
      }),
    });
    const { ctx, result } = run({ startYear: 2026 });
    await result;

    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toContain('1980–2024');
    expect(notice).toContain('past the end');
  });

  it('explains the dollar unit when a cost floor emptied the page', async () => {
    mockService({
      searchEvents: vi.fn().mockResolvedValue({
        ...NATIONAL_SOURCE,
        disasters: [],
        totalCount: 0,
        disasterTypesInFile: ['Drought'],
      }),
    });
    const { ctx, result } = run({ minCostInUsd: 1000 });
    await result;

    // A caller thinking in millions passes 1000 and means a billion.
    expect(getEnrichment(ctx).notice as string).toContain('$1,000');
    expect(getEnrichment(ctx).notice as string).toContain('1e9 for one billion');
  });

  it('discloses truncation when more matches exist beyond the page', async () => {
    mockService({
      searchEvents: vi.fn().mockResolvedValue({
        ...NATIONAL_SOURCE,
        disasters: [HELENE],
        totalCount: 403,
        disasterTypesInFile: ['Tropical Cyclone'],
      }),
    });
    const { ctx, result } = run({ limit: 1 });
    await result;

    const enrichment = getEnrichment(ctx);
    expect(enrichment.truncated).toBe(true);
    expect(enrichment.shown).toBe(1);
    expect(enrichment.cap).toBe(1);
    expect(enrichment.totalCount).toBe(403);
  });

  it('flags a page whose offset ran past the end of a non-empty match set', async () => {
    mockService({
      searchEvents: vi.fn().mockResolvedValue({
        ...NATIONAL_SOURCE,
        disasters: [],
        totalCount: 6,
        disasterTypesInFile: ['Drought'],
      }),
    });
    const { ctx, result } = run({ offset: 99 });
    await result;

    const enrichment = getEnrichment(ctx);
    expect(enrichment.exhausted).toBe(true);
    expect(enrichment.notice as string).toContain('offset 99');
    expect(enrichment).not.toHaveProperty('truncated');
  });

  it('writes exactly one notice, never stacking the empty and truncated branches', async () => {
    mockService({
      searchEvents: vi.fn().mockResolvedValue({
        ...NATIONAL_SOURCE,
        disasters: [HELENE],
        totalCount: 1,
        disasterTypesInFile: ['Tropical Cyclone'],
      }),
    });
    const { ctx, result } = run({});
    await result;

    const enrichment = getEnrichment(ctx);
    expect(enrichment).not.toHaveProperty('notice');
    expect(enrichment).not.toHaveProperty('truncated');
    expect(enrichment).not.toHaveProperty('exhausted');
  });
});
