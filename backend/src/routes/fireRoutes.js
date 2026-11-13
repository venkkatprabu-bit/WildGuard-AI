
import { Router } from "express";
import pool from "../config/db.js";

const router = Router();

// GET /api/fires
router.get("/", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        id,
        latitude,
        longitude,
        acquisition_time,
        satellite,
        confidence,
        frp
      FROM fire_hotspots
      ORDER BY acquisition_time DESC
      LIMIT 100
    `);

    res.json({
      success: true,
      count: result.rows.length,
      data: result.rows
    });
  } catch (error) {
    console.error(error.message);

    res.status(500).json({
      success: false,
      message: "Failed to retrieve fire hotspots"
    });
  }
});

export default router;
