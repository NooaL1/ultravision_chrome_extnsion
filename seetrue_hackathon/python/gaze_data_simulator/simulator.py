# simulator.py
# Simulates the eye tracking data server and scene image server locally.
# Eye tracking: figure-of-eight fixation pattern, sine-wave pupil size.
# Scene image: webcam feed over ZMQ on port 3425.
# Run this instead of the real hardware server, then start main.py normally.

import math
import random
import struct
import threading
import time
from datetime import datetime, timedelta, timezone

import cv2
import numpy as np
import zmq

VGA_W, VGA_H = 640, 480
EYE_PORT = 3428
SCENE_PORT = 3425
SAMPLE_INTERVAL = 0.010   # 100 Hz
SCENE_INTERVAL = 1.0 / 30  # 30 fps

TZ = timezone(timedelta(hours=2))

# ---------------------------------------------------------------------------
# Figure-of-eight fixation points via Lissajous 1:2 curve
# 80 % coverage: ax = 0.4 in normalized coords (0.8/2), ay = 0.4
# ---------------------------------------------------------------------------
def _figure8_points(n: int = 20):
    cx, cy = 0.5, 0.5
    ax = 0.80 * VGA_W / 2 / VGA_W   # 0.40
    ay = 0.80 * VGA_H / 2 / VGA_H   # 0.40
    pts = []
    for i in range(n):
        t = 2 * math.pi * i / n
        pts.append((cx + ax * math.sin(t), cy + ay * math.sin(2 * t)))
    return pts


def _pupil_mm(t_sec: float) -> float:
    """Slow sine wave: 2–8 mm, period ~5 s."""
    return 5.0 + 3.0 * math.sin(2 * math.pi * t_sec / 5.0)


def _iso_now() -> str:
    now = datetime.now(TZ)
    ms = now.microsecond // 1000
    return now.strftime(f"%Y-%m-%dT%H:%M:%S.{ms:03d}+02:00")


# ---------------------------------------------------------------------------
# Eye tracking server
# ---------------------------------------------------------------------------
def run_eye_server(stop: threading.Event) -> None:
    ctx = zmq.Context()
    sock = ctx.socket(zmq.PUSH)
    sock.setsockopt(zmq.SNDHWM, 10)
    sock.bind(f"tcp://127.0.0.1:{EYE_PORT}")
    print(f"Eye tracking simulator bound to tcp://127.0.0.1:{EYE_PORT}")

    fixations = _figure8_points(20)
    n_fix = len(fixations)

    t0 = time.perf_counter()
    sample_id = 1

    # State machine
    fix_idx = 0
    fix_x, fix_y = fixations[0]
    fix_dur = random.uniform(0.200, 0.500)
    state = "fixating"
    state_t0 = time.perf_counter()
    fb_sent = False          # FB event sent for current fixation?

    sac_x0 = fix_x
    sac_y0 = fix_y
    sac_x1, sac_y1 = fixations[1]
    sac_dur = 0.050
    gaze_x, gaze_y = fix_x, fix_y

    while not stop.is_set():
        loop_t = time.perf_counter()
        elapsed = loop_t - t0
        state_elapsed = loop_t - state_t0

        pupil = _pupil_mm(elapsed)
        pl = max(1.0, pupil + random.gauss(0, 0.05))
        pr = max(1.0, pupil + random.gauss(0, 0.05))

        eye_event = ""

        if state == "fixating":
            gaze_x = fix_x + random.gauss(0, 0.004)
            gaze_y = fix_y + random.gauss(0, 0.004)
            gaze_x = max(0.0, min(1.0, gaze_x))
            gaze_y = max(0.0, min(1.0, gaze_y))

            if not fb_sent:
                eye_event = "FB"
                fb_sent = True

            if state_elapsed >= fix_dur:
                eye_event = f"FEx{fix_x:.3f}y{fix_y:.3f}d{fix_dur:.3f}"
                next_idx = (fix_idx + 1) % n_fix
                sac_x0, sac_y0 = gaze_x, gaze_y
                sac_x1, sac_y1 = fixations[next_idx]
                dist_px = math.hypot(
                    (sac_x1 - sac_x0) * VGA_W,
                    (sac_y1 - sac_y0) * VGA_H,
                )
                # Saccade speed ~500 px/s; minimum 30 ms
                sac_dur = max(0.030, dist_px / 500.0)
                fix_idx = next_idx
                fix_x, fix_y = fixations[fix_idx]
                fix_dur = random.uniform(0.200, 0.500)
                state = "saccading"
                state_t0 = loop_t
                fb_sent = False

        elif state == "saccading":
            alpha = min(1.0, state_elapsed / sac_dur)
            # Ease-in-out for realism
            alpha_s = alpha * alpha * (3 - 2 * alpha)
            gaze_x = sac_x0 + alpha_s * (sac_x1 - sac_x0)
            gaze_y = sac_y0 + alpha_s * (sac_y1 - sac_y0)
            eye_event = "S"

            if state_elapsed >= sac_dur:
                state = "fixating"
                state_t0 = loop_t

        # Build semicolon-delimited string matching the real server format
        # Fields 0-20; parser uses indices 0,1,2,3,4,5,9,10,11,20
        pl_px = int(pl * 290)
        pr_px = int(pr * 290)
        row = (
            f"{sample_id};{elapsed * 1000:.3f};"
            f"{gaze_x:.4f};{gaze_y:.4f};"
            f"{pl:.2f};{pr:.2f};"
            f"{pl_px};{pr_px};"
            f"1.00;1.000;1.000;"          # combined, RScore, LScore
            f"{sample_id % 1000};"        # PicNum
            f"{_iso_now()};"
            f"-2.000;3.000;-38.000;"      # head pose left xyz
            f"-2.500;1.500;-35.000;"      # head pose right xyz
            f";{eye_event}"               # field 19 empty, field 20 = event
        )

        try:
            sock.send_string(row, zmq.NOBLOCK)
        except zmq.Again:
            pass

        sample_id += 1
        sleep = SAMPLE_INTERVAL - (time.perf_counter() - loop_t)
        if sleep > 0:
            time.sleep(sleep)

    sock.close()
    ctx.term()
    print("Eye tracking simulator stopped.")


