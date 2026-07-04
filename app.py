from flask import Flask, jsonify, Response, send_from_directory
import serial
import json
import threading
import cv2
import time
import os

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

app = Flask(__name__)

# ==========================
# CAMERA
# ==========================

camera = cv2.VideoCapture(0)


def generate_frames():
    while True:
        success, frame = camera.read()

        if not success:
            time.sleep(0.03)
            continue

        ret, buffer = cv2.imencode(".jpg", frame)

        if not ret:
            continue

        yield (
            b"--frame\r\n"
            b"Content-Type: image/jpeg\r\n\r\n" +
            buffer.tobytes() +
            b"\r\n"
        )


# ==========================
# DEFAULT TELEMETRY
# ==========================

latest = {
    "temperature": 0,
    "humidity": 0,
    "pressure": 0,
    "altitude": 0,
    "latitude": 0,
    "longitude": 0,
    "pitch": 0,
    "roll": 0,
    "yaw": 0,
    "battery": 100,
    "voltage": 4.2,
    "packets": 0,
    "signal": 100,
    "gps_satellites": 0,
    "mission_time": 0,
    "status": "CONNECTED",
}

start_time = time.time()


def first_present(data, *keys):
    for key in keys:
        if key in data and data[key] is not None:
            return data[key]
    return None


def normalize_telemetry(data):
    normalized = dict(data)

    aliases = {
        "temperature": ("temperature", "temp"),
        "humidity": ("humidity", "hum"),
        "pressure": ("pressure", "pres"),
        "altitude": ("altitude", "alt"),
        "latitude": ("latitude", "lat"),
        "longitude": ("longitude", "lon"),
        "gps_satellites": ("gps_satellites", "sats"),
        "packets": ("packets", "packet"),
        "battery": ("battery", "batt"),
        "signal": ("signal", "rssi"),
    }

    for target, keys in aliases.items():
        value = first_present(data, *keys)
        if value is not None:
            normalized[target] = value

    return normalized


# ==========================
# SERIAL READER
# ==========================

def serial_reader():
    global latest

    try:
        ser = serial.Serial("/dev/ttyUSB0", 115200, timeout=1)
        print("ESP32 Connected")
    except Exception as e:
        latest["status"] = "SERIAL_ERROR"
        print("Serial Error:", e)
        return

    packet_count = 0

    while True:
        try:
            line = ser.readline().decode(errors="ignore").strip()

            if not line:
                continue

            if line.startswith("{"):
                data = normalize_telemetry(json.loads(line))
                packet_count += 1
                latest.update(data)
                latest["packets"] = packet_count
                latest["mission_time"] = int(time.time() - start_time)
                latest["status"] = "CONNECTED"
        except Exception:
            pass


# ==========================
# DASHBOARD FILES
# ==========================

@app.route("/")
def home():
    return send_from_directory(BASE_DIR, "index.html")


@app.route("/styles.css")
def styles():
    return send_from_directory(BASE_DIR, "styles.css")


@app.route("/script.js")
def script():
    return send_from_directory(BASE_DIR, "script.js")


@app.route("/extra.js")
def extra_script():
    return send_from_directory(BASE_DIR, "extra.js")


# ==========================
# API ROUTES
# ==========================

@app.route("/telemetry")
def telemetry():
    latest["mission_time"] = int(time.time() - start_time)
    return jsonify(latest)


@app.route("/video_feed")
def video_feed():
    return Response(
        generate_frames(),
        mimetype="multipart/x-mixed-replace; boundary=frame",
    )


# ==========================
# START THREAD
# ==========================

threading.Thread(target=serial_reader, daemon=True).start()


# ==========================
# RUN SERVER
# ==========================

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, threaded=True)
