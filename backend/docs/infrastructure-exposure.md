# Infrastructure exposure API

This research prototype reports geometric intersections between experimental spread envelopes
and a local OpenStreetMap snapshot. It does not identify confirmed damage, predict fire
progression, estimate safe distances, or provide evacuation or dispatch advice.

## Setup in VS Code

Run backend commands in a terminal whose working directory is `WildGuard-AI/backend`.
Keep PostgreSQL connection settings in the existing `.env`; do not commit credentials.

The idempotent migration is `../database/migrations/002_infrastructure_exposure.sql`.
It preserves existing data, creates missing OSM tables, and adds feature geometry/category
indexes. In pgAdmin, select the configured project database, open Query Tool, open that
migration, and execute it. PostGIS must be available to that database.

Import a small area before expecting analyzed results:

```powershell
node src/scripts/importOSM.js 11.6644 76.628 6000
npm start
```

The importer accepts latitude, longitude and an integer radius from 500 to 12000 metres;
radius defaults to 6000. It upserts OSM nodes/ways and records coverage in the same
transaction. A complete empty response records zero-feature coverage. A failed/partial
response or invalid supported geometry records no new coverage and does not commit
partial feature writes. Existing successful import records remain if a later attempt fails.

Default endpoint: `https://overpass.private.coffee/api/interpreter`.
Configure `OVERPASS_URL` or a comma-separated `OVERPASS_URLS` list in `.env`.
Configured URLs must not include credentials or query strings. The importer rotates
configured endpoints across at most three total attempts, with 1s/2s exponential backoff
for HTTP 429/500/502/503/504 and transport timeouts. Retry-After is respected up to 30s;
longer cooldowns stop the command. Each request times out after 75s; the Overpass query
has a 45s compute timeout, 32 MiB server memory limit and 50,000-element client limit.
Do not repeatedly rerun large queries against public servers.

Settlements are node points or way bounding-box center points, hospital nodes are points,
closed hospital ways are polygons, and roads are LineStrings. Relations, city places,
and other infrastructure classes are outside this initial import scope.

## GET /api/fires/:id/exposure

| Parameter | Required | Meaning |
|---|---|---|
| `id` (path) | Yes | Existing positive fire ID, within JavaScript safe integer range |
| `windSpeed` | Paired | Manual scenario wind speed, 0–150 km/h |
| `windDirection` | Paired | Meteorological direction wind comes from, 0–360 degrees |
| `baseRateKmh` | No | Experimental expansion parameter, 0.01–0.5; default 0.12 |

Supply both manual wind parameters or neither. Empty, repeated, nonnumeric or
out-of-range parameters return 400. Supplying both bypasses historical weather entirely
and labels the source `Manual scenario inputs`.

Without manual inputs, the existing `getHistoricalWeather()` service retrieves wind at
the FIRMS detection coordinates and acquisition hour, using its historical source/cache
selection. No current-weather observation or fabricated wind is substituted. Missing or
mismatched hourly wind returns 502 and suggests manual inputs. Database failures return 500.

The existing `generateSpreadSimulation()` produces 1h, 3h and 6h GeoJSON polygons using
the same wind-oriented ellipse model as the spread endpoint. These are illustrative
envelopes under constant wind, not observed or forecast fire perimeters. The base rate is
an uncalibrated visualization parameter; terrain, vegetation and suppression are excluded.

Select a real ID in pgAdmin:

```sql
SELECT id, latitude, longitude, acquisition_time
FROM fire_hotspots ORDER BY acquisition_time DESC LIMIT 10;
```

Replace `ACTUAL_ID` with that ID in VS Code's REST client, a browser, or PowerShell:

```http
GET http://localhost:5000/api/fires/ACTUAL_ID/exposure?windSpeed=12&windDirection=270
GET http://localhost:5000/api/fires/ACTUAL_ID/exposure
GET http://localhost:5000/api/fires/ACTUAL_ID/exposure?windSpeed=12&windDirection=270&baseRateKmh=0.2
```

For analyzed results, import around the selected fire's coordinates. Importing Bandipur
does not create coverage around unrelated fire IDs.

## Coverage and intersection semantics

Each polygon is checked for valid coordinates, closed rings, nonzero area and PostGIS
validity. Antimeridian-crossing polygons are rejected by this initial planar implementation.

