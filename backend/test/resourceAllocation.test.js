import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import pool from "../src/config/db.js";
import fireRoutes from "../src/routes/fireRoutes.js";
import resourceRoutes from "../src/routes/resourceRoutes.js";
import { parseAllocationOptions, selectSimulatedResources, simulateResourceAllocation,
  listSimulatedResources } from "../src/services/resourceAllocationService.js";
import { demoResources, seedSimulatedResources } from "../src/scripts/seedSimulatedResources.js";

const fire = { id: "1", latitude: 11, longitude: 76, acquisition_time: "2026-10-28T12:00:00Z" };
const unit = (unit_code, resource_type, distance_m, availability = "available") => ({
  id: unit_code, unit_code, name: "Fictional " + unit_code, resource_type,
  availability, distance_m, latitude: 11.01, longitude: 76.01, simulation_only: true,
  data_source: "test fixture", updated_at: "2026-11-14T00:00:00Z"
});
const requested = { fire_engine: 1, water_tanker: 1, medical_team: 1 };
const rows = [unit("ENG-B", "fire_engine", 1000), unit("ENG-A", "fire_engine", 1000),
  unit("BUSY", "fire_engine", 100, "busy"), unit("TANK", "water_tanker", 1500),
  unit("MED", "medical_team", 2500)];
const dbFor = (resources = rows, fires = [fire]) => ({ query: async (sql, params) => {
  if (sql.includes("fire_hotspots")) return { rows: fires };
  if (sql.includes("ST_Distance")) assert.deepEqual(params, [76, 11]);
  return { rows: resources };
} });

test("allocation defaults are explicit toy demand; input validation rejects malformed options", () => {
  assert.deepEqual(parseAllocationOptions().requested, requested);
  assert.equal(parseAllocationOptions().maxDistanceKm, 50);
  for (const query of [
    { fireEngines: "-1" }, { waterTankers: "11" }, { medicalTeams: "1.5" },
    { fireEngines: "" }, { medicalTeams: ["1", "2"] },
    { fireEngines: "0", waterTankers: "0", medicalTeams: "0" },
    { maxDistanceKm: "0" }, { maxDistanceKm: "201" }, { maxDistanceKm: "NaN" },
    { maxDistanceKm: " " }, { includeExposure: "" }, { includeExposure: ["true"] },
    { windSpeed: "12" }, { windDirection: "270" },
    { windSpeed: "-1", windDirection: "270" }, { windSpeed: "151", windDirection: "270" },
    { windSpeed: "12", windDirection: "361" }, { baseRateKmh: "0.6" },
    { includeExposure: "false", windSpeed: "12", windDirection: "270" }
  ]) assert.throws(() => parseAllocationOptions(query), { status: 400 });
});

test("selection filters availability and ranks exact metres then stable code regardless of input order", () => {
  const first = selectSimulatedResources(rows, requested, 50);
  const second = selectSimulatedResources([...rows].reverse(), requested, 50);
  assert.deepEqual(first, second);
  assert.deepEqual(first.selected.map(r => r.unit_code), ["ENG-A", "TANK", "MED"]);
  assert.match(first.selected[0].selection_reason, /ranked 1 of 2/);
  assert.equal(first.inventory.find(r => r.unit_code === "BUSY").exclusion_reason, "unavailable");
  assert.equal(first.inventory.find(r => r.unit_code === "ENG-B").exclusion_reason, "requested_count_already_filled");
});

test("selection uses unrounded distances, inclusive cutoff and excludes invalid/non-simulated data", () => {
  const fixtures = [unit("A", "fire_engine", 1000.04), unit("Z", "fire_engine", 1000.03),
    unit("BOUNDARY", "water_tanker", 1000), unit("OUTSIDE", "medical_team", 1000.0001),
    { ...unit("BAD", "fire_engine", 0), distance_m: NaN },
    { ...unit("REAL", "fire_engine", 0), simulation_only: false }];
  const result = selectSimulatedResources(fixtures, requested, 1.001);
  assert.equal(result.selected[0].unit_code, "Z");
  const boundary = selectSimulatedResources(fixtures, requested, 1);
  assert.ok(boundary.selected.some(r => r.unit_code === "BOUNDARY"));
  assert.equal(boundary.inventory.find(r => r.unit_code === "OUTSIDE").exclusion_reason, "outside_distance_limit");
  for (const code of ["BAD", "REAL"]) assert.equal(boundary.inventory.find(r => r.unit_code === code).eligible, false);
});

