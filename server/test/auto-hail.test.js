import test from "node:test";
import assert from "node:assert/strict";

import { RaceRoom } from "../src/raceRoom.js";
import { freshBoatState, freshRaceState } from "../src/physics.js";

function twoBoatRoom() {
  const room = new RaceRoom({}, {});
  room.boats = [freshBoatState(90), freshBoatState(270)];
  room.races = [freshRaceState(), freshRaceState()];
  room.connected = [true, true];
  return room;
}

test("an approaching starboard boat hails port", () => {
  const room = twoBoatRoom();
  room.boats[0].worldX = -10; room.boats[0].speedKnots = 5; room.boats[0].tackSign = 1;
  room.boats[1].worldX = 10; room.boats[1].speedKnots = 5; room.boats[1].tackSign = -1;
  room.updateAutoHails([0, 1], { dir: 0, speed: 12 });
  assert.equal(room.activeHails.get(0).call, "STARBOARD");
  assert.equal(room.activeHails.get(0).toBoatIndex, 1);
});

test("the entitled inside boat hails for room in the three-length zone", () => {
  const room = twoBoatRoom();
  room.races[0].status = "racing"; room.races[1].status = "racing";
  room.boats[0].worldY = room.windwardMark.y + 5;
  room.boats[1].worldY = room.windwardMark.y + 9;
  room.boats[0].worldX = 0; room.boats[1].worldX = 2;
  room.updateAutoHails([0, 1], { dir: 0, speed: 12 });
  assert.equal(room.activeHails.get(0).call, "ROOM");
});

test("a leeward boat luffing a windward boat hails up", () => {
  const room = twoBoatRoom();
  room.boats[0].headingDeg = 45; room.boats[0].targetHeadingDeg = 20; room.boats[0].tackSign = 1;
  room.boats[1].headingDeg = 45; room.boats[1].targetHeadingDeg = 45; room.boats[1].tackSign = 1;
  room.boats[0].worldY = 0; room.boats[1].worldY = -5;
  room.updateAutoHails([0, 1], { dir: 0, speed: 12 });
  assert.equal(room.activeHails.get(0).call, "UP");
});
