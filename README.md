# UltraVision — SeeTrue-lasit + Daemon Chrome-laajennus

**Yhdistetty stäkki**: SeeTrue-silmänseurantalaseilla mitatusta katseesta,
pupillin koosta ja käden eleistä päätellään milloin YouTube Shorts -video
skipataan automaattisesti. Daemonin webkamera täydentää tätä rPPG-sykkeellä,
kasvon ilmeillä ja pään asennolla.

## Mitä järjestelmä tekee

Avaat YouTube Shorts -sivun lasit päässä. Mittaripalkki ilmestyy ruudulle.
Kun signaalit kertovat että video ei kiinnosta — pupilli pienenee, katse
karkaa ruudusta, kulmakarvat painuvat, hymy katoaa — pinkki indicator-palkki
alkaa kasvaa. Jos signaali kestää 1 sekunnin verran, video skipataan
automaattisesti seuraavaan.

Käden eleet scene-kameran edessä ohittavat algoritmin:
- **Käsi alas** = skippaa nyt
- **Käsi ylös** = takaisin edelliseen videoon
- **Pään pudistus** = pakkoskip
- **Nyökkäys** = pidä video pidempään

## Arkkitehtuuri yhdellä silmäyksellä

```
┌──────────────────┐         ┌──────────────────┐         ┌──────────────────┐
│ SeeTrue-lasit    │  ZMQ    │ python/gaze_    │   WS    │ Daemon Chrome   │
│ (laite)          │────────▶│ bridge/         │────────▶│ extension       │
│                  │  3428   │ bridge.py       │  8765   │ (daemon-       │
│ · katse          │  3425   │                  │         │  extension/)   │
│ · pupillit       │         │ · UDP handshake │         │                 │
│ · scene-kamera   │         │ · sync ZMQ pull │         │ · rPPG syke    │
└──────────────────┘         │ · käsi-eleet    │         │ · ilmeet       │
                             │ · 1 Hz heartbeat│         │ · pään asento  │
                             │ · WS pub/sub    │         │ · Shorts skip  │
                             └──────────────────┘         └──────────────────┘
```

Lasit ovat **pääsignaali**. Webkamera täydentää signaaleita ja toimii backuppinä
jos lasit eivät ole päällä.

## Asennus toiselle koneelle

```bash
git clone https://github.com/NooaL1/ultravision_chrome_extnsion.git
cd ultravision_chrome_extnsion
```

### Python-puoli (bridge)

```bash
pip install websockets pyzmq mediapipe opencv-python numpy
```

### Chrome-laajennus

1. Avaa `chrome://extensions`
2. Kytke "Developer mode" päälle (oikea yläkulma)
3. Klikkaa "Load unpacked"
4. Valitse `daemon-extension/`-kansio tästä klooatusta repostosta
5. Daemon ilmestyy työkalupalkkiin

## Käynnistys

### 1. Käynnistä SeeTrue-laite

- Liitä lasit ja käynnistä `SeeTrueEyeServer.exe` laitteen tietokoneella
  (oletuksena se kuuntelee porttia 3429 ja sen IP näkyy laitteen näytöltä)
- Varmista että laptop ja SeeTrue-kone ovat **samassa verkossa**

### 2. Käynnistä bridge

```powershell
python python/gaze_bridge/bridge.py --remote_ip 172.20.10.3 --no-display
```

`--remote_ip` korvataan SeeTrue-laitteen oikealla IP:llä. `--no-display`
ajaa MediaPipe-käsi-eletunnistuksen ilman cv2-ikkunaa (säästää RAMia).

Bridge tekee automaattisesti UDP-handshakean SeeTrue-serverille
(sendEyeTrackerTypeData → setEyeTrackerDevice → runPictureProcessing).
Lokissa pitäisi näkyä:

```
[preflight] ✓ 172.20.10.3 vastaa pingiin
[handshake] kicking SeeTrueEyeServer at 172.20.10.3:3429
[ZMQ] gaze parsed #1: {pupilL: 2.84, pupilR: 4.19, ...}
[Gesture] frame #1 (188 KB)
[WS] client connected
```

### 3. Käynnistä Daemon

- Klikkaa Daemon-ikoni Chromen työkalupalkista → Engine ON
- Salli webkameran käyttö
- Mille tahansa sivulle ilmestyy pinkki pilleri oikealle yläkulmaan ja
  klikkaamalla saat sci-fi-paneelin näkyviin (CARDIO, ROI, blendshapet,
  EMOTION, BPM TREND, **SEETRUE**)
- SEETRUE-osio näyttää pupillipalkit, sakkadit ja yhteyden tilan
  (live · N/s = vihreä, bridge ✓ · SeeTrue silent = kelta, bridge offline = punainen)

### 4. Avaa YouTube Shorts

```
https://www.youtube.com/shorts
```

