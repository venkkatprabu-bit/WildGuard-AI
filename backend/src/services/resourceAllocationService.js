import pool from "../config/db.js";
import { analyzeFireExposure } from "./exposureService.js";

export const RESOURCE_TYPES = ["fire_engine", "water_tanker", "medical_team"];
export const ALLOCATION_WARNING = "Hypothetical allocation simulation only. Units and availability are simulated. Straight-line distance does not establish road access, travel time, operational readiness, suitability, or safety. No resources are reserved or dispatched.";
const error = (status, message) => Object.assign(new Error(message), { status });
const round4 = n => Number(n.toFixed(4));

function numeric(query, name, fallback, min, max, integer = false) {
  if (query[name] === undefined) return fallback;
  const raw = query[name];
  const value = Number(raw);
  if (typeof raw !== "string" || !raw.trim() || !Number.isFinite(value) ||
      value < min || value > max || (integer && !Number.isInteger(value))) {
    throw error(400, name + " must be " + (integer ? "an integer " : "") + "between " + min + " and " + max);
  }
  return value;
}

export function parseAllocationOptions(query = {}) {
  const requested = {
    fire_engine: numeric(query, "fireEngines", 1, 0, 10, true),
    water_tanker: numeric(query, "waterTankers", 1, 0, 10, true),
    medical_team: numeric(query, "medicalTeams", 1, 0, 10, true)
  };
  if (!Object.values(requested).some(n => n > 0)) throw error(400, "Request at least one simulated unit");
  const maxDistanceKm = numeric(query, "maxDistanceKm", 50, 0.1, 200);
  if (query.includeExposure !== undefined && query.includeExposure !== "true" && query.includeExposure !== "false") {
    throw error(400, "includeExposure must be true or false");
  }
  const includeExposure = query.includeExposure !== "false";
  const exposureQuery = {};
  const manual = query.windSpeed !== undefined || query.windDirection !== undefined;
  if (manual && (query.windSpeed === undefined || query.windDirection === undefined)) {
    throw error(400, "Provide both windSpeed and windDirection");
  }
  if (manual) {
    numeric(query, "windSpeed", undefined, 0, 150);
    numeric(query, "windDirection", undefined, 0, 360);
    exposureQuery.windSpeed = query.windSpeed;
    exposureQuery.windDirection = query.windDirection;
  }
  if (query.baseRateKmh !== undefined) {
    numeric(query, "baseRateKmh", undefined, 0.01, 0.5);
    exposureQuery.baseRateKmh = query.baseRateKmh;
  }
  if (!includeExposure && (manual || query.baseRateKmh !== undefined)) {
    throw error(400, "Wind and base-rate parameters require includeExposure=true");
  }
  return { requested, maxDistanceKm, includeExposure, exposureQuery };
}

const RESOURCE_COLUMNS = `
  r.id,r.unit_code,r.name,r.resource_type,r.availability,r.simulation_only,
  r.data_source,r.updated_at,
  ST_Y(r.location::geometry) AS latitude,ST_X(r.location::geometry) AS longitude
`;

function resourceRecord(row) {
  return {
    id: String(row.id), unit_code: row.unit_code, name: row.name,
    resource_type: row.resource_type, availability: row.availability,
    simulation_only: true, source: row.data_source,
    location: { latitude: row.latitude, longitude: row.longitude },
    availability_recorded_at: row.updated_at
  };
}

function pointFeature(resource, properties = {}) {
  return { type: "Feature", id: resource.unit_code,
    geometry: { type: "Point", coordinates: [resource.location.longitude, resource.location.latitude] },
    properties: { id: resource.id, unit_code: resource.unit_code, name: resource.name,
      resource_type: resource.resource_type, availability: resource.availability,
      simulation_only: true, source: resource.source,
      availability_recorded_at: resource.availability_recorded_at, ...properties } };
}

