// Offscreen engine: webcam + MediaPipe face mesh + POS rPPG + WebGazer.
// Sends ticks to service worker which broadcasts to all tabs.

import { FaceLandmarker, FilesetResolver }
  from "./lib/vision_bundle.mjs";

const send = (payload) => {
  try { chrome.runtime.sendMessage({ type: 'tick', payload }); } catch {}
};

// ── Fusion bridge (Ovision SeeTrue) ────────────────────────────────────────
const FUSION_URL = 'ws://localhost:8765';
let fusionWs = null;
let fusionConnected = false;
let lastOvision = {
  // packed by source key
  gaze: null,        // { gx, gy, ts, event, pupilL, pupilR }
  pupil: null,       // { L, R, mean, ts } latest pupil mm reading
  gesture: null,     // { gesture, ts }
  face: null,        // { smile, mouth_open, brow, ts }
  bridge: null,      // { seetrue_alive, msgs_per_sec, last_event_age_s, total_msgs, ts }
  scene: null,       // { dataUrl, w, h, ts } SeeTrue-skenekameran live JPEG
  // derived live signals
  saccadePerSec: 0,
  fixDwellMs: 0,
  lastEventChangeT: 0,
  // event-rate tracker
  _eventTimes: [],   // recent saccade ts (perf-now-like) for rate calc
  // last pupil samples for shorts/HUD (mean over both eyes when valid)
};
let lastFusionSendT = 0;
const FUSION_SEND_MIN_MS = 180;   // send Daemon -> bridge ≤ ~5 Hz

function fusionSend(obj) {
  if (!fusionConnected || !fusionWs) return;
  try { fusionWs.send(JSON.stringify(obj)); } catch {}
}

function fusionTickFromDaemon() {
  // Avoid hammering: cap at FUSION_SEND_MIN_MS regardless of caller cadence.
  const now = Date.now();
  if (now - lastFusionSendT < FUSION_SEND_MIN_MS) return;
  lastFusionSendT = now;
  fusionSend({
    source: 'daemon',
    ts: now,
    bpm: currentBpm || null,
    snr: lastSnrSent,
    fps: loopFps,
    emotion: lastEmotion,
    headPose: lastHeadPose,
    face: lastFaceVisible,
    blendshapesTop: lastTopBlendshapes,
  });
}

// ── Stream webkameran kuva bridgelle WS:n yli ──────────────────────────────
// Bridge avaa cv2-ikkunan johon näyttää tämän streamin. Webkamera-contention
// (Windows: kahden prosessin avata sama kamera) ratkeaa kun vain Daemonin
// offscreen-Chrome omistaa kameran ja python näyttää sen lähetetyn datan.
const _wcStreamCv = document.createElement('canvas');
_wcStreamCv.width = 480; _wcStreamCv.height = 360;
const _wcStreamCtx = _wcStreamCv.getContext('2d');
let _wcStreamBusy = false;
let _wcStreamLastT = 0;
async function streamWebcamToBridge() {
  if (!fusionConnected || !video || !video.videoWidth) return;
  if (_wcStreamBusy) return;
  const now = Date.now();
  if (now - _wcStreamLastT < 100) return;   // ≤ 10 fps
  _wcStreamLastT = now;
  _wcStreamBusy = true;
  try {
    _wcStreamCtx.drawImage(video, 0, 0, _wcStreamCv.width, _wcStreamCv.height);
    const blob = await new Promise(r => _wcStreamCv.toBlob(r, 'image/jpeg', 0.55));
    if (!blob) { _wcStreamBusy = false; return; }
    const ab = await blob.arrayBuffer();
    const bytes = new Uint8Array(ab);
    // base64-koodaa chunkeissa ettei stack-kaadu suurilla blobeilla
    let bin = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    const b64 = btoa(bin);
    fusionSend({ source: 'daemon-webcam', ts: now, w: 480, h: 360, jpeg: b64 });
  } catch (e) {
    // toBlob/arrayBuffer voi heittää jos canvas tyhjä — ohita
  } finally {
    _wcStreamBusy = false;
  }
}
setInterval(streamWebcamToBridge, 120);  // tähtää ~8–10 fps

