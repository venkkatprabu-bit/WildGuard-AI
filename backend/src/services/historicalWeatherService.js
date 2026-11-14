
import pool from "../config/db.js";

const ARCHIVE_URL =
  "https://archive-api.open-meteo.com/v1/archive";

const HISTORICAL_FORECAST_URL =
  "https://historical-forecast-api.open-meteo.com/v1/forecast";

const RECENT_FORECAST_URL =
  "https://api.open-meteo.com/v1/forecast";

const VARIABLES = [
  "temperature_2m",
  "relative_humidity_2m",
  "wind_speed_10m",
  "wind_direction_10m",
  "precipitation",
  "vapour_pressure_deficit"
];

function numeric(value) {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : null;
}

async function fetchWeather(source, lat, lon, timestamp) {
  const url = new URL(source.url);

  url.searchParams.set("latitude", String(lat));
  url.searchParams.set("longitude", String(lon));
  url.searchParams.set("hourly", VARIABLES.join(","));
  url.searchParams.set("timezone", "GMT");
  url.searchParams.set("timeformat", "unixtime");

  if (source.type === "recent") {
    // Recently available forecast-model data
    url.searchParams.set("past_days", "10");
    url.searchParams.set("forecast_days", "1");
  } else {
    const date = timestamp.slice(0, 10);

    url.searchParams.set("start_date", date);
    url.searchParams.set("end_date", date);
  }

  if (source.type === "era5") {
    url.searchParams.set("models", "era5");
  }

  console.log(`Weather source: ${source.name}`);

  const response = await fetch(url, {
    signal: AbortSignal.timeout(25000)
  });

  if (!response.ok) {
    const details = await response.text();

    throw new Error(
      `Open-Meteo HTTP ${response.status}: ${details.slice(0, 200)}`
    );
  }

  return response.json();
}