Recorded import circles use `ST_Buffer(geography, metres)`; the union of relevant circles
must `ST_Covers()` the entire scenario polygon. Multiple imports can provide combined
coverage. Circles are polygon approximations (32 segments per quadrant), so very near
their edges coverage is conservative. The implementation follows the
[PostGIS ST_Covers semantics](https://www.postgis.net/docs/ST_Covers.html).

If full coverage is absent, that horizon returns `coverage_unavailable`, `counts: null`,
and an empty FeatureCollection, even if some locally stored features intersect it.
Partial geometry alone does not establish full import coverage.

If coverage exists, indexed `ST_Intersects()` selects mapped objects; `ST_Intersection()`
clips their geometry to the scenario and `ST_AsGeoJSON()` returns the overlap.
Counts represent distinct `osm_type/osm_id/category` objects, not fragments, road length,
population, or damaged assets. Boundary touches count as intersections.
Geometry uses EPSG:4326 and longitude before latitude.

Covered areas with no intersections return `analyzed` with three numeric zero counts.
Imported query coverage does not establish completeness of real-world OSM mapping.
Snapshots can be stale; fetched/imported timestamps are included. Reimports upsert records
but do not remove objects deleted from upstream OSM.

## Response contract for Angular / Leaflet

HTTP 200 is `{ "success": true, "data": ... }`.
The data object contains:

- `status`: `complete` if all three horizons are analyzed, `partial` if only some are,
  or `coverage_unavailable` if none have full coverage.
- `fire_id`, `simulation` (the original GeoJSON FeatureCollection including wind/model metadata),
  `horizons`, and `warning`.
- Each horizon includes `horizon_hours`, `status`, `counts`, `features`, `source`,
  and `coverage: { complete, imports }`.
- Each coverage import includes latitude, longitude, radius_m, feature_count and imported_at.
- An analyzed horizon's counts have settlement, hospital and road integer fields.
- `features` is a GeoJSON FeatureCollection. Each Feature has an object ID, clipped overlap
  geometry, and properties: osm_type, osm_id (string, preserving bigint precision),
  category, name, subtype, tags, fetched_at, horizon_hours and source.
  Clipped geometries may be Point, Polygon, MultiLineString, or GeometryCollection.

Render `data.simulation` and each horizon's `features` as separate Leaflet GeoJSON layers.
Display the status and disclaimer with the map. Do not label unavailable coverage as zero.

An actual uncovered-horizon response has this shape:

```json
{
  "horizon_hours": 1,
  "status": "coverage_unavailable",
  "counts": null,
  "coverage": { "complete": false, "imports": [] },
  "source": "OpenStreetMap via Overpass; locally imported snapshot",
  "features": { "type": "FeatureCollection", "features": [] }
}
```

Errors use `{ "success": false, "message": "..." }`:

| HTTP | Meaning |
|---|---|
| 400 | Invalid ID or query parameters |
| 404 | Fire not found |
| 422 | Unusable detection or invalid simulation polygon |
| 502/503 | Historical wind unavailable; use paired manual wind inputs |
| 500 | Database or unexpected server error |

## Tests and pgAdmin checks

```powershell
npm test
$env:RUN_POSTGIS_TESTS = "1"
node --test test/exposure.postgis.test.js
Remove-Item Env:RUN_POSTGIS_TESTS
```

Default tests use mocked HTTP/database responses for importer and orchestration paths,
and real in-memory GeoTIFFs for the existing vegetation regression suite.
Spatial tests explicitly opt in to the configured PostGIS database. They create temporary
tables that shadow project tables, insert fixture geometries only there, and roll back
every fixture transaction. No dummy infrastructure is inserted into project tables.
Without the environment flag, spatial tests are reported as skipped.

In pgAdmin:

```sql
SELECT PostGIS_Version();
SELECT table_name FROM information_schema.tables
WHERE table_schema='public' AND table_name IN ('osm_features','osm_import_coverage');
SELECT indexname,indexdef FROM pg_indexes
WHERE tablename IN ('osm_features','osm_import_coverage');
SELECT ST_GeometryType(geom),ST_SRID(geom),ST_IsValid(geom),COUNT(*)
FROM osm_features GROUP BY 1,2,3;
SELECT * FROM osm_import_coverage ORDER BY imported_at DESC;
SELECT category,COUNT(*) FROM osm_features GROUP BY category;
```

Existing health, fires, per-fire weather/risk/spread, weather and vegetation routes remain
registered; this module adds only the exposure route. Frontend, weather, risk and Sentinel-2
implementations are unchanged.

## Verification on 14 November 2026

- Migration 002 was actually applied to the configured database.
- Live schema inspection found PostGIS 3.7, both OSM tables, the geometry GiST index,
  category index and uniqueness constraints. The feature geometry column is GEOMETRY,
  SRID 4326.
- The final combined automated run passed all 28 tests, with zero failures or skips:
  10 existing vegetation regressions, 13 exposure/importer unit tests and 5 real PostGIS
  fixture tests. Default `npm test` passes 23 and explicitly skips the 5 opt-in PostGIS tests.
- A temporary local HTTP server mounted the actual fire routes. Actual database fire ID
  `2811` returned HTTP 200 with all three horizons for manual wind (12 km/h, 270 degrees).
  An external-fetch guard confirmed zero weather requests for that manual call.
- The same actual fire returned HTTP 200 using live Open-Meteo Historical Forecast wind:
  7.1 km/h from 45 degrees at `2026-11-12T09:00:00Z`, matching the FIRMS detection at
  `2026-11-12T09:04:00Z`. The existing service cached that successful hourly observation.
- Live HTTP edge checks returned 400 for an invalid ID, missing one wind parameter,
  negative speed, direction above 360 and invalid base rate, and 404 for a nonexistent ID.
- The live Bandipur importer command was run once with its internal bounded retries.
  All three attempts to the default private.coffee endpoint timed out. It exited with
  failure and did not insert infrastructure or coverage.
- Final project-table counts were zero features and zero coverage records. Both live
  exposure requests therefore correctly returned `coverage_unavailable` and null counts.
  Covered counts and clipped overlaps were verified against real PostGIS using isolated
  fixtures, not live OSM data. Live OSM import remains unverified until Overpass responds.
- Syntax checks for the service, route and importer, plus `git diff --check`, passed.
  Existing route handlers were preserved; unrelated weather, Sentinel-2, risk and frontend
  code was not changed for this module. No commit or push was performed.
