import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_BOAT_SETUP, normalizeBoatSetup, analyzerRigTarget,
  boatSetupPerformance, freshBoatState, stepBoatKinematics
} from "../src/physics.js";
import {
  normalizeBoatSetup as normalizeClientSetup,
  analyzerRigTarget as clientRigTarget,
  boatSetupPerformance as clientSetupPerformance
} from "../public/physics-client.js";

test("missing and invalid setup values are safely normalized", () => {
  assert.deepEqual(normalizeBoatSetup({ skipperWeightKg: null }), DEFAULT_BOAT_SETUP);
  assert.deepEqual(normalizeBoatSetup({
    skipperWeightKg: 200, sailChoice: "unknown", mastPositionMm: 5, rigTensionKg: 90
  }), { skipperWeightKg: 120, sailChoice: "GS1", mastPositionMm: 35, rigTensionKg: 40 });
});

test("Analyzer rig targets interpolate through its wind bands", () => {
  assert.deepEqual(analyzerRigTarget(5), { mastPositionMm: 43, rigTensionKg: 34.7 });
  assert.deepEqual(analyzerRigTarget(11.5), { mastPositionMm: 53, rigTensionKg: 35.2 });
  assert.deepEqual(analyzerRigTarget(25), { mastPositionMm: 56, rigTensionKg: 34.6 });
});

test("GS1 plus favours light pressure and GS1 minus favours heavy pressure", () => {
  const common = { skipperWeightKg: 95, mastPositionMm: 53, rigTensionKg: 35 };
  assert.ok(boatSetupPerformance({ ...common, sailChoice: "GS1+" }, 7).speedMultiplier
    > boatSetupPerformance({ ...common, sailChoice: "GS1-" }, 7).speedMultiplier);
  assert.ok(boatSetupPerformance({ ...common, sailChoice: "GS1-" }, 18).speedMultiplier
    > boatSetupPerformance({ ...common, sailChoice: "GS1+" }, 18).speedMultiplier);
});

test("effective wind changes the active setup target and performance", () => {
  const setup = { skipperWeightKg: 95, sailChoice: "GS1", mastPositionMm: 56, rigTensionKg: 35 };
  const clean = boatSetupPerformance(setup, 18), dirty = boatSetupPerformance(setup, 9);
  assert.notEqual(clean.targetMastPositionMm, dirty.targetMastPositionMm);
  assert.notEqual(clean.speedMultiplier, dirty.speedMultiplier);
});

test("setup affects authoritative kinematics", () => {
  const light = { skipperWeightKg: 85, sailChoice: "GS1+", mastPositionMm: 46, rigTensionKg: 35 };
  const heavy = { skipperWeightKg: 110, sailChoice: "GS1-", mastPositionMm: 46, rigTensionKg: 35 };
  const a = freshBoatState(45, light), b = freshBoatState(45, heavy);
  stepBoatKinematics(a, { dir: 0, speed: 7 }, 1);
  stepBoatKinematics(b, { dir: 0, speed: 7 }, 1);
  assert.ok(a.speedKnots > b.speedKnots);
});

test("browser and server setup calculations remain identical", () => {
  const samples = [
    [{}, 5],
    [{ skipperWeightKg: 78, sailChoice: "GS1+", mastPositionMm: 42, rigTensionKg: 33.5 }, 8],
    [{ skipperWeightKg: 115, sailChoice: "GS1-", mastPositionMm: 56, rigTensionKg: 38 }, 20],
    [{ skipperWeightKg: 95, sailChoice: "WB", mastPositionMm: 50, rigTensionKg: 35 }, 12]
  ];
  for (const [setup, wind] of samples) {
    assert.deepEqual(normalizeBoatSetup(setup), normalizeClientSetup(setup));
    assert.deepEqual(analyzerRigTarget(wind), clientRigTarget(wind));
    assert.deepEqual(boatSetupPerformance(setup, wind), clientSetupPerformance(setup, wind));
  }
});
