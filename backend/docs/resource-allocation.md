# Phase 5: simulated resource allocation

This module generates hypothetical selections from a separate, explicitly simulated
inventory. It does not reserve resources, change availability, dispatch vehicles or
personnel, infer operational needs, or assess whether deployment is safe.

## Setup

From `WildGuard-AI/backend`, use the existing database settings in `.env`.
Open `../database/migrations/003_simulated_resources.sql` in pgAdmin Query Tool for
the configured project database and execute it. It is idempotent and preserves existing data.
The migration creates `simulated_resources` with:

- A unique uppercase `unit_code`, name and resource type.
- `availability`: available, busy, maintenance or inactive.
- `location`: PostGIS geography Point, SRID 4326.
- Mandatory `simulation_only=true`, source description and recorded timestamp.
- Geography GiST and type/availability indexes.

Supported types are `fire_engine`, `water_tanker` and `medical_team`. Each row
represents one hypothetical unit, with no inferred personnel, vehicle or water capacity.
Database constraints reject other types, unknown availability and non-simulated rows.

The migration starts with an empty inventory. Allocation never inserts fallback units.

For a fictional demo, select a real fire center:

```sql
SELECT id,latitude,longitude,acquisition_time
FROM fire_hotspots ORDER BY acquisition_time DESC LIMIT 10;
```

Then seed near that center using coordinates you choose:

```powershell
node src/scripts/seedSimulatedResources.js LAT LON
npm start
```

Replace LAT/LON with numeric coordinates (latitude -89 to 89, longitude -179 to 179).
The optional seed adds six `SIM-DEMO-*` rows: two available engines, one busy engine,
one available tanker, one tanker under maintenance and one available medical team.
Names, locations and availability are entirely fictional; they are not station or emergency
service data. Coordinates are illustrative offsets around the supplied center.
The seed is transactional and idempotent: existing unit codes are left unchanged,
including edited locations and availability. Rerunning at a new center will not relocate
existing demo rows.

You may add your own clearly simulated inventory in pgAdmin with parameterized tools
or SQL, preserving `simulation_only=true` and descriptive provenance.
For example, this explicitly fictional row uses longitude before latitude:

```sql
INSERT INTO simulated_resources
  (unit_code,name,resource_type,availability,location,data_source)
VALUES
  ('SIM-CUSTOM-01','Fictional scenario engine','fire_engine','available',
   ST_SetSRID(ST_MakePoint(76.628,11.6644),4326)::geography,
   'User-defined fictional scenario; not actual station data')
ON CONFLICT (unit_code) DO NOTHING;
```

## GET /api/resources

Lists the simulated inventory as JSON and GeoJSON. Optional filters:

| Parameter | Values |
|---|---|
| `type` | fire_engine, water_tanker, medical_team |
| `availability` | available, busy, maintenance, inactive |

Examples:

```http
GET http://localhost:5000/api/resources
GET http://localhost:5000/api/resources?type=fire_engine&availability=available
```

The envelope is `{success:true,data:{simulation_only,status,count,resources,features,warning}}`.
Status is `loaded` or `empty_inventory`; loaded does not imply every listed unit is available.
Each resource includes ID, unit code, name, type, simulated availability, coordinates,
source and availability_recorded_at. GeoJSON points use [longitude,latitude].
An empty inventory returns HTTP 200, zero resources and an empty FeatureCollection.

## GET /api/fires/:id/allocation

Retrieves the existing FIRMS hotspot and reads the simulated inventory from PostgreSQL.
Returns a hypothetical per-type selection without changing resource records.

| Parameter | Default | Range / meaning |
|---|---|---|
| `id` (path) | Required | Existing positive fire ID within JavaScript safe integer range |
| `fireEngines` | 1 | Integer 0-10 |
| `waterTankers` | 1 | Integer 0-10 |
| `medicalTeams` | 1 | Integer 0-10 |
| `maxDistanceKm` | 50 | 0.1-200 km, inclusive |
| `includeExposure` | true | Literal true or false |
| `windSpeed` | Historical | Paired manual exposure-context wind, 0-150 km/h |
| `windDirection` | Historical | Paired manual meteorological direction, 0-360 degrees |
| `baseRateKmh` | 0.12 | Existing exposure model's experimental base rate, 0.01-0.5 |

