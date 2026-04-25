# bridge.py
"""
Bridges SeeTrue eye-tracker ZMQ stream to a local WebSocket so a
Chrome extension can read gaze + pupil data, plus runs MediaPipe
hand-tracking on the scene-cam feed in a separate process so the
cv2.imshow window works reliably on Windows.

Run alongside the eye tracker:
    python bridge.py --remote_ip 192.168.10.201
"""

import argparse
import asyncio
import collections
import json
import multiprocessing as mpr
import sys
import time

if sys.platform == "win32":
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

import zmq
import zmq.asyncio
from websockets.server import serve

WS_HOST       = "localhost"
WS_PORT       = 8765
GAZE_PORT     = 3428
SCENE_PORT    = 3425

SWIPE_COOLDOWN_S  = 0.7
PROCESS_EVERY_NTH = 1
PINCH_ON_DIST     = 0.06    # finger-tip distance (norm) below this = pinched
PINCH_OFF_DIST    = 0.10    # release threshold (hysteresis)
DRAG_THRESHOLD    = 0.10    # min Δy during pinch to count as a swipe

clients: set = set()


async def ws_handler(ws):
    clients.add(ws)
    print(f"[WS] client connected (total={len(clients)})")
    try:
        await ws.wait_closed()
    finally:
        clients.discard(ws)
        print(f"[WS] client disconnected (total={len(clients)})")


async def broadcast(msg: str):
    if not clients:
        return
    await asyncio.gather(
        *[c.send(msg) for c in clients], return_exceptions=True
    )


# ── Gaze loop (asyncio) ─────────────────────────────────────────────────────
async def gaze_loop(remote_ip: str):
    ctx  = zmq.asyncio.Context()
    sock = ctx.socket(zmq.PULL)
    sock.setsockopt(zmq.RCVHWM, 0)
    sock.connect(f"tcp://{remote_ip}:{GAZE_PORT}")
    print(f"[ZMQ] gaze PULL connected to tcp://{remote_ip}:{GAZE_PORT}")
    msg_count = 0
    while True:
        try:
            raw = await sock.recv_string()
            msg_count += 1
            fields = raw.strip().split(";")
            if len(fields) < 21:
                continue
            event = fields[20].strip()
            if event == "NA":
                continue
            data = {
                "ts":     float(fields[1]),
                "gx":     float(fields[2]),
                "gy":     float(fields[3]),
                "pupilL": float(fields[4]),
                "pupilR": float(fields[5]),
                "event":  event,
            }
            if msg_count <= 3:
                print(f"[ZMQ] gaze parsed: {data}")
            await broadcast(json.dumps(data))
        except (ValueError, IndexError):
            continue
        except Exception as exc:
            print(f"[ZMQ] gaze error: {exc}")


