// ---------------------------------------------------------------------------
// Shared server-authoritative sailing physics.
// Ported 1:1 from the single-player prototype (sailing-prototype.html) so
// server behavior matches what was designed and play-tested client-side.
// Generalized from a hardcoded player+ghost pair to an array of up to
// MAX_BOATS boats.
// ---------------------------------------------------------------------------

export const MAX_BOATS = 6;
export const TICK_HZ = 15;
export const TICK_MS = 1000 / TICK_HZ;

export const TAU = Math.PI * 2;
export const D2R = Math.PI / 180;

export function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
export function lerp(a, b, t) { return a + (b - a) * t; }
export function wrap360(a) { a = a % 360; if (a < 0) a += 360; return a; }
export function wrap180(a) { return wrap360(a + 180) - 180; }

// ---------- reference polar table: real Finn dinghy chart ----------
export const TWA_ROWS = [40, 45, 50, 60, 75, 90, 110, 120, 135, 150, 165, 180];
export const TWS_COLS = [5, 8, 10, 12, 15, 18, 20, 25];
export const POLAR = [
  [2.1, 3.2, 4.7, 5.7, 6.7, 7.6, 8.2, 9.5],
  [2.2, 3.6, 5.0, 6.1, 7.2, 8.2, 8.9, 10.3],
  [2.3, 3.9, 5.2, 6.3, 7.5, 8.5, 9.2, 10.6],
  [2.6, 4.3, 5.5, 6.7, 8.0, 9.2, 10.0, 11.4],
  [2.8, 4.7, 5.8, 7.0, 8.4, 9.6, 10.4, 11.8],
  [2.9, 4.9, 6.0, 7.2, 8.6, 9.9, 10.7, 12.1],
  [3.0, 5.1, 6.2, 7.4, 8.9, 10.2, 11.0, 12.4],
  [3.1, 5.2, 6.3, 7.5, 9.0, 10.3, 11.2, 12.6],
  [3.0, 5.1, 6.1, 7.2, 8.7, 10.0, 10.8, 12.2],
  [2.7, 4.6, 5.7, 6.7, 8.1, 9.3, 10.0, 11.3],
  [2.3, 3.9, 5.3, 6.2, 7.3, 8.4, 9.1, 10.4],
  [2.0, 3.4, 5.0, 5.8, 6.8, 7.8, 8.4, 9.6]
];

function bracket(arr, v) {
  v = clamp(v, arr[0], arr[arr.length - 1]);
  let lo = 0;
  for (let i = 0; i < arr.length - 1; i++) { if (v >= arr[i] && v <= arr[i + 1]) { lo = i; break; } }
  const hi = Math.min(lo + 1, arr.length - 1);
  const span = arr[hi] - arr[lo];
  const t = span > 0 ? (v - arr[lo]) / span : 0;
  return { lo, hi, t };
}

export function polarSpeed(absTwaDeg, twsKnots) {
  const a = bracket(TWA_ROWS, absTwaDeg);
  const w = bracket(TWS_COLS, twsKnots);
  const top = lerp(POLAR[a.lo][w.lo], POLAR[a.lo][w.hi], w.t);
  const bot = lerp(POLAR[a.hi][w.lo], POLAR[a.hi][w.hi], w.t);
  return lerp(top, bot, a.t);
}

// ---------- tunables (identical to the single-player prototype) ----------
export const NO_GO_HALF = 40;
export const TACK_LOCKOUT_SEC = 2.0;
export const ACCEL_KT_PER_SEC = 1.4;
export const TURN_RATE_MAX = 32;
export const TURN_RATE_MIN = 11;
export const TRIM_MAX_ERROR = 25;
export const STERNWAY_DRIFT_FACTOR = 0.06;
export const MPS_PER_KNOT = 0.5144;

// ---------- course: windward/leeward, one lap, finish at the start line ----------
export const FINN_LENGTH_M = 4.5;
export const START_LINE_LENGTH_PER_BOAT = 1.5;
export const MIN_START_LINE_LENGTH_M = 20;
export const PIN_X = -10, BOAT_END_X = 10, START_Y = 0;
export const WINDWARD_MARK = { x: 0, y: -150 };
export const MARK_RADIUS = 8;
export const PRESTART_SECONDS = 180;
export const RACE_TIMEOUT_SECONDS = 240;

// ---------- right-of-way rules ----------
export const INFRINGEMENT_RADIUS = 5;
export const PENALTY_TURN_DEG = 360;
export const PENALTY_IMMUNITY_SEC = 4;

export function dist(ax, ay, bx, by) { return Math.hypot(ax - bx, ay - by); }
export function bearingTo(fromX, fromY, toX, toY) {
  return wrap360(Math.atan2(toX - fromX, -(toY - fromY)) / D2R);
}
export function crossedLine(prevX, prevY, curX, curY, lineY, xMin, xMax) {
  const south2north = prevY > lineY && curY <= lineY;
  const north2south = prevY < lineY && curY >= lineY;
  if (!south2north && !north2south) return null;
  const t = (lineY - prevY) / (curY - prevY);
  const xAt = prevX + (curX - prevX) * t;
  if (xAt < xMin || xAt > xMax) return null;
  return south2north ? "south-to-north" : "north-to-south";
}