export async function listSimulatedResources(query = {}, { db = pool } = {}) {
  const { type, availability } = query;
  if (type !== undefined && !RESOURCE_TYPES.includes(type)) throw error(400, "Invalid resource type");
  if (availability !== undefined && !["available","busy","maintenance","inactive"].includes(availability)) {
    throw error(400, "Invalid simulated availability");
  }
  const result = await db.query(`
    SELECT ${RESOURCE_COLUMNS}
    FROM simulated_resources r
    WHERE r.simulation_only=true
      AND ($1::text IS NULL OR r.resource_type=$1)
      AND ($2::text IS NULL OR r.availability=$2)
    ORDER BY r.unit_code COLLATE "C"
  `, [type ?? null, availability ?? null]);
  const resources = result.rows.map(resourceRecord);
  return { simulation_only: true, status: resources.length ? "loaded" : "empty_inventory",
    count: resources.length, resources,
    features: { type: "FeatureCollection", features: resources.map(r => pointFeature(r)) },
    warning: ALLOCATION_WARNING };
}

// Pure selection: exact (unrounded) metres, then stable ASCII unit code.
// Exposure is deliberately excluded from this toy selection policy.
export function selectSimulatedResources(rows, requested, maxDistanceKm) {
  const inventory = rows.map(row => {
    const resource = resourceRecord(row);
    const valid = RESOURCE_TYPES.includes(row.resource_type) &&
      row.simulation_only === true &&
      Number.isFinite(row.latitude) && Math.abs(row.latitude) <= 90 &&
      Number.isFinite(row.longitude) && Math.abs(row.longitude) <= 180 &&
      Number.isFinite(row.distance_m) && row.distance_m >= 0;
    let exclusion = null;
    if (!valid) exclusion = "invalid_resource_data";
    else if (row.availability !== "available") exclusion = "unavailable";
    else if (requested[row.resource_type] === 0) exclusion = "type_not_requested";
    else if (row.distance_m > maxDistanceKm * 1000) exclusion = "outside_distance_limit";
    return { ...resource, distance_km: valid ? round4(row.distance_m / 1000) : null,
      eligible: !exclusion, selected: false, exclusion_reason: exclusion,
      _distance: valid ? row.distance_m : Infinity };
  });
  inventory.sort((a, b) => a._distance - b._distance ||
    (a.unit_code < b.unit_code ? -1 : a.unit_code > b.unit_code ? 1 : 0));
  const selected = [];
  const summary = {};
  for (const type of RESOURCE_TYPES) {
    const candidates = inventory.filter(r => r.resource_type === type && r.eligible);
    const chosen = candidates.slice(0, requested[type]);
    for (const [index, unit] of chosen.entries()) {
      unit.selected = true;
      selected.push({ resource_id: unit.id, unit_code: unit.unit_code,
        resource_type: type, distance_km: unit.distance_km, location: unit.location,
        simulation_only: true, availability: unit.availability, source: unit.source,
        availability_recorded_at: unit.availability_recorded_at,
        rank_within_type: index + 1,
        selection_reason: "Simulated availability is available; ranked " + (index + 1) +
          " of " + candidates.length + " eligible " + type +
          " units by straight-line distance, then unit_code; within the " +
          maxDistanceKm + " km scenario limit." });
    }
    for (const unit of candidates.slice(requested[type])) {
      unit.exclusion_reason = "requested_count_already_filled";
    }
    summary[type] = { requested: requested[type], eligible: candidates.length,
      selected: chosen.length, shortfall: Math.max(0, requested[type] - chosen.length) };
  }
  return { inventory: inventory.map(({ _distance, ...r }) => r), selected, summary };
}

