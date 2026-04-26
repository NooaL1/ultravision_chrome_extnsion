# bridge.py — SeeTrue ↔ WebSocket-silta + käsi-eleentunnistus
"""
=============================================================================
  Mitä tämä tiedosto on
=============================================================================
Tämä on SILTA SeeTrue-silmänseurantalasien ja Daemon-Chrome-laajennuksen
välillä. SeeTrue-lasit ovat järjestelmän PÄÄSIGNAALI:
    · katseen koordinaatit (gx, gy)
    · pupillin koko vasemmalle ja oikealle silmälle (mm)
    · sakkadit, fixationit, blinkit
    · scene-kameran video (lasien etupuolelta) → käsieleet

Kaikki tämä virtaa ZMQ:n yli SeeTruen omasta serveriohjelmasta
(SeeTrueEyeServer.exe) bridgeen, joka:
    1. Käynnistää datavirran lähettämällä UDP-handshakean serverille
       (sendEyeTrackerTypeData → setEyeTrackerDevice → runPictureProcessing)
    2. Vastaanottaa ZMQ-viestit erillisessä Python-aliprosessissa
       (välttäen Windowsin asyncio + zmq.asyncio -ristiriidan)
    3. Ajaa MediaPipe Hands -käsiraajamallia scene-kameran framessa
       ja tunnistaa pinch-grab + drag -liikkeitä SWIPE-tapahtumiksi
    4. Tarjoaa kaiken WebSocket-clienteille porttiin ws://localhost:8765
    5. Lähettää 1 Hz heartbeatin jotta clientit tietävät onko data elossa

Daemon-laajennus (daemon-extension/) yhdistyy tähän, ottaa SeeTruen datan,
yhdistää sen omaan webkameran rPPG + tunne-analyysiin, ja päättelee siitä
tulisiko YouTube Shorts skipata.

=============================================================================
  Tyypilliset käynnistystavat
=============================================================================
SeeTrue-laitteen kanssa (oletus IP 172.20.10.3, connect-tila):
    python bridge.py

Jos SeeTruen IP on eri:
    python bridge.py --remote_ip 192.168.X.Y

Jos SeeTrue PUSHaa lapotpiisi (laptop bindaa porttiin):
    python bridge.py --bind

Ilman laitteistoa, simulaattorilla (kahdessa terminaalissa):
    python ../gaze_data_simulator/simulator.py
    python bridge.py --simulator

Demoa varten (kevyt RAM, ei cv2-ikkunoita):
    python bridge.py --no-display

=============================================================================
  Mitä lokissa pitäisi näkyä kun kaikki toimii
=============================================================================
    [preflight] ✓ 172.20.10.3 vastaa pingiin
    [handshake] kicking SeeTrueEyeServer at 172.20.10.3:3429
    [handshake] → UDP {'action': 'sendEyeTrackerTypeData'}
    [handshake] → UDP {'action': 'runPictureProcessing', ...}
    [ZMQ] gaze parsed #1: {pupilL: 2.84, pupilR: 4.19, ...}   ← lasit syöttävät
    [Gesture] frame #1 (188 KB)                               ← scene-kamera
    [WS] client connected                                     ← Daemon yhdistyi
    [WS] inbound #1: {"source":"daemon", "bpm": 65, ...}      ← Daemon syöttää HR

Jos näet "still waiting for first gaze sample" → SeeTrue ei lähetä dataa.
Tarkista IP, verkko, ja että SeeTrueEyeServer on käynnistetty laitteella.
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

# ── Hand-swipe-asetukset (SeeTruen scene-kameran kuva) ──────────────────────
# Käyttäjä tekee "pinch-grab" (peukalo + etusormi yhteen) ja vetää joko
# ylös tai alas. Kun pinch vapautuu, lasketaan Δy ja jos se ylittää
# DRAG_THRESHOLD, lähetetään SWIPE-tapahtuma. Kynnykset on tuunattu siten
# että pienikin selvä nykäys riittää — käyttäjä haluaa ohjata Shortsia
# nopeasti edestakaisin lasit päässä.
SWIPE_COOLDOWN_S  = 0.4     # min aika kahden swipen välillä (oli 0.7 — tehty herkemmäksi)
PROCESS_EVERY_NTH = 1       # 1 = jokainen frame, kasvata jos CPU rajoittaa
PINCH_ON_DIST     = 0.06    # peukalo+etusormi alle tämän = grab alkaa
PINCH_OFF_DIST    = 0.10    # vapautus-kynnys (hysteresis)
DRAG_THRESHOLD    = 0.05    # min Δy normalisoitu jotta lasketaan swipeksi
                            # (0.10 oli liian korkea — hienovaraiset
                            #  käden nykäykset eivät rekisteröityneet)

clients: set = set()

# SeeTrue liveness — gaze_loop päivittää, heartbeat_loop ja stdout lukevat.
# time.monotonic() pohjainen jotta kellovaihdot eivät häiritse.
last_gaze_ts: float = 0.0
gaze_msg_count: int = 0


# ── SeeTrue UDP/ZMQ handshake ───────────────────────────────────────────────
# Server (SeeTrueEyeServer.exe) push-aa ZMQ:ta vasta kun client on lähettänyt
# UDP "runPictureProcessing" -komennon porttiin INITIAL_PORT (3429).
# Notifikaatiot tulevat takaisin ZMQ-portista 3430 (initial+1).
# Tämä funktio matkii sitä mitä SeeTrueTechLauncher.exe tekee: device discovery
# → pick → start. Auto mode = "haetaan listalta ensimmäinen, käynnistetään".
INITIAL_PORT       = 3429   # UDP control
NOTIFICATIONS_PORT = 3430   # ZMQ notifications (initial+1)


def kick_seetrue_stream(remote_ip: str, timeout_s: float = 4.0,
                        prefer_device: str | None = None) -> bool:
    """Send the UDP commands needed to start the SeeTrue ZMQ stream.

    Returns True if at least the runPictureProcessing was sent (server may or
    may not start streaming depending on calibration state).
    """
    import socket
    import zmq as zmq_local

    print(f"[handshake] kicking SeeTrueEyeServer at {remote_ip}:{INITIAL_PORT}")

    # 1) ZMQ PULL for notifications coming back from server
    ctx = zmq_local.Context()
    notif_sock = ctx.socket(zmq_local.PULL)
    notif_sock.RCVTIMEO = int(timeout_s * 1000)
    try:
        notif_sock.connect(f"tcp://{remote_ip}:{NOTIFICATIONS_PORT}")
    except Exception as exc:
        print(f"[handshake] notif PULL connect failed: {exc}")
        notif_sock.close(); ctx.term()
        return False

    # 2) UDP socket for sending commands
    udp = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)

    def send_cmd(d: dict):
        msg = json.dumps(d).encode("utf-8")
        udp.sendto(msg, (remote_ip, INITIAL_PORT))
        print(f"[handshake] → UDP {d}")

    # 3) Discover devices
    send_cmd({"action": "sendEyeTrackerTypeData"})

    device = prefer_device
    deadline = time.monotonic() + timeout_s
    while device is None and time.monotonic() < deadline:
        try:
            raw = notif_sock.recv_string()
        except zmq_local.error.Again:
            break
        except Exception as exc:
            print(f"[handshake] notif recv error: {exc}")
            break
        try:
            obj = json.loads(raw)
        except Exception:
            continue
        msg = obj.get("message") or {}
        # API: code 20 = list of EyeTracking devices. Voi tulla "devices"-listana
        # tai erikseen merkkijonoissa device_specific_identifier. Ota mitä saadaan.
        candidates = []
        for k in ("devices", "deviceList", "eyeTrackerList", "trackers"):
            v = msg.get(k)
            if isinstance(v, list) and v:
                candidates.extend([str(x) for x in v])
        # joskus payload on suoraan stringi
        if not candidates:
            for k in ("device", "eyeTrackerDevice", "eyeTrackerType"):
                v = msg.get(k)
                if isinstance(v, str) and v:
                    candidates.append(v)
        if candidates:
            device = candidates[0]
            print(f"[handshake] picked device: {device} (alternatives: {candidates})")
            break
        else:
            print(f"[handshake] notification: {obj}")

    if device is None:
        # Fallback: serveri ei vastannut device-listalla. Yritetään silti
        # runPictureProcessing tyhjällä eyeTrackerType:llä — joillakin versioilla
        # tämä toimii kun kalibrointi on aiemmin tehty.
        print("[handshake] no device list — trying blind start with empty type")
        device = ""

    # 4) Set device + start picture processing
    if device:
        send_cmd({"action": "setEyeTrackerDevice", "eyeTrackerDevice": device})
        time.sleep(0.2)

    send_cmd({
        "action": "runPictureProcessing",
        "executableStreams": {
            "recEyeData":      True,
            "recLeftEyeData":  False,
            "recRightEyeData": False,
            "recSceneData":    True,
        },
        "eyeTrackerType":  device,
        "calibrationData": "",
    })

    # 5) Lopeta — anna serverin aikaa vaihtaa tilaa
    time.sleep(0.3)
    udp.close()
    notif_sock.close()
    ctx.term()
    print("[handshake] done — bridge will now listen on ZMQ for gaze data")
    return True


async def ws_handler(ws):
    clients.add(ws)
    print(f"[WS] client connected (total={len(clients)})")
    inbound = 0
    try:
        async for raw in ws:
            inbound += 1
            if inbound <= 3 or inbound % 200 == 0:
                preview = raw if len(raw) < 160 else raw[:160] + "…"
                print(f"[WS] inbound #{inbound}: {preview}")
            await broadcast_to_others(raw, sender=ws)
    except Exception as exc:
        print(f"[WS] handler error: {exc}")
    finally:
        clients.discard(ws)
        print(f"[WS] client disconnected (total={len(clients)})")


async def broadcast(msg: str):
    if not clients:
        return
    await asyncio.gather(
        *[c.send(msg) for c in clients], return_exceptions=True
    )


async def broadcast_to_others(msg: str, sender):
    targets = [c for c in clients if c is not sender]
    if not targets:
        return
    await asyncio.gather(
        *[c.send(msg) for c in targets], return_exceptions=True
    )


# ── Gaze worker subprocess (sync zmq, drained by asyncio relay) ────────────
# HUOM: aiempi versio käytti zmq.asyncio.Context()-luokkaa main loopissa.
# Windows + Python 3.11 + pyzmq + asyncio yhdistelmässä on raportoitu ettei
# data koskaan saavu vaikka connect onnistuu. simple_gaze_receiverin pattern
# (sync ZMQ erillisessä prosessissa, blocking recv) toimii varmasti — käytetään
# sitä ja relayataan parsittu data multiprocessing.Queue:n kautta asyncio-puolelle.
def gaze_worker(remote_ip: str, gaze_q, bind_mode: bool = False,
                gaze_shared=None):
    """Subprocess: sync zmq.PULL → parse → push to gaze_q.
    Sama tapa kuin simple_gaze_receiver/EyeTrackingReceiver mutta ilman
    shared_data-kerrosta — vain raaka relay.

    gaze_shared: valinnainen mp.Array('d', 5) jaettu muisti
        [gx, gy, pupilL, pupilR, ts]. gesture_worker (tai mikä tahansa
        muu prosessi) lukee siitä uusimman gaze-pisteen reaaliajassa,
        ilman msg-passing-overheadia, ja piirtää sen scene-cam-ikkunaan."""
    import zmq as zmq_local
    ctx  = zmq_local.Context()
    sock = ctx.socket(zmq_local.PULL)
    sock.setsockopt(zmq_local.RCVHWM, 0)
    sock.RCVTIMEO = 2000  # ms — tasapaino: ei rosvoa CPU:ta, lokit kerran/2s
    if bind_mode:
        endpoint = f"tcp://0.0.0.0:{GAZE_PORT}"
        sock.bind(endpoint)
        print(f"[ZMQ] gaze PULL bound on {endpoint} (waiting for SeeTrue PUSH)")
    else:
        endpoint = f"tcp://{remote_ip}:{GAZE_PORT}"
        sock.connect(endpoint)
        print(f"[ZMQ] gaze PULL connected to {endpoint}")

    msg_count = 0
    stall_count = 0
    last_recv_ts = 0.0
    eyes_warned = False

    while True:
        try:
            raw = sock.recv_string()
        except zmq_local.error.Again:
            stall_count += 1
            age = (time.monotonic() - last_recv_ts) if last_recv_ts else None
            if age is None:
                print(f"[ZMQ] still waiting for first gaze sample "
                      f"(stall #{stall_count}). Tarkista: SeeTrue päällä? "
                      f"IP/portti? Kokeile --bind tai --simulator.")
            else:
                print(f"[ZMQ] no gaze data — {age:.1f}s since last sample")
            continue
        except Exception as exc:
            print(f"[ZMQ] gaze recv error: {type(exc).__name__}: {exc}")
            time.sleep(0.5)
            continue

        try:
            msg_count += 1
            last_recv_ts = time.monotonic()
            fields = raw.strip().split(";")
            if len(fields) < 21:
                continue
            event = fields[20].strip()
            # main.py vertailee " NA" — meidän strip()+vertailu kattaa molemmat
            if event == "NA":
                if not eyes_warned:
                    print("[ZMQ] eyes not detected (event=NA) — gaze receives "
                          "frames but tracker ei näe silmiä. Kalibroi/asettele.")
                    eyes_warned = True
                # Lähetä silti heartbeat-päivitys — bridge tietää että data virtaa
                try:
                    gaze_q.put_nowait({"source": "ovision-gaze",
                                       "_alive_only": True,
                                       "event": "NA"})
                except Exception:
                    pass
                continue
            if eyes_warned:
                print("[ZMQ] eyes detected again — resuming gaze stream.")
                eyes_warned = False
            data = {
                "source": "ovision-gaze",
                "ts":     float(fields[1]),
                "gx":     float(fields[2]),
                "gy":     float(fields[3]),
                "pupilL": float(fields[4]),
                "pupilR": float(fields[5]),
                "event":  event,
            }
            if msg_count <= 3 or msg_count % 500 == 0:
                print(f"[ZMQ] gaze parsed #{msg_count}: {data}")
            # Päivitä shared memory jotta gesture_worker / scene-viewer voi
            # piirtää gaze-pisteen reaaliajassa ilman msg-passingia.
            if gaze_shared is not None:
                try:
                    gaze_shared[0] = data["gx"]
                    gaze_shared[1] = data["gy"]
                    gaze_shared[2] = data["pupilL"]
                    gaze_shared[3] = data["pupilR"]
                    gaze_shared[4] = time.time()
                except Exception:
                    pass
            try:
                gaze_q.put_nowait(data)
            except Exception:
                pass  # queue full — drop, fresh data will follow
        except (ValueError, IndexError):
            continue
        except Exception as exc:
            print(f"[ZMQ] gaze parse error: {exc}")


# ── Async relay: pull from gaze_q → broadcast WS + update liveness counters ─
async def gaze_relay(q):
    global last_gaze_ts, gaze_msg_count
    while True:
        try:
            evt = q.get_nowait()
        except Exception:
            await asyncio.sleep(0.01)
            continue
        last_gaze_ts = time.monotonic()
        gaze_msg_count += 1
        # Älä broadcastaa pelkkää alive-pingiä — vain heartbeat hyödyntää sitä
        if evt.get("_alive_only"):
            continue
        try:
            await broadcast(json.dumps(evt))
        except Exception as exc:
            print(f"[gaze_relay] broadcast error: {exc}")


# ── Gesture worker subprocess (cv2.imshow safe in main thread) ──────────────
def gesture_worker(remote_ip: str, gesture_q, bind_mode: bool = False,
                   show_window: bool = True, gaze_shared=None):
    """Runs in its own process so cv2.imshow + cv2.waitKey work properly.

    Tämä prosessi:
      1. Vastaanottaa SeeTrue-skenekameran kuvavirran ZMQ:n yli (port 3425)
      2. Ajaa MediaPipe-hands sen päällä → tunnistaa pinch+drag ja open-palm
         swipe-eleet → push gesture_q:hun
      3. Lähettää JOKA 3. KUVAN downscaled JPEG:nä Daemonin HUDille jotta
         käyttäjä näkee Chrome-laajennuksen sisällä lasien etupuolisen kuvan
         + sen päällä gaze-pisteen (mihin hän juuri katsoo)
    """
    import zmq as zmq_local
    import numpy as np
    import cv2 as cv
    import mediapipe as mp
    import base64

    ctx  = zmq_local.Context()
    sock = ctx.socket(zmq_local.PULL)
    sock.setsockopt(zmq_local.RCVHWM, 0)
    if bind_mode:
        endpoint = f"tcp://0.0.0.0:{SCENE_PORT}"
        sock.bind(endpoint)
        print(f"[Gesture] subprocess bound on {endpoint} (waiting for PUSH)")
    else:
        endpoint = f"tcp://{remote_ip}:{SCENE_PORT}"
        sock.connect(endpoint)
        print(f"[Gesture] subprocess connected to {endpoint}")

    hands  = mp.solutions.hands.Hands(
        max_num_hands=1, min_detection_confidence=0.55,
        min_tracking_confidence=0.45,
    )
    drawer = mp.solutions.drawing_utils
    style  = mp.solutions.drawing_styles

    if show_window:
        cv.namedWindow("Gesture debug", cv.WINDOW_NORMAL)
        cv.resizeWindow("Gesture debug", 800, 600)
        # ÄLÄ pelkästään näytä eleitä — avaa myös ISO scene-cam-ikkuna jossa
        # näkyy lasit-kameran kuva + gaze-piste reaaliajassa. Tämä on demoa
        # varten huomattavasti sulavampi kuin Chrome-paneelin scene-view koska
        # ei msg-passing-overheadia. Natiivi-fps (~30 fps).
        cv.namedWindow("Lasien kamera + gaze", cv.WINDOW_NORMAL)
        cv.resizeWindow("Lasien kamera + gaze", 960, 720)

    last_swipe_ts    = 0.0
    last_swipe_label = ""
    last_swipe_at    = 0.0
    frame_idx        = 0

    # Pinch-grab state
    pinching      = False
    grab_start_y  = None   # wrist y when grab started
    current_y     = None
    pinch_dist    = 0.0

    # Open-palm swipe detector — käsi liikkuu ylös/alas ilman pinchiä.
    # Tämä on kahvanvedon vaihtoehto: monet ihmiset eivät pinchaa luonnollisesti
    # vaan vain heiluttavat kättä. Pidetään (ts, y) -historia 800 ms ikkunassa
    # ja kun max-min y-erotus ylittää 0.18, lasketaan se swipeksi.
    wrist_hist = []   # [(t, y), ...]
    OPEN_SWIPE_WINDOW_S = 0.8
    OPEN_SWIPE_RANGE    = 0.18   # vähintään 18% kuvan korkeudesta = swipe

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

        # ── Stream pieni scene-frame Daemon HUDille ──────────────────────
        # Joka 2. kuva (~15 fps), 320×240 JPEG q70.
        # JSON-relayn ja Chrome-extensionin msg-passingin overhead on iso
        # kun viesti on isohko base64. Aiempi 240x180 + 10 fps näytti
        # silti ~10 fpm — ongelma oli että payload uusiutui niin nopeasti
        # ettei content-script ehtinyt purkaa Image:a. Nyt: korkeampi
        # resoluutio (selvempi näkymä), q70 (parempi laatu pienissä
        # muutoksissa) mutta lähetetään harvemmin (skipataan jos jonossa
        # on jo data).
        if frame_idx % 2 == 0:
            try:
                # Skippaa jos jono on lähes täynnä — vältetään kasaantuminen
                if gesture_q.qsize() < 32:
                    small = cv.resize(img, (320, 240),
                                      interpolation=cv.INTER_AREA)
                    ok, buf = cv.imencode(".jpg", small,
                                          [cv.IMWRITE_JPEG_QUALITY, 70])
                    if ok:
                        b64 = base64.b64encode(buf.tobytes()).decode("ascii")
                        gesture_q.put_nowait({
                            "source": "ovision-scene",
                            "ts": now,
                            "w": 320, "h": 240,
                            "jpeg": b64,
                        })
            except Exception:
                pass

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
                        gesture_q.put_nowait({"source": "ovision-gesture",
                                              "gesture": gesture, "ts": now})
                    except Exception:
                        pass
                grab_start_y = None

            drawer.draw_landmarks(
                img, lm, mp.solutions.hands.HAND_CONNECTIONS,
                style.get_default_hand_landmarks_style(),
                style.get_default_hand_connections_style(),
            )

            # ── Open-palm swipe ─────────────────────────────────────────────
            # Tämä laukeaa myös ilman pinchiä — kun käsi vain liikkuu
            # nopeasti ylös/alas. Käsi on usein vain heilautus, ei
            # tarkkaa kahvanvetoa, joten tämä on yleensä luonnollisempaa.
            wrist_hist.append((now, wrist.y))
            while wrist_hist and now - wrist_hist[0][0] > OPEN_SWIPE_WINDOW_S:
                wrist_hist.pop(0)
            if (len(wrist_hist) >= 4
                    and now - last_swipe_ts > SWIPE_COOLDOWN_S):
                ys = [p[1] for p in wrist_hist]
                ymin = min(ys); ymax = max(ys)
                rng  = ymax - ymin
                if rng >= OPEN_SWIPE_RANGE:
                    # Suunta: jos VIIMEISIN y on alle aiemman keskiarvon → liike
                    # alaspäin (next/skip); ylöspäin → prev/keep.
                    # NB: y=0 on ruudun yläreuna scene-kameran koordinaateissa.
                    first_y = wrist_hist[0][1]
                    last_y  = wrist_hist[-1][1]
                    if last_y - first_y > OPEN_SWIPE_RANGE * 0.6:
                        gesture = "next"   # käsi liikkui alas → next/skip
                    elif first_y - last_y > OPEN_SWIPE_RANGE * 0.6:
                        gesture = "prev"   # käsi liikkui ylös → prev
                    else:
                        gesture = None     # heilautus mutta ei selvää suuntaa
                    if gesture:
                        print(f"[Gesture] OPEN-SWIPE {gesture.upper()} "
                              f"(range {rng:.2f}, Δ {last_y-first_y:+.2f})")
                        last_swipe_ts    = now
                        last_swipe_label = f"SWIPE {gesture.upper()}"
                        last_swipe_at    = now
                        try:
                            gesture_q.put_nowait({"source": "ovision-gesture",
                                                  "gesture": gesture,
                                                  "ts": now,
                                                  "via": "open-palm"})
                        except Exception:
                            pass
                        wrist_hist.clear()
        else:
            # Hand left frame → cancel any in-progress grab without firing
            pinching      = False
            grab_start_y  = None
            current_y     = None
            pinch_dist    = 0.0
            wrist_hist.clear()

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

        if show_window:
            cv.imshow("Gesture debug", img)

            # ── Scene-cam + gaze overlay -ikkuna ─────────────────────────
            # Käyttää alkuperäistä isoa scene-frameä (640x480 tai mitä
            # SeeTrue lähettää), piirtää siihen gaze-pisteen shared
            # memorystä. Natiivi-fps, paljon sulavampi kuin Chrome-panelissa.
            scene_disp = img.copy()
            sH, sW = scene_disp.shape[:2]
            gx_norm = gy_norm = pup_l = pup_r = 0.0
            gaze_age = 99.0
            if gaze_shared is not None:
                try:
                    gx_norm = float(gaze_shared[0])
                    gy_norm = float(gaze_shared[1])
                    pup_l   = float(gaze_shared[2])
                    pup_r   = float(gaze_shared[3])
                    gaze_age = max(0.0, time.time() - float(gaze_shared[4]))
                except Exception:
                    pass
            if gaze_age < 1.0 and 0.0 <= gx_norm <= 1.0 and 0.0 <= gy_norm <= 1.0:
                gx_px = int(gx_norm * sW)
                gy_px = int(gy_norm * sH)
                # Iso pinkki risti + ympyrä
                cv.circle(scene_disp, (gx_px, gy_px), 26, (90, 60, 255), 3, cv.LINE_AA)
                cv.circle(scene_disp, (gx_px, gy_px), 12, (130, 110, 255), 2, cv.LINE_AA)
                cv.line(scene_disp, (gx_px - 40, gy_px), (gx_px - 14, gy_px),
                        (130, 110, 255), 2, cv.LINE_AA)
                cv.line(scene_disp, (gx_px + 14, gy_px), (gx_px + 40, gy_px),
                        (130, 110, 255), 2, cv.LINE_AA)
                cv.line(scene_disp, (gx_px, gy_px - 40), (gx_px, gy_px - 14),
                        (130, 110, 255), 2, cv.LINE_AA)
                cv.line(scene_disp, (gx_px, gy_px + 14), (gx_px, gy_px + 40),
                        (130, 110, 255), 2, cv.LINE_AA)
                cv.circle(scene_disp, (gx_px, gy_px), 3, (255, 255, 255), -1, cv.LINE_AA)
                cv.putText(scene_disp,
                           f"pup L {pup_l:.2f}  R {pup_r:.2f}  age {gaze_age*1000:.0f}ms",
                           (12, sH - 16),
                           cv.FONT_HERSHEY_SIMPLEX, 0.6, (200, 200, 255), 2, cv.LINE_AA)
            else:
                cv.putText(scene_disp, "no gaze (lasit ei lukitse silmia)",
                           (12, sH - 16),
                           cv.FONT_HERSHEY_SIMPLEX, 0.6, (80, 80, 255), 2, cv.LINE_AA)
            cv.imshow("Lasien kamera + gaze", scene_disp)

            if cv.waitKey(1) & 0xFF == ord("q"):
                break
        else:
            # Headless: anna prosessorin hengittää, älä kuluta täyttä CPU:ta
            time.sleep(0.001)


# ── Webcam worker (face expression + secondary hand tracking) ──────────────
def webcam_worker(gesture_q, cam_index=0, show_window: bool = True):
    """Reads laptop webcam → MediaPipe face mesh + hands. Pushes face
    expression metrics + (optional) gesture events into the queue.
    Runs in its own process so cv2.imshow works on Windows."""
    import cv2 as cv
    import mediapipe as mp

    cap = cv.VideoCapture(cam_index, cv.CAP_DSHOW)
    if not cap.isOpened():
        cap = cv.VideoCapture(cam_index)
    if not cap.isOpened():
        print(f"[Webcam] no camera at index {cam_index} — disabled")
        return
    print(f"[Webcam] opened camera {cam_index}")

    face_mesh = mp.solutions.face_mesh.FaceMesh(
        max_num_faces=1, refine_landmarks=True,
        min_detection_confidence=0.5, min_tracking_confidence=0.5,
    )
    hands = mp.solutions.hands.Hands(
        max_num_hands=1,
        min_detection_confidence=0.55, min_tracking_confidence=0.45,
    )

    if show_window:
        cv.namedWindow("Webcam debug", cv.WINDOW_NORMAL)
        cv.resizeWindow("Webcam debug", 700, 500)

    last_face_send = 0.0
    last_swipe_ts  = 0.0
    pinching       = False
    grab_start_y   = None

    # Expression baselines (estimated over first 3 s of frames)
    baseline = {"smile": None, "mouth_open": None, "brow": None}
    baseline_samples = {"smile": [], "mouth_open": [], "brow": []}
    BASELINE_FRAMES  = 60

    while True:
        ok, frame = cap.read()
        if not ok:
            time.sleep(0.05)
            continue
        frame = cv.flip(frame, 1)            # selfie mirror
        h, w  = frame.shape[:2]
        rgb   = cv.cvtColor(frame, cv.COLOR_BGR2RGB)

        face_results = None
        hand_results = None
        try:
            face_results = face_mesh.process(rgb)
        except Exception as exc:
            pass
        try:
            hand_results = hands.process(rgb)
        except Exception as exc:
            pass

        now = time.time()
        face_metrics = None

        # ── Face expression metrics ──────────────────────────────────────────
        if face_results and face_results.multi_face_landmarks:
            lm = face_results.multi_face_landmarks[0].landmark
            # Face-width normaliser (distance between cheeks)
            left_cheek  = lm[234]
            right_cheek = lm[454]
            face_w = max(0.01, ((right_cheek.x - left_cheek.x) ** 2 +
                                 (right_cheek.y - left_cheek.y) ** 2) ** 0.5)
            # Smile: mouth corner horizontal distance / face width
            left_corner  = lm[61];  right_corner = lm[291]
            smile = (((right_corner.x - left_corner.x) ** 2 +
                      (right_corner.y - left_corner.y) ** 2) ** 0.5) / face_w
            # Mouth open: vertical lip distance / face width
            upper_lip = lm[13]; lower_lip = lm[14]
            mouth_open = abs(upper_lip.y - lower_lip.y) / face_w
            # Brow raise: brow to eye distance / face width
            left_brow = lm[105]; left_eye_top = lm[159]
            brow = abs(left_brow.y - left_eye_top.y) / face_w

            metrics = {"smile": smile, "mouth_open": mouth_open, "brow": brow}

            # Establish baseline during first N frames
            for k, v in metrics.items():
                if baseline[k] is None and len(baseline_samples[k]) < BASELINE_FRAMES:
                    baseline_samples[k].append(v)
                    if len(baseline_samples[k]) == BASELINE_FRAMES:
                        baseline[k] = sum(baseline_samples[k]) / BASELINE_FRAMES
                        print(f"[Webcam] baseline {k}={baseline[k]:.4f}")

            # Compute deltas vs baseline (clip to roughly -1..+1)
            face_metrics = {}
            for k, v in metrics.items():
                if baseline[k]:
                    face_metrics[k] = (v - baseline[k]) / baseline[k]
                else:
                    face_metrics[k] = 0.0

            # Draw key landmarks
            for idx, color in [(13,(0,255,255)), (14,(0,255,255)),
                               (61,(255,0,255)), (291,(255,0,255)),
                               (105,(0,200,0)), (159,(0,200,0)),
                               (234,(150,150,150)),(454,(150,150,150))]:
                p = lm[idx]
                cv.circle(frame, (int(p.x*w), int(p.y*h)), 3, color, -1)

            # Send periodically
            if now - last_face_send > 0.4:
                msg = {"source": "ovision-face",
                       "face": face_metrics, "ts": now}
                try:
                    gesture_q.put_nowait(msg)
                except Exception:
                    pass
                last_face_send = now

        # ── Hands (pinch-grab swipe from webcam side) ────────────────────────
        if hand_results and hand_results.multi_hand_landmarks:
            lm = hand_results.multi_hand_landmarks[0]
            wrist = lm.landmark[0]
            thumb = lm.landmark[4]; index = lm.landmark[8]
            pd = ((thumb.x - index.x)**2 + (thumb.y - index.y)**2) ** 0.5
            if not pinching and pd < PINCH_ON_DIST:
                pinching = True; grab_start_y = wrist.y
            elif pinching and pd > PINCH_OFF_DIST:
                pinching = False
                d = wrist.y - grab_start_y
                if abs(d) > DRAG_THRESHOLD and now - last_swipe_ts > SWIPE_COOLDOWN_S:
                    g = "next" if d < 0 else "prev"
                    print(f"[Webcam] SWIPE {g.upper()} (Δy {d:+.2f})")
                    last_swipe_ts = now
                    try:
                        gesture_q.put_nowait({"source": "ovision-gesture",
                                              "gesture": g, "ts": now,
                                              "via": "webcam"})
                    except Exception:
                        pass
                grab_start_y = None
            mp.solutions.drawing_utils.draw_landmarks(
                frame, lm, mp.solutions.hands.HAND_CONNECTIONS,
            )

        # ── Debug overlays ────────────────────────────────────────────────────
        y0 = 25
        cv.putText(frame, "Webcam: face + hand", (10, y0),
                   cv.FONT_HERSHEY_SIMPLEX, 0.6, (0,255,0), 2, cv.LINE_AA)
        if face_metrics:
            for i, (k, v) in enumerate(face_metrics.items()):
                color = (0,255,0) if v > 0.05 else (0,180,255) if v > -0.05 else (80,80,255)
                cv.putText(frame, f"{k:11s} {v:+.2f}",
                           (10, y0 + 25 + i*22),
                           cv.FONT_HERSHEY_SIMPLEX, 0.55, color, 2, cv.LINE_AA)
        else:
            cv.putText(frame, "no face", (10, y0+25),
                       cv.FONT_HERSHEY_SIMPLEX, 0.55, (80,80,255), 2)

        if pinching:
            cv.putText(frame, "GRABBED", (10, h-20),
                       cv.FONT_HERSHEY_SIMPLEX, 0.7, (0,255,255), 2, cv.LINE_AA)

        if show_window:
            cv.imshow("Webcam debug", frame)
            if cv.waitKey(1) & 0xFF == ord("q"):
                break
        else:
            time.sleep(0.001)

    cap.release()
    if show_window:
        cv.destroyAllWindows()


# ── Bridge between gesture queue and WS broadcast (asyncio) ─────────────────
async def gesture_relay(q):
    while True:
        try:
            evt = q.get_nowait()
            await broadcast(json.dumps(evt))
        except Exception:
            await asyncio.sleep(0.03)


# ── Heartbeat: 1 Hz status broadcast for HUD diagnostics ───────────────────
async def heartbeat_loop():
    last_count = 0
    while True:
        await asyncio.sleep(1.0)
        now = time.monotonic()
        rate = gaze_msg_count - last_count
        last_count = gaze_msg_count
        seetrue_alive = (last_gaze_ts > 0.0 and (now - last_gaze_ts) < 2.0)
        msg = json.dumps({
            "source": "bridge",
            "heartbeat": True,
            "seetrue_alive": seetrue_alive,
            "msgs_per_sec": rate,
            "last_event_age_s":
                None if last_gaze_ts == 0.0 else round(now - last_gaze_ts, 2),
            "total_msgs": gaze_msg_count,
        })
        await broadcast(msg)


# ── Main ────────────────────────────────────────────────────────────────────
async def main():
    parser = argparse.ArgumentParser(
        description="SeeTrue ↔ WebSocket bridge with optional MediaPipe gestures."
    )
    parser.add_argument("--remote_ip", default="172.20.10.3",
        help="SeeTrue device IP (when --bind not set). Default: 172.20.10.3 "
             "(matches simple_gaze_receiver/main.py default).")
    parser.add_argument("--enable-webcam", action="store_true",
        help="Run the webcam_worker (face mesh + hand). OFF by default — "
             "Daemon-laajennus tekee saman tehokkaammin selainpuolella.")
    parser.add_argument("--no-gesture", action="store_true",
        help="Skip the MediaPipe hand-gesture worker entirely. Saves "
             "~150 MB RAM if you only need SeeTrue gaze data.")
    parser.add_argument("--no-display", action="store_true",
        help="Run gesture/webcam workers headless — skip cv2.imshow windows.")
    parser.add_argument("--bind", action="store_true",
        help="Bind ZMQ sockets locally (0.0.0.0) instead of connecting to "
             "remote_ip. Use this when SeeTrue PUSHes to the laptop.")
    parser.add_argument("--simulator", action="store_true",
        help="Shortcut for testing: forces remote_ip=127.0.0.1 (use alongside "
             "python ../gaze_data_simulator/simulator.py).")
    parser.add_argument("--no-auto-start", action="store_true",
        help="Skip the UDP handshake (sendEyeTrackerTypeData + setEyeTrackerDevice "
             "+ runPictureProcessing). Käytä jos SeeTrueTechLauncher on jo "
             "käynnistänyt streamin.")
    parser.add_argument("--device", default=None,
        help="Force a specific eyeTrackerType id (skip auto-discovery during "
             "handshake). Esim. --device EyeTrackerNetwork")
    args = parser.parse_args()

    if args.simulator:
        args.remote_ip = "127.0.0.1"

    show_window = not args.no_display
    bind_mode   = bool(args.bind)
    auto_start  = not args.no_auto_start and not args.simulator and not bind_mode

    # ── Banner ───────────────────────────────────────────────────────────────
    direction_gaze  = (f"bind   tcp://0.0.0.0:{GAZE_PORT}"  if bind_mode
                       else f"connect tcp://{args.remote_ip}:{GAZE_PORT}")
    direction_scene = (f"bind   tcp://0.0.0.0:{SCENE_PORT}" if bind_mode
                       else f"connect tcp://{args.remote_ip}:{SCENE_PORT}")
    gesture_state = "off" if args.no_gesture else ("on (window)" if show_window else "on (headless)")
    webcam_state  = "off" if not args.enable_webcam else ("on (window)" if show_window else "on (headless)")
    print("=" * 64)
    print("  bridge.py  ·  SeeTrue ↔ WebSocket fusion")
    print(f"  ZMQ gaze:   {direction_gaze}")
    print(f"  ZMQ scene:  {direction_scene}")
    print(f"  Workers:    gesture={gesture_state}  webcam={webcam_state}")
    print(f"  WebSocket:  ws://{WS_HOST}:{WS_PORT}")
    print(f"  Auto-start: {'YES (UDP handshake)' if auto_start else 'no'}")
    if not args.simulator and not bind_mode:
        print("  Hint: jos hiljaisuus jatkuu yli 5s — kokeile --bind tai --simulator")
    print("=" * 64)

    # ── Pre-flight: voiko remote_ip:tä edes pingata? ────────────────────────
    # Säästää käyttäjältä minuutin "still waiting" -lokia kun verkko on rikki.
    if not bind_mode and not args.simulator:
        import subprocess as _sp
        try:
            r = _sp.run(["ping", "-n", "1", "-w", "800", args.remote_ip],
                        capture_output=True, text=True, timeout=3)
            reachable = ("TTL=" in r.stdout) or ("ttl=" in r.stdout.lower())
        except Exception:
            reachable = False
        if not reachable:
            print(f"[preflight] ⚠ {args.remote_ip} EI VASTAA pingiin.")
            print(f"[preflight]   Laptop on todennäköisesti eri verkossa kuin SeeTrue-server.")
            print(f"[preflight]   Tarkista: ipconfig | findstr IPv4")
            print(f"[preflight]   Vinkkejä:")
            print(f"[preflight]     · liity samaan WiFiin/hotspotiin missä SeeTrue-kone on")
            print(f"[preflight]     · jos server on samassa LANissa, etsi sen IP arp -a:lla")
            print(f"[preflight]     · simulaattoritesti: --simulator (toiseen termiin simulator.py)")
            print(f"[preflight]   Bridge jatkaa silti — voit pysäyttää Ctrl+C:llä.\n")
        else:
            print(f"[preflight] ✓ {args.remote_ip} vastaa pingiin")

    # ── UDP handshake: tell SeeTrueEyeServer to start streaming ─────────────
    # Tämä korvaa SeeTrueTechLauncherin tekemän alustusvaiheen. Ilman tätä ZMQ
    # portit pysyvät hiljaa vaikka server pyörii.
    if auto_start:
        try:
            kick_seetrue_stream(args.remote_ip, prefer_device=args.device)
        except Exception as exc:
            print(f"[handshake] FAILED: {exc} — jatketaan, mutta data ei ehkä virtaa")

    gesture_q = mpr.Queue(maxsize=64)
    gaze_q    = mpr.Queue(maxsize=512)

    # Shared memory live gaze:lle (gx, gy, pupilL, pupilR, ts).
    # gaze_worker kirjoittaa, gesture_worker lukee ja piirtää scene-cam-
    # ikkunaan. Kevyt mp.Array — ei lockia, pieni racing OK visualisointiin.
    gaze_shared = mpr.Array("d", [0.0, 0.0, 0.0, 0.0, 0.0])

    # Gaze worker AINA päällä — SeeTrue-data on bridgen pääfunktio
    gaze_proc = mpr.Process(target=gaze_worker,
                            args=(args.remote_ip, gaze_q, bind_mode, gaze_shared),
                            daemon=True)
    gaze_proc.start()
    print(f"[Bridge] gaze worker pid={gaze_proc.pid}")

    if not args.no_gesture:
        proc = mpr.Process(target=gesture_worker,
                           args=(args.remote_ip, gesture_q, bind_mode,
                                 show_window, gaze_shared),
                           daemon=True)
        proc.start()
        print(f"[Bridge] gesture worker pid={proc.pid}")
    else:
        print("[Bridge] gesture worker disabled (--no-gesture)")

    if args.enable_webcam:
        cam_proc = mpr.Process(target=webcam_worker,
                               args=(gesture_q, 0, show_window),
                               daemon=True)
        cam_proc.start()
        print(f"[Bridge] webcam worker pid={cam_proc.pid}")
    else:
        print("[Bridge] webcam worker disabled (use --enable-webcam to opt in)")

    server = await serve(ws_handler, WS_HOST, WS_PORT)
    print(f"[WS] listening on ws://{WS_HOST}:{WS_PORT}")
    await asyncio.gather(
        server.wait_closed(),
        gaze_relay(gaze_q),
        gesture_relay(gesture_q),
        heartbeat_loop(),
    )


if __name__ == "__main__":
    mpr.freeze_support()
    asyncio.run(main())
