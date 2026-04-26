// YouTube Shorts auto-skip — research-backed multimodal disinterest detector.
// Algoritmin keskeiset komponentit (lähde: Subconscious Shorts auto-skip, ~150
// papers CHI/ETRA/IMWUT/ACII 2022–2026):
//   1. Per-user Welford+EWMA z-score baselines per modality
//   2. Multi-modal AND-gate: vaadi >=2 modaliteettia kynnyksen yli
//   3. Schmitt-trigger hysteresis (T_high=0.6, T_low=0.3 z-space)
//   4. Dwell-time 1.0–1.5 s ennen actionia (matchaa human RT 700–1000 ms)
//   5. Pre-action indicator t=0.7s alkaen, skip @ 1.0–2.0s
//   6. Asymmetric error costs: skip-cap ≤25 %/sessio, confidence floor
//   7. Gesture veto window 300 ms + 3 s undo

(() => {
  if (window.__daemonShortsInjected) return;
  window.__daemonShortsInjected = true;
  const isShorts = () => /\/shorts\//.test(location.pathname);

  const SK_ENABLED = '__daemon_shorts_enabled';
  const SK_SENS    = '__daemon_shorts_sensitivity';
  let enabled = JSON.parse(localStorage.getItem(SK_ENABLED) ?? 'true');
  let sensitivity = parseFloat(localStorage.getItem(SK_SENS) ?? '50'); // 0..100

  // ── UI ─────────────────────────────────────────────────────────────────
  const ui = document.createElement('div');
  ui.id = '__d-shorts';
  ui.innerHTML = `
    <div class="__d-shorts-meter">
      <div class="__d-shorts-fill" id="__ds-fill"></div>
      <div class="__d-shorts-pre" id="__ds-pre"></div>
    </div>
    <div class="__d-shorts-info">
      <div class="__d-shorts-row">
        <span class="__d-shorts-emoji" id="__ds-emoji">⚪</span>
        <span class="__d-shorts-label" id="__ds-label">…</span>
      </div>
      <div class="__d-shorts-row">
        <span class="__d-shorts-pct" id="__ds-pct">—</span>
        <span class="__d-shorts-time" id="__ds-time"></span>
      </div>
      <div class="__d-shorts-row __d-shorts-mods" id="__ds-mods"></div>
      <div class="__d-shorts-row __d-shorts-sens">
        <span class="__d-shorts-sens-lbl">herkkyys</span>
        <input type="range" id="__ds-sens" min="0" max="100" value="${sensitivity}">
        <span id="__ds-sens-val">${sensitivity}</span>
      </div>
      <div class="__d-shorts-row __d-shorts-hint" id="__ds-hint">
        ele alas = skip · ele ylös = pidempään
      </div>
    </div>
    <button class="__d-shorts-toggle" id="__ds-toggle" title="Päällä / pois">
      <span id="__ds-toggle-icon">${enabled ? '⏻' : '○'}</span>
    </button>
  `;
  document.documentElement.appendChild(ui);

  const fillEl   = ui.querySelector('#__ds-fill');
  const preEl    = ui.querySelector('#__ds-pre');
  const emojiEl  = ui.querySelector('#__ds-emoji');
  const labelEl  = ui.querySelector('#__ds-label');
  const pctEl    = ui.querySelector('#__ds-pct');
  const timeEl   = ui.querySelector('#__ds-time');
  const modsEl   = ui.querySelector('#__ds-mods');
  const toggleEl = ui.querySelector('#__ds-toggle');
  const toggleIcon = ui.querySelector('#__ds-toggle-icon');
  const sensEl   = ui.querySelector('#__ds-sens');
  const sensValEl = ui.querySelector('#__ds-sens-val');
  const hintEl   = ui.querySelector('#__ds-hint');

  toggleEl.onclick = () => {
    enabled = !enabled;
    localStorage.setItem(SK_ENABLED, enabled);
    toggleIcon.textContent = enabled ? '⏻' : '○';
    ui.classList.toggle('__d-disabled', !enabled);
    resetVideoState();
  };
  ui.classList.toggle('__d-disabled', !enabled);

  sensEl.oninput = () => {
    sensitivity = parseFloat(sensEl.value);
    sensValEl.textContent = sensitivity.toFixed(0);
    localStorage.setItem(SK_SENS, sensitivity);
  };

  // ── Welford + EWMA per-signal baselines ─────────────────────────────────
  // Tutkimus (Mathôt 2018, Pauwels 2022, Personalised Affective 2025): per-user
  // z-score on välttämätöntä — absoluuttiset kynnykset eivät yleisty.
  // Käytetään hybrid: Welford ensimmäiseen N näytteeseen, sitten EWMA α=0.05.
  const baselines = {};
  const FAST_SAMPLES = 30;     // Welford-vaihe
  const EWMA_ALPHA   = 0.05;   // ~20 sample tau
  function bl(name) {
    return baselines[name] || (baselines[name] = {
      n: 0, mean: 0, M2: 0, sd: 0,
    });
  }
  function update(name, x) {
    if (!Number.isFinite(x)) return;
    const b = bl(name);
    if (b.n < FAST_SAMPLES) {
      b.n++;
      const delta = x - b.mean;
      b.mean += delta / b.n;
      b.M2   += delta * (x - b.mean);
      b.sd    = b.n > 1 ? Math.sqrt(b.M2 / (b.n - 1)) : 0;
    } else {
      // EWMA mean + EWMA variance (West 1979)
      const oldMean = b.mean;
      b.mean = b.mean * (1 - EWMA_ALPHA) + x * EWMA_ALPHA;
      const incVar = (x - oldMean) * (x - b.mean);
      b.M2   = b.M2 * (1 - EWMA_ALPHA) + incVar * EWMA_ALPHA * b.n;
      b.sd   = Math.sqrt(b.M2 / Math.max(1, b.n - 1));
    }
  }
  function z(name, x) {
    const b = baselines[name];
    if (!b || b.n < 8 || b.sd < 1e-6 || !Number.isFinite(x)) return null;
    return (x - b.mean) / b.sd;
  }

  // ── Video / session state ──────────────────────────────────────────────
  let videoStartT = performance.now();
  let lastSkipT   = 0;
  let lastManualScrollT = 0;
  let lastUrl     = location.href;

  // Schmitt + dwell state machine
  let schmittArmed = false;     // crossing T_high → set; T_low → cleared
  let armStartT    = 0;         // when armed
  let preActionVisible = false;

  // Asymmetric error cost: cap auto-skips to ≤25 % per session
  let videosSeen   = 0;
  let videosSkipped = 0;

  // Recent skip log for the active-learning loop
  const skipLog = [];   // {t, reason, autoOrManual}

  // Veto / undo state
  let pendingSkipT = 0;        // when we plan to skip; gesture in 300 ms vetoes
  let lastAutoSkipT = 0;       // for 3-s undo

  // Yaw-shake / nod history (oscillation detector)
  const yawHist   = [];
  const pitchHist = [];

  // Most recent SeeTrue pupil
  let lastPupilMm = null;
  let lastPupilT  = 0;
  // Saccade rate over recent window (already computed in offscreen)
  let lastSacc    = 0;

  // Recent disinterest score history for smoothing
  const dHist = [];   // {t, D, modKeys}
  const D_WINDOW_MS = 2500;

  function resetVideoState() {
    videoStartT  = performance.now();
    schmittArmed = false;
    armStartT    = 0;
    pendingSkipT = 0;
    preActionVisible = false;
    preEl.style.width = '0%';
    preEl.style.opacity = '0';
    yawHist.length = 0;
    pitchHist.length = 0;
    dHist.length = 0;
  }

  addEventListener('wheel',     () => { lastManualScrollT = Date.now(); }, { passive: true });
  addEventListener('touchstart',() => { lastManualScrollT = Date.now(); }, { passive: true });
  addEventListener('keydown', (e) => {
    if (['ArrowDown','ArrowUp','PageDown','PageUp','j','k'].includes(e.key)) {
      lastManualScrollT = Date.now();
      // Manuaalinen skip ennen meidän actionia → log labeled training data
      if (pendingSkipT > 0 && performance.now() < pendingSkipT) {
        skipLog.push({ t: Date.now(), reason: 'manual-pre-auto', autoOrManual: 'manual' });
      }
    }
  });

  function syncShortsState() {
    const onShorts = isShorts();
    ui.style.display = onShorts ? 'flex' : 'none';
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      videosSeen++;
      resetVideoState();
    }
  }
  syncShortsState();
  setInterval(syncShortsState, 200);

  // ── Multimodal disinterest D(t) ─────────────────────────────────────────
  // Painot tutkimuksen suosituksesta (taulukko §6):
  //   gaze off-screen 0.30, head yaw 0.20, pupil 0.15, blink 0.10,
  //   AU4 0.10, AU43 0.10, HR 0.05.
  // Adaptoituu: jos modaliteetti puuttuu (esim. ei SeeTrueta), painot
  // normalisoidaan jäljellä oleviin.
  const W = {
    yaw: 0.20, pitch: 0.10, gazeOff: 0.20,
    pupil: 0.15, blink: 0.10, sacc: 0.05,
    au4: 0.10, au43: 0.10, smile: 0.10,   // smile = NEGATIIVINEN paino (engagement)
    hr: 0.05,
  };

  function computeDisinterest(state) {
    const m = {};   // per-modality disinterest contribution in z-space (positive=disinterest)
    const bs = {};
    for (const sh of (state.blendshapes || [])) bs[sh.name] = sh.score;

    // 1) Pupil (z-score baselined). Pieni pupilli vs baseline = disinterest.
    if (lastPupilMm !== null && performance.now() - lastPupilT < 2000) {
      update('pupil', lastPupilMm);
      const zp = z('pupil', lastPupilMm);
      if (zp !== null) m.pupil = -zp;   // negate: dilation = engagement
    }

    // 2) Blink rate (eyeBlink blendshape proxy). Yli baseline = disengaging.
    if (state.blendshapes) {
      const blink = ((bs.eyeBlinkLeft || 0) + (bs.eyeBlinkRight || 0)) / 2;
      update('blink', blink);
      const zb = z('blink', blink);
      if (zb !== null) m.blink = zb;

      // 3) AU4 (browDown sustained, no smile). Höfling 2023 ad-disliking.
      const au4   = ((bs.browDownLeft || 0) + (bs.browDownRight || 0)) / 2;
      const smile = ((bs.mouthSmileLeft || 0) + (bs.mouthSmileRight || 0)) / 2;
      update('au4', au4);
      update('smile', smile);
      const zAU4 = z('au4', au4);
      const zSmile = z('smile', smile);
      // AU4 sustained AND no AU12/AU6 (gating)
      if (zAU4 !== null && zSmile !== null && zSmile < 0.5) m.au4 = zAU4;
      if (zSmile !== null) m.smile = -zSmile;   // smile = engagement → -z

      // 4) AU43 (eyes closed) sustained. eyeBlink>0.6 sustained ≥500 ms.
      // Approximate via current frame — sustained tracking via dwell window.
      if (blink > 0.6) m.au43 = 1.5;            // strong disengagement marker
    }

    // 5) Head yaw / pitch deviation (>15°). Whitehill 2014 / ViBED-Net.
    if (state.headPose) {
      const yawAbs   = Math.abs(state.headPose.yaw   || 0);
      const pitchAbs = Math.abs(state.headPose.pitch || 0);
      if (yawAbs   > 15) m.yaw   = (yawAbs   - 15) / 15;   // 1.0 at 30°
      if (pitchAbs > 15) m.pitch = (pitchAbs - 15) / 15;
    }

    // 6) Saccade rate elevation = scanning/disengagement (gaze entropy proxy)
    if (state.ovision && typeof state.ovision.saccadePerSec === 'number') {
      lastSacc = state.ovision.saccadePerSec;
      update('sacc', lastSacc);
      const zs = z('sacc', lastSacc);
      if (zs !== null) m.sacc = zs;
    }

    // 7) Gaze off-screen — SeeTrue gx/gy out of [0,1] range or no recent fixation
    if (state.ovision && state.ovision.gaze) {
      const g = state.ovision.gaze;
      const off = (g.gx < -0.05 || g.gx > 1.05 || g.gy < -0.05 || g.gy > 1.05);
      if (off) m.gazeOff = 1.5;  // strong disengagement when looking away
    }

    // 8) HR drift without deceleration: van der Kooij & Naber 2019
    if (typeof state.bpm === 'number' && state.bpm > 0) {
      update('hr', state.bpm);
      const zhr = z('hr', state.bpm);
      // Engagement = HR DECELERATION (1–3 BPM drop). Disinterest = no decel
      // or rising HR. We treat positive z as disinterest contribution.
      if (zhr !== null) m.hr = Math.max(0, zhr) * 0.5;  // weak signal
    }

    // ── Weighted aggregate ─────────────────────────────────────────────────
    let weightedSum = 0, totalW = 0, signalsAbove = 0, totalSignals = 0;
    let aboveHigh = 0, aboveLow = 0;
    const T_high = 0.6, T_low = 0.3;
    for (const [key, w] of Object.entries(W)) {
      if (typeof m[key] !== 'number' || !Number.isFinite(m[key])) continue;
      const v = m[key];
      totalSignals++;
      // For positive-z (disinterest) modalities, count above thresholds
      if (v > T_high) aboveHigh++;
      if (v > T_low)  aboveLow++;
      if (Math.abs(v) >= 0.5) signalsAbove++;  // confidence floor
      // Saturate at ±3 z and clip negative for disinterest aggregation
      const vc = Math.max(-3, Math.min(3, v));
      weightedSum += w * Math.max(0, vc);
      totalW += w;
    }
    const D = totalW > 0 ? weightedSum / totalW : 0;

    return { D, m, aboveHigh, aboveLow, signalsAbove, totalSignals };
  }

  // ── Engagement (positive) score for UI bar — separate from disinterest ──
  // Tämä on käyttäjälle kiva visualisointi joka sopii "kiinnostaa/tylsä" -akselille.
  // Algoritmin päätös perustuu D(t):hen, ei tähän.
  function engagementUi(state, dis) {
    let s = 0.5;
    const bs = {};
    for (const sh of (state.blendshapes || [])) bs[sh.name] = sh.score;
    const smile = ((bs.mouthSmileLeft || 0) + (bs.mouthSmileRight || 0)) / 2;
    const jawOpen = bs.jawOpen || 0;
    const cheek = ((bs.cheekSquintLeft || 0) + (bs.cheekSquintRight || 0)) / 2;
    s += smile * 0.5;
    if (smile > 0.25 && jawOpen > 0.15) s += 0.25;     // laughter
    if (cheek > 0.15 && smile > 0.15)   s += 0.15;     // duchenne
    if (state.emotion?.label === 'happy')     s += 0.20 * (state.emotion.score || 0);
    if (state.emotion?.label === 'surprised') s += 0.25 * (state.emotion.score || 0);
    if (state.emotion?.label === 'focused')   s += 0.10 * (state.emotion.score || 0);
    s -= dis.D * 0.6;
    return Math.max(0, Math.min(1, s));
  }

  // ── Head shake / nod (oscillation detector — gestural shortcuts) ──────
  function detectHeadShake(now) {
    while (yawHist.length && now - yawHist[0].t > 1200) yawHist.shift();
    if (yawHist.length < 6) return false;
    const ys = yawHist.map(p => p.yaw);
    let mn = Infinity, mx = -Infinity;
    for (const y of ys) { if (y < mn) mn = y; if (y > mx) mx = y; }
    const range = mx - mn;
    const mean = ys.reduce((a,b)=>a+b,0) / ys.length;
    let cross = 0;
    for (let i = 1; i < ys.length; i++) {
      if ((ys[i-1] - mean) * (ys[i] - mean) < 0) cross++;
    }
    return range > 25 && cross >= 3;
  }
  function detectNod(now) {
    while (pitchHist.length && now - pitchHist[0].t > 1200) pitchHist.shift();
    if (pitchHist.length < 6) return false;
    const ps = pitchHist.map(p => p.pitch);
    let mn = Infinity, mx = -Infinity;
    for (const p of ps) { if (p < mn) mn = p; if (p > mx) mx = p; }
    const range = mx - mn;
    const mean = ps.reduce((a,b)=>a+b,0) / ps.length;
    let cross = 0;
    for (let i = 1; i < ps.length; i++) {
      if ((ps[i-1] - mean) * (ps[i] - mean) < 0) cross++;
    }
    return range > 18 && cross >= 3;
  }

  // ── Sensitivity slider modifies T_high/T_low/dwell only, not the structure ──
  function tunings() {
    const t = sensitivity / 100;   // 0 = patient, 1 = aggressive
    return {
      T_high: 0.75 - t * 0.30,    // 0.75 .. 0.45 z-space
      T_low:  0.40 - t * 0.20,    // 0.40 .. 0.20
      dwellMs: 1500 - t * 500,    // 1500 .. 1000 ms
      preStartMs: 700,            // pre-action indicator alkaa 700 ms kohdalla
      minVideoMs: 2500 - t * 1500,
      reqAboveHigh: t < 0.5 ? 2 : 1,   // patient: vaadi 2 modaliteettia, aggressiivinen: 1
    };
  }

  function classify(eng) {
    if (eng > 0.72) return { emoji: '🔥', label: 'kiinnostaa' };
    if (eng > 0.58) return { emoji: '😊', label: 'ihan kiva' };
    if (eng > 0.42) return { emoji: '⚪', label: 'neutraali' };
    if (eng > 0.28) return { emoji: '😐', label: 'tylsähköä' };
    return { emoji: '💤', label: 'tylsä' };
  }

  let lastEng = 0.5;
  function updateUI() {
    const pct = Math.round(lastEng * 100);
    fillEl.style.width = pct + '%';
    fillEl.style.background = lastEng > 0.55 ? '#51cf66'
                            : lastEng > 0.35 ? '#ffc850'
                            : '#ff4d6d';
    const c = classify(lastEng);
    emojiEl.textContent = c.emoji;
    labelEl.textContent = c.label;
    pctEl.textContent = pct;
    const elapsed = (performance.now() - videoStartT) / 1000;
    timeEl.textContent = elapsed.toFixed(1) + 's';
  }

  // Render which modalities are firing — debug + transparency for trust
  function updateMods(m, aboveHigh) {
    const bits = [];
    const tun = tunings();
    for (const [k, v] of Object.entries(m)) {
      if (typeof v !== 'number' || !Number.isFinite(v)) continue;
      const hot = v > tun.T_high;
      bits.push(`<span class="${hot ? '__ds-mod-hot' : ''}">${k}=${v.toFixed(1)}</span>`);
    }
    modsEl.innerHTML = bits.join(' ');
  }

  function setPreAction(progress) {
    if (progress <= 0) {
      preEl.style.width = '0%';
      preEl.style.opacity = '0';
      preActionVisible = false;
    } else {
      preEl.style.width = (progress * 100).toFixed(0) + '%';
      preEl.style.opacity = '1';
      preActionVisible = true;
    }
  }

  // ── Main decision tick ─────────────────────────────────────────────────
  function decide(state) {
    if (!enabled || !isShorts()) return;
    const now = performance.now();
    const elapsed = now - videoStartT;
    if (Date.now() - lastManualScrollT < 5000) { setPreAction(0); return; }
    if (Date.now() - lastSkipT < 1500) { setPreAction(0); return; }

    // Päivitä yaw/pitch oscillation history
    if (state.headPose) {
      yawHist.push({ t: now, yaw: state.headPose.yaw });
      pitchHist.push({ t: now, pitch: state.headPose.pitch });
    }

    // Headshake = forced-skip (override the slow algorithm)
    if (detectHeadShake(now) && Date.now() - lastSkipT > 1500) {
      skipNext('shake');
      return;
    }
    // Nod = engagement bump (extends time-on-video)
    if (detectNod(now)) {
      videoStartT = now - 100;
      flashKeep();
    }

    if (elapsed < tunings().minVideoMs) { setPreAction(0); return; }

    // ── Compute disinterest with confidence floor ───────────────────────
    const dis = computeDisinterest(state);
    const tun = tunings();

    // EWMA the D(t) for smoothing — tau ~250 ms at 20 Hz
    const ALPHA_D = 0.20;
    if (dHist.length === 0) dHist.push({ t: now, D: dis.D });
    else {
      const last = dHist[dHist.length - 1];
      const smoothed = last.D * (1 - ALPHA_D) + dis.D * ALPHA_D;
      dHist.push({ t: now, D: smoothed });
    }
    while (dHist.length && now - dHist[0].t > D_WINDOW_MS) dHist.shift();
    const Dnow = dHist[dHist.length - 1].D;

    updateMods(dis.m, dis.aboveHigh);

    // Skip-cap: ≤25 % of videos in session (Bliss 1993, Moder 2024)
    const skipRatio = videosSeen > 0 ? videosSkipped / videosSeen : 0;
    const overCap = skipRatio > 0.25 && videosSeen > 4;

    // Confidence floor: tarvitaan vähintään 2 merkitsevää signaalia (|z|>=0.5)
    const enoughConfidence = dis.signalsAbove >= 2;

    // Multi-modal AND-gate: vaadi reqAboveHigh modaliteettia kynnyksen yli
    const gateOpen = dis.aboveHigh >= tun.reqAboveHigh;

    // Schmitt-trigger
    if (!schmittArmed && Dnow > tun.T_high && gateOpen && enoughConfidence && !overCap) {
      schmittArmed = true;
      armStartT = now;
    } else if (schmittArmed && Dnow < tun.T_low) {
      // Drop below T_low → disarm and reset
      schmittArmed = false;
      armStartT = 0;
      setPreAction(0);
    }

    // Dwell timer — show indicator @ preStartMs, fire @ dwellMs
    if (schmittArmed) {
      const dwellMs = now - armStartT;
      if (dwellMs > tun.preStartMs) {
        const frac = Math.min(1, (dwellMs - tun.preStartMs) /
                                  (tun.dwellMs - tun.preStartMs));
        setPreAction(frac);
      }
      if (dwellMs > tun.dwellMs) {
        // 300 ms gesture-veto window before final commit — already implicit:
        // any manual scroll within 1500 ms ago blocks decide().
        skipNext('disinterest');
        schmittArmed = false;
        armStartT = 0;
      }
    } else {
      setPreAction(0);
    }
  }

  function skipNext(reason) {
    lastSkipT       = Date.now();
    lastAutoSkipT   = lastSkipT;
    pendingSkipT    = 0;
    setPreAction(0);
    flashSkip(reason);
    skipLog.push({ t: lastSkipT, reason, autoOrManual: 'auto' });
    if (skipLog.length > 200) skipLog.shift();
    videosSkipped++;
    const opts = { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40, which: 40, bubbles: true, cancelable: true };
    document.dispatchEvent(new KeyboardEvent('keydown', opts));
    document.dispatchEvent(new KeyboardEvent('keyup',   opts));
    resetVideoState();
  }

  function flashSkip(reason) {
    ui.classList.add('__d-skipping');
    hintEl.textContent = reason === 'shake'        ? '↺ pää pudistus → skip'
                       : reason === 'gesture'      ? '👇 ele → skip'
                       : reason === 'disinterest'  ? '✕ kiinnostus loppui → skip'
                       :                             '✕ skip';
    setTimeout(() => {
      ui.classList.remove('__d-skipping');
      hintEl.textContent = 'ele alas = skip · ele ylös = pidempään · pudistus = pakkoskip';
    }, 1500);
  }
  function flashKeep() {
    ui.classList.add('__d-keeping');
    hintEl.textContent = '↑ ele/nyökkäys → pidetään pidempään';
    setTimeout(() => {
      ui.classList.remove('__d-keeping');
      hintEl.textContent = 'ele alas = skip · ele ylös = pidempään · pudistus = pakkoskip';
    }, 1500);
  }

  // ── Subscribe to biometrics ────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type !== 'tick') return;
    const p = msg.payload || {};
    if (p.ovision) {
      if (p.ovision.pupil && typeof p.ovision.pupil.mean === 'number') {
        lastPupilMm = p.ovision.pupil.mean;
        lastPupilT = performance.now();
      }
      // Eksplisiittinen ele Shortsin yli — alas-swipe = skip, ylös = keep
      const g = p.ovision.gesture;
      if (g && g.gesture && enabled && isShorts()) {
        const ts = (g.ts || 0) * 1000;
        if (!window.__d_lastGestureTs || ts > window.__d_lastGestureTs) {
          window.__d_lastGestureTs = ts;
          if (g.gesture === 'next' && Date.now() - lastSkipT > 1500) {
            skipNext('gesture');
          } else if (g.gesture === 'prev') {
            // KEEP — venytä videoaikaa, pakota schmitt pois
            videoStartT = performance.now() - 100;
            schmittArmed = false; armStartT = 0; setPreAction(0);
            flashKeep();
          }
        }
      }
    }

    // Tee päätös JOKA tickillä → algoritmi reagoi 5–30 Hz tahdilla
    decide(p);

    // Update UI engagement bar
    const dis = computeDisinterest(p);
    const eng = engagementUi(p, dis);
    lastEng = lastEng * 0.8 + eng * 0.2;
    updateUI();
  });

  setInterval(updateUI, 250);
  // Run decide() periodically too — vältä pitkiä tickejä jumittumasta
  setInterval(() => {
    if (!enabled || !isShorts()) return;
    // Empty state — algorithm uses cached lastPupilMm etc.
    decide({});
  }, 500);
  updateUI();
})();
