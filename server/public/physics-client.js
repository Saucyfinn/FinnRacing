// Client-side copy of the server's boat-kinematics formulas (server/src/physics.js).
// Used only for *local prediction* of the player's own boat between network
// snapshots, so steering feels instant. The server is still authoritative —
// see reconcile() in client.js. Keep this in sync with physics.js by hand;
// it's small and stable (polar table, no-go blend, turn-rate curve).

export const D2R = Math.PI / 180;
export function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
export function lerp(a, b, t) { return a + (b - a) * t; }
export function wrap360(a) { a = a % 360; if (a < 0) a += 360; return a; }
export function wrap180(a) { return wrap360(a + 180) - 180; }

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

export const NO_GO_HALF = 40;
export const TACK_LOCKOUT_SEC = 2.0;
export const ACCEL_KT_PER_SEC = 1.4;
export const TURN_RATE_MAX = 32;
export const TURN_RATE_MIN = 11;
export const TRIM_MAX_ERROR = 25;
export const STERNWAY_DRIFT_FACTOR = 0.06;
export const MPS_PER_KNOT = 0.5144;
export const PX_PER_METER = 6.5;

export const SAIL_CHOICES = Object.freeze(["GS1-", "GS1", "GS1+", "WB"]);
export const DEFAULT_BOAT_SETUP = Object.freeze({ skipperWeightKg: 95, sailChoice: "GS1", mastPositionMm: 50, rigTensionKg: 35 });
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
    if (w >= ANALYZER_RIG_TARGETS[i].windKnots && w <= ANALYZER_RIG_TARGETS[i + 1].windKnots) { lo = ANALYZER_RIG_TARGETS[i]; hi = ANALYZER_RIG_TARGETS[i + 1]; break; }
  }
  const t = (w - lo.windKnots) / (hi.windKnots - lo.windKnots);
  return { mastPositionMm: lerp(lo.mastPositionMm, hi.mastPositionMm, t), rigTensionKg: lerp(lo.rigTensionKg, hi.rigTensionKg, t) };
}
export function boatSetupPerformance(setupValue, twsKnots) {
  const setup = normalizeBoatSetup(setupValue), target = analyzerRigTarget(twsKnots);
  const mastError01 = clamp(Math.abs(setup.mastPositionMm - target.mastPositionMm) / 13, 0, 1);
  const tensionError01 = clamp(Math.abs(setup.rigTensionKg - target.rigTensionKg) / 5, 0, 1);
  const rigMatch01 = clamp(1 - mastError01 * 0.62 - tensionError01 * 0.38, 0, 1);
  const profile = SAIL_PROFILES[setup.sailChoice];
  const lightToHeavy = clamp((twsKnots - 12) / 7, -1, 1);
  const sailEffect = -profile.powerBias * lightToHeavy + profile.controlBias * Math.max(0, lightToHeavy) + profile.baseSpeed;
  const weight01 = clamp((setup.skipperWeightKg - 95) / 25, -1, 1);
  const weightEffect = weight01 * lightToHeavy * 0.025;
  const rigPenalty = mastError01 * 0.045 + tensionError01 * 0.035;
  return {
    speedMultiplier: clamp(1 + sailEffect + weightEffect - rigPenalty, 0.88, 1.07),
    accelerationMultiplier: clamp(1 - weight01 * 0.035 - (1 - rigMatch01) * 0.10, 0.86, 1.06),
    pointingPenaltyDeg: clamp(profile.pointingPenaltyDeg + mastError01 * 1.4 + tensionError01 * 1.0, 0, 3),
    rigMatch01, targetMastPositionMm: target.mastPositionMm, targetRigTensionKg: target.rigTensionKg
  };
}

export const PIN_X = -10, BOAT_END_X = 10, START_Y = 0;
export const WINDWARD_MARK = { x: 0, y: -1852 };
export const LEEWARD_GATE_OFFSET_M = -5;
export const LEEWARD_GATE_WIDTH_M = 20;
export const PRESTART_SECONDS = 180;

export function dist(ax, ay, bx, by) { return Math.hypot(ax - bx, ay - by); }
export function bearingTo(fromX, fromY, toX, toY) {
  return wrap360(Math.atan2(toX - fromX, -(toY - fromY)) / D2R);
}
export function leewardGateForStartLine(startLine) {
  const centreX = (startLine.pinX + startLine.boatEndX) / 2;
  return { portX: centreX - LEEWARD_GATE_WIDTH_M / 2, starboardX: centreX + LEEWARD_GATE_WIDTH_M / 2, y: startLine.y + LEEWARD_GATE_OFFSET_M };
}
export function currentMarkFor(leg, windwardMark = WINDWARD_MARK, startLine = { pinX: PIN_X, boatEndX: BOAT_END_X, y: START_Y }) {
  if (leg === 1 || leg === 3) return windwardMark;
  if (leg === 2 || leg === 4) {
    const gate = leewardGateForStartLine(startLine);
    return { x: (gate.portX + gate.starboardX) / 2, y: gate.y };
  }
  return { x: (startLine.pinX + startLine.boatEndX) / 2, y: startLine.y };
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

export function freshBoatState(headingDeg, setup = DEFAULT_BOAT_SETUP) {
  return {
    headingDeg, targetHeadingDeg: headingDeg, speedKnots: 0,
    trimAngleDeg: 30, trimEfficiency01: 1, autoTrim: true,
    tackSign: 1, tackLockoutTimer: 0,
    worldX: 0, worldY: 0,
    setup: normalizeBoatSetup(setup), setupEffect: boatSetupPerformance(setup, 10)
  };
}
