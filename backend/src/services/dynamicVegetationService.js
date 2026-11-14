import { fromArrayBuffer } from "geotiff";

const TOKEN_URL = "https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token";
const CATALOG_URL = "https://sh.dataspace.copernicus.eu/catalog/v1/search";
const PROCESS_URL = "https://sh.dataspace.copernicus.eu/process/v1";
const EVALSCRIPT = `
//VERSION=3
function setup() {
  return {
    input: ["B04", "B08", "B11", "SCL", "dataMask"],
    output: { bands: 3, sampleType: "FLOAT32" }
  };
}
function evaluatePixel(s) {
  if (s.dataMask !== 1 || (s.SCL !== 4 && s.SCL !== 5)) return [0, 0, 0];
  const redDen = s.B08 + s.B04;
  const swirDen = s.B08 + s.B11;
  if (redDen <= 0 || swirDen <= 0) return [0, 0, 0];
  const ndvi = (s.B08 - s.B04) / redDen;
  const ndmi = (s.B08 - s.B11) / swirDen;
  if (!isFinite(ndvi) || !isFinite(ndmi) ||
      ndvi < -1 || ndvi > 1 || ndmi < -1 || ndmi > 1) return [0, 0, 0];
  return [ndvi, ndmi, 1];
}
`;

function failure(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

let tokenCache = null;

// Never propagate upstream bodies, URLs, headers or fetch errors containing credentials.
async function request(url, options, stage, format) {
  try {
    const response = await fetch(url, {
      ...options, signal: AbortSignal.timeout(30000)
    });
    if (!response.ok) {
      if (response.status === 401) tokenCache = null;
      const messages = {
        401: "Copernicus authentication failed; check configured credentials",
        403: "Copernicus access denied; check account permissions",
        406: "Copernicus rejected the requested response format",
        429: "Copernicus rate limit reached; retry later"
      };
      throw failure(
        [401, 403, 406, 429].includes(response.status) ? response.status : 502,
        "COPERNICUS_HTTP_" + response.status,
        messages[response.status] || "Copernicus " + stage + " request failed"
      );
    }
    return await response[format]();
  } catch (error) {
    if (error.code?.startsWith("COPERNICUS_")) throw error;
    if (error.name === "TimeoutError" || error.name === "AbortError") {
      throw failure(504, "COPERNICUS_TIMEOUT", "Copernicus " + stage + " request timed out");
    }
    throw failure(502, "COPERNICUS_RESPONSE", "Copernicus " + stage + " response unavailable or invalid");
  }
}

async function getAccessToken() {
  if (tokenCache && Date.now() < tokenCache.expiresAt) return tokenCache.value;
  const clientId = process.env.COPERNICUS_CLIENT_ID;
  const secret = process.env.COPERNICUS_CLIENT_SECRET;
  if (!clientId || !secret) {
    throw failure(503, "COPERNICUS_CREDENTIALS", "Copernicus credentials are missing on the server");
  }
  const token = await request(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials", client_id: clientId, client_secret: secret
    })
  }, "authentication", "json");
  if (typeof token.access_token !== "string" || !token.access_token ||
      !Number.isFinite(Number(token.expires_in)) || Number(token.expires_in) <= 0) {
    throw failure(502, "COPERNICUS_TOKEN", "Copernicus returned an invalid authentication response");
  }
  tokenCache = {
    value: token.access_token,
    expiresAt: Date.now() + Math.max(0, Number(token.expires_in) - 60) * 1000
  };
  return tokenCache.value;
}

function postApi(url, token, payload, json = true) {
  return request(url, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
      Accept: json ? "application/geo+json" : "image/tiff"
    },
    body: JSON.stringify(payload)
  }, json ? "catalog" : "processing", json ? "json" : "arrayBuffer");
}

const round4 = value => Number(value.toFixed(4));

async function readIndices(buffer) {
  try {
    const tiff = await fromArrayBuffer(buffer);
    const image = await tiff.getImage();
    const [ndviPixels, ndmiPixels, validPixels] =
      await image.readRasters({ samples: [0, 1, 2] });
    let ndviTotal = 0;
    let ndmiTotal = 0;
    let count = 0;
    for (let i = 0; i < ndviPixels.length; i++) {
      const ndvi = ndviPixels[i];
      const ndmi = ndmiPixels[i];
      if (validPixels[i] !== 1 || !Number.isFinite(ndvi) || !Number.isFinite(ndmi) ||
          ndvi < -1 || ndvi > 1 || ndmi < -1 || ndmi > 1) continue;
      ndviTotal += ndvi;
      ndmiTotal += ndmi;
      count++;
    }
    if (!count) return null;
    return {
      ndvi: round4(ndviTotal / count),
      ndmi: round4(ndmiTotal / count),
      valid_pixel_fraction: round4(count / ndviPixels.length)
    };
  } catch {
    throw failure(502, "COPERNICUS_TIFF", "Copernicus returned an unreadable three-band GeoTIFF");
  }
}

