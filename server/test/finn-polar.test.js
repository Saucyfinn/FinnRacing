import test from "node:test";
import assert from "node:assert/strict";

import {
  FINN_CLOSE_HAULED_MAX_KNOTS,
  BY_THE_LEE_MAX_DEG,
  FINN_BOOM_OUTER_POINT_M,
  FINN_LENGTH_M,
  FINN_BEAM_M,
  groundMotionFor,
  freshBoatState,
  freshRaceState,
  polarSpeed,
  idealTrimAngle,
  stepBoatKinematics,
  stepRace,
  startLineForBoatCount,
  leewardGateForStartLine, seaStateFor
} from "../src/physics.js";
import {
  BY_THE_LEE_MAX_DEG as CLIENT_BY_THE_LEE_MAX_DEG,
  FINN_BOOM_OUTER_POINT_M as CLIENT_FINN_BOOM_OUTER_POINT_M,
  FINN_LENGTH_M as CLIENT_FINN_LENGTH_M,
  FINN_BEAM_M as CLIENT_FINN_BEAM_M,
  groundMotionFor as clientGroundMotionFor,
  idealTrimAngle as clientIdealTrimAngle,
  tackSignForTwa as clientTackSignForTwa,
  leewardGateForStartLine as clientLeewardGateForStartLine,
  currentMarkFor as clientCurrentMarkFor
} from "../public/physics-client.js";
import { localToLatLon, latLonToLocal } from "../public/geo.js";

test("default line and course geometry match the sailing instructions", () => {
  assert.equal(FINN_LENGTH_M, 4.5);
  assert.equal(FINN_BEAM_M, 1.51);
  assert.equal(CLIENT_FINN_LENGTH_M, FINN_LENGTH_M);
  assert.equal(CLIENT_FINN_BEAM_M, FINN_BEAM_M);
  assert.equal(startLineForBoatCount(0).lengthM, 20);
  assert.equal(startLineForBoatCount(2).lengthM, 20);
  assert.equal(startLineForBoatCount(4).lengthM, 27);
  assert.equal(startLineForBoatCount(6).lengthM, 40.5);
  const fourBoatLine = startLineForBoatCount(4);
  const gate = leewardGateForStartLine(fourBoatLine);
  assert.deepEqual(gate, { portX: -7.5, starboardX: 7.5, y: -100 });
  assert.deepEqual(clientLeewardGateForStartLine(fourBoatLine), gate);
  assert.deepEqual(clientCurrentMarkFor(4, { x: 0, y: -1852 }, fourBoatLine), { x: 0, y: -100 });
  assert.deepEqual(clientCurrentMarkFor(5, { x: 0, y: -1852 }, fourBoatLine), { x: 0, y: 0 });
  assert.deepEqual(leewardGateForStartLine(fourBoatLine, { offsetM: -175, widthM: 30, centerX: 40 }), { portX: 25, starboardX: 55, y: -175 });
});

test("draggable map marks round-trip between GPS and course coordinates", () => {
  const venue = { lat: -43.6198028, lon: 172.7193694, bearingDeg: 75 };
  for (const mark of [{ x: 0, y: -1852 }, { x: -7.5, y: -100 }, { x: 47.5, y: -175 }]) {
    const gps = localToLatLon(mark.x, mark.y, venue);
    const local = latLonToLocal(gps.lat, gps.lon, venue);
    assert.ok(Math.abs(local.x - mark.x) < 0.000001);
    assert.ok(Math.abs(local.y - mark.y) < 0.000001);
  }
});

test("Finn polar is capped at 5.4 knots at 40 degrees", () => {
  for (const windSpeed of [5, 8, 10, 12, 15, 18, 20, 25, 30]) {
    assert.ok(polarSpeed(40, windSpeed) <= FINN_CLOSE_HAULED_MAX_KNOTS);
  }
  assert.equal(polarSpeed(40, 25), FINN_CLOSE_HAULED_MAX_KNOTS);
});

