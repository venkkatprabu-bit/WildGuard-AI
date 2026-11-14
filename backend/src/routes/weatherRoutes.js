
import { Router } from "express";
import pool from "../config/db.js";

const router = Router();

// GET /api/weather/bandipur
router.get("/bandipur", async (req, res) => {
  try {
    const limit = Number(req.query.limit ?? 24);

    if (!Number.isInteger(limit) || limit < 1 || limit > 168) {
      return res.status(400).json({
        success: false,
        message: "Limit must be between 1 and 168"
      });
    }

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
        vapour_pressure_deficit
      FROM weather_observations
      WHERE source = 'Open-Meteo'
      ORDER BY observation_time DESC
      LIMIT $1
      `,
      [limit]
    );

    res.status(200).json({
      success: true,
      location: "Bandipur National Park",
      source: "Open-Meteo",
      data_type: "historical",
      count: result.rows.length,
      last_observation_at:
        result.rows[0]?.observation_time ?? null,
      data: result.rows
    });

  } catch (error) {
    console.error("Weather API Error:", error.message);

    res.status(500).json({
      success: false,
      message: "Failed to fetch weather data"
    });
  }
});

export default router;
