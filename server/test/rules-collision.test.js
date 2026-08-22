import test from "node:test";
import assert from "node:assert/strict";

import { applyPenaltyOverride, freshBoatState, freshRaceState, HULL_COLLISION_RADIUS_M, PENALTY_CLEARANCE_M, startPenalty, stepRules, updatePenaltyProgress } from "../src/physics.js";

test("a collision stops and separates both boats and penalizes port tack", () => {
  const port = freshBoatState(40), starboard = freshBoatState(320);
  port.tackSign = -1; starboard.tackSign = 1;
  port.worldX = 0; port.worldY = 0; port.speedKnots = 5;
  starboard.worldX = 2; starboard.worldY = 0; starboard.speedKnots = 5;
  const portRace = freshRaceState(), starboardRace = freshRaceState();
  portRace.status = "racing"; starboardRace.status = "racing";

  stepRules([port, starboard], [portRace, starboardRace], { dir: 0, speed: 12 }, 0.1, [3, 5]);

  assert.equal(port.speedKnots, 0);
  assert.equal(starboard.speedKnots, 0);
  assert.ok(Math.hypot(port.worldX - starboard.worldX, port.worldY - starboard.worldY) >= HULL_COLLISION_RADIUS_M);
  assert.equal(portRace.collision.active, true);
  assert.equal(starboardRace.collision.active, true);
  assert.equal(portRace.collision.withBoatIndex, 5);
  assert.equal(starboardRace.collision.withBoatIndex, 3);
  assert.equal(portRace.penalty.pending, true);
  assert.equal(portRace.penalty.active, false);
  assert.match(portRace.penalty.rule, /Rule 10.*collision/);
  assert.equal(starboardRace.penalty.active, false);
});

test("a close windward boat receives Rule 11 without a collision stop", () => {
  const leeward = freshBoatState(40), windward = freshBoatState(40);
  leeward.tackSign = 1; windward.tackSign = 1;
  leeward.worldX = 0; leeward.worldY = 0;
  windward.worldX = -3.5; windward.worldY = -2.94;
  leeward.speedKnots = 4; windward.speedKnots = 4;
  const leewardRace = freshRaceState(), windwardRace = freshRaceState();
  leewardRace.status = "racing"; windwardRace.status = "racing";

  stepRules([leeward, windward], [leewardRace, windwardRace], { dir: 0, speed: 12 }, 0.1);

  assert.equal(windwardRace.penalty.pending, true);
  assert.match(windwardRace.penalty.rule, /Rule 11/);
  assert.equal(leeward.speedKnots, 4);
  assert.equal(windward.speedKnots, 4);
});

test("a clear-astern boat receives Rule 12 during prestart", () => {
  const astern = freshBoatState(90), ahead = freshBoatState(90);
  astern.worldX = 0; ahead.worldX = 4.6;
  const asternRace = freshRaceState(), aheadRace = freshRaceState();
  stepRules([astern, ahead], [asternRace, aheadRace], { dir: 0, speed: 12 }, 0.1);
  assert.equal(asternRace.penalty.pending, true);
  assert.equal(asternRace.penalty.active, false);
  assert.match(asternRace.penalty.rule, /Rule 12/);
});

test("a boat while tacking receives Rule 13", () => {
  const tacking = freshBoatState(45), steady = freshBoatState(45);
  tacking.worldX = 0; steady.worldX = 4.6;
  tacking.tackLockoutTimer = 1;
  const tackingRace = freshRaceState(), steadyRace = freshRaceState();
  stepRules([tacking, steady], [tackingRace, steadyRace], { dir: 0, speed: 12 }, 0.1);
  assert.equal(tackingRace.penalty.pending, true);
  assert.match(tackingRace.penalty.rule, /Rule 13/);
});

test("a queued penalty starts only after the start and clear of every boat", () => {
  const penalized = freshBoatState(90), other = freshBoatState(90);
  const penalizedRace = freshRaceState(), otherRace = freshRaceState();
  startPenalty(penalized, penalizedRace, "Rule 12");

  other.worldX = PENALTY_CLEARANCE_M + 1;
  stepRules([penalized, other], [penalizedRace, otherRace], { dir: 0, speed: 12 }, 0.1);
  assert.equal(penalizedRace.penalty.pending, true, "prestart penalty stays queued even when clear");
  assert.equal(penalizedRace.penalty.active, false);

  penalizedRace.status = "racing";
  otherRace.status = "racing";
  other.worldX = PENALTY_CLEARANCE_M - 1;
  stepRules([penalized, other], [penalizedRace, otherRace], { dir: 0, speed: 12 }, 0.1);
  assert.equal(penalizedRace.penalty.pending, true, "penalty stays queued near another boat");

  other.worldX = PENALTY_CLEARANCE_M + 1;
  stepRules([penalized, other], [penalizedRace, otherRace], { dir: 0, speed: 12 }, 0.1);
  assert.equal(penalizedRace.penalty.pending, false);
  assert.equal(penalizedRace.penalty.active, true);
});

test("a second penalty disqualifies and stops the boat", () => {
  const boat = freshBoatState(45), race = freshRaceState();
  boat.speedKnots = 5;
  startPenalty(boat, race, "Rule 10");
  race.penalty.pending = false;
  race.penalty.active = false;
  startPenalty(boat, race, "Rule 11");

  assert.equal(race.penalty.count, 2);
  assert.equal(race.status, "disqualified");
  assert.equal(race.penalty.active, false);
  assert.equal(race.penalty.pending, false);
  assert.equal(boat.speedKnots, 0);
});

test("auto penalty can be disabled and a completed turn clears its rule", () => {
  const boat = freshBoatState(45), race = freshRaceState();
  race.status = "racing";
  startPenalty(boat, race, "Rule 10 — port/starboard");
  race.penalty.pending = false;
  race.penalty.active = true;

  race.penalty.autoComplete = false;
  boat.targetHeadingDeg = 90;
  applyPenaltyOverride(boat, race);
  assert.equal(boat.targetHeadingDeg, 90, "manual mode preserves helm control");

  race.penalty.turnedDeg = 359;
  race.penalty.lastHeading = 40;
  boat.headingDeg = 45;
  updatePenaltyProgress(boat, race, 0.1);
  assert.equal(race.penalty.active, false);
  assert.equal(race.penalty.turnedDeg, 0);
  assert.equal(race.penalty.rule, null);
});
