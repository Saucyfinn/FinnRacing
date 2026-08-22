import {
  D2R, clamp, lerp, wrap360, wrap180,
  NO_GO_HALF, TRIM_MAX_ERROR, PX_PER_METER,
  PIN_X, BOAT_END_X, START_Y, WINDWARD_MARK, PRESTART_SECONDS,
  idealTrimAngle, stepBoatKinematics, freshBoatState,
  dist, bearingTo, currentMarkFor
} from "./physics-client.js";
import { localToLatLon, latLonToPixel, metersPerPixel, bestZoomFor, TILE_SIZE } from "./geo.js";

const TAU = Math.PI * 2;
const RENDER_DELAY_MS = 150; // buffered-interpolation delay applied to *other* boats

// How many screen pixels per metre of water. Now adjustable, because once
// there's real imagery underneath you want to pull back and see the course.
let viewScale = PX_PER_METER;
const MIN_SCALE = 0.9, MAX_SCALE = 10;

// venue = { lat, lon, bearingDeg } once the server tells us where this room is.
let venue = null;
let imageryAvailable = false;
const tileCache = new Map();   // "z/x/y" -> HTMLImageElement (or null once known-missing)
const TILE_CACHE_MAX = 400;

// ---------- room id / shareable link ----------
function genRoomId() {
  const bytes = crypto.getRandomValues(new Uint8Array(5));
  return Array.from(bytes, b => (b % 36).toString(36)).join("");
}
const params = new URLSearchParams(location.search);
let roomId = params.get("room");
if (!roomId) {
  roomId = genRoomId();
  params.set("room", roomId);
  history.replaceState(null, "", location.pathname + "?" + params.toString());
}
document.getElementById("linkInput").value = location.href;
document.getElementById("roomLabel").textContent = "room " + roomId;
document.getElementById("headerRoom").textContent = "ROOM " + roomId.toUpperCase();

// ---------- state ----------
let ws = null, wsRetries = 0, intentionalClose = false;
let myId = null, myBoatIndex = null, myColor = "#e2ece9", isHost = false, isWaiting = false, maxBoats = 6;
let myInitialized = false;
let authoritative = null;
const myBoat = freshBoatState(0);
let myRace = { status: "prestart", leg: 1, ocs: false, finishTime: null, place: null, penalty: { active: false, turnedDeg: 0, rule: null } };
let wind = { dir: 0, speed: 10 };
let myDirtyWind = { type: "clean", sourceBoatIndex: null, exposure01: 0, speedDeficitKnots: 0, directionShiftDeg: 0, effectiveSpeed: 10, effectiveDir: 0 };
let roomStatus = "lobby";
let raceClock = 0;
let startLine = { pinX: PIN_X, boatEndX: BOAT_END_X, y: START_Y, lengthM: BOAT_END_X - PIN_X };
let lastSnapshotBoats = [];
const remoteBuffers = {}; // boatIndex -> [{tRecv, worldX, worldY, headingDeg, speedKnots, tackSign, name, color, connected, race}]
const wakeMap = {}; // boatIndex -> [{x,y,age}]

// ---------- DOM ----------
const nameInput = document.getElementById("nameInput");
const linkInput = document.getElementById("linkInput");
const copyLinkBtn = document.getElementById("copyLinkBtn");
const rosterList = document.getElementById("rosterList");
const rosterCount = document.getElementById("rosterCount");
const rosterMax = document.getElementById("rosterMax");
const waitingList = document.getElementById("waitingList");
const waitingCount = document.getElementById("waitingCount");
const lobbyStatus = document.getElementById("lobbyStatus");
const startBtn = document.getElementById("startBtn");
const lobby = document.getElementById("lobby");
const connDot = document.getElementById("connDot");

nameInput.value = localStorage.getItem("finnracing_name") || "";
nameInput.addEventListener("change", () => {
  const nm = nameInput.value.trim().slice(0, 16);
  localStorage.setItem("finnracing_name", nm);
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "rename", name: nm || "Sailor" }));
});
copyLinkBtn.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(linkInput.value);
    copyLinkBtn.textContent = "COPIED";
    setTimeout(() => { copyLinkBtn.textContent = "COPY"; }, 1200);
  } catch {
    linkInput.select();
    document.execCommand("copy");
  }
});
startBtn.addEventListener("click", () => {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "start" }));
});

function setConnDot(ok) { connDot.classList.toggle("bad", !ok); }

// ---------- venue (where on earth this course is) ----------
const venueInput = document.getElementById("venueInput");
const venueBearing = document.getElementById("venueBearing");
const venueApplyBtn = document.getElementById("venueApplyBtn");
const venueLocateBtn = document.getElementById("venueLocateBtn");
const venueMapApplyBtn = document.getElementById("venueMapApplyBtn");
const venueMapCoords = document.getElementById("venueMapCoords");
const venueStatus = document.getElementById("venueStatus");
const attribution = document.getElementById("attribution");
let venuePickerMap = null;

function updateVenuePickerReadout() {
  if (!venuePickerMap) return;
  const centre = venuePickerMap.getCenter();
  venueMapCoords.textContent = centre.lat.toFixed(5) + ", " + centre.lng.toFixed(5) + " · zoom " + venuePickerMap.getZoom();
  venueInput.value = centre.lat.toFixed(5) + ", " + centre.lng.toFixed(5);
}

function initVenuePicker() {
  if (!window.L || venuePickerMap) return;
  venuePickerMap = window.L.map("venueMap", {
    center: [-41.0, 172.5], zoom: 5, minZoom: 5, maxZoom: 20,
    maxBounds: [[-48.5, 164.5], [-32.5, 180]], maxBoundsViscosity: 0.8
  });
  window.L.tileLayer("/tiles/{z}/{x}/{y}.webp", {
    minZoom: 5, maxZoom: 20, attribution: "Imagery © LINZ · CC BY 4.0"
  }).addTo(venuePickerMap);
  venuePickerMap.on("move zoom", updateVenuePickerReadout);
  updateVenuePickerReadout();
}
initVenuePicker();

