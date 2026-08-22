export { RaceRoom } from "./raceRoom.js";
import { DEFAULT_VENUE, isLegacyDefaultVenue } from "./venue.js";

const ROOM_ID_RE = /^[a-zA-Z0-9_-]{3,32}$/;
const TILE_RE = /^\/tiles\/(\d{1,2})\/(\d{1,7})\/(\d{1,7})\.(png|webp|jpeg)$/;

// LINZ Basemaps aerial imagery, proxied so the API key never reaches the client
// and so Cloudflare's edge cache absorbs repeat tile requests.
// Imagery is CC BY 4.0 — the client renders the required attribution.
const LINZ_TILE_BASE = "https://basemaps.linz.govt.nz/v1/tiles/aerial/3857";
const TILE_CACHE_SECONDS = 60 * 60 * 24 * 30;
const CONDITIONS_CACHE_SECONDS = 10 * 60;

export function interpolateSeries(hourly, fields, nowMs = Date.now()) {
  const times = hourly.time.map(value => Date.parse(value + (value.endsWith("Z") ? "" : "Z")));
  let hi = times.findIndex(time => time >= nowMs);
  if (hi < 0) hi = times.length - 1;
  const lo = Math.max(0, hi - 1);
  const span = times[hi] - times[lo];
  const amount = span > 0 ? Math.max(0, Math.min(1, (nowMs - times[lo]) / span)) : 0;
  const out = { validTime: new Date(nowMs).toISOString() };
  for (const field of fields) {
    const from = Number(hourly[field][lo]), to = Number(hourly[field][hi]);
    if (field.includes("direction")) {
      const delta = ((to - from + 540) % 360) - 180;
      out[field] = (from + delta * amount + 360) % 360;
    } else out[field] = from + (to - from) * amount;
  }
  return out;
}

async function serveConditions(url) {
  const lat = Number(url.searchParams.get("lat")), lon = Number(url.searchParams.get("lon"));
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    return Response.json({ error: "invalid coordinates" }, { status: 400 });
  }
  const common = { latitude: lat.toFixed(4), longitude: lon.toFixed(4), timezone: "GMT", past_hours: "1", forecast_hours: "6" };
  const weatherQuery = new URLSearchParams({ ...common,
    current: "temperature_2m,weather_code,wind_gusts_10m",
    hourly: "wind_speed_10m,wind_direction_10m,wind_gusts_10m", wind_speed_unit: "kn"
  });
  const marineQuery = new URLSearchParams({ ...common,
    hourly: "ocean_current_velocity,ocean_current_direction,sea_level_height_msl",
    wind_speed_unit: "kn", cell_selection: "sea"
  });
  const fetchOptions = { cf: { cacheEverything: true, cacheTtl: CONDITIONS_CACHE_SECONDS }, headers: { Accept: "application/json" } };
  const [weatherResponse, marineResponse] = await Promise.all([
    fetch("https://api.open-meteo.com/v1/forecast?" + weatherQuery, fetchOptions),
    fetch("https://marine-api.open-meteo.com/v1/marine?" + marineQuery, fetchOptions)
  ]);
  if (!weatherResponse.ok || !marineResponse.ok) return Response.json({ error: "conditions unavailable" }, { status: 502 });
  const [weather, marine] = await Promise.all([weatherResponse.json(), marineResponse.json()]);
  const wind = interpolateSeries(weather.hourly, ["wind_speed_10m", "wind_direction_10m", "wind_gusts_10m"]);
  const tide = interpolateSeries(marine.hourly, ["ocean_current_velocity", "ocean_current_direction", "sea_level_height_msl"]);
  return Response.json({
    source: "open-meteo-best-match", fetchedAt: new Date().toISOString(), validTime: wind.validTime,
    latitude: weather.latitude, longitude: weather.longitude, timezone: weather.timezone,
    weatherCode: weather.current.weather_code, temperatureC: weather.current.temperature_2m,
    windSpeedKnots: wind.wind_speed_10m, windDirectionDeg: wind.wind_direction_10m, windGustKnots: wind.wind_gusts_10m,
    currentSpeedKnots: tide.ocean_current_velocity, currentDirectionDeg: tide.ocean_current_direction,
    seaLevelM: tide.sea_level_height_msl,
    notice: "Modelled conditions; marine values are coarse and not for navigation."
  }, { headers: { "Cache-Control": `public, max-age=${CONDITIONS_CACHE_SECONDS}` } });
}

