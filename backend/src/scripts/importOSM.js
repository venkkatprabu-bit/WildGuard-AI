import "dotenv/config";
import { pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import pool from "../config/db.js";

const DEFAULT_OVERPASS_URL = "https://overpass.private.coffee/api/interpreter";
const TRANSIENT = new Set([429, 500, 502, 503, 504]);
const MAX_ELEMENTS = 50000;

function validPoint(lat, lon) {
  return Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
}

export function getGeometry(element) {
  const tags = element.tags || {};
  if (["node", "way"].includes(element.type) && ["village", "hamlet", "town"].includes(tags.place)) {
    const p = element.type === "node" ? element : element.center;
    if (!p || !validPoint(p.lat, p.lon)) throw new Error("Settlement lacks valid point or way center");
    return { category: "settlement", subtype: tags.place,
      geometry: { type: "Point", coordinates: [p.lon, p.lat] } };
  }
  if (element.type === "node" && tags.amenity === "hospital") {
    if (!validPoint(element.lat, element.lon)) throw new Error("Hospital lacks valid coordinates");
    return { category: "hospital", subtype: "hospital",
      geometry: { type: "Point", coordinates: [element.lon, element.lat] } };
  }
  if (element.type !== "way") return null;
  const category = tags.amenity === "hospital" ? "hospital" : tags.highway ? "road" : null;
  if (!category) return null;
  if (!Array.isArray(element.geometry) || element.geometry.some(p => !validPoint(p.lat, p.lon))) {
    throw new Error("OSM way contains missing or invalid geometry");
  }
  const coordinates = element.geometry.map(p => [p.lon, p.lat]);
  if (category === "hospital") {
    if (coordinates.length < 4 || coordinates[0][0] !== coordinates.at(-1)[0] ||
        coordinates[0][1] !== coordinates.at(-1)[1]) {
      throw new Error("Hospital way is not a valid closed polygon; import not marked complete");
    }
    return { category, subtype: "hospital", geometry: { type: "Polygon", coordinates: [coordinates] } };
  }
  if (coordinates.length < 2) throw new Error("Road way has insufficient coordinates");
  return { category, subtype: tags.highway, geometry: { type: "LineString", coordinates } };
}

function configuredEndpoints() {
  const values = (process.env.OVERPASS_URLS || process.env.OVERPASS_URL || DEFAULT_OVERPASS_URL)
    .split(",").map(s => s.trim()).filter(Boolean);
  if (!values.length) throw new Error("At least one Overpass endpoint is required");
  for (const value of values) {
    const url = new URL(value);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error("Overpass endpoints must be HTTP(S) URLs without credentials or query parameters");
    }
  }
  return values;
}

export async function fetchOSM(query, {
  fetchImpl = globalThis.fetch, wait = sleep, endpoints = configuredEndpoints(), logger = console
} = {}) {
  // Three total attempts, not three attempts per endpoint.
  for (let attempt = 0; attempt < 3; attempt++) {
    const endpoint = endpoints[attempt % endpoints.length];
    const url = new URL(endpoint);
    const label = url.origin + url.pathname;
    let response;
    try {
      response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
          "User-Agent": process.env.OSM_USER_AGENT || "WildGuardAI-ResearchPrototype/0.1"
        },
        body: new URLSearchParams({ data: query }),
        signal: AbortSignal.timeout(75000)
      });
    } catch (cause) {
      logger.error("Overpass request failed:", label, cause.name);
      if (attempt === 2) throw new Error("Overpass unavailable after three attempts");
      await wait(1000 * 2 ** attempt);
      continue;
    }
    if (!response.ok) {
      const errorBody = await response.text();
      logger.error("Overpass server:", label);
      logger.error("HTTP status:", response.status);
      logger.error("Error details:", errorBody.slice(0, 500));
      if (!TRANSIENT.has(response.status) || attempt === 2) {
        throw new Error("Overpass API failed: HTTP " + response.status);
      }
      const retryAfter = response.headers.get("retry-after");
      const requestedMs = retryAfter == null ? 0 :
        /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now();
      // Do not retry before a long server-requested cooldown, or block the CLI for minutes.
      if (requestedMs > 30000) throw new Error("Overpass rate limited; retry after the server cooldown");
      await wait(Math.max(1000 * 2 ** attempt, Number.isFinite(requestedMs) ? Math.max(0, requestedMs) : 0));
      continue;
    }
    const data = await response.json();
    if (data.remark) throw new Error("Overpass reported an incomplete or failed query; coverage not recorded");
    if (!Array.isArray(data.elements) || data.elements.length > MAX_ELEMENTS) {
      throw new Error("Unexpected or oversized OpenStreetMap response");
    }
    return data;
  }
}

