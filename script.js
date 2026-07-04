(function () {
  "use strict";

  const TELEMETRY_URL = "/telemetry";
  const VIDEO_URL = "/video_feed";
  const POLL_MS = 100;
  const FETCH_TIMEOUT_MS = 1200;
  const CAMERA_RECONNECT_MS = 1800;
  const MAX_PATH_POINTS = 900;

  const ids = [
    "gpsStatus", "gpsMeta", "telemetryStatus", "telemetryMeta", "headerAltitude",
    "headerBattery", "batteryMeta", "cameraStatus", "feedFps", "feedSignal",
    "videoTimestamp", "payloadMeta", "frameSync", "cameraWarning", "gpsLockIndicator",
    "centerMap", "positionHealth", "lat", "lon", "satellites", "fixQuality",
    "temperature", "humidity", "pressure", "altitude", "horizonInner", "pitch",
    "roll", "yaw", "powerHealth", "batteryFill", "batteryLabel", "battery",
    "voltage", "missionHealth", "powerState", "connectionStatus", "missionTime",
    "packetCount", "signalStrength", "lastUpdate", "systemLog", "latency",
    "footerPackets", "footerSignal", "firmware", "piStatus", "espStatus",
    "cameraFooter", "fullscreenToggle", "gpsMap", "videoFeed"
  ];

  const el = {};
  for (const id of ids) el[id] = document.getElementById(id);

  const state = {
    connected: false,
    cameraOnline: false,
    inFlight: false,
    pollTimer: 0,
    cameraTimer: 0,
    lastTelemetryAt: 0,
    lastPacketCount: null,
    lastGps: null,
    firstGps: null,
    path: [],
    autoCenter: true,
    map: null,
    marker: null,
    polyline: null,
    fallbackPin: null,
    events: [],
    flags: {
      gpsLocked: false,
      weakSignal: false,
      cameraConnected: false
    }
  };

  boot();

  function boot() {
    addEvent("System Online", "info");
    setupCamera();
    setupFullscreen();
    setupMapControls();
    updateClockOverlay();
    setInterval(updateClockOverlay, 500);
    initMap();
    pollTelemetry();
    state.pollTimer = setInterval(pollTelemetry, POLL_MS);
  }

  async function pollTelemetry() {
    if (state.inFlight) return;

    state.inFlight = true;
    const started = performance.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      const response = await fetch(TELEMETRY_URL, {
        cache: "no-store",
        headers: { Accept: "application/json" },
        signal: controller.signal
      });

      if (!response.ok) throw new Error("Telemetry HTTP " + response.status);
      const packet = await response.json();
      const latency = Math.max(0, Math.round(performance.now() - started));
      handleTelemetry(packet, latency);
    } catch (error) {
      handleTelemetryError();
    } finally {
      clearTimeout(timeout);
      state.inFlight = false;
    }
  }

  function handleTelemetry(packet, latency) {
    if (!state.connected) addEvent("Telemetry Connected", "info");
    state.connected = true;
    state.lastTelemetryAt = Date.now();
    document.body.dataset.connection = "online";

    const gps = {
      lat: firstNumber(packet, "latitude", "lat"),
      lon: firstNumber(packet, "longitude", "lon"),
      satellites: firstInteger(packet, "gps_satellites", "sats")
    };
    const hasGps = Number.isFinite(gps.lat) && Number.isFinite(gps.lon) && gps.satellites > 0;
    const signal = clamp(firstNumber(packet, "signal", "rssi"), 0, 100);
    const battery = clamp(firstNumber(packet, "battery", "batt"), 0, 100);
    const voltage = firstNumber(packet, "voltage");
    const packets = firstInteger(packet, "packets", "packet");
    const status = textValue(packet.status, "CONNECTED").toUpperCase();
    const altitude = firstNumber(packet, "altitude", "alt");
    const temperature = firstNumber(packet, "temperature", "temp");
    const humidity = firstNumber(packet, "humidity", "hum");
    const pressure = firstNumber(packet, "pressure", "pres");

    setText("telemetryStatus", "CONNECTED");
    setText("telemetryMeta", "100 MS POLL");
    setText("connectionStatus", "CONNECTED");
    setText("piStatus", "ONLINE");
    setText("espStatus", status);
    el.telemetryStatus && el.telemetryStatus.classList.remove("is-stale");

    setText("gpsStatus", hasGps ? "LOCKED" : "NO FIX");
    setText("gpsMeta", Number.isFinite(gps.satellites) ? gps.satellites + " SAT" : "-- SAT");
    setText("positionHealth", hasGps ? "GPS LOCK" : "GPS SEARCH");
    setText("gpsLockIndicator", hasGps ? "GPS LOCK" : "GPS WAIT");
    setText("fixQuality", hasGps ? "3D FIX" : "NO FIX");
    setText("lat", hasGps ? gps.lat.toFixed(6) : "--");
    setText("lon", hasGps ? gps.lon.toFixed(6) : "--");
    setText("satellites", Number.isFinite(gps.satellites) ? gps.satellites : "--");

    setNumber("temperature", temperature, 1);
    setNumber("humidity", humidity, 0);
    setNumber("pressure", pressure, 0);
    setNumber("altitude", altitude, 1);
    setNumber("headerAltitude", altitude, 1);

    const pitch = firstNumber(packet, "pitch");
    const roll = firstNumber(packet, "roll");
    const yaw = firstNumber(packet, "yaw", "hdg");
    setText("pitch", Number.isFinite(pitch) ? pitch.toFixed(1) : "--");
    setText("roll", Number.isFinite(roll) ? roll.toFixed(1) : "--");
    setText("yaw", Number.isFinite(yaw) ? normalizeDegrees(yaw).toFixed(0) : "--");
    updateHorizon(pitch, roll);

    setText("headerBattery", Number.isFinite(battery) ? battery.toFixed(0) : "--");
    setText("battery", Number.isFinite(battery) ? battery.toFixed(0) : "--");
    setText("batteryLabel", Number.isFinite(battery) ? battery.toFixed(0) + "%" : "--%");
    setText("batteryMeta", Number.isFinite(voltage) ? voltage.toFixed(2) + " V" : "-- V");
    setText("voltage", Number.isFinite(voltage) ? voltage.toFixed(2) : "--");
    updateBattery(battery);

    const health = missionHealth(battery, signal, status);
    setText("missionHealth", health);
    setText("powerHealth", Number.isFinite(voltage) ? "BUS STABLE" : "BUS WAIT");
    setText("powerState", Number.isFinite(battery) ? (battery < 20 ? "LOW" : "NOMINAL") : "WAIT");

    setText("missionTime", formatMissionTime(packet.mission_time));
    setText("packetCount", Number.isFinite(packets) ? packets.toLocaleString("en-US") : "--");
    setText("footerPackets", Number.isFinite(packets) ? packets.toLocaleString("en-US") : "--");
    setText("signalStrength", Number.isFinite(signal) ? signal.toFixed(0) + "%" : "--%");
    setText("footerSignal", Number.isFinite(signal) ? signal.toFixed(0) + "%" : "--%");
    setText("feedSignal", Number.isFinite(signal) ? "SIG " + signal.toFixed(0) + "%" : "SIG --%");
    setText("feedFps", formatFps(packet));
    setText("firmware", textValue(packet.firmware || packet.fw_version || packet.version, "--"));
    setText("latency", latency + " ms");
    setText("lastUpdate", formatUtcTime(new Date()));
    setText("frameSync", Number.isFinite(packets) ? "PACKET " + String(packets).padStart(7, "0") : "WAITING");
    setText("payloadMeta", hasGps ? gps.lat.toFixed(6) + ", " + gps.lon.toFixed(6) : "--, --");

    if (hasGps) updateGps(gps.lat, gps.lon);
    evaluateEvents({ hasGps, signal, packets });
  }

  function handleTelemetryError() {
    if (state.connected) {
      addEvent("Packet Loss Detected", "warning");
      addEvent("Telemetry Disconnected", "danger");
    }

    state.connected = false;
    document.body.dataset.connection = "offline";
    setText("telemetryStatus", "DISCONNECTED");
    setText("telemetryMeta", "RECONNECTING");
    setText("connectionStatus", "DISCONNECTED");
    setText("piStatus", "DISCONNECTED");
    setText("espStatus", "NO DATA");
    el.telemetryStatus && el.telemetryStatus.classList.add("is-stale");
  }

  function evaluateEvents(next) {
    if (next.hasGps && !state.flags.gpsLocked) addEvent("GPS Lock Acquired", "info");
    if (!next.hasGps && state.flags.gpsLocked) addEvent("GPS Lost", "warning");
    state.flags.gpsLocked = next.hasGps;

    if (Number.isFinite(next.signal) && next.signal < 35 && !state.flags.weakSignal) {
      addEvent("Signal Weak", "warning");
      state.flags.weakSignal = true;
    }
    if (Number.isFinite(next.signal) && next.signal > 50) state.flags.weakSignal = false;

    if (
      Number.isFinite(next.packets) &&
      Number.isFinite(state.lastPacketCount) &&
      next.packets < state.lastPacketCount
    ) {
      addEvent("Packet Loss Detected", "warning");
    }
    if (Number.isFinite(next.packets)) state.lastPacketCount = next.packets;
  }

  function setupCamera() {
    if (!el.videoFeed) return;

    el.videoFeed.addEventListener("load", () => {
      if (!state.cameraOnline) addEvent("Camera Connected", "info");
      state.cameraOnline = true;
      state.flags.cameraConnected = true;
      document.body.dataset.camera = "online";
      setText("cameraStatus", "LIVE");
      setText("cameraFooter", "ONLINE");
      clearTimeout(state.cameraTimer);
    });

    el.videoFeed.addEventListener("error", reconnectCamera);
    el.videoFeed.src = VIDEO_URL;
    clearTimeout(state.cameraTimer);
    state.cameraTimer = setTimeout(() => {
      if (!state.cameraOnline) reconnectCamera();
    }, CAMERA_RECONNECT_MS);
  }

  function reconnectCamera() {
    if (state.cameraOnline) addEvent("Camera Disconnected", "danger");
    state.cameraOnline = false;
    document.body.dataset.camera = "offline";
    setText("cameraStatus", "RECONNECTING");
    setText("cameraFooter", "RECONNECTING");

    clearTimeout(state.cameraTimer);
    state.cameraTimer = setTimeout(() => {
      if (!el.videoFeed) return;
      el.videoFeed.src = VIDEO_URL + "?t=" + Date.now();
    }, CAMERA_RECONNECT_MS);
  }

  function initMap() {
    if (window.L && el.gpsMap) {
      state.map = L.map(el.gpsMap, {
        zoomControl: true,
        attributionControl: true,
        preferCanvas: true
      }).setView([0, 0], 2);

      createOfflineTileLayer().addTo(state.map);

      state.polyline = L.polyline([], {
        color: "#63ff9f",
        weight: 3,
        opacity: 0.88
      }).addTo(state.map);

      state.marker = L.marker([0, 0], {
        icon: L.divIcon({
          className: "",
          html: '<div class="gps-marker"></div>',
          iconSize: [18, 18],
          iconAnchor: [9, 9]
        })
      }).addTo(state.map);
      return;
    }

    if (!el.gpsMap) return;
    const pin = document.createElement("div");
    pin.className = "map-fallback-pin";
    const label = document.createElement("div");
    label.className = "map-fallback-label";
    label.textContent = "LEAFLET OFFLINE / GPS TRAIL STANDBY";
    el.gpsMap.append(pin, label);
    state.fallbackPin = pin;
  }

  function setupMapControls() {
    if (!el.centerMap) return;
    el.centerMap.addEventListener("click", () => {
      state.autoCenter = true;
      if (state.lastGps && state.map) state.map.setView([state.lastGps.lat, state.lastGps.lon], Math.max(state.map.getZoom(), 16));
    });
  }

  function createOfflineTileLayer() {
    const OfflineTileLayer = L.GridLayer.extend({
      createTile: function (coords) {
        const tile = document.createElement("canvas");
        const size = this.getTileSize();
        tile.width = size.x;
        tile.height = size.y;

        const ctx = tile.getContext("2d");
        const seed = Math.abs((coords.x * 73856093) ^ (coords.y * 19349663) ^ (coords.z * 83492791));
        const base = 7 + (seed % 13);
        ctx.fillStyle = "rgb(" + base + "," + (base + 10) + "," + (base + 8) + ")";
        ctx.fillRect(0, 0, size.x, size.y);

        for (let i = 0; i < 34; i += 1) {
          const x = (seed * (i + 3) * 17) % size.x;
          const y = (seed * (i + 5) * 29) % size.y;
          const radius = 16 + ((seed + i * 11) % 58);
          const alpha = 0.018 + ((seed + i) % 9) / 900;
          const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius);
          gradient.addColorStop(0, "rgba(88,199,255," + alpha + ")");
          gradient.addColorStop(1, "rgba(0,0,0,0)");
          ctx.fillStyle = gradient;
          ctx.fillRect(0, 0, size.x, size.y);
        }

        ctx.strokeStyle = "rgba(99,255,159,0.08)";
        ctx.lineWidth = 1;
        for (let line = 0; line <= size.x; line += 64) {
          ctx.beginPath();
          ctx.moveTo(line, 0);
          ctx.lineTo(line, size.y);
          ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(0, line);
          ctx.lineTo(size.x, line);
          ctx.stroke();
        }

        ctx.strokeStyle = "rgba(88,199,255,0.07)";
        ctx.beginPath();
        ctx.moveTo(0, (seed % 180) + 24);
        ctx.bezierCurveTo(70, 30 + (seed % 70), 160, 220 - (seed % 90), size.x, 90 + (seed % 120));
        ctx.stroke();

        return tile;
      }
    });

    return new OfflineTileLayer({
      attribution: "Offline tactical map",
      tileSize: 256
    });
  }

  function updateGps(lat, lon) {
    state.lastGps = { lat, lon };
    if (!state.firstGps) state.firstGps = { lat, lon };

    state.path.push([lat, lon]);
    if (state.path.length > MAX_PATH_POINTS) state.path.shift();

    if (state.map && state.marker && state.polyline) {
      state.marker.setLatLng([lat, lon]);
      state.polyline.setLatLngs(state.path);
      if (state.autoCenter) state.map.setView([lat, lon], Math.max(state.map.getZoom(), 16), { animate: true });
      return;
    }

    if (state.fallbackPin && state.firstGps) {
      const scale = 0.002;
      const x = clamp(50 + ((lon - state.firstGps.lon) / scale) * 40, 8, 92);
      const y = clamp(50 - ((lat - state.firstGps.lat) / scale) * 40, 8, 92);
      el.gpsMap.style.setProperty("--pin-x", x + "%");
      el.gpsMap.style.setProperty("--pin-y", y + "%");
    }
  }

  function setupFullscreen() {
    if (!el.fullscreenToggle) return;
    el.fullscreenToggle.addEventListener("click", async () => {
      try {
        if (!document.fullscreenElement) {
          await document.documentElement.requestFullscreen();
          setText("fullscreenToggle", "EXIT");
        } else {
          await document.exitFullscreen();
          setText("fullscreenToggle", "FULLSCREEN");
        }
      } catch (error) {
        addEvent("Fullscreen Unavailable", "warning");
      }
    });

    document.addEventListener("fullscreenchange", () => {
      setText("fullscreenToggle", document.fullscreenElement ? "EXIT" : "FULLSCREEN");
    });
  }

  function updateClockOverlay() {
    setText("videoTimestamp", formatUtcTime(new Date()));
  }

  function updateHorizon(pitch, roll) {
    if (!el.horizonInner) return;
    const safePitch = Number.isFinite(pitch) ? clamp(pitch, -30, 30) : 0;
    const safeRoll = Number.isFinite(roll) ? clamp(roll, -90, 90) : 0;
    el.horizonInner.style.transform = "rotate(" + safeRoll + "deg) translateY(" + safePitch * 1.25 + "px)";
  }

  function updateBattery(value) {
    if (!el.batteryFill) return;
    const battery = Number.isFinite(value) ? clamp(value, 0, 100) : 0;
    el.batteryFill.style.height = battery + "%";
    if (battery < 20) {
      el.batteryFill.style.background = "linear-gradient(180deg, #ffd0d4, #ff4d5d)";
    } else if (battery < 45) {
      el.batteryFill.style.background = "linear-gradient(180deg, #fff0b0, #ffd166)";
    } else {
      el.batteryFill.style.background = "linear-gradient(180deg, #e8fff4, #63ff9f)";
    }
  }

  function missionHealth(battery, signal, status) {
    if (!state.connected) return "UNKNOWN";
    if (status !== "CONNECTED") return status;
    if (Number.isFinite(battery) && battery < 20) return "POWER LOW";
    if (Number.isFinite(signal) && signal < 35) return "SIGNAL WEAK";
    return "NOMINAL";
  }

  function addEvent(message, level) {
    const duplicate = state.events[0] && state.events[0].message === message;
    if (duplicate) return;

    state.events.unshift({
      message,
      level: level || "info",
      time: new Date()
    });
    state.events = state.events.slice(0, 42);
    renderLog();
  }

  function renderLog() {
    if (!el.systemLog) return;
    el.systemLog.innerHTML = state.events
      .map((entry) => {
        return '<div class="log-entry ' + entry.level + '">' +
          "<time>" + formatUtcTime(entry.time) + "</time>" +
          "<span>" + escapeHtml(entry.message) + "</span>" +
          "</div>";
      })
      .join("");
  }

  function setNumber(id, value, decimals) {
    const number = numberValue(value);
    setText(id, Number.isFinite(number) ? number.toFixed(decimals) : "--");
  }

  function setText(id, value) {
    if (!el[id]) return;
    const next = String(value);
    if (el[id].textContent !== next) el[id].textContent = next;
  }

  function firstNumber(packet, ...keys) {
    for (const key of keys) {
      const number = numberValue(packet[key]);
      if (Number.isFinite(number)) return number;
    }
    return NaN;
  }

  function firstInteger(packet, ...keys) {
    const number = firstNumber(packet, ...keys);
    return Number.isFinite(number) ? Math.round(number) : NaN;
  }

  function numberValue(value) {
    if (value === null || value === undefined || value === "") return NaN;
    const number = Number(value);
    return Number.isFinite(number) ? number : NaN;
  }

  function integerValue(value) {
    const number = numberValue(value);
    return Number.isFinite(number) ? Math.round(number) : NaN;
  }

  function textValue(value, fallback) {
    return typeof value === "string" && value.trim() ? value.trim() : fallback;
  }

  function formatMissionTime(value) {
    const seconds = integerValue(value);
    if (!Number.isFinite(seconds)) return "--:--:--";
    const safe = Math.max(0, seconds);
    const hours = Math.floor(safe / 3600);
    const minutes = Math.floor((safe % 3600) / 60);
    const secs = safe % 60;
    return pad(hours) + ":" + pad(minutes) + ":" + pad(secs);
  }

  function formatFps(packet) {
    const fps = numberValue(packet.camera_fps ?? packet.fps ?? packet.video_fps);
    return Number.isFinite(fps) ? "FPS " + fps.toFixed(1) : "FPS --";
  }

  function formatUtcTime(date) {
    return pad(date.getUTCHours()) + ":" + pad(date.getUTCMinutes()) + ":" + pad(date.getUTCSeconds()) + " UTC";
  }

  function normalizeDegrees(value) {
    return ((value % 360) + 360) % 360;
  }

  function clamp(value, min, max) {
    if (!Number.isFinite(value)) return NaN;
    return Math.max(min, Math.min(max, value));
  }

  function pad(value) {
    return String(value).padStart(2, "0");
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }
})();
