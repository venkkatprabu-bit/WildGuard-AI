
import { Router } from "express";
import { calculateWildfireRisk } from "../services/riskService.js";

const router = Router();

// GET /api/risk?lat=...&lon=...&at=...
router.get("/", async (req, res) => {
  try {
    const { lat, lon, at } = req.query;

    if (lat == null || lon == null || !at) {
      return res.status(400).json({
        success: false,
        message: "lat, lon and at are required"
      });
    }

    const latitude = Number(lat);
    const longitude = Number(lon);
    const analysisTime = new Date(at);

    if (
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude) ||
      latitude < -90 || latitude > 90 ||
      longitude < -180 || longitude > 180 ||
      Number.isNaN(analysisTime.getTime())
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid coordinates or ISO 8601 timestamp"
      });
    }

    const analysis = await calculateWildfireRisk(
      latitude,
      longitude,
      analysisTime
    );

    res.status(200).json({
      success: true,
      data: analysis
    });

  } catch (error) {
    console.error("Risk API error:", error);

    res.status(error.status || 500).json({
      success: false,
      message: error.status
        ? error.message
        : "Failed to calculate wildfire risk"
    });
  }
});

export default router;