export async function getHistoricalWeather(lat, lon, detectedAt) {
  const detectionTime = new Date(detectedAt);

  if (
    Number.isNaN(detectionTime.getTime()) ||
    detectionTime.getTime() > Date.now()
  ) {
    throw new Error("Invalid fire detection timestamp");
  }

  const hourMs =
    Math.floor(detectionTime.getTime() / 3600000) * 3600000;

  const timestamp = new Date(hourMs).toISOString();
  const hourSeconds = hourMs / 1000;

  const ageDays =
    (Date.now() - detectionTime.getTime()) / 86400000;

  const historicalForecast = {
    name: "Open-Meteo Historical Forecast",
    url: HISTORICAL_FORECAST_URL,
    type: "historical"
  };

  // Choose API sources based on detection age.
  // Recent events cannot reliably use delayed ERA5 data.
  const sources = ageDays < 7
    ? [
        historicalForecast,
        {
          name: "Open-Meteo Recent Forecast",
          url: RECENT_FORECAST_URL,
          type: "recent"
        }
      ]
    : [
        {
          name: "Open-Meteo ERA5",
          url: ARCHIVE_URL,
          type: "era5"
        },
        historicalForecast
      ];

  let lastProblem = "No suitable historical weather found";

  for (const source of sources) {

    // STEP 1: Search PostgreSQL for this exact request
    const cached = await pool.query(
      `
      SELECT *
      FROM weather_observations
      WHERE latitude = $1
        AND longitude = $2
        AND observation_time = $3::timestamptz
        AND source = $4
        AND temperature IS NOT NULL
        AND humidity IS NOT NULL
        AND wind_speed IS NOT NULL
        AND wind_direction IS NOT NULL
      LIMIT 1
      `,
      [lat, lon, timestamp, source.name]
    );

    if (cached.rows.length > 0) {
      console.log(`Weather cache HIT: ${source.name}`);

      const row = cached.rows[0];

      return {
        fire_detection_time: detectionTime.toISOString(),
        weather_time: timestamp,
        requested_location: {
          latitude: lat,
          longitude: lon
        },
        model_grid_location:
          row.model_latitude == null ||
          row.model_longitude == null
            ? null
            : {
                latitude: row.model_latitude,
                longitude: row.model_longitude
              },
        temperature: row.temperature,
        humidity: row.humidity,
        wind_speed: row.wind_speed,
        wind_direction: row.wind_direction,
        precipitation: row.precipitation,
        vapour_pressure_deficit:
          row.vapour_pressure_deficit,
        source: row.source,
        cached: true
      };
    }

    console.log(`Weather cache MISS: ${source.name}`);

    // STEP 2: Retrieve data from Open-Meteo
    let result;

    try {
      result = await fetchWeather(
        source, lat, lon, timestamp
      );
    } catch (error) {
      console.error(
        `${source.name} request failed:`,
        error.message
      );
      lastProblem = error.message;
      continue;
    }

    const hourly = result.hourly;
    const index = hourly?.time?.indexOf(hourSeconds) ?? -1;

    if (index === -1) {
      lastProblem = `No matching hourly record from ${source.name}`;
      console.warn(lastProblem);
      continue;
    }

    const value = name => numeric(hourly[name]?.[index]);

    const weather = {
      temperature: value("temperature_2m"),
      humidity: value("relative_humidity_2m"),
      wind_speed: value("wind_speed_10m"),
      wind_direction: value("wind_direction_10m"),
      precipitation: value("precipitation"),
      vapour_pressure_deficit:
        value("vapour_pressure_deficit")
    };

    // STEP 3: Reject missing essential measurements
    const required = [
      "temperature",
      "humidity",
      "wind_speed",
      "wind_direction"
    ];

    const missing = required.filter(
      key => weather[key] === null
    );

    if (missing.length > 0) {
      lastProblem =
        `${source.name} missing: ${missing.join(", ")}`;

      console.warn(lastProblem);
      continue;
    }

    const gridLat = numeric(result.latitude);
    const gridLon = numeric(result.longitude);

    if (gridLat === null || gridLon === null) {
      lastProblem = "Weather model-grid coordinates missing";
      continue;
    }

    // STEP 4: Cache successful observations
    await pool.query(
      `
      INSERT INTO weather_observations (
        latitude,
        longitude,
        observation_time,
        temperature,
        humidity,
        wind_speed,
        wind_direction,
        precipitation,
        vapour_pressure_deficit,
        source,
        location,
        model_latitude,
        model_longitude
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
        ST_SetSRID(
          ST_MakePoint($2, $1), 4326
        )::geography,
        $11, $12
      )
      ON CONFLICT (
        latitude, longitude, observation_time, source
      )
      DO UPDATE SET
        temperature = EXCLUDED.temperature,
        humidity = EXCLUDED.humidity,
        wind_speed = EXCLUDED.wind_speed,
        wind_direction = EXCLUDED.wind_direction,
        precipitation = EXCLUDED.precipitation,
        vapour_pressure_deficit =
          EXCLUDED.vapour_pressure_deficit,
        model_latitude = EXCLUDED.model_latitude,
        model_longitude = EXCLUDED.model_longitude
      `,
      [
        lat, lon, timestamp,
        weather.temperature,
        weather.humidity,
        weather.wind_speed,
        weather.wind_direction,
        weather.precipitation,
        weather.vapour_pressure_deficit,
        source.name,
        gridLat,
        gridLon
      ]
    );

    console.log(`Weather saved: ${source.name}`);

    return {
      fire_detection_time: detectionTime.toISOString(),
      weather_time: timestamp,
      requested_location: {
        latitude: lat,
        longitude: lon
      },
      model_grid_location: {
        latitude: gridLat,
        longitude: gridLon
      },
      ...weather,
      source: source.name,
      cached: false
    };
  }

  const error = new Error(lastProblem);
  error.status = 422;
  throw error;
}
