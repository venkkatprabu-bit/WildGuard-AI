
import { fromArrayBuffer } from "geotiff";

const TOKEN_URL =
  "https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token";

const CATALOG_URL =
  "https://sh.dataspace.copernicus.eu/catalog/v1/search";

const PROCESS_URL =
  "https://sh.dataspace.copernicus.eu/process/v1";

// Sentinel Hub calculates both indices and masks invalid pixels
const EVALSCRIPT = `
//VERSION=3
function setup() {
  return {
    input: ["B04", "B08", "B11", "SCL", "dataMask"],
    output: {
      bands: 2,
      sampleType: "FLOAT32",
      nodataValue: NaN
    }
  };
}

function evaluatePixel(s) {
  // Accept vegetation and bare-ground pixels.
  // Reject cloud, shadow, water and no-data classes.
  if (s.dataMask !== 1 || ![4, 5].includes(s.SCL)) {
    return [NaN, NaN];
  }

  const ndviDen = s.B08 + s.B04;
  const ndmiDen = s.B08 + s.B11;

  if (ndviDen <= 0 || ndmiDen <= 0) {
    return [NaN, NaN];
  }

  return [
    (s.B08 - s.B04) / ndviDen,
    (s.B08 - s.B11) / ndmiDen
  ];
}
`;

let tokenCache = null;

async function getAccessToken() {
  if (tokenCache && Date.now() < tokenCache.expiresAt) {
    return tokenCache.value;
  }

  const clientId = process.env.COPERNICUS_CLIENT_ID;
  const secret = process.env.COPERNICUS_CLIENT_SECRET;

  if (!clientId || !secret) {
    throw new Error("Copernicus credentials are missing");
  }

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: secret
  });

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body,
    signal: AbortSignal.timeout(20000)
  });

  if (!response.ok) {
    throw new Error(`Copernicus authentication failed: ${response.status}`);
  }

  const token = await response.json();

  tokenCache = {
    value: token.access_token,
    expiresAt:
      Date.now() + Math.max(0, token.expires_in - 60) * 1000
  };

  return tokenCache.value;
}


async function postApi(url, token, payload, acceptJson = true) {

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",

      // Catalog API returns GeoJSON
      // Processing API returns GeoTIFF
      Accept: acceptJson
        ? "application/geo+json"
        : "image/tiff"
    },

    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30000)
  });

  if (!response.ok) {
    const message = await response.text();

    throw new Error(
      `Copernicus HTTP ${response.status}: ${message.slice(0, 300)}`
    );
  }

  return acceptJson
    ? response.json()
    : response.arrayBuffer();
}


function round4(value) {
  return Number(value.toFixed(4));
}

export async function getDynamicVegetation(lat, lon, at) {
  const analysisTime = at ? new Date(at) : new Date();

  if (
    Number.isNaN(analysisTime.getTime()) ||
    analysisTime.getTime() > Date.now()
  ) {
    throw new Error("Invalid analysis date");
  }

  // Approximately 550 m square at the equator.
  const delta = 0.0025;

  const bbox = [
    lon - delta,
    lat - delta,
    lon + delta,
    lat + delta
  ];

  const startTime = new Date(
    analysisTime.getTime() - 30 * 86400000
  );

  const token = await getAccessToken();

  // STEP 1: Search Sentinel-2 imagery
  const catalog = await postApi(CATALOG_URL, token, {
    collections: ["sentinel-2-l2a"],
    bbox,
    datetime:
      `${startTime.toISOString()}/${analysisTime.toISOString()}`,
    limit: 50
  });

  const scenes = (catalog.features ?? [])
    .filter(scene => scene.properties?.datetime)
    .filter(scene => {
      const cloud = scene.properties["eo:cloud_cover"];
      return typeof cloud === "number" && cloud <= 50;
    })
    .sort((a, b) =>
      new Date(b.properties.datetime) -
      new Date(a.properties.datetime)
    );

  if (scenes.length === 0) {
    const error = new Error(
      "No suitable Sentinel-2 image found in the previous 30 days"
    );
    error.status = 404;
    throw error;
  }

  const scene = scenes[0];
  const sceneTime = new Date(scene.properties.datetime);

  // STEP 2: Process imagery around the selected acquisition
  const request = {
    input: {
      bounds: {
        bbox,
        properties: {
          crs: "http://www.opengis.net/def/crs/OGC/1.3/CRS84"
        }
      },
      data: [{
        type: "sentinel-2-l2a",
        dataFilter: {
          timeRange: {
            from: new Date(sceneTime.getTime() - 60000).toISOString(),
            to: new Date(sceneTime.getTime() + 60000).toISOString()
          },
          mosaickingOrder: "mostRecent"
        }
      }]
    },
    output: {
      width: 32,
      height: 32,
      responses: [{
        identifier: "default",
        format: { type: "image/tiff" }
      }]
    },
    evalscript: EVALSCRIPT
  };

  const buffer = await postApi(
    PROCESS_URL, token, request, false
  );

  // STEP 3: Read numerical indices from returned GeoTIFF
  const tiff = await fromArrayBuffer(buffer);
  const image = await tiff.getImage();

  const [ndviPixels, ndmiPixels] = await image.readRasters({
    samples: [0, 1]
  });

  let ndviTotal = 0;
  let ndmiTotal = 0;
  let count = 0;

  for (let i = 0; i < ndviPixels.length; i++) {
    const ndvi = ndviPixels[i];
    const ndmi = ndmiPixels[i];

    if (
      Number.isFinite(ndvi) &&
      Number.isFinite(ndmi) &&
      ndvi >= -1 && ndvi <= 1 &&
      ndmi >= -1 && ndmi <= 1
    ) {
      ndviTotal += ndvi;
      ndmiTotal += ndmi;
      count++;
    }
  }

  if (count === 0) {
    const error = new Error(
      "Selected image has no usable vegetation pixels"
    );
    error.status = 404;
    throw error;
  }

  return {
    location: {
      latitude: lat,
      longitude: lon
    },
    ndvi: round4(ndviTotal / count),
    ndmi: round4(ndmiTotal / count),
    image_date: sceneTime.toISOString().slice(0, 10),
    image_acquired_at: sceneTime.toISOString(),
    fetched_at: new Date().toISOString(),
    scene_cloud_cover_percent:
      scene.properties["eo:cloud_cover"],
    valid_pixel_fraction: round4(count / ndviPixels.length),
    source: "Sentinel-2 L2A",
    method: "Mean of valid pixels in approximately 500 m area",
    quality_note:
      "Cloud/shadow screening uses scene classification. Results are not direct fuel moisture measurements."
  };
}
