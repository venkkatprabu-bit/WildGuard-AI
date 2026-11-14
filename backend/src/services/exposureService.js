import pool from "../config/db.js";
import { getHistoricalWeather } from "./historicalWeatherService.js";
import { generateSpreadSimulation } from "./spreadSimulationService.js";

const HORIZONS = [1, 3, 6];
const WARNING = "Experimental geometric exposure only. Not confirmed damage, predicted fire progression, evacuation guidance, or dispatch advice. OSM mapping may be incomplete; settlement points do not represent population or settlement boundaries.";
const error = (status, message) => Object.assign(new Error(message), { status });

function validatePolygon(geometry) {
  if (geometry?.type !== "Polygon" || !Array.isArray(geometry.coordinates) ||
      !geometry.coordinates.length) throw error(422, "A nonempty GeoJSON Polygon is required");
  for (const ring of geometry.coordinates) {
    if (!Array.isArray(ring) || ring.length < 4 ||
        ring.some(p => !Array.isArray(p) || p.length !== 2 ||
          !Number.isFinite(p[0]) || !Number.isFinite(p[1]) ||
          p[0] < -180 || p[0] > 180 || p[1] < -90 || p[1] > 90) ||
        ring[0][0] !== ring.at(-1)[0] || ring[0][1] !== ring.at(-1)[1]) {
      throw error(422, "Invalid GeoJSON polygon coordinates or unclosed ring");
    }
    // Dateline wrapping needs a different representation than a single planar polygon.
    if (ring.some((p, i) => i && Math.abs(p[0] - ring[i - 1][0]) > 180)) {
      throw error(422, "Scenarios crossing the antimeridian are not supported");
    }
  }
}

export async function analyzeExposure(simulation, db = pool) {
  if (simulation?.type !== "FeatureCollection" || !Array.isArray(simulation.features) ||
      simulation.features.length !== 3 ||
      HORIZONS.some(h => simulation.features.filter(f =>
        f.type === "Feature" && f.properties?.horizon_hours === h).length !== 1)) {
    throw error(422, "Simulation must contain exactly the 1, 3 and 6 hour polygon features");
  }
  for (const feature of simulation.features) validatePolygon(feature.geometry);
  const horizons = [];
  for (const hours of HORIZONS) {
    const feature = simulation.features.find(f => f.properties.horizon_hours === hours);
    const geometry = JSON.stringify(feature.geometry);
    const validation = await db.query(`
      SELECT ST_IsValid(g) AND NOT ST_IsEmpty(g) AND ST_Area(g) > 0 AS valid
      FROM (SELECT ST_SetSRID(ST_GeomFromGeoJSON($1::jsonb),4326) AS g) s
    `, [geometry]);
    if (!validation.rows[0]?.valid) throw error(422, "Invalid simulation polygon at " + hours + " hours");

    const coverageResult = await db.query(`
      WITH scenario AS (
        SELECT ST_SetSRID(ST_GeomFromGeoJSON($1::jsonb),4326) AS geom
      ), regions AS (
        SELECT c.*, ST_Buffer(
          ST_SetSRID(ST_MakePoint(c.longitude,c.latitude),4326)::geography,
          c.radius_m, 'quad_segs=32'
        )::geometry AS geom
        FROM osm_import_coverage c
      ), relevant AS (
        SELECT r.* FROM regions r CROSS JOIN scenario s
        WHERE ST_Intersects(r.geom,s.geom)
      )
      SELECT COALESCE(ST_Covers(ST_UnaryUnion(ST_Collect(r.geom)),
        (SELECT geom FROM scenario)),false) AS covered,
        COALESCE(jsonb_agg(jsonb_build_object(
          'latitude',r.latitude,'longitude',r.longitude,'radius_m',r.radius_m,
          'feature_count',r.feature_count,'imported_at',r.imported_at
        )), '[]'::jsonb) AS imports
      FROM relevant r
    `, [geometry]);
    const coverage = coverageResult.rows[0];
    const base = {
      horizon_hours: hours,
      coverage: { complete: Boolean(coverage?.covered), imports: coverage?.imports || [] },
      source: "OpenStreetMap via Overpass; locally imported snapshot"
    };
    if (!coverage?.covered) {
      horizons.push({ ...base, status: "coverage_unavailable", counts: null,
        features: { type: "FeatureCollection", features: [] } });
      continue;
    }
    const result = await db.query(`
      WITH scenario AS (
        SELECT ST_SetSRID(ST_GeomFromGeoJSON($1::jsonb),4326) AS geom
      )
      SELECT f.osm_type,f.osm_id,f.category,f.name,f.subtype,f.tags,f.fetched_at,
        ST_AsGeoJSON(ST_Intersection(f.geom,s.geom))::jsonb AS overlap_geometry
      FROM osm_features f CROSS JOIN scenario s
      WHERE f.category IN ('settlement','hospital','road')
        AND f.geom && s.geom AND ST_Intersects(f.geom,s.geom)
      ORDER BY f.category,f.osm_type,f.osm_id
    `, [geometry]);
    const counts = { settlement: 0, hospital: 0, road: 0 };
    const seen = new Set();
    const features = [];
    for (const row of result.rows) {
      const key = row.osm_type + "/" + row.osm_id + "/" + row.category;
      if (seen.has(key)) continue;
      seen.add(key);
      counts[row.category]++;
      const { overlap_geometry, ...properties } = row;
      features.push({ type: "Feature", id: key, geometry: overlap_geometry,
        properties: { ...properties, horizon_hours: hours, source: "OpenStreetMap" } });
    }
    horizons.push({ ...base, status: "analyzed", counts,
      features: { type: "FeatureCollection", features } });
  }
  return {
    status: horizons.every(h => h.status === "analyzed") ? "complete" :
      horizons.every(h => h.status === "coverage_unavailable") ? "coverage_unavailable" : "partial",
    fire_id: simulation.metadata?.fire_id, simulation, horizons, warning: WARNING
  };
}