// Accepts what you get from Google Maps / LINZ: "-41.2865, 174.7762"
function parseLatLon(text) {
  const m = String(text).trim().match(/^\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (!m) return null;
  const lat = Number(m[1]), lon = Number(m[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return { lat, lon };
}

function sendVenue(lat, lon) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  // Number("") is 0, which would silently mean "wind from due north" every time
  // the field is left blank — treat empty as "server picks".
  const raw = venueBearing.value.trim();
  const brg = raw === "" ? NaN : Number(raw);
  ws.send(JSON.stringify({
    t: "venue", lat, lon,
    bearingDeg: Number.isFinite(brg) ? brg : undefined
  }));
}

if (venueApplyBtn) {
  venueApplyBtn.addEventListener("click", () => {
    const parsed = parseLatLon(venueInput.value);
    if (!parsed) { venueStatus.textContent = "need \"lat, lon\" — e.g. -41.2865, 174.7762"; return; }
    venueStatus.textContent = "setting course position…";
    sendVenue(parsed.lat, parsed.lon);
  });
}
if (venueMapApplyBtn) {
  venueMapApplyBtn.addEventListener("click", () => {
    if (!venuePickerMap) { venueStatus.textContent = "map is still loading"; return; }
    const centre = venuePickerMap.getCenter();
    venueStatus.textContent = "setting course at map centre…";
    sendVenue(centre.lat, centre.lng);
  });
}
if (venueLocateBtn) {
  venueLocateBtn.addEventListener("click", () => {
    if (!navigator.geolocation) { venueStatus.textContent = "this browser has no location support"; return; }
    venueStatus.textContent = "finding you…";
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const lat = pos.coords.latitude, lon = pos.coords.longitude;
        venueInput.value = lat.toFixed(5) + ", " + lon.toFixed(5);
        sendVenue(lat, lon);
      },
      () => { venueStatus.textContent = "couldn't get your location — type coordinates instead"; },
      { enableHighAccuracy: true, timeout: 8000 }
    );
  });
}

function applyVenueToUi() {
  if (!venueStatus) return;
  if (venue) {
    venueInput.value = venue.lat.toFixed(5) + ", " + venue.lon.toFixed(5);
    venueBearing.value = Math.round(venue.bearingDeg);
    if (venuePickerMap) {
      const current = venuePickerMap.getCenter();
      if (Math.abs(current.lat - venue.lat) > 0.00001 || Math.abs(current.lng - venue.lon) > 0.00001) {
        venuePickerMap.setView([venue.lat, venue.lon], Math.max(venuePickerMap.getZoom(), 15));
      }
      setTimeout(() => venuePickerMap.invalidateSize(), 0);
    }
    venueStatus.textContent = "course set — wind from " + Math.round(venue.bearingDeg) + "°T"
      + (imageryAvailable ? "" : " · no imagery key on this Worker");
    // Keep the shareable link carrying the venue, so a fresh room from this
    // link starts at the same place.
    const p = new URLSearchParams(location.search);
    p.set("room", roomId);
    p.set("lat", venue.lat.toFixed(5));
    p.set("lon", venue.lon.toFixed(5));
    p.set("brg", String(Math.round(venue.bearingDeg)));
    history.replaceState(null, "", location.pathname + "?" + p.toString());
    linkInput.value = location.href;
  } else {
    venueStatus.textContent = "open water — set a position to race on the real map";
  }
  attribution.classList.toggle("show", !!(venue && imageryAvailable));
}

// Ask the Worker whether an imagery key is configured before trying tiles.
fetch("/api/config")
  .then(r => r.json())
  .then(cfg => { imageryAvailable = cfg.imagery === "linz"; applyVenueToUi(); })
  .catch(() => { imageryAvailable = false; });

// ---------- view zoom ----------
let autoZoomEnabled = true;
const autoZoomBtn = document.getElementById("autoZoomBtn");

function setScale(next) {
  viewScale = clamp(next, MIN_SCALE, MAX_SCALE);
  const el = document.getElementById("zoomReadout");
  if (el) el.textContent = Math.round(document.getElementById("world").clientWidth / viewScale) + "m";
}
function setAutoZoom(enabled) {
  autoZoomEnabled = enabled;
  autoZoomBtn.classList.toggle("active", enabled);
  autoZoomBtn.setAttribute("aria-pressed", String(enabled));
}
function manualZoom(next) { setAutoZoom(false); setScale(next); }
document.getElementById("zoomInBtn").addEventListener("click", () => manualZoom(viewScale * 1.4));
document.getElementById("zoomOutBtn").addEventListener("click", () => manualZoom(viewScale / 1.4));
autoZoomBtn.addEventListener("click", () => setAutoZoom(!autoZoomEnabled));
// Start pulled back enough to see a decent slice of the course on a map.
setScale(2.2);

// pinch to zoom on the water
let pinchStart = null;
const worldCanvas = document.getElementById("world");
worldCanvas.addEventListener("touchstart", (e) => {
  if (e.touches.length === 2) {
    setAutoZoom(false);
    pinchStart = { d: touchDist(e.touches), scale: viewScale };
  }
}, { passive: true });
worldCanvas.addEventListener("touchmove", (e) => {
  if (e.touches.length === 2 && pinchStart) {
    const d = touchDist(e.touches);
    if (pinchStart.d > 0) setScale(pinchStart.scale * (d / pinchStart.d));
  }
}, { passive: true });
worldCanvas.addEventListener("touchend", () => { pinchStart = null; }, { passive: true });
worldCanvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  manualZoom(viewScale * (e.deltaY < 0 ? 1.15 : 1 / 1.15));
}, { passive: false });
function touchDist(t) { return Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY); }

function updateAutoZoom() {
  if (!autoZoomEnabled || !myInitialized) return;
  const points = lastSnapshotBoats
    .filter(b => b.connected)
    .map(b => ({ x: b.worldX, y: b.worldY }));
  if (roomStatus === "lobby" || raceClock < PRESTART_SECONDS) {
    points.push({ x: startLine.pinX, y: startLine.y }, { x: startLine.boatEndX, y: startLine.y });
  } else if (myRace.status !== "finished") {
    points.push(currentMarkFor(myRace.leg));
  }
  let maxDx = 10, maxDy = 10;
  for (const p of points) {
    maxDx = Math.max(maxDx, Math.abs(p.x - myBoat.worldX));
    maxDy = Math.max(maxDy, Math.abs(p.y - myBoat.worldY));
  }
  const w = worldCanvas.clientWidth, h = worldCanvas.clientHeight;
  const target = clamp(Math.min((w * 0.42) / maxDx, (h * 0.36) / maxDy), MIN_SCALE, MAX_SCALE);
  setScale(lerp(viewScale, target, 0.035));
}

