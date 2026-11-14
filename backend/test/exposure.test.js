import test from "node:test";
import assert from "node:assert/strict";
import { analyzeExposure, analyzeFireExposure } from "../src/services/exposureService.js";
import { importOSM, fetchOSM, getGeometry } from "../src/scripts/importOSM.js";

const fire = { id: "123", latitude: 11.6644, longitude: 76.628, acquisition_time: "2026-10-28T12:30:00Z" };
const quiet = { log() {}, error() {} };
const weather = { wind_speed: 12, wind_direction: 270,
  weather_time: "2026-10-28T12:00:00Z", source: "Historical fixture" };
const db = { query: async () => ({ rows: [fire] }) };

test("manual wind uses existing simulation and never requests weather", async () => {
  let called = false;
  const result = await analyzeFireExposure("123", { windSpeed: "12", windDirection: "270" }, {
    db, getWeather: async () => { called = true; throw new Error("Must not call weather"); },
    analyze: async simulation => simulation
  });
  assert.equal(called, false);
  assert.deepEqual(result.features.map(f => f.properties.horizon_hours), [1, 3, 6]);
  assert.equal(result.metadata.wind.source, "Manual scenario inputs");
  assert.equal(result.metadata.assumptions.base_expansion_rate_kmh, 0.12);
});

test("automatic wind uses detection coordinates and timestamp", async () => {
  const result = await analyzeFireExposure("123", {}, { db,
    getWeather: async (...args) => {
      assert.deepEqual(args, [fire.latitude, fire.longitude, fire.acquisition_time]);
      return weather;
    }, analyze: async simulation => simulation });
  assert.equal(result.metadata.wind.source, weather.source);
  assert.equal(result.metadata.wind.observation_time, weather.weather_time);
});

test("invalid IDs, manual winds and base rate are rejected before DB access", async () => {
  const cases = [
    ["bad", {}], ["0", {}], ["1.5", {}], ["9007199254740992", {}],
    ["1", { windSpeed: "12" }], ["1", { windDirection: "270" }],
    ["1", { windSpeed: "-1", windDirection: "270" }],
    ["1", { windSpeed: "151", windDirection: "270" }],
    ["1", { windSpeed: "12", windDirection: "361" }],
    ["1", { windSpeed: ["12", "13"], windDirection: "270" }],
    ["1", { windSpeed: " ", windDirection: "270" }],
    ["1", { baseRateKmh: "0" }], ["1", { baseRateKmh: "0.51" }],
    ["1", { baseRateKmh: "" }]
  ];
  for (const [id, query] of cases) await assert.rejects(analyzeFireExposure(id, query, {
    db: { query() { assert.fail("Invalid parameters must not query database"); } }
  }), { status: 400 });
});

test("missing fire returns 404; unusable fire returns 422", async () => {
  await assert.rejects(analyzeFireExposure("123", {}, {
    db: { query: async () => ({ rows: [] }) }
  }), { status: 404 });
  await assert.rejects(analyzeFireExposure("123", {}, {
    db: { query: async () => ({ rows: [{ ...fire, latitude: 100 }] }) }
  }), { status: 422 });
});

test("weather outages and missing/mismatched historical wind suggest manual input", async () => {
  for (const getWeather of [
    async () => { throw new Error("Unavailable"); },
    async () => ({ ...weather, wind_speed: null }),
    async () => ({ ...weather, weather_time: "2026-10-28T13:00:00Z" })
  ]) await assert.rejects(analyzeFireExposure("123", {}, { db, getWeather }), e => {
    assert.equal(e.status, 502); assert.match(e.message, /manual/); return true;
  });
  await assert.rejects(analyzeFireExposure("123", {}, { db,
    getWeather: async () => { throw Object.assign(new Error("database failure"), { code: "42P01" }); }
  }), { code: "42P01" });
});

test("malformed GeoJSON rejects before spatial SQL", async () => {
  const square = { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] };
  const simulation = geometry => ({ type: "FeatureCollection",
    features: [1, 3, 6].map(h => ({ type: "Feature", properties: { horizon_hours: h }, geometry })) });
  for (const value of [null, { type: "FeatureCollection", features: [] },
    simulation({ type: "Point", coordinates: [0, 0] }),
    simulation({ ...square, coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1]]] }),
    simulation({ ...square, coordinates: [[[0, 0], [181, 0], [1, 1], [0, 0]]] })]) {
    await assert.rejects(analyzeExposure(value, { query() { assert.fail("No SQL expected"); } }), { status: 422 });
  }
});

const node = { type: "node", id: 1, lat: 11, lon: 76, tags: { place: "village", name: "Fixture" } };
const hospital = { type: "way", id: 2, tags: { amenity: "hospital" },
  geometry: [{ lon: 0, lat: 0 }, { lon: 1, lat: 0 }, { lon: 1, lat: 1 }, { lon: 0, lat: 0 }] };
