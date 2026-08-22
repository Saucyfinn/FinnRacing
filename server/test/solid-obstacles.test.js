import test from "node:test";
import assert from "node:assert/strict";

import { LandCollisionMap } from "../src/landCollision.js";
import { RaceRoom } from "../src/raceRoom.js";
import { freshBoatState, freshRaceState } from "../src/physics.js";

test("land polygons distinguish land, water, and polygon holes", () => {
  const map = new LandCollisionMap([[
    [[172.70, -43.65], [172.75, -43.65], [172.75, -43.60], [172.70, -43.60], [172.70, -43.65]],
    [[172.72, -43.63], [172.73, -43.63], [172.73, -43.62], [172.72, -43.62], [172.72, -43.63]]
  ]]);
  assert.equal(map.isLand(-43.64, 172.71), true);
  assert.equal(map.isLand(-43.625, 172.725), false, "water hole remains navigable");
  assert.equal(map.isLand(-43.68, 172.71), false);
});

test("hitting a course mark restores the last water position and stops the boat", () => {
  const room = new RaceRoom({}, {});
  const boat = freshBoatState(0), race = freshRaceState();
  boat.worldX = room.windwardMark.x; boat.worldY = room.windwardMark.y; boat.speedKnots = 5;
  room.stopAtSolidObstacle(boat, race, 10, -1800, 0.1);
  assert.deepEqual([boat.worldX, boat.worldY, boat.speedKnots], [10, -1800, 0]);
  assert.deepEqual(race.obstacle, { active: true, type: "MARK", timer: 0.8 });
});

test("hitting mapped land restores the last water position and stops the boat", () => {
  const room = new RaceRoom({}, {});
  room.landCollisionMap = { isLand: () => true };
  const boat = freshBoatState(0), race = freshRaceState();
  room.boats[0] = boat;
  boat.worldX = 300; boat.worldY = 300; boat.speedKnots = 4;
  room.stopAtSolidObstacle(boat, race, 299, 299, 0.1);
  assert.deepEqual([boat.worldX, boat.worldY, boat.speedKnots], [299, 299, 0]);
  assert.equal(race.obstacle.type, "LAND");
  assert.equal(room.activeHails.get(0).call, "BUGGER");
});
