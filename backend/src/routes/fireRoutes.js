
import { Router } from "express";
import pool from "../config/db.js";
import { getHistoricalWeather } from "../services/historicalWeatherService.js";
import { assessHotspotRisk } from "../services/dynamicRiskService.js";
import { generateSpreadSimulation } from "../services/spreadSimulationService.js";

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


// GET /api/fires/:id/weather

router.get("/:id/weather", async (req, res) => {
  try {
    const fireId = Number(req.params.id);

    if (!Number.isSafeInteger(fireId) || fireId <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid fire ID"
      });
    }

    // STEP 1: Retrieve fire detection from PostgreSQL
    const result = await pool.query(
      `
      SELECT
        id,
        latitude,
        longitude,
        acquisition_time
      FROM fire_hotspots
      WHERE id = $1
      `,
      [fireId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Fire detection not found"
      });
    }

    const fire = result.rows[0];

    // STEP 2: Request weather at the detection time
    const weather = await getHistoricalWeather(
      fire.latitude,
      fire.longitude,
      fire.acquisition_time
    );

    // STEP 3: Return combined information
    res.json({
      success: true,
      fire_id: fire.id,
      data: weather
    });

  } catch (error) {
    console.error("Historical weather error:", error);

    res.status(error.status || 502).json({
      success: false,
      message: error.status === 404
        ? error.message
        : "Historical weather retrieval failed"
    });
  }
});


// GET /api/fires/:id/risk

router.get("/:id/risk", async (req, res) => {
  try {
    const fireId = Number(req.params.id);

    if (!Number.isSafeInteger(fireId) || fireId <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid fire ID"
      });
    }

    // Retrieve the selected NASA FIRMS detection
    const result = await pool.query(
      `
      SELECT
        id,
        latitude,
        longitude,
        acquisition_time,
        satellite,
        confidence,
        frp
      FROM fire_hotspots
      WHERE id = $1
      `,
      [fireId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Fire detection not found"
      });
    }

    // Run the environmental risk analysis
    const analysis = await assessHotspotRisk(
      result.rows[0]
    );

    res.json({
      success: true,
      data: analysis
    });

  } catch (error) {
    console.error("Dynamic risk error:", error);

    res.status(500).json({
      success: false,
      message: "Unable to analyze selected fire detection"
    });
  }
});


// GET /api/fires/:id/spread

router.get("/:id/spread", async (req, res) => {
  try {
    const fireId = Number(req.params.id);

    if (!Number.isSafeInteger(fireId) || fireId <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid fire ID"
      });
    }

    // STEP 1: Retrieve NASA FIRMS detection
    const result = await pool.query(
      `
      SELECT
        id,
        latitude,
        longitude,
        acquisition_time
      FROM fire_hotspots
      WHERE id = $1
      `,
      [fireId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Fire detection not found"
      });
    }

    const fire = result.rows[0];

    // STEP 2: Optional demonstration parameters
    const manualSpeed = req.query.windSpeed;
    const manualDirection = req.query.windDirection;

    const usingManualWind =
      manualSpeed !== undefined ||
      manualDirection !== undefined;

    const baseRateKmh =
      req.query.baseRateKmh === undefined
        ? 0.12
        : Number(req.query.baseRateKmh);

    if (
      !Number.isFinite(baseRateKmh) ||
      baseRateKmh < 0.01 ||
      baseRateKmh > 0.5
    ) {
      return res.status(400).json({
        success: false,
        message: "baseRateKmh must be between 0.01 and 0.5"
      });
    }

    let windSpeed;
    let windDirection;
    let windSource;
    let weatherTime = null;

    if (usingManualWind) {
      // Scenario testing without external API calls
      if (
        manualSpeed === undefined ||
        manualDirection === undefined ||
        manualSpeed === "" ||
        manualDirection === ""
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Provide both windSpeed and windDirection"
        });
      }

      windSpeed = Number(manualSpeed);
      windDirection = Number(manualDirection);
      windSource = "Manual scenario inputs";

    } else {
      // Historical conditions at fire detection time
      const weather = await getHistoricalWeather(
        fire.latitude,
        fire.longitude,
        fire.acquisition_time
      );

      windSpeed = weather.wind_speed;
      windDirection = weather.wind_direction;
      windSource = weather.source;
      weatherTime = weather.weather_time;
    }

    if (
      !Number.isFinite(windSpeed) ||
      !Number.isFinite(windDirection) ||
      windSpeed < 0 ||
      windSpeed > 150 ||
      windDirection < 0 ||
      windDirection > 360
    ) {
      return res.status(422).json({
        success: false,
        message:
          "Valid wind speed and direction are required"
      });
    }

    // STEP 3: Generate the scenario polygons
    const simulation = generateSpreadSimulation({
      fire,
      windSpeed,
      windDirection,
      windSource,
      weatherTime,
      baseRateKmh
    });

    res.json({
      success: true,
      data: simulation
    });

  } catch (error) {
    console.error("Spread simulation error:", error);

    res.status(502).json({
      success: false,
      message: "Unable to generate spread scenario"
    });
  }
});


export default router;