export function startLineForBoatCount(count) {
  const lengthM = Math.max(MIN_START_LINE_LENGTH_M, Math.max(0, count) * FINN_LENGTH_M * START_LINE_LENGTH_PER_BOAT);
  return { pinX: -lengthM / 2, boatEndX: lengthM / 2, y: START_Y, lengthM };
}

export function idealTrimAngle(twaDeg) { return clamp(twaDeg * 0.5, 6, 80); }
export function turnRateFor(absTwaDeg) {
  const t = clamp(absTwaDeg / (NO_GO_HALF * 1.4), 0, 1);
  return lerp(TURN_RATE_MIN, TURN_RATE_MAX, t);
}

export function noGoSpeed(absTwaDeg, twsKnots) {
  const fullCloseHauled = polarSpeed(NO_GO_HALF, twsKnots);
  const drift = -twsKnots * STERNWAY_DRIFT_FACTOR;
  const t = clamp(absTwaDeg / NO_GO_HALF, 0, 1);
  const eased = t * t * (3 - 2 * t);
  return lerp(drift, fullCloseHauled, eased);
}

// ---------- wind: deterministic function of elapsed room time, so every
// client can also predict it locally without a dedicated wind message ----------
export function windAt(baseDir, baseSpeed, t) {
  const dir = wrap360(baseDir + Math.sin(t * 0.05) * 7 + Math.sin(t * 0.13 + 1.7) * 2.5);
  const speed = clamp(baseSpeed + Math.sin(t * 0.09 + 0.6) * 3.2 + Math.sin(t * 0.21) * 1.1, 5, 25);
  return { dir, speed };
}

export function freshBoatState(headingDeg) {
  return {
    headingDeg, targetHeadingDeg: headingDeg, speedKnots: 0,
    trimAngleDeg: 30, trimEfficiency01: 1, autoTrim: true,
    tackSign: 1, tackLockoutTimer: 0,
    worldX: 0, worldY: 0
  };
}

export function stepBoatKinematics(s, wind, dt) {
  const twaSigned = wrap180(wind.dir - s.headingDeg);
  const absTwa = Math.abs(twaSigned);
  const pinching = absTwa < NO_GO_HALF;

  const toTarget = wrap180(s.targetHeadingDeg - s.headingDeg);
  const rate = turnRateFor(absTwa) * dt;
  if (Math.abs(toTarget) <= rate) s.headingDeg = wrap360(s.headingDeg + toTarget);
  else s.headingDeg = wrap360(s.headingDeg + Math.sign(toTarget) * rate);

  const newTack = twaSigned >= 0 ? 1 : -1;
  if (s.tackLockoutTimer > 0) s.tackLockoutTimer -= dt;
  if (newTack !== s.tackSign && s.tackLockoutTimer <= 0) {
    s.tackSign = newTack;
    s.tackLockoutTimer = TACK_LOCKOUT_SEC;
  }

  if (s.autoTrim) {
    s.trimEfficiency01 = 0.97;
  } else {
    const ideal = idealTrimAngle(absTwa);
    const err = Math.abs(s.trimAngleDeg - ideal);
    s.trimEfficiency01 = 1 - Math.pow(clamp(err / TRIM_MAX_ERROR, 0, 1), 1.5);
  }

  const trimPenalty = lerp(0.55, 1.0, s.trimEfficiency01);
  let target;
  if (pinching) {
    const raw = noGoSpeed(absTwa, wind.speed);
    target = raw > 0 ? raw * trimPenalty : raw;
  } else {
    target = polarSpeed(absTwa, wind.speed) * trimPenalty;
  }
  const maxStep = ACCEL_KT_PER_SEC * dt;
  if (Math.abs(target - s.speedKnots) <= maxStep) s.speedKnots = target;
  else s.speedKnots += Math.sign(target - s.speedKnots) * maxStep;

  const mps = s.speedKnots * MPS_PER_KNOT;
  const hr = s.headingDeg * D2R;
  s.worldX += Math.sin(hr) * mps * dt;
  s.worldY += -Math.cos(hr) * mps * dt;

  const drifting = s.speedKnots <= 0.05;
  return { twaSigned, absTwa, inNoGo: pinching, drifting };
}

export function freshRaceState() {
  return {
    status: "prestart", leg: 1, ocs: false, prevWorldX: 0, prevWorldY: 0, finishTime: null, place: null,
    penalty: { active: false, turnedDeg: 0, rule: null, lastHeading: 0 }, immunityTimer: 0
  };
}

export function currentMarkFor(rs) {
  return rs.leg === 1 ? WINDWARD_MARK : { x: (PIN_X + BOAT_END_X) / 2, y: START_Y };
}