// ---------- networking ----------
function connect() {
  const proto = location.protocol === "https:" ? "wss://" : "ws://";
  const name = (nameInput.value || "Sailor").trim().slice(0, 16);
  const q = new URLSearchParams({ name: (nameInput.value || "Sailor").trim().slice(0, 16) });
  // Carry any venue from the link through to the room, so opening a shared
  // course link actually lands you on that patch of water.
  const here = new URLSearchParams(location.search);
  for (const k of ["lat", "lon", "brg"]) {
    const v = here.get(k);
    if (v !== null && v !== "") q.set(k, v);
  }
  const url = proto + location.host + "/ws/" + encodeURIComponent(roomId) + "?" + q.toString();
  ws = new WebSocket(url);
  ws.addEventListener("open", () => { wsRetries = 0; setConnDot(true); lobbyStatus.textContent = "connected"; });
  ws.addEventListener("message", (evt) => { try { onServerMessage(JSON.parse(evt.data)); } catch { /* ignore malformed */ } });
  ws.addEventListener("close", () => {
    setConnDot(false);
    if (intentionalClose) return;
    wsRetries++;
    const delay = Math.min(1500 * wsRetries, 6000);
    lobbyStatus.textContent = "disconnected — reconnecting…";
    setTimeout(connect, delay);
  });
  ws.addEventListener("error", () => { try { ws.close(); } catch { /* already closing */ } });
}
connect();

setInterval(() => {
  if (ws && ws.readyState === WebSocket.OPEN && myInitialized) {
    ws.send(JSON.stringify({
      t: "input", targetHeadingDeg: myBoat.targetHeadingDeg,
      autoTrim: myBoat.autoTrim, trimAngleDeg: myBoat.trimAngleDeg
    }));
  }
}, 66);

function onServerMessage(msg) {
  if (msg.t === "full") {
    lobbyStatus.textContent = "room is full (" + maxBoats + "/" + maxBoats + ") — waiting for a seat to free up";
  } else if (msg.t === "welcome") {
    myId = msg.youId; myBoatIndex = msg.boatIndex; myColor = msg.color; isHost = msg.isHost; isWaiting = !!msg.waiting; maxBoats = msg.maxBoats;
    rosterMax.textContent = maxBoats;
    // The room, not your link, decides where the course is — so late joiners
    // land on the same patch of water as everyone else.
    venue = msg.venue || null;
    if (msg.startLine) startLine = msg.startLine;
    applyVenueToUi();
  } else if (msg.t === "roster") {
    roomStatus = msg.roomStatus;
    if (msg.startLine) startLine = msg.startLine;
    if (msg.venue !== undefined) { venue = msg.venue; applyVenueToUi(); }
    renderRoster(msg.roster, msg.hostId);
  } else if (msg.t === "start_countdown") {
    if (!isWaiting) lobby.classList.add("hide");
  } else if (msg.t === "snapshot") {
    onSnapshot(msg);
  }
}

function renderRoster(roster, hostId) {
  const joined = roster.filter(r => !r.waiting);
  const waiting = roster.filter(r => r.waiting);
  rosterCount.textContent = joined.length;
  waitingCount.textContent = waiting.length;
  rosterList.innerHTML = "";
  waitingList.innerHTML = "";
  const own = roster.find(r => r.id === myId);
  if (own) {
    isWaiting = !!own.waiting;
    if (!isWaiting && myBoatIndex == null) {
      myBoatIndex = own.boatIndex;
      myColor = own.color;
      myInitialized = false;
    }
  }
  function addRosterRow(target, r, suffix) {
    const row = document.createElement("div");
    row.className = "fleet-row" + (r.id === myId ? " me" : "");
    const dot = document.createElement("span");
    dot.className = "dot"; dot.style.background = r.color;
    const nm = document.createElement("span");
    nm.className = "nm";
    nm.textContent = r.name + (r.id === hostId ? " · host" : "");
    const st = document.createElement("span");
    st.className = "st"; st.textContent = suffix;
    row.appendChild(dot); row.appendChild(nm); row.appendChild(st);
    target.appendChild(row);
  }
  joined.forEach(r => addRosterRow(rosterList, r, "ready"));
  waiting.forEach((r, i) => addRosterRow(waitingList, r, "#" + (i + 1)));
  if (!joined.length) rosterList.innerHTML = '<div class="empty-roster">No sailors joined yet</div>';
  if (!waiting.length) waitingList.innerHTML = '<div class="empty-roster">Lobby is clear</div>';
  isHost = myId && myId === hostId;
  venueApplyBtn.disabled = !isHost || roomStatus !== "lobby";
  venueMapApplyBtn.disabled = !isHost || roomStatus !== "lobby";
  venueLocateBtn.disabled = !isHost || roomStatus !== "lobby";
  if (roomStatus === "lobby") {
    lobby.classList.remove("hide");
    startBtn.disabled = !isHost || isWaiting;
    startBtn.textContent = isWaiting ? "WAITING FOR A RACE SEAT" : (isHost ? "START 3:00 SEQUENCE" : "WAITING FOR HOST");
    startBtn.classList.toggle("active", isHost && !isWaiting);
  } else {
    if (isWaiting) {
      lobby.classList.remove("hide");
      startBtn.disabled = true;
      startBtn.textContent = "RACE IN PROGRESS · WAITING FOR NEXT START";
      startBtn.classList.remove("active");
    } else lobby.classList.add("hide");
  }
}

