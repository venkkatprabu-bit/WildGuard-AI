import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import express from "express";
import { writeArrayBuffer } from "geotiff";
import vegetationRoutes from "../src/routes/vegetationRoutes.js";

const source = await readFile(new URL("../src/services/dynamicVegetationService.js", import.meta.url), "utf8");
const evalscript = source.match(/const EVALSCRIPT = `([\s\S]*?)`;/)[1];
const evaluate = vm.runInNewContext(evalscript + "; evaluatePixel;");
const at = "2026-10-28T12:00:00Z";
const scene = (datetime, cloud = 10) => ({ id: datetime, properties: { datetime, "eo:cloud_cover": cloud } });
const recent = scene("2026-10-27T10:00:00Z");
const older = scene("2026-10-26T10:00:00Z");
const tiff = pixels => writeArrayBuffer(new Float32Array(pixels.flat()), {
  width: pixels.length, height: 1, SamplesPerPixel: 3,
  BitsPerSample: [32, 32, 32], SampleFormat: [3, 3, 3],
  PhotometricInterpretation: 1, ExtraSamples: [0, 0]
});
let serial = 0;
async function fixture(run, { scenes = [recent], rasters = [tiff([[0.6, 0.2, 1]])], fail, missing = false, pages } = {}) {
  const originalFetch = globalThis.fetch;
  const originalId = process.env.COPERNICUS_CLIENT_ID;
  const originalSecret = process.env.COPERNICUS_CLIENT_SECRET;
  process.env.COPERNICUS_CLIENT_ID = "test-client";
  process.env.COPERNICUS_CLIENT_SECRET = "test-secret";
  if (missing) delete process.env.COPERNICUS_CLIENT_SECRET;
  const calls = [];
  let rasterIndex = 0;
  let pageIndex = 0;
  globalThis.fetch = async (url, options) => {
    calls.push({ url, ...options });
    if (fail) return fail(url, options);
    if (url.includes("openid-connect")) return Response.json({ access_token: "test-token", expires_in: 3600 });
    if (url.includes("catalog")) return Response.json(pages ? pages[pageIndex++] : { features: scenes });
    return new Response(rasters[rasterIndex++]);
  };
  try {
    const service = await import("../src/services/dynamicVegetationService.js?test=" + serial++);
    await run(service.getDynamicVegetation, calls);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalId == null) delete process.env.COPERNICUS_CLIENT_ID;
    else process.env.COPERNICUS_CLIENT_ID = originalId;
    if (originalSecret == null) delete process.env.COPERNICUS_CLIENT_SECRET;
    else process.env.COPERNICUS_CLIENT_SECRET = originalSecret;
  }
}

test("Evalscript masks classes, missing data, zero denominators and computes indices", () => {
  const sample = { B04: 0.2, B08: 0.6, B11: 0.3, SCL: 4, dataMask: 1 };
  assert.equal(evaluate(sample)[0], 0.49999999999999994);
  assert.ok(Math.abs(evaluate({ ...sample, SCL: 5 })[1] - 1 / 3) < 1e-10);
  for (const SCL of [0, 1, 2, 3, 6, 7, 8, 9, 10, 11]) {
    assert.deepEqual(Array.from(evaluate({ ...sample, SCL })), [0, 0, 0]);
  }
  for (const changes of [{ dataMask: 0 }, { B08: 0, B04: 0 }, { B08: 0, B11: 0 }, { B08: NaN }]) {
    assert.deepEqual(Array.from(evaluate({ ...sample, ...changes })), [0, 0, 0]);
  }
});

test("real Float32 TIFF decoding validates mask, finite values, ranges and rounding", async () => {
  await fixture(async (get, calls) => {
    const result = await get(11.6644, 76.628, at);
    assert.equal(result.ndvi, 0.4);
    assert.equal(result.ndmi, 0.05);
    assert.equal(result.valid_pixel_fraction, 0.2857);
    assert.equal(result.image_acquired_at, new Date(recent.properties.datetime).toISOString());
    assert.equal(result.source, "Sentinel-2 L2A");
    const catalog = calls.find(c => c.url.includes("catalog"));
    assert.equal(catalog.headers.Accept, "application/geo+json");
    assert.equal(JSON.parse(catalog.body).datetime, "2026-09-28T12:00:00.000Z/2026-10-28T12:00:00.000Z");
    const processCall = calls.find(c => c.url.includes("process/v1"));
    assert.equal(processCall.headers.Accept, "image/tiff");
    assert.equal(processCall.headers["Content-Type"], "application/json");
    const range = JSON.parse(processCall.body).input.data[0].dataFilter.timeRange;
    assert.equal(Date.parse(range.to), Date.parse(recent.properties.datetime));
    assert.equal(Date.parse(range.to) - Date.parse(range.from), 1);
    await get(12.2958, 76.6394, at);
    assert.equal(calls.filter(c => c.url.includes("openid-connect")).length, 1);
  }, { rasters: [tiff([
    [0.6, 0.2, 1], [0.2, -0.1, 1], [0.9, 0.9, 0],
    [NaN, 0, 1], [0, Infinity, 1], [1.01, 0, 1], [0, -1.01, 1]
  ]), tiff([[0, 0, 1]])] });
});