function ingestOvisionMessage(obj) {
  if (!obj || typeof obj !== 'object') return;
  _fusionIngestCount++;
  const src = obj.source;
  if (_fusionIngestCount <= 5 || _fusionIngestCount % 200 === 0) {
    console.log(`[fusion] ingest #${_fusionIngestCount} src=${src}`,
                JSON.stringify(obj).slice(0, 200));
  }
  // Ovision gaze stream — primary signal: per-eye pupil mm + screen-frac gaze
  if (src === 'ovision-gaze') {
    lastOvision.gaze = {
      gx: obj.gx, gy: obj.gy,
      pupilL: obj.pupilL, pupilR: obj.pupilR,
      event: obj.event, ts: obj.ts,
    };
    if (typeof obj.pupilL === 'number' && typeof obj.pupilR === 'number') {
      const valid = (v) => Number.isFinite(v) && v > 0.5 && v < 12;
      const L = valid(obj.pupilL) ? obj.pupilL : null;
      const R = valid(obj.pupilR) ? obj.pupilR : null;
      let mean = null;
      if (L !== null && R !== null) mean = (L + R) / 2;
      else if (L !== null) mean = L;
      else if (R !== null) mean = R;
      if (mean !== null) {
        lastOvision.pupil = { L, R, mean, ts: obj.ts };
      }
    }
    // Saccade rate over 5 s rolling window (event field == "SACCADE")
    if (typeof obj.event === 'string') {
      const now = performance.now();
      if (obj.event.toUpperCase().includes('SACCADE')) {
        lastOvision._eventTimes.push(now);
      }
      while (lastOvision._eventTimes.length &&
             now - lastOvision._eventTimes[0] > 5000) {
        lastOvision._eventTimes.shift();
      }
      lastOvision.saccadePerSec = lastOvision._eventTimes.length / 5;
      // Track fixation dwell — duration since last non-FIXATION event
      const isFix = obj.event.toUpperCase().includes('FIXATION');
      if (!isFix) lastOvision.lastEventChangeT = now;
      lastOvision.fixDwellMs = isFix
        ? Math.max(0, now - lastOvision.lastEventChangeT)
        : 0;
    }
    return;
  }
  if (src === 'ovision-gesture') {
    lastOvision.gesture = { gesture: obj.gesture, ts: obj.ts };
    return;
  }
  if (src === 'ovision-face') {
    lastOvision.face = { ...(obj.face || {}), ts: obj.ts };
    return;
  }
  if (src === 'ovision-scene' && obj.jpeg) {
    // Lasit-skenekameran kuva (240×180 JPEG base64).
    // Tallennetaan dataURL ja pusketaan content.js:lle joka piirtää
    // sen + gaze-pisteen päälle "mihin lasit katsovat juuri nyt".
    lastOvision.scene = {
      dataUrl: 'data:image/jpeg;base64,' + obj.jpeg,
      w: obj.w || 240, h: obj.h || 180, ts: obj.ts,
    };
    return;
  }
  // Bridge heartbeat — diagnostiikka 1 Hz: kertoo onko SeeTrue oikeasti elossa
  if (src === 'bridge' && obj.heartbeat) {
    lastOvision.bridge = {
      seetrue_alive: !!obj.seetrue_alive,
      msgs_per_sec: obj.msgs_per_sec || 0,
      last_event_age_s: obj.last_event_age_s,
      total_msgs: obj.total_msgs || 0,
      ts: performance.now(),
    };
    return;
  }
  // Ignore daemon echoes (broadcast_to_others already excludes sender, but be safe)
  if (src === 'daemon') return;
}

// Debug counters — printtaa kerran sekunnissa että näkee virtaako data.
let _fusionRxCount = 0;       // raw WS messages received
let _fusionIngestCount = 0;   // messages routed by ingestOvisionMessage
let _emitCount = 0;           // ovision ticks broadcast
setInterval(() => {
  if (fusionConnected || _fusionRxCount > 0) {
    console.log(`[fusion] rx=${_fusionRxCount} ingest=${_fusionIngestCount} emit=${_emitCount} ` +
      `state{gaze:${!!lastOvision.gaze} pupil:${!!lastOvision.pupil} ` +
      `bridge:${!!lastOvision.bridge}}`);
  }
}, 1000);

