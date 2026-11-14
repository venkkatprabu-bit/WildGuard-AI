import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import pool from "../src/config/db.js";
import express from "express";
import fireRoutes from "../src/routes/fireRoutes.js";
import resourceRoutes from "../src/routes/resourceRoutes.js";
import { simulateResourceAllocation, listSimulatedResources } from "../src/services/resourceAllocationService.js";
import { seedSimulatedResources } from "../src/scripts/seedSimulatedResources.js";

const enabled = process.env.RUN_POSTGIS_TESTS === "1";
const migration = await readFile(new URL("../../database/migrations/003_simulated_resources.sql", import.meta.url), "utf8");
async function isolated(run) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Match the actual schema without changing project tables or consuming their sequences.
    const schema = migration.slice(migration.indexOf("CREATE TABLE"), migration.indexOf("CREATE INDEX"))
      .replace("CREATE TABLE IF NOT EXISTS simulated_resources", "CREATE TEMP TABLE simulated_resources")
      .replace(/\);\s*$/, ") ON COMMIT DROP;");
    await client.query(schema);
    await client.query(`
      CREATE TEMP TABLE fire_hotspots (id bigint,latitude double precision,
        longitude double precision,acquisition_time timestamptz) ON COMMIT DROP;
      INSERT INTO fire_hotspots VALUES (1,0,0,'2026-10-28T12:00:00Z');
    `);
    await run(client);
  } finally { await client.query("ROLLBACK"); client.release(); }
}
async function insert(client, code, type, lon, lat = 0, availability = "available") {
  await client.query(`
    INSERT INTO simulated_resources(unit_code,name,resource_type,availability,location)
    VALUES ($1::text,$1::text,$2,$3,ST_SetSRID(ST_MakePoint($4,$5),4326)::geography)
  `, [code,type,availability,lon,lat]);
}

test("PostGIS allocation: distance in metres, ordering, lon/lat and availability", { skip: !enabled }, async () => {
  await isolated(async client => {
    await insert(client,"ENGINE-FAR","fire_engine",0.02);
    await insert(client,"ENGINE-NEAR","fire_engine",0.01);
    await insert(client,"ENGINE-BUSY","fire_engine",0.001,0,"busy");
    await insert(client,"TANKER","water_tanker",0,0.01);
    await insert(client,"MEDICAL","medical_team",-0.01,0);
    const result = await simulateResourceAllocation("1", { includeExposure: "false" }, { db: client });
    assert.equal(result.status,"complete");
    const engine = result.assignments.find(r => r.resource_type === "fire_engine");
    assert.equal(engine.unit_code,"ENGINE-NEAR");
    assert.ok(Math.abs(engine.distance_km - 1.1132) < 0.001);
    const tanker = result.assignments.find(r => r.resource_type === "water_tanker");
    assert.ok(Math.abs(tanker.distance_km - 1.1057) < 0.001);
    assert.deepEqual(result.resource_features.features.find(f => f.id === "TANKER").geometry.coordinates,[0,0.01]);
  });
});

test("PostGIS allocation: repeated simulations are deterministic and inventory remains unchanged", { skip: !enabled }, async () => {
  await isolated(async client => {
    await insert(client,"ENGINE-B","fire_engine",0.01);
    await insert(client,"ENGINE-A","fire_engine",0.01);
    const before = (await client.query("SELECT * FROM simulated_resources ORDER BY id")).rows;
    const options = { includeExposure: "false", waterTankers: "0", medicalTeams: "0" };
    const one = await simulateResourceAllocation("1",options,{db:client});
    const two = await simulateResourceAllocation("1",options,{db:client});
    assert.deepEqual(one,two);
    assert.equal(one.assignments[0].unit_code,"ENGINE-A");
    assert.deepEqual((await client.query("SELECT * FROM simulated_resources ORDER BY id")).rows,before);
  });
});

test("PostGIS allocation: radius exclusion, partial results, empty inventory and filters", { skip: !enabled }, async () => {
  await isolated(async client => {
    assert.equal((await simulateResourceAllocation("1",{includeExposure:"false"},{db:client})).status,"no_resources");
    await insert(client,"FAR","fire_engine",1);
    const result = await simulateResourceAllocation("1",{includeExposure:"false"},{db:client});
    assert.equal(result.status,"no_eligible_resources");
    assert.equal(result.resources[0].exclusion_reason,"outside_distance_limit");
    await insert(client,"NEAR","water_tanker",0.001);
    assert.equal((await simulateResourceAllocation("1",{includeExposure:"false"},{db:client})).status,"partial");
    const inventory = await listSimulatedResources({type:"water_tanker",availability:"available"},{db:client});
    assert.equal(inventory.count,1);
    assert.equal(inventory.resources[0].unit_code,"NEAR");
  });
});

