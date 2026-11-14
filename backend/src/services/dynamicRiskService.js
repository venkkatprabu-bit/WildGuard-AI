
import { getHistoricalWeather } from "./historicalWeatherService.js";
import { getDynamicVegetation } from "./dynamicVegetationService.js";

const MAX_IMAGE_AGE_DAYS = 14;
const MIN_VALID_PIXEL_FRACTION = 0.2;

function clamp(value) {
  return Math.max(0, Math.min(100, value));
}

function getRiskLevel(score) {
  if (score >= 75) return "EXTREME";
  if (score >= 55) return "HIGH";
  if (score >= 30) return "MODERATE";
  return "LOW";
}

function validNumber(value) {
  return typeof value === "number" &&
    Number.isFinite(value);
}

export async function assessHotspotRisk(fire) {

  const lat = Number(fire.latitude);
  const lon = Number(fire.longitude);
  const detectedAt = new Date(fire.acquisition_time);

  if (
    !validNumber(lat) ||
    !validNumber(lon) ||
    Number.isNaN(detectedAt.getTime())
  ) {
    throw new Error("Invalid fire detection data");
  }

  // STEP 1: Retrieve both environmental sources
  const [weatherResult, vegetationResult] =
    await Promise.allSettled([
      getHistoricalWeather(lat, lon, detectedAt),
      getDynamicVegetation(lat, lon, detectedAt)
    ]);

  const weather = weatherResult.status === "fulfilled"
    ? weatherResult.value
    : null;

  const vegetation = vegetationResult.status === "fulfilled"
    ? vegetationResult.value
    : null;

  const problems = [];

  if (!weather) {
    problems.push("Historical weather unavailable");
    console.error(
      "Weather retrieval:",
      weatherResult.reason
    );
  }

  if (!vegetation) {
    problems.push("Sentinel-2 vegetation unavailable");
    console.error(
      "Vegetation retrieval:",
      vegetationResult.reason
    );
  }

  // STEP 2: Check measurement completeness
  if (weather && (
    !validNumber(weather.temperature) ||
    !validNumber(weather.humidity) ||
    !validNumber(weather.wind_speed)
  )) {
    problems.push("Required weather measurements missing");
  }

  if (vegetation && (
    !validNumber(vegetation.ndvi) ||
    !validNumber(vegetation.ndmi)
  )) {
    problems.push("Required vegetation measurements missing");
  }

  // STEP 3: Check observation dates and image quality
  if (weather) {
    const weatherTime = new Date(weather.weather_time);
    const weatherAge =
      detectedAt.getTime() - weatherTime.getTime();

    if (
      Number.isNaN(weatherTime.getTime()) ||
      weatherAge < 0 ||
      weatherAge >= 3600000
    ) {
      problems.push("Weather time does not match detection hour");
    }
  }

  if (vegetation) {
    const imageTime = new Date(
      vegetation.image_acquired_at
    );

    const imageAgeDays =
      (detectedAt.getTime() - imageTime.getTime()) /
      86400000;

    if (
      Number.isNaN(imageTime.getTime()) ||
      imageAgeDays < 0 ||
      imageAgeDays > MAX_IMAGE_AGE_DAYS
    ) {
      problems.push("Sentinel-2 image is too old or post-dates detection");
    }

    if (
      !validNumber(vegetation.valid_pixel_fraction) ||
      vegetation.valid_pixel_fraction <
        MIN_VALID_PIXEL_FRACTION
    ) {
      problems.push("Insufficient usable vegetation pixels");
    }
  }

  const base = {
    fire: {
      id: fire.id,
      latitude: lat,
      longitude: lon,
      detection_time: detectedAt.toISOString(),
      satellite: fire.satellite,
      confidence: fire.confidence,
      frp: fire.frp
    },
    weather,
    vegetation,
    model: "Experimental environmental risk score v1"
  };

  // Never invent a score when required data is missing
  if (problems.length > 0) {
    return {
      ...base,
      status: "incomplete",
      risk_score: null,
      risk_level: null,
      problems,
      warning: "Risk score not calculated because required data or quality checks failed."
    };
  }

  // STEP 4: Normalize each environmental factor
  const factors = [
    {
      name: "Temperature",
      score: clamp(
        ((weather.temperature - 15) / 25) * 100
      ),
      weight: 0.25
    },
    {
      name: "Low humidity",
      score: clamp(100 - weather.humidity),
      weight: 0.25
    },
    {
      name: "Wind speed",
      score: clamp((weather.wind_speed / 40) * 100),
      weight: 0.20
    },
    {
      name: "NDMI moisture proxy",
      score: clamp(
        ((0.4 - vegetation.ndmi) / 0.6) * 100
      ),
      weight: 0.20
    },
    {
      name: "NDVI vegetation proxy",
      score: clamp(
        ((vegetation.ndvi - 0.1) / 0.7) * 100
      ),
      weight: 0.10
    }
  ];

  // STEP 5: Calculate weighted risk score
  const total = factors.reduce(
    (sum, factor) =>
      sum + factor.score * factor.weight,
    0
  );

  const riskScore = Math.round(total);

  // STEP 6: Identify strongest contributing factors
  const breakdown = factors.map(factor => ({
    name: factor.name,
    normalized_score: Number(
      factor.score.toFixed(2)
    ),
    weight: factor.weight,
    contribution: Number(
      (factor.score * factor.weight).toFixed(2)
    )
  }));

  const mainFactors = [...breakdown]
    .sort((a, b) => b.contribution - a.contribution)
    .slice(0, 3)
    .map(factor => factor.name);

  return {
    ...base,
    status: "complete",
    risk_score: riskScore,
    risk_level: getRiskLevel(riskScore),
    main_factors: mainFactors,
    factor_breakdown: breakdown,
    problems: [],
    warning:
      "Experimental, uncalibrated risk indicator. Not for emergency forecasting or dispatch decisions."
  };
}
