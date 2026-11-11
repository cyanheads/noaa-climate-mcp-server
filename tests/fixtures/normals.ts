/**
 * @fileoverview Responses from NCEI's Access Data Service for the 1991–2020
 * normals datasets, captured live at Seattle-Tacoma (`USW00024233`) and
 * Kent 0.6 SE (`US1WAKG0005`) on 2026-11-11.
 *
 * Bodies are verbatim, padding included: every value, flag, and year count
 * arrives as a left-padded string, key order varies from row to row, and the
 * annual/seasonal row carries no `DATE` key. Slices are marked where a body was
 * cut to the rows a test reads.
 *
 * @module tests/fixtures/normals
 */

/**
 * `normals-monthly-1991-2020`, the five monthly defaults with attributes.
 * Snowfall is provisional (`P`) every month; the rest are standard (`S`).
 */
export const MONTHLY_DEFAULTS_JSON = `[
{"STATION":"USW00024233","years_MLY-SNOW-NORMAL":"18","MLY-SNOW-NORMAL":"     1.8","MLY-PRCP-NORMAL":"    5.78","meas_flag_MLY-SNOW-NORMAL":" ","MLY-TMAX-NORMAL":"    48.0","comp_flag_MLY-TMIN-NORMAL":"S","comp_flag_MLY-TAVG-NORMAL":"S","comp_flag_MLY-SNOW-NORMAL":"P","DATE":"01","MLY-TAVG-NORMAL":"    42.8","MLY-TMIN-NORMAL":"    37.7","meas_flag_MLY-PRCP-NORMAL":" ","years_MLY-TAVG-NORMAL":"27","meas_flag_MLY-TMAX-NORMAL":" ","years_MLY-TMIN-NORMAL":"27","meas_flag_MLY-TAVG-NORMAL":" ","meas_flag_MLY-TMIN-NORMAL":" ","years_MLY-PRCP-NORMAL":"30","comp_flag_MLY-TMAX-NORMAL":"S","years_MLY-TMAX-NORMAL":"30","comp_flag_MLY-PRCP-NORMAL":"S"}
,{"STATION":"USW00024233","years_MLY-SNOW-NORMAL":"18","MLY-SNOW-NORMAL":"     2.2","MLY-PRCP-NORMAL":"    3.76","meas_flag_MLY-SNOW-NORMAL":" ","MLY-TMAX-NORMAL":"    50.3","comp_flag_MLY-TMIN-NORMAL":"S","comp_flag_MLY-TAVG-NORMAL":"S","comp_flag_MLY-SNOW-NORMAL":"P","DATE":"02","MLY-TAVG-NORMAL":"    44.0","MLY-TMIN-NORMAL":"    37.7","meas_flag_MLY-PRCP-NORMAL":" ","years_MLY-TAVG-NORMAL":"27","meas_flag_MLY-TMAX-NORMAL":" ","years_MLY-TMIN-NORMAL":"27","meas_flag_MLY-TAVG-NORMAL":" ","meas_flag_MLY-TMIN-NORMAL":" ","years_MLY-PRCP-NORMAL":"30","comp_flag_MLY-TMAX-NORMAL":"S","years_MLY-TMAX-NORMAL":"30","comp_flag_MLY-PRCP-NORMAL":"S"}
,{"STATION":"USW00024233","years_MLY-SNOW-NORMAL":"18","MLY-SNOW-NORMAL":"     0.4","MLY-PRCP-NORMAL":"    4.17","meas_flag_MLY-SNOW-NORMAL":" ","MLY-TMAX-NORMAL":"    54.2","comp_flag_MLY-TMIN-NORMAL":"S","comp_flag_MLY-TAVG-NORMAL":"S","comp_flag_MLY-SNOW-NORMAL":"P","DATE":"03","MLY-TAVG-NORMAL":"    47.1","MLY-TMIN-NORMAL":"    39.9","meas_flag_MLY-PRCP-NORMAL":" ","years_MLY-TAVG-NORMAL":"26","meas_flag_MLY-TMAX-NORMAL":" ","years_MLY-TMIN-NORMAL":"26","meas_flag_MLY-TAVG-NORMAL":" ","meas_flag_MLY-TMIN-NORMAL":" ","years_MLY-PRCP-NORMAL":"30","comp_flag_MLY-TMAX-NORMAL":"S","years_MLY-TMAX-NORMAL":"30","comp_flag_MLY-PRCP-NORMAL":"S"}
,{"STATION":"USW00024233","years_MLY-SNOW-NORMAL":"18","MLY-SNOW-NORMAL":"     0.0","MLY-PRCP-NORMAL":"    3.18","meas_flag_MLY-SNOW-NORMAL":" ","MLY-TMAX-NORMAL":"    59.3","comp_flag_MLY-TMIN-NORMAL":"S","comp_flag_MLY-TAVG-NORMAL":"S","comp_flag_MLY-SNOW-NORMAL":"P","DATE":"04","MLY-TAVG-NORMAL":"    51.3","MLY-TMIN-NORMAL":"    43.3","meas_flag_MLY-PRCP-NORMAL":" ","years_MLY-TAVG-NORMAL":"26","meas_flag_MLY-TMAX-NORMAL":" ","years_MLY-TMIN-NORMAL":"26","meas_flag_MLY-TAVG-NORMAL":" ","meas_flag_MLY-TMIN-NORMAL":" ","years_MLY-PRCP-NORMAL":"30","comp_flag_MLY-TMAX-NORMAL":"S","years_MLY-TMAX-NORMAL":"30","comp_flag_MLY-PRCP-NORMAL":"S"}
,{"STATION":"USW00024233","years_MLY-SNOW-NORMAL":"18","MLY-SNOW-NORMAL":"     0.0","MLY-PRCP-NORMAL":"    1.88","meas_flag_MLY-SNOW-NORMAL":" ","MLY-TMAX-NORMAL":"    66.3","comp_flag_MLY-TMIN-NORMAL":"S","comp_flag_MLY-TAVG-NORMAL":"S","comp_flag_MLY-SNOW-NORMAL":"P","DATE":"05","MLY-TAVG-NORMAL":"    57.5","MLY-TMIN-NORMAL":"    48.7","meas_flag_MLY-PRCP-NORMAL":" ","years_MLY-TAVG-NORMAL":"26","meas_flag_MLY-TMAX-NORMAL":" ","years_MLY-TMIN-NORMAL":"26","meas_flag_MLY-TAVG-NORMAL":" ","meas_flag_MLY-TMIN-NORMAL":" ","years_MLY-PRCP-NORMAL":"30","comp_flag_MLY-TMAX-NORMAL":"S","years_MLY-TMAX-NORMAL":"30","comp_flag_MLY-PRCP-NORMAL":"S"}
,{"STATION":"USW00024233","years_MLY-SNOW-NORMAL":"18","MLY-SNOW-NORMAL":"     0.0","MLY-PRCP-NORMAL":"    1.45","meas_flag_MLY-SNOW-NORMAL":" ","MLY-TMAX-NORMAL":"    71.1","comp_flag_MLY-TMIN-NORMAL":"S","comp_flag_MLY-TAVG-NORMAL":"S","comp_flag_MLY-SNOW-NORMAL":"P","DATE":"06","MLY-TAVG-NORMAL":"    62.0","MLY-TMIN-NORMAL":"    53.0","meas_flag_MLY-PRCP-NORMAL":" ","years_MLY-TAVG-NORMAL":"26","meas_flag_MLY-TMAX-NORMAL":" ","years_MLY-TMIN-NORMAL":"26","meas_flag_MLY-TAVG-NORMAL":" ","meas_flag_MLY-TMIN-NORMAL":" ","years_MLY-PRCP-NORMAL":"29","comp_flag_MLY-TMAX-NORMAL":"S","years_MLY-TMAX-NORMAL":"30","comp_flag_MLY-PRCP-NORMAL":"S"}
,{"STATION":"USW00024233","years_MLY-SNOW-NORMAL":"18","MLY-SNOW-NORMAL":"     0.0","MLY-PRCP-NORMAL":"    0.60","meas_flag_MLY-SNOW-NORMAL":" ","MLY-TMAX-NORMAL":"    77.4","comp_flag_MLY-TMIN-NORMAL":"S","comp_flag_MLY-TAVG-NORMAL":"S","comp_flag_MLY-SNOW-NORMAL":"P","DATE":"07","MLY-TAVG-NORMAL":"    67.1","MLY-TMIN-NORMAL":"    56.8","meas_flag_MLY-PRCP-NORMAL":" ","years_MLY-TAVG-NORMAL":"25","meas_flag_MLY-TMAX-NORMAL":" ","years_MLY-TMIN-NORMAL":"25","meas_flag_MLY-TAVG-NORMAL":" ","meas_flag_MLY-TMIN-NORMAL":" ","years_MLY-PRCP-NORMAL":"30","comp_flag_MLY-TMAX-NORMAL":"S","years_MLY-TMAX-NORMAL":"30","comp_flag_MLY-PRCP-NORMAL":"S"}
,{"STATION":"USW00024233","years_MLY-SNOW-NORMAL":"18","MLY-SNOW-NORMAL":"     0.0","MLY-PRCP-NORMAL":"    0.97","meas_flag_MLY-SNOW-NORMAL":" ","MLY-TMAX-NORMAL":"    77.6","comp_flag_MLY-TMIN-NORMAL":"S","comp_flag_MLY-TAVG-NORMAL":"S","comp_flag_MLY-SNOW-NORMAL":"P","DATE":"08","MLY-TAVG-NORMAL":"    67.4","MLY-TMIN-NORMAL":"    57.2","meas_flag_MLY-PRCP-NORMAL":" ","years_MLY-TAVG-NORMAL":"25","meas_flag_MLY-TMAX-NORMAL":" ","years_MLY-TMIN-NORMAL":"25","meas_flag_MLY-TAVG-NORMAL":" ","meas_flag_MLY-TMIN-NORMAL":" ","years_MLY-PRCP-NORMAL":"30","comp_flag_MLY-TMAX-NORMAL":"S","years_MLY-TMAX-NORMAL":"30","comp_flag_MLY-PRCP-NORMAL":"S"}
,{"STATION":"USW00024233","years_MLY-SNOW-NORMAL":"18","MLY-SNOW-NORMAL":"     0.0","MLY-PRCP-NORMAL":"    1.61","meas_flag_MLY-SNOW-NORMAL":" ","MLY-TMAX-NORMAL":"    71.6","comp_flag_MLY-TMIN-NORMAL":"S","comp_flag_MLY-TAVG-NORMAL":"S","comp_flag_MLY-SNOW-NORMAL":"P","DATE":"09","MLY-TAVG-NORMAL":"    62.6","MLY-TMIN-NORMAL":"    53.6","meas_flag_MLY-PRCP-NORMAL":" ","years_MLY-TAVG-NORMAL":"26","meas_flag_MLY-TMAX-NORMAL":" ","years_MLY-TMIN-NORMAL":"26","meas_flag_MLY-TAVG-NORMAL":" ","meas_flag_MLY-TMIN-NORMAL":" ","years_MLY-PRCP-NORMAL":"29","comp_flag_MLY-TMAX-NORMAL":"S","years_MLY-TMAX-NORMAL":"30","comp_flag_MLY-PRCP-NORMAL":"S"}
,{"STATION":"USW00024233","years_MLY-SNOW-NORMAL":"17","MLY-SNOW-NORMAL":"     0.0","MLY-PRCP-NORMAL":"    3.91","meas_flag_MLY-SNOW-NORMAL":" ","MLY-TMAX-NORMAL":"    60.5","comp_flag_MLY-TMIN-NORMAL":"S","comp_flag_MLY-TAVG-NORMAL":"S","comp_flag_MLY-SNOW-NORMAL":"P","DATE":"10","MLY-TAVG-NORMAL":"    53.8","MLY-TMIN-NORMAL":"    47.0","meas_flag_MLY-PRCP-NORMAL":" ","years_MLY-TAVG-NORMAL":"27","meas_flag_MLY-TMAX-NORMAL":" ","years_MLY-TMIN-NORMAL":"27","meas_flag_MLY-TAVG-NORMAL":" ","meas_flag_MLY-TMIN-NORMAL":" ","years_MLY-PRCP-NORMAL":"30","comp_flag_MLY-TMAX-NORMAL":"S","years_MLY-TMAX-NORMAL":"30","comp_flag_MLY-PRCP-NORMAL":"S"}
,{"STATION":"USW00024233","years_MLY-SNOW-NORMAL":"17","MLY-SNOW-NORMAL":"     0.2","MLY-PRCP-NORMAL":"    6.31","meas_flag_MLY-SNOW-NORMAL":" ","MLY-TMAX-NORMAL":"    52.1","comp_flag_MLY-TMIN-NORMAL":"S","comp_flag_MLY-TAVG-NORMAL":"S","comp_flag_MLY-SNOW-NORMAL":"P","DATE":"11","MLY-TAVG-NORMAL":"    46.5","MLY-TMIN-NORMAL":"    40.9","meas_flag_MLY-PRCP-NORMAL":" ","years_MLY-TAVG-NORMAL":"27","meas_flag_MLY-TMAX-NORMAL":" ","years_MLY-TMIN-NORMAL":"27","meas_flag_MLY-TAVG-NORMAL":" ","meas_flag_MLY-TMIN-NORMAL":" ","years_MLY-PRCP-NORMAL":"30","comp_flag_MLY-TMAX-NORMAL":"S","years_MLY-TMAX-NORMAL":"30","comp_flag_MLY-PRCP-NORMAL":"S"}
,{"STATION":"USW00024233","years_MLY-SNOW-NORMAL":"17","MLY-SNOW-NORMAL":"     1.7","MLY-PRCP-NORMAL":"    5.72","meas_flag_MLY-SNOW-NORMAL":" ","MLY-TMAX-NORMAL":"    47.0","comp_flag_MLY-TMIN-NORMAL":"S","comp_flag_MLY-TAVG-NORMAL":"S","comp_flag_MLY-SNOW-NORMAL":"P","DATE":"12","MLY-TAVG-NORMAL":"    42.0","MLY-TMIN-NORMAL":"    37.1","meas_flag_MLY-PRCP-NORMAL":" ","years_MLY-TAVG-NORMAL":"27","meas_flag_MLY-TMAX-NORMAL":" ","years_MLY-TMIN-NORMAL":"27","meas_flag_MLY-TAVG-NORMAL":" ","meas_flag_MLY-TMIN-NORMAL":" ","years_MLY-PRCP-NORMAL":"30","comp_flag_MLY-TMAX-NORMAL":"S","years_MLY-TMAX-NORMAL":"30","comp_flag_MLY-PRCP-NORMAL":"S"}
]`;

