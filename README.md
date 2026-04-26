# UltraVision — SeeTrue glasses + Daemon Chrome extension

**Combined stack**: gaze, pupil size, and hand gestures from SeeTrue
eye-tracking glasses decide when a YouTube Short gets auto-skipped.
Daemon's webcam complements this with rPPG heart rate, facial
expressions, and head pose.

The eye-tracking glasses are the **primary signal** in every part of the
system — pupil dilation, gaze position, saccades, fixations, and the hand
gestures captured by the glasses' front-facing scene camera. The webcam
is a complementary signal source and a fallback when the glasses are not
worn.

## What the system does

You open YouTube Shorts wearing the glasses. A meter bar appears on the
screen. When the signals say the video isn't engaging — pupil shrinks,
gaze drifts off-screen, brows lower, smile fades — a thin pink
pre-action progress bar starts to fill. If the signal lasts about 1
second, the video auto-skips to the next.

Hand gestures in front of the glasses' scene camera override the
algorithm:

- **Hand down** = skip now
- **Hand up** = back to the previous video
- **Head shake** = forced skip
- **Head nod** = keep this video longer

## Architecture at a glance

```
┌──────────────────┐         ┌──────────────────┐         ┌──────────────────┐
│ SeeTrue glasses  │  ZMQ    │ python/gaze_    │   WS    │ Daemon Chrome   │
│ (device)         │────────▶│ bridge/         │────────▶│ extension       │
│                  │  3428   │ bridge.py       │  8765   │ (daemon-       │
│ · gaze           │  3425   │                  │         │  extension/)   │
│ · pupils         │         │ · UDP handshake │         │                 │
│ · scene camera   │         │ · sync ZMQ pull │         │ · rPPG HR      │
└──────────────────┘         │ · hand gestures │         │ · expressions  │
                             │ · 1 Hz heartbeat│         │ · head pose    │
                             │ · WS pub/sub    │         │ · Shorts skip  │
                             │ · cv2 windows   │         │                 │
                             └──────────────────┘         └──────────────────┘
```

The bridge also opens two native cv2 windows: the live SeeTrue scene
camera with a real-time gaze crosshair, and the Daemon-streamed laptop
webcam (Daemon owns the camera, encodes JPEG, streams over the same
WebSocket — avoids Windows webcam-contention).

## Install on a fresh machine

```bash
git clone https://github.com/NooaL1/ultravision_chrome_extnsion.git
cd ultravision_chrome_extnsion
```

### Python side (bridge)

```bash
pip install websockets pyzmq mediapipe opencv-python numpy
```

### Chrome extension

1. Open `chrome://extensions`
2. Enable Developer mode (top right)
3. Click "Load unpacked"
4. Pick the `daemon-extension/` folder from this checkout
5. Daemon shows up in the toolbar

## Startup

### 1. Power up the SeeTrue device

- Plug in the glasses and start `SeeTrueEyeServer.exe` on the device's
  computer (it listens on port 3429 by default; the device shows its IP
  on its screen)
- Make sure your laptop and the SeeTrue computer are on the **same
  network**

### 2. Start the bridge

```powershell
python python/gaze_bridge/bridge.py --remote_ip 172.20.10.3
```

Replace `--remote_ip` with the SeeTrue device's actual IP. The bridge
performs the UDP handshake automatically (sendEyeTrackerTypeData →
setEyeTrackerDevice → runPictureProcessing). You should see in the log:

```
[preflight] ✓ 172.20.10.3 responded to ping
[handshake] kicking SeeTrueEyeServer at 172.20.10.3:3429
[ZMQ] gaze parsed #1: {pupilL: 2.84, pupilR: 4.19, ...}
[Gesture] frame #1 (188 KB)
[WS] client connected
```

Two cv2 windows pop up:
- **Lasien kamera + gaze** — live scene camera + pink gaze crosshair
- **Webcam (Daemonin lähetys)** — placeholder until Daemon connects

Headless mode: pass `--no-display` if you only need the WebSocket bridge
and want no windows.

### 3. Start Daemon

- Click the Daemon icon in the Chrome toolbar → Engine ON
- Allow webcam access
- A pink pill shows up on every page; click it to expand the sci-fi
  panel (CARDIO, ROI, blendshapes, EMOTION, BPM TREND, **SEETRUE**)
- The SEETRUE section shows pupil bars, saccades, and connection status
  (green `live · N/s` = good; amber `bridge ✓ · SeeTrue silent` = bridge
  up but glasses silent; red `bridge offline` = bridge not running)