Mittaripalkki ilmestyy vasempaan reunaan. Algoritmi alkaa toimia heti, mutta
**ensimmäiset ~30 sekuntia kerää baselinea** — älä huolehdi jos ei skippaa
tylsääkin videota heti, baseline-vaiheen jälkeen reagoi nopeammin.

## Tärkeimmät tiedostot

| Polku | Mitä |
|-------|------|
| `python/gaze_bridge/bridge.py` | Silta SeeTrue ↔ WebSocket. UDP handshake, ZMQ recv subprosessi, käsi-eleet, heartbeat. |
| `python/simple_gaze_receiver/main.py` | Alkuperäinen SeeTrue-vastaanotin (referenssi, ei käytetä bridgessä) |
| `python/gaze_data_simulator/simulator.py` | Lähettää valedataa testaukseen ilman lasit |
| `daemon-extension/manifest.json` | Chrome-laajennuksen manifesti (MV3) |
| `daemon-extension/offscreen.js` | Webkamera + MediaPipe + WebGazer + WebSocket-fuusio bridgeen |
| `daemon-extension/content.js` | Sci-fi HUD-paneeli joka injektoituu joka sivulle |
| `daemon-extension/shorts.js` | YouTube Shorts auto-skip -algoritmi |
| `daemon-extension/background.js` | Service worker joka relayttaa viestejä offscreen ↔ tabit |
| `API/SeeTrue Client API description v2.0.pdf` | Virallinen SeeTrue-API-dokumentti |

## Vianmääritys

| Oire | Korjaus |
|------|---------|
| `[ZMQ] still waiting for first gaze sample` | Tarkista IP, verkkoyhteys, että `SeeTrueEyeServer.exe` pyörii |
| `[preflight] ⚠ X EI VASTAA pingiin` | Et ole samassa verkossa kuin lasit. Vaihda WiFi tai tarkista IP `arp -a`:lla |
| Daemon HUDissa SEETRUE-chip on punainen `bridge offline` | Bridge ei pyöri tai sammui, käynnistä uudelleen |
| HUDin chip kelta `bridge ✓ · SeeTrue silent` | Bridge pystyssä mutta lasit ei lähetä → kalibroi laite, tarkista USB-liitäntä |
| Käsi-eleet eivät laukea Shortsissa | Päivitä Daemon-laajennus `chrome://extensions` → reload. Bridgessä pitäisi nähdä `[Gesture] OPEN-SWIPE NEXT` tai `[Gesture] SWIPE NEXT` |
| Shorts ei skippaa edes max-herkkyydellä | Anna 30 sek baselinen muodostumiseen. Avaa Shorts-sivun F12-konsoli ja katso `[content] ticks=` ja `[shorts] SeeTrue gesture:` -lokit |
| Liikaa muistia kuluu | `--no-display` (oletus) ja `--no-gesture` jos et tarvitse käsi-eleitä |

## Algoritmin pääpiirteet (shorts.js)

Tutkimuspohjainen multi-modaalinen disinterest-detektori:

1. **Per-user z-score baselinet** Welford+EWMA jokaiselle signaalille
   (pupil, blink, AU4 brow-down, AU12 smile, head yaw/pitch, saccade rate, HR)
2. **Multi-modal AND-gate**: vaaditaan ≥1–2 modaliteettia kynnyksen yli
3. **Schmitt-trigger hysteresis**: T_high → arm, T_low → disarm
4. **Dwell-time 0.7–1.5 s** ennen actionia (matchaa human reaction time)
5. **Pre-action indicator** näyttää kun skip on tulossa → käyttäjä voi vetäistä
   käden ylös tai katsoa videoon → schmitt purkaantuu
6. **Confidence floor**: jos kaikki signaalit ovat baseline-tasolla, mitään ei tapahdu
7. **Skip-cap**: enintään 25–80 % videoista (säädettävä) auto-skipataan sessiossa

Painot tutkimuksen suosituksesta:
yaw 0.20, gazeOff 0.20, pupil 0.15, blink 0.10, AU4 0.10, AU43 0.10,
smile -0.10, sacc 0.05, HR 0.05, pitch 0.10.

## Lisenssointi

Sisäinen prototyyppi — ei vielä julkista lisenssiä. Älä jaa repoa eteenpäin.

Vendored kolmannen osapuolen kirjastoja:
- MediaPipe (Apache-2.0) — `daemon-extension/wasm/`, `daemon-extension/lib/vision_bundle.mjs`
- WebGazer.js (LGPL-3.0) — `daemon-extension/lib/webgazer.min.js`
- YOLOv8 (Ultralytics, AGPL-3.0) — `yolov8s-world.pt` (vain `simple_gaze_receiver`-puolella)
- SeeTrue API — © SeeTrue Technologies

## Kehitys

```bash
# Tee muutoksia daemon-extension/-kansioon repon sisällä
# Reload Chromessa: chrome://extensions → Daemon → ⟳

# Bridge-puolen muutokset:
# Edit python/gaze_bridge/bridge.py → Ctrl+C bridge → restart

git add .
git commit -m "..."
git push
```