# ── Gesture worker subprocess (cv2.imshow safe in main thread) ──────────────
def gesture_worker(remote_ip: str, gesture_q):
    """Runs in its own process so cv2.imshow + cv2.waitKey work properly."""
    import zmq as zmq_local
    import numpy as np
    import cv2 as cv
    import mediapipe as mp

    ctx  = zmq_local.Context()
    sock = ctx.socket(zmq_local.PULL)
    sock.setsockopt(zmq_local.RCVHWM, 0)
    sock.connect(f"tcp://{remote_ip}:{SCENE_PORT}")
    print(f"[Gesture] subprocess connected to tcp://{remote_ip}:{SCENE_PORT}")

    hands  = mp.solutions.hands.Hands(
        max_num_hands=1, min_detection_confidence=0.55,
        min_tracking_confidence=0.45,
    )
    drawer = mp.solutions.drawing_utils
    style  = mp.solutions.drawing_styles

    cv.namedWindow("Gesture debug", cv.WINDOW_NORMAL)
    cv.resizeWindow("Gesture debug", 800, 600)

    last_swipe_ts    = 0.0
    last_swipe_label = ""
    last_swipe_at    = 0.0
    frame_idx        = 0

    # Pinch-grab state
    pinching      = False
    grab_start_y  = None   # wrist y when grab started
    current_y     = None
    pinch_dist    = 0.0

    while True:
        try:
            data = sock.recv()
        except Exception as exc:
            print(f"[Gesture] zmq recv error: {exc}")
            time.sleep(0.5); continue

        frame_idx += 1
        if frame_idx <= 3 or frame_idx % 60 == 0:
            print(f"[Gesture] frame #{frame_idx} ({len(data)} bytes)")
        if frame_idx % PROCESS_EVERY_NTH != 0:
            continue
        if len(data) <= 4:
            continue

        # SeeTrue scene-cam frames have a 4-byte big-endian header
        arr = np.frombuffer(data[4:], dtype=np.uint8)
        img = cv.imdecode(arr, cv.IMREAD_COLOR)
        if img is None:
            continue

        results = None
        try:
            rgb = cv.cvtColor(img, cv.COLOR_BGR2RGB)
            results = hands.process(rgb)
        except Exception as exc:
            if frame_idx % 60 == 0:
                print(f"[Gesture] MP error: {type(exc).__name__}: {exc}")

        now = time.time()
        h, w = img.shape[:2]
        hand_ok = results is not None and results.multi_hand_landmarks

        if hand_ok:
            lm = results.multi_hand_landmarks[0]
            wrist = lm.landmark[0]
            thumb = lm.landmark[4]   # THUMB_TIP
            index = lm.landmark[8]   # INDEX_FINGER_TIP

            # Pinch distance in normalised screen coords
            pinch_dist = ((thumb.x - index.x) ** 2 +
                          (thumb.y - index.y) ** 2) ** 0.5
            current_y = wrist.y

            # Hysteresis: easier to grab than to release
            if not pinching and pinch_dist < PINCH_ON_DIST:
                pinching = True
                grab_start_y = wrist.y
                print(f"[Gesture] GRAB at y={wrist.y:.2f}")
            elif pinching and pinch_dist > PINCH_OFF_DIST:
                # Release → decide direction
                pinching = False
                delta = wrist.y - grab_start_y
                print(f"[Gesture] RELEASE Δy={delta:+.2f}")
                if (abs(delta) > DRAG_THRESHOLD
                        and now - last_swipe_ts > SWIPE_COOLDOWN_S):
                    gesture = "next" if delta < 0 else "prev"
                    print(f"[Gesture] SWIPE {gesture.upper()} (Δy {delta:+.2f})")
                    last_swipe_ts    = now
                    last_swipe_label = f"SWIPE {gesture.upper()}"
                    last_swipe_at    = now
                    try:
                        gesture_q.put_nowait({"gesture": gesture, "ts": now})
                    except Exception:
                        pass
                grab_start_y = None

            drawer.draw_landmarks(
                img, lm, mp.solutions.hands.HAND_CONNECTIONS,
                style.get_default_hand_landmarks_style(),
                style.get_default_hand_connections_style(),
            )
        else:
            # Hand left frame → cancel any in-progress grab without firing
            pinching      = False
            grab_start_y  = None
            current_y     = None
            pinch_dist    = 0.0

        # Debug overlays
        meter_h = h - 40
        # Pinch-distance meter (left)
        cv.rectangle(img, (20, 20), (40, 20+meter_h), (60,60,60), -1)
        pf = int(min(1.0, pinch_dist / 0.20) * meter_h)
        pinch_color = (0,255,0) if pinching else (0,200,255)
        cv.rectangle(img, (20, 20+meter_h-pf), (40, 20+meter_h),
                     pinch_color, -1)
        ony = 20 + meter_h - int(meter_h * PINCH_ON_DIST / 0.20)
        cv.line(img, (16, ony), (44, ony), (0,255,0), 1)
        cv.putText(img, f"pinch {pinch_dist:.2f}", (10, 20+meter_h+15),
                   cv.FONT_HERSHEY_SIMPLEX, 0.45, (255,255,255), 1)

        # Grab Δy meter (right) — only meaningful while pinching
        if pinching and grab_start_y is not None and current_y is not None:
            delta = current_y - grab_start_y
            mid = 20 + meter_h // 2
            cv.rectangle(img, (w-40, 20), (w-20, 20+meter_h), (60,60,60), -1)
            d_px = int(min(1.0, abs(delta) / DRAG_THRESHOLD / 1.2) * meter_h // 2)
            color = (0,255,0) if abs(delta) > DRAG_THRESHOLD else (0,200,255)
            if delta < 0:
                cv.rectangle(img, (w-40, mid - d_px), (w-20, mid), color, -1)
            else:
                cv.rectangle(img, (w-40, mid), (w-20, mid + d_px), color, -1)
            cv.line(img, (w-44, mid), (w-16, mid), (255,255,255), 1)
            cv.putText(img, f"drag {delta:+.2f}", (w-120, 20+meter_h+15),
                       cv.FONT_HERSHEY_SIMPLEX, 0.5, (255,255,255), 1)

        cv.putText(img, "HAND OK" if hand_ok else "no hand", (60, 25),
                   cv.FONT_HERSHEY_SIMPLEX, 0.7,
                   (0,255,0) if hand_ok else (80,80,255), 2, cv.LINE_AA)
        if pinching:
            cv.putText(img, "GRABBED", (60, 50),
                       cv.FONT_HERSHEY_SIMPLEX, 0.7, (0,255,255), 2, cv.LINE_AA)

        if last_swipe_label and now - last_swipe_at < 0.8:
            (tw, th_), _ = cv.getTextSize(last_swipe_label,
                              cv.FONT_HERSHEY_SIMPLEX, 1.2, 3)
            cx = (w - tw) // 2
            cv.rectangle(img, (cx-12, h//2-th_-10), (cx+tw+12, h//2+10),
                         (0,0,0), -1)
            cv.putText(img, last_swipe_label, (cx, h//2),
                       cv.FONT_HERSHEY_SIMPLEX, 1.2, (0,255,0), 3, cv.LINE_AA)

        cv.imshow("Gesture debug", img)
        if cv.waitKey(1) & 0xFF == ord("q"):
            break


# ── Bridge between gesture queue and WS broadcast (asyncio) ─────────────────
async def gesture_relay(q):
    while True:
        try:
            evt = q.get_nowait()
            await broadcast(json.dumps(evt))
        except Exception:
            await asyncio.sleep(0.03)


# ── Main ────────────────────────────────────────────────────────────────────
async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--remote_ip", default="192.168.10.201")
    args = parser.parse_args()

    gesture_q = mpr.Queue(maxsize=64)
    proc = mpr.Process(target=gesture_worker, args=(args.remote_ip, gesture_q),
                       daemon=True)
    proc.start()
    print(f"[Bridge] gesture worker pid={proc.pid}")

    server = await serve(ws_handler, WS_HOST, WS_PORT)
    print(f"[WS] listening on ws://{WS_HOST}:{WS_PORT}")
    await asyncio.gather(
        server.wait_closed(),
        gaze_loop(args.remote_ip),
        gesture_relay(gesture_q),
    )


if __name__ == "__main__":
    mpr.freeze_support()
    asyncio.run(main())
