import { PbfReader as Pbf } from "pbf";
import { VectorTile } from "@mapbox/vector-tile";

const ZOOM = 15;

function lonToTileX(lon) { return Math.floor((lon + 180) / 360 * 2 ** ZOOM); }
function latToTileY(lat) {
  const rad = lat * Math.PI / 180;
  return Math.floor((1 - Math.asinh(Math.tan(rad)) / Math.PI) / 2 * 2 ** ZOOM);
}

function inRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function inPolygon(lon, lat, rings) {
  return rings.length > 0 && inRing(lon, lat, rings[0]) && !rings.slice(1).some(ring => inRing(lon, lat, ring));
}

export class LandCollisionMap {
  constructor(polygons) { this.polygons = polygons; }
  isLand(lat, lon) {
    return this.polygons.some(polygon => inPolygon(lon, lat, polygon));
  }
}

export async function loadLandCollisionMap(venue, apiKey, radiusM = 2600) {
  if (!apiKey || !venue) return null;
  const latPad = radiusM / 111320;
  const lonPad = radiusM / (111320 * Math.cos(venue.lat * Math.PI / 180));
  const minX = lonToTileX(venue.lon - lonPad), maxX = lonToTileX(venue.lon + lonPad);
  const minY = latToTileY(venue.lat + latPad), maxY = latToTileY(venue.lat - latPad);
  const jobs = [];
  for (let x = minX; x <= maxX; x++) for (let y = minY; y <= maxY; y++) jobs.push((async () => {
    const url = `https://basemaps.linz.govt.nz/v1/tiles/topographic-v2/3857/${ZOOM}/${x}/${y}.pbf?api=${encodeURIComponent(apiKey)}`;
    const response = await fetch(url, { cf: { cacheEverything: true, cacheTtl: 86400 } });
    if (!response.ok) return [];
    const tile = new VectorTile(new Pbf(new Uint8Array(await response.arrayBuffer())));
    const layer = tile.layers.boundaries;
    if (!layer) return [];
    const polygons = [];
    for (let i = 0; i < layer.length; i++) {
      const geometry = layer.feature(i).toGeoJSON(x, y, ZOOM).geometry;
      if (geometry.type === "Polygon") polygons.push(geometry.coordinates);
      else if (geometry.type === "MultiPolygon") polygons.push(...geometry.coordinates);
    }
    return polygons;
  })());
  return new LandCollisionMap((await Promise.all(jobs)).flat());
}
