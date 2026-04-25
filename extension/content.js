// content.js — YouTube Shorts Auto-Swiper (with live dashboard + save gesture)

const WS_URL           = "ws://localhost:8765";
const ROLLING_SEC      = 2.5;
const SETTLE_SEC       = 0.5;
const CHECK_EVERY_MS   = 500;
let BOREDOM_THRESH = parseInt(
  localStorage.getItem("__shorts_boredom_thresh__") || "80", 10
);
const THRESH_STEP = 3;
const THRESH_MIN  = 20;
const THRESH_MAX  = 95;
const SKIP_COOLDOWN_MS = 800;
const VERDICT_HOLD_MS  = 800;

// Skip-countdown / save-gesture
const COUNTDOWN_MS         = 1500;     // grace window before actually skipping
const SAVE_DILATION_RATIO  = 0.03;     // 3% pupil rise during countdown = save
const COUNTDOWN_BASELINE_S = 1.0;      // pupil window used for save baseline

let lastUrl       = location.href;
let shortStart    = 0;
let lastSkippedByUs = false;   // true if our algorithm fired the skip
let lastShortMeta   = null;    // {creator, words}
let lastShortStarted= 0;       // performance time when current short loaded
let prediction      = null;    // {prob, sampleCount} for current short

// Genre learning model: creator + word frequencies
let genreModel = JSON.parse(localStorage.getItem("__shorts_genre__") || "{}");
let pupilSamples  = [];
let blinkTimes    = [];
let saccadeTimes  = [];
let blinks        = 0;
let saccades      = 0;
let lastEvent     = "";
let lastCheckMs   = 0;
let lastSkipTs    = 0;
let latestSignals = null;             // last computed boredom breakdown
let countdown     = null;             // active skip countdown {startTs, baseline}

// ── Reset state on every new Short ───────────────────────────────────────────
function resetForNewShort() {
  shortStart    = performance.now() / 1000;
  pupilSamples  = [];
  blinkTimes    = [];
  saccadeTimes  = [];
  blinks        = 0;
  saccades      = 0;
  lastEvent     = "";
  lastCheckMs   = 0;
  countdown     = null;
  console.log("[Shorts] reset for new short", location.href);
}

function isOnShort() {
  return location.pathname.startsWith("/shorts/");
}

