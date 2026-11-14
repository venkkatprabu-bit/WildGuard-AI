
import { fromFile } from "geotiff";
import { fileURLToPath } from "node:url";

// Paths to the processed Sentinel-2 rasters
const ndviPath = fileURLToPath(
  new URL(
    "../../../datasets/vegetation/wildguard_bandipur_ndvi_2026-10-27.tiff",
    import.meta.url
  )
);

const ndmiPath = fileURLToPath(
  new URL(
    "../../../datasets/vegetation/wildguard_bandipur_ndmi_2026-10-27.tiff",
    import.meta.url
  )
);

// Cache raster objects so we don't reopen the files
// for every API request.
let rasterPromise;

async function loadRasters() {
  if (!rasterPromise) {
    rasterPromise = Promise.all([
      fromFile(ndviPath),
      fromFile(ndmiPath)
    ]).then(async ([ndviTiff, ndmiTiff]) => {
      const [ndvi, ndmi] = await Promise.all([
        ndviTiff.getImage(),
        ndmiTiff.getImage()
      ]);

      const a = ndvi.getBoundingBox();
      const b = ndmi.getBoundingBox();

      if (
        ndvi.getWidth() !== ndmi.getWidth() ||
        ndvi.getHeight() !== ndmi.getHeight() ||
        a.some((v, i) => Math.abs(v - b[i]) > 1e-8)
      ) {
        throw new Error("NDVI and NDMI rasters do not align");
      }

      return { ndvi, ndmi };
    }).catch(error => {
      rasterPromise = null;
      throw error;
    });
  }

  return rasterPromise;
}

function validIndex(value) {
  return Number.isFinite(value) &&
         value >= -1 &&
         value <= 1;
}

async function sampleIndex(image, x, y) {
  const [band] = await image.readRasters({
    window: [x, y, x + 1, y + 1],
    samples: [0]
  });

  const value = band[0];

  return validIndex(value)
    ? Number(value.toFixed(4))
    : null;
}

export async function getVegetationAtPoint(lat, lon) {
  const { ndvi, ndmi } = await loadRasters();

  // These downloaded rasters use EPSG:4326
  const [west, south, east, north] =
    ndvi.getBoundingBox();

  if (
    lon < west || lon >= east ||
    lat <= south || lat > north
  ) {
    return null; // Point is outside raster coverage
  }

  // Convert geographic coordinates into pixel coordinates
  const x = Math.floor(
    ((lon - west) / (east - west)) * ndvi.getWidth()
  );

  const y = Math.floor(
    ((north - lat) / (north - south)) * ndvi.getHeight()
  );

  const [ndviValue, ndmiValue] = await Promise.all([
    sampleIndex(ndvi, x, y),
    sampleIndex(ndmi, x, y)
  ]);

  return {
    ndvi: ndviValue,
    ndmi: ndmiValue,
    image_date: "2026-10-27",
    source: "Sentinel-2 L2A",
    quality_note:
      "Basic invalid-pixel filtering only; clouds and shadows not fully masked"
  };
}
