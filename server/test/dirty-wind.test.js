import test from "node:test";
import assert from "node:assert/strict";
import { dirtyWindFromBoat, freshBoatState, stepFleetDirtyWind } from "../src/physics.js";

function boat(x, y, heading = 320, tackSign = 1) {
  const b = freshBoatState(heading);
  b.worldX = x; b.worldY = y; b.tackSign = tackSign;
  return b;
}

test("a boat directly downstream is in the direct wake", () => {
  const effect = dirtyWindFromBoat(boat(0, 10), boat(0, 0), { dir: 0, speed: 12 });
  assert.equal(effect.type, "directWake");
  assert.ok(effect.exposure01 > 0.4);
});

test("a boat outside the wake is clean", () => {
  const effect = dirtyWindFromBoat(boat(20, 10), boat(0, 0), { dir: 0, speed: 12 });
  assert.equal(effect.type, "clean");
  assert.equal(effect.exposure01, 0);
});

test("a same-tack windward boat astern is backwinded by a lee bow", () => {
  const source = boat(0, 0);
  const hr = source.headingDeg * Math.PI / 180;
  const forward = { x: Math.sin(hr), y: -Math.cos(hr) };
  const right = { x: Math.cos(hr), y: Math.sin(hr) };
  const target = boat(right.x * 2.5 - forward.x * 2, right.y * 2.5 - forward.y * 2);
  const effect = dirtyWindFromBoat(target, source, { dir: 0, speed: 12 });
  assert.equal(effect.type, "leeBow");
  assert.ok(effect.exposure01 > 0.7);
});

test("fleet smoothing produces a deficit and preserves the source seat", () => {
  const boats = [boat(0, 10), boat(0, 0)];
  stepFleetDirtyWind(boats, { dir: 0, speed: 12 }, 1, [4, 9]);
  assert.equal(boats[0].dirtyWind.sourceBoatIndex, 9);
  assert.ok(boats[0].dirtyWind.effectiveSpeed < 12);
  assert.ok(boats[0].dirtyWind.exposure01 > 0);
});

test("release smoothing retains the interaction label until exposure clears", () => {
  const boats = [boat(0, 10), boat(0, 0)];
  stepFleetDirtyWind(boats, { dir: 0, speed: 12 }, 1, [4, 9]);
  const before = boats[0].dirtyWind.exposure01;
  boats[0].worldX = 30;
  stepFleetDirtyWind(boats, { dir: 0, speed: 12 }, 0.1, [4, 9]);
  assert.equal(boats[0].dirtyWind.type, "directWake");
  assert.equal(boats[0].dirtyWind.sourceBoatIndex, 9);
  assert.ok(boats[0].dirtyWind.exposure01 < before);
});
