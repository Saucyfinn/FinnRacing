export { RaceRoom } from "./raceRoom.js";

const ROOM_ID_RE = /^[a-zA-Z0-9_-]{3,32}$/;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // /ws/<roomId> — WebSocket upgrade, routed to that room's Durable Object.
    // The room code is picked client-side; the Durable Object is created
    // lazily on first connection, so there's no separate "create room" call.
    const m = url.pathname.match(/^\/ws\/([^/]+)\/?$/);
    if (m) {
      const roomId = m[1];
      if (!ROOM_ID_RE.test(roomId)) {
        return new Response("invalid room id", { status: 400 });
      }
      const id = env.RACE_ROOM.idFromName(roomId);
      const stub = env.RACE_ROOM.get(id);
      const forward = new URL(request.url);
      forward.pathname = "/ws";
      return stub.fetch(new Request(forward.toString(), request));
    }

    // Everything else is the static client (public/).
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response("not found", { status: 404 });
  }
};