test("allocation returns JSON/GeoJSON and never requests exposure when disabled or updates inventory", async () => {
  const statements = [];
  const db = dbFor();
  const result = await simulateResourceAllocation("1", { includeExposure: "false" }, {
    db: { query: async (sql, params) => { statements.push(sql); return db.query(sql, params); } },
    getExposure: async () => assert.fail("No external context expected")
  });
  assert.equal(result.status, "complete");
  assert.equal(result.assignments.length, 3);
  assert.equal(result.selected_features.features.length, 3);
  assert.deepEqual(result.selected_features.features[0].geometry.coordinates, [76.01, 11.01]);
  assert.deepEqual(result.fire_feature.geometry.coordinates, [76, 11]);
  assert.equal(result.policy.exposure_affects_selection, false);
  assert.equal(result.exposure.status, "not_requested");
  assert.ok(statements.every(sql => !/\b(INSERT|UPDATE|DELETE)\b/i.test(sql)));
  assert.ok(result.assignments.every(a => a.simulation_only && a.location));
});

test("no inventory, unavailable units, out-of-radius units and partial fulfillment are distinct", async () => {
  for (const [fixtures, status] of [
    [[], "no_resources"], [[unit("BUSY", "fire_engine", 0, "busy")], "no_eligible_resources"],
    [[unit("FAR", "fire_engine", 50001)], "no_eligible_resources"],
    [[unit("ENGINE", "fire_engine", 100)], "partial"]
  ]) {
    const result = await simulateResourceAllocation("1", { includeExposure: "false" }, { db: dbFor(fixtures) });
    assert.equal(result.status, status);
    assert.equal(result.summary.medical_team.shortfall, 1);
  }
});

test("explicit zero requested counts exclude those types without creating a shortfall", async () => {
  const result = await simulateResourceAllocation("1", {
    includeExposure: "false", medicalTeams: "0", waterTankers: "0", fireEngines: "2"
  }, { db: dbFor() });
  assert.equal(result.status, "complete");
  assert.equal(result.assignments.length, 2);
  assert.equal(result.summary.medical_team.shortfall, 0);
  assert.equal(result.resources.find(r => r.unit_code === "MED").exclusion_reason, "type_not_requested");
});

test("context is reused without affecting selection; missing coverage remains null", async () => {
  let options;
  const horizons = [{ horizon_hours: 1, status: "coverage_unavailable", counts: null }];
  const result = await simulateResourceAllocation("1", { windSpeed: "12", windDirection: "270" }, {
    db: dbFor(), getExposure: async (id, query, dependencies) => {
      assert.equal(id, "1"); options = query; assert.ok(dependencies.db);
      return { status: "coverage_unavailable", horizons };
    }
  });
  assert.deepEqual(options, { windSpeed: "12", windDirection: "270" });
  assert.equal(result.status, "complete");
  assert.equal(result.exposure.horizons[0].counts, null);
});

test("weather or exposure failure does not invent context or block selections", async () => {
  const result = await simulateResourceAllocation("1", {}, {
    db: dbFor(), getExposure: async () => { throw Object.assign(new Error("secret detail"), { status: 502 }); },
    logger: { error() {} }
  });
  assert.equal(result.status, "complete");
  assert.equal(result.exposure.status, "unavailable");
  assert.equal(result.exposure.upstream_status, 502);
  assert.match(result.exposure.reason, /Historical weather/);
  assert.ok(!JSON.stringify(result).includes("secret detail"));
  assert.equal(result.exposure.horizons, undefined);
});