// Lähetä scene-cam-kuva VAIN kun se on UUSI — muuten emit-tickit kuljettavat
// turhaan saman ison base64-payloadin chromen msg-channelin yli ja browser
// ruuhkautuu. Pidetään kirjaa siitä, mitä viimeksi lähetettiin.
let _lastEmittedSceneTs = 0;
function emitOvisionTick() {
  // Forward latest Ovision snapshot to consumers (HUD, shorts) at 10 Hz.
  if (!lastOvision.gaze && !lastOvision.pupil && !lastOvision.gesture
      && !lastOvision.face && !lastOvision.bridge && !fusionConnected) return;

  // Sisällytä scene vain jos se on uusi — säästää bandwidthia 90 %.
  let sceneToSend = null;
  if (lastOvision.scene && lastOvision.scene.ts !== _lastEmittedSceneTs) {
    sceneToSend = lastOvision.scene;
    _lastEmittedSceneTs = lastOvision.scene.ts;
  }

  const out = { ovision: {
    pupil: lastOvision.pupil,
    gaze: lastOvision.gaze ? { gx: lastOvision.gaze.gx,
                               gy: lastOvision.gaze.gy,
                               event: lastOvision.gaze.event } : null,
    gesture: lastOvision.gesture,
    saccadePerSec: lastOvision.saccadePerSec,
    fixDwellMs: lastOvision.fixDwellMs,
    face: lastOvision.face,
    bridge: lastOvision.bridge,
    scene: sceneToSend,    // null jos ei uutta, muuten {dataUrl,w,h,ts}
    connected: fusionConnected,
  }};
  _emitCount++;
  send(out);
}

// 10 Hz emit-timer luodaan KERRAN — ei joka uudelleenyhdistyksen yhteydessä,
// muuten reconnectit vuotavat asteittain CPU:ta ja muistia.
let _ovisionEmitTimer = null;

function connectFusion() {
  let backoffMs = 1000;
  const open = () => {
    try {
      fusionWs = new WebSocket(FUSION_URL);
    } catch (e) {
      console.warn('[fusion] ctor failed', e);
      scheduleRetry();
      return;
    }
    fusionWs.onopen = () => {
      fusionConnected = true;
      backoffMs = 1000;
      console.log('[fusion] connected', FUSION_URL);
      send({ fusion: { connected: true } });
    };
    fusionWs.onmessage = (ev) => {
      _fusionRxCount++;
      let raw = ev.data;
      if (typeof raw !== 'string') return;
      let obj;
      try { obj = JSON.parse(raw); } catch (e) {
        if (_fusionRxCount <= 3) console.warn('[fusion] parse fail', raw.slice(0,80));
        return;
      }
      ingestOvisionMessage(obj);
    };
    fusionWs.onerror = (e) => {
      // onclose will fire next; just log once
      console.warn('[fusion] error', e?.message || '');
    };
    fusionWs.onclose = () => {
      const wasConnected = fusionConnected;
      fusionConnected = false;
      fusionWs = null;
      if (wasConnected) console.log('[fusion] disconnected');
      // Tyhjennä bridge-heartbeat: ei vanhentunutta "alive" tilaa harhauttamaan HUDia
      lastOvision.bridge = null;
      send({ fusion: { connected: false } });
      scheduleRetry();
    };
  };
  const scheduleRetry = () => {
    setTimeout(open, backoffMs);
    backoffMs = Math.min(8000, Math.round(backoffMs * 1.5));
  };
  open();
  // Forward latest Ovision state to listeners at 10 Hz — vain ensimmäisellä kerralla
  if (_ovisionEmitTimer === null) {
    _ovisionEmitTimer = setInterval(emitOvisionTick, 100);
  }
}

// Cached Daemon-side biometrics for fusion outbound (last seen).
let lastSnrSent = null;
let lastEmotion = null;
let lastHeadPose = null;
let lastFaceVisible = null;
let lastTopBlendshapes = null;

// Time-based buffering (not sample-based) — toimii myös 3-5 fps:llä.
const WIN_SEC = 10;          // FFT-ikkuna sekunteina
const MIN_ANALYZE_SEC = 3;   // näyttää lukeman heti — laadusta välittämättä
const rB = [], gB = [], bB = [], tB = [];
let currentBpm = 0;
const bpmHist = [];
const bpmTimeline = []; // {t, bpm} — viim. 60s
const emotionTimeline = []; // {t, label, score}
let lastWaveform = null;   // normalisoitu Float32Array
let lastSpectrum = null;   // {bpms: Float32Array, powers: Float32Array}

let video, sample, sCtx;
let landmarker = null;
let started = false;

// Amplifioitu ROI -näkymä
const AMP_W = 60, AMP_H = 45, AMP_GAIN = 50, AMP_ALPHA = 0.03;
let ampCanvas, ampCtx, ampMean = null, ampImg = null;