const road = { type: "way", id: 3, tags: { highway: "primary" },
  geometry: [{ lon: 0, lat: 0 }, { lon: 1, lat: 1 }] };

test("OSM geometry conversion supports settlement points, hospital points/polygons and roads", () => {
  assert.deepEqual(getGeometry(node).geometry.coordinates, [76, 11]);
  assert.equal(getGeometry({ ...node, type: "way", center: { lat: 11, lon: 76 } }).geometry.type, "Point");
  assert.equal(getGeometry({ ...node, tags: { amenity: "hospital" } }).geometry.type, "Point");
  assert.equal(getGeometry(hospital).geometry.type, "Polygon");
  assert.equal(getGeometry(road).geometry.type, "LineString");
  assert.throws(() => getGeometry({ ...hospital, geometry: hospital.geometry.slice(0, 3) }));
  assert.throws(() => getGeometry({ ...road, geometry: [{ lon: NaN, lat: 0 }] }));
});

function mockDatabase() {
  const calls = [];
  let released = false;
  const client = { query: async (sql, params) => {
    calls.push({ sql, params }); return { rowCount: 1, rows: [{ id: 1 }] };
  }, release() { released = true; } };
  return { calls, client, db: { connect: async () => client }, released: () => released };
}

test("import retries HTTP 502 then upserts features and coverage before COMMIT", async () => {
  const fixture = mockDatabase();
  const waits = [];
  let requests = 0;
  const result = await importOSM(11.6644, 76.628, 6000, {
    db: fixture.db, logger: quiet, endpoints: ["https://example.test/interpreter"],
    wait: async ms => waits.push(ms),
    fetchImpl: async () => ++requests === 1 ? new Response("temporary", { status: 502 }) :
      Response.json({ elements: [node, hospital, road] })
  });
  assert.equal(requests, 2); assert.deepEqual(waits, [1000]);
  assert.deepEqual(result, { settlement: 1, hospital: 1, road: 1, skipped: 0 });
  assert.equal(fixture.calls[0].sql, "BEGIN");
  assert.match(fixture.calls.at(-2).sql, /osm_import_coverage/);
  assert.deepEqual(fixture.calls.at(-2).params, [11.6644, 76.628, 6000, 3]);
  assert.equal(fixture.calls.at(-1).sql, "COMMIT");
  assert.ok(fixture.released());
});

test("successful empty response records zero-feature coverage", async () => {
  const fixture = mockDatabase();
  await importOSM(11, 76, 6000, { db: fixture.db, logger: quiet,
    fetchImpl: async () => Response.json({ elements: [] }) });
  assert.deepEqual(fixture.calls.at(-2).params, [11, 76, 6000, 0]);
  assert.equal(fixture.calls.at(-1).sql, "COMMIT");
});

test("timeouts and transient HTTP statuses have at most three attempts", async () => {
  for (const status of [429, 500, 502, 503, 504, "timeout"]) {
    let attempts = 0;
    const waits = [];
    await assert.rejects(fetchOSM("fixture", { logger: quiet,
      wait: async ms => waits.push(ms),
      fetchImpl: async () => {
        attempts++;
        if (status === "timeout") throw Object.assign(new Error("timeout"), { name: "TimeoutError" });
        return new Response("temporary", { status });
      }
    }));
    assert.equal(attempts, 3); assert.deepEqual(waits, [1000, 2000]);
  }
});

test("permanent HTTP error and long Retry-After do not retry", async () => {
  for (const response of [new Response("bad", { status: 400 }),
    new Response("limit", { status: 429, headers: { "retry-after": "120" } })]) {
    let calls = 0;
    await assert.rejects(fetchOSM("fixture", { logger: quiet,
      fetchImpl: async () => { calls++; return response; },
      wait: async () => assert.fail("Should not wait")
    }));
    assert.equal(calls, 1);
  }
});

test("partial response never starts a database transaction; invalid geometry rolls back", async () => {
  await assert.rejects(importOSM(11, 76, 6000, {
    logger: quiet, db: { connect() { assert.fail("Must not connect"); } },
    fetchImpl: async () => Response.json({ elements: [], remark: "runtime timeout" })
  }));
  const fixture = mockDatabase();
  fixture.client.query = async (sql, params) => {
    fixture.calls.push({ sql, params });
    return { rowCount: 0, rows: [] };
  };
  await assert.rejects(importOSM(11, 76, 6000, { db: fixture.db, logger: quiet,
    fetchImpl: async () => Response.json({ elements: [node] }) }));
  assert.equal(fixture.calls.at(-1).sql, "ROLLBACK");
  assert.ok(!fixture.calls.some(c => c.sql.includes("osm_import_coverage")));
});

test("invalid import arguments do not contact Overpass", async () => {
  for (const args of [[100, 76, 6000], [11, 200, 6000], [11, 76, 499],
    [11, 76, 12001], [11, 76, 500.5]]) {
    await assert.rejects(importOSM(...args, {
      fetchImpl: async () => assert.fail("No network expected")
    }));
  }
});
