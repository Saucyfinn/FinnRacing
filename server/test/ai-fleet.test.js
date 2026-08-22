import test from "node:test";
import assert from "node:assert/strict";

import { RaceRoom } from "../src/raceRoom.js";
import { stepBoatKinematics, stepRace } from "../src/physics.js";

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
  const startRelativeWind = Math.abs(((raceRoom.boats[seat].targetHeadingDeg - raceRoom.currentWind().dir + 540) % 360) - 180);
  assert.ok(startRelativeWind >= 38 && startRelativeWind <= 46);

  raceRoom.races[seat].status = "racing";
  raceRoom.races[seat].leg = 1;
  raceRoom.boats[seat].worldX = 20;
  raceRoom.steerAi(seat);
  const tackRelativeWind = ((raceRoom.boats[seat].targetHeadingDeg - raceRoom.currentWind().dir + 540) % 360) - 180;
  assert.ok(tackRelativeWind <= -38 && tackRelativeWind >= -46);
});

test("AI remains on the course, rounds the mark, and finishes", () => {
  const raceRoom = room();
  raceRoom.prestartSeconds = 30;
  raceRoom.setAiCount(1);
  raceRoom.beginRace();
  const [seat] = raceRoom.aiSeats;
  let maximumDistance = 0;
  for (let tick = 0; tick < 9000 && raceRoom.races[seat].status !== "finished"; tick++) {
    raceRoom.raceClock = tick * 0.1;
    raceRoom.roomStatus = raceRoom.raceClock < raceRoom.prestartSeconds ? "prestart" : "racing";
    raceRoom.steerAi(seat);
    const wind = raceRoom.currentWind();
    stepBoatKinematics(raceRoom.boats[seat], wind, 0.1, raceRoom.waterCurrent);
    stepRace(raceRoom.boats[seat], raceRoom.races[seat], raceRoom.raceClock, 0.1,
      raceRoom.startLine, raceRoom.prestartSeconds, raceRoom.windwardMark);
    maximumDistance = Math.max(maximumDistance, Math.hypot(raceRoom.boats[seat].worldX, raceRoom.boats[seat].worldY));
  }
  assert.equal(raceRoom.races[seat].status, "finished");
  assert.ok(maximumDistance < 250);
});