test("PostGIS allocation: existing exposure service runs as context without imported coverage", { skip: !enabled }, async () => {
  await isolated(async client => {
    await client.query(`
      CREATE TEMP TABLE osm_features (osm_type text,osm_id bigint,category text,name text,
        subtype text,tags jsonb,fetched_at timestamptz,geom geometry(Geometry,4326)) ON COMMIT DROP;
      CREATE TEMP TABLE osm_import_coverage (latitude double precision,longitude double precision,
        radius_m integer,feature_count integer,imported_at timestamptz) ON COMMIT DROP;
    `);
    await insert(client,"ENGINE","fire_engine",0.001);
    const result = await simulateResourceAllocation("1",{
      windSpeed:"12",windDirection:"270",waterTankers:"0",medicalTeams:"0"
    },{db:client});
    assert.equal(result.status,"complete");
    assert.equal(result.exposure.status,"coverage_unavailable");
    assert.equal(result.exposure.horizons.length,3);
    assert.ok(result.exposure.horizons.every(h => h.counts === null));
    assert.equal(result.exposure.simulation.metadata.wind.source,"Manual scenario inputs");
  });
});

test("PostGIS allocation: schema rejects non-simulated rows and invalid availability/type", { skip: !enabled }, async () => {
  await isolated(async client => {
    for (const [field,value] of [["simulation_only",false],["availability","dispatched"],["resource_type","helicopter"]]) {
      await client.query("SAVEPOINT bad_row");
      const values = {simulation_only:true,availability:"available",resource_type:"fire_engine",[field]:value};
      await assert.rejects(client.query(`
        INSERT INTO simulated_resources(unit_code,name,resource_type,availability,location,simulation_only)
        VALUES ('INVALID','INVALID',$1,$2,ST_SetSRID(ST_MakePoint(0,0),4326)::geography,$3)
      `,[values.resource_type,values.availability,values.simulation_only]),{code:"23514"});
      await client.query("ROLLBACK TO SAVEPOINT bad_row");
    }
    assert.equal((await client.query("SELECT COUNT(*)::int AS count FROM simulated_resources")).rows[0].count,0);
  });
});

test("PostGIS allocation: fictional seed is idempotent and preserves edited simulated availability", { skip: !enabled }, async () => {
  await isolated(async client => {
    // Seed transaction boundaries are represented by savepoints within the fixture transaction.
    const db = {connect:async()=>({
      query:async(sql,params)=>sql==="BEGIN" ? client.query("SAVEPOINT seed") :
        sql==="COMMIT" ? client.query("RELEASE SAVEPOINT seed") :
        sql==="ROLLBACK" ? client.query("ROLLBACK TO SAVEPOINT seed") : client.query(sql,params),
      release(){}
    })};
    assert.equal((await seedSimulatedResources(11,76,db)).inserted,6);
    await client.query("UPDATE simulated_resources SET availability='busy' WHERE unit_code='SIM-DEMO-ENGINE-01'");
    assert.equal((await seedSimulatedResources(12,77,db)).inserted,0);
    const row = (await client.query("SELECT availability,ST_Y(location::geometry) AS latitude FROM simulated_resources WHERE unit_code='SIM-DEMO-ENGINE-01'")).rows[0];
    assert.equal(row.availability,"busy");
    assert.equal(row.latitude,11.01);
  });
});


test("PostGIS allocation: HTTP endpoints select from temporary PostgreSQL inventory without changing it", { skip: !enabled }, async () => {
  await isolated(async client => {
    await insert(client,"HTTP-ENGINE","fire_engine",0.001);
    await insert(client,"HTTP-TANKER","water_tanker",0.002);
    await insert(client,"HTTP-MEDICAL","medical_team",0.003);
    const before = (await client.query("SELECT * FROM simulated_resources ORDER BY id")).rows;
    const originalQuery = pool.query;
    const app = express(); app.use("/api/fires",fireRoutes); app.use("/api/resources",resourceRoutes);
    const server = app.listen(0,"127.0.0.1");
    await new Promise(resolve=>server.once("listening",resolve));
    pool.query = (...args)=>client.query(...args);
    try {
      const base = "http://127.0.0.1:"+server.address().port;
      const response = await fetch(base+"/api/fires/1/allocation?includeExposure=false");
      const body = await response.json();
      assert.equal(response.status,200);
      assert.equal(body.data.status,"complete");
      assert.equal(body.data.assignments.length,3);
      assert.equal(body.data.selected_features.features.length,3);
      assert.ok(body.data.selected_features.features.every(f=>f.properties.selection_reason));
      const listing = await fetch(base+"/api/resources?type=water_tanker");
      assert.equal((await listing.json()).data.count,1);
      assert.deepEqual((await client.query("SELECT * FROM simulated_resources ORDER BY id")).rows,before);
    } finally {
      pool.query = originalQuery;
      await new Promise(resolve=>server.close(resolve));
    }
  });
});

test.after(async () => { await pool.end(); });
