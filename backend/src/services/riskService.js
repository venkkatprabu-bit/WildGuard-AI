
import pool from "../config/db.js";
import { getVegetationAtPoint } from "./vegetationService.js";

// Keep a value between 0 and 100
function clamp(value) {
  return Math.max(0, Math.min(100, value));
}

function createError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function getRiskLevel(score) {
  if (score >= 75) return "EXTREME";
  if (score >= 55) return "HIGH";
  if (score >= 30) return "MODERATE";
  return "LOW";
}

export async function calculateWildfireRisk(lat, lon, at) {

  // STEP 1: Get Sentinel-2 vegetation information
  const vegetation = await getVegetationAtPoint(lat, lon);

  if (!vegetation) {
    throw createError(
      404,
      "Location is outside the available vegetation raster"
    );
  }

  // Do not use an image captured after the analysis time.
  // This conservative check waits until after the image date.
  const imageDayEnd = new Date(
    `${vegetation.image_date}T23:59:59Z`
  );

  if (at <= imageDayEnd) {
    throw createError(
      422,
      "Analysis time must be after the satellite image date"
    );
  }

  // STEP 2: Get nearby historical weather
  // Only use observations from the previous two hours.
  const result = await pool.query(
    `
    SELECT
      latitude,
      longitude,
      observation_time,
      temperature,
      humidity,
      wind_speed,
      wind_direction,
      precipitation,
      vapour_pressure_deficit,
      ST_Distance(
        location,
        ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography
      ) AS distance_m
    FROM weather_observations
    WHERE source = 'Open-Meteo'
      AND observation_time <= $3::timestamptz
      AND observation_time >=
          $3::timestamptz - INTERVAL '2 hours'
      AND ST_DWithin(
        location,
        ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography,
        25000
      )
    ORDER BY observation_time DESC, distance_m ASC
    LIMIT 1
    `,
    [lat, lon, at.toISOString()]
  );

  if (result.rows.length === 0) {
    throw createError(
      404,
      "No suitable historical weather observation found"
    );
  }

  const weather = result.rows[0];

  // STEP 3: Check required measurements
  const inputs = {
    temperature: weather.temperature,
    humidity: weather.humidity,
    wind_speed: weather.wind_speed,
    ndvi: vegetation.ndvi,
    ndmi: vegetation.ndmi
  };

  const missing = Object.entries(inputs)
    .filter(([, value]) => !Number.isFinite(value))
    .map(([key]) => key);

  if (missing.length > 0) {
    throw createError(
      422,
      `Missing or invalid measurements: ${missing.join(", ")}`
    );
  }

  // STEP 4: Normalize factors to 0–100
  // Experimental thresholds for prototype use only
  const factors = [
    {
      name: "Temperature",
      score: clamp(
        ((weather.temperature - 15) / 25) * 100
      ),
      weight: 0.25
    },
    {
      name: "Low humidity",
      score: clamp(100 - weather.humidity),
      weight: 0.25
    },
    {
      name: "Wind speed",
      score: clamp((weather.wind_speed / 40) * 100),
      weight: 0.20
    },
    {
      name: "Vegetation moisture proxy",
      score: clamp(
        ((0.4 - vegetation.ndmi) / 0.6) * 100
      ),
      weight: 0.20
    },
    {
      name: "Vegetation cover proxy",
      score: clamp(
        ((vegetation.ndvi - 0.1) / 0.7) * 100
      ),
      weight: 0.10
    }
  ];

  // STEP 5: Weighted score
  const total = factors.reduce(
    (sum, factor) =>
      sum + factor.score * factor.weight,
    0
  );

  const riskScore = Math.round(total);
  const riskLevel = getRiskLevel(riskScore);

  // STEP 6: Explain higher contributing factors
  const mainFactors = factors
    .filter(factor => factor.score >= 60)
    .sort(
      (a, b) =>
        b.score * b.weight - a.score * a.weight
    )
    .map(factor => factor.name);

  return {
    location: {
      latitude: lat,
      longitude: lon
    },
    analysis_time: at.toISOString(),
    risk_score: riskScore,
    risk_level: riskLevel,
    main_factors: mainFactors,
    factor_breakdown: factors.map(factor => ({
      name: factor.name,
      normalized_score: Number(factor.score.toFixed(2)),
      weight: factor.weight,
      weighted_points: Number(
        (factor.score * factor.weight).toFixed(2)
      )
    })),
    weather: {
      ...weather,
      source: "Open-Meteo historical"
    },
    vegetation,
    model: "Experimental weighted risk score v1",
    warning:
      "Research prototype only. Not a validated fire-danger forecast. Vegetation imagery has not been fully cloud-masked."
  };
}
