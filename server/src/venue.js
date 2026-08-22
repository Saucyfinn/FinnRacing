export const DEFAULT_VENUE = Object.freeze({
  // 43°37'11.29"S 172°43'09.73"E
  lat: -43.6198028,
  lon: 172.7193694,
  bearingDeg: 75
});

const LEGACY_DEFAULT_VENUES = Object.freeze([
  Object.freeze({ lat: -41.285, lon: 174.825 }),
  Object.freeze({ lat: -43.6105, lon: 172.724 })
]);

function samePosition(a, b) {
  return Math.abs(Number(a.lat) - b.lat) < 0.000001
    && Math.abs(Number(a.lon) - b.lon) < 0.000001;
}

export function isDefaultVenue(venue) {
  return samePosition(venue, DEFAULT_VENUE);
}

export function isLegacyDefaultVenue(venue) {
  return LEGACY_DEFAULT_VENUES.some(candidate => samePosition(venue, candidate));
}
