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

## Verifying it works

I tested this end-to-end against a local `wrangler dev` instance (not just
unit-level): filled a room to its 6-boat cap and confirmed a 7th connection
is turned away, disconnected a boat mid-race and confirmed the room keeps
simulating the rest of the fleet without breaking, and drove two live
WebSocket-connected boats through a full prestart → start → collision course
to confirm a real Rule 10 (port/starboard) penalty fires from actual gameplay
input, not just a forced test state.
