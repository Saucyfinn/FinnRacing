import test from "node:test";
import assert from "node:assert/strict";

import { interpolateSeries } from "../src/index.js";
import { RaceRoom } from "../src/raceRoom.js";
import { freshBoatState } from "../src/physics.js";

test("forecast interpolation follows the shortest path across north", () => {
  const hourly = {
    time: ["2026-08-22T00:00", "2026-08-22T01:00"],
    wind_speed_10m: [10, 14], wind_direction_10m: [350, 10]
  };
  const result = interpolateSeries(hourly, ["wind_speed_10m", "wind_direction_10m"], Date.parse("2026-08-22T00:30Z"));
  assert.equal(result.wind_speed_10m, 12);
  assert.equal(result.wind_direction_10m, 0);
});

test("race wind field is deterministic and varies smoothly by position", () => {
  const room = new RaceRoom({}, {});
  room.conditionModel = { source: "test", gustKnots: 20, seed: 12345 };
  room.raceModel = { ...room.conditionModel };
  room.wind.t = 30;
  const centre = { dir: 0, speed: 12 };
  const first = freshBoatState(0), second = freshBoatState(0);
  first.worldX = 0; first.worldY = 0;
  second.worldX = 20; second.worldY = 15;
  const a = room.windForBoat(first, centre), repeat = room.windForBoat(first, centre), b = room.windForBoat(second, centre);
  assert.deepEqual(a, repeat);
  assert.notDeepEqual(a, b);
  const directionDifference = Math.abs(((a.dir - b.dir + 540) % 360) - 180);
  assert.ok(directionDifference < 15);
  assert.ok(Math.abs(a.speed - b.speed) < 8);
});