export async function importOSM(lat, lon, radius, {
  db = pool, logger = console, ...requestOptions
} = {}) {
  if (!validPoint(lat, lon) || !Number.isInteger(radius) || radius < 500 || radius > 12000) {
    throw new Error("Usage: node src/scripts/importOSM.js LAT LON RADIUS (integer 500-12000m)");
  }
  const query = `
    [out:json][timeout:45][maxsize:33554432];
    (
      node["place"~"^(village|hamlet|town)$"](around:${radius},${lat},${lon});
      way["place"~"^(village|hamlet|town)$"](around:${radius},${lat},${lon});
      node["amenity"="hospital"](around:${radius},${lat},${lon});
      way["amenity"="hospital"](around:${radius},${lat},${lon});
      way["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|service|living_street|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link)$"]
        (around:${radius},${lat},${lon});
    );
    out body center geom;
  `;
  logger.log("Requesting OpenStreetMap features...");
  const data = await fetchOSM(query, { ...requestOptions, logger });
  logger.log("Received " + data.elements.length + " OSM elements");
  const client = await db.connect();
  const counts = { settlement: 0, hospital: 0, road: 0, skipped: 0 };
  const seen = new Set();
  try {
    await client.query("BEGIN");
    for (const element of data.elements) {
      const feature = getGeometry(element);
      if (!feature) { counts.skipped++; continue; }
      if (!/^\d+$/.test(String(element.id))) throw new Error("Invalid OSM identifier");
      const key = element.type + "/" + element.id + "/" + feature.category;
      if (seen.has(key)) continue;
      seen.add(key);
      const result = await client.query(`
        WITH shape AS (
          SELECT ST_SetSRID(ST_GeomFromGeoJSON($7),4326) AS geom
        )
        INSERT INTO osm_features (osm_type,osm_id,category,name,subtype,tags,geom)
        SELECT $1,$2,$3,$4,$5,$6::jsonb,geom FROM shape
        WHERE ST_IsValid(geom) AND NOT ST_IsEmpty(geom)
        ON CONFLICT (osm_type,osm_id,category)
        DO UPDATE SET name=EXCLUDED.name,subtype=EXCLUDED.subtype,
          tags=EXCLUDED.tags,geom=EXCLUDED.geom,fetched_at=NOW()
        RETURNING id
      `, [element.type,String(element.id),feature.category,element.tags?.name || null,
        feature.subtype,JSON.stringify(element.tags || {}),JSON.stringify(feature.geometry)]);
      if (result.rowCount !== 1) throw new Error("Invalid OSM geometry; complete import rolled back");
      counts[feature.category]++;
    }
    const totalImported = counts.settlement + counts.hospital + counts.road;
    // Coverage and features commit atomically, including successful empty imports.
    await client.query(`
      INSERT INTO osm_import_coverage (latitude,longitude,radius_m,feature_count)
      VALUES ($1,$2,$3,$4)
      ON CONFLICT (latitude,longitude,radius_m)
      DO UPDATE SET feature_count=EXCLUDED.feature_count,imported_at=NOW()
    `, [lat,lon,radius,totalImported]);
    await client.query("COMMIT");
    logger.log("OSM import completed:", counts);
    return counts;
  } catch (cause) {
    await client.query("ROLLBACK");
    throw cause;
  } finally {
    client.release();
  }
}

async function main() {
  const [latArg, lonArg, radiusArg = "6000", ...extra] = process.argv.slice(2);
  if (!latArg?.trim() || !lonArg?.trim() || !radiusArg.trim() || extra.length) {
    throw new Error("Usage: node src/scripts/importOSM.js LAT LON RADIUS (500-12000m)");
  }
  await importOSM(Number(latArg), Number(lonArg), Number(radiusArg));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(cause => {
    console.error("OSM import failed:", cause.message);
    process.exitCode = 1;
  }).finally(() => pool.end());
}
