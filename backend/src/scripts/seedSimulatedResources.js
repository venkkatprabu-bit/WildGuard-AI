import "dotenv/config";
import { pathToFileURL } from "node:url";
import pool from "../config/db.js";

// Fictional coordinates relative to a user-specified scenario center.
// These names do not identify actual stations, vehicles or personnel.
export function demoResources(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 89 ||
      Math.abs(lon) > 179) throw new Error("Demo center must be within latitude -89 to 89 and longitude -179 to 179");
  return [
    ["SIM-DEMO-ENGINE-01", "fire_engine", "available", 0.01, 0.01],
    ["SIM-DEMO-ENGINE-02", "fire_engine", "available", -0.02, 0.02],
    ["SIM-DEMO-ENGINE-03", "fire_engine", "busy", 0.002, 0.002],
    ["SIM-DEMO-TANKER-01", "water_tanker", "available", 0.015, -0.01],
    ["SIM-DEMO-TANKER-02", "water_tanker", "maintenance", 0.003, -0.003],
    ["SIM-DEMO-MEDICAL-01", "medical_team", "available", -0.01, -0.015]
  ].map(([unit_code, resource_type, availability, dy, dx]) => ({
    unit_code, name: "Fictional demo " + unit_code, resource_type, availability,
    latitude: lat + dy, longitude: lon + dx
  }));
}

export async function seedSimulatedResources(lat, lon, db = pool) {
  const rows = demoResources(lat, lon);
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    let inserted = 0;
    for (const row of rows) {
      const result = await client.query(`
        INSERT INTO simulated_resources
          (unit_code,name,resource_type,availability,location,simulation_only,data_source)
        VALUES ($1,$2,$3,$4,ST_SetSRID(ST_MakePoint($5,$6),4326)::geography,true,$7)
        ON CONFLICT (unit_code) DO NOTHING
      `, [row.unit_code,row.name,row.resource_type,row.availability,
        row.longitude,row.latitude,"Fictional demo fixture; not real resource or station data"]);
      inserted += result.rowCount;
    }
    await client.query("COMMIT");
    return { inserted, already_present: rows.length - inserted,
      simulation_only: true, note: "Existing demo rows were preserved, including locations and availability." };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}

async function main() {
  const [lat, lon, ...extra] = process.argv.slice(2);
  if (typeof lat !== "string" || !lat.trim() || typeof lon !== "string" || !lon.trim() || extra.length) {
    throw new Error("Usage: node src/scripts/seedSimulatedResources.js LAT LON");
  }
  console.log(await seedSimulatedResources(Number(lat), Number(lon)));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error("Simulated resource seed failed:", error.message); process.exitCode = 1; })
    .finally(() => pool.end());
}
