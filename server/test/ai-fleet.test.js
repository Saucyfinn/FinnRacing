import test from "node:test";
import assert from "node:assert/strict";

import { RaceRoom } from "../src/raceRoom.js";
import { RACE_ENTRY_IMMUNITY_SEC, spawnPositions, stepBoatKinematics, stepRace } from "../src/physics.js";

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

test("AI fleet requests return a confirmed opponent count", () => {
  const raceRoom = room();
  const replies = [];
  const ws = { send: value => replies.push(JSON.parse(value)) };
  raceRoom.hostId = "host";
  raceRoom.sessions.set(ws, { id: "host", boatIndex: 0 });

  raceRoom.handleMessage(ws, JSON.stringify({ t: "ai_fleet", count: 2 }));

  assert.equal(raceRoom.aiSeats.size, 2);
  assert.deepEqual(replies.at(-1), { t: "ai_fleet_result", count: 2, limited: false });
});

test("race-entry staging gives every boat generous separation and rules immunity", () => {
  for (let count = 2; count <= 6; count++) {
    const positions = spawnPositions(count, { dir: 0, speed: 12 });
    for (let i = 0; i < positions.length; i++) for (let j = i + 1; j < positions.length; j++) {
      assert.ok(Math.hypot(positions[i].x - positions[j].x, positions[i].y - positions[j].y) >= 11);
    }
  }

  const raceRoom = room();
  raceRoom.setAiCount(3);
  raceRoom.beginRace();
  for (const seat of raceRoom.aiSeats) assert.equal(raceRoom.races[seat].immunityTimer, RACE_ENTRY_IMMUNITY_SEC);
});

test("the course axis aligns to the wind when the start sequence begins", () => {
  const raceRoom = room();
  raceRoom.venue = { lat: -43.6198028, lon: 172.7193694, bearingDeg: 75 };
  raceRoom.wind = { baseDir: 28, baseSpeed: 12, t: 12 };
  raceRoom.waterCurrent = { speedKnots: 1, directionDeg: 40, trueDirectionDeg: 115 };
  const expectedTrueWind = (75 + raceRoom.currentWind().dir) % 360;

  raceRoom.beginRace();

  assert.ok(Math.abs(raceRoom.venue.bearingDeg - expectedTrueWind) < 0.000001);
  assert.ok(Math.abs(raceRoom.currentWind().dir) < 0.000001);
  assert.equal(raceRoom.startLine.y, 0);
  assert.equal(raceRoom.windwardMark.x, 0);
  assert.equal(raceRoom.windwardMark.y, -1852);
  assert.equal(raceRoom.waterCurrent.trueDirectionDeg, 115);
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
  raceRoom.wind = { baseDir: 0, baseSpeed: 12, t: 0 };
  raceRoom.prestartSeconds = 30;
  raceRoom.setAiCount(1);
  raceRoom.beginRace();
  const [seat] = raceRoom.aiSeats;
  let maximumDistance = 0;
  for (let tick = 0; tick < 50000 && raceRoom.races[seat].status !== "finished"; tick++) {
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
  assert.ok(maximumDistance < 2000);
});