async function start() {
  if (started) return;
  started = true;

  video = document.createElement('video');
  video.autoplay = true; video.playsInline = true; video.muted = true;
  document.body.appendChild(video);

  sample = document.createElement('canvas');
  sCtx = sample.getContext('2d', { willReadFrequently: true });

  // 1) Webcam ENSIN — kamera syttyy heti, virheet näkyviksi popupiin.
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480, frameRate: { ideal: 30 } }, audio: false
    });
  } catch (e) {
    const msg = e && (e.name + ': ' + (e.message || '')) || String(e);
    console.error('getUserMedia failed', e);
    send({ error: 'Webcam: ' + msg, running: false });
    started = false;
    return;
  }
  video.srcObject = stream;
  await video.play();
  send({ running: true, error: null });

  // 2) MediaPipe taustalla — kokeile GPU, fallback CPU. Raportoi tilan.
  (async () => {
    let fileset;
    try {
      fileset = await FilesetResolver.forVisionTasks(chrome.runtime.getURL('wasm'));
      console.log('FilesetResolver loaded');
    } catch (e) {
      console.error('FilesetResolver failed', e);
      send({ error: 'WASM lataus failasi: ' + (e?.message || e) });
      return;
    }
    const opts = (delegate) => ({
      baseOptions: {
        modelAssetPath: chrome.runtime.getURL('models/face_landmarker.task'),
        delegate
      },
      runningMode: 'VIDEO',
      numFaces: 1,
      outputFaceBlendshapes: true,
      outputFacialTransformationMatrixes: true
    });
    for (const d of ['GPU', 'CPU']) {
      try {
        landmarker = await FaceLandmarker.createFromOptions(fileset, opts(d));
        console.log('FaceLandmarker ready (' + d + ')');
        send({ mp: d });
        return;
      } catch (e) {
        console.warn('FaceLandmarker ' + d + ' init failed', e);
        send({ error: 'FL/' + d + ': ' + (e?.message || e) });
      }
    }
  })();

  // WebGazer (loaded as classic <script> in offscreen.html)
  if (window.webgazer) {
    try {
      webgazer.params.showVideoPreview = false;
      webgazer.params.showFaceOverlay = false;
      webgazer.params.showFaceFeedbackBox = false;
      webgazer.params.showGazeDot = false;
      webgazer.saveDataAcrossSessions(true);
      webgazer.setRegression('ridge').setGazeListener(onGaze);
      await webgazer.begin();
      try { webgazer.showVideoPreview(false).showPredictionPoints(false); } catch {}
    } catch (e) {
      console.warn('webgazer init failed', e);
    }
  } else {
    console.warn('webgazer not loaded');
  }

  scheduleNext();

  // WebGazer:n oma loop on rAF-pohjainen ja se throttlautuu offscreenissä
  // ~1 Hz:iin. Pollataan ennustetta itse 10 Hz:n tahdilla.
  if (window.webgazer) {
    setInterval(async () => {
      try {
        const p = await webgazer.getCurrentPrediction();
        if (p) send({ gaze: { x: p.x, y: p.y } });
      } catch {}
    }, 100);
  }

  // Bridge to ovision/bridge.py (SeeTrue + Ovision workers).
  connectFusion();
}

// rAF JA video.requestVideoFrameCallback ovat molemmat throttlattuja
// hidden offscreen -dokumenteissa. setInterval ei ole.
let _loopTimer = null;
function scheduleNext() {
  if (_loopTimer) return;
  _loopTimer = setInterval(loop, 33); // ~30 Hz
}

function onGaze(data) {
  if (!data) return;
  // window.screenX/Y available in offscreen? Usually 0,0. WebGazer trained
  // with screen coords during calibration -> predictions are screen coords directly.
  send({ gaze: { x: data.x, y: data.y } });
}

let lastVT = -1, frame = 0;
let loopFps = 0, loopFpsT = performance.now(), loopFpsCount = 0;

// Heartbeat — kerran sekunnissa lokita tila ja lähetä diagnostiikka.
setInterval(() => {
  const buf = tB.length > 1 ? (tB[tB.length-1] - tB[0]).toFixed(1) : '0';
  console.log(`[daemon] frame=${frame} loopFps=${loopFps.toFixed(1)} buf=${buf}s mp=${landmarker?'Y':'N'} bpm=${currentBpm}`);
  send({ loopFps, bufSec: parseFloat(buf) });
}, 1000);

