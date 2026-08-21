import {
  MAX_BOATS, TICK_MS, D2R,
  clamp, wrap360,
  windAt, freshBoatState, stepBoatKinematics,
  freshRaceState, stepRace, stepRules, applyPenaltyOverride, updatePenaltyProgress,
  spawnPositions, PRESTART_SECONDS, RACE_TIMEOUT_SECONDS
} from "./physics.js";

const BOAT_COLORS = ["#e2ece9", "#6fa9d9", "#f0c581", "#c98bd8", "#7fd1a8", "#e2726f"];
const RESTART_DELAY_SEC = 6;

// One RaceRoom Durable Object instance = one race room (fleet of up to
// MAX_BOATS boats). The room is addressed by a short room code the client
// picks, so no separate "create room" API call is needed — the Worker maps
// /ws/<code> straight to a Durable Object of that name.
export class RaceRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = new Map(); // WebSocket -> { id, name, boatIndex }
    this.boats = [];           // parallel arrays, index = boatIndex (seat), sparse-safe
    this.races = [];
    this.connected = [];       // boolean per seat
    this.names = [];
    this.wind = { baseDir: Math.random() * 360, baseSpeed: 10 + Math.random() * 8, t: 0 };
    this.roomStatus = "lobby"; // lobby | prestart | racing | finished
    this.raceClock = 0;
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
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.acceptSession(server, url.searchParams.get("name") || "Sailor");
      return new Response(null, { status: 101, webSocket: client });
    }
    return new Response("not found", { status: 404 });
  }

  // this.wind only holds the seed (baseDir/baseSpeed/t) — anything that needs
  // an actual {dir, speed} (spawn placement, etc.) must resolve it first.
  currentWind() { return windAt(this.wind.baseDir, this.wind.baseSpeed, this.wind.t); }

  freeSeat() {
    for (let i = 0; i < MAX_BOATS; i++) if (!this.connected[i]) return i;
    return -1;
  }

  acceptSession(ws, name) {
    const seat = this.freeSeat();
    if (seat === -1) {
      ws.accept();
      ws.send(JSON.stringify({ t: "full" }));
      ws.close(1013, "room full");
      return;
    }
    ws.accept();
    const id = crypto.randomUUID();
    if (!this.hostId) this.hostId = id;

    const spawn = spawnPositions(seat + 1, this.currentWind())[seat];
    const boat = freshBoatState(spawn.headingDeg);
    boat.worldX = spawn.x; boat.worldY = spawn.y;
    this.boats[seat] = boat;
    this.races[seat] = freshRaceState();
    this.races[seat].prevWorldX = spawn.x;
    this.races[seat].prevWorldY = spawn.y;
    this.connected[seat] = true;
    this.names[seat] = String(name).slice(0, 16) || "Sailor";

    this.sessions.set(ws, { id, name: this.names[seat], boatIndex: seat });

    ws.addEventListener("message", (evt) => this.handleMessage(ws, evt.data));
    ws.addEventListener("close", () => this.handleClose(ws));
    ws.addEventListener("error", () => this.handleClose(ws));

    ws.send(JSON.stringify({
      t: "welcome", youId: id, boatIndex: seat, color: BOAT_COLORS[seat % BOAT_COLORS.length],
      isHost: id === this.hostId, maxBoats: MAX_BOATS
    }));
    this.broadcastRoster();
    this.ensureTicking();
  }

  handleMessage(ws, raw) {
    const session = this.sessions.get(ws);
    if (!session) return;
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const boat = this.boats[session.boatIndex];
    const race = this.races[session.boatIndex];
    if (!boat || !race) return;

    if (msg.t === "input") {
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
      if (session.id === this.hostId && this.roomStatus === "lobby") {
        this.beginRace();
      }
    } else if (msg.t === "rename") {
      const nm = String(msg.name || "").slice(0, 16);
      if (nm) { this.names[session.boatIndex] = nm; this.broadcastRoster(); }
    }
  }

  handleClose(ws) {
    const session = this.sessions.get(ws);
    if (!session) return;
    this.sessions.delete(ws);
    this.connected[session.boatIndex] = false;
    // Leave the boat's simulation state in place but stop it from actively
    // steering — it holds its current heading/trim rather than teleporting
    // away or vanishing mid-fleet.
    const boat = this.boats[session.boatIndex];
    if (boat) boat.targetHeadingDeg = boat.headingDeg;
    if (session.id === this.hostId) {
      const next = [...this.sessions.values()][0];
      this.hostId = next ? next.id : null;
    }
    this.broadcastRoster();
    if (this.sessions.size === 0) this.stopTicking();
  }

  beginRace() {
    const seats = [];
    for (let i = 0; i < MAX_BOATS; i++) if (this.connected[i]) seats.push(i);
    const spawns = spawnPositions(seats.length, this.currentWind());
    seats.forEach((seat, k) => {
      const spawn = spawns[k];
      const fresh = freshBoatState(spawn.headingDeg);
      fresh.worldX = spawn.x; fresh.worldY = spawn.y;
      this.boats[seat] = fresh;
      const rs = freshRaceState();
      rs.prevWorldX = spawn.x; rs.prevWorldY = spawn.y;
      this.races[seat] = rs;
    });
    this.raceClock = 0;
    this.roomStatus = "prestart";
    this.broadcast({ t: "start_countdown", prestartSeconds: PRESTART_SECONDS });
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
      for (const i of activeSeats) stepBoatKinematics(this.boats[i], wind, dt);
    } else {
      this.raceClock += dt;
      for (const i of activeSeats) {
        const boat = this.boats[i], rs = this.races[i];
        applyPenaltyOverride(boat, rs);
        stepBoatKinematics(boat, wind, dt);
        updatePenaltyProgress(boat, rs, dt);
        stepRace(boat, rs, this.raceClock, dt);
      }
      const activeBoats = activeSeats.map(i => this.boats[i]);
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
        if (this.restartTimer <= 0 && activeSeats.length > 0) this.beginRace();
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
    const roster = [];
    for (let i = 0; i < MAX_BOATS; i++) {
      if (!this.boats[i]) continue;
      roster.push({ boatIndex: i, name: this.names[i], connected: !!this.connected[i], color: BOAT_COLORS[i % BOAT_COLORS.length] });
    }
    this.broadcast({ t: "roster", roster, hostId: this.hostId, roomStatus: this.roomStatus });
  }

  broadcastSnapshot(wind, activeSeats) {
    const boats = activeSeats.map(i => {
      const b = this.boats[i], r = this.races[i];
      return {
        boatIndex: i, name: this.names[i], color: BOAT_COLORS[i % BOAT_COLORS.length], connected: !!this.connected[i],
        worldX: round2(b.worldX), worldY: round2(b.worldY), headingDeg: round2(b.headingDeg),
        speedKnots: round2(b.speedKnots), tackSign: b.tackSign, autoTrim: b.autoTrim,
        trimAngleDeg: round2(b.trimAngleDeg), trimEfficiency01: round2(b.trimEfficiency01),
        race: {
          status: r.status, leg: r.leg, ocs: r.ocs, finishTime: r.finishTime, place: r.place,
          penalty: { active: r.penalty.active, turnedDeg: round2(r.penalty.turnedDeg), rule: r.penalty.rule }
        }
      };
    });
    this.broadcast({
      t: "snapshot", serverTimeMs: Date.now(), wind: { dir: round2(wind.dir), speed: round2(wind.speed) },
      roomStatus: this.roomStatus, raceClock: round2(this.raceClock), boats
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