function onSnapshot(msg) {
  wind.dir = msg.wind.dir; wind.speed = msg.wind.speed;
  roomStatus = msg.roomStatus; raceClock = msg.raceClock;
  if (msg.startLine) startLine = msg.startLine;
  lastSnapshotBoats = msg.boats;
  if (roomStatus !== "lobby" && !isWaiting) lobby.classList.add("hide");
  const now = performance.now();
  for (const b of msg.boats) {
    if (b.boatIndex === myBoatIndex) {
      if (!myInitialized) {
        myBoat.worldX = b.worldX; myBoat.worldY = b.worldY;
        myBoat.headingDeg = b.headingDeg; myBoat.targetHeadingDeg = b.headingDeg;
        myBoat.speedKnots = b.speedKnots; myBoat.tackSign = b.tackSign;
        myInitialized = true;
      }
      authoritative = b;
      if (b.dirtyWind) myDirtyWind = b.dirtyWind;
      myRace = b.race;
    } else {
      let buf = remoteBuffers[b.boatIndex];
      if (!buf) buf = remoteBuffers[b.boatIndex] = [];
      buf.push({
        tRecv: now, worldX: b.worldX, worldY: b.worldY, headingDeg: b.headingDeg,
        speedKnots: b.speedKnots, tackSign: b.tackSign, name: b.name, color: b.color,
        connected: b.connected, race: b.race, dirtyWind: b.dirtyWind
      });
      while (buf.length > 12) buf.shift();
    }
  }
}

// ---------- local prediction + server reconciliation for our own boat ----------
function stepLocalPrediction(dt) {
  if (!myInitialized) return { twaSigned: 0, absTwa: 0, inNoGo: false, drifting: false };
  if (myRace.penalty && myRace.penalty.active) {
    myBoat.targetHeadingDeg = wrap360(myBoat.headingDeg + 45); // mirrors the server's forced-turn override
  }
  const localWind = myDirtyWind.exposure01 > 0.01
    ? { dir: myDirtyWind.effectiveDir, speed: myDirtyWind.effectiveSpeed }
    : wind;
  const info = stepBoatKinematics(myBoat, localWind, dt);
  if (authoritative) {
    const dx = authoritative.worldX - myBoat.worldX, dy = authoritative.worldY - myBoat.worldY;
    const d = Math.hypot(dx, dy);
    if (d > 4) {
      myBoat.worldX = authoritative.worldX; myBoat.worldY = authoritative.worldY;
      myBoat.headingDeg = authoritative.headingDeg; myBoat.speedKnots = authoritative.speedKnots;
    } else if (d > 0.03) {
      const pull = clamp(dt / 0.3, 0, 1);
      myBoat.worldX += dx * pull; myBoat.worldY += dy * pull;
    }
    myBoat.tackSign = authoritative.tackSign;
  }
  return info;
}

function getRemoteRenderState(boatIndex) {
  const buf = remoteBuffers[boatIndex];
  if (!buf || buf.length === 0) return null;
  const renderT = performance.now() - RENDER_DELAY_MS;
  if (renderT <= buf[0].tRecv) return buf[0];
  const last = buf[buf.length - 1];
  if (renderT >= last.tRecv) return last;
  for (let i = 0; i < buf.length - 1; i++) {
    const a = buf[i], b = buf[i + 1];
    if (renderT >= a.tRecv && renderT <= b.tRecv) {
      const span = b.tRecv - a.tRecv;
      const t = span > 0 ? (renderT - a.tRecv) / span : 0;
      return {
        worldX: lerp(a.worldX, b.worldX, t), worldY: lerp(a.worldY, b.worldY, t),
        headingDeg: a.headingDeg + wrap180(b.headingDeg - a.headingDeg) * t,
        speedKnots: lerp(a.speedKnots, b.speedKnots, t),
        tackSign: b.tackSign, name: b.name, color: b.color, connected: b.connected, race: b.race,
        dirtyWind: b.dirtyWind
      };
    }
  }
  return last;
}

// ---------- input: heading tape ----------
const tapeCanvas = document.getElementById("headingTape");
const tapeCtx = tapeCanvas.getContext("2d");
let tapeDrag = false;
function tapePxPerDeg() { return tapeCanvas.clientWidth / 140; }
function tapePointerToHeading(clientX) {
  const rect = tapeCanvas.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  return wrap360(myBoat.headingDeg + (clientX - cx) / tapePxPerDeg());
}
tapeCanvas.addEventListener("pointerdown", (e) => {
  tapeCanvas.setPointerCapture(e.pointerId);
  tapeDrag = true;
  myBoat.targetHeadingDeg = tapePointerToHeading(e.clientX);
});
tapeCanvas.addEventListener("pointermove", (e) => { if (tapeDrag) myBoat.targetHeadingDeg = tapePointerToHeading(e.clientX); });
function endTapeDrag() { tapeDrag = false; }
tapeCanvas.addEventListener("pointerup", endTapeDrag);
tapeCanvas.addEventListener("pointercancel", endTapeDrag);

function drawTape() {
  const w = tapeCanvas.clientWidth, h = tapeCanvas.clientHeight;
  const dpr = window.devicePixelRatio || 1;
  if (tapeCanvas.width !== w * dpr || tapeCanvas.height !== h * dpr) { tapeCanvas.width = w * dpr; tapeCanvas.height = h * dpr; }
  tapeCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  tapeCtx.clearRect(0, 0, w, h);
  tapeCtx.fillStyle = "#0e2027"; tapeCtx.fillRect(0, 0, w, h);

  const cx = w / 2, pxPerDeg = w / 140;
  function xFor(deg) { return cx + wrap180(deg - myBoat.headingDeg) * pxPerDeg; }

  const loX = xFor(wind.dir - NO_GO_HALF), hiX = xFor(wind.dir + NO_GO_HALF);
  tapeCtx.fillStyle = "rgba(226,114,111,0.24)";
  tapeCtx.fillRect(Math.min(loX, hiX), 0, Math.abs(hiX - loX), h);

  tapeCtx.strokeStyle = "rgba(226,236,233,0.28)";
  tapeCtx.fillStyle = "rgba(183,199,197,0.85)";
  tapeCtx.font = "10px 'IBM Plex Mono', monospace";
  tapeCtx.textAlign = "center";
  for (let d = -180; d <= 180; d += 10) {
    const heading = wrap360(myBoat.headingDeg + d);
    const x = xFor(heading);
    if (x < -10 || x > w + 10) continue;
    const major = Math.round(heading) % 30 === 0;
    tapeCtx.beginPath(); tapeCtx.moveTo(x, h - (major ? 22 : 14)); tapeCtx.lineTo(x, h);
    tapeCtx.lineWidth = major ? 1.4 : 1; tapeCtx.stroke();
    if (major) tapeCtx.fillText(Math.round(trueDeg(heading)) + "°", x, h - 26);
  }

  const wx = xFor(wind.dir);
  tapeCtx.fillStyle = "#dba85a";
  tapeCtx.beginPath(); tapeCtx.moveTo(wx, 6); tapeCtx.lineTo(wx - 6, 16); tapeCtx.lineTo(wx + 6, 16); tapeCtx.closePath(); tapeCtx.fill();

  const tx = clamp(xFor(myBoat.targetHeadingDeg), 8, w - 8);
  tapeCtx.strokeStyle = "#e2726f"; tapeCtx.lineWidth = 2.5;
  tapeCtx.beginPath(); tapeCtx.moveTo(tx, 0); tapeCtx.lineTo(tx, h); tapeCtx.stroke();

  tapeCtx.strokeStyle = "#e2ece9"; tapeCtx.lineWidth = 2;
  tapeCtx.beginPath(); tapeCtx.moveTo(cx, 0); tapeCtx.lineTo(cx, h); tapeCtx.stroke();
}

