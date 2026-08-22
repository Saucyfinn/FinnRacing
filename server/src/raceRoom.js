import {
  MAX_BOATS, TICK_MS, D2R,
  clamp, wrap360,
  windAt, freshBoatState, stepBoatKinematics, stepFleetDirtyWind, effectiveWindForBoat,
  normalizeBoatSetup,
  freshRaceState, stepRace, stepRules, applyPenaltyOverride, updatePenaltyProgress,
  spawnPositions, startLineForBoatCount, PRESTART_SECONDS, RACE_TIMEOUT_SECONDS
} from "./physics.js";

const BOAT_COLORS = ["#e2ece9", "#6fa9d9", "#f0c581", "#c98bd8", "#7fd1a8", "#e2726f"];
const RESTART_DELAY_SEC = 6;
const DEFAULT_VENUE = { lat: -41.285, lon: 174.825, bearingDeg: 340 }; // Wellington Harbour

// One RaceRoom Durable Object instance = one race room (fleet of up to
// MAX_BOATS boats). The room is addressed by a short room code the client
// picks, so no separate "create room" API call is needed — the Worker maps
// /ws/<code> straight to a Durable Object of that name.
export class RaceRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = new Map(); // WebSocket -> { id, name, boatIndex|null }
    this.boats = [];           // parallel arrays, index = boatIndex (seat), sparse-safe
    this.races = [];
    this.connected = [];       // boolean per seat
    this.names = [];
    this.setups = [];
    // baseDir is 0 by design: the whole simulation runs in a COURSE-LOCAL frame
    // where -Y is always dead upwind, which is what keeps WINDWARD_MARK an
    // actual beat and the start line square to the breeze. Where that course
    // sits on the planet, and which way it points, is `venue` below — applied
    // only when projecting to lat/lon for the map. The physics never sees it.
    this.wind = { baseDir: 0, baseSpeed: 10 + Math.random() * 8, t: 0 };
    // { lat, lon, bearingDeg } — bearingDeg is the TRUE compass bearing the
    // wind blows FROM, i.e. the direction local -Y points on the real map.
    // Always start on mapped water. A venue embedded in the first room link,
    // or a host lobby change, replaces this Wellington Harbour default.
    this.venue = { ...DEFAULT_VENUE };
    this.venueChosenFromLink = false;
    this.roomStatus = "lobby"; // lobby | prestart | racing | finished
    this.raceClock = 0;
    this.startLine = startLineForBoatCount(0);
    this.hostId = null;
    this.restartTimer = 0;
    this.tickHandle = null;
    this.lastTickAt = 0;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/ws")) {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("expected websocket", { status: 426 });
      }
      // The first client into a room fixes where on earth it is; everyone who
      // joins later races the same course regardless of what their link says.
      this.adoptVenue(url.searchParams);
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.acceptSession(server, url.searchParams.get("name") || "Sailor", {
        skipperWeightKg: url.searchParams.get("weight"),
        sailChoice: url.searchParams.get("sail"),
        mastPositionMm: url.searchParams.get("mast"),
        rigTensionKg: url.searchParams.get("tension")
      });
      return new Response(null, { status: 101, webSocket: client });
    }
    return new Response("not found", { status: 404 });
  }

  // this.wind only holds the seed (baseDir/baseSpeed/t) — anything that needs
  // an actual {dir, speed} (spawn placement, etc.) must resolve it first.
  currentWind() { return windAt(this.wind.baseDir, this.wind.baseSpeed, this.wind.t); }

  adoptVenue(params) {
    if (this.venueChosenFromLink) return;
    // Careful: Number(null) is 0 and Number("") is 0, so a missing parameter
    // would otherwise read as a perfectly valid course at 0°N 0°E.
    const latRaw = params.get("lat"), lonRaw = params.get("lon");
    if (latRaw === null || lonRaw === null || latRaw === "" || lonRaw === "") return;
    const lat = Number(latRaw), lon = Number(lonRaw);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return;

    const brgRaw = params.get("brg");
    const brg = brgRaw === null || brgRaw === "" ? NaN : Number(brgRaw);
    this.venue = {
      lat, lon,
      // No bearing given: pick one per room so successive races at the same
      // venue aren't all pointing the same way down the harbour.
      bearingDeg: Number.isFinite(brg) ? ((brg % 360) + 360) % 360 : Math.floor(Math.random() * 360)
    };
    this.venueChosenFromLink = true;
  }

  freeSeat() {
    for (let i = 0; i < MAX_BOATS; i++) if (!this.connected[i]) return i;
    return -1;
  }

  acceptSession(ws, name, setupValue) {
    ws.accept();
    const id = crypto.randomUUID();
    if (!this.hostId) this.hostId = id;
    const cleanName = String(name).slice(0, 16) || "Sailor";
    const session = { id, name: cleanName, boatIndex: null, setup: normalizeBoatSetup(setupValue) };
    this.sessions.set(ws, session);
    if (this.roomStatus === "lobby") this.assignSeat(session);

    ws.addEventListener("message", (evt) => this.handleMessage(ws, evt.data));
    ws.addEventListener("close", () => this.handleClose(ws));
    ws.addEventListener("error", () => this.handleClose(ws));

    ws.send(JSON.stringify({
      t: "welcome", youId: id, boatIndex: session.boatIndex,
      color: session.boatIndex == null ? "#6b8599" : BOAT_COLORS[session.boatIndex % BOAT_COLORS.length],
      isHost: id === this.hostId, waiting: session.boatIndex == null,
      maxBoats: MAX_BOATS, venue: this.venue, startLine: this.startLine, setup: session.setup
    }));
    this.broadcastRoster();
    this.ensureTicking();
  }

  handleMessage(ws, raw) {
    const session = this.sessions.get(ws);
    if (!session) return;
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.t === "rename") {
      const nm = String(msg.name || "").slice(0, 16);
      if (nm) {
        session.name = nm;
        if (session.boatIndex != null) this.names[session.boatIndex] = nm;
        this.broadcastRoster();
      }
      return;
    }
    if (msg.t === "setup") {
      // Lock the setup once the start sequence begins so it cannot be used as
      // an in-race performance control. It can be changed again next lobby.
      if (this.roomStatus !== "lobby") return;
      session.setup = normalizeBoatSetup(msg.setup);
      if (session.boatIndex != null) {
        this.setups[session.boatIndex] = session.setup;
        const setupBoat = this.boats[session.boatIndex];
        if (setupBoat) setupBoat.setup = session.setup;
      }
      this.broadcastRoster();
      return;
    }

    const boat = session.boatIndex == null ? null : this.boats[session.boatIndex];
    const race = session.boatIndex == null ? null : this.races[session.boatIndex];

    if (msg.t === "input" && boat && race) {
      if (typeof msg.targetHeadingDeg === "number" && isFinite(msg.targetHeadingDeg)) {
        // A penalty in progress overrides player steering server-side each
        // tick anyway (applyPenaltyOverride), so it's safe to just record intent.
        boat.targetHeadingDeg = wrap360(msg.targetHeadingDeg);
      }
      if (typeof msg.autoTrim === "boolean") boat.autoTrim = msg.autoTrim;
      if (!boat.autoTrim && typeof msg.trimAngleDeg === "number" && isFinite(msg.trimAngleDeg)) {
        boat.trimAngleDeg = clamp(msg.trimAngleDeg, -90, 90);
      }
    } else if (msg.t === "start") {
      if (session.id === this.hostId && session.boatIndex != null && this.roomStatus === "lobby") {
        this.beginRace();
      }
    } else if (msg.t === "venue") {
      // Host can move the course while everyone is still in the lobby; once
      // racing, the water stays put.
      if (session.id !== this.hostId || this.roomStatus !== "lobby") return;
      const lat = Number(msg.lat), lon = Number(msg.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
      if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return;
      const brg = Number(msg.bearingDeg);
      this.venue = {
        lat, lon,
        bearingDeg: Number.isFinite(brg) ? ((brg % 360) + 360) % 360
          : (this.venue ? this.venue.bearingDeg : Math.floor(Math.random() * 360))
      };
      this.broadcastRoster();
    }
  }

  handleClose(ws) {
    const session = this.sessions.get(ws);
    if (!session) return;
    this.sessions.delete(ws);
    if (session.boatIndex != null) this.connected[session.boatIndex] = false;
    // Leave the boat's simulation state in place but stop it from actively
    // steering — it holds its current heading/trim rather than teleporting
    // away or vanishing mid-fleet.
    const boat = session.boatIndex == null ? null : this.boats[session.boatIndex];
    if (boat) boat.targetHeadingDeg = boat.headingDeg;
    if (session.id === this.hostId) {
      const next = [...this.sessions.values()].find(s => s.boatIndex != null) || [...this.sessions.values()][0];
      this.hostId = next ? next.id : null;
    }
    if (this.roomStatus === "lobby") this.promoteWaiting();
    if (this.roomStatus === "lobby") this.startLine = startLineForBoatCount(this.connected.filter(Boolean).length);
    this.broadcastRoster();
    if (this.sessions.size === 0) this.stopTicking();
  }

  beginRace() {
    const seats = [];
    for (let i = 0; i < MAX_BOATS; i++) if (this.connected[i]) seats.push(i);
    this.startLine = startLineForBoatCount(seats.length);
    const spawns = spawnPositions(seats.length, this.currentWind(), this.startLine);
    seats.forEach((seat, k) => {
      const spawn = spawns[k];
      const fresh = freshBoatState(spawn.headingDeg, this.setups[seat]);
      fresh.worldX = spawn.x; fresh.worldY = spawn.y;
      this.boats[seat] = fresh;
      const rs = freshRaceState();
      rs.prevWorldX = spawn.x; rs.prevWorldY = spawn.y;
      this.races[seat] = rs;
    });
    this.raceClock = 0;
    this.roomStatus = "prestart";
    this.broadcast({ t: "start_countdown", prestartSeconds: PRESTART_SECONDS });
    this.broadcastRoster();
  }

  assignSeat(session) {
    const seat = this.freeSeat();
    if (seat === -1) return false;
    const spawn = spawnPositions(seat + 1, this.currentWind())[seat];
    const boat = freshBoatState(spawn.headingDeg, session.setup);
    boat.worldX = spawn.x; boat.worldY = spawn.y;
    this.boats[seat] = boat;
    this.races[seat] = freshRaceState();
    this.races[seat].prevWorldX = spawn.x;
    this.races[seat].prevWorldY = spawn.y;
    this.connected[seat] = true;
    this.names[seat] = session.name;
    this.setups[seat] = session.setup;
    session.boatIndex = seat;
    if (this.roomStatus === "lobby") {
      const entered = this.connected.filter(Boolean).length;
      this.startLine = startLineForBoatCount(entered);
    }
    return true;
  }

  promoteWaiting() {
    for (const session of this.sessions.values()) {
      if (session.boatIndex == null && !this.assignSeat(session)) break;
    }
  }

  ensureTicking() {
    if (this.tickHandle) return;
    this.lastTickAt = Date.now();
    this.tickHandle = setInterval(() => this.tick(), TICK_MS);
  }
  stopTicking() {
    if (this.tickHandle) { clearInterval(this.tickHandle); this.tickHandle = null; }
  }

  tick() {
    const now = Date.now();
    const dt = clamp((now - this.lastTickAt) / 1000, 0, 1 / 8);
    this.lastTickAt = now;

    this.wind.t += dt;
    const wind = windAt(this.wind.baseDir, this.wind.baseSpeed, this.wind.t);

    const activeSeats = [];
    for (let i = 0; i < MAX_BOATS; i++) if (this.boats[i]) activeSeats.push(i);

    if (this.roomStatus === "lobby") {
      const activeBoats = activeSeats.map(i => this.boats[i]);
      stepFleetDirtyWind(activeBoats, wind, dt, activeSeats);
      for (const i of activeSeats) stepBoatKinematics(this.boats[i], effectiveWindForBoat(this.boats[i], wind), dt);
    } else {
      this.raceClock += dt;
      const activeBoats = activeSeats.map(i => this.boats[i]);
      stepFleetDirtyWind(activeBoats, wind, dt, activeSeats);
      for (const i of activeSeats) {
        const boat = this.boats[i], rs = this.races[i];
        applyPenaltyOverride(boat, rs);
        stepBoatKinematics(boat, effectiveWindForBoat(boat, wind), dt);
        updatePenaltyProgress(boat, rs, dt);
        stepRace(boat, rs, this.raceClock, dt, this.startLine);
      }
      const activeRaces = activeSeats.map(i => this.races[i]);
      stepRules(activeBoats, activeRaces, wind, dt);

      if (this.roomStatus === "prestart" || this.roomStatus === "racing") {
        const anyRacing = activeSeats.some(i => this.races[i].status === "racing");
        if (anyRacing) this.roomStatus = "racing";
        const allDone = activeSeats.length > 0 && activeSeats.every(i => this.races[i].status === "finished");
        const timedOut = this.raceClock > PRESTART_SECONDS + RACE_TIMEOUT_SECONDS;
        if (allDone || timedOut) {
          this.roomStatus = "finished";
          this.restartTimer = RESTART_DELAY_SEC;
          this.assignFinishPlaces(activeSeats);
        }
      } else if (this.roomStatus === "finished") {
        this.restartTimer -= dt;
        if (this.restartTimer <= 0) {
          this.roomStatus = "lobby";
          this.promoteWaiting();
          this.broadcastRoster();
        }
      }
    }

    this.broadcastSnapshot(wind, activeSeats);
  }

  assignFinishPlaces(activeSeats) {
    const finished = activeSeats
      .filter(i => this.races[i].status === "finished" && this.races[i].place == null)
      .sort((a, b) => this.races[a].finishTime - this.races[b].finishTime);
    let placeBase = activeSeats.filter(i => this.races[i].place != null).length;
    finished.forEach((i, k) => { this.races[i].place = placeBase + k + 1; });
  }

  broadcastRoster() {
    const roster = [...this.sessions.values()].map(session => ({
      id: session.id,
      boatIndex: session.boatIndex,
      name: session.name,
      connected: true,
      waiting: session.boatIndex == null,
      setup: session.setup,
      color: session.boatIndex == null ? "#6b8599" : BOAT_COLORS[session.boatIndex % BOAT_COLORS.length]
    }));
    this.broadcast({ t: "roster", roster, hostId: this.hostId, roomStatus: this.roomStatus, venue: this.venue, startLine: this.startLine });
  }

  broadcastSnapshot(wind, activeSeats) {
    const boats = activeSeats.map(i => {
      const b = this.boats[i], r = this.races[i];
      return {
        boatIndex: i, name: this.names[i], color: BOAT_COLORS[i % BOAT_COLORS.length], connected: !!this.connected[i],
        worldX: round2(b.worldX), worldY: round2(b.worldY), headingDeg: round2(b.headingDeg),
        speedKnots: round2(b.speedKnots), tackSign: b.tackSign, autoTrim: b.autoTrim,
        trimAngleDeg: round2(b.trimAngleDeg), trimEfficiency01: round2(b.trimEfficiency01),
        setup: b.setup,
        setupEffect: {
          speedMultiplier: round3(b.setupEffect.speedMultiplier), accelerationMultiplier: round3(b.setupEffect.accelerationMultiplier),
          pointingPenaltyDeg: round2(b.setupEffect.pointingPenaltyDeg), rigMatch01: round3(b.setupEffect.rigMatch01),
          targetMastPositionMm: round2(b.setupEffect.targetMastPositionMm), targetRigTensionKg: round2(b.setupEffect.targetRigTensionKg)
        },
        dirtyWind: {
          type: b.dirtyWind.type, sourceBoatIndex: b.dirtyWind.sourceBoatIndex,
          exposure01: round2(b.dirtyWind.exposure01), speedDeficitKnots: round2(b.dirtyWind.speedDeficitKnots),
          directionShiftDeg: round2(b.dirtyWind.directionShiftDeg), effectiveSpeed: round2(b.dirtyWind.effectiveSpeed),
          effectiveDir: round2(b.dirtyWind.effectiveDir)
        },
        race: {
          status: r.status, leg: r.leg, ocs: r.ocs, finishTime: r.finishTime, place: r.place,
          penalty: { active: r.penalty.active, turnedDeg: round2(r.penalty.turnedDeg), rule: r.penalty.rule }
        }
      };
    });
    this.broadcast({
      t: "snapshot", serverTimeMs: Date.now(), wind: { dir: round2(wind.dir), speed: round2(wind.speed) },
      roomStatus: this.roomStatus, raceClock: round2(this.raceClock), startLine: this.startLine, boats
    });
  }

  broadcast(obj) {
    const json = JSON.stringify(obj);
    for (const ws of this.sessions.keys()) {
      try { ws.send(json); } catch { /* dead socket, will be cleaned up on close event */ }
    }
  }
}

function round2(n) { return Math.round(n * 100) / 100; }
function round3(n) { return Math.round(n * 1000) / 1000; }
