/**
 * @fileoverview Types for the NCEI 1991–2020 U.S. Climate Normals client.
 * @module services/normals/types
 */

/** The four 1991–2020 normals products, named as NCEI names its datasets. */
export type NormalsGranularity = 'monthly' | 'daily' | 'hourly' | 'annualseasonal';

/** One station's normals request, already validated by the tool. */
export interface NormalsQuery {
  /** Datatype IDs, uppercase, each carrying one of the granularity's prefixes. */
  datatypes: readonly string[];
  granularity: NormalsGranularity;
  /** 1–12. Narrows monthly, daily, and hourly to that month's rows. */
  month?: number;
  /** Bare 11-character GHCN-Daily ID in NCEI's case — uppercase, or a mixed-case legacy ID as published — the only form the service matches. */
  station: string;
}

/** One datatype's value on one row, with NCEI's per-value attributes. */
export interface NormalsRecord {
  /** NCEI's completeness flag: S, R, P, or E. Omitted when blank. */
  completeness?: string;
  datatype: string;
  /** NCEI's row key without a year: "01", "01-31", or "01-01T00:00:00". Absent for annualseasonal. */
  date?: string;
  /** NCEI's measurement flag (M, V, W, X, Y, Z). Omitted when blank. */
  measurementFlag?: string;
  /** NCEI's -9999 special value: missing or insufficient data. `value` is omitted. */
  missing?: true;
  /** The native unit, for datatypes whose unit is verified. Omitted otherwise. */
  unit?: string;
  value?: number;
  /** A value NCEI writes as text rather than a number — the MM/DD frost and freeze dates. */
  valueText?: string;
  /** Years of data behind the value. */
  years?: number;
}

export interface NormalsResult {
  /** The NCEI dataset the rows came from, e.g. `normals-monthly-1991-2020`. */
  dataset: string;
  /** Every record, ordered by date, then by the order the datatypes were requested. */
  records: NormalsRecord[];
  /** Rows the service returned, before they were split into records. */
  rowCount: number;
  /** Requested datatypes no returned row carries, in request order. */
  unmatchedDatatypes: string[];
}
