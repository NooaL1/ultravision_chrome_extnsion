# Gaze Attractiveness Meter — Chrome Extension

Detects faces on any web page and rates them 1–10 based on your **pupil dilation** and **gaze fixation** while you look at them. Uses your SeeTrue eye tracker via a local WebSocket bridge.

## Setup

### 1. Install Python deps for the bridge

```bash
pip install websockets pyzmq
```

### 2. Download face-api.js + tinyFaceDetector model

The extension needs two things in this folder:
- `face-api.min.js`
- `models/tiny_face_detector_model-weights_manifest.json` + `models/tiny_face_detector_model-shard1`

Easiest:

```bash
# face-api.min.js
curl -L -o extension/face-api.min.js https://justadudewhohacks.github.io/face-api.js/dist/face-api.min.js

# Tiny face detector model
mkdir -p extension/models
curl -L -o extension/models/tiny_face_detector_model-weights_manifest.json \
  https://justadudewhohacks.github.io/face-api.js/models/tiny_face_detector_model-weights_manifest.json
curl -L -o extension/models/tiny_face_detector_model-shard1 \
  https://justadudewhohacks.github.io/face-api.js/models/tiny_face_detector_model-shard1
```

### 3. Start the gaze bridge (alongside the eye tracker)

```bash
python python/gaze_bridge/bridge.py --remote_ip 192.168.10.201
```

You should see `[WS] listening on ws://localhost:8765`.

### 4. Load the extension in Chrome

1. Open `chrome://extensions/`
2. Toggle "Developer mode" (top right)
3. Click "Load unpacked"
4. Select the `extension/` folder
5. Pin the extension (optional)

### 5. Use it

1. Browse to any page with photos of people (LinkedIn, Wikipedia, news, etc.)
2. You should see a cyan circle = your live gaze cursor
3. Yellow rectangles appear around detected faces, with `?/10` badges
4. Look at a face for ~2 seconds → the badge updates with your score and the browser speaks it aloud

Cooldown 12 s before a face can be re-rated.

## Tuning

In `content.js`:

- `MEASURE_SEC` — measurement window (2 s default)
- `BASELINE_WINDOW` — pupil baseline window (8 s default)
- `COOLDOWN_SEC` — per-face re-score cooldown
- `scoreAttractiveness()` — adjust the weighting between pupil dilation and fixation

## Notes

- Gaze is mapped from normalised SeeTrue coords (0–1) to the viewport. There is **no per-screen calibration** — accuracy depends on the eye tracker's mounting.
- Faces are detected once per image; pages with infinite scroll will pick them up on the rescan interval.
- CORS-tainted images are skipped silently.