function parameter(value, name, min, max) {
  if (typeof value !== "string" || !value.trim() || !Number.isFinite(Number(value)) ||
      Number(value) < min || Number(value) > max) {
    throw error(400, name + " must be between " + min + " and " + max);
  }
  return Number(value);
}

// Dependencies are optional so tests can use isolated PostGIS tables and deterministic weather.
export async function analyzeFireExposure(id, query = {}, {
  db = pool, getWeather = getHistoricalWeather,
  simulate = generateSpreadSimulation, analyze = analyzeExposure
} = {}) {
  if (typeof id !== "string" || !/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id))) {
    throw error(400, "Invalid fire ID");
  }
  const baseRateKmh = query.baseRateKmh === undefined ? 0.12 :
    parameter(query.baseRateKmh, "baseRateKmh", 0.01, 0.5);
  const manual = query.windSpeed !== undefined || query.windDirection !== undefined;
  let windSpeed, windDirection, windSource, weatherTime = null;
  if (manual) {
    if (query.windSpeed === undefined || query.windDirection === undefined) {
      throw error(400, "Provide both windSpeed and windDirection");
    }
    windSpeed = parameter(query.windSpeed, "windSpeed", 0, 150);
    windDirection = parameter(query.windDirection, "windDirection", 0, 360);
    windSource = "Manual scenario inputs";
  }
  const result = await db.query(`
    SELECT id,latitude,longitude,acquisition_time FROM fire_hotspots WHERE id=$1
  `, [id]);
  if (!result.rows.length) throw error(404, "Fire detection not found");
  const fire = result.rows[0];
  const lat = Number(fire.latitude), lon = Number(fire.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 ||
      Math.abs(lon) > 180 || !Number.isFinite(new Date(fire.acquisition_time).getTime()) ||
      new Date(fire.acquisition_time).getTime() > Date.now()) {
    throw error(422, "Fire detection has unusable coordinates or timestamp");
  }
  if (!manual) {
    let weather;
    try {
      weather = await getWeather(lat, lon, fire.acquisition_time);
    } catch (cause) {
      // Preserve database errors as server failures rather than labeling them as weather outages.
      if (cause.code) throw cause;
      throw error(502, "Historical wind unavailable; try both windSpeed and windDirection as manual scenario parameters");
    }
    windSpeed = weather?.wind_speed;
    windDirection = weather?.wind_direction;
    windSource = weather?.source;
    weatherTime = weather?.weather_time;
    const weatherMs = Date.parse(weatherTime);
    const ageMs = new Date(fire.acquisition_time).getTime() - weatherMs;
    if (!Number.isFinite(windSpeed) || windSpeed < 0 || windSpeed > 150 ||
        !Number.isFinite(windDirection) || windDirection < 0 || windDirection > 360 ||
        !Number.isFinite(weatherMs) || ageMs < 0 || ageMs >= 3600000) {
      throw error(502, "Historical wind missing or does not match the detection hour; try manual windSpeed and windDirection");
    }
  }
  const simulation = simulate({ fire, windSpeed, windDirection, windSource, weatherTime, baseRateKmh });
  return analyze(simulation, db);
}
