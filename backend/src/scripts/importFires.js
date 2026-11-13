
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "csv-parse/sync";
import pool from "../config/db.js";

// Path from backend folder to dataset
const filePath = fileURLToPath(new URL(
  "../../../datasets/nasafirms/wildgaurd_karanataka.csv",
  import.meta.url
));

async function importFires() {
  try {
    // Step 1: Read CSV
    const csvContent = fs.readFileSync(filePath, "utf8");

    // Step 2: Convert CSV into objects
    const records = parse(csvContent, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      bom: true
    });

    console.log(`CSV records found: ${records.length}`);

    let inserted = 0;
    let skipped = 0;

    // Step 3: Insert each detection
    for (const record of records) {
      const latitude = Number(record.latitude);
      const longitude = Number(record.longitude);
      const frp = Number(record.frp);
      const brightness = Number(record.bright_ti4);

      // NASA FIRMS acquisition times are UTC
      const rawDate = record.acq_date;
      const isoDate = rawDate.replace(/^(\d{2})-(\d{2})-(\d{4})$/, "$3-$2-$1");
      const rawTime = record.acq_time;
      const utcTime = /^\d{1,4}$/.test(rawTime)
        ? rawTime.padStart(4, "0").replace(/^(\d{2})(\d{2})$/, "$1:$2")
        : rawTime;
      const acquisitionTime = new Date(
        `${isoDate}T${utcTime}:00Z`
      );

      // Skip invalid records
      if (
        !Number.isFinite(latitude) ||
        !Number.isFinite(longitude) ||
        latitude < -90 ||
        latitude > 90 ||
        longitude < -180 ||
        longitude > 180 ||
        Number.isNaN(acquisitionTime.getTime())
      ) {
        skipped++;
        continue;
      }

      // Step 4: Store geographic point
      const result = await pool.query(
        `
        INSERT INTO fire_hotspots (
          latitude,
          longitude,
          acquisition_time,
          satellite,
          instrument,
          confidence,
          frp,
          brightness,
          location
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8,
          ST_SetSRID(
            ST_MakePoint($2, $1),
            4326
          )::geography
        )
        ON CONFLICT DO NOTHING
        RETURNING id
        `,
        [
          latitude,
          longitude,
          acquisitionTime,
          record.satellite,
          "VIIRS",
          record.confidence,
          Number.isFinite(frp) ? frp : null,
          Number.isFinite(brightness) ? brightness : null
        ]
      );

      if (result.rowCount === 1) {
        inserted++;
      } else {
        skipped++;
      }
    }

    console.log("Import completed!");
    console.log(`Inserted: ${inserted}`);
    console.log(`Skipped or already present: ${skipped}`);

  } catch (error) {
    console.error("Import failed:", error.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

importFires();
