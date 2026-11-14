import { Router } from "express";
import { listSimulatedResources } from "../services/resourceAllocationService.js";

const router = Router();

// Simulated inventory only; availability is never changed by this endpoint.
router.get("/", async (req, res) => {
  try {
    res.json({ success: true, data: await listSimulatedResources(req.query) });
  } catch (error) {
    console.error("Simulated resource inventory error:", error.code || error.status || "unexpected_error");
    res.status(error.status === 400 ? 400 : 500).json({
      success: false,
      message: error.status === 400 ? error.message : "Unable to retrieve simulated resources"
    });
  }
});

export default router;