/** `normals-annualseasonal-1991-2020`, the five annual defaults: one row, no `DATE`. */
export const ANNUAL_DEFAULTS_JSON = `[
{"meas_flag_ANN-TAVG-NORMAL":" ","meas_flag_ANN-TMIN-NORMAL":" ","STATION":"USW00024233","comp_flag_ANN-SNOW-NORMAL":"P","ANN-TAVG-NORMAL":"    53.7","ANN-TMIN-NORMAL":"    46.1","meas_flag_ANN-PRCP-NORMAL":" ","ANN-SNOW-NORMAL":"     6.3","years_ANN-TMAX-NORMAL":"30","meas_flag_ANN-TMAX-NORMAL":" ","comp_flag_ANN-TMAX-NORMAL":"S","years_ANN-PRCP-NORMAL":"29","ANN-TMAX-NORMAL":"    61.3","comp_flag_ANN-PRCP-NORMAL":"S","comp_flag_ANN-TAVG-NORMAL":"S","comp_flag_ANN-TMIN-NORMAL":"S","years_ANN-SNOW-NORMAL":"17","years_ANN-TMIN-NORMAL":"25","ANN-PRCP-NORMAL":"   39.34","meas_flag_ANN-SNOW-NORMAL":" ","years_ANN-TAVG-NORMAL":"25"}
]`;

