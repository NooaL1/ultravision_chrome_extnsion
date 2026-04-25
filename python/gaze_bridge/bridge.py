# bridge.py
"""
Bridges SeeTrue eye-tracker ZMQ stream to a local WebSocket so a
Chrome extension can read gaze + pupil data.

Run alongside the eye tracker:
    python bridge.py --remote_ip 192.168.10.201
"""

import argparse
import asyncio
import json
import sys

if sys.platform == "win32":
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

import zmq
import zmq.asyncio
from websockets.server import serve

WS_HOST   = "localhost"
WS_PORT   = 8765
ZMQ_PORT  = 3428  # SeeTrue eye tracking data port

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


async def gaze_loop(remote_ip: str):
    ctx  = zmq.asyncio.Context()
    sock = ctx.socket(zmq.PULL)            # SeeTrue uses PUSH/PULL, not PUB/SUB
    sock.setsockopt(zmq.RCVHWM, 0)
    sock.connect(f"tcp://{remote_ip}:{ZMQ_PORT}")
    print(f"[ZMQ] PULL connected to tcp://{remote_ip}:{ZMQ_PORT}")

    msg_count = 0
    parse_fails = 0
    while True:
        try:
            raw = await sock.recv_string()
            msg_count += 1
            if msg_count <= 3:
                print(f"[ZMQ] sample #{msg_count} raw: {raw!r}")
            fields = raw.strip().split(";")
            if len(fields) < 21:
                parse_fails += 1
                if parse_fails <= 3:
                    print(f"[ZMQ] short message ({len(fields)} fields): {raw!r}")
                continue
            # SeeTrue field layout (per EyeTrackingReceiver.parse_data):
            # 0=ID 1=Timestamp 2=GazeX 3=GazeY 4=PupilL 5=PupilR
            # 9=RScore 10=LScore 11=PicNum 20=event
            event = fields[20].strip()
            if event == "NA":
                continue   # eyes not detected — skip
            data = {
                "ts":     float(fields[1]),
                "gx":     float(fields[2]),
                "gy":     float(fields[3]),
                "pupilL": float(fields[4]),
                "pupilR": float(fields[5]),
                "event":  event,
            }
            if msg_count <= 3:
                print(f"[ZMQ] parsed:  {data}")
            await broadcast(json.dumps(data))
        except (ValueError, IndexError) as e:
            parse_fails += 1
            if parse_fails <= 3:
                print(f"[ZMQ] parse error ({e}): {raw!r}")
            continue
        except Exception as exc:
            print(f"[ZMQ] error: {exc}")


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--remote_ip", default="192.168.10.201")
    args = parser.parse_args()

    server = await serve(ws_handler, WS_HOST, WS_PORT)
    print(f"[WS] listening on ws://{WS_HOST}:{WS_PORT}")
    await asyncio.gather(server.wait_closed(), gaze_loop(args.remote_ip))


if __name__ == "__main__":
    asyncio.run(main())