test("latest Mysuru request defaults analysis time and returns numerical indices", async () => {
  await fixture(async get => {
    const result = await get(12.2958, 76.6394);
    assert.equal(typeof result.ndvi, "number");
    assert.equal(typeof result.ndmi, "number");
    assert.equal(result.valid_pixel_fraction, 1);
    assert.ok(Date.parse(result.image_acquired_at) <= Date.parse(result.analysis_at));
  }, { scenes: [scene(new Date(Date.now() - 86400000).toISOString())] });
});

test("invalid first acquisition retries older scene; excludes future, old and cloudy scenes", async () => {
  await fixture(async (get, calls) => {
    const result = await get(11, 76, at);
    assert.equal(result.image_acquired_at, new Date(older.properties.datetime).toISOString());
    assert.equal(calls.filter(c => c.url.includes("process/v1")).length, 2);
  }, { scenes: [older, scene("2026-10-29T00:00:00Z"), recent,
    scene("2026-09-01T00:00:00Z"), scene("2026-10-28T10:00:00Z", 90)],
    rasters: [tiff([[0, 0, 0]]), tiff([[0, 0, 1]])] });
});

test("catalog pagination is followed", async () => {
  await fixture(async (get, calls) => {
    await get(11, 76, at);
    const catalog = calls.filter(c => c.url.includes("catalog"));
    assert.equal(catalog.length, 2);
    assert.equal(JSON.parse(catalog[1].body).next, 100);
  }, { pages: [{ features: [], context: { next: 100 } }, { features: [recent] }] });
});

test("all invalid pixels stop at five distinct acquisitions", async () => {
  await fixture(async (get, calls) => {
    await assert.rejects(get(11, 76, at), { status: 404, code: "NO_VALID_PIXELS" });
    assert.equal(calls.filter(c => c.url.includes("process/v1")).length, 5);
  }, { scenes: Array.from({ length: 8 }, (_, i) => scene("2026-10-" + (27 - i) + "T10:00:00Z")),
    rasters: Array.from({ length: 5 }, () => tiff([[0, 0, 0]])) });
});

test("empty catalog and malformed TIFF return clear errors", async () => {
  await fixture(async get => assert.rejects(get(11, 76, at), { status: 404, code: "NO_SCENES" }), { scenes: [] });
  await fixture(async get => assert.rejects(get(11, 76, at), { status: 502, code: "COPERNICUS_TIFF" }), {
    rasters: [new ArrayBuffer(8)]
  });
});

test("input validation runs before authentication", async () => {
  await fixture(async (get, calls) => {
    for (const args of [[100, 200, at], [NaN, 76, at], [11, 76, ""],
      [11, 76, "invalid"], [11, 76, "2999-01-01T00:00:00Z"]]) {
      await assert.rejects(get(...args), { status: 400 });
    }
    assert.equal(calls.length, 0);
  });
});

test("missing credentials, upstream statuses, timeout and network errors are sanitized", async () => {
  await fixture(async get => assert.rejects(get(11, 76, at), { status: 503 }), { missing: true });
  for (const status of [401, 403, 406, 429, 500]) {
    await fixture(async get => {
      await assert.rejects(get(11, 76, at), error => {
        assert.equal(error.status, status === 500 ? 502 : status);
        assert.ok(!error.message.includes("test-secret"));
        return true;
      });
    }, { fail: () => new Response("test-secret test-token", { status }) });
  }
  for (const [name, status] of [["TimeoutError", 504], ["TypeError", 502]]) {
    await fixture(async get => assert.rejects(get(11, 76, at), { status }), {
      fail: () => { throw Object.assign(new Error("test-secret"), { name }); }
    });
  }
});

test("HTTP live route rejects invalid queries and preserves local route", async () => {
  const app = express();
  app.use("/api/vegetation", vegetationRoutes);
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  const base = "http://127.0.0.1:" + server.address().port;
  try {
    for (const query of ["lat=100&lon=200", "lat=&lon=76", "lat=11&lon=76&at=invalid",
      "lat=11&lon=76&at=2999-01-01", "lat=11&lat=12&lon=76"]) {
      const response = await fetch(base + "/api/vegetation/live?" + query);
      assert.equal(response.status, 400);
      assert.equal((await response.json()).success, false);
    }
    assert.equal((await fetch(base + "/api/vegetation")).status, 400);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