/**
 * Slice: the last three rows of `normals-daily-1991-2020` for February
 * (`startDate=2020-02-01&endDate=2020-02-29`, 29 rows upstream), datatypes
 * `DLY-TMAX-NORMAL,MTD-PRCP-NORMAL`. NCEI computes no precipitation average for
 * February 29, so that row's `MTD-PRCP-NORMAL` is `-9999.00`, flagged `M`, with
 * a blank completeness flag and `" 0"` years.
 */
export const DAILY_FEBRUARY_TAIL_JSON = `[
{"DATE":"02-27","years_DLY-TMAX-NORMAL":"30","MTD-PRCP-NORMAL":"    3.63","STATION":"USW00024233","years_MTD-PRCP-NORMAL":"30","meas_flag_DLY-TMAX-NORMAL":" ","meas_flag_MTD-PRCP-NORMAL":" ","comp_flag_DLY-TMAX-NORMAL":"S","DLY-TMAX-NORMAL":"    51.7","comp_flag_MTD-PRCP-NORMAL":"S"}
,{"DATE":"02-28","years_DLY-TMAX-NORMAL":"30","MTD-PRCP-NORMAL":"    3.76","STATION":"USW00024233","years_MTD-PRCP-NORMAL":"30","meas_flag_DLY-TMAX-NORMAL":" ","meas_flag_MTD-PRCP-NORMAL":" ","comp_flag_DLY-TMAX-NORMAL":"S","DLY-TMAX-NORMAL":"    51.8","comp_flag_MTD-PRCP-NORMAL":"S"}
,{"DATE":"02-29","years_DLY-TMAX-NORMAL":"30","MTD-PRCP-NORMAL":"-9999.00","STATION":"USW00024233","years_MTD-PRCP-NORMAL":" 0","meas_flag_DLY-TMAX-NORMAL":" ","meas_flag_MTD-PRCP-NORMAL":"M","comp_flag_DLY-TMAX-NORMAL":"S","DLY-TMAX-NORMAL":"    51.9","comp_flag_MTD-PRCP-NORMAL":" "}
]`;