# ---------------------------------------------------------------------------
# Scene image server (webcam)
# ---------------------------------------------------------------------------
def run_scene_server(stop: threading.Event) -> None:
    ctx = zmq.Context()
    sock = ctx.socket(zmq.PUSH)
    sock.setsockopt(zmq.SNDHWM, 2)
    sock.bind(f"tcp://127.0.0.1:{SCENE_PORT}")
    print(f"Scene image simulator bound to tcp://127.0.0.1:{SCENE_PORT}")

    cap = cv2.VideoCapture(1)
    if cap.isOpened():
        cap.set(cv2.CAP_PROP_FRAME_WIDTH, VGA_W)
        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, VGA_H)
        print("Webcam opened.")
    else:
        print("WARNING: No webcam found – sending blank frames.")

    blank = np.zeros((VGA_H, VGA_W, 3), dtype=np.uint8)
    frame_num = 0
    encode_params = [cv2.IMWRITE_JPEG_QUALITY, 75]

    while not stop.is_set():
        loop_t = time.perf_counter()

        if cap.isOpened():
            ret, frame = cap.read()
            if not ret:
                frame = blank.copy()
        else:
            frame = blank.copy()

        if frame.shape[:2] != (VGA_H, VGA_W):
            frame = cv2.resize(frame, (VGA_W, VGA_H))

        _, buf = cv2.imencode(".jpg", frame, encode_params)
        header = struct.pack(">I", frame_num)

        try:
            sock.send(header + buf.tobytes(), zmq.NOBLOCK)
        except zmq.Again:
            pass

        frame_num += 1
        sleep = SCENE_INTERVAL - (time.perf_counter() - loop_t)
        if sleep > 0:
            time.sleep(sleep)

    cap.release()
    sock.close()
    ctx.term()
    print("Scene image simulator stopped.")


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    stop = threading.Event()

    eye_t = threading.Thread(target=run_eye_server, args=(stop,), daemon=True)
    scene_t = threading.Thread(target=run_scene_server, args=(stop,), daemon=True)

    eye_t.start()
    scene_t.start()

    print("Simulator running. Press Ctrl+C to stop.")
    try:
        while True:
            time.sleep(0.1)
    except KeyboardInterrupt:
        print("\nStopping...")
        stop.set()

    eye_t.join(timeout=2)
    scene_t.join(timeout=2)
    print("Done.")