function loop() {
  loopFpsCount++;
  const now = performance.now();
  if (now - loopFpsT > 500) {
    loopFps = loopFpsCount * 1000 / (now - loopFpsT);
    loopFpsCount = 0; loopFpsT = now;
  }
  if (!video.videoWidth) { scheduleNext(); return; }
  if (sample.width !== video.videoWidth) {
    sample.width = video.videoWidth; sample.height = video.videoHeight;
  }
  sCtx.drawImage(video, 0, 0);

  let roi = null;
  if (landmarker && video.currentTime !== lastVT) {
    lastVT = video.currentTime;
    const r = landmarker.detectForVideo(video, performance.now());
    if (r.faceLandmarks && r.faceLandmarks.length > 0) {
      roi = computeForeheadROI(r.faceLandmarks[0], sample.width, sample.height);
      // Cache uusimmat landmarkit, mutta itse preview piirtyy ALLA aina —
      // näin webkameran kuva päivittyy jokaisella loop-iteraatiolla
      // (~30 Hz target, todellisuudessa 5–15 fps CPU:n mukaan).
      _lastFaceLandmarks = r.faceLandmarks[0];
    }
    // Pään asento — joka frame, kevyt
    if (r.facialTransformationMatrixes && r.facialTransformationMatrixes.length > 0) {
      const m = r.facialTransformationMatrixes[0].data;
      // Column-major 4x4. Yaw = atan2(m[8], m[10]), pitch = asin(-m[9]), roll = atan2(m[1], m[5]).
      const yaw   = Math.atan2(m[8], m[10]) * 180 / Math.PI;
      const pitch = Math.asin(-Math.max(-1, Math.min(1, m[9]))) * 180 / Math.PI;
      const roll  = Math.atan2(m[1], m[5]) * 180 / Math.PI;
      lastHeadPose = { yaw, pitch, roll };
      send({ headPose: lastHeadPose });
    }
    // Lähetä top-blendshapes (mikroilmeet) joka 6. frame
    if (frame % 6 === 0 && r.faceBlendshapes && r.faceBlendshapes.length > 0) {
      const cats = r.faceBlendshapes[0].categories || [];
      const top = cats
        .filter(c => c.categoryName !== '_neutral' && c.score > 0.05)
        .sort((a, b) => b.score - a.score)
        .slice(0, 8)
        .map(c => ({ name: c.categoryName, score: c.score }));
      const emotion = inferEmotion(cats);
      const now = performance.now();
      emotionTimeline.push({ t: now, label: emotion.label, score: emotion.score });
      while (emotionTimeline.length > 0 && now - emotionTimeline[0].t > 30000) emotionTimeline.shift();
      send({ blendshapes: top, emotion });
      lastEmotion = emotion;
      lastTopBlendshapes = top;
    }
  }

  if (roi) {
    sampleROI(roi);
    if (frame % 15 === 0) { lastFaceVisible = true; send({ face: true }); }
    // analysoi sekuntipohjaisesti — toimii myös 5 fps:llä
    const haveSec = tB.length > 1 ? (tB[tB.length-1] - tB[0]) : 0;
    if (haveSec >= MIN_ANALYZE_SEC && frame % 10 === 0) analyze();
  } else if (frame % 15 === 0) {
    lastFaceVisible = false;
    send({ face: false });
  }

  // Webkameran preview Chromeen on POISTETTU — natiivit cv2-ikkunat
  // bridgessä näyttävät sekä webcam-kuvan että lasit-kameran ja gaze-pisteen
  // huomattavasti sulavammin (ei chrome.runtime.sendMessage-overheadia).
  // Jos haluat preview takaisin Chromeen: poista alla oleva early-return.
  // if (frame % 2 === 0) renderWebcamPreview(_lastFaceLandmarks);

  frame++;
  scheduleNext();
}

// Cachattu uusin face-mesh landmark-array. renderWebcamPreview piirtää
// ne preview-canvasille reaaliajassa, vaikka MediaPipe ei juuri nyt
// laskisi uutta detektiota.
let _lastFaceLandmarks = null;

