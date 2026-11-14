import test from "node:test";
import assert from "node:assert/strict";
import pool from "../src/config/db.js";
import { analyzeExposure } from "../src/services/exposureService.js";

const enabled = process.env.RUN_POSTGIS_TESTS === "1";
const square = { type: "Polygon", coordinates: [[[0,0],[0.01,0],[0.01,0.01],[0,0.01],[0,0]]] };
const simulation = (geometry = square) => ({ type: "FeatureCollection", metadata: { fire_id: "fixture" },
  features: [1,3,6].map(h => ({ type: "Feature", properties: { horizon_hours: h }, geometry })) });

async function isolated(run) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`
      CREATE TEMP TABLE osm_features (
        id BIGSERIAL PRIMARY KEY,osm_type TEXT,osm_id BIGINT,category TEXT,
        name TEXT,subtype TEXT,tags JSONB DEFAULT '{}',geom geometry(Geometry,4326),
        fetched_at timestamptz DEFAULT now(),UNIQUE(osm_type,osm_id,category)
      ) ON COMMIT DROP;
      CREATE INDEX ON osm_features USING gist(geom);
      CREATE TEMP TABLE osm_import_coverage (
        latitude double precision,longitude double precision,radius_m integer,
        feature_count integer DEFAULT 0,imported_at timestamptz DEFAULT now()
      ) ON COMMIT DROP;
    `);
    await run(client);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}
const cover = client => client.query(`
  INSERT INTO osm_import_coverage(latitude,longitude,radius_m) VALUES (0.005,0.005,2000)
`);

test("PostGIS: no coverage, outside coverage, empty covered area are distinct", { skip: !enabled }, async () => {
  await isolated(async client => {
    const noCoverage = await analyzeExposure(simulation(), client);
    assert.equal(noCoverage.status, "coverage_unavailable");
    assert.equal(noCoverage.horizons[0].counts, null);
    await client.query("INSERT INTO osm_import_coverage(latitude,longitude,radius_m) VALUES (11,76,6000)");
    assert.equal((await analyzeExposure(simulation(), client)).horizons[0].counts, null);
    await cover(client);
    const covered = await analyzeExposure(simulation(), client);
    assert.equal(covered.status, "complete");
    assert.deepEqual(covered.horizons[0].counts, { settlement: 0, hospital: 0, road: 0 });
  });
});

test("PostGIS: real point, hospital polygon and crossing road intersections count objects once", { skip: !enabled }, async () => {
  await isolated(async client => {
    await cover(client);
    await client.query(`
      INSERT INTO osm_features(osm_type,osm_id,category,geom) VALUES
      ('node',1,'settlement',ST_GeomFromText('POINT(0.005 0.005)',4326)),
      ('node',2,'settlement',ST_GeomFromText('POINT(0.02 0.02)',4326)),
      ('way',3,'hospital',ST_GeomFromText('POLYGON((0.008 0.008,0.012 0.008,0.012 0.012,0.008 0.012,0.008 0.008))',4326)),
      ('way',4,'road',ST_GeomFromText('LINESTRING(-0.002 0.002,0.012 0.002,0.012 0.008,-0.002 0.008)',4326))
    `);
    const result = await analyzeExposure(simulation(), client);
    for (const horizon of result.horizons) {
      assert.deepEqual(horizon.counts, { settlement: 1, hospital: 1, road: 1 });
      assert.equal(horizon.features.features.length, 3);
      assert.equal(horizon.features.features.find(f => f.properties.category === "road").geometry.type, "MultiLineString");
      assert.equal(horizon.features.features.find(f => f.properties.category === "hospital").geometry.type, "Polygon");
      assert.ok(horizon.features.features.every(f => f.properties.horizon_hours === horizon.horizon_hours));
    }
  });
});

test("PostGIS: imported areas can collectively cover a polygon", { skip: !enabled }, async () => {
  await isolated(async client => {
    await client.query("INSERT INTO osm_import_coverage(latitude,longitude,radius_m) VALUES (0.005,0.001,850)");
    assert.equal((await analyzeExposure(simulation(), client)).status, "coverage_unavailable");
    await client.query("INSERT INTO osm_import_coverage(latitude,longitude,radius_m) VALUES (0.005,0.009,850)");
    assert.equal((await analyzeExposure(simulation(), client)).status, "complete");
  });
});

test("PostGIS: self-intersecting and zero-area polygons are rejected", { skip: !enabled }, async () => {
  await isolated(async client => {
    for (const coordinates of [
      [[[0,0],[0.01,0.01],[0,0.01],[0.01,0],[0,0]]],
      [[[0,0],[0.01,0],[0.02,0],[0,0]]]
    ]) await assert.rejects(analyzeExposure(simulation({ type: "Polygon", coordinates }), client), { status: 422 });
  });
});

test("PostGIS: mixed per-horizon coverage produces partial status", { skip: !enabled }, async () => {
  await isolated(async client => {
    await cover(client);
    const value = simulation();
    value.features[2].geometry = { type: "Polygon", coordinates: [[[1,1],[1.01,1],[1.01,1.01],[1,1]]] };
    const result = await analyzeExposure(value, client);
    assert.equal(result.status, "partial");
    assert.equal(result.horizons[2].counts, null);
    assert.equal(result.horizons[0].status, "analyzed");
  });
});

test.after(async () => { await pool.end(); });
