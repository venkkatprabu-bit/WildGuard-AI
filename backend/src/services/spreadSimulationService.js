
const EARTH_RADIUS_KM = 6371.0088;
const HORIZONS = [1, 3, 6];

function toRadians(degrees) {
  return degrees * Math.PI / 180;
}

function toDegrees(radians) {
  return radians * 180 / Math.PI;
}

// Move from a coordinate in a given direction and distance.
// Returns GeoJSON coordinate order: [longitude, latitude].
function destinationPoint(lat, lon, bearing, distanceKm) {
  const lat1 = toRadians(lat);
  const lon1 = toRadians(lon);
  const angle = distanceKm / EARTH_RADIUS_KM;
  const direction = toRadians(bearing);

  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(angle) +
    Math.cos(lat1) * Math.sin(angle) *
    Math.cos(direction)
  );

  const lon2 = lon1 + Math.atan2(
    Math.sin(direction) * Math.sin(angle) * Math.cos(lat1),
    Math.cos(angle) - Math.sin(lat1) * Math.sin(lat2)
  );

  const longitude =
    ((toDegrees(lon2) + 540) % 360) - 180;

  return [
    Number(longitude.toFixed(6)),
    Number(toDegrees(lat2).toFixed(6))
  ];
}

// Create one wind-oriented elliptical envelope.
function createEnvelope({
  latitude,
  longitude,
  downwindBearing,
  windSpeed,
  baseRateKmh,
  hours
}) {
  // Wind strength only shapes the illustrative ellipse.
  const windFactor = Math.min(windSpeed / 30, 1);

  const baseRadius = baseRateKmh * hours;

  const majorRadius =
    baseRadius * (1 + 1.5 * windFactor);

  const minorRadius =
    baseRadius * (1 - 0.25 * windFactor);

  const centerShift =
    baseRadius * 0.55 * windFactor;

  const direction = toRadians(downwindBearing);
  const coordinates = [];

  // Generate 72 points around the ellipse.
  for (let i = 0; i < 72; i++) {
    const angle = 2 * Math.PI * i / 72;

    const along =
      centerShift + majorRadius * Math.cos(angle);

    const across =
      minorRadius * Math.sin(angle);

    // Rotate ellipse relative to north.
    const north =
      along * Math.cos(direction) -
      across * Math.sin(direction);

    const east =
      along * Math.sin(direction) +
      across * Math.cos(direction);

    const distanceKm = Math.hypot(north, east);
    const bearing = toDegrees(Math.atan2(east, north));

    coordinates.push(
      destinationPoint(
        latitude,
        longitude,
        bearing,
        distanceKm
      )
    );
  }

  // Close the polygon exactly.
  coordinates.push([...coordinates[0]]);

  return {
    type: "Feature",
    properties: {
      horizon_hours: hours,
      label: `${hours}-hour scenario`,
      assumed_base_rate_kmh: baseRateKmh,
      wind_speed_kmh: windSpeed,
      downwind_bearing_degrees: downwindBearing,
      major_radius_km: Number(majorRadius.toFixed(4)),
      minor_radius_km: Number(minorRadius.toFixed(4)),
      is_forecast: false
    },
    geometry: {
      type: "Polygon",
      coordinates: [coordinates]
    }
  };
}

export function generateSpreadSimulation({
  fire,
  windSpeed,
  windDirection,
  windSource,
  weatherTime = null,
  baseRateKmh = 0.12
}) {
  const latitude = Number(fire.latitude);
  const longitude = Number(fire.longitude);
  const detectionTime = new Date(fire.acquisition_time);

  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    Number.isNaN(detectionTime.getTime())
  ) {
    throw new Error("Invalid fire coordinates or timestamp");
  }

  if (
    !Number.isFinite(windSpeed) ||
    !Number.isFinite(windDirection) ||
    windSpeed < 0 ||
    windDirection < 0 ||
    windDirection > 360 ||
    baseRateKmh <= 0 ||
    !Number.isFinite(baseRateKmh)
  ) {
    throw new Error("Invalid simulation parameters");
  }

  // Meteorological direction is where wind comes FROM.
  const downwindBearing = (windDirection + 180) % 360;

  const features = HORIZONS.map(hours =>
    createEnvelope({
      latitude,
      longitude,
      downwindBearing,
      windSpeed,
      baseRateKmh,
      hours
    })
  );

  return {
    type: "FeatureCollection",
    features,
    metadata: {
      fire_id: fire.id,
      origin: {
        latitude,
        longitude
      },
      detection_time: detectionTime.toISOString(),
      wind: {
        speed_kmh: windSpeed,
        direction_from_degrees: windDirection,
        downwind_bearing_degrees: downwindBearing,
        source: windSource,
        observation_time: weatherTime
      },
      simulated_hours: HORIZONS,
      model: "Experimental wind-oriented ellipse v1",
      assumptions: {
        base_expansion_rate_kmh: baseRateKmh,
        wind_constant_over_horizon: true,
        vegetation_included: false,
        terrain_included: false,
        fire_suppression_included: false
      },
      warning:
        "Illustrative scenario only. Not a predicted fire perimeter, safe-distance estimate, or evacuation guide."
    }
  };
}
