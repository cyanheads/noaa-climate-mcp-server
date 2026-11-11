/**
 * @fileoverview Domain types for the NCEI Storm Events Database bulk CSV export.
 * @module services/storm-events/types
 */

/**
 * One damage figure as NCEI reports it.
 *
 * `raw` is always the upstream cell verbatim. `amountInUsd` is present only when
 * that cell parsed; an absent `DamageEstimate` altogether means the cell was
 * empty — "not reported", never "$0". See `parseDamageEstimate`.
 */
export type DamageEstimate = {
  /** The upstream cell verbatim, e.g. `0.00K`, `1.20M`, `1.00B`. */
  raw: string;
  /** Dollar value of `raw`, omitted when the cell did not parse. */
  amountInUsd?: number;
};

/** One row of the Storm Events `details` table, projected to the surfaced columns. */
export type StormEvent = {
  eventId: string;
  episodeId?: string;
  eventType: string;
  state: string;
  countyOrZone?: string;
  countyOrZoneType?: string;
  /** `STATE_FIPS` zero-padded to two digits. NCEI writes territories as 96–99 and marine areas as 81–95. */
  stateFips?: string;
  /** `CZ_FIPS` zero-padded to three digits: a county code on `C` rows, an NWS zone number otherwise. */
  czFips?: string;
  /** CDO county location ID (`FIPS:` + stateFips + czFips), present only where it names a Census county. */
  cdoLocationId?: string;
  /** NWS Weather Forecast Office identifier. */
  wfo?: string;
  /** The reference place NWS measures the event start from, not the start point itself. */
  beginLocation?: string;
  beginDateTime: string;
  beginDate?: string;
  endDate?: string;
  endDateTime?: string;
  timezone?: string;
  magnitude?: number;
  magnitudeType?: string;
  torFScale?: string;
  torLengthInMiles?: number;
  torWidthInYards?: number;
  injuriesDirect?: number;
  injuriesIndirect?: number;
  deathsDirect?: number;
  deathsIndirect?: number;
  damageProperty?: DamageEstimate;
  damageCrops?: DamageEstimate;
  floodCause?: string;
  beginLatitude?: number;
  beginLongitude?: number;
  endLatitude?: number;
  endLongitude?: number;
  source?: string;
  episodeNarrative?: string;
  eventNarrative?: string;
};

/** Filters and paging for one Storm Events search. */
export type StormEventsQuery = {
  /** Exact EPISODE_ID digit string; leading zeros remain significant. */
  episodeId?: string;
  /** Calendar year; each year is a separate upstream file. */
  year: number;
  /** Full upper-case state or territory name as NCEI writes it, matched case-insensitively. */
  state?: string;
  /** NWS event-type label, matched case-insensitively and exactly. */
  eventType?: string;
  /** Calendar month of the event's begin date (1–12). */
  month?: number;
  /** Five-digit county FIPS, leading zeros intact; matches rows whose `cdoLocationId` is `FIPS:<countyFips>`. */
  countyFips?: string;
  /** Inclusive local-calendar overlap bounds within the selected year's export. */
  startDate?: string;
  endDate?: string;
  /** Minimum parsed property damage in dollars. Rows with no parsed figure are excluded. */
  minDamageInUsd?: number;
  limit: number;
  offset: number;
};

/** Result of one Storm Events search over a single year's `details` file. */
export type StormEventsSearchResult = {
  /** The requested page of matching events, in the source file's own row order. */
  events: StormEvent[];
  /** Every row matching the filters, before `offset`/`limit`. */
  totalCount: number;
  /** Rows read from the file, matched or not. */
  scannedRowCount: number;
  /** The `_c<publishDate>`-suffixed filename this result was read from. */
  sourceFile: string;
  /**
   * Rows that satisfied every other filter but were dropped by `minDamageInUsd`
   * because their property damage was not reported or did not parse. Zero when
   * `minDamageInUsd` was not supplied.
   */
  excludedUnknownDamage: number;
  /** Distinct `EVENT_TYPE` values present in this year's file. */
  eventTypesInYear: string[];
  /** Distinct `STATE` values present in this year's file. */
  statesInYear: string[];
};
