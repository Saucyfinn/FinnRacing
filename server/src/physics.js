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
export const FINN_CLOSE_HAULED_MAX_KNOTS = 5.4;
export const POLAR = [
  [2.1, 3.2, 4.7, 5.4, 5.4, 5.4, 5.4, 5.4],
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

// ---------- individual Finn setup ----------
export const SAIL_CHOICES = Object.freeze(["GS1-", "GS1", "GS1+", "WB"]);
export const DEFAULT_BOAT_SETUP = Object.freeze({
  skipperWeightKg: 95,
  sailChoice: "GS1",
  mastPositionMm: 50,
  rigTensionKg: 35
});

// Mid-points derived from FinnSailAnalyzer's light / medium / heavy tables.
// The Analyzer calls this the board position and records rig loads around
// 34–36.3 kg; the game exposes the sailor-facing names requested for setup.
export const ANALYZER_RIG_TARGETS = Object.freeze([
  Object.freeze({ windKnots: 5, mastPositionMm: 43, rigTensionKg: 34.7 }),
  Object.freeze({ windKnots: 11.5, mastPositionMm: 53, rigTensionKg: 35.2 }),
  Object.freeze({ windKnots: 18, mastPositionMm: 56, rigTensionKg: 34.6 })
]);

const SAIL_PROFILES = Object.freeze({
  "GS1-": Object.freeze({ powerBias: -0.055, controlBias: 0.025, baseSpeed: 0, pointingPenaltyDeg: 0 }),
  GS1: Object.freeze({ powerBias: 0, controlBias: 0, baseSpeed: 0, pointingPenaltyDeg: 0 }),
  "GS1+": Object.freeze({ powerBias: 0.055, controlBias: -0.012, baseSpeed: 0, pointingPenaltyDeg: 0.15 }),
  WB: Object.freeze({ powerBias: 0.025, controlBias: 0.015, baseSpeed: -0.005, pointingPenaltyDeg: 0.6 })
});

export function normalizeBoatSetup(value = {}) {
  const numberOr = (raw, fallback) => raw === null || raw === "" || raw === undefined ? fallback : Number(raw);
  const weight = numberOr(value.skipperWeightKg, DEFAULT_BOAT_SETUP.skipperWeightKg);
  const mast = numberOr(value.mastPositionMm, DEFAULT_BOAT_SETUP.mastPositionMm);
  const tension = numberOr(value.rigTensionKg, DEFAULT_BOAT_SETUP.rigTensionKg);
  const rawSail = String(value.sailChoice || "GS1").replace("−", "-").toUpperCase();
  return {
    skipperWeightKg: clamp(Number.isFinite(weight) ? weight : DEFAULT_BOAT_SETUP.skipperWeightKg, 70, 120),
    sailChoice: SAIL_CHOICES.includes(rawSail) ? rawSail : DEFAULT_BOAT_SETUP.sailChoice,
    mastPositionMm: clamp(Number.isFinite(mast) ? mast : DEFAULT_BOAT_SETUP.mastPositionMm, 35, 56),
    rigTensionKg: clamp(Number.isFinite(tension) ? tension : DEFAULT_BOAT_SETUP.rigTensionKg, 30, 40)
  };
}

export function analyzerRigTarget(twsKnots) {
  const w = clamp(twsKnots, ANALYZER_RIG_TARGETS[0].windKnots, ANALYZER_RIG_TARGETS.at(-1).windKnots);
  let lo = ANALYZER_RIG_TARGETS[0], hi = ANALYZER_RIG_TARGETS[1];
  for (let i = 0; i < ANALYZER_RIG_TARGETS.length - 1; i++) {
    if (w >= ANALYZER_RIG_TARGETS[i].windKnots && w <= ANALYZER_RIG_TARGETS[i + 1].windKnots) {
      lo = ANALYZER_RIG_TARGETS[i]; hi = ANALYZER_RIG_TARGETS[i + 1]; break;
    }
  }
  const t = (w - lo.windKnots) / (hi.windKnots - lo.windKnots);
  return {
    mastPositionMm: lerp(lo.mastPositionMm, hi.mastPositionMm, t),
    rigTensionKg: lerp(lo.rigTensionKg, hi.rigTensionKg, t)
  };
}

export function boatSetupPerformance(setupValue, twsKnots) {
  const setup = normalizeBoatSetup(setupValue);
  const target = analyzerRigTarget(twsKnots);
  const mastError01 = clamp(Math.abs(setup.mastPositionMm - target.mastPositionMm) / 13, 0, 1);
  const tensionError01 = clamp(Math.abs(setup.rigTensionKg - target.rigTensionKg) / 5, 0, 1);
  const rigMatch01 = clamp(1 - mastError01 * 0.62 - tensionError01 * 0.38, 0, 1);

  const profile = SAIL_PROFILES[setup.sailChoice];
  const lightToHeavy = clamp((twsKnots - 12) / 7, -1, 1);
  const sailEffect = -profile.powerBias * lightToHeavy
    + profile.controlBias * Math.max(0, lightToHeavy) + profile.baseSpeed;
  const weight01 = clamp((setup.skipperWeightKg - 95) / 25, -1, 1);
  const weightEffect = weight01 * lightToHeavy * 0.025;
  const rigPenalty = mastError01 * 0.045 + tensionError01 * 0.035;

  return {
    speedMultiplier: clamp(1 + sailEffect + weightEffect - rigPenalty, 0.88, 1.07),
    accelerationMultiplier: clamp(1 - weight01 * 0.035 - (1 - rigMatch01) * 0.10, 0.86, 1.06),
    pointingPenaltyDeg: clamp(profile.pointingPenaltyDeg + mastError01 * 1.4 + tensionError01 * 1.0, 0, 3),
    rigMatch01,
    targetMastPositionMm: target.mastPositionMm,
    targetRigTensionKg: target.rigTensionKg
  };
}

// ---------- course: windward/leeward, one lap, finish at the start line ----------
export const FINN_LENGTH_M = 4.5;
// Aerodynamic gameplay constants are grouped for later on-water calibration.
export const DIRTY_WIND = Object.freeze({
  wakeLengthM: FINN_LENGTH_M * 12,
  wakeDecayM: FINN_LENGTH_M * 6,
  wakeHalfWidthM: 1.1,
  wakeSpreadDeg: 12,
  directWakeSpreadDeg: 4,
  leeBowAftM: FINN_LENGTH_M * 2.2,
  leeBowWindwardM: FINN_LENGTH_M * 1.8,
  leeBowMaxShiftDeg: 7,
  attackSec: 0.7,
  releaseSec: 1.8
});
export const START_LINE_LENGTH_PER_BOAT = 1.5;
export const MIN_START_LINE_LENGTH_M = 20;
export const PIN_X = -10, BOAT_END_X = 10, START_Y = 0;
export const WINDWARD_MARK = { x: 0, y: -150 };
export const MARK_RADIUS = 8;
export const PRESTART_SECONDS = 180;
export const RACE_TIMEOUT_SECONDS = 240;

// ---------- right-of-way rules ----------
export const INFRINGEMENT_RADIUS = 5;
export const PENALTY_CLEARANCE_M = 10;
export const HULL_COLLISION_RADIUS_M = 4.2;
export const COLLISION_STOP_SECONDS = 1.5;
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

export function noGoSpeed(absTwaDeg, twsKnots, noGoHalf = NO_GO_HALF) {
  const fullCloseHauled = polarSpeed(noGoHalf, twsKnots);
  const drift = -twsKnots * STERNWAY_DRIFT_FACTOR;
  const t = clamp(absTwaDeg / noGoHalf, 0, 1);
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

function cleanDirtyWind(wind) {
  return {
    type: "clean", sourceBoatIndex: null, exposure01: 0,
    speedDeficitKnots: 0, directionShiftDeg: 0,
    effectiveSpeed: wind.speed, effectiveDir: wind.dir
  };
}

// Instantaneous interference from one source. This includes both the normal
// downwind plume and the near-field lee-bow region where a leeward boat that
// is slightly ahead backwinds a same-tack windward boat.
export function dirtyWindFromBoat(target, source, wind) {
  if (target === source) return { exposure01: 0, type: "clean" };
  const dx = target.worldX - source.worldX;
  const dy = target.worldY - source.worldY;

  const flowR = wrap360(wind.dir + 180) * D2R;
  const flowX = Math.sin(flowR), flowY = -Math.cos(flowR);
  const downwindM = dx * flowX + dy * flowY;
  const crosswindM = Math.abs(dx * flowY - dy * flowX);

  let wakeExposure = 0;
  let wakeType = "clean";
  if (downwindM > 0.4 && downwindM < DIRTY_WIND.wakeLengthM) {
    const halfWidth = DIRTY_WIND.wakeHalfWidthM
      + downwindM * Math.tan(DIRTY_WIND.wakeSpreadDeg * D2R);
    if (crosswindM < halfWidth * 2.2) {
      const lateral = Math.exp(-0.5 * Math.pow(crosswindM / halfWidth, 2));
      wakeExposure = Math.min(0.96, Math.exp(-downwindM / DIRTY_WIND.wakeDecayM) * lateral);
      const directWidth = 0.7 + downwindM * Math.tan(DIRTY_WIND.directWakeSpreadDeg * D2R);
      wakeType = crosswindM <= directWidth ? "directWake" : "trailingDirtyAir";
    }
  }

  let leeBowExposure = 0;
  const targetTwa = wrap180(wind.dir - target.headingDeg);
  const sourceTwa = wrap180(wind.dir - source.headingDeg);
  if (target.tackSign === source.tackSign
      && Math.abs(targetTwa) >= 32 && Math.abs(targetTwa) <= 75
      && Math.abs(sourceTwa) >= 32 && Math.abs(sourceTwa) <= 75) {
    const hr = source.headingDeg * D2R;
    const forwardX = Math.sin(hr), forwardY = -Math.cos(hr);
    const rightX = Math.cos(hr), rightY = Math.sin(hr);
    const targetAheadM = dx * forwardX + dy * forwardY;
    const targetWindwardM = (dx * rightX + dy * rightY) * Math.sign(sourceTwa || 1);
    if (targetAheadM > -DIRTY_WIND.leeBowAftM && targetAheadM < 1.5
        && targetWindwardM > 0.3 && targetWindwardM < DIRTY_WIND.leeBowWindwardM) {
      const foreAft = Math.exp(-0.5 * Math.pow((targetAheadM + 2.0) / 3.6, 2));
      const windward = Math.exp(-0.5 * Math.pow((targetWindwardM - 2.5) / 2.0, 2));
      leeBowExposure = Math.min(0.94, 0.92 * foreAft * windward);
    }
  }

  if (leeBowExposure > wakeExposure) return { exposure01: leeBowExposure, type: "leeBow" };
  return { exposure01: wakeExposure, type: wakeType };
}

function maximumDeficitFraction(twsKnots) {
  // A Finn is proportionally more vulnerable to lost pressure in light air.
  return lerp(0.38, 0.20, clamp((twsKnots - 5) / 20, 0, 1));
}

export function stepFleetDirtyWind(boats, wind, dt, boatIndices = boats.map((_, i) => i)) {
  for (let i = 0; i < boats.length; i++) {
    const target = boats[i];
    let clearProduct = 1;
    let dominant = { exposure01: 0, type: "clean", sourceBoatIndex: null };
    for (let j = 0; j < boats.length; j++) {
      if (i === j) continue;
      const effect = dirtyWindFromBoat(target, boats[j], wind);
      clearProduct *= 1 - effect.exposure01;
      if (effect.exposure01 > dominant.exposure01) {
        dominant = { ...effect, sourceBoatIndex: boatIndices[j] };
      }
    }

    const rawExposure = clamp(1 - clearProduct, 0, 1);
    const old = target.dirtyWind || cleanDirtyWind(wind);
    const tau = rawExposure > old.exposure01 ? DIRTY_WIND.attackSec : DIRTY_WIND.releaseSec;
    const blend = 1 - Math.exp(-Math.max(0, dt) / tau);
    const exposure01 = lerp(old.exposure01, rawExposure, blend);
    const active = exposure01 >= 0.04;
    const hasInstantSource = dominant.sourceBoatIndex !== null;
    const type = active ? (hasInstantSource ? dominant.type : old.type) : "clean";
    const sourceBoatIndex = active
      ? (hasInstantSource ? dominant.sourceBoatIndex : old.sourceBoatIndex)
      : null;
    const speedDeficitKnots = Math.min(4.5, wind.speed * maximumDeficitFraction(wind.speed) * exposure01);
    const twaSign = Math.sign(wrap180(wind.dir - target.headingDeg)) || target.tackSign || 1;
    const directionShiftDeg = type === "leeBow"
      ? -twaSign * DIRTY_WIND.leeBowMaxShiftDeg * exposure01
      : 0;
    target.dirtyWind = {
      type,
      sourceBoatIndex,
      exposure01,
      speedDeficitKnots,
      directionShiftDeg,
      effectiveSpeed: Math.max(2, wind.speed - speedDeficitKnots),
      effectiveDir: wrap360(wind.dir + directionShiftDeg)
    };
  }
}

export function effectiveWindForBoat(boat, cleanWind) {
  const dirty = boat.dirtyWind;
  return dirty ? { dir: dirty.effectiveDir, speed: dirty.effectiveSpeed } : cleanWind;
}

export function freshBoatState(headingDeg, setup = DEFAULT_BOAT_SETUP) {
  return {
    headingDeg, targetHeadingDeg: headingDeg, speedKnots: 0,
    trimAngleDeg: 30, trimEfficiency01: 1, autoTrim: true,
    tackSign: 1, tackLockoutTimer: 0,
    worldX: 0, worldY: 0,
    dirtyWind: cleanDirtyWind({ dir: 0, speed: 10 }),
    setup: normalizeBoatSetup(setup), setupEffect: boatSetupPerformance(setup, 10)
  };
}

export function stepBoatKinematics(s, wind, dt, waterCurrent = null) {
  const twaSigned = wrap180(wind.dir - s.headingDeg);
  const absTwa = Math.abs(twaSigned);
  const setupEffect = boatSetupPerformance(s.setup, wind.speed);
  s.setupEffect = setupEffect;
  const effectiveNoGoHalf = NO_GO_HALF + setupEffect.pointingPenaltyDeg;
  const pinching = absTwa < effectiveNoGoHalf;

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
    const raw = noGoSpeed(absTwa, wind.speed, effectiveNoGoHalf);
    target = raw > 0 ? raw * trimPenalty * setupEffect.speedMultiplier : raw;
  } else {
    target = polarSpeed(absTwa, wind.speed) * trimPenalty * setupEffect.speedMultiplier;
  }
  if (absTwa <= NO_GO_HALF) target = Math.min(target, FINN_CLOSE_HAULED_MAX_KNOTS);
  const maxStep = ACCEL_KT_PER_SEC * setupEffect.accelerationMultiplier * dt;
  if (Math.abs(target - s.speedKnots) <= maxStep) s.speedKnots = target;
  else s.speedKnots += Math.sign(target - s.speedKnots) * maxStep;
  if (absTwa <= NO_GO_HALF) s.speedKnots = Math.min(s.speedKnots, FINN_CLOSE_HAULED_MAX_KNOTS);

  const mps = s.speedKnots * MPS_PER_KNOT;
  const hr = s.headingDeg * D2R;
  s.worldX += Math.sin(hr) * mps * dt;
  s.worldY += -Math.cos(hr) * mps * dt;
  if (waterCurrent && waterCurrent.speedKnots > 0) {
    const currentMps = waterCurrent.speedKnots * MPS_PER_KNOT;
    const currentRad = wrap360(waterCurrent.directionDeg) * D2R;
    s.worldX += Math.sin(currentRad) * currentMps * dt;
    s.worldY += -Math.cos(currentRad) * currentMps * dt;
  }

  const drifting = s.speedKnots <= 0.05;
  return { twaSigned, absTwa, inNoGo: pinching, drifting, setupEffect };
}

export function freshRaceState() {
  return {
    status: "prestart", leg: 1, ocs: false, prevWorldX: 0, prevWorldY: 0, finishTime: null, place: null,
    penalty: { active: false, pending: false, count: 0, turnedDeg: 0, rule: null, lastHeading: 0 }, immunityTimer: 0,
    collision: { active: false, timer: 0, withBoatIndex: null }
  };
}

export function currentMarkFor(rs, windwardMark = WINDWARD_MARK) {
  return rs.leg === 1 ? windwardMark : { x: (PIN_X + BOAT_END_X) / 2, y: START_Y };
}

export function stepRace(s, rs, raceClock, dt, startLine = { pinX: PIN_X, boatEndX: BOAT_END_X, y: START_Y }, prestartSeconds = PRESTART_SECONDS, windwardMark = WINDWARD_MARK) {
  if (rs.status === "finished" || rs.status === "disqualified") { rs.prevWorldX = s.worldX; rs.prevWorldY = s.worldY; return; }
  const crossing = crossedLine(rs.prevWorldX, rs.prevWorldY, s.worldX, s.worldY, startLine.y, Math.min(startLine.pinX, startLine.boatEndX), Math.max(startLine.pinX, startLine.boatEndX));
  const afterStart = raceClock >= prestartSeconds;

  if (rs.status === "prestart") {
    if (crossing === "south-to-north") {
      if (afterStart) { rs.status = "racing"; rs.leg = 1; rs.ocs = false; }
      else { rs.ocs = true; }
    } else if (crossing === "north-to-south" && rs.ocs) {
      rs.ocs = false;
    }
  } else if (rs.status === "racing") {
    if (rs.leg === 1) {
      if (dist(s.worldX, s.worldY, windwardMark.x, windwardMark.y) < MARK_RADIUS) rs.leg = 2;
    } else if (rs.leg === 2 && crossing === "north-to-south") {
      rs.status = "finished";
      rs.finishTime = raceClock - prestartSeconds;
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
  if (rs.penalty.active || rs.penalty.pending || rs.status === "disqualified") return;
  rs.penalty.count += 1;
  if (rs.penalty.count >= 2) {
    rs.penalty.active = false;
    rs.penalty.pending = false;
    rs.penalty.rule = rule;
    rs.status = "disqualified";
    s.speedKnots = 0;
    return;
  }
  rs.penalty.pending = true;
  rs.penalty.active = false;
  rs.penalty.turnedDeg = 0;
  rs.penalty.rule = rule;
  rs.penalty.lastHeading = s.headingDeg;
}

// Generalized from the 2-boat prototype to N boats: every pair within the
// infringement radius during "racing" is checked; a foul on either member
// of a pair skips that pair (one foul at a time per boat, same rule as before).
export function stepRules(boats, races, wind, dt, seatIds = boats.map((_, index) => index)) {
  for (const rs of races) {
    if (rs.immunityTimer > 0) rs.immunityTimer -= dt;
    if (rs.collision && rs.collision.timer > 0) {
      rs.collision.timer = Math.max(0, rs.collision.timer - dt);
      rs.collision.active = rs.collision.timer > 0;
    }
  }
  for (let i = 0; i < boats.length; i++) {
    for (let j = i + 1; j < boats.length; j++) {
      const bi = boats[i], bj = boats[j];
      const ri = races[i], rj = races[j];
      if (!["prestart", "racing"].includes(ri.status) || !["prestart", "racing"].includes(rj.status)) continue;
      const separation = dist(bi.worldX, bi.worldY, bj.worldX, bj.worldY);
      if (separation >= INFRINGEMENT_RADIUS) continue;

      let giveWayIsI, rule;
      if (bi.tackLockoutTimer > 0 && bj.tackLockoutTimer <= 0) {
        giveWayIsI = true;
        rule = "Rule 13 — while tacking";
      } else if (bj.tackLockoutTimer > 0 && bi.tackLockoutTimer <= 0) {
        giveWayIsI = false;
        rule = "Rule 13 — while tacking";
      } else if (bi.tackSign !== bj.tackSign) {
        giveWayIsI = bi.tackSign < 0;
        rule = "Rule 10 — port/starboard";
      } else {
        const dx = bj.worldX - bi.worldX, dy = bj.worldY - bi.worldY;
        const headingR = bi.headingDeg * D2R;
        const aheadM = dx * Math.sin(headingR) + dy * -Math.cos(headingR);
        if (Math.abs(aheadM) > FINN_LENGTH_M * 0.55) {
          giveWayIsI = aheadM > 0;
          rule = "Rule 12 — clear astern/clear ahead";
        } else {
          const downwind = wrap360(wind.dir + 180) * D2R;
          const ux = Math.sin(downwind), uy = -Math.cos(downwind);
          const posI = bi.worldX * ux + bi.worldY * uy;
          const posJ = bj.worldX * ux + bj.worldY * uy;
          giveWayIsI = posI < posJ;
          rule = "Rule 11 — windward/leeward";
        }
      }

      if (separation < HULL_COLLISION_RADIUS_M) {
        const nx = separation > 0.001 ? (bj.worldX - bi.worldX) / separation : 1;
        const ny = separation > 0.001 ? (bj.worldY - bi.worldY) / separation : 0;
        const correction = (HULL_COLLISION_RADIUS_M - separation) / 2 + 0.02;
        bi.worldX -= nx * correction; bi.worldY -= ny * correction;
        bj.worldX += nx * correction; bj.worldY += ny * correction;
        bi.speedKnots = 0; bj.speedKnots = 0;
        ri.collision = { active: true, timer: COLLISION_STOP_SECONDS, withBoatIndex: seatIds[j] };
        rj.collision = { active: true, timer: COLLISION_STOP_SECONDS, withBoatIndex: seatIds[i] };
        ri.prevWorldX = bi.worldX; ri.prevWorldY = bi.worldY;
        rj.prevWorldX = bj.worldX; rj.prevWorldY = bj.worldY;
        rule += " · collision";
      }

      const giveWayBoat = giveWayIsI ? bi : bj;
      const giveWayRace = giveWayIsI ? ri : rj;
      if (ri.penalty.active || ri.penalty.pending || rj.penalty.active || rj.penalty.pending || giveWayRace.immunityTimer > 0) continue;
      startPenalty(giveWayBoat, giveWayRace, rule);
    }
  }

  for (let i = 0; i < boats.length; i++) {
    const rs = races[i];
    if (!rs.penalty.pending || rs.status !== "racing") continue;
    const clear = boats.every((other, j) => j === i || races[j].status === "disqualified" ||
      dist(boats[i].worldX, boats[i].worldY, other.worldX, other.worldY) >= PENALTY_CLEARANCE_M);
    if (!clear) continue;
    rs.penalty.pending = false;
    rs.penalty.active = true;
    rs.penalty.turnedDeg = 0;
    rs.penalty.lastHeading = boats[i].headingDeg;
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