/**
 * Slice: the first row of `normals-hourly-1991-2020` for January with
 * `HLY-TEMP-NORMAL,HLY-DEWP-NORMAL`. The live response repeats this shape for
 * all 744 hours of the month; {@link hourlyJanuaryJson} rebuilds that count.
 */
const HOURLY_JANUARY_FIRST_ROW = {
  DATE: '01-01T00:00:00',
  STATION: 'USW00024233',
  'HLY-DEWP-NORMAL': '    34.8',
  'comp_flag_HLY-DEWP-NORMAL': 'S',
  'years_HLY-TEMP-NORMAL': '30',
  'years_HLY-DEWP-NORMAL': '30',
  'meas_flag_HLY-TEMP-NORMAL': ' ',
  'HLY-TEMP-NORMAL': '    40.0',
  'meas_flag_HLY-DEWP-NORMAL': ' ',
  'comp_flag_HLY-TEMP-NORMAL': 'S',
};

/**
 * January's 744 hourly rows — `01-01T00:00:00` through `01-31T23:00:00` — in
 * the captured row shape, values held at the first hour's.
 */
export function hourlyJanuaryJson(): string {
  const rows = [];
  for (let day = 1; day <= 31; day++) {
    for (let hour = 0; hour < 24; hour++) {
      const date = `01-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00`;
      rows.push({ ...HOURLY_JANUARY_FIRST_ROW, DATE: date });
    }
  }
  return JSON.stringify(rows);
}

