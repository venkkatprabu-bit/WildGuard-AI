
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "csv-parse/sync";
import pool from "../config/db.js";

const filePath = fileURLToPath(
  new URL(
    "../../../datasets/weather/bandipur_weather_historical.csv",
    import.meta.url
  )
);

function toNumber(value) {
  if (value === undefined || value === "") return null;

  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

async function importWeather() {
  try {
    const content = fs.readFileSync(filePath, "utf8");
    const lines = content.split(/\r?\n/);

    // Read Open-Meteo metadata
    const [metadata] = parse(
      lines.slice(0, 2).join("\n"),
      { columns: true, skip_empty_lines: true }
    );

    if (metadata.timezone !== "Asia/Kolkata") {
      throw new Error("Unexpected weather CSV timezone");
    }

    const latitude = Number(metadata.latitude);
    const longitude = Number(metadata.longitude);

    // Locate weather records
    const headerIndex = lines.findIndex(
      line => line.startsWith("time,")
    );

    if (headerIndex === -1) {
      throw new Error("Weather CSV header not found");
    }

    const records = parse(
      lines.slice(headerIndex).join("\n"),
      {
        columns: true,
        skip_empty_lines: true,
        trim: true
      }
    );

    console.log(`Found ${records.length} weather records`);

    let inserted = 0;
    let skipped = 0;

    for (const row of records) {
      // Convert India local time to UTC
      const timestamp = new Date(
        `${row.time}:00+05:30`
      );

      if (Number.isNaN(timestamp.getTime())) {
        skipped++;
        continue;
      }

      const result = await pool.query(
        `
        INSERT INTO weather_observations (
          latitude, longitude, observation_time,
          temperature, humidity, wind_speed,
          wind_direction, precipitation,
          vapour_pressure_deficit, location
        )
        VALUES (
          $1, $2, $3, $4, $5,
          $6, $7, $8, $9,
          ST_SetSRID(
            ST_MakePoint($2, $1), 4326
          )::geography
        )
        ON CONFLICT (
          latitude, longitude, observation_time, source
        ) DO NOTHING
        RETURNING id
        `,
        [
          latitude,
          longitude,
          timestamp,
          toNumber(row["temperature_2m (°C)"]),
          toNumber(row["relative_humidity_2m (%)"]),
          toNumber(row["wind_speed_10m (km/h)"]),
          toNumber(row["wind_direction_10m (°)"]),
          toNumber(row["precipitation (mm)"]),
          toNumber(row["vapour_pressure_deficit (kPa)"])
        ]
      );

      if (result.rowCount === 1) inserted++;
      else skipped++;
    }

    console.log("Import complete!");
    console.log(`Inserted: ${inserted}`);
    console.log(`Skipped: ${skipped}`);

  } catch (error) {
    console.error("Import failed:", error.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

importWeather();