// Karkeat tunne-arviot blendshape-aktivaatioista. Palauttaa { label, score }.
function inferEmotion(categories) {
  const m = {};
  for (const c of categories) m[c.categoryName] = c.score;
  const v = (k) => m[k] || 0;

  const happy    = (v('mouthSmileLeft') + v('mouthSmileRight')) / 2;
  const sad      = (v('mouthFrownLeft') + v('mouthFrownRight')) / 2 + v('browInnerUp') * 0.5;
  const surprise = v('jawOpen') * 0.6 + v('eyeWideLeft') * 0.2 + v('eyeWideRight') * 0.2 + v('browInnerUp') * 0.4;
  const anger    = (v('browDownLeft') + v('browDownRight')) / 2 + (v('eyeSquintLeft') + v('eyeSquintRight')) / 4;
  const disgust  = (v('noseSneerLeft') + v('noseSneerRight')) / 2 + v('mouthUpperUpLeft') * 0.3;
  const focus    = (v('eyeSquintLeft') + v('eyeSquintRight')) / 2 + v('browDownLeft') * 0.3;
  const tired    = (v('eyeBlinkLeft') + v('eyeBlinkRight')) / 2;

  const cands = [
    ['happy', happy], ['sad', sad], ['surprised', surprise],
    ['angry', anger], ['disgusted', disgust], ['focused', focus], ['tired', tired],
  ];
  cands.sort((a, b) => b[1] - a[1]);
  const [label, score] = cands[0];
  return score < 0.12 ? { label: 'neutral', score: 0 } : { label, score };
}

// ── Webkameran preview HUDille ──────────────────────────────────────────
// Renderöi webkameran kuvan pienelle canvasille + face-mesh overlay
// (tärkeimmät landmarkit + kontuurit) ja lähettää pixel-datan content.js:lle
// joka piirtää sen Daemon-paneelin "WEBCAM"-celliin. Pyörii ~10 fps:llä.
const WEBCAM_PREVIEW_W = 240, WEBCAM_PREVIEW_H = 180;
let _webcamCanvas = null, _webcamCtx = null, _webcamImg = null;

// Mediapipe Face Mesh -indekseiltä piirrettävät pisteet:
// silmien ääriviivat, kulmat, suun reunat, kasvon ovaali — visuaalinen impact
// ilman että piirretään koko 478 pistettä joka frame.
const FACE_HIGHLIGHT_IDX = [
  // kasvojen ovaali
  10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288,
  397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136,
  172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109,
  // silmät
  33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246,
  263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386, 387, 388, 466,
  // kulmakarvat
  70, 63, 105, 66, 107, 55, 65, 52, 53, 46,
  300, 293, 334, 296, 336, 285, 295, 282, 283, 276,
  // suu
  61, 84, 17, 314, 405, 320, 307, 375, 321, 308, 324, 318,
  78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308, 415,
];

function renderWebcamPreview(landmarks) {
  if (!_webcamCanvas) {
    _webcamCanvas = document.createElement('canvas');
    _webcamCanvas.width = WEBCAM_PREVIEW_W;
    _webcamCanvas.height = WEBCAM_PREVIEW_H;
    _webcamCtx = _webcamCanvas.getContext('2d', { willReadFrequently: true });
  }
  // 1) Piirrä peilattu video (selfie-näkymä) preview-kokoon
  _webcamCtx.save();
  _webcamCtx.translate(WEBCAM_PREVIEW_W, 0);
  _webcamCtx.scale(-1, 1);
  _webcamCtx.drawImage(video, 0, 0, WEBCAM_PREVIEW_W, WEBCAM_PREVIEW_H);
  _webcamCtx.restore();

  // 2) Piirrä face-landmarkit reunusta hiukan vahvistettuna
  _webcamCtx.fillStyle = '#5c9eff';
  _webcamCtx.shadowColor = '#5c9eff';
  _webcamCtx.shadowBlur = 4;
  for (const idx of FACE_HIGHLIGHT_IDX) {
    const p = landmarks[idx];
    if (!p) continue;
    // Mirror x because the video was mirrored above
    const x = (1 - p.x) * WEBCAM_PREVIEW_W;
    const y = p.y * WEBCAM_PREVIEW_H;
    _webcamCtx.fillRect(x - 1, y - 1, 2, 2);
  }
  _webcamCtx.shadowBlur = 0;
  // 3) Saa raw pixels → content.js voi piirtää ne suoraan
  if (!_webcamImg) {
    _webcamImg = _webcamCtx.getImageData(0, 0, WEBCAM_PREVIEW_W, WEBCAM_PREVIEW_H);
  } else {
    _webcamImg = _webcamCtx.getImageData(0, 0, WEBCAM_PREVIEW_W, WEBCAM_PREVIEW_H);
  }
  send({
    webcamPreview: {
      pixels: _webcamImg.data,
      w: WEBCAM_PREVIEW_W, h: WEBCAM_PREVIEW_H,
    }
  });
}

