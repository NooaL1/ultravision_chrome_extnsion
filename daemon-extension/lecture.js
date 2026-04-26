// Lecture mode: record audio + transcribe (fi-FI) + capture biometrics + save to IDB.

import { saveSession } from './idb.js';

const $ = id => document.getElementById(id);
const startBtn = $('start'), stopBtn = $('stop'), cancelBtn = $('cancel');
const statusEl = $('status'), transcriptEl = $('transcript');
const mBpm = $('m-bpm'), mFocus = $('m-focus'), mEmotion = $('m-emotion'), mTime = $('m-time');
const tlCv  = $('timeline'); const tlCtx = tlCv.getContext('2d');

let mediaStream = null, recorder = null, chunks = [];
let recognizer = null;
let startedAtMs = 0, sessionId = null;
let bio = [];          // {t, bpm, focus, emotion, blendshapes}
let segments = [];     // {start, end, text}
let interimText = '';
let lastBio = { bpm: null, snr: null, emotion: null, blendshapes: null, face: false };

// ----- biometric subscription -----
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'tick') Object.assign(lastBio, msg.payload || {});
});
chrome.runtime.sendMessage({ type: 'engine:state' }, (s) => {
  if (s) Object.assign(lastBio, s);
});

// Periodically capture a biometric sample (every 1s during recording)
setInterval(() => {
  if (!recorder || recorder.state !== 'recording') return;
  const t = (performance.now() - perfStart) / 1000; // seconds since rec start
  const sample = {
    t,
    bpm: lastBio.bpm || null,
    focus: computeFocus(lastBio),
    emotion: lastBio.emotion?.label || 'neutral',
    emoScore: lastBio.emotion?.score || 0,
    face: !!lastBio.face,
  };
  bio.push(sample);
  // UI updates
  if (sample.bpm) mBpm.textContent = sample.bpm.toFixed(0);
  mFocus.textContent = (sample.focus * 100).toFixed(0);
  mEmotion.textContent = sample.emotion;
  mTime.textContent = fmtTime(t);
  drawTimeline();
}, 1000);

let perfStart = 0;

function computeFocus(b) {
  // 0..1 — yhdistelmä: focused-tunne, ei väsymystä, naama näkyvissä
  if (!b || !b.face) return 0;
  const m = {};
  for (const s of (b.blendshapes || [])) m[s.name] = s.score;
  const tired   = ((m.eyeBlinkLeft || 0) + (m.eyeBlinkRight || 0)) / 2;
  const focused = b.emotion?.label === 'focused' ? (b.emotion.score || 0) : 0;
  const browDown = ((m.browDownLeft || 0) + (m.browDownRight || 0)) / 2;
  const eyeSquint = ((m.eyeSquintLeft || 0) + (m.eyeSquintRight || 0)) / 2;
  const concentration = Math.min(1, focused * 0.6 + browDown * 0.3 + eyeSquint * 0.3);
  const alertness = 1 - Math.min(1, tired * 1.5);
  return Math.max(0, Math.min(1, concentration * 0.6 + alertness * 0.4));
}

function fmtTime(s) {
  const m = Math.floor(s/60), ss = Math.floor(s%60);
  return `${m}:${String(ss).padStart(2,'0')}`;
}

// ----- start -----
startBtn.onclick = async () => {
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    alert('Mikkilupa hylätty: ' + e.message);
    return;
  }
  // Käynnistä Daemonin engine jos ei ole käynnissä, jotta biometria virtaa.
  chrome.runtime.sendMessage({ type: 'engine:start' });

  recorder = new MediaRecorder(mediaStream, { mimeType: pickMime() });
  chunks = [];
  recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  recorder.start(1000);
  perfStart = performance.now();
  startedAtMs = Date.now();
  bio = []; segments = []; interimText = '';
  transcriptEl.innerHTML = '';

  startSpeech();

  startBtn.disabled = true;
  stopBtn.disabled = false;
  cancelBtn.disabled = false;
  statusEl.textContent = 'äänitys käynnissä';
  statusEl.classList.add('rec');
};

function pickMime() {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
  for (const c of candidates) if (MediaRecorder.isTypeSupported(c)) return c;
  return '';
}

// ----- stop & save -----
stopBtn.onclick = async () => {
  await stopAll();
  statusEl.textContent = 'tallennetaan...';
  statusEl.classList.remove('rec');
  const blob = new Blob(chunks, { type: chunks[0]?.type || 'audio/webm' });
  const id = await saveSession({
    startedAt: startedAtMs,
    durationMs: Date.now() - startedAtMs,
    audioBlob: blob,
    transcript: segments,
    bio,
    title: `Luento ${new Date(startedAtMs).toLocaleString('fi-FI')}`
  });
  location.href = `review.html?id=${id}`;
};

cancelBtn.onclick = async () => {
  if (!confirm('Hylätäänkö äänitys ilman tallennusta?')) return;
  await stopAll();
  bio = []; segments = []; chunks = [];
  statusEl.textContent = 'peruutettu';
  statusEl.classList.remove('rec');
  startBtn.disabled = false;
  stopBtn.disabled = true; cancelBtn.disabled = true;
  transcriptEl.innerHTML = '<div class="hint">Käynnistä äänitys → puhe näkyy tässä reaaliajassa.</div>';
};

async function stopAll() {
  return new Promise(res => {
    if (!recorder || recorder.state === 'inactive') return res();
    recorder.onstop = () => {
      try { mediaStream?.getTracks().forEach(t => t.stop()); } catch {}
      try { recognizer?.stop(); } catch {}
      res();
    };
    recorder.stop();
  });
}

