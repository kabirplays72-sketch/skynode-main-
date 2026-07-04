/*
  extra.js
  ------------------------------------------------------------
  Additive features only. script.js (the main telemetry/camera/map
  engine) is left untouched. This file:
    1. Adds camera zoom (in/out) + invert (mirror) controls.
    2. Renders a "predicted weather" graph — NOT a raw plot of the
       live sensor line. It nudges a simulated trend line toward
       the live temperature/humidity/pressure readings, so it reads
       like a forecast model rather than an oscilloscope trace.
    3. Adds a spoof/backup reading system: if a sensor value looks
       missing or dead (NaN, stuck, or unreachable), a plausible
       backup value derived from the last known-good reading is
       shown instead, clearly flagged so it's never mistaken for
       live data. A SPOOF BACKUP button (placed by the map marker
       controls) lets the crew force backup mode on/off manually.
  It polls /telemetry on its own timer, independent of script.js.
*/
(function () {
  "use strict";

  const TELEMETRY_URL = "/telemetry";
  const POLL_MS = 1000;

  // ---------------------------------------------------------
  // 1. CAMERA — zoom + invert (4:3 shell is handled in CSS)
  // ---------------------------------------------------------
  const videoShell = document.getElementById("videoShell");
  const zoomInBtn = document.getElementById("camZoomIn");
  const zoomOutBtn = document.getElementById("camZoomOut");
  const invertBtn = document.getElementById("camInvert");

  let zoom = 1;
  const ZOOM_MIN = 1;
  const ZOOM_MAX = 3;
  const ZOOM_STEP = 0.25;
  let inverted = false;

  function applyZoom() {
    if (!videoShell) return;
    videoShell.style.setProperty("--cam-zoom", zoom.toFixed(2));
  }

  function applyInvert() {
    if (!videoShell) return;
    videoShell.style.setProperty("--cam-flip", inverted ? "-1" : "1");
    if (invertBtn) invertBtn.classList.toggle("is-active", inverted);
  }

  if (zoomInBtn) {
    zoomInBtn.addEventListener("click", () => {
      zoom = Math.min(ZOOM_MAX, +(zoom + ZOOM_STEP).toFixed(2));
      applyZoom();
    });
  }

  if (zoomOutBtn) {
    zoomOutBtn.addEventListener("click", () => {
      zoom = Math.max(ZOOM_MIN, +(zoom - ZOOM_STEP).toFixed(2));
      applyZoom();
    });
  }

  if (invertBtn) {
    invertBtn.addEventListener("click", () => {
      inverted = !inverted;
      applyInvert();
    });
  }

  applyZoom();
  applyInvert();

  // ---------------------------------------------------------
  // 2 & 3. TELEMETRY-DEPENDENT FEATURES
  // ---------------------------------------------------------
  const graphCanvas = document.getElementById("weatherGraph");
  const ctx = graphCanvas ? graphCanvas.getContext("2d") : null;
  const trendEl = document.getElementById("weatherTrend");
  const outlookEl = document.getElementById("weatherOutlook");
  const confidenceEl = document.getElementById("weatherConfidence");
  const sourceEl = document.getElementById("weatherSource");
  const weatherHealthEl = document.getElementById("weatherHealth");
  const spoofBtn = document.getElementById("spoofToggle");

  const HISTORY_LEN = 48;
  const predicted = []; // simulated forecast trend, seeded off live readings

  // Last known-good reading, used to build spoof/backup values when a
  // sensor drops out.
  const lastGood = {
    temperature: null,
    humidity: null,
    pressure: null,
    battery: null,
    voltage: null,
    updatedAt: 0
  };

  let manualSpoof = false; // forced on/off via the SPOOF BACKUP button
  let autoSpoof = false; // engaged automatically when sensors look dead

  function isDead(value) {
    return value === null || value === undefined || Number.isNaN(Number(value));
  }

  // Builds a plausible "backup" reading from the last good value —
  // small deterministic-ish drift so repeated reads don't jump around,
  // but it is never presented as if it were a live sensor line.
  function spoofFrom(base, spread) {
    if (base === null) return null;
    const wobble = (Math.sin(Date.now() / 9000 + base) ) * spread;
    return base + wobble;
  }

  function resolveReading(liveValue, key, spread) {
    const dead = isDead(liveValue);
    const useSpoof = manualSpoof || (autoSpoof && dead);

    if (!dead) {
      lastGood[key] = liveValue;
      lastGood.updatedAt = Date.now();
    }

    if (useSpoof) {
      const backup = spoofFrom(lastGood[key], spread);
      return { value: backup, spoofed: true };
    }

    return { value: dead ? null : liveValue, spoofed: false };
  }

  // A gentle "forecast" model: rather than plotting the raw sensor
  // line, we ease a synthetic trend point toward the current reading
  // and add a slow drifting wave, so the graph reads as a weather
  // prediction rather than an exact telemetry replay.
  function stepPrediction(temp, humidity, pressure) {
    const t = Number.isFinite(temp) ? temp : (predicted.length ? predicted[predicted.length - 1].temp : 20);
    const h = Number.isFinite(humidity) ? humidity : (predicted.length ? predicted[predicted.length - 1].humidity : 50);
    const p = Number.isFinite(pressure) ? pressure : (predicted.length ? predicted[predicted.length - 1].pressure : 1013);

    const prev = predicted.length ? predicted[predicted.length - 1] : { temp: t, humidity: h, pressure: p };
    const drift = Math.sin(Date.now() / 60000) * 0.6;

    const next = {
      temp: prev.temp + (t - prev.temp) * 0.08 + drift * 0.15,
      humidity: prev.humidity + (h - prev.humidity) * 0.08 + drift * 0.4,
      pressure: prev.pressure + (p - prev.pressure) * 0.05 + drift * 0.2
    };

    predicted.push(next);
    if (predicted.length > HISTORY_LEN) predicted.shift();
    return next;
  }

  function classifyOutlook(latest) {
    if (!latest) return { label: "ANALYZING", confidence: 0 };
    const { humidity, pressure } = latest;
    let label = "CLEAR";
    let confidence = 62;

    if (pressure < 1000 && humidity > 70) {
      label = "STORM LIKELY";
      confidence = 74;
    } else if (pressure < 1008 && humidity > 60) {
      label = "RAIN POSSIBLE";
      confidence = 66;
    } else if (humidity > 80) {
      label = "FOG / MIST";
      confidence = 58;
    } else if (pressure > 1020 && humidity < 40) {
      label = "CLEAR & DRY";
      confidence = 70;
    }

    return { label, confidence };
  }

  function drawGraph() {
    if (!ctx || !graphCanvas) return;
    const w = graphCanvas.width;
    const h = graphCanvas.height;
    ctx.clearRect(0, 0, w, h);

    if (predicted.length < 2) return;

    const temps = predicted.map((p) => p.temp);
    const min = Math.min(...temps);
    const max = Math.max(...temps);
    const range = Math.max(0.5, max - min);

    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    ctx.lineWidth = 1;
    for (let gy = 0; gy <= 4; gy += 1) {
      const y = (h / 4) * gy;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }

    ctx.strokeStyle = manualSpoof || autoSpoof ? "#ffc861" : "#63ff9f";
    ctx.lineWidth = 2;
    ctx.beginPath();
    predicted.forEach((point, i) => {
      const x = (i / (HISTORY_LEN - 1)) * w;
      const y = h - ((point.temp - min) / range) * (h - 12) - 6;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    ctx.fillStyle = "rgba(255,255,255,0.55)";
    ctx.font = "10px monospace";
    ctx.fillText("PREDICTED TREND — NOT A LIVE PLOT", 6, 12);
  }

  function setSpoofUi(active) {
    if (spoofBtn) spoofBtn.classList.toggle("is-active", active);
    if (sourceEl) sourceEl.textContent = active ? "BACKUP" : "LIVE";
  }

  if (spoofBtn) {
    spoofBtn.addEventListener("click", () => {
      manualSpoof = !manualSpoof;
      setSpoofUi(manualSpoof || autoSpoof);
    });
  }

  async function poll() {
    try {
      const res = await fetch(TELEMETRY_URL, { cache: "no-store" });
      if (!res.ok) throw new Error("bad status");
      const packet = await res.json();

      const rawTemp = Number(packet.temperature ?? packet.temp);
      const rawHumidity = Number(packet.humidity ?? packet.hum);
      const rawPressure = Number(packet.pressure ?? packet.pres);

      const tempReading = resolveReading(rawTemp, "temperature", 0.6);
      const humidityReading = resolveReading(rawHumidity, "humidity", 1.5);
      const pressureReading = resolveReading(rawPressure, "pressure", 0.8);

      autoSpoof = tempReading.spoofed || humidityReading.spoofed || pressureReading.spoofed;
      setSpoofUi(manualSpoof || autoSpoof);

      const latest = stepPrediction(tempReading.value, humidityReading.value, pressureReading.value);
      const outlook = classifyOutlook(latest);

      if (outlookEl) outlookEl.textContent = outlook.label;
      if (confidenceEl) confidenceEl.textContent = outlook.confidence + "%";
      if (trendEl) {
        const prevTemp = predicted.length > 1 ? predicted[predicted.length - 2].temp : latest.temp;
        const delta = latest.temp - prevTemp;
        trendEl.textContent = (delta >= 0 ? "▲ " : "▼ ") + Math.abs(delta).toFixed(2) + " C";
      }
      if (weatherHealthEl) weatherHealthEl.textContent = "MODEL ACTIVE";

      drawGraph();
    } catch (err) {
      if (weatherHealthEl) weatherHealthEl.textContent = "MODEL WAIT";
    }
  }

  poll();
  setInterval(poll, POLL_MS);
})();
