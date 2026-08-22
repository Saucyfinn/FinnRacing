import test from "node:test";
import assert from "node:assert/strict";

import {
  FINN_CLOSE_HAULED_MAX_KNOTS,
  FINN_LENGTH_M,
  FINN_BEAM_M,
  freshBoatState,
  freshRaceState,
  polarSpeed,
  stepBoatKinematics,
  stepRace,
  startLineForBoatCount,
  leewardGateForStartLine
} from "../src/physics.js";
import {
  FINN_LENGTH_M as CLIENT_FINN_LENGTH_M,
  FINN_BEAM_M as CLIENT_FINN_BEAM_M,
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