// ----- speech recognition (fi-FI) -----
function startSpeech() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    appendHint('Selaimesi ei tue SpeechRecognitionia. Pelkkä audio tallentuu.');
    return;
  }
  recognizer = new SR();
  recognizer.lang = 'fi-FI';
  recognizer.continuous = true;
  recognizer.interimResults = true;
  recognizer.onresult = (ev) => {
    let interim = '';
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const r = ev.results[i];
      const text = r[0].transcript;
      if (r.isFinal) {
        const tNow = (performance.now() - perfStart) / 1000;
        // Karkea heuristiikka: oletetaan että segmentti kesti ~ 0.4s/sana
        const dur = Math.max(1, text.split(/\s+/).length * 0.4);
        const seg = { start: Math.max(0, tNow - dur), end: tNow, text: text.trim() };
        segments.push(seg);
        appendFinal(seg);
      } else {
        interim += text;
      }
    }
    interimText = interim;
    renderInterim();
  };
  recognizer.onerror = (e) => {
    if (e.error === 'no-speech' || e.error === 'aborted') return;
    appendHint(`SpeechRecognition: ${e.error}`);
  };
  recognizer.onend = () => {
    // Käynnistä uudelleen jos vielä äänitetään (Chrome lopettaa noin minuutin välein)
    if (recorder && recorder.state === 'recording') {
      try { recognizer.start(); } catch {}
    }
  };
  try { recognizer.start(); } catch (e) { appendHint('SpeechRecognition start failasi: ' + e.message); }
}

function appendHint(msg) {
  const h = document.createElement('div');
  h.className = 'hint'; h.textContent = msg;
  transcriptEl.appendChild(h);
}
function appendFinal(seg) {
  const span = document.createElement('span');
  span.className = 'seg'; span.dataset.start = seg.start;
  // Tagaa segmentti focuksen mukaan (haetaan lähin bio-piste)
  const bp = nearestBio(seg.start);
  if (bp) {
    if (bp.focus < 0.35) span.classList.add('dip');
    else if (bp.focus > 0.7) span.classList.add('high');
  }
  span.innerHTML = `<span class="ts">${fmtTime(seg.start)}</span>${escapeHtml(seg.text)} `;
  // Korvaa interim
  removeInterim();
  // Poista alkuvinkki
  const hintEl = transcriptEl.querySelector('.hint');
  if (hintEl) hintEl.remove();
  transcriptEl.appendChild(span);
  renderInterim();
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}
function renderInterim() {
  removeInterim();
  if (!interimText) return;
  const span = document.createElement('span');
  span.className = 'seg interim'; span.id = '__d-interim';
  span.textContent = interimText + ' ';
  transcriptEl.appendChild(span);
}
function removeInterim() {
  const el = document.getElementById('__d-interim');
  if (el) el.remove();
}
function nearestBio(t) {
  if (!bio.length) return null;
  let best = bio[0], bd = Math.abs(bio[0].t - t);
  for (const b of bio) {
    const d = Math.abs(b.t - t);
    if (d < bd) { bd = d; best = b; }
  }
  return best;
}
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

// ----- timeline canvas -----
function drawTimeline() {
  const W = tlCv.width, H = tlCv.height;
  tlCtx.clearRect(0, 0, W, H);
  if (bio.length < 2) return;
  const t0 = bio[0].t, t1 = bio[bio.length-1].t;
  const span = Math.max(1, t1 - t0);

  // dips background
  tlCtx.fillStyle = 'rgba(255,200,80,.15)';
  let inDip = false, dipStart = 0;
  for (const b of bio) {
    const x = ((b.t - t0) / span) * W;
    if (b.focus < 0.35 && !inDip) { inDip = true; dipStart = x; }
    if (b.focus >= 0.35 && inDip) { tlCtx.fillRect(dipStart, 0, x - dipStart, H); inDip = false; }
  }
  if (inDip) tlCtx.fillRect(dipStart, 0, W - dipStart, H);

  // BPM line (top half)
  const bpms = bio.filter(b => b.bpm).map(b => b.bpm);
  if (bpms.length > 1) {
    let mn = Math.min(...bpms), mx = Math.max(...bpms);
    if (mx - mn < 6) { mn = (mn+mx)/2 - 3; mx = mn + 6; }
    tlCtx.strokeStyle = '#ff4d6d'; tlCtx.lineWidth = 1.5;
    tlCtx.beginPath();
    let first = true;
    for (const b of bio) {
      if (!b.bpm) continue;
      const x = ((b.t - t0) / span) * W;
      const y = H/2 - ((b.bpm - mn) / (mx - mn)) * (H/2 - 6) - 4;
      if (first) { tlCtx.moveTo(x, y); first = false; } else tlCtx.lineTo(x, y);
    }
    tlCtx.stroke();
  }

  // Focus line (bottom half)
  tlCtx.strokeStyle = '#51cf66'; tlCtx.lineWidth = 1.5;
  tlCtx.beginPath();
  for (let i = 0; i < bio.length; i++) {
    const b = bio[i];
    const x = ((b.t - t0) / span) * W;
    const y = H - b.focus * (H/2 - 6) - 4;
    if (i === 0) tlCtx.moveTo(x, y); else tlCtx.lineTo(x, y);
  }
  tlCtx.stroke();

  // Midline divider
  tlCtx.strokeStyle = 'rgba(255,255,255,.06)';
  tlCtx.beginPath(); tlCtx.moveTo(0, H/2); tlCtx.lineTo(W, H/2); tlCtx.stroke();
}
