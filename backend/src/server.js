
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import pool from "./config/db.js";
import fireRoutes from "./routes/fireRoutes.js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors({ origin: "http://localhost:4200" }));
app.use(express.json());

// Backend health check
app.get("/api/health", (req, res) => {
  res.json({
    status: "success",
    message: "WildGuard AI Backend Running"
  });
});

// Database connection check
app.get("/api/db-test", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        current_database() AS database,
        NOW() AS server_time,
        PostGIS_Version() AS postgis_version
    `);

    res.json({
      status: "success",
      message: "PostgreSQL and PostGIS Connected",
      data: result.rows[0]
    });
  } catch (error) {
    console.error("Database error:", error.message);

    res.status(500).json({
      status: "error",
      message: "Database connection failed"
    });
  }
});

app.use("/api/fires", fireRoutes);

app.listen(PORT, () => {
  console.log(`WildGuard AI server running on port ${PORT}`);
});