// ---------- input: trim slider ----------
const trimCanvas = document.getElementById("trimSlider");
const trimCtx = trimCanvas.getContext("2d");
let trimDrag = false;
const autoTrimBtn = document.getElementById("autoTrimBtn");
autoTrimBtn.addEventListener("click", () => {
  myBoat.autoTrim = !myBoat.autoTrim;
  autoTrimBtn.classList.toggle("active", myBoat.autoTrim);
  autoTrimBtn.textContent = myBoat.autoTrim ? "AUTO" : "MANUAL";
});
function trimPointerToAngle(clientX) {
  const rect = trimCanvas.getBoundingClientRect();
  return clamp((clientX - rect.left) / rect.width, 0, 1) * 90;
}
trimCanvas.addEventListener("pointerdown", (e) => {
  if (myBoat.autoTrim) return;
  trimCanvas.setPointerCapture(e.pointerId);
  trimDrag = true;
  myBoat.trimAngleDeg = trimPointerToAngle(e.clientX);
});
trimCanvas.addEventListener("pointermove", (e) => { if (trimDrag) myBoat.trimAngleDeg = trimPointerToAngle(e.clientX); });
function endTrimDrag() { trimDrag = false; }
trimCanvas.addEventListener("pointerup", endTrimDrag);
trimCanvas.addEventListener("pointercancel", endTrimDrag);

function currentTWA() { return wrap180(wind.dir - myBoat.headingDeg); }

// Headings and wind are simulated in the course-local frame. Once the course
// is pinned to a real place, show them as true compass bearings instead —
// reading "wind @ 3°" next to actual coastline would be nonsense.
function trueDeg(localDeg) {
  return venue ? wrap360(localDeg + venue.bearingDeg) : wrap360(localDeg);
}
function bearingSuffix() { return venue ? "°T" : "°"; }

function drawTrim() {
  const w = trimCanvas.clientWidth, h = trimCanvas.clientHeight;
  const dpr = window.devicePixelRatio || 1;
  if (trimCanvas.width !== w * dpr || trimCanvas.height !== h * dpr) { trimCanvas.width = w * dpr; trimCanvas.height = h * dpr; }
  trimCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  trimCtx.clearRect(0, 0, w, h);
  trimCtx.fillStyle = "#0e2027"; trimCtx.fillRect(0, 0, w, h);

  const trackY = h / 2, pad = 10;
  function xFor(deg) { return pad + (deg / 90) * (w - pad * 2); }

  const absTwa = Math.abs(currentTWA());
  const ideal = idealTrimAngle(absTwa);
  const loX = xFor(clamp(ideal - TRIM_MAX_ERROR, 0, 90));
  const hiX = xFor(clamp(ideal + TRIM_MAX_ERROR, 0, 90));
  trimCtx.fillStyle = myBoat.autoTrim ? "rgba(95,194,140,0.10)" : "rgba(95,194,140,0.20)";
  trimCtx.fillRect(loX, trackY - 12, hiX - loX, 24);

  trimCtx.strokeStyle = "rgba(226,236,233,0.25)"; trimCtx.lineWidth = 2;
  trimCtx.beginPath(); trimCtx.moveTo(pad, trackY); trimCtx.lineTo(w - pad, trackY); trimCtx.stroke();

  const ix = xFor(ideal);
  trimCtx.strokeStyle = "#5fc28c"; trimCtx.lineWidth = 2;
  trimCtx.beginPath(); trimCtx.moveTo(ix, trackY - 14); trimCtx.lineTo(ix, trackY + 14); trimCtx.stroke();

  const hx = xFor(myBoat.autoTrim ? ideal : myBoat.trimAngleDeg);
  trimCtx.fillStyle = myBoat.autoTrim ? "rgba(219,168,90,0.45)" : "#dba85a";
  trimCtx.beginPath(); trimCtx.arc(hx, trackY, 8, 0, TAU); trimCtx.fill();
}