### 4. Open YouTube Shorts

```
https://www.youtube.com/shorts
```

A meter appears in the lower-left. The algorithm starts immediately, but
the **first ~30 seconds collect baselines** — don't be surprised if
boring clips don't skip right away. After baseline, it reacts faster.

## Key files

| Path | What it does |
|------|--------------|
| `python/gaze_bridge/bridge.py` | SeeTrue ↔ WebSocket bridge. UDP handshake, ZMQ recv subprocess, hand gestures, heartbeat, native cv2 windows. |
| `python/simple_gaze_receiver/main.py` | Original SeeTrue receiver (reference, not used by bridge) |
| `python/gaze_data_simulator/simulator.py` | Sends fake gaze data for testing without the device |
| `daemon-extension/manifest.json` | Chrome extension manifest (MV3) |
| `daemon-extension/offscreen.js` | Webcam + MediaPipe + WebGazer + WebSocket fusion |
| `daemon-extension/content.js` | Sci-fi HUD panel injected into every page |
| `daemon-extension/shorts.js` | YouTube Shorts auto-skip algorithm |
| `daemon-extension/background.js` | Service worker that relays messages offscreen ↔ tabs |
| `API/SeeTrue Client API description v2.0.pdf` | Official SeeTrue API documentation |

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `[ZMQ] still waiting for first gaze sample` | Check IP, network, that `SeeTrueEyeServer.exe` is running |
| `[preflight] ⚠ X did not respond to ping` | You're on a different network than the glasses. Switch WiFi or check IP via `arp -a` |
| Daemon HUD shows red `bridge offline` | Bridge isn't running or crashed; restart it |
| HUD shows amber `bridge ✓ · SeeTrue silent` | Bridge is up but glasses aren't sending → calibrate, check USB cable |
| Hand gestures don't trigger Shorts | Reload Daemon at `chrome://extensions` → ⟳. Bridge log should show `[Gesture] OPEN-SWIPE NEXT` or `[Gesture] SWIPE NEXT` |
| Shorts won't skip even at max sensitivity | Wait ~30 s for baseline. Open Shorts page F12 console for `[content] ticks=` and `[shorts] SeeTrue gesture:` logs |
| Too much memory used | Pass `--no-display` (already default to no-webcam) and `--no-gesture` if you don't need hand gestures |
| Webcam window full of color noise | Webcam-contention: kill all old python processes (`taskkill /F /IM python.exe`) and restart bridge so Daemon owns the camera and streams it via WebSocket |

## Algorithm overview (shorts.js)

Research-backed multi-modal disinterest detector:

1. **Per-user z-score baselines** with Welford + EWMA for every signal
   (pupil, blink, AU4 brow-down, AU12 smile, head yaw/pitch, saccade
   rate, HR)
2. **Multi-modal AND-gate**: at least 1–2 modalities must exceed the
   threshold before triggering
3. **Schmitt-trigger hysteresis**: T_high → arm, T_low → disarm
4. **Dwell time 0.25–1.5 s** before action (matches human reaction time)
5. **Pre-action indicator** shows when a skip is coming → user can pull
   their hand up or focus on the video → Schmitt disarms
6. **Confidence floor**: when all signals are at baseline, nothing
   happens (turned off at high sensitivity)
7. **Skip cap**: at most 25–100 % of videos can be auto-skipped per
   session (configurable via the sensitivity slider)

Weights from the research recommendations:
yaw 0.20, gazeOff 0.20, pupil 0.15, blink 0.10, AU4 0.10, AU43 0.10,
smile -0.10, sacc 0.05, HR 0.05, pitch 0.10.

## Licensing

Internal prototype — no public license yet. Don't redistribute.

Vendored third-party libraries:
- MediaPipe (Apache-2.0) — `daemon-extension/wasm/`, `daemon-extension/lib/vision_bundle.mjs`
- WebGazer.js (LGPL-3.0) — `daemon-extension/lib/webgazer.min.js`
- YOLOv8 (Ultralytics, AGPL-3.0) — `yolov8s-world.pt` (only used inside `simple_gaze_receiver`)
- SeeTrue API — © SeeTrue Technologies

## Development

```bash
# Edit daemon-extension/ inside the repo
# Reload in Chrome: chrome://extensions → Daemon → ⟳

# Bridge changes:
# Edit python/gaze_bridge/bridge.py → Ctrl+C the bridge → restart

git add .
git commit -m "..."
git push
```
