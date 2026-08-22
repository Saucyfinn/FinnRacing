import test from "node:test";
import assert from "node:assert/strict";

import worker, { interpolateSeries } from "../src/index.js";
import { RaceRoom } from "../src/raceRoom.js";
import { freshBoatState } from "../src/physics.js";

test("new room connections default to Lyttelton Harbour", async () => {
  let forwardedUrl;
  const env = {
    RACE_ROOM: {
      idFromName: roomId => roomId,
      get: () => ({
        fetch(request) {
          forwardedUrl = new URL(request.url);
          return new Response("ok");
        }
      })
    }
  };

  await worker.fetch(new Request("https://finnracing.test/ws/abc?name=Skipper"), env);

  assert.equal(forwardedUrl.searchParams.get("lat"), "-43.6198028");
  assert.equal(forwardedUrl.searchParams.get("lon"), "172.7193694");
  assert.equal(forwardedUrl.searchParams.get("brg"), "75");
});

test("obsolete default links are upgraded but custom venues are preserved", async () => {
  const forwarded = [];
  const env = {
    RACE_ROOM: {
      idFromName: roomId => roomId,
      get: () => ({
        fetch(request) {
          forwarded.push(new URL(request.url));
          return new Response("ok");
        }
      })
    }
  };

  await worker.fetch(new Request("https://finnracing.test/ws/old?lat=-43.6105&lon=172.724&brg=75"), env);
  await worker.fetch(new Request("https://finnracing.test/ws/custom?lat=-36.84&lon=174.76&brg=20"), env);

  assert.equal(forwarded[0].searchParams.get("lat"), "-43.6198028");
  assert.equal(forwarded[0].searchParams.get("lon"), "172.7193694");
  assert.equal(forwarded[1].searchParams.get("lat"), "-36.84");
  assert.equal(forwarded[1].searchParams.get("lon"), "174.76");
});

test("an active room using an obsolete default adopts the precise default", () => {
  const room = new RaceRoom({}, {});
  room.venue = { lat: -43.6105, lon: 172.724, bearingDeg: 75 };
  room.venueChosenFromLink = true;

  room.adoptVenue(new URLSearchParams({ lat: "-43.6198028", lon: "172.7193694", brg: "75" }));

  assert.deepEqual(room.venue, { lat: -43.6198028, lon: 172.7193694, bearingDeg: 75 });
});

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