// ── Genre-learning helpers ──────────────────────────────────────────────────
function getCurrentShortMeta() {
  // Title: try active reel first, then og:title
  let title = "";
  let creator = "";
  const active = document.querySelector("ytd-reel-video-renderer[is-active]")
              || document.querySelector("ytd-reel-video-renderer");
  if (active) {
    const t = active.querySelector("yt-formatted-string.title, h2");
    if (t) title = t.textContent || "";
    const c = active.querySelector('a[href^="/@"]');
    if (c) creator = (c.getAttribute("href")||"").match(/@([^/?#]+)/)?.[1] || "";
  }
  if (!title) {
    const og = document.querySelector('meta[property="og:title"]');
    if (og) title = og.getAttribute("content") || "";
  }
  if (!creator) {
    const a = document.querySelector('a[href^="/@"]');
    if (a) creator = (a.getAttribute("href")||"").match(/@([^/?#]+)/)?.[1] || "";
  }
  // Tokenise title into useful words
  const stop = new Set(["this","that","with","from","what","when","your","yours",
                        "they","them","into","just","like","over","very","than",
                        "shorts","short","video","watch"]);
  const wordSet = new Set();
  for (const w of (title.toLowerCase().match(/[a-zÀ-ſ]{4,}/g) || [])) {
    if (!stop.has(w)) wordSet.add(w);
  }
  return { creator, title, words: [...wordSet] };
}

function recordOutcome(meta, didSkip) {
  if (!meta || (!meta.creator && meta.words.length === 0)) return;
  genreModel.creator ||= {};
  genreModel.words   ||= {};
  const bump = (bucket, key) => {
    bucket[key] ||= { watched: 0, skipped: 0 };
    bucket[key][didSkip ? "skipped" : "watched"]++;
  };
  if (meta.creator) bump(genreModel.creator, meta.creator);
  for (const w of meta.words) bump(genreModel.words, w);
  localStorage.setItem("__shorts_genre__", JSON.stringify(genreModel));
  console.log(`[Shorts] recorded ${didSkip?"SKIP":"WATCH"} `
            + `creator=@${meta.creator} words=[${meta.words.slice(0,5).join(",")}]`);
}

function predictInterest(meta) {
  if (!meta) return null;
  let weightedWatched = 0, totalWeight = 0, totalPriors = 0;
  const creatorBucket = meta.creator && genreModel.creator?.[meta.creator];
  if (creatorBucket) {
    const total = creatorBucket.watched + creatorBucket.skipped;
    if (total >= 1) {
      const rate = creatorBucket.watched / total;
      const weight = total * 3;          // creator counts 3× per word
      weightedWatched += rate * weight;
      totalWeight     += weight;
      totalPriors     += total;
    }
  }
  for (const w of meta.words) {
    const b = genreModel.words?.[w];
    if (!b) continue;
    const total = b.watched + b.skipped;
    if (total >= 1) {
      const rate = b.watched / total;
      weightedWatched += rate * total;
      totalWeight     += total;
      totalPriors     += total;
    }
  }
  if (totalPriors < 5 || totalWeight === 0) return null;
  return { prob: weightedWatched / totalWeight, priors: totalPriors };
}

// ── Mood classifier ─────────────────────────────────────────────────────────
function classifyMood(blinkRate, saccRate, cv) {
  if (blinkRate > 0.5)                       return { name: "TIRED",      color: "#ffa726", icon: "🥱" };
  if (saccRate  > 2.0)                       return { name: "DISTRACTED", color: "#ef5350", icon: "😵" };
  if (blinkRate < 0.2 && saccRate < 0.8 && cv > 0.005)
                                             return { name: "FOCUSED",    color: "#26c6da", icon: "🎯" };
                                             return { name: "NEUTRAL",    color: "#9e9e9e", icon: "⚖" };
}

setInterval(() => {
  if (location.href !== lastUrl) {
    // Finalise the previous Short before reset
    if (lastShortMeta && lastShortStarted) {
      const elapsed = performance.now() / 1000 - lastShortStarted;
      let didSkip = null;
      if (lastSkippedByUs)        didSkip = true;
      else if (elapsed < 3.0)     didSkip = true;
      else if (elapsed > 5.0)     didSkip = false;
      if (didSkip !== null) recordOutcome(lastShortMeta, didSkip);
    }
    lastUrl = location.href;
    lastSkippedByUs = false;
    if (isOnShort()) {
      resetForNewShort();
      // Capture meta for this new Short (slight delay so DOM has settled)
      setTimeout(() => {
        lastShortMeta    = getCurrentShortMeta();
        lastShortStarted = performance.now() / 1000;
        prediction       = predictInterest(lastShortMeta);
        console.log(`[Shorts] new short meta:`, lastShortMeta,
                    `prediction:`, prediction);
      }, 500);
    }
  }
}, 250);

// ── WebSocket ────────────────────────────────────────────────────────────────
function connectWS() {
  const ws = new WebSocket(WS_URL);
  ws.onopen    = () => console.log("[Shorts] WS connected");
  ws.onerror   = () => console.warn("[Shorts] WS error — bridge.py running?");
  ws.onclose   = () => setTimeout(connectWS, 3000);
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.gesture) {
      onHandGesture(d.gesture);
    } else if (d.face) {
      onFaceMetrics(d.face);
    } else {
      onGazeFrame(d);
    }
  };
}

// ── Face-expression handler (from webcam) ───────────────────────────────────
let latestFace = null;     // {smile, mouth_open, brow}  (deltas vs baseline)
let _lastFaceTs = 0;
function onFaceMetrics(face) {
  latestFace = face;
  _lastFaceTs = Date.now();
}

// Combine face deltas into a small engagement boost (-30..+30) on the boredom
// score. Smile or surprise → reduces boredom; flat face → no effect.
function faceEngagementDelta() {
  if (!latestFace || Date.now() - _lastFaceTs > 2000) return 0;
  const f = latestFace;
  // smile/mouth/brow are normalised relative changes. Cap them.
  const smile = Math.max(-0.3, Math.min(0.5, f.smile || 0));
  const open  = Math.max(-0.3, Math.min(0.8, f.mouth_open || 0));
  const brow  = Math.max(-0.3, Math.min(0.4, f.brow || 0));
  // Positive smile/open/brow lower boredom. Multiply for sensitivity.
  return -(smile * 40 + open * 25 + brow * 30);
}

// ── Hand-gesture handler (manual swipe via wrist motion) ────────────────────
let _lastGestureTs = 0;
function onHandGesture(direction) {
  const now = Date.now();
  if (now - _lastGestureTs < 700) return;   // debounce
  _lastGestureTs = now;
  console.log(`[Shorts] hand gesture → ${direction}`);
  showVerdict(direction === "next" ? "👋 NEXT" : "👋 BACK", "#7c4dff");
  // Cancel any pending auto-skip countdown
  countdown = null;
  if (document.activeElement && document.activeElement.blur) {
    document.activeElement.blur();
  }
  document.body.focus();
  const video = document.querySelector("video");
  if (video) try { video.focus(); } catch(e) {}
  const key = direction === "next" ? "ArrowDown" : "ArrowUp";
  const code = direction === "next" ? "ArrowDown" : "ArrowUp";
  const keyCode = direction === "next" ? 40 : 38;
  ["keydown", "keyup"].forEach(type => {
    const e = new KeyboardEvent(type, {
      key, code, keyCode, which: keyCode,
      bubbles: true, cancelable: true,
    });
    document.dispatchEvent(e);
    if (video) video.dispatchEvent(e);
  });
  lastSkipTs = now;   // share cooldown with auto-skip
}

let _frameCount = 0;
let _lastBlinkFlash = 0, _lastSaccFlash = 0;
function onGazeFrame(d) {
  _frameCount++;
  const now = performance.now() / 1000;
  const pupil = (d.pupilL + d.pupilR) / 2;

  if (!isOnShort()) return;
  if (shortStart === 0) resetForNewShort();

  const elapsed = now - shortStart;

  // Blink + saccade tracking
  const ev = d.event || "";
  if (ev === "BB" && lastEvent !== "BB") {
    blinkTimes.push(now);
    _lastBlinkFlash = performance.now();
  }
  if ((ev === "S" || ev.startsWith("FE")) && lastEvent !== ev) {
    saccadeTimes.push(now);
    _lastSaccFlash = performance.now();
  }
  lastEvent = ev;

  // Pupil sample
  if (elapsed >= SETTLE_SEC && pupil > 0) {
    pupilSamples.push({t: now, p: pupil});
  }

  // Trim rolling window
  const cutoff = now - ROLLING_SEC;
  while (pupilSamples.length && pupilSamples[0].t < cutoff) pupilSamples.shift();
  while (blinkTimes.length   && blinkTimes[0]   < cutoff) blinkTimes.shift();
  while (saccadeTimes.length && saccadeTimes[0] < cutoff) saccadeTimes.shift();

  // Update dashboard every frame
  updateDashboard();

  // ── Countdown phase: monitoring for save gesture ──────────────────────────
  if (countdown) {
    const dt = Date.now() - countdown.startTs;
    // Check current pupil vs frozen baseline
    const recent = pupilSamples.slice(-Math.max(3, pupilSamples.length >> 2));
    if (recent.length >= 3 && countdown.baseline) {
      const recAvg = recent.reduce((a,b)=>a+b.p,0) / recent.length;
      const ratio  = (recAvg - countdown.baseline) / countdown.baseline;
      if (ratio >= SAVE_DILATION_RATIO) {
        // SAVED!
        showVerdict(`SAVED!`, "#00d060");
        console.log(`[Shorts] SAVED — pupil rose ${(ratio*100).toFixed(1)}% during countdown`);
        countdown = null;
        lastSkipTs = Date.now();   // hold off until next check window
        return;
      }
    }
    if (dt >= COUNTDOWN_MS) {
      // Countdown finished — actually skip
      console.log("[Shorts] countdown finished → executing skip");
      showVerdict(`SKIP`, "#ff4040");
      skipToNext();
      countdown = null;
      lastSkipTs = Date.now();
    }
    return;   // skip normal evaluation while countdown active
  }

  // HUD: settle indicator
  if (elapsed < SETTLE_SEC) return;

  // Time-based check
  const nowMs = Date.now();
  if (nowMs - lastCheckMs < CHECK_EVERY_MS) return;
  if (nowMs - lastSkipTs < SKIP_COOLDOWN_MS) return;
  lastCheckMs = nowMs;

  const sig = computeBoredom();
  latestSignals = sig;

  // Apply face-expression engagement delta to the score
  const faceDelta = faceEngagementDelta();
  const adjScore = Math.max(0, Math.min(100, sig.score + faceDelta));
  sig.faceDelta = faceDelta;
  sig.adjScore  = adjScore;

  if (adjScore > BOREDOM_THRESH) {
    // Start the countdown instead of immediate skip
    const recent = pupilSamples.slice(-Math.ceil(COUNTDOWN_BASELINE_S * 30));
    const baseline = recent.length
      ? recent.reduce((a,b)=>a+b.p,0) / recent.length
      : null;
    countdown = { startTs: Date.now(), baseline };
    console.log(`[Shorts] boredom ${sig.score} + face ${faceDelta.toFixed(0)} `
              + `= ${adjScore} > ${BOREDOM_THRESH} → countdown`);
  }
}

function computeBoredom() {
  if (pupilSamples.length < 4) {
    return {score: 30, pupilDrop:0, flatScore:0, blinkScore:0, saccScore:0,
            slope:0, cv:0, blinkRate:0, saccRate:0};
  }
  const vals = pupilSamples.map(s => s.p);
  const ts   = pupilSamples.map(s => s.t);
  const n    = vals.length;
  const mean = vals.reduce((a,b)=>a+b,0) / n;
  const winSec = Math.max(0.5, ROLLING_SEC);
  const blinks   = blinkTimes.length;
  const saccades = saccadeTimes.length;

  let sumXY=0, sumX=0, sumY=0, sumXX=0;
  for (let i=0; i<n; i++) {
    sumX += ts[i]; sumY += vals[i];
    sumXY += ts[i]*vals[i]; sumXX += ts[i]*ts[i];
  }
  const slope     = (n*sumXY - sumX*sumY) / (n*sumXX - sumX*sumX || 1);
  const slopeNorm = slope / (mean || 1);
  let pupilDrop = 0;
  if (slopeNorm < 0) pupilDrop = Math.min(100, -slopeNorm * 2500);

  let varSum = 0;
  for (const v of vals) varSum += (v - mean) ** 2;
  const cv = Math.sqrt(varSum / n) / (mean || 1);
  let flatScore = 0;
  if      (cv < 0.003) flatScore = 80;
  else if (cv < 0.006) flatScore = 50;
  else if (cv < 0.010) flatScore = 20;

  const blinkRate = blinks / winSec;
  let blinkScore = 0;
  if      (blinkRate > 0.8) blinkScore = 100;
  else if (blinkRate > 0.5) blinkScore = 75;
  else if (blinkRate > 0.3) blinkScore = 35;

  const saccRate = saccades / winSec;
  let saccScore = 0;
  if      (saccRate > 3.5) saccScore = 95;
  else if (saccRate > 2.5) saccScore = 70;
  else if (saccRate > 1.5) saccScore = 30;

  const signals = [pupilDrop, flatScore, blinkScore, saccScore];
  const top = Math.max(...signals);
  const avg = signals.reduce((a,b)=>a+b,0) / signals.length;
  const score = Math.round(top * 0.7 + avg * 0.3);

  return {score, pupilDrop, flatScore, blinkScore, saccScore,
          slope: slopeNorm, cv, blinkRate, saccRate};
}

function skipToNext() {
  lastSkippedByUs = true;
  if (document.activeElement && document.activeElement.blur) {
    document.activeElement.blur();
  }
  document.body.focus();
  const video = document.querySelector("video");
  if (video) try { video.focus(); } catch(e) {}
  ["keydown", "keyup"].forEach(type => {
    const e = new KeyboardEvent(type, {
      key: "ArrowDown", code: "ArrowDown", keyCode: 40, which: 40,
      bubbles: true, cancelable: true,
    });
    document.dispatchEvent(e);
    if (video) video.dispatchEvent(e);
  });
}

// ── Verdict popup ───────────────────────────────────────────────────────────
function showVerdict(text, color) {
  let v = document.getElementById("__shorts_verdict__");
  if (!v) {
    v = document.createElement("div");
    v.id = "__shorts_verdict__";
    Object.assign(v.style, {
      position: "fixed", top: "30%", left: "50%",
      transform: "translate(-50%, -50%)",
      padding: "20px 40px", borderRadius: "16px",
      font: "bold 56px system-ui, sans-serif",
      color: "#fff",
      zIndex: 2147483647, pointerEvents: "none",
      boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
    });
    document.body.appendChild(v);
  }
  v.textContent = text;
  v.style.background = color;
  v.style.opacity = "1";
  v.style.transition = "opacity 0.4s";
  setTimeout(() => { v.style.opacity = "0"; }, VERDICT_HOLD_MS - 400);
  speechSynthesis.cancel();
  speechSynthesis.speak(new SpeechSynthesisUtterance(text.split(" ")[0]));
}

// ── Live dashboard (sidebar) ────────────────────────────────────────────────
function ensureDashboard() {
  let d = document.getElementById("__shorts_dash__");
  if (d) return d;
  d = document.createElement("div");
  d.id = "__shorts_dash__";
  Object.assign(d.style, {
    position: "fixed", top: "70px", right: "20px",
    width: "260px", padding: "14px",
    background: "rgba(15,15,20,0.92)", color: "#fff",
    borderRadius: "14px", border: "1px solid rgba(255,255,255,0.1)",
    font: "13px ui-monospace, Menlo, monospace",
    zIndex: 2147483647, pointerEvents: "none",
    boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
    backdropFilter: "blur(8px)",
  });
  d.innerHTML = `
    <div style="font:bold 14px system-ui;margin-bottom:10px;letter-spacing:.5px;">
      🎯 GAZE SIGNALS
    </div>
    <div id="__d_mood__" style="text-align:center;font:bold 13px system-ui;
         margin-bottom:8px;padding:5px 10px;border-radius:8px;
         background:rgba(255,255,255,0.06);letter-spacing:1px;">
      ⚖ NEUTRAL
    </div>
    <div id="__d_pred__" style="font:11px system-ui;margin-bottom:10px;
         padding:6px 8px;border-radius:6px;background:rgba(255,255,255,0.04);
         text-align:center;line-height:1.4;">
      🔮 — <span style="opacity:.5;">need 5+ priors</span>
    </div>
    <div style="position:relative;height:90px;width:90px;margin:0 auto 8px;">
      <svg width="90" height="90" viewBox="0 0 90 90" style="transform:rotate(-90deg);">
        <circle cx="45" cy="45" r="38" stroke="rgba(255,255,255,0.1)"
                stroke-width="8" fill="none"/>
        <circle id="__d_arc__" cx="45" cy="45" r="38" stroke="#00d060"
                stroke-width="8" fill="none" stroke-linecap="round"
                stroke-dasharray="0 999" />
      </svg>
      <div id="__d_score__" style="position:absolute;inset:0;display:flex;
           align-items:center;justify-content:center;font:bold 26px system-ui;">
        --
      </div>
    </div>
    <div id="__d_state__" style="text-align:center;font:bold 12px system-ui;
         margin-bottom:10px;letter-spacing:1px;">HOOKED</div>

    <div style="margin:8px 0;">
      <div style="display:flex;justify-content:space-between;font-size:10px;
                  opacity:0.7;margin-bottom:2px;">
        <span>PUPIL ${ROLLING_SEC}s</span><span id="__d_pupil_val__">--</span>
      </div>
      <svg id="__d_pupil__" width="100%" height="36" viewBox="0 0 232 36"
           preserveAspectRatio="none" style="background:rgba(255,255,255,0.04);
           border-radius:4px;display:block;">
        <polyline id="__d_pupil_line__" points="" fill="none"
                  stroke="#3ea6ff" stroke-width="1.5"/>
      </svg>
    </div>

    <div id="__d_signals__"></div>

    <div id="__d_face__" style="margin-top:8px;font:11px ui-monospace;
         padding:6px 8px;border-radius:6px;background:rgba(255,255,255,0.04);
         line-height:1.5;">
      <div style="display:flex;justify-content:space-between;
                  font-size:10px;opacity:.7;margin-bottom:2px;">
        <span>FACE</span><span id="__d_face_delta__">--</span>
      </div>
      <span id="__d_face_vals__" style="opacity:.85;">no face</span>
    </div>

    <div id="__d_event__" style="display:flex;gap:8px;margin-top:10px;
         justify-content:center;">
      <span id="__d_blink__" style="padding:3px 8px;border-radius:6px;
            background:rgba(255,255,255,0.08);font-size:11px;">👁 0</span>
      <span id="__d_sacc__"  style="padding:3px 8px;border-radius:6px;
            background:rgba(255,255,255,0.08);font-size:11px;">↯ 0</span>
    </div>

    <div style="margin-top:10px;font-size:10px;opacity:0.5;text-align:center;">
      THRESH <span id="__d_thresh__">${BOREDOM_THRESH}</span> &nbsp; , = stricter . = looser
    </div>
  `;
  document.body.appendChild(d);
  return d;
}

function renderSignalRow(label, value, max=100) {
  const pct = Math.max(0, Math.min(100, value));
  const color = pct > 50 ? "#ff4040" : pct > 25 ? "#ffd400" : "#3ea6ff";
  return `
    <div style="display:flex;align-items:center;gap:6px;margin:3px 0;font-size:11px;">
      <span style="width:60px;opacity:0.8;">${label}</span>
      <div style="flex:1;height:6px;background:rgba(255,255,255,0.08);
                  border-radius:3px;overflow:hidden;">
        <div style="width:${pct}%;height:100%;background:${color};
                    transition:width 0.2s;"></div>
      </div>
      <span style="width:24px;text-align:right;opacity:0.6;">${value|0}</span>
    </div>`;
}

function updateDashboard() {
  const d = ensureDashboard();

  // Pupil graph: map pupilSamples to SVG polyline
  if (pupilSamples.length >= 2) {
    const vals = pupilSamples.map(s => s.p);
    const min = Math.min(...vals), max = Math.max(...vals);
    const range = Math.max(0.1, max - min);
    const now = pupilSamples[pupilSamples.length-1].t;
    const tStart = now - ROLLING_SEC;
    const points = pupilSamples.map(s => {
      const x = ((s.t - tStart) / ROLLING_SEC) * 232;
      const y = 32 - ((s.p - min) / range) * 28;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(" ");
    document.getElementById("__d_pupil_line__")?.setAttribute("points", points);
    document.getElementById("__d_pupil_val__")
      ?.replaceChildren(document.createTextNode(vals[vals.length-1].toFixed(2)));
  }

  // Signal bars + score gauge
  const sig = latestSignals || {score:0, pupilDrop:0, flatScore:0,
                                  blinkScore:0, saccScore:0};
  const score = sig.score;
  const arcLen = 238.76;   // 2π*38
  const dash = (score/100) * arcLen;
  const arc = document.getElementById("__d_arc__");
  if (arc) {
    arc.setAttribute("stroke-dasharray", `${dash} 999`);
    arc.setAttribute("stroke",
      score > BOREDOM_THRESH ? "#ff4040"
      : score > BOREDOM_THRESH * 0.7 ? "#ffd400"
      : "#00d060");
  }
  const sc = document.getElementById("__d_score__");
  if (sc) sc.textContent = score;

  // Mood chip
  const mood = classifyMood(sig.blinkRate || 0, sig.saccRate || 0, sig.cv || 0);
  const moodEl = document.getElementById("__d_mood__");
  if (moodEl) {
    moodEl.textContent = `${mood.icon} ${mood.name}`;
    moodEl.style.background = mood.color + "33";
    moodEl.style.color      = mood.color;
    moodEl.style.border     = `1px solid ${mood.color}55`;
  }

  // Genre prediction
  const predEl = document.getElementById("__d_pred__");
  if (predEl) {
    if (prediction) {
      const pctSkip = Math.round((1 - prediction.prob) * 100);
      const willSkip = pctSkip > 60;
      const willWatch = pctSkip < 40;
      const color = willSkip ? "#ff4040" : willWatch ? "#00d060" : "#ffd400";
      const verdict = willSkip ? "will SKIP" : willWatch ? "will WATCH" : "uncertain";
      predEl.innerHTML =
        `🔮 PRED  <span style="color:${color};font-weight:bold;">`
      + `${pctSkip}% ${verdict}</span>  <span style="opacity:.5;">`
      + `(${prediction.priors} priors)</span>`;
    } else {
      predEl.innerHTML =
        `🔮 — <span style="opacity:.5;">need 5+ priors</span>`;
    }
  }

  const state = countdown
    ? `⚠ SKIPPING in ${((COUNTDOWN_MS-(Date.now()-countdown.startTs))/1000).toFixed(1)}s`
    : score > BOREDOM_THRESH ? "BORED"
    : "HOOKED";
  const stateEl = document.getElementById("__d_state__");
  if (stateEl) {
    stateEl.textContent = state;
    stateEl.style.color = countdown ? "#ffd400"
                          : score > BOREDOM_THRESH ? "#ff4040" : "#00d060";
  }

  const sigsEl = document.getElementById("__d_signals__");
  if (sigsEl) {
    sigsEl.innerHTML =
        renderSignalRow("PUP DROP",  sig.pupilDrop)
      + renderSignalRow("PUP FLAT",  sig.flatScore)
      + renderSignalRow("BLINKS",    sig.blinkScore)
      + renderSignalRow("SACCADES",  sig.saccScore);
  }

  // Flash blink/saccade pills on event
  const nowMs = performance.now();
  const blinkEl = document.getElementById("__d_blink__");
  const saccEl  = document.getElementById("__d_sacc__");
  if (blinkEl) {
    const flash = nowMs - _lastBlinkFlash < 200;
    blinkEl.style.background = flash ? "#3ea6ff" : "rgba(255,255,255,0.08)";
    blinkEl.textContent = `👁 ${blinkTimes.length}`;
  }
  if (saccEl) {
    const flash = nowMs - _lastSaccFlash < 200;
    saccEl.style.background = flash ? "#ffd400" : "rgba(255,255,255,0.08)";
    saccEl.textContent = `↯ ${saccadeTimes.length}`;
  }

  // Face row
  const faceVals = document.getElementById("__d_face_vals__");
  const faceDelta = document.getElementById("__d_face_delta__");
  if (faceVals && faceDelta) {
    if (latestFace && Date.now() - _lastFaceTs < 2000) {
      const f = latestFace;
      const fmt = (k, v) => {
        const c = v > 0.05 ? "#00d060" : v > -0.05 ? "#ffd400" : "#ff4040";
        return `<span style="color:${c};">${k} ${v>=0?"+":""}${v.toFixed(2)}</span>`;
      };
      faceVals.innerHTML =
          fmt("smile", f.smile||0) + " "
        + fmt("mouth", f.mouth_open||0) + " "
        + fmt("brow",  f.brow||0);
      const delta = sig.faceDelta != null ? sig.faceDelta : 0;
      const dColor = delta < -2 ? "#00d060" : delta > 2 ? "#ff4040" : "#9e9e9e";
      faceDelta.style.color = dColor;
      faceDelta.textContent = (delta>=0?"+":"") + delta.toFixed(0);
    } else {
      faceVals.textContent = "no face";
      faceDelta.textContent = "--";
    }
  }

  // Threshold indicator
  document.getElementById("__d_thresh__").textContent = BOREDOM_THRESH;
}

// ── Adaptive threshold via keyboard ─────────────────────────────────────────
function adjustThresh(delta, label) {
  BOREDOM_THRESH = Math.max(THRESH_MIN, Math.min(THRESH_MAX,
                                                  BOREDOM_THRESH + delta));
  localStorage.setItem("__shorts_boredom_thresh__", String(BOREDOM_THRESH));
  console.log(`[Shorts] threshold → ${BOREDOM_THRESH} (${label})`);
  showToast(`${label}  threshold: ${BOREDOM_THRESH}`,
            delta > 0 ? "#1976d2" : "#e53935");
}

function showToast(text, color) {
  let t = document.getElementById("__shorts_toast__");
  if (!t) {
    t = document.createElement("div");
    t.id = "__shorts_toast__";
    Object.assign(t.style, {
      position: "fixed", bottom: "60px", left: "50%",
      transform: "translateX(-50%)",
      padding: "20px 36px", borderRadius: "16px",
      color: "#fff", font: "bold 28px system-ui, sans-serif",
      zIndex: 2147483647, pointerEvents: "none",
      transition: "opacity 0.4s, transform 0.2s",
      boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
      textShadow: "0 2px 4px rgba(0,0,0,0.5)",
    });
    document.body.appendChild(t);
  }
  t.textContent = text;
  t.style.background = color || "rgba(0,0,0,0.9)";
  t.style.opacity = "1";
  t.style.transform = "translateX(-50%) scale(1.1)";
  clearTimeout(t._timer);
  setTimeout(() => { t.style.transform = "translateX(-50%) scale(1)"; }, 100);
  t._timer = setTimeout(() => { t.style.opacity = "0"; }, 2000);
}

function onFeedbackKey(e) {
  if (e.key === "," || e.code === "Comma") {
    adjustThresh(+THRESH_STEP, "− SKIP LESS");
    e.preventDefault(); e.stopPropagation();
  }
  else if (e.key === "." || e.code === "Period") {
    adjustThresh(-THRESH_STEP, "+ SKIP MORE");
    e.preventDefault(); e.stopPropagation();
  }
}
document.addEventListener("keydown", onFeedbackKey, true);
window.addEventListener("keydown", onFeedbackKey, true);

// ── Boot ────────────────────────────────────────────────────────────────────
console.log(`[Shorts] extension loaded — threshold ${BOREDOM_THRESH}`);
ensureDashboard();
connectWS();