function computeForeheadROI(lm, W, H) {
  const ids = [10, 67, 297, 9, 151, 108, 337, 69, 299];
  let xmin=1, xmax=0, ymin=1, ymax=0;
  for (const id of ids) {
    const p = lm[id];
    if (p.x < xmin) xmin = p.x;
    if (p.x > xmax) xmax = p.x;
    if (p.y < ymin) ymin = p.y;
    if (p.y > ymax) ymax = p.y;
  }
  const w = xmax - xmin, h = ymax - ymin;
  xmin += w*0.10; xmax -= w*0.10;
  ymin += h*0.15; ymax -= h*0.05;
  return {
    x: Math.max(0, Math.floor(xmin*W)),
    y: Math.max(0, Math.floor(ymin*H)),
    w: Math.max(1, Math.floor((xmax-xmin)*W)),
    h: Math.max(1, Math.floor((ymax-ymin)*H))
  };
}

function sampleROI({ x, y, w, h }) {
  const img = sCtx.getImageData(x, y, w, h).data;
  let sr=0, sg=0, sb=0, n=0;
  for (let i=0; i<img.length; i+=4) {
    const r=img[i], g=img[i+1], b=img[i+2];
    const lum = (r+g+b)/3;
    if (lum < 30 || lum > 245) continue;
    sr+=r; sg+=g; sb+=b; n++;
  }
  if (n === 0) return;
  const t = performance.now() / 1000;
  rB.push(sr/n); gB.push(sg/n); bB.push(sb/n); tB.push(t);
  while (tB.length > 2 && (tB[tB.length-1] - tB[0]) > WIN_SEC) {
    rB.shift(); gB.shift(); bB.shift(); tB.shift();
  }
  computeAmplifiedROI(x, y, w, h);
}

// Lasketaan amplifioitu ROI (per-pikselin EMA highpass + 50× gain).
// Lähetetään harvempaan, content scriptille renderöitäväksi.
function computeAmplifiedROI(x, y, w, h) {
  if (!ampCanvas) {
    ampCanvas = document.createElement('canvas');
    ampCanvas.width = AMP_W; ampCanvas.height = AMP_H;
    ampCtx = ampCanvas.getContext('2d', { willReadFrequently: true });
    ampImg = ampCtx.createImageData(AMP_W, AMP_H);
  }
  ampCtx.save();
  ampCtx.translate(AMP_W, 0); ampCtx.scale(-1, 1); // peilattu
  ampCtx.drawImage(sample, x, y, w, h, 0, 0, AMP_W, AMP_H);
  ampCtx.restore();
  const cur = ampCtx.getImageData(0, 0, AMP_W, AMP_H).data;
  if (!ampMean) {
    ampMean = new Float32Array(cur.length);
    for (let i=0; i<cur.length; i++) ampMean[i] = cur[i];
  }
  const out = ampImg.data;
  for (let i=0; i<cur.length; i+=4) {
    for (let c=0; c<3; c++) {
      const v = cur[i+c];
      const m = ampMean[i+c] = ampMean[i+c]*(1-AMP_ALPHA) + v*AMP_ALPHA;
      let amp = m + (v - m) * AMP_GAIN;
      if (amp < 0) amp = 0; else if (amp > 255) amp = 255;
      out[i+c] = amp;
    }
    out[i+3] = 255;
  }
}

function pos(r, g, b, fs) {
  const L = r.length;
  // Wang et al.: 1.6s ikkuna. Matalalla fs:llä clampataan että >= 4 samplea.
  const winSize = Math.max(4, Math.min(L, Math.round(1.6 * fs)));
  const H = new Array(L).fill(0);
  for (let n = winSize; n < L; n++) {
    const m = n - winSize;
    let mr=0, mg=0, mb=0;
    for (let i=m; i<n; i++) { mr+=r[i]; mg+=g[i]; mb+=b[i]; }
    mr/=winSize; mg/=winSize; mb/=winSize;
    const X = new Array(winSize), Y = new Array(winSize);
    for (let i=0; i<winSize; i++) {
      const rn = r[m+i]/mr, gn = g[m+i]/mg, bn = b[m+i]/mb;
      X[i] = gn - bn; Y[i] = gn + bn - 2*rn;
    }
    let mx=0, my=0;
    for (let i=0; i<winSize; i++){ mx+=X[i]; my+=Y[i]; }
    mx/=winSize; my/=winSize;
    let vx=0, vy=0;
    for (let i=0; i<winSize; i++){ vx+=(X[i]-mx)**2; vy+=(Y[i]-my)**2; }
    const sx = Math.sqrt(vx/winSize), sy = Math.sqrt(vy/winSize);
    const alpha = sy === 0 ? 0 : sx / sy;
    for (let i=0; i<winSize; i++) {
      H[m+i] += (X[i] - mx) + alpha * (Y[i] - my);
    }
  }
  return H;
}