export async function getDynamicVegetation(lat, lon, at) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon) ||
      lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    throw failure(400, "INVALID_COORDINATES", "Invalid latitude or longitude");
  }
  if (at != null && !(at instanceof Date) && (typeof at !== "string" || !at.trim())) {
    throw failure(400, "INVALID_TIMESTAMP", "Invalid or future analysis timestamp");
  }
  const analysisTime = at == null ? new Date() : new Date(at);
  if (!Number.isFinite(analysisTime.getTime()) || analysisTime.getTime() > Date.now()) {
    throw failure(400, "INVALID_TIMESTAMP", "Invalid or future analysis timestamp");
  }
  const delta = 0.0025;
  const bbox = [Math.max(-180, lon - delta), Math.max(-90, lat - delta),
    Math.min(180, lon + delta), Math.min(90, lat + delta)];
  const startTime = new Date(analysisTime.getTime() - 30 * 86400000);
  const token = await getAccessToken();
  const search = {
    collections: ["sentinel-2-l2a"], bbox,
    datetime: startTime.toISOString() + "/" + analysisTime.toISOString(),
    limit: 100
  };
  const features = [];
  const pages = new Set();
  let next;
  do {
    const catalog = await postApi(CATALOG_URL, token,
      next == null ? search : { ...search, next });
    if (!Array.isArray(catalog.features)) {
      throw failure(502, "COPERNICUS_CATALOG", "Copernicus returned an invalid scene catalog");
    }
    features.push(...catalog.features);
    next = catalog.context?.next;
    if (next != null) {
      if (pages.has(next) || pages.size >= 20) {
        throw failure(502, "COPERNICUS_CATALOG", "Copernicus scene catalog pagination could not be completed");
      }
      pages.add(next);
    }
  } while (next != null);

  const scenes = features.filter(scene => {
    const time = Date.parse(scene.properties?.datetime);
    const cloud = scene.properties?.["eo:cloud_cover"];
    return Number.isFinite(time) && time >= startTime.getTime() &&
      time <= analysisTime.getTime() && Number.isFinite(cloud) && cloud >= 0 && cloud <= 50;
  }).sort((a, b) => Date.parse(b.properties.datetime) - Date.parse(a.properties.datetime) ||
    a.properties["eo:cloud_cover"] - b.properties["eo:cloud_cover"]);
  // Tiles from the same acquisition share a processing window; do not retry that window.
  const seen = new Set();
  const acquisitions = scenes.filter(scene => {
    const time = Date.parse(scene.properties.datetime);
    if (seen.has(time)) return false;
    seen.add(time);
    return true;
  }).slice(0, 5);
  if (!acquisitions.length) {
    throw failure(404, "NO_SCENES", "No suitable Sentinel-2 scene with cloud cover at most 50% in the preceding 30 days");
  }

  for (const scene of acquisitions) {
    const sceneTime = new Date(scene.properties.datetime);
    const buffer = await postApi(PROCESS_URL, token, {
      input: {
        bounds: { bbox, properties: { crs: "http://www.opengis.net/def/crs/OGC/1.3/CRS84" } },
        data: [{
          type: "sentinel-2-l2a",
          dataFilter: {
            // A one-millisecond window ending at the Catalog acquisition excludes later imagery.
            timeRange: {
              from: new Date(sceneTime.getTime() - 1).toISOString(),
              to: sceneTime.toISOString()
            },
            mosaickingOrder: "mostRecent"
          }
        }]
      },
      output: {
        width: 32, height: 32,
        responses: [{ identifier: "default", format: { type: "image/tiff" } }]
      },
      evalscript: EVALSCRIPT
    }, false);
    const indices = await readIndices(buffer);
    if (!indices) continue;
    return {
      location: { latitude: lat, longitude: lon },
      ...indices,
      analysis_at: analysisTime.toISOString(),
      image_date: sceneTime.toISOString().slice(0, 10),
      image_acquired_at: sceneTime.toISOString(),
      fetched_at: new Date().toISOString(),
      scene_id: scene.id,
      scene_cloud_cover_percent: round4(scene.properties["eo:cloud_cover"]),
      source: "Sentinel-2 L2A",
      method: "Mean of valid pixels in a 0.005-degree bounding box",
      quality_note: "Research prototype. NDVI and NDMI are vegetation indices, not direct measures of wildfire danger or fuel moisture. Only SCL classes 4 and 5 are accepted."
    };
  }
  throw failure(404, "NO_VALID_PIXELS",
    "No valid vegetation pixels in " + acquisitions.length + " attempted Sentinel-2 acquisitions; pixels may be cloud-contaminated or missing");
}
