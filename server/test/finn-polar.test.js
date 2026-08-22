import test from "node:test";
import assert from "node:assert/strict";

import {
  FINN_CLOSE_HAULED_MAX_KNOTS,
  freshBoatState,
  polarSpeed,
  stepBoatKinematics
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