Request at least one unit across the three types. Empty, repeated, nonnumeric,
fractional count and out-of-range parameters return 400. Supplying wind or base-rate
parameters with `includeExposure=false` returns 400 rather than silently ignoring them.

Example requests; replace ACTUAL_ID with a database fire ID:

```http
GET http://localhost:5000/api/fires/ACTUAL_ID/allocation?includeExposure=false
GET http://localhost:5000/api/fires/ACTUAL_ID/allocation?windSpeed=12&windDirection=270
GET http://localhost:5000/api/fires/ACTUAL_ID/allocation?fireEngines=2&waterTankers=1&medicalTeams=0&maxDistanceKm=25&includeExposure=false
GET http://localhost:5000/api/fires/ACTUAL_ID/allocation
```

### Selection policy

1. A row must explicitly be simulation-only, have usable coordinates/distance and a supported type.
2. Its simulated availability must be exactly `available`.
3. Its type must have a positive requested scenario count.
4. Its distance must be within the inclusive configured limit.
5. Within each type, select ascending unrounded distance, breaking exact ties by ascending
   uppercase ASCII unit code. Select no more than the requested count.

PostGIS `ST_Distance` on EPSG:4326 geography calculates geodesic distance in metres;
see the [official distance documentation](https://postgis.net/docs/ST_Distance.html).
The API expresses approximate straight-line distance in kilometres, rounded to four
decimals, while ranking uses the original metre values. It does not calculate road
routes, travel times, terrain access, resource capabilities or safe approach paths.

With identical fire, inventory and parameters, selections are deterministic. Each unit
can be selected only once within a result. Different simulation calls may select the
same unit because this system has no reservation, dispatch or concurrency allocation state.

Default demand is a toy scenario of one unit per type. Counts are configurable
demonstration assumptions, not calculated emergency staffing requirements.
Availability is the current stored simulated snapshot, not historical availability at the
hotspot's detection time. Each unit exposes when its availability was recorded;
the module does not verify real-world readiness or freshness.

### Exposure context

The module reuses `analyzeFireExposure()`, including its existing 1h/3h/6h polygons,
PostGIS intersections and import-coverage checks. Exposure is returned as contextual
metadata and does not change requested demand or selection ordering.

With manual wind, the existing service bypasses Open-Meteo. Otherwise it requests
historical wind at the FIRMS detection hour using its existing cache/source logic.
If weather, mapping, geometry or database problems prevent optional context, allocation
still returns its resource result and `exposure.status="unavailable"` with a sanitized
reason and upstream status. A failure querying the fire or inventory returns HTTP 500.

Unimported OSM coverage retains `coverage_unavailable` and null counts, distinct from
a covered area with zero intersections. If exposure is disabled, context is
`{status:"not_requested",contextual_only:true}`.
Existing historical-weather cache writes may occur while fetching context; simulated
resource records are never changed by either GET endpoint.

### JSON and GeoJSON contract

The success envelope is `{success:true,data:...}`. Data includes:

- `simulation_only: true`, `warning`, and `fire` with ID, coordinates and acquisition time.
- `policy`: explicit request counts, distance limit, ranking, distance method,
  demand/availability assumptions, and `exposure_affects_selection:false`.
- `summary`: per type, requested, eligible, selected and shortfall counts.
- `assignments`: resource ID/code/type, location, source, simulated availability,
  distance_km, availability_recorded_at, rank_within_type and selection_reason.
- `resources`: the full inventory with distances, selected/eligible flags and exclusion_reason.
- `resource_features`: all valid resource locations as a GeoJSON FeatureCollection.
- `selected_features`: selected resource points as a GeoJSON FeatureCollection.
- `fire_feature`: the actual FIRMS hotspot as a GeoJSON Point Feature.
- `exposure`: optional contextual results and their own model limitations.

Resource GeoJSON properties include selected/eligible flags, distance, exclusion reason,
rank and selection explanation. All IDs are strings to preserve PostgreSQL bigint precision.
No straight-line connection is returned as a drivable route.

Allocation statuses refer only to hypothetical scenario fulfillment:

| Status | Meaning |
|---|---|
| complete | Every requested toy count was filled |
| partial | Some units selected, with one or more requested counts unfilled |
| no_resources | No simulated inventory exists |
| no_eligible_resources | Inventory exists, but none qualifies for this request |

Excluded units explain `unavailable`, `type_not_requested`, `outside_distance_limit`,
`invalid_resource_data`, or `requested_count_already_filled`. The latter remains
eligible but was not selected because nearer or tie-breaking units filled the count.

HTTP 400 means invalid parameters, 404 means no matching fire, 422 means unusable
fire coordinates/timestamp, and 500 means a required database/server failure.
Errors use `{success:false,message:...}` without exposing internal database details.
Empty or insufficient inventory is a valid HTTP 200 simulation result with explicit shortfalls.

For Leaflet, load `fire_feature`, `resource_features`, and `selected_features` as separate
GeoJSON layers. Show availability/source, the selection explanation, the inventory timestamp,
the exposure status and simulation warning. Do not label a selection as actual dispatch
or an assertion that deploying the resource is operationally safe.

## Tests

From the backend directory:

```powershell
npm test
$env:RUN_POSTGIS_TESTS = "1"
npm test
Remove-Item Env:RUN_POSTGIS_TESTS
```

The default run uses deterministic mocks and explicitly skips opt-in PostGIS tests.
The integration run uses the configured database, temporary shadow tables and fixture
rollback. No fixture resources or infrastructure are inserted into project tables.

Tests cover availability/exclusions, deterministic ties, unrounded distance ranking,
inclusive distance boundaries, shortages, empty inventory, parameter validation,
JSON/GeoJSON, sanitized HTTP errors, optional unavailable exposure, actual historical
exposure-service integration, schema constraints, fictional seed idempotency and
unchanged resource records after repeated allocations.

In pgAdmin:

```sql
SELECT id,unit_code,resource_type,availability,simulation_only,data_source,
       ST_Y(location::geometry) AS latitude,
       ST_X(location::geometry) AS longitude,updated_at
FROM simulated_resources ORDER BY unit_code;
SELECT indexname,indexdef FROM pg_indexes WHERE tablename='simulated_resources';
```

Existing weather, vegetation, risk, spread and exposure endpoints remain registered.
No frontend, routing-engine or external dispatch integration is included.

## Verification on 14 November 2026

- Migration 003 was applied successfully to the configured PostgreSQL/PostGIS database.
  The simulation table, primary/unique constraints and both indexes were inspected.
- The final full run with `RUN_POSTGIS_TESTS=1` passed 47 tests with zero failures
  or skips: 28 existing regression tests, 12 new allocation unit/HTTP tests and
  7 new allocation PostGIS/HTTP integration tests.
- Allocation fixtures verified actual geography distances, coordinate order,
  unrounded ranking, exact tie-breaking, filtering, shortages and unchanged inventory.
  A fixture HTTP request using real temporary PostgreSQL resources returned three
  selections and matching GeoJSON explanations.
- The fictional seed ran only against isolated temporary fixture tables. Repeated seeding
  preserved simulated availability changes and did not duplicate rows.
- Live HTTP checks mounted the actual routes with the actual configured database.
  `/api/resources` returned HTTP 200 with `empty_inventory`.
  Actual FIRMS fire `2811` returned HTTP 200 with `no_resources` and zero assignments,
  both with context disabled and with manual-wind exposure context enabled.
- Automatic context for the same actual fire reused the existing historical weather cache:
  Open-Meteo Historical Forecast, wind 7.1 km/h from 45 degrees, observed at
  `2026-11-12T09:00:00Z` for the `09:04Z` detection. No new weather download
  was required for this Phase 5 verification.
- The actual fire's exposure context returned `coverage_unavailable`, not zero
  mapped intersections. The prior Overpass availability problem was not retried in
  this phase; allocation does not depend on a successful OSM import.
- Persistent simulated inventory remains empty (zero rows). No fictional fixture
  resources were added to the persistent project table, and no resource was reserved,
  dispatched, or marked busy by an allocation request.
- Syntax checks and `git diff --check` passed. Existing routes remain registered.
  No frontend, weather, Sentinel-2, risk or spread code was modified for Phase 5.
  No new dependencies, credentials, commits or pushes were introduced.

To populate the optional fictional demo near the inspected actual fire, run from backend:

```powershell
node src/scripts/seedSimulatedResources.js 18.4456 75.14965
```

Then start/restart the backend and request:

```http
GET http://localhost:5000/api/fires/2811/allocation?includeExposure=false
```

The coordinates and ID above come from the inspected database record. The seeded
resource locations are fictional offsets and must not be interpreted as actual facilities.
