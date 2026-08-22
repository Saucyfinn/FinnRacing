import test from "node:test";
import assert from "node:assert/strict";

import { RaceRoom } from "../src/raceRoom.js";

function room() { return new RaceRoom({}, {}); }

test("host-configured AI opponents occupy real fleet seats", () => {
  const raceRoom = room();
  raceRoom.setAiCount(3);
  assert.equal(raceRoom.aiSeats.size, 3);
  assert.equal(raceRoom.connected.filter(Boolean).length, 3);
  for (const seat of raceRoom.aiSeats) {
    assert.match(raceRoom.names[seat], /^AI Finn /);
    assert.ok(raceRoom.boats[seat]);
    assert.ok(raceRoom.races[seat]);
  }

  raceRoom.setAiCount(1);
  assert.equal(raceRoom.aiSeats.size, 1);
  assert.equal(raceRoom.connected.filter(Boolean).length, 1);
});

test("AI starts on the signal and chooses an upwind tack", () => {
  const raceRoom = room();
  raceRoom.setAiCount(1);
  const [seat] = raceRoom.aiSeats;
  raceRoom.beginRace();
  raceRoom.raceClock = raceRoom.prestartSeconds - 7;
  raceRoom.steerAi(seat);
  assert.equal(raceRoom.boats[seat].targetHeadingDeg, 0);

  raceRoom.races[seat].status = "racing";
  raceRoom.races[seat].leg = 1;
  raceRoom.boats[seat].worldX = 20;
  raceRoom.steerAi(seat);
  assert.equal(raceRoom.boats[seat].targetHeadingDeg, 320);
});