/** `MLY-TAVG-NORMAL,MLY-FAKE-NORMAL`: the unknown ID is answered with HTTP 200 and the column absent. */
export const MONTHLY_UNKNOWN_DATATYPE_JSON = `[
{"DATE":"01","MLY-TAVG-NORMAL":"    42.8","STATION":"USW00024233"}
,{"DATE":"02","MLY-TAVG-NORMAL":"    44.0","STATION":"USW00024233"}
,{"DATE":"03","MLY-TAVG-NORMAL":"    47.1","STATION":"USW00024233"}
,{"DATE":"04","MLY-TAVG-NORMAL":"    51.3","STATION":"USW00024233"}
,{"DATE":"05","MLY-TAVG-NORMAL":"    57.5","STATION":"USW00024233"}
,{"DATE":"06","MLY-TAVG-NORMAL":"    62.0","STATION":"USW00024233"}
,{"DATE":"07","MLY-TAVG-NORMAL":"    67.1","STATION":"USW00024233"}
,{"DATE":"08","MLY-TAVG-NORMAL":"    67.4","STATION":"USW00024233"}
,{"DATE":"09","MLY-TAVG-NORMAL":"    62.6","STATION":"USW00024233"}
,{"DATE":"10","MLY-TAVG-NORMAL":"    53.8","STATION":"USW00024233"}
,{"DATE":"11","MLY-TAVG-NORMAL":"    46.5","STATION":"USW00024233"}
,{"DATE":"12","MLY-TAVG-NORMAL":"    42.0","STATION":"USW00024233"}
]`;

