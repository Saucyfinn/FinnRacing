import {
  MAX_BOATS, TICK_MS, D2R, MPS_PER_KNOT, FINN_LENGTH_M,
  clamp, wrap360, wrap180, bearingTo,
  windAt, freshBoatState, stepBoatKinematics, stepFleetDirtyWind, effectiveWindForBoat,
  normalizeBoatSetup,
  freshRaceState, stepRace, stepRules, applyPenaltyOverride, updatePenaltyProgress,
  spawnPositions, startLineForBoatCount, leewardGateForStartLine, PRESTART_SECONDS, RACE_TIMEOUT_SECONDS
} from "./physics.js";
import { DEFAULT_VENUE, isDefaultVenue, isLegacyDefaultVenue } from "./venue.js";

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
    this.sessions = new Map(); // WebSocket -> { id, name, boatIndex|null }
    this.boats = [];           // parallel arrays, index = boatIndex (seat), sparse-safe
    this.races = [];
    this.connected = [];       // boolean per seat
    this.names = [];
    this.setups = [];
    this.aiSeats = new Set();
    this.activeHails = new Map();
    this.hailCooldowns = new Map();
    this.markRoomRights = new Map();
    // baseDir is 0 by design: the whole simulation runs in a COURSE-LOCAL frame
    // where -Y is always dead upwind, which is what keeps WINDWARD_MARK an
    // actual beat and the start line square to the breeze. Where that course
    // sits on the planet, and which way it points, is `venue` below — applied
    // only when projecting to lat/lon for the map. The physics never sees it.
    this.wind = { baseDir: 0, baseSpeed: 10 + Math.random() * 8, t: 0 };
    this.waterCurrent = { speedKnots: 0, directionDeg: 0, seaLevelM: null, source: "manual" };
    this.conditionModel = { source: "manual", validTime: null, gustKnots: null, seed: 1 };
    this.raceModel = null;
    // { lat, lon, bearingDeg } — bearingDeg is the TRUE compass bearing the
    // wind blows FROM, i.e. the direction local -Y points on the real map.
    // Always start on mapped water. A venue embedded in the first room link,
    // or a host lobby change, replaces this Lyttelton Harbour default.
    this.venue = { ...DEFAULT_VENUE };
    this.venueChosenFromLink = false;
    this.roomStatus = "lobby"; // lobby | prestart | racing | finished
    this.raceClock = 0;
    this.prestartSeconds = PRESTART_SECONDS;
    this.startLine = startLineForBoatCount(0);
    this.windwardMark = { x: 0, y: -1852 };
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
    // Careful: Number(null) is 0 and Number("") is 0, so a missing parameter
    // would otherwise read as a perfectly valid course at 0°N 0°E.
    const latRaw = params.get("lat"), lonRaw = params.get("lon");
    if (latRaw === null || lonRaw === null || latRaw === "" || lonRaw === "") return;
    const lat = Number(latRaw), lon = Number(lonRaw);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return;

    // Upgrade rooms that received one of the application's obsolete defaults.
    // A genuinely custom venue remains fixed for the lifetime of the room.
    if (this.venueChosenFromLink
      && !(isLegacyDefaultVenue(this.venue) && isDefaultVenue({ lat, lon }))) return;

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
      maxBoats: MAX_BOATS, venue: this.venue, startLine: this.startLine, windwardMark: this.windwardMark, setup: session.setup
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
    if (msg.t === "conditions") {
      if (this.roomStatus !== "lobby" || session.id !== this.hostId) return;
      const windSpeed = Number(msg.windSpeedKnots), windDir = Number(msg.windDirectionDeg);
      const currentSpeed = Number(msg.currentSpeedKnots), currentDir = Number(msg.currentDirectionDeg);
      if (![windSpeed, windDir, currentSpeed, currentDir].every(Number.isFinite)) return;
      this.wind.baseSpeed = clamp(windSpeed, 2, 30);
      // The course is wind-aligned: local -Y points into the true wind and the
      // horizontal start/finish line is therefore perpendicular to it.
      if (this.venue) this.venue.bearingDeg = wrap360(windDir);
      const courseBearing = this.venue ? this.venue.bearingDeg : windDir;
      this.wind.baseDir = 0;
      this.wind.t = 0;
      this.waterCurrent = {
        speedKnots: clamp(currentSpeed, 0, 6), directionDeg: wrap360(currentDir - courseBearing), trueDirectionDeg: wrap360(currentDir),
        seaLevelM: msg.seaLevelM !== null && msg.seaLevelM !== "" && Number.isFinite(Number(msg.seaLevelM))
          ? clamp(Number(msg.seaLevelM), -5, 5) : null,
        source: msg.source === "public" ? "public" : "manual"
      };
      const seedText = String(msg.modelValidTime || "manual") + ":" + windSpeed + ":" + windDir + ":" + currentSpeed + ":" + currentDir;
      this.conditionModel = {
        source: msg.source === "public" ? String(msg.modelSource || "public") : "manual",
        validTime: msg.source === "public" ? String(msg.modelValidTime || "") : null,
        fetchedAt: msg.source === "public" ? String(msg.fetchedAt || "") : null,
        gustKnots: Number.isFinite(Number(msg.windGustKnots)) ? clamp(Number(msg.windGustKnots), this.wind.baseSpeed, 45) : this.wind.baseSpeed,
        seed: hashString(seedText)
      };
      this.prestartSeconds = clamp(Math.round(Number(msg.prestartSeconds) || PRESTART_SECONDS), 30, 600);
      this.broadcastRoster();
      return;
    }
    if (msg.t === "ai_fleet") {
      if (this.roomStatus !== "lobby" || session.id !== this.hostId) return;
      this.setAiCount(clamp(Math.round(Number(msg.count) || 0), 0, MAX_BOATS - 1));
      return;
    }
    if (msg.t === "restart") {
      if (session.id === this.hostId && session.boatIndex != null) this.beginRace();
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
      if (typeof msg.autoPenalty === "boolean") race.penalty.autoComplete = msg.autoPenalty;
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
      const previousBearing = this.venue ? this.venue.bearingDeg : 0;
      const trueWindDirection = wrap360(this.wind.baseDir + previousBearing);
      const trueCurrentDirection = Number.isFinite(this.waterCurrent.trueDirectionDeg)
        ? this.waterCurrent.trueDirectionDeg : wrap360(this.waterCurrent.directionDeg + previousBearing);
      this.venue = {
        lat, lon,
        bearingDeg: trueWindDirection
      };
      const courseLengthM = clamp(Number(msg.courseLengthM) || Math.abs(this.windwardMark.y), 50, 5000);
      this.windwardMark = { x: 0, y: -courseLengthM };
      this.wind.baseDir = 0;
      this.waterCurrent.directionDeg = wrap360(trueCurrentDirection - this.venue.bearingDeg);
      this.waterCurrent.trueDirectionDeg = trueCurrentDirection;
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
    this.alignCourseToStartWind();
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
    this.raceModel = { ...this.conditionModel };
    this.activeHails.clear(); this.hailCooldowns.clear(); this.markRoomRights.clear();
    this.roomStatus = "prestart";
    this.broadcast({ t: "start_countdown", prestartSeconds: this.prestartSeconds });
    this.broadcastRoster();
  }

  alignCourseToStartWind() {
    if (!this.venue) return;
    const localWindAtStart = this.currentWind().dir;
    const previousBearing = this.venue.bearingDeg;
    const trueWindAtStart = wrap360(previousBearing + localWindAtStart);
    const trueCurrentDirection = Number.isFinite(this.waterCurrent.trueDirectionDeg)
      ? this.waterCurrent.trueDirectionDeg
      : wrap360(previousBearing + this.waterCurrent.directionDeg);

    this.venue.bearingDeg = trueWindAtStart;
    // Keep the same modeled oscillation phase but make its instantaneous value
    // zero in the newly wind-aligned local frame.
    this.wind.baseDir = wrap360(this.wind.baseDir - localWindAtStart);
    this.waterCurrent.directionDeg = wrap360(trueCurrentDirection - trueWindAtStart);
    this.waterCurrent.trueDirectionDeg = trueCurrentDirection;
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

  setAiCount(requestedCount) {
    while (this.aiSeats.size > requestedCount) {
      const seat = [...this.aiSeats].pop();
      this.aiSeats.delete(seat);
      this.connected[seat] = false;
      this.boats[seat] = null; this.races[seat] = null; this.names[seat] = null; this.setups[seat] = null;
    }
    while (this.aiSeats.size < requestedCount) {
      const seat = this.freeSeat();
      if (seat === -1) break;
      const spawn = spawnPositions(seat + 1, this.currentWind())[seat];
      const setup = normalizeBoatSetup({ skipperWeightKg: 95, sailChoice: "GS1", mastPositionMm: 53, rigTensionKg: 35 });
      const boat = freshBoatState(spawn.headingDeg, setup);
      boat.worldX = spawn.x; boat.worldY = spawn.y;
      this.boats[seat] = boat; this.races[seat] = freshRaceState();
      this.races[seat].prevWorldX = spawn.x; this.races[seat].prevWorldY = spawn.y;
      this.connected[seat] = true; this.names[seat] = "AI Finn " + (this.aiSeats.size + 1); this.setups[seat] = setup;
      this.aiSeats.add(seat);
    }
    this.startLine = startLineForBoatCount(this.connected.filter(Boolean).length);
    this.promoteWaiting();
    this.broadcastRoster();
  }

  steerAi(seat) {
    const boat = this.boats[seat], race = this.races[seat];
    if (!boat || !race || race.penalty.active || race.status === "disqualified") return;
    boat.autoTrim = true;
    if (this.roomStatus === "lobby") {
      const phase = this.wind.t * 0.10 + seat * 1.7;
      this.steerAiTo(seat, Math.sin(phase) * 7, 12 + (seat % 3) * 2, false);
      return;
    }
    if (race.status === "prestart") {
      const remaining = this.prestartSeconds - this.raceClock;
      if (race.ocs) {
        // Return completely to the prestart side before making another run.
        this.steerAiTo(seat, clamp(boat.worldX, this.startLine.pinX + 2, this.startLine.boatEndX - 2), 8, false);
        return;
      }
      const fleetOrder = [...this.aiSeats].indexOf(seat);
      const fleetSize = Math.max(1, this.aiSeats.size);
      const slotT = (fleetOrder + 1) / (fleetSize + 1);
      const slotX = this.startLine.pinX + 2 + slotT * (this.startLine.lengthM - 4);
      const secondsToLine = Math.max(2.5, boat.worldY / Math.max(1.8, boat.speedKnots * 0.5144) + 1.8);
      if (remaining <= secondsToLine) {
        this.steerAiTo(seat, slotX, -10, true);
      } else {
        // Sail a compact racetrack behind the line instead of disappearing on
        // a fixed reach. The waypoint remains inside the visible start box.
        const holdPhase = this.raceClock * 0.16 + seat * 1.9;
        const holdX = clamp(slotX + Math.sin(holdPhase) * 5, this.startLine.pinX + 2, this.startLine.boatEndX - 2);
        const holdY = 10 + (Math.cos(holdPhase) + 1) * 3;
        this.steerAiTo(seat, holdX, holdY, false);
      }
      return;
    }
    if (race.status === "finished" || race.status === "disqualified") { boat.targetHeadingDeg = boat.headingDeg; return; }
    if (race.leg === 1 || race.leg === 3) {
      const windDir = this.currentWind().dir;
      const starboard = wrap360(windDir + 42), port = wrap360(windDir - 42);
      const markDistance = Math.hypot(boat.worldX - this.windwardMark.x, boat.worldY - this.windwardMark.y);
      if (boat.worldX > 18) boat.aiTackHeading = port;
      else if (boat.worldX < -18) boat.aiTackHeading = starboard;
      else if (!Number.isFinite(boat.aiTackHeading)) boat.aiTackHeading = seat % 2 ? starboard : port;
      // Near the mark, tack onto the layline that converges toward it rather
      // than continuing past it on the original boundary rule.
      if (markDistance < 35) boat.aiTackHeading = boat.worldX > 0 ? port : starboard;
      this.setAiHeadingWithAvoidance(seat, boat.aiTackHeading);
    } else if (race.leg === 2 || race.leg === 4) {
      const gate = leewardGateForStartLine(this.startLine);
      this.steerAiTo(seat, (gate.portX + gate.starboardX) / 2, gate.y + 10, false);
    } else {
      const finishX = (this.startLine.pinX + this.startLine.boatEndX) / 2;
      this.steerAiTo(seat, finishX, this.startLine.y + 10, false);
    }
  }

  steerAiTo(seat, x, y, allowCloseHauled) {
    const boat = this.boats[seat];
    let desired = bearingTo(boat.worldX, boat.worldY, x, y);
    const windDir = this.currentWind().dir;
    const relativeToWind = ((desired - windDir + 540) % 360) - 180;
    if (!allowCloseHauled && Math.abs(relativeToWind) < 42) desired = wrap360(windDir + (relativeToWind < 0 ? -42 : 42));
    else if (allowCloseHauled && Math.abs(relativeToWind) < 38) desired = wrap360(windDir + (boat.worldX > x ? -42 : 42));
    this.setAiHeadingWithAvoidance(seat, desired);
  }

  setAiHeadingWithAvoidance(seat, desired) {
    const boat = this.boats[seat];
    for (let otherSeat = 0; otherSeat < this.boats.length; otherSeat++) {
      const other = this.boats[otherSeat];
      if (!other || otherSeat === seat || !this.connected[otherSeat]) continue;
      const separation = Math.hypot(other.worldX - boat.worldX, other.worldY - boat.worldY);
      if (separation >= 7) continue;
      const otherBearing = bearingTo(boat.worldX, boat.worldY, other.worldX, other.worldY);
      const side = (((otherBearing - desired + 540) % 360) - 180) >= 0 ? -1 : 1;
      desired = wrap360(desired + side * (8 - separation) * 4);
    }
    boat.targetHeadingDeg = wrap360(desired);
  }

  issueHail(fromSeat, toSeat, call, type) {
    const now = this.wind.t, key = type + ":" + fromSeat + ":" + toSeat;
    if ((this.hailCooldowns.get(key) || 0) > now) return;
    this.hailCooldowns.set(key, now + 5);
    this.activeHails.set(fromSeat, { id: key + ":" + Math.floor(now * 10), call, type, toBoatIndex: toSeat, until: now + 2.4 });
  }

  updateAutoHails(activeSeats, wind) {
    for (const [seat, hail] of this.activeHails) if (hail.until <= this.wind.t) this.activeHails.delete(seat);
    const markRoomZone = FINN_LENGTH_M * 3;
    for (let a = 0; a < activeSeats.length; a++) {
      for (let b = a + 1; b < activeSeats.length; b++) {
        const i = activeSeats[a], j = activeSeats[b];
        const bi = this.boats[i], bj = this.boats[j], ri = this.races[i], rj = this.races[j];
        if (!bi || !bj || !ri || !rj) continue;
        if (!["prestart", "racing"].includes(ri.status) || !["prestart", "racing"].includes(rj.status)) continue;
        const separation = Math.hypot(bj.worldX - bi.worldX, bj.worldY - bi.worldY);

        if (bi.tackSign !== bj.tackSign && separation < 28 && closestApproachMetres(bi, bj, 7) < 7) {
          const starboardSeat = bi.tackSign > 0 ? i : j, portSeat = starboardSeat === i ? j : i;
          this.issueHail(starboardSeat, portSeat, "STARBOARD", "starboard");
        }

        if (bi.tackSign === bj.tackSign && separation < 12) {
          const downwindR = wrap360(wind.dir + 180) * D2R;
          const ux = Math.sin(downwindR), uy = -Math.cos(downwindR);
          const posI = bi.worldX * ux + bi.worldY * uy, posJ = bj.worldX * ux + bj.worldY * uy;
          const leewardSeat = posI > posJ ? i : j, windwardSeat = leewardSeat === i ? j : i;
          const leeward = this.boats[leewardSeat];
          const currentTwa = Math.abs(wrap180(wind.dir - leeward.headingDeg));
          const targetTwa = Math.abs(wrap180(wind.dir - leeward.targetHeadingDeg));
          if (targetTwa < currentTwa - 2) this.issueHail(leewardSeat, windwardSeat, "UP", "up");
        }

        const pairKey = i + ":" + j;
        if (ri.status === "racing" && rj.status === "racing" && ri.leg === rj.leg && (ri.leg === 1 || ri.leg === 3)) {
          const di = Math.hypot(bi.worldX - this.windwardMark.x, bi.worldY - this.windwardMark.y);
          const dj = Math.hypot(bj.worldX - this.windwardMark.x, bj.worldY - this.windwardMark.y);
          if (!this.markRoomRights.has(pairKey) && Math.min(di, dj) <= markRoomZone) this.markRoomRights.set(pairKey, di <= dj ? i : j);
          const entitledSeat = this.markRoomRights.get(pairKey);
          if (entitledSeat != null && Math.min(di, dj) <= markRoomZone && separation < 16) {
            this.issueHail(entitledSeat, entitledSeat === i ? j : i, "ROOM", "room");
          }
        } else this.markRoomRights.delete(pairKey);
      }
    }
  }

  windForBoat(boat, centreWind) {
    const model = this.raceModel || this.conditionModel;
    const gustRange = clamp((model.gustKnots || centreWind.speed) - centreWind.speed, 0, 12);
    const phase = (model.seed || 1) * 0.0001;
    const patch = Math.sin(this.wind.t * 0.055 + boat.worldX * 0.032 + boat.worldY * 0.017 + phase);
    const ripple = Math.sin(this.wind.t * 0.14 - boat.worldX * 0.019 + boat.worldY * 0.027 + phase * 1.7);
    const local = {
      speed: clamp(centreWind.speed + Math.max(0, gustRange) * (patch * 0.32 + ripple * 0.12), 2, 30),
      dir: wrap360(centreWind.dir + patch * 4 + ripple * 1.5)
    };
    const dirty = boat.dirtyWind;
    if (!dirty) return local;
    return { speed: Math.max(2, local.speed - dirty.speedDeficitKnots), dir: wrap360(local.dir + dirty.directionShiftDeg) };
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
    for (const seat of this.aiSeats) this.steerAi(seat);

    if (this.roomStatus === "lobby") {
      const activeBoats = activeSeats.map(i => this.boats[i]);
      stepFleetDirtyWind(activeBoats, wind, dt, activeSeats);
      for (const i of activeSeats) stepBoatKinematics(this.boats[i], this.windForBoat(this.boats[i], wind), dt, this.waterCurrent);
    } else {
      this.raceClock += dt;
      const activeBoats = activeSeats.map(i => this.boats[i]);
      stepFleetDirtyWind(activeBoats, wind, dt, activeSeats);
      for (const i of activeSeats) {
        const boat = this.boats[i], rs = this.races[i];
        if (rs.status === "disqualified" || (rs.collision && rs.collision.active)) {
          boat.speedKnots = 0;
        } else {
          applyPenaltyOverride(boat, rs);
          stepBoatKinematics(boat, this.windForBoat(boat, wind), dt, this.waterCurrent);
          updatePenaltyProgress(boat, rs, dt);
        }
        stepRace(boat, rs, this.raceClock, dt, this.startLine, this.prestartSeconds, this.windwardMark);
      }
      const activeRaces = activeSeats.map(i => this.races[i]);
      stepRules(activeBoats, activeRaces, wind, dt, activeSeats);
      this.updateAutoHails(activeSeats, wind);

      if (this.roomStatus === "prestart" || this.roomStatus === "racing") {
        const anyRacing = activeSeats.some(i => this.races[i].status === "racing");
        if (anyRacing) this.roomStatus = "racing";
        const allDone = activeSeats.length > 0 && activeSeats.every(i => ["finished", "disqualified"].includes(this.races[i].status));
        const timedOut = this.raceClock > this.prestartSeconds + RACE_TIMEOUT_SECONDS;
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
    for (const seat of this.aiSeats) roster.push({
      id: "ai-" + seat, boatIndex: seat, name: this.names[seat], connected: true, waiting: false, ai: true,
      setup: this.setups[seat], color: BOAT_COLORS[seat % BOAT_COLORS.length]
    });
    this.broadcast({ t: "roster", roster, hostId: this.hostId, roomStatus: this.roomStatus, venue: this.venue, startLine: this.startLine, windwardMark: this.windwardMark, conditions: this.waterCurrent, conditionModel: this.conditionModel, prestartSeconds: this.prestartSeconds, aiCount: this.aiSeats.size });
  }

  broadcastSnapshot(wind, activeSeats) {
    const boats = activeSeats.map(i => {
      const b = this.boats[i], r = this.races[i];
      return {
        boatIndex: i, name: this.names[i], color: BOAT_COLORS[i % BOAT_COLORS.length], connected: !!this.connected[i], ai: this.aiSeats.has(i),
        worldX: round2(b.worldX), worldY: round2(b.worldY), headingDeg: round2(b.headingDeg),
        speedKnots: round2(b.speedKnots), tackSign: b.tackSign, autoTrim: b.autoTrim,
        trimAngleDeg: round2(b.trimAngleDeg), trimEfficiency01: round2(b.trimEfficiency01),
        setup: b.setup,
        sailingWind: this.windForBoat(b, wind),
        hail: this.activeHails.get(i) || null,
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
          penalty: { active: r.penalty.active, pending: r.penalty.pending, autoComplete: r.penalty.autoComplete, count: r.penalty.count, turnedDeg: round2(r.penalty.turnedDeg), rule: r.penalty.rule },
          collision: r.collision
        }
      };
    });
    this.broadcast({
      t: "snapshot", serverTimeMs: Date.now(), wind: { dir: round2(wind.dir), speed: round2(wind.speed) },
      roomStatus: this.roomStatus, raceClock: round2(this.raceClock), prestartSeconds: this.prestartSeconds, startLine: this.startLine, windwardMark: this.windwardMark, waterCurrent: this.waterCurrent, conditionModel: this.raceModel || this.conditionModel, boats
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
function hashString(value) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) { hash ^= value.charCodeAt(i); hash = Math.imul(hash, 16777619); }
  return hash >>> 0;
}
function closestApproachMetres(a, b, horizonSeconds) {
  const velocity = boat => ({
    x: Math.sin(boat.headingDeg * D2R) * boat.speedKnots * MPS_PER_KNOT,
    y: -Math.cos(boat.headingDeg * D2R) * boat.speedKnots * MPS_PER_KNOT
  });
  const va = velocity(a), vb = velocity(b);
  const rx = b.worldX - a.worldX, ry = b.worldY - a.worldY;
  const vx = vb.x - va.x, vy = vb.y - va.y;
  const speed2 = vx * vx + vy * vy;
  const time = speed2 > 0.0001 ? clamp(-(rx * vx + ry * vy) / speed2, 0, horizonSeconds) : 0;
  return Math.hypot(rx + vx * time, ry + vy * time);
}