export function stepRace(s, rs, raceClock, dt, startLine = { pinX: PIN_X, boatEndX: BOAT_END_X, y: START_Y }) {
  if (rs.status === "finished") { rs.prevWorldX = s.worldX; rs.prevWorldY = s.worldY; return; }
  const crossing = crossedLine(rs.prevWorldX, rs.prevWorldY, s.worldX, s.worldY, startLine.y, Math.min(startLine.pinX, startLine.boatEndX), Math.max(startLine.pinX, startLine.boatEndX));
  const afterStart = raceClock >= PRESTART_SECONDS;

  if (rs.status === "prestart") {
    if (crossing === "south-to-north") {
      if (afterStart) { rs.status = "racing"; rs.leg = 1; rs.ocs = false; }
      else { rs.ocs = true; }
    } else if (crossing === "north-to-south" && rs.ocs) {
      rs.ocs = false;
    }
  } else if (rs.status === "racing") {
    if (rs.leg === 1) {
      if (dist(s.worldX, s.worldY, WINDWARD_MARK.x, WINDWARD_MARK.y) < MARK_RADIUS) rs.leg = 2;
    } else if (rs.leg === 2 && crossing === "south-to-north") {
      rs.status = "finished";
      rs.finishTime = raceClock - PRESTART_SECONDS;
    }
  }
  rs.prevWorldX = s.worldX; rs.prevWorldY = s.worldY;
}

// ---------- right-of-way: simplified RRS 10 (port/starboard) & RRS 11 (windward/leeward) ----------
export function applyPenaltyOverride(s, rs) {
  if (!rs.penalty.active) return;
  s.targetHeadingDeg = wrap360(s.headingDeg + 45);
}
export function updatePenaltyProgress(s, rs, dt) {
  if (!rs.penalty.active) return;
  rs.penalty.turnedDeg += Math.abs(wrap180(s.headingDeg - rs.penalty.lastHeading));
  rs.penalty.lastHeading = s.headingDeg;
  if (rs.penalty.turnedDeg >= PENALTY_TURN_DEG) {
    rs.penalty.active = false;
    rs.immunityTimer = PENALTY_IMMUNITY_SEC;
    s.targetHeadingDeg = s.headingDeg;
  }
}
export function startPenalty(s, rs, rule) {
  rs.penalty.active = true;
  rs.penalty.turnedDeg = 0;
  rs.penalty.rule = rule;
  rs.penalty.lastHeading = s.headingDeg;
}

// Generalized from the 2-boat prototype to N boats: every pair within the
// infringement radius during "racing" is checked; a foul on either member
// of a pair skips that pair (one foul at a time per boat, same rule as before).
export function stepRules(boats, races, wind, dt) {
  for (const rs of races) {
    if (rs.immunityTimer > 0) rs.immunityTimer -= dt;
  }
  for (let i = 0; i < boats.length; i++) {
    for (let j = i + 1; j < boats.length; j++) {
      const bi = boats[i], bj = boats[j];
      const ri = races[i], rj = races[j];
      if (ri.status !== "racing" || rj.status !== "racing") continue;
      if (ri.penalty.active || rj.penalty.active) continue;
      if (dist(bi.worldX, bi.worldY, bj.worldX, bj.worldY) >= INFRINGEMENT_RADIUS) continue;

      let giveWayIsI, rule;
      if (bi.tackSign !== bj.tackSign) {
        giveWayIsI = bi.tackSign < 0;
        rule = "Rule 10 — port/starboard";
      } else {
        const downwind = wrap360(wind.dir + 180) * D2R;
        const ux = Math.sin(downwind), uy = -Math.cos(downwind);
        const posI = bi.worldX * ux + bi.worldY * uy;
        const posJ = bj.worldX * ux + bj.worldY * uy;
        giveWayIsI = posI < posJ;
        rule = "Rule 11 — windward/leeward";
      }

      const giveWayBoat = giveWayIsI ? bi : bj;
      const giveWayRace = giveWayIsI ? ri : rj;
      if (giveWayRace.immunityTimer > 0) continue;
      startPenalty(giveWayBoat, giveWayRace, rule);
    }
  }
}

// Spread N starting positions along the start line, all on a reaching
// heading roughly wind ± 70deg so nobody spawns already in the no-go zone.
export function spawnPositions(count, wind, startLine = startLineForBoatCount(count)) {
  const usableWidth = (startLine.boatEndX - startLine.pinX) - 6;
  const out = [];
  for (let i = 0; i < count; i++) {
    const t = count === 1 ? 0.5 : i / (count - 1);
    const x = startLine.pinX + 3 + usableWidth * t;
    const y = startLine.y + 12 + (i % 2 === 0 ? 3 : 0);
    const heading = wrap360(wind.dir + (i % 2 === 0 ? 70 : -70));
    out.push({ x, y, headingDeg: heading });
  }
  return out;
}
