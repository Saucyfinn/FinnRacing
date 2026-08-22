# FinnRacing — online multiplayer server

A Cloudflare Worker + Durable Object that turns the single-player sailing
prototype into real small-fleet racing (up to 6 boats) over WebSockets.

- The Worker (`src/index.js`) serves the client from `public/` and routes
  `/ws/<roomId>` to that room's Durable Object.
- Each `RaceRoom` Durable Object (`src/raceRoom.js`) is one race room. It runs
  the authoritative physics tick at 15Hz, broadcasts state snapshots to every
  connected player, and is the same right-of-way/penalty-turn logic from the
  single-player prototype, generalized from a hardcoded pair to N boats.
- `src/physics.js` / `public/physics-client.js` are the server and client
  copies of the boat-kinematics formulas (polar table, no-go blend, turn-rate
  curve) — kept in sync by hand, ported 1:1 from `sailing-prototype.html`.
- The client (`public/index.html` + `public/client.js`) runs local prediction
  for your own boat (instant steering feel) and buffered interpolation for
  every other boat, reconciling against the server's snapshots.

### Dirty wind

Before every physics step, the server calculates aerodynamic interference for
the fleet. It distinguishes a direct wake, the wider trailing dirty-air plume,
and the asymmetric lee-bow region where a same-tack leeward boat slightly
ahead can backwind the windward boat. Smoothed exposure reduces the effective
wind used by the Finn polar; a lee bow also changes its effective direction.
The resulting interaction is sent in authoritative snapshots for local client
prediction and the dirty-air warning. Calibration constants are grouped in
`DIRTY_WIND` in `src/physics.js`.

### Individual Finn setup

Each sailor can configure skipper weight (70–120 kg), GS1 minus / GS1 / GS1
plus / WB sail, mast position (35–56 mm), and rig tension (30–40 kg) in the
lobby. Setups lock when the start sequence begins and are applied by the
server-authoritative polar calculation. Mast and tension targets interpolate
the light, medium, and heavy-air tables in FinnSailAnalyzer. The four named
sail profiles and skipper-weight trade-offs are explicit gameplay calibration
data because those exact measurements are not present in the Analyzer.

### Race conditions model

`GET /api/conditions?lat=…&lon=…` fetches and normalizes Open-Meteo weather
and marine forecasts on the Worker. Upstream responses are edge-cached for ten
minutes and hourly values are interpolated to the request time. The host may
use the model unchanged, adjust its values, or enter conditions manually.

When the start sequence begins, the room freezes the provider metadata and a
deterministic seed. The server derives smooth race-scale pressure and direction
patches from the forecast mean and gust range. Every boat, including AI, uses
the same authoritative model. Marine current is applied as ground-track drift;
boat speed remains speed through water. Marine values are coarse model output
and must not be used for navigation.

## Deploy

Run these from your own machine (or from Claude Code in a terminal) — this
repo can't be deployed from inside a sandboxed Claude session, since deploying
needs your own Cloudflare login.

```bash
cd server
npm install
npx wrangler login      # one-time browser login to your Cloudflare account
npx wrangler deploy
```

Wrangler prints the live URL (something like `https://finnracing.<you>.workers.dev`).
Share that URL — anyone who opens it lands in a fresh room; the room code is
just a URL query param (`?room=xyz12`), generated client-side, so there's no
separate "create room" step. Whoever opens a room link first becomes the host
and can start the race once the boats they're waiting for have joined.

To use a custom domain instead of `*.workers.dev`, add a `routes` entry to
`wrangler.toml` or attach one from the Cloudflare dashboard after the first
deploy.

## Satellite imagery (LINZ Basemaps)

The course can sit on real water, with NZ aerial imagery underneath it. This is
optional — with no key configured the game falls back to the abstract water it
had before, and nothing else changes.

1. Get a free API key from [LINZ Basemaps](https://basemaps.linz.govt.nz/) (the
   imagery is published under CC BY 4.0).
2. Store it as a Worker secret so it never reaches the browser:

```bash
npx wrangler secret put LINZ_API_KEY
```

Tiles are served through this Worker's own `/tiles/{z}/{x}/{y}.webp` route
rather than fetched directly from LINZ. That keeps the key server-side and lets
Cloudflare's edge cache absorb repeat tile requests, so a fleet racing the same
patch of water hits LINZ once rather than once per boat. Required attribution is
rendered in the corner of the map whenever imagery is showing.

### How the course maps onto the world

The simulation runs in a **course-local frame** where `-Y` is always dead
upwind — that's what keeps the windward mark a genuine beat and the start line
square to the breeze. Geography is applied only at render time, as a rotation
onto true north (`public/geo.js`). The physics has no idea where on earth it is,
which means adding the map changed no sailing behaviour at all.

A room's venue is `{ lat, lon, bearingDeg }`, where `bearingDeg` is the true
compass bearing the wind blows **from**. Set it in the lobby (paste coordinates
from any map, or hit 📍 for your current position), or pass it in the link:

```
https://your-worker.workers.dev/?room=abc12&lat=-41.2865&lon=174.7900&brg=230
```

The first person into a room fixes the venue; the host can move it while
everyone is still in the lobby, and it locks once racing starts. Late joiners
always get the room's venue rather than whatever their own link said, so the
fleet is guaranteed to be racing the same course.

## Local development

```bash
npm run dev
```

Runs the whole thing locally via `wrangler dev` (no Cloudflare account
needed for local dev) at `http://localhost:8787`. Open it in two browser
tabs/windows to test a race against yourself.

## Known limitations (MVP)

- **No reconnect-to-same-boat.** A page refresh mid-race rejoins as a new
  seat rather than resuming your old one — the old boat just holds its
  heading and keeps sailing (drops out of active control) until the race
  ends. Fixing this needs a persisted per-player session id and a short
  reconnect grace window, which felt like scope for a v2.
- **Room state is in-memory only.** If a room's Durable Object gets evicted
  (long idle period) the room resets. Fine for casual pickup races; would
  need Durable Object storage to survive that.
- **No mark-room or start-line rules.** Only RRS 10 (port/starboard) and
  RRS 11 (windward/leeward) are enforced, same simplification as the
  single-player prototype.
- **No matchmaking queue.** Racing happens via a shared room link, not
  auto-paired quick-match — that was the scope picked for this version.
- **Imagery is NZ-only.** LINZ covers New Zealand; a course set anywhere else
  gets blank water rather than an error. The `/tiles` proxy gates on a coverage
  bounding box and returns 204 outside it — LINZ itself answers out-of-coverage
  requests with a valid grey placeholder tile, not a 404, so the gap can't be
  detected from the response. Supporting elsewhere means adding a second tile
  source behind the same route.
- **The course doesn't know where the land is.** Marks are placed purely by the
  wind axis, so a course set close inshore can put the windward mark on a beach.
  Fixing that properly needs a coastline check against LINZ vector data.

## Verifying it works

I tested this end-to-end against a local `wrangler dev` instance (not just
unit-level): filled a room to its 6-boat cap and confirmed a 7th connection
is turned away, disconnected a boat mid-race and confirmed the room keeps
simulating the rest of the fleet without breaking, and drove two live
WebSocket-connected boats through a full prestart → start → collision course
to confirm a real Rule 10 (port/starboard) penalty fires from actual gameplay
input, not just a forced test state.