// Where LINZ actually has aerial imagery. Outside these boxes it answers 200
// with a solid pale-grey placeholder rather than 404, so we can't detect the
// gap from the response — we have to know not to ask. [west, south, east, north]
const LINZ_COVERAGE = [
  [166.0, -47.5, 179.0, -34.0],   // mainland NZ + offshore islands
  [-176.7, -44.4, -175.7, -43.6]  // Chatham Islands, east of the dateline
];

// Lat/lon extent of a Web Mercator tile, as [west, south, east, north].
function tileBounds(zoom, tx, ty) {
  const n = Math.pow(2, zoom);
  const lon = i => i / n * 360 - 180;
  const lat = j => Math.atan(Math.sinh(Math.PI * (1 - 2 * j / n))) * 180 / Math.PI;
  return [lon(tx), lat(ty + 1), lon(tx + 1), lat(ty)];
}

function hasImagery(zoom, tx, ty) {
  const [w, s, e, n] = tileBounds(zoom, tx, ty);
  // Any overlap counts — a tile straddling the coast still carries real pixels.
  return LINZ_COVERAGE.some(([cw, cs, ce, cn]) => w < ce && e > cw && s < cn && n > cs);
}

async function serveTile(z, x, y, fmt, env, request) {
  const zoom = Number(z), tx = Number(x), ty = Number(y);
  const span = Math.pow(2, zoom);
  if (!Number.isInteger(zoom) || zoom < 0 || zoom > 24) return new Response("bad zoom", { status: 400 });
  if (tx < 0 || tx >= span || ty < 0 || ty >= span) return new Response("tile out of range", { status: 400 });

  const key = env.LINZ_API_KEY;
  // No key configured: tell the client cleanly so it falls back to plain water
  // rather than spamming failed requests.
  if (!key) return new Response(null, { status: 204 });

  // Outside coverage, skip the round-trip entirely: LINZ would return a valid
  // blank tile that Leaflet paints over the water, and we'd cache it for a
  // month. 204 lets the client fall through to its own water rendering.
  if (!hasImagery(zoom, tx, ty)) return new Response(null, { status: 204 });

  const upstream = `${LINZ_TILE_BASE}/${zoom}/${tx}/${ty}.${fmt}?api=${encodeURIComponent(key)}`;
  const res = await fetch(upstream, {
    cf: { cacheEverything: true, cacheTtl: TILE_CACHE_SECONDS },
    headers: { "Accept": "image/*" }
  });

  // Upstream failure (bad key, rate limit, outage) — same "no tile" answer, so
  // the map degrades to blank water instead of the client retrying.
  if (!res.ok) return new Response(null, { status: 204 });

  const headers = new Headers();
  headers.set("Content-Type", res.headers.get("Content-Type") || `image/${fmt}`);
  headers.set("Cache-Control", `public, max-age=${TILE_CACHE_SECONDS}, immutable`);
  return new Response(res.body, { status: 200, headers });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // /ws/<roomId> — WebSocket upgrade, routed to that room's Durable Object.
    const m = url.pathname.match(/^\/ws\/([^/]+)\/?$/);
    if (m) {
      const roomId = m[1];
      if (!ROOM_ID_RE.test(roomId)) {
        return new Response("invalid room id", { status: 400 });
      }
      const id = env.RACE_ROOM.idFromName(roomId);
      const stub = env.RACE_ROOM.get(id);
      const forward = new URL(request.url);
      forward.pathname = "/ws";
      // Existing Durable Object rooms created before map support may still
      // hold a null venue. Supplying the default on reconnect upgrades them,
      // while rooms that already chose a venue ignore these parameters.
      const forwardedVenue = {
        lat: forward.searchParams.get("lat"),
        lon: forward.searchParams.get("lon")
      };
      if (!forward.searchParams.has("lat") || !forward.searchParams.has("lon") || isLegacyDefaultVenue(forwardedVenue)) {
        forward.searchParams.set("lat", String(DEFAULT_VENUE.lat));
        forward.searchParams.set("lon", String(DEFAULT_VENUE.lon));
        forward.searchParams.set("brg", String(DEFAULT_VENUE.bearingDeg));
      }
      return stub.fetch(new Request(forward.toString(), request));
    }

    const t = url.pathname.match(TILE_RE);
    if (t) return serveTile(t[1], t[2], t[3], t[4], env, request);

    // Lets the client know whether to even attempt the map layer.
    if (url.pathname === "/api/config") {
      return Response.json({ imagery: env.LINZ_API_KEY ? "linz" : "none" });
    }
    if (url.pathname === "/api/conditions") return serveConditions(url);

    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response("not found", { status: 404 });
  }
};