function bpmFromSignal(h, fs) {
  let mean = 0; for (const v of h) mean += v; mean /= h.length;
  const x = new Array(h.length);
  for (let i=0; i<h.length; i++) {
    const w = 0.5 * (1 - Math.cos(2*Math.PI*i/(h.length-1)));
    x[i] = (h[i] - mean) * w;
  }
  let bestBpm = 0, bestPow = 0, totalPow = 0;
  let count = 0;
  const bpmMax = Math.min(240, fs * 30 * 0.9);
  // Tallennetaan koko spektri jotta content script voi piirtää sen.
  const bpms = [], powers = [];
  for (let bpm = 42; bpm <= bpmMax; bpm += 1) {
    const f = bpm / 60;
    const w = 2 * Math.PI * f / fs;
    let re=0, im=0;
    for (let i=0; i<x.length; i++) {
      re += x[i] * Math.cos(w*i);
      im += x[i] * Math.sin(w*i);
    }
    const p = re*re + im*im;
    totalPow += p; count++;
    bpms.push(bpm); powers.push(p);
    if (p > bestPow) { bestPow = p; bestBpm = bpm; }
  }
  const snr = 10 * Math.log10(bestPow / ((totalPow - bestPow) / (count - 1) + 1e-9));
  lastSpectrum = { bpms: new Float32Array(bpms), powers: new Float32Array(powers), peak: bestBpm };
  return { bpm: bestBpm, snr };
}

function analyze() {
  const dur = tB[tB.length-1] - tB[0];
  const fsEff = (tB.length-1) / dur;
  if (!isFinite(fsEff) || fsEff < 3) return;
  const h = pos(rB, gB, bB, fsEff);
  const { bpm, snr } = bpmFromSignal(h, fsEff);
  bpmHist.push(bpm); if (bpmHist.length > 5) bpmHist.shift();
  const sorted = [...bpmHist].sort((a,b)=>a-b);
  currentBpm = sorted[sorted.length>>1];

  // Aaltomuoto normalisoituna -> content scriptille
  let mn=Infinity, mx=-Infinity;
  for (const v of h) { if (v<mn) mn=v; if (v>mx) mx=v; }
  const span = (mx - mn) || 1;
  const wf = new Float32Array(Math.min(h.length, 200));
  const stride = h.length / wf.length;
  for (let i=0; i<wf.length; i++) wf[i] = (h[Math.floor(i*stride)] - mn) / span;
  lastWaveform = wf;

  // BPM-historia (60s)
  const now = performance.now();
  bpmTimeline.push({ t: now, bpm: currentBpm });
  while (bpmTimeline.length > 0 && now - bpmTimeline[0].t > 60000) bpmTimeline.shift();

  lastSnrSent = snr;
  send({ bpm: currentBpm, snr, fps: fsEff });
}

// Lähetä raskas data (amp ROI, waveform, spektri, timelinet) 5x sekunnissa.
setInterval(() => {
  if (!started) return;
  const payload = {};
  if (ampImg) payload.ampPixels = ampImg.data; // structuredClone hoitaa Uint8ClampedArray
  if (lastWaveform) payload.waveform = lastWaveform;
  if (lastSpectrum) {
    payload.spectrum = {
      bpms: lastSpectrum.bpms, powers: lastSpectrum.powers, peak: lastSpectrum.peak
    };
  }
  if (bpmTimeline.length) payload.bpmTimeline = bpmTimeline.slice();
  if (emotionTimeline.length) payload.emotionTimeline = emotionTimeline.slice();
  if (Object.keys(payload).length > 0) send(payload);
  // Push Daemon biometrics into the fusion bridge at the same cadence.
  fusionTickFromDaemon();
}, 200);

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'offscreen:start') start();
});

start().catch(e => console.error('offscreen start failed', e));
