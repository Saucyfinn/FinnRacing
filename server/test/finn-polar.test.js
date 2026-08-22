import test from "node:test";
import assert from "node:assert/strict";

import {
  FINN_CLOSE_HAULED_MAX_KNOTS,
  freshBoatState,
  freshRaceState,
  polarSpeed,
  stepBoatKinematics,
  stepRace
} from "../src/physics.js";

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
  race.status = "racing"; race.leg = 4;
  race.prevWorldX = 0; race.prevWorldY = -1;
  boat.worldX = 0; boat.worldY = 1;
  stepRace(boat, race, 200, 0, undefined, 60, { x: 0, y: -250 });
  assert.equal(race.status, "finished");
  assert.equal(race.finishTime, 140);
});

test("default course requires gate and two windward legs before the downwind finish", () => {
  const boat = freshBoatState(180);
  const race = freshRaceState();
  race.status = "racing";
  const mark = { x: 0, y: -1852 };

  boat.worldX = 0; boat.worldY = mark.y;
  stepRace(boat, race, 100, 0, undefined, 60, mark);
  assert.equal(race.leg, 2);

  race.prevWorldX = 0; race.prevWorldY = 99;
  boat.worldY = 101;
  stepRace(boat, race, 900, 0, undefined, 60, mark);
  assert.equal(race.leg, 3);

  boat.worldY = mark.y;
  stepRace(boat, race, 1800, 0, undefined, 60, mark);
  assert.equal(race.leg, 4);

  race.prevWorldY = -1; boat.worldY = 1;
  stepRace(boat, race, 2600, 0, undefined, 60, mark);
  assert.equal(race.status, "finished");
});
