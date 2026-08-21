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

export const NO_GO_HALF = 40;
export const TACK_LOCKOUT_SEC = 2.0;
export const ACCEL_KT_PER_SEC = 1.4;
export const TURN_RATE_MAX = 32;
export const TURN_RATE_MIN = 11;
export const TRIM_MAX_ERROR = 25;
export const STERNWAY_DRIFT_FACTOR = 0.06;
export const MPS_PER_KNOT = 0.5144;
export const PX_PER_METER = 6.5;

export const PIN_X = -20, BOAT_END_X = 20, START_Y = 0;
export const WINDWARD_MARK = { x: 0, y: -150 };
export const PRESTART_SECONDS = 20;

export function dist(ax, ay, bx, by) { return Math.hypot(ax - bx, ay - by); }
export function bearingTo(fromX, fromY, toX, toY) {
  return wrap360(Math.atan2(toX - fromX, -(toY - fromY)) / D2R);
}
export function currentMarkFor(leg) {
  return leg === 1 ? WINDWARD_MARK : { x: (PIN_X + BOAT_END_X) / 2, y: START_Y };
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

export function freshBoatState(headingDeg) {
  return {
    headingDeg, targetHeadingDeg: headingDeg, speedKnots: 0,
    trimAngleDeg: 30, trimEfficiency01: 1, autoTrim: true,
    tackSign: 1, tackLockoutTimer: 0,
    worldX: 0, worldY: 0
  };
}