test("boom trim follows point of sail and reaches 90 degrees dead downwind", () => {
  assert.equal(FINN_BOOM_OUTER_POINT_M, 3.23);
  assert.equal(CLIENT_FINN_BOOM_OUTER_POINT_M, FINN_BOOM_OUTER_POINT_M);
  assert.equal(idealTrimAngle(40), 10);
  assert.equal(idealTrimAngle(90), 40);
  assert.equal(idealTrimAngle(180), 90);
  assert.equal(clientIdealTrimAngle(40), idealTrimAngle(40));
  assert.equal(clientIdealTrimAngle(90), idealTrimAngle(90));
  assert.equal(clientIdealTrimAngle(180), idealTrimAngle(180));

  const boat = freshBoatState(180);
  stepBoatKinematics(boat, { dir: 0, speed: 10 }, 0.1);
  assert.equal(boat.trimAngleDeg, 90);
});

test("boat can sail 20 degrees by the lee before gybing", () => {
  assert.equal(BY_THE_LEE_MAX_DEG, 20);
  assert.equal(CLIENT_BY_THE_LEE_MAX_DEG, BY_THE_LEE_MAX_DEG);
  assert.equal(clientTackSignForTwa(-170, 1), 1);
  assert.equal(clientTackSignForTwa(-159, 1), -1);
  assert.ok(polarSpeed(165, 10) > polarSpeed(180, 10));

  const boat = freshBoatState(170);
  boat.tackSign = 1;
  stepBoatKinematics(boat, { dir: 0, speed: 10 }, 0.1);
  assert.equal(boat.tackSign, 1, "10 degrees by the lee retains the existing tack");

  boat.headingDeg = 159;
  boat.targetHeadingDeg = 159;
  boat.tackLockoutTimer = 0;
  stepBoatKinematics(boat, { dir: 0, speed: 10 }, 0.1);
  assert.equal(boat.tackSign, -1, "more than 20 degrees by the lee completes the gybe");
});

test("waves add a small by-the-lee speed benefit", () => {
  const waves = freshBoatState(170);
  waves.tackSign = 1;
  const waveState = stepBoatKinematics(
    waves,
    { dir: 0, speed: 16 },
    0.1,
    { speedKnots: 0.4, directionDeg: 180 }
  ).seaState;
  assert.equal(waveState.byTheLee, true);
  assert.ok(waveState.byTheLeeBoostKnots > 0);
  assert.ok(waveState.byTheLeeBoostKnots < 0.25, "the wave benefit remains modest");

  const flat = freshBoatState(170);
  flat.tackSign = 1;
  const flatState = stepBoatKinematics(flat, { dir: 0, speed: 5 }, 0.1).seaState;
  assert.equal(flatState.byTheLeeBoostKnots, 0);
});

test("optimized boat setup cannot exceed the 40-degree hull-speed cap", () => {
  const boat = freshBoatState(320);
  boat.speedKnots = 8;
  boat.setup = {
    skipperWeightKg: 120,
    sailChoice: "GS1+",
    mastPositionMm: 56,
    rigTensionKg: 34.6
  };

  stepBoatKinematics(boat, { dir: 0, speed: 25 }, 1);
  assert.equal(boat.speedKnots, FINN_CLOSE_HAULED_MAX_KNOTS);
});

test("tidal current changes ground track without changing speed through water", () => {
  const stillWater = freshBoatState(90);
  const tide = freshBoatState(90);
  stepBoatKinematics(stillWater, { dir: 0, speed: 12 }, 1);
  stepBoatKinematics(tide, { dir: 0, speed: 12 }, 1, { speedKnots: 2, directionDeg: 90 });

  assert.equal(tide.speedKnots, stillWater.speedKnots);
  assert.ok(Math.abs((tide.worldX - stillWater.worldX) - 2 * 0.5144) < 1e-9);
  assert.ok(Math.abs(tide.worldY - stillWater.worldY) < 1e-9);
});

