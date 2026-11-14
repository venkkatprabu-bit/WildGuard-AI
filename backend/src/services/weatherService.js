
const BASE_URL = "https://api.open-meteo.com/v1/forecast";

// Temporary in-memory cache
const weatherCache = new Map();
const CACHE_DURATION = 10 * 60 * 1000;

export async function getCurrentWeather(lat, lon) {

  const cacheKey = `${lat.toFixed(3)},${lon.toFixed(3)}`;
  const cached = weatherCache.get(cacheKey);

  // Return cached result if still valid
  if (
    cached &&
    Date.now() - cached.fetchedAt < CACHE_DURATION
  ) {
    return {
      ...cached.data,
      cached: true
    };
  }

  const url = new URL(BASE_URL);

  url.searchParams.set("latitude", String(lat));
  url.searchParams.set("longitude", String(lon));

  url.searchParams.set(
    "current",
    [
      "temperature_2m",
      "relative_humidity_2m",
      "wind_speed_10m",
      "wind_direction_10m",
      "precipitation"
    ].join(",")
  );

  url.searchParams.set("timezone", "GMT");

  const response = await fetch(url, {
    signal: AbortSignal.timeout(8000)
  });

  if (!response.ok) {
    throw new Error(
      `Open-Meteo request failed: ${response.status}`
    );
  }

  const result = await response.json();

  if (!result.current?.time) {
    throw new Error("Missing current weather data");
  }

  const weather = {
    requested_location: {
      latitude: lat,
      longitude: lon
    },

    model_grid_location: {
      latitude: result.latitude,
      longitude: result.longitude
    },

    temperature: result.current.temperature_2m,
    humidity: result.current.relative_humidity_2m,
    wind_speed: result.current.wind_speed_10m,
    wind_direction: result.current.wind_direction_10m,
    precipitation: result.current.precipitation,

    units: {
      temperature: "°C",
      humidity: "%",
      wind_speed: "km/h",
      precipitation: "mm"
    },

    observed_at: new Date(
      `${result.current.time}Z`
    ).toISOString(),

    fetched_at: new Date().toISOString(),
    source: "Open-Meteo Forecast API",
    data_type: "current model weather",
    cached: false
  };

  // Limit cache growth for the prototype
  if (weatherCache.size >= 500) {
    weatherCache.clear();
  }

  weatherCache.set(cacheKey, {
    fetchedAt: Date.now(),
    data: weather
  });

  return weather;
}