// ---------- world canvas ----------
const world = document.getElementById("world");
const wctx = world.getContext("2d");
function resizeWorld() {
  const dpr = window.devicePixelRatio || 1;
  const w = world.clientWidth, h = world.clientHeight;
  world.width = w * dpr; world.height = h * dpr;
  wctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener("resize", resizeWorld);
resizeWorld();

// ---------- satellite map layer ----------
// Tiles come from our own /tiles proxy (LINZ Basemaps behind it), so no API key
// is ever in the client and Cloudflare's edge absorbs the repeat requests.
function getTile(z, x, y) {
  const key = z + "/" + x + "/" + y;
  if (tileCache.has(key)) return tileCache.get(key);
  const img = new Image();
  img.decoding = "async";
  img.dataset.ready = "";
  img.addEventListener("load", () => { img.dataset.ready = "1"; });
  // 204 (no key / outside coverage) surfaces here as an error — cache the miss
  // so we don't re-request a tile that will never exist.
  img.addEventListener("error", () => { tileCache.set(key, null); });
  img.src = "/tiles/" + z + "/" + x + "/" + y + ".webp";
  if (tileCache.size > TILE_CACHE_MAX) {
    // crude LRU-ish trim: drop the oldest inserted keys
    const drop = tileCache.keys().next().value;
    tileCache.delete(drop);
  }
  tileCache.set(key, img);
  return img;
}

function drawMapLayer(cx, cy, w, h) {
  if (!venue || !imageryAvailable) return false;

  const zoom = bestZoomFor(viewScale, venue.lat, 12, 21);
  const mPerPx = metersPerPixel(venue.lat, zoom);
  const scale = mPerPx * viewScale;          // screen px per Mercator px
  const tilePx = TILE_SIZE * scale;          // on-screen size of one tile

  // Where the player's boat sits in the Mercator pyramid.
  const boatLL = localToLatLon(myBoat.worldX, myBoat.worldY, venue);
  const boatPix = latLonToPixel(boatLL.lat, boatLL.lon, zoom);

  // The local frame is rotated relative to true north by the course bearing,
  // so the north-up imagery has to be counter-rotated to match the course-up view.
  wctx.save();
  wctx.translate(cx, cy);
  wctx.rotate(-venue.bearingDeg * Math.PI / 180);

  // Rotation means the screen rect can sample anywhere inside its circumcircle.
  const reach = Math.hypot(w, h) / 2 / scale;
  const minPx = boatPix.px - reach, maxPx = boatPix.px + reach;
  const minPy = boatPix.py - reach, maxPy = boatPix.py + reach;
  const span = Math.pow(2, zoom);
  const x0 = Math.max(0, Math.floor(minPx / TILE_SIZE)), x1 = Math.min(span - 1, Math.floor(maxPx / TILE_SIZE));
  const y0 = Math.max(0, Math.floor(minPy / TILE_SIZE)), y1 = Math.min(span - 1, Math.floor(maxPy / TILE_SIZE));

  let drewAny = false;
  for (let tx = x0; tx <= x1; tx++) {
    for (let ty = y0; ty <= y1; ty++) {
      const img = getTile(zoom, tx, ty);
      if (!img || !img.dataset.ready) continue;
      const sx = (tx * TILE_SIZE - boatPix.px) * scale;
      const sy = (ty * TILE_SIZE - boatPix.py) * scale;
      // +1 closes the hairline seams that rounding leaves between tiles
      wctx.drawImage(img, sx, sy, tilePx + 1, tilePx + 1);
      drewAny = true;
    }
  }
  wctx.restore();

  if (drewAny) {
    // Knock the imagery back so boats, marks and the HUD stay readable over it.
    wctx.fillStyle = "rgba(8,21,27,0.30)";
    wctx.fillRect(0, 0, w, h);
  }
  return drewAny;
}

function drawBoatShape(originX, originY, headingDeg, hullColor, sailLean, tackSign) {
  wctx.save();
  wctx.translate(originX, originY);
  wctx.rotate(headingDeg * D2R);
  wctx.fillStyle = hullColor;
  wctx.beginPath();
  wctx.moveTo(0, -20); wctx.lineTo(9, 14); wctx.lineTo(0, 8); wctx.lineTo(-9, 14);
  wctx.closePath(); wctx.fill();
  wctx.strokeStyle = "rgba(226,236,233,0.55)"; wctx.lineWidth = 2;
  wctx.beginPath(); wctx.moveTo(0, -14); wctx.lineTo((tackSign > 0 ? -1 : 1) * sailLean, 6); wctx.stroke();
  wctx.restore();
}

const lastWakeAt = {}; // boatIndex -> performance.now() ms, throttles emission independent of frame rate
function maybePushWake(boatIndex, x, y, speedKnots) {
  if (Math.abs(speedKnots) <= 0.15) return;
  const now = performance.now();
  const last = lastWakeAt[boatIndex] || 0;
  const interval = clamp(320 - Math.abs(speedKnots) * 18, 90, 320);
  if (now - last < interval) return;
  lastWakeAt[boatIndex] = now;
  let arr = wakeMap[boatIndex];
  if (!arr) arr = wakeMap[boatIndex] = [];
  arr.push({ x, y, age: 0 });
}

function drawWorld(info, dt) {
  const w = world.clientWidth, h = world.clientHeight;
  const cx = w / 2, cy = h / 2;

  const g = wctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, "#0e2530"); g.addColorStop(1, "#08151b");
  wctx.fillStyle = g; wctx.fillRect(0, 0, w, h);

  const onMap = drawMapLayer(cx, cy, w, h);

  // The abstract drift grid only earns its place when there's no imagery to
  // read motion against.
  if (!onMap) {
    const tile = 46;
    const ox = (-myBoat.worldX * viewScale) % tile;
    const oy = (-myBoat.worldY * viewScale) % tile;
    wctx.strokeStyle = "rgba(255,255,255,0.035)"; wctx.lineWidth = 1;
    for (let x = ox - tile; x < w + tile; x += tile) { wctx.beginPath(); wctx.moveTo(x, 0); wctx.lineTo(x, h); wctx.stroke(); }
    for (let y = oy - tile; y < h + tile; y += tile) { wctx.beginPath(); wctx.moveTo(0, y); wctx.lineTo(w, y); wctx.stroke(); }
  }

  function toScreen(wx, wy) { return [cx + (wx - myBoat.worldX) * viewScale, cy + (wy - myBoat.worldY) * viewScale]; }

  // wake, own boat
  maybePushWake(myBoatIndex, myBoat.worldX, myBoat.worldY, myBoat.speedKnots);
  for (const key in wakeMap) {
    const arr = wakeMap[key];
    for (let i = arr.length - 1; i >= 0; i--) {
      arr[i].age += dt;
      if (arr[i].age > 6) { arr.splice(i, 1); continue; }
      const [sx, sy] = toScreen(arr[i].x, arr[i].y);
      const a = clamp(1 - arr[i].age / 6, 0, 1) * 0.3;
      wctx.fillStyle = "rgba(226,236,233," + a.toFixed(3) + ")";
      wctx.beginPath(); wctx.arc(sx, sy, 2.2, 0, TAU); wctx.fill();
    }
  }

  // wind arrow
  wctx.save();
  wctx.translate(cx, 64);
  wctx.rotate(wind.dir * D2R);
  wctx.strokeStyle = "#dba85a"; wctx.fillStyle = "#dba85a"; wctx.lineWidth = 2;
  wctx.beginPath(); wctx.moveTo(0, -26); wctx.lineTo(0, 22); wctx.stroke();
  wctx.beginPath(); wctx.moveTo(0, 26); wctx.lineTo(-6, 14); wctx.lineTo(6, 14); wctx.closePath(); wctx.fill();
  wctx.restore();

  // start/finish line + windward mark
  const anyOcs = lastSnapshotBoats.some(b => b.race.ocs);
  const [pinSx, pinSy] = toScreen(startLine.pinX, startLine.y);
  const [endSx, endSy] = toScreen(startLine.boatEndX, startLine.y);
  wctx.strokeStyle = anyOcs ? "#e2726f" : "rgba(226,236,233,0.5)";
  wctx.lineWidth = 1.6; wctx.setLineDash([5, 5]);
  wctx.beginPath(); wctx.moveTo(pinSx, pinSy); wctx.lineTo(endSx, endSy); wctx.stroke();
  wctx.setLineDash([]);
  [[pinSx, pinSy], [endSx, endSy]].forEach(([sx, sy]) => {
    wctx.fillStyle = "#f0c581"; wctx.beginPath(); wctx.arc(sx, sy, 4, 0, TAU); wctx.fill();
  });
  const [mSx, mSy] = toScreen(WINDWARD_MARK.x, WINDWARD_MARK.y);
  wctx.fillStyle = "#dba85a"; wctx.beginPath(); wctx.arc(mSx, mSy, 5, 0, TAU); wctx.fill();
  wctx.strokeStyle = "rgba(219,168,90,0.4)"; wctx.lineWidth = 1;
  wctx.beginPath(); wctx.arc(mSx, mSy, 8 * viewScale, 0, TAU); wctx.stroke();

  // other boats
  for (const key in remoteBuffers) {
    const r = getRemoteRenderState(Number(key));
    if (!r || !r.connected) continue;
    const [sx, sy] = toScreen(r.worldX, r.worldY);
    if (sx < -60 || sx > w + 60 || sy < -60 || sy > h + 60) continue; // off-screen, skip label work
    maybePushWake(Number(key), r.worldX, r.worldY, r.speedKnots);
    drawBoatShape(sx, sy, r.headingDeg, r.color, 8, r.tackSign);
    if (r.dirtyWind && r.dirtyWind.exposure01 >= 0.12) {
      wctx.strokeStyle = r.dirtyWind.type === "leeBow" ? "rgba(226,114,111,0.8)" : "rgba(240,197,129,0.75)";
      wctx.lineWidth = 2;
      wctx.beginPath(); wctx.arc(sx, sy, 14 + r.dirtyWind.exposure01 * 8, 0, TAU); wctx.stroke();
    }
    wctx.fillStyle = r.color; wctx.font = "10.5px 'IBM Plex Mono', monospace"; wctx.textAlign = "center";
    wctx.fillText(r.name + " · " + r.speedKnots.toFixed(1) + "kt", sx, sy - 28);
    if (r.race && r.race.penalty && r.race.penalty.active) {
      wctx.fillStyle = "rgba(226,120,116,0.95)";
      wctx.fillText("PENALTY " + Math.round(r.race.penalty.turnedDeg) + "°/360°", sx, sy - 40);
    }
  }

  // own boat, screen-fixed
  const hullColor = info.drifting ? "#e2726f" : (info.inNoGo ? "#f0c581" : myColor);
  const sailLean = myBoat.autoTrim ? 8 : (myBoat.trimAngleDeg / 90) * 22;
  drawBoatShape(cx, cy, myBoat.headingDeg, hullColor, sailLean, myBoat.tackSign);
  if (myDirtyWind.exposure01 >= 0.12) {
    wctx.strokeStyle = myDirtyWind.type === "leeBow" ? "rgba(226,114,111,0.9)" : "rgba(240,197,129,0.85)";
    wctx.lineWidth = 2.5;
    wctx.beginPath(); wctx.arc(cx, cy, 17 + myDirtyWind.exposure01 * 8, 0, TAU); wctx.stroke();
  }
  wctx.fillStyle = "rgba(226,236,233,0.75)"; wctx.font = "10.5px 'IBM Plex Mono', monospace"; wctx.textAlign = "center";
  wctx.fillText("YOU", cx, cy - 28);
}