test("speed and course over ground combine boat motion with tidal current", () => {
  const ground = groundMotionFor(0, 5, { speedKnots: 2, directionDeg: 90 });
  assert.ok(Math.abs(ground.speedOverGroundKnots - Math.hypot(5, 2)) < 0.000001);
  assert.ok(Math.abs(ground.courseOverGroundDeg - 21.801409486) < 0.000001);
  assert.deepEqual(clientGroundMotionFor(0, 5, { speedKnots: 2, directionDeg: 90 }), ground);

  const stopped = groundMotionFor(0, 0, { speedKnots: 0, directionDeg: 0 });
  assert.equal(stopped.speedOverGroundKnots, 0);
  assert.equal(stopped.courseOverGroundDeg, null);
});

test("wind against tide creates more chop than a following tide", () => {
  const wind = { dir: 0, speed: 16 };
  const against = seaStateFor(wind, { speedKnots: 2, directionDeg: 0 });
  const following = seaStateFor(wind, { speedKnots: 2, directionDeg: 180 });
  assert.ok(against.chop01 > following.chop01 + 0.5);
  assert.equal(against.label, "STEEP CHOP");
});

test("chop slows an upwind Finn and waves produce downwind surfing bursts", () => {
  const wind = { dir: 0, speed: 16 };
  const flat = freshBoatState(40), choppy = freshBoatState(40);
  for (let i = 0; i < 200; i++) {
    stepBoatKinematics(flat, wind, 0.1, { speedKnots: 0, directionDeg: 0 });
    stepBoatKinematics(choppy, wind, 0.1, { speedKnots: 2, directionDeg: 0 });
  }
  assert.ok(choppy.speedKnots < flat.speedKnots - 0.25);

  const downwind = freshBoatState(180);
  let maxSurfBoost = 0;
  for (let i = 0; i < 300; i++) {
    const state = stepBoatKinematics(downwind, wind, 0.1, { speedKnots: 0.4, directionDeg: 180 }).seaState;
    maxSurfBoost = Math.max(maxSurfBoost, state.surfBoostKnots);
  }
  assert.ok(maxSurfBoost >= 0.5);
});

test("custom start sequence controls when a line crossing starts the race", () => {
  const boat = freshBoatState(0);
  const race = freshRaceState();
  boat.worldX = 0; boat.worldY = -1;
  race.prevWorldX = 0; race.prevWorldY = 1;
  stepRace(boat, race, 59, 0, undefined, 60);
  assert.equal(race.status, "prestart");

  race.prevWorldY = 1;
  stepRace(boat, race, 60, 0, undefined, 60);
  assert.equal(race.status, "racing");
});

test("downwind return crossing completes the race", () => {
  const boat = freshBoatState(180);
  const race = freshRaceState();
  race.status = "racing"; race.leg = 5;
  race.prevWorldX = 0; race.prevWorldY = -1;
  boat.worldX = 0; boat.worldY = 1;
  stepRace(boat, race, 200, 0, undefined, 60, { x: 0, y: -250 });
  assert.equal(race.status, "finished");
  assert.equal(race.finishTime, 140);
});

test("default course completes two windward leewards before finishing at the line", () => {
  const boat = freshBoatState(180);
  const race = freshRaceState();
  race.status = "racing";
  const mark = { x: 0, y: -1852 };

  boat.worldX = 0; boat.worldY = mark.y;
  stepRace(boat, race, 100, 0, undefined, 60, mark);
  assert.equal(race.leg, 2);

  race.prevWorldX = 0; race.prevWorldY = -101;
  boat.worldY = -99;
  stepRace(boat, race, 900, 0, undefined, 60, mark);
  assert.equal(race.leg, 3);

  boat.worldY = mark.y;
  stepRace(boat, race, 1800, 0, undefined, 60, mark);
  assert.equal(race.leg, 4);

  race.prevWorldY = -101; boat.worldY = -99;
  stepRace(boat, race, 2500, 0, undefined, 60, mark);
  assert.equal(race.leg, 5);

  race.prevWorldY = -1; boat.worldY = 1;
  stepRace(boat, race, 2600, 0, undefined, 60, mark);
  assert.equal(race.status, "finished");
});
