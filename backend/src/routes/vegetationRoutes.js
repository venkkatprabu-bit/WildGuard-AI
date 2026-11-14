
import { Router } from "express";
import { getVegetationAtPoint } from "../services/vegetationService.js";
import { getDynamicVegetation } from "../services/dynamicVegetationService.js";

const router = Router();

// GET /api/vegetation?lat=11.6644&lon=76.628
router.get("/", async (req, res) => {
  try {
    const lat = Number(req.query.lat);
    const lon = Number(req.query.lon);

    if (
      req.query.lat == null ||
      req.query.lon == null ||
      !Number.isFinite(lat) ||
      !Number.isFinite(lon) ||
      lat < -90 || lat > 90 ||
      lon < -180 || lon > 180
    ) {
      return res.status(400).json({
        success: false,
        message: "Valid lat and lon are required"
      });
    }

    const vegetation = await getVegetationAtPoint(
      lat,
      lon
    );

    if (!vegetation) {
      return res.status(404).json({
        success: false,
        message: "Location outside Bandipur raster coverage"
      });
    }

    res.json({
      success: true,
      location: { latitude: lat, longitude: lon },
      data: vegetation
    });

  } catch (error) {
    console.error("Vegetation API error:", error.message);

    res.status(500).json({
      success: false,
      message: "Failed to retrieve vegetation data"
    });
  }
});



// GET /api/vegetation/live?lat=...&lon=...&at=...

router.get("/live", async (req, res) => {
  try {
    const { lat, lon, at } = req.query;

    if (lat == null || lon == null || lat === "" || lon === "") {
      return res.status(400).json({
        success: false,
        message: "Latitude and longitude are required"
      });
    }

    const latitude = Number(lat);
    const longitude = Number(lon);

    if (
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude) ||
      latitude < -90 || latitude > 90 ||
      longitude < -180 || longitude > 180
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid coordinates"
      });
    }

    if (at != null && (
      Number.isNaN(new Date(at).getTime()) ||
      new Date(at).getTime() > Date.now()
    )) {
      return res.status(400).json({
        success: false,
        message: "Invalid analysis timestamp"
      });
    }

    const vegetation = await getDynamicVegetation(
      latitude,
      longitude,
      at
    );

    res.json({
      success: true,
      data: vegetation
    });

  } catch (error) {
    console.error("Dynamic vegetation error:", error);

    res.status(error.status || 502).json({
      success: false,
      message: error.status === 404
        ? error.message
        : "Unable to retrieve Sentinel-2 vegetation data"
    });
  }
});

export default router;