// ---------- HUD text ----------
const elWind = document.getElementById("rWind");
const elTwa = document.getElementById("rTwa");
const elSpeed = document.getElementById("rSpeed");
const elHeading = document.getElementById("rHeading");
const elTack = document.getElementById("tackBadge");
const elStall = document.getElementById("stallBanner");
const elOcs = document.getElementById("ocsBanner");
const elPenalty = document.getElementById("penaltyBanner");
const elPenaltyRule = document.getElementById("penaltyRule");
const elPenaltyDeg = document.getElementById("penaltyDeg");
const elDirtyWind = document.getElementById("dirtyWindBanner");
const elTapeReadout = document.getElementById("tapeReadout");
const elTrimReadout = document.getElementById("trimReadout");
const elRaceClock = document.getElementById("raceClock");
const elRaceLeg = document.getElementById("raceLeg");
const elMarkArrow = document.getElementById("markArrow");
const elMarkDist = document.getElementById("markDist");
const elFleet = document.getElementById("fleetCard");

function fmtClock(sec) {
  sec = Math.max(0, Math.ceil(sec));
  const m = Math.floor(sec / 60), s = sec % 60;
  return m + ":" + (s < 10 ? "0" : "") + s;
}

function updateMarkPointer(mark) {
  elMarkArrow.style.opacity = 1;
  const bearing = bearingTo(myBoat.worldX, myBoat.worldY, mark.x, mark.y);
  const rel = wrap180(bearing - myBoat.headingDeg);
  elMarkArrow.style.transform = "rotate(" + rel + "deg)";
  elMarkDist.textContent = Math.round(dist(myBoat.worldX, myBoat.worldY, mark.x, mark.y)) + "m";
}

