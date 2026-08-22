// ---------------------------------------------------------------------------
// Putting the course on the planet.
//
// The simulation runs in a COURSE-LOCAL frame: -Y is dead upwind, +X is to the
// right when looking upwind, units are metres. Nothing in the physics knows or
// cares about geography. This module is the only place the two meet: it rotates
// the local frame onto true north and projects to Web Mercator so satellite
// tiles line up underneath.
//
// Over a course a few hundred metres across, a local flat-earth (ENU)
// approximation is accurate to well under a metre, so no proper geodesy needed.
// ---------------------------------------------------------------------------

const D2R = Math.PI / 180;
const M_PER_DEG_LAT = 111320;
export const TILE_SIZE = 256;
// Web Mercator ground resolution at the equator, zoom 0, in metres per pixel.
const EQUATOR_M_PER_PX = 156543.03392804097;

// Local course metres -> metres north/east of the course origin.
// bearingDeg is the TRUE bearing the wind blows FROM, i.e. where local -Y points.
export function localToNorthEast(worldX, worldY, bearingDeg) {
  const upwind = -worldY;      // local "up" the course
  const across = worldX;       // local right, looking upwind
  const b = bearingDeg * D2R;
  return {
    north: upwind * Math.cos(b) - across * Math.sin(b),
    east: upwind * Math.sin(b) + across * Math.cos(b)
  };
}

export function northEastToLatLon(north, east, originLat, originLon) {
  const lat = originLat + north / M_PER_DEG_LAT;
  const lon = originLon + east / (M_PER_DEG_LAT * Math.cos(originLat * D2R));
  return { lat, lon };
}

export function localToLatLon(worldX, worldY, venue) {
  const { north, east } = localToNorthEast(worldX, worldY, venue.bearingDeg);
  return northEastToLatLon(north, east, venue.lat, venue.lon);
}

export function latLonToLocal(lat, lon, venue) {
  const north = (lat - venue.lat) * M_PER_DEG_LAT;
  const east = (lon - venue.lon) * M_PER_DEG_LAT * Math.cos(venue.lat * D2R);
  const b = venue.bearingDeg * D2R;
  const upwind = north * Math.cos(b) + east * Math.sin(b);
  const across = -north * Math.sin(b) + east * Math.cos(b);
  return { x: across, y: -upwind };
}

// --- Web Mercator ---------------------------------------------------------

export function lonToMercatorX01(lon) { return (lon + 180) / 360; }

export function latToMercatorY01(lat) {
  const s = Math.sin(lat * D2R);
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
}

// Absolute pixel position in the Mercator pyramid at a given zoom.
export function latLonToPixel(lat, lon, zoom) {
  const worldPx = TILE_SIZE * Math.pow(2, zoom);
  return { px: lonToMercatorX01(lon) * worldPx, py: latToMercatorY01(lat) * worldPx };
}

// Ground resolution (metres per Mercator pixel) at a latitude and zoom.
// Mercator stretches with latitude, so this shrinks toward the poles.
export function metersPerPixel(lat, zoom) {
  return EQUATOR_M_PER_PX * Math.cos(lat * D2R) / Math.pow(2, zoom);
}

// Pick the zoom whose native resolution is closest to how many screen pixels
// we're drawing per metre — so imagery renders near 1:1 instead of blurry.
// Clamped to what LINZ actually publishes for aerial imagery.
export function bestZoomFor(pxPerMeter, lat, minZoom = 12, maxZoom = 21) {
  const ideal = Math.log2(EQUATOR_M_PER_PX * Math.cos(lat * D2R) * pxPerMeter);
  return Math.max(minZoom, Math.min(maxZoom, Math.round(ideal)));
}