/**
 * `US1WAKG0005`, a precipitation-only CoCoRaHS station, asked for
 * `MLY-TAVG-NORMAL,MLY-PRCP-NORMAL`: the temperature column is absent rather
 * than `-9999`, and every precipitation normal is estimated (`E`).
 */
export const PRECIP_ONLY_MONTHLY_JSON = `[
{"DATE":"01","STATION":"US1WAKG0005","meas_flag_MLY-PRCP-NORMAL":" ","MLY-PRCP-NORMAL":"    5.57","years_MLY-PRCP-NORMAL":"12","comp_flag_MLY-PRCP-NORMAL":"E"}
,{"DATE":"02","STATION":"US1WAKG0005","meas_flag_MLY-PRCP-NORMAL":" ","MLY-PRCP-NORMAL":"    3.67","years_MLY-PRCP-NORMAL":"12","comp_flag_MLY-PRCP-NORMAL":"E"}
,{"DATE":"03","STATION":"US1WAKG0005","meas_flag_MLY-PRCP-NORMAL":" ","MLY-PRCP-NORMAL":"    3.79","years_MLY-PRCP-NORMAL":"12","comp_flag_MLY-PRCP-NORMAL":"E"}
,{"DATE":"04","STATION":"US1WAKG0005","meas_flag_MLY-PRCP-NORMAL":" ","MLY-PRCP-NORMAL":"    3.04","years_MLY-PRCP-NORMAL":"12","comp_flag_MLY-PRCP-NORMAL":"E"}
,{"DATE":"05","STATION":"US1WAKG0005","meas_flag_MLY-PRCP-NORMAL":" ","MLY-PRCP-NORMAL":"    2.17","years_MLY-PRCP-NORMAL":"10","comp_flag_MLY-PRCP-NORMAL":"E"}
,{"DATE":"06","STATION":"US1WAKG0005","meas_flag_MLY-PRCP-NORMAL":" ","MLY-PRCP-NORMAL":"    1.65","years_MLY-PRCP-NORMAL":"12","comp_flag_MLY-PRCP-NORMAL":"E"}
,{"DATE":"07","STATION":"US1WAKG0005","meas_flag_MLY-PRCP-NORMAL":" ","MLY-PRCP-NORMAL":"    0.76","years_MLY-PRCP-NORMAL":"13","comp_flag_MLY-PRCP-NORMAL":"E"}
,{"DATE":"08","STATION":"US1WAKG0005","meas_flag_MLY-PRCP-NORMAL":" ","MLY-PRCP-NORMAL":"    1.05","years_MLY-PRCP-NORMAL":"13","comp_flag_MLY-PRCP-NORMAL":"E"}
,{"DATE":"09","STATION":"US1WAKG0005","meas_flag_MLY-PRCP-NORMAL":" ","MLY-PRCP-NORMAL":"    1.76","years_MLY-PRCP-NORMAL":"12","comp_flag_MLY-PRCP-NORMAL":"E"}
,{"DATE":"10","STATION":"US1WAKG0005","meas_flag_MLY-PRCP-NORMAL":" ","MLY-PRCP-NORMAL":"    3.60","years_MLY-PRCP-NORMAL":"11","comp_flag_MLY-PRCP-NORMAL":"E"}
,{"DATE":"11","STATION":"US1WAKG0005","meas_flag_MLY-PRCP-NORMAL":" ","MLY-PRCP-NORMAL":"    5.92","years_MLY-PRCP-NORMAL":"12","comp_flag_MLY-PRCP-NORMAL":"E"}
,{"DATE":"12","STATION":"US1WAKG0005","meas_flag_MLY-PRCP-NORMAL":" ","MLY-PRCP-NORMAL":"    5.47","years_MLY-PRCP-NORMAL":"12","comp_flag_MLY-PRCP-NORMAL":"E"}
]`;