export async function simulateResourceAllocation(id, query = {}, {
  db = pool, getExposure = analyzeFireExposure, logger = console
} = {}) {
  if (typeof id !== "string" || !/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id))) {
    throw error(400, "Invalid fire ID");
  }
  const options = parseAllocationOptions(query);
  const fireResult = await db.query(`
    SELECT id,latitude,longitude,acquisition_time FROM fire_hotspots WHERE id=$1
  `, [id]);
  const fire = fireResult.rows[0];
  if (!fire) throw error(404, "Fire detection not found");
  const lat = Number(fire.latitude), lon = Number(fire.longitude);
  const time = new Date(fire.acquisition_time);
  if (fire.latitude == null || fire.longitude == null || !Number.isFinite(lat) ||
      !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180 ||
      !Number.isFinite(time.getTime()) || fire.acquisition_time == null || time.getTime() > Date.now()) {
    throw error(422, "Fire detection has unusable coordinates or timestamp");
  }
  // Current simulated availability is a scenario snapshot, not historical availability at detection time.
  const result = await db.query(`
    SELECT ${RESOURCE_COLUMNS},
      ST_Distance(r.location,ST_SetSRID(ST_MakePoint($1,$2),4326)::geography) AS distance_m
    FROM simulated_resources r
    WHERE r.simulation_only=true
    ORDER BY r.unit_code COLLATE "C"
  `, [lon, lat]);
  const { inventory, selected, summary } =
    selectSimulatedResources(result.rows, options.requested, options.maxDistanceKm);
  let exposure = { status: "not_requested", contextual_only: true };
  if (options.includeExposure) {
    try {
      const context = await getExposure(id, options.exposureQuery, { db });
      exposure = {
        status: context.status, contextual_only: true,
        horizons: context.horizons, simulation: context.simulation, warning: context.warning,
        note: "Mapped intersections do not determine resource demand, staffing, or operational safety."
      };
    } catch (cause) {
      logger.error("Allocation exposure context unavailable:", cause.code || cause.status || "unexpected_error");
      exposure = { status: "unavailable", contextual_only: true,
        reason: [502,503].includes(cause.status) ? "Historical weather unavailable; use paired manual wind parameters for exposure context." :
          "Exposure context could not be calculated.",
        upstream_status: Number.isInteger(cause.status) ? cause.status : 500 };
    }
  }
  const shortages = Object.values(summary).some(s => s.shortfall > 0);
  const status = !inventory.length ? "no_resources" :
    !selected.length ? "no_eligible_resources" : shortages ? "partial" : "complete";
  const assignmentsByCode = new Map(selected.map(a => [a.unit_code, a]));
  const features = { type: "FeatureCollection",
    features: inventory.filter(r => r.location && Number.isFinite(r.location.latitude) &&
      Number.isFinite(r.location.longitude) && Math.abs(r.location.latitude) <= 90 &&
      Math.abs(r.location.longitude) <= 180).map(r => pointFeature(r, {
        distance_km: r.distance_km, selected: r.selected, eligible: r.eligible,
        exclusion_reason: r.exclusion_reason,
        selection_reason: assignmentsByCode.get(r.unit_code)?.selection_reason || null,
        rank_within_type: assignmentsByCode.get(r.unit_code)?.rank_within_type || null
      })) };
  return {
    status, simulation_only: true,
    fire: { id: String(fire.id), latitude: lat, longitude: lon, acquisition_time: time.toISOString() },
    policy: {
      name: "Nearest available simulated units per type v1",
      requested: options.requested, max_distance_km: options.maxDistanceKm,
      ranking: ["availability must equal available", "exact straight-line distance ascending", "unit_code ascending"],
      distance_method: "PostGIS ST_Distance on EPSG:4326 geography, metres",
      exposure_affects_selection: false,
      availability_basis: "Current simulated inventory snapshot; not availability at historical fire time",
      demand_basis: "User-specified scenario counts or toy defaults; not inferred operational requirements"
    },
    summary, assignments: selected, resources: inventory, resource_features: features,
    selected_features: { type: "FeatureCollection", features: features.features.filter(f => f.properties.selected) },
    fire_feature: { type: "Feature", geometry: { type: "Point", coordinates: [lon, lat] },
      properties: { fire_id: String(fire.id), source: "NASA FIRMS" } },
    exposure, warning: ALLOCATION_WARNING
  };
}
