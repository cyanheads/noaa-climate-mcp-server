---
name: noaa-climate-guide
description: Use noaa_climate_* tools for historical climate comparisons, coverage checks, and connecting storm events to station observations. Resolve identifiers across corpora and check missing data, quality flags, baselines, and cost scope before drawing conclusions.
license: Apache-2.0
metadata:
  author: "cyanheads"
  version: "1.0"
---

## Scope

Use historical observations for measured weather, climate normals for a specified baseline, Storm Events for discrete severe-weather reports, and Billion-Dollar Disasters for archived disaster costs. These corpora answer different questions; a missing record in one does not establish absence in another.

## Identifiers

Resolve location categories with `noaa_climate_list_location_categories`, then names to location IDs with `noaa_climate_find_locations`. Category names are not location prefixes: countries use `FIPS:` IDs and climate regions use `CLIM:` IDs.

Obtain station IDs from `noaa_climate_find_stations` and measurement IDs from `noaa_climate_list_data_types`, scoped to the intended dataset and station. Carry returned identifiers forward instead of constructing them from display names.

Storm episode IDs come from returned events. Keep the selected export year when following an episode; episode IDs are not CDO location or station IDs.

## Gates

1. Before reporting that observations are absent, check the dataset, station, measurement, and requested dates together. Coverage dates bound a record; they do not prove an uninterrupted series. Distinguish an exhausted page from a query with no matches.
2. Before calculating a total, mean, or extreme, retrieve every required page and nonoverlapping date window, or label the result as partial. Keep station series distinct: a location-scoped result is a collection of station observations, not a ready-made regional series.
3. Before aggregating, establish units for each measurement and a missing-data and quality policy. Do not replace missing precipitation with zero. GHCND values with nonblank `flags.quality` failed a quality check; exclude them from a quality-screened aggregate or explicitly disclose their inclusion. An absent decoded flag is not proof that another dataset passed the same checks.
4. Before calling a comparison an anomaly from normal, name the baseline. CDO `NORMAL_*` supplies 1981–2010 normals; its 2010 proxy dates do not select another baseline. Stop short of claiming a comparison against 1991–2020 when only these normals were retrieved.
5. Before summing disaster costs, establish the corpus and geographic basis. State-scoped Billion-Dollar event rows carry national event costs; summing them across states double-counts. Preserve state annual cost bins as ranges, archived CPI adjustments as archived figures, and unreported Storm Events damage as unknown.

## Workflows

For a historical comparison, choose monthly or annual summaries when they answer the question; use daily observations when the question needs daily detail. Discover compatible stations and measurements before fetching. Report the stations and usable observation coverage behind the comparison, including gaps or exclusions that affect it.

To investigate weather around a storm, use the event's valid local calendar dates to scope a CDO search. Check whether its geography is a county or a forecast zone. Resolve a county through `noaa_climate_find_locations` before finding compatible stations; do not treat a forecast-zone name as a county. If dates or geography cannot be resolved, state that limitation rather than inventing a join. Nearby station observations provide context, not proof of conditions at every point along an event's path.

For a storm-system investigation, follow a returned episode with `noaa_climate_search_storm_events`. Resolve narrative references within their response page; do not carry a page-local narrative reference into another page. For an interval spanning years, search the relevant annual exports rather than assuming date bounds expand the selected export.
