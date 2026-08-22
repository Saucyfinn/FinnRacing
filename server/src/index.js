export { RaceRoom } from "./raceRoom.js";

const ROOM_ID_RE = /^[a-zA-Z0-9_-]{3,32}$/;
const TILE_RE = /^\/tiles\/(\d{1,2})\/(\d{1,7})\/(\d{1,7})\.(png|webp|jpeg)$/;

// LINZ Basemaps aerial imagery, proxied so the API key never reaches the client
// and so Cloudflare's edge cache absorbs repeat tile requests.
// Imagery is CC BY 4.0 — the client renders the required attribution.
const LINZ_TILE_BASE = "https://basemaps.linz.govt.nz/v1/tiles/aerial/3857";
const TILE_CACHE_SECONDS = 60 * 60 * 24 * 30;

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
      return stub.fetch(new Request(forward.toString(), request));
    }

    const t = url.pathname.match(TILE_RE);
    if (t) return serveTile(t[1], t[2], t[3], t[4], env, request);

    // Lets the client know whether to even attempt the map layer.
    if (url.pathname === "/api/config") {
      return Response.json({ imagery: env.LINZ_API_KEY ? "linz" : "none" });
    }

    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response("not found", { status: 404 });
  }
};
