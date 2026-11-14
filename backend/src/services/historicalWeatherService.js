
import pool from "../config/db.js";

const BASE_URL = "https://archive-api.open-meteo.com/v1/archive";

const VARIABLES = [
  "temperature_2m",
  "relative_humidity_2m",
  "wind_speed_10m",
  "wind_direction_10m",
  "precipitation",
  "vapour_pressure_deficit"
];

function numberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : null;
}

export async function getHistoricalWeather(lat, lon, detectedAt) {

  const detectionTime = new Date(detectedAt);

  if (Number.isNaN(detectionTime.getTime())) {
    throw new Error("Invalid fire detection time");
  }

  // Round the fire detection time down to its UTC hour
  const hourMs =
    Math.floor(detectionTime.getTime() / 3600000) * 3600000;

  const weatherTime = new Date(hourMs);
  const timestamp = weatherTime.toISOString();

  // STEP 1: Check PostgreSQL first
  const cached = await pool.query(
    `
    SELECT
      latitude, longitude, observation_time,
      temperature, humidity, wind_speed,
      wind_direction, precipitation,
      vapour_pressure_deficit, created_at,
      ST_Distance(
        location,
        ST_SetSRID(
          ST_MakePoint($2, $1), 4326
        )::geography
      ) AS distance_m
    FROM weather_observations
    WHERE source = 'Open-Meteo'
      AND observation_time = $3::timestamptz
      AND ST_DWithin(
        location,
        ST_SetSRID(
          ST_MakePoint($2, $1), 4326
        )::geography,
        15000
      )
      AND temperature IS NOT NULL
      AND humidity IS NOT NULL
      AND wind_speed IS NOT NULL
    ORDER BY distance_m ASC
    LIMIT 1
    `,
    [lat, lon, timestamp]
  );

  if (cached.rows.length > 0) {
    console.log("Historical weather: PostgreSQL cache HIT");

    const row = cached.rows[0];

    return {
      fire_detection_time: detectionTime.toISOString(),
      weather_time: timestamp,
      requested_location: { latitude: lat, longitude: lon },
      model_grid_location: {
        latitude: row.latitude,
        longitude: row.longitude
      },
      model_grid_distance_m: Number(row.distance_m),
      temperature: row.temperature,
      humidity: row.humidity,
      wind_speed: row.wind_speed,
      wind_direction: row.wind_direction,
      precipitation: row.precipitation,
      vapour_pressure_deficit: row.vapour_pressure_deficit,
      source: "Open-Meteo Historical (ERA5)",
      cached: true,
      stored_at: row.created_at
    };
  }

  // STEP 2: Cache miss — request Open-Meteo
  console.log("Historical weather: cache MISS");

  const url = new URL(BASE_URL);

  url.searchParams.set("latitude", String(lat));
  url.searchParams.set("longitude", String(lon));
  url.searchParams.set("start_date", timestamp.slice(0, 10));
  url.searchParams.set("end_date", timestamp.slice(0, 10));
  url.searchParams.set("hourly", VARIABLES.join(","));
  url.searchParams.set("timezone", "GMT");
  url.searchParams.set("timeformat", "unixtime");
  url.searchParams.set("models", "era5");

  let apiData;

  // Retry once for transient failures
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      console.log(`Open-Meteo request attempt ${attempt}`);

      const response = await fetch(url, {
        signal: AbortSignal.timeout(20000)
      });

      if (!response.ok) {
        const error = new Error(
          `Open-Meteo HTTP ${response.status}`
        );
        error.httpStatus = response.status;
        throw error;
      }

      apiData = await response.json();
      break;

    } catch (error) {
      const retryable =
        !error.httpStatus ||
        error.httpStatus === 429 ||
        error.httpStatus >= 500;

      if (!retryable || attempt === 2) {
        throw error;
      }

      await new Promise(resolve =>
        setTimeout(resolve, 1500)
      );
    }
  }

  // STEP 3: Extract weather for the detection hour
  const hourly = apiData?.hourly;

  if (!Array.isArray(hourly?.time)) {
    throw new Error("Open-Meteo returned no hourly data");
  }

  const hourSeconds = hourMs / 1000;
  const index = hourly.time.indexOf(hourSeconds);

  if (index === -1) {
    throw new Error("Detection-hour weather unavailable");
  }

  const value = key => numberOrNull(hourly[key]?.[index]);

  const weather = {
    temperature: value("temperature_2m"),
    humidity: value("relative_humidity_2m"),
    wind_speed: value("wind_speed_10m"),
    wind_direction: value("wind_direction_10m"),
    precipitation: value("precipitation"),
    vapour_pressure_deficit: value("vapour_pressure_deficit")
  };

  if (
    weather.temperature === null ||
    weather.humidity === null ||
    weather.wind_speed === null
  ) {
    throw new Error("Required weather values are missing");
  }

  const gridLat = Number(apiData.latitude);
  const gridLon = Number(apiData.longitude);

  if (
    !Number.isFinite(gridLat) ||
    !Number.isFinite(gridLon)
  ) {
    throw new Error("Invalid weather model-grid coordinates");
  }

  // STEP 4: Save to PostgreSQL
  await pool.query(
    `
    INSERT INTO weather_observations (
      latitude, longitude, observation_time,
      temperature, humidity, wind_speed,
      wind_direction, precipitation,
      vapour_pressure_deficit, source, location
    )
    VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9,
      'Open-Meteo',
      ST_SetSRID(
        ST_MakePoint($2, $1), 4326
      )::geography
    )
    ON CONFLICT (
      latitude, longitude, observation_time, source
    ) DO NOTHING
    `,
    [
      gridLat,
      gridLon,
      timestamp,
      weather.temperature,
      weather.humidity,
      weather.wind_speed,
      weather.wind_direction,
      weather.precipitation,
      weather.vapour_pressure_deficit
    ]
  );

  console.log("Historical weather saved to PostgreSQL");

  // STEP 5: Return weather to client
  return {
    fire_detection_time: detectionTime.toISOString(),
    weather_time: timestamp,
    requested_location: { latitude: lat, longitude: lon },
    model_grid_location: {
      latitude: gridLat,
      longitude: gridLon
    },
    ...weather,
    source: "Open-Meteo Historical (ERA5)",
    cached: false,
    stored_at: new Date().toISOString()
  };
}