test("invalid IDs/options fail before DB access; missing or unusable fire is handled", async () => {
  for (const id of ["bad", "0", "1.5", "9007199254740992", "1 OR 1=1"]) {
    await assert.rejects(simulateResourceAllocation(id, {}, {
      db: { query: () => assert.fail("No query expected") }
    }), { status: 400 });
  }
  await assert.rejects(simulateResourceAllocation("1", { fireEngines: "-1" }, {
    db: { query: () => assert.fail("No query expected") }
  }), { status: 400 });
  await assert.rejects(simulateResourceAllocation("1", {}, { db: dbFor([], []) }), { status: 404 });
  for (const changes of [{ latitude: null }, { latitude: 100 }, { acquisition_time: null },
    { acquisition_time: "2999-01-01" }, { longitude: "invalid" }]) {
    await assert.rejects(simulateResourceAllocation("1", {}, {
      db: dbFor([], [{ ...fire, ...changes }])
    }), { status: 422 });
  }
});

test("resource listing has parameterized filters and matching GeoJSON; invalid filters reject", async () => {
  const result = await listSimulatedResources({ type: "fire_engine", availability: "available" }, {
    db: { query: async (sql, params) => {
      assert.deepEqual(params, ["fire_engine", "available"]); assert.match(sql, /simulation_only=true/);
      return { rows: [rows[0]] };
    } }
  });
  assert.equal(result.count, 1);
  assert.equal(result.features.features[0].properties.simulation_only, true);
  for (const query of [{ type: "helicopter" }, { availability: "dispatched" }, { type: ["fire_engine"] }]) {
    await assert.rejects(listSimulatedResources(query), { status: 400 });
  }
  assert.equal((await listSimulatedResources({}, { db: dbFor([]) })).status, "empty_inventory");
});

test("demo fixtures are visibly fictional and validate center coordinates", async () => {
  assert.equal(demoResources(11, 76).length, 6);
  assert.ok(demoResources(11, 76).every(r => r.name.startsWith("Fictional") && r.unit_code.startsWith("SIM-DEMO")));
  assert.throws(() => demoResources(90, 76));
  assert.throws(() => demoResources(11, NaN));
  const statements = [];
  let released = false;
  const result = await seedSimulatedResources(11, 76, { connect: async () => ({
    query: async (sql, params) => { statements.push({ sql, params }); return { rowCount: sql.includes("INSERT") ? 1 : 0 }; },
    release() { released = true; }
  }) });
  assert.equal(result.inserted, 6);
  assert.equal(statements[0].sql, "BEGIN");
  assert.equal(statements.at(-1).sql, "COMMIT");
  assert.ok(statements.filter(s => s.sql.includes("INSERT")).every(s => s.sql.includes("DO NOTHING")));
  assert.ok(released);
});

test("actual HTTP routes return envelopes, validations and sanitized DB errors", async () => {
  const originalQuery = pool.query;
  const app = express(); app.use("/api/fires", fireRoutes); app.use("/api/resources", resourceRoutes);
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  const base = "http://127.0.0.1:" + server.address().port;
  pool.query = dbFor().query;
  try {
    const valid = await fetch(base + "/api/fires/1/allocation?includeExposure=false");
    assert.equal(valid.status, 200); assert.equal((await valid.json()).data.assignments.length, 3);
    const inventory = await fetch(base + "/api/resources");
    assert.equal(inventory.status, 200); assert.equal((await inventory.json()).data.resources.length, rows.length);
    for (const path of ["/api/fires/bad/allocation", "/api/fires/1/allocation?windSpeed=12",
      "/api/fires/1/allocation?medicalTeams=-1", "/api/resources?availability=wrong"]) {
      const response = await fetch(base + path);
      assert.equal(response.status, 400); assert.equal((await response.json()).success, false);
    }
    pool.query = async () => { throw Object.assign(new Error("private database detail"), { code: "42P01" }); };
    const failure = await fetch(base + "/api/fires/1/allocation?includeExposure=false");
    assert.equal(failure.status, 500);
    assert.ok(!JSON.stringify(await failure.json()).includes("private database detail"));
  } finally {
    pool.query = originalQuery;
    await new Promise(resolve => server.close(resolve));
  }
});

test.after(async () => { await pool.end(); });