function updateRaceHud() {
  if (roomStatus === "lobby" || !myInitialized) {
    elRaceClock.textContent = "LOBBY"; elRaceLeg.textContent = "waiting to start";
    elMarkArrow.style.opacity = 0; elMarkDist.textContent = "";
    elOcs.classList.remove("show");
    return;
  }
  if (myRace.status === "finished") {
    const place = myRace.place === 1 ? "1st" : myRace.place === 2 ? "2nd" : myRace.place === 3 ? "3rd" : (myRace.place + "th");
    elRaceClock.textContent = "FINISHED — " + place + " · " + (myRace.finishTime || 0).toFixed(1) + "s";
    elRaceLeg.textContent = "next race starts automatically";
    elMarkArrow.style.opacity = 0; elMarkDist.textContent = "";
  } else if (raceClock < PRESTART_SECONDS) {
    elRaceClock.textContent = "PRESTART · " + fmtClock(PRESTART_SECONDS - raceClock);
    elRaceLeg.textContent = myRace.ocs ? "OCS — get back below the line" : "→ start line";
    updateMarkPointer({ x: (startLine.pinX + startLine.boatEndX) / 2, y: startLine.y });
  } else {
    elRaceClock.textContent = "RACE · " + fmtClock(raceClock - PRESTART_SECONDS);
    elRaceLeg.textContent = myRace.leg === 1 ? "→ windward mark" : "→ finish";
    updateMarkPointer(currentMarkFor(myRace.leg));
  }
  elOcs.classList.toggle("show", myRace.ocs && raceClock < PRESTART_SECONDS);
  elPenalty.classList.toggle("show", myRace.penalty.active);
  if (myRace.penalty.active) {
    elPenaltyRule.textContent = myRace.penalty.rule;
    elPenaltyDeg.textContent = " " + Math.round(myRace.penalty.turnedDeg) + "°/360°";
  }
}

function statusLabel(b) {
  if (b.race.penalty.active) return "PENALTY " + Math.round(b.race.penalty.turnedDeg) + "°";
  if (b.race.status === "finished") return "FINISHED " + (b.race.place ? "#" + b.race.place : "");
  if (roomStatus === "lobby") return "lobby";
  if (raceClock < PRESTART_SECONDS) return b.race.ocs ? "OCS" : "prestart";
  return "leg " + b.race.leg;
}

function updateFleetCard() {
  const boats = lastSnapshotBoats.slice().sort((a, b) => {
    const pa = a.race.place, pb = b.race.place;
    if (pa && pb) return pa - pb;
    if (pa) return -1;
    if (pb) return 1;
    return a.boatIndex - b.boatIndex;
  });
  elFleet.innerHTML = "";
  boats.forEach(b => {
    const row = document.createElement("div");
    row.className = "fleet-row" + (b.boatIndex === myBoatIndex ? " me" : "");
    row.innerHTML =
      '<span class="place">' + (b.race.place || "") + '</span>' +
      '<span class="dot" style="background:' + b.color + '; opacity:' + (b.connected ? 1 : 0.35) + '"></span>' +
      '<span class="nm">' + escapeHtml(b.name) + (b.connected ? "" : " (left)") + '</span>' +
      '<span class="st">' + statusLabel(b) + '</span>';
    elFleet.appendChild(row);
  });
}
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

function updateHud(info) {
  elWind.textContent = wind.speed.toFixed(1) + " kt @ " + Math.round(trueDeg(wind.dir)) + bearingSuffix();
  elTwa.textContent = Math.round(info.absTwa) + "°" + (info.inNoGo ? " (pinching)" : "");
  elTwa.classList.toggle("warn", info.drifting);
  elSpeed.textContent = myBoat.speedKnots.toFixed(1) + " kt" + (info.drifting && myBoat.speedKnots < -0.05 ? " (sternway)" : "");
  elSpeed.classList.toggle("warn", info.drifting);
  elHeading.textContent = Math.round(trueDeg(myBoat.headingDeg)) + bearingSuffix();
  elTack.textContent = myBoat.tackSign > 0 ? "STARBOARD TACK" : "PORT TACK";
  elTack.className = "tack-badge " + (myBoat.tackSign > 0 ? "starboard" : "port");
  elStall.textContent = myBoat.speedKnots < -0.05 ? "IN IRONS — DRIFTING BACKWARD" : "IN IRONS — NO DRIVE";
  elStall.classList.toggle("show", info.drifting);
  elTapeReadout.textContent = Math.round(trueDeg(myBoat.headingDeg)) + "° → " + Math.round(trueDeg(myBoat.targetHeadingDeg)) + "°";
  elTrimReadout.textContent = myBoat.autoTrim ? "auto" : Math.round(myBoat.trimAngleDeg) + "° · " + Math.round(myBoat.trimEfficiency01 * 100) + "%";
  const dirty = myDirtyWind.exposure01 >= 0.12;
  elDirtyWind.classList.toggle("show", dirty);
  if (dirty) {
    const source = lastSnapshotBoats.find(b => b.boatIndex === myDirtyWind.sourceBoatIndex);
    const label = myDirtyWind.type === "leeBow" ? "LEE BOW — BACKWINDED"
      : myDirtyWind.type === "directWake" ? "DIRECT WAKE" : "DIRTY AIR";
    elDirtyWind.textContent = label + (source ? " BY " + String(source.name || "BOAT").toUpperCase() : "")
      + " · −" + myDirtyWind.speedDeficitKnots.toFixed(1) + " KT";
  }
}

// ---------- main loop ----------
let lastFrameT = performance.now();
function frame(now) {
  const dt = clamp((now - lastFrameT) / 1000, 0, 1 / 20);
  lastFrameT = now;
  const info = stepLocalPrediction(dt);
  updateAutoZoom();
  drawWorld(info, dt);
  drawTape();
  drawTrim();
  updateHud(info);
  updateRaceHud();
  updateFleetCard();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

window.addEventListener("beforeunload", () => { intentionalClose = true; try { ws && ws.close(); } catch { /* noop */ } });