/** Slice: January's `MLY-TAVG-STDDEV` with attributes — a datatype outside the unit table. */
export const MONTHLY_STDDEV_JANUARY_JSON = `[
{"DATE":"01","MLY-TAVG-STDDEV":"     2.8","meas_flag_MLY-TAVG-STDDEV":" ","comp_flag_MLY-TAVG-STDDEV":"S","years_MLY-TAVG-STDDEV":"27"}
]`;

/**
 * Slice: two frost-probability columns of the annual row. The last-spring-32°F
 * date at 50% is written as month/day text; Sea-Tac never reaches 16°F often
 * enough for the 10% first-fall date, which is `-9999.0`.
 */
export const ANNUAL_FROST_DATES_JSON = `[
{"STATION":"USW00024233","ANN-TMIN-PRBLST-T32FP50":"   03/02","ANN-TMIN-PRBFST-T16FP10":" -9999.0"}
]`;

/** A station the service does not know, or one without normals: HTTP 200 and an empty array. */
export const NO_ROWS_JSON = '[]';

/** HTTP 400, daily or hourly sent without a date window. */
export const MISSING_DATES_400_JSON =
  '{"errorCode":400,"errorMessage":"Bad Request","errors":[{"field":"startDate","message":"A start date is required.","value":null},{"field":"endDate","message":"An end date is required.","value":null}]}';

/** HTTP 400, a dataset the service does not serve. */
export const UNSUPPORTED_DATASET_400_JSON =
  '{"errorCode":400,"errorMessage":"Bad Request","errors":[{"field":"dataset","message":"Unsupported dataset.","value":"normals-weekly-1991-2020"}]}';

/** Apache's 404 page, served for a path outside the service. */
export const APACHE_404_HTML =
  '<!DOCTYPE HTML PUBLIC "-//IETF//DTD HTML 2.0//EN">\n<html><head>\n<title>404 Not Found</title>\n</head><body>\n<h1>Not Found</h1>\n<p>The requested URL was not found on this server.</p>\n</body></html>\n';
