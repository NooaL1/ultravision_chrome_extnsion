// YouTube Shorts auto-scroller. Mittaa kiinnostusta biometriasta + tunnistaa
// pään pudistuksen. Skippaa videon kun signaali on negatiivinen tai kun
// pysyt vain neutraalina liian pitkään. Säädettävä herkkyys.

(() => {
  if (window.__daemonShortsInjected) return;
  window.__daemonShortsInjected = true;
  const isShorts = () => /\/shorts\//.test(location.pathname);

  const SK_ENABLED = '__daemon_shorts_enabled';
  const SK_SENS    = '__daemon_shorts_sensitivity';
  let enabled = JSON.parse(localStorage.getItem(SK_ENABLED) ?? 'true');
  let sensitivity = parseFloat(localStorage.getItem(SK_SENS) ?? '50'); // 0..100

  // ---- UI ----
  const ui = document.createElement('div');
  ui.id = '__d-shorts';
  ui.innerHTML = `
    <div class="__d-shorts-meter">
      <div class="__d-shorts-fill" id="__ds-fill"></div>
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
      <div class="__d-shorts-row __d-shorts-sens">
        <span class="__d-shorts-sens-lbl">herkkyys</span>
        <input type="range" id="__ds-sens" min="0" max="100" value="${sensitivity}">
        <span id="__ds-sens-val">${sensitivity}</span>
      </div>
      <div class="__d-shorts-row __d-shorts-hint" id="__ds-hint">
        pää pudistus = skip · nyökkäys = pidempään
      </div>
    </div>
    <button class="__d-shorts-toggle" id="__ds-toggle" title="Päällä / pois">
      <span id="__ds-toggle-icon">${enabled ? '⏻' : '○'}</span>
    </button>
  `;
  document.documentElement.appendChild(ui);

  const fillEl   = ui.querySelector('#__ds-fill');
  const emojiEl  = ui.querySelector('#__ds-emoji');
  const labelEl  = ui.querySelector('#__ds-label');
  const pctEl    = ui.querySelector('#__ds-pct');
  const timeEl   = ui.querySelector('#__ds-time');
  const toggleEl = ui.querySelector('#__ds-toggle');
  const toggleIcon = ui.querySelector('#__ds-toggle-icon');
  const sensEl     = ui.querySelector('#__ds-sens');
  const sensValEl  = ui.querySelector('#__ds-sens-val');
  const hintEl     = ui.querySelector('#__ds-hint');

  toggleEl.onclick = () => {
    enabled = !enabled;
    localStorage.setItem(SK_ENABLED, enabled);
    toggleIcon.textContent = enabled ? '⏻' : '○';
    ui.classList.toggle('__d-disabled', !enabled);
    interestEMA = 0.5; videoStartT = performance.now();
  };
  ui.classList.toggle('__d-disabled', !enabled);

  sensEl.oninput = () => {
    sensitivity = parseFloat(sensEl.value);
    sensValEl.textContent = sensitivity.toFixed(0);
    localStorage.setItem(SK_SENS, sensitivity);
  };

  // ---- state ----
  let interestEMA = 0.5;
  let videoStartT = performance.now();
  let lastSkipT = 0;
  let lastManualScrollT = 0;
  let lastUrl = location.href;
  let lastPositiveT = performance.now(); // milloin viimeksi oli >0.55 signaali

  // Yaw-historia head shaken havaitsemiseen
  const yawHist = []; // {t, yaw}
  const pitchHist = []; // for nod (positive signal)

  // SeeTrue pupil baseline. Slow EWMA over ~30s of valid samples — kun
  // SeeTrue käynnistyy ja laitetta kalibroidaan, baseline asettuu nopeasti
  // (alpha kasvaa kunnes 30 hyvää näytettä on saatu).
  let pupilBaseline = null;
  let pupilSamples = 0;
  const PUPIL_TARGET = 30; // ~6s @ 5 Hz tai sec @ 50 Hz
  let lastPupilMm = null;
  let lastPupilT = 0;
  function updatePupilBaseline(mm) {
    if (!Number.isFinite(mm) || mm < 1.0 || mm > 10.0) return;
    pupilSamples++;
    // Aluksi nopea sopeutuminen (1/n keskiarvo), siirtyy EMA:ksi PUPIL_TARGET
    // näytteen jälkeen.
    if (pupilBaseline === null) { pupilBaseline = mm; return; }
    const alpha = pupilSamples < PUPIL_TARGET
      ? 1 / (pupilSamples + 1)
      : 0.01; // ~100-näytteen efektiivinen ikkuna
    pupilBaseline = pupilBaseline * (1 - alpha) + mm * alpha;
  }

  addEventListener('wheel', () => { lastManualScrollT = Date.now(); }, { passive: true });
  addEventListener('touchstart', () => { lastManualScrollT = Date.now(); }, { passive: true });
  addEventListener('keydown', (e) => {
    if (['ArrowDown','ArrowUp','PageDown','PageUp','j','k'].includes(e.key)) {
      lastManualScrollT = Date.now();
    }
  });

  function syncShortsState() {
    const onShorts = isShorts();
    ui.style.display = onShorts ? 'flex' : 'none';
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      videoStartT = performance.now();
      interestEMA = 0.5;
      lastPositiveT = performance.now();
      yawHist.length = 0; pitchHist.length = 0;
      // Säilytä pupillin baseline yli videoiden — se kuvaa käyttäjää, ei klippiä
    }
  }
  syncShortsState();
  setInterval(syncShortsState, 200);

  // ---- scoring ----
  function instantScore(state) {
    let s = 0.40;
    const m = {};
    for (const sh of (state.blendshapes || [])) m[sh.name] = sh.score;

    // POSITIIVISET
    const smileL = m.mouthSmileLeft || 0, smileR = m.mouthSmileRight || 0;
    const smile = (smileL + smileR) / 2;
    const eyeWide = ((m.eyeWideLeft || 0) + (m.eyeWideRight || 0)) / 2;
    const browInnerUp = (m.browInnerUp || 0);
    const browOuterUp = ((m.browOuterUpLeft || 0) + (m.browOuterUpRight || 0)) / 2;
    const jawOpen = (m.jawOpen || 0);
    const cheekSquint = ((m.cheekSquintLeft || 0) + (m.cheekSquintRight || 0)) / 2;

    s += smile * 0.7;
    // "Naurahdus" = hymy + leuka auki + posket kiristyvät → vahva positiivinen
    if (smile > 0.25 && jawOpen > 0.15) s += 0.4;
    if (cheekSquint > 0.15 && smile > 0.15) s += 0.25; // aito hymy
    s += eyeWide * 0.35;
    s += browInnerUp * 0.15;
    s += browOuterUp * 0.20; // yllättynyt nostaa kulmia

    if (state.emotion?.label === 'happy')     s += 0.30 * (state.emotion.score || 0);
    if (state.emotion?.label === 'surprised') s += 0.40 * (state.emotion.score || 0);
    if (state.emotion?.label === 'focused')   s += 0.20 * (state.emotion.score || 0);

    // NEGATIIVISET
    const blink = ((m.eyeBlinkLeft || 0) + (m.eyeBlinkRight || 0)) / 2;
    const frown = ((m.mouthFrownLeft || 0) + (m.mouthFrownRight || 0)) / 2;
    const sneer = ((m.noseSneerLeft || 0) + (m.noseSneerRight || 0)) / 2;
    const browDown = ((m.browDownLeft || 0) + (m.browDownRight || 0)) / 2;
    const lipPress = (m.mouthPressLeft || 0) + (m.mouthPressRight || 0);
    const mouthPucker = (m.mouthPucker || 0);

    s -= blink * 0.50;
    s -= frown * 0.60;
    s -= sneer * 0.70;
    // Vihainen: kulmat alas + jännittynyt suu
    if (browDown > 0.30 && (frown > 0.15 || lipPress > 0.20)) s -= 0.50;
    s -= mouthPucker * 0.20; // hyi-suu

    if (state.emotion?.label === 'disgusted') s -= 0.50 * (state.emotion.score || 0);
    if (state.emotion?.label === 'tired')     s -= 0.45 * (state.emotion.score || 0);
    if (state.emotion?.label === 'sad')       s -= 0.35 * (state.emotion.score || 0);
    if (state.emotion?.label === 'angry')     s -= 0.50 * (state.emotion.score || 0);

    if (state.face === false) s -= 0.20;

    // ── SeeTrue pupil dilation (z-score-style vs personal baseline) ─────────
    // Tutkimuskonsensus (Mathôt 2018, Bradley 2008): +0.05–0.15 mm yli
    // baselinen sustained ≥1 s = engagement; vastaava lasku = disengagement.
    // Käytetään suhteellista poikkeamaa baseliniin — luminanssikorjausta ei
    // ole, joten kerrointa pidetään maltillisena ja vaaditaan selvä margin.
    if (lastPupilMm !== null && pupilBaseline !== null && pupilSamples >= 6
        && performance.now() - lastPupilT < 2000) {
      const rel = (lastPupilMm - pupilBaseline) / pupilBaseline;
      // ±15% kynnys plan.md:n mukaan; saturoituu ±0.30 kohdalla.
      if (rel > 0.15) {
        s += Math.min(0.20, (rel - 0.15) * 1.0 + 0.05);
      } else if (rel < -0.15) {
        s -= Math.min(0.25, (-rel - 0.15) * 1.5 + 0.05);
      }
    }

    return Math.max(0, Math.min(1, s));
  }

  // ---- head gestures ----
  // Pää pudistus: yaw oskilloi nopeasti puolelta toiselle
  function detectHeadShake(now) {
    // Pidä viim. 1.2s ikkuna
    while (yawHist.length && now - yawHist[0].t > 1200) yawHist.shift();
    if (yawHist.length < 6) return false;
    const ys = yawHist.map(p => p.yaw);
    let mn = Infinity, mx = -Infinity;
    for (const y of ys) { if (y < mn) mn = y; if (y > mx) mx = y; }
    const range = mx - mn;
    // Lasketaan zero-crossings keskiarvon ympäri
    const mean = ys.reduce((a,b)=>a+b,0) / ys.length;
    let cross = 0;
    for (let i = 1; i < ys.length; i++) {
      if ((ys[i-1] - mean) * (ys[i] - mean) < 0) cross++;
    }
    // Vähintään 25° peak-to-peak ja 3+ ylitystä = pään pudistus
    return range > 25 && cross >= 3;
  }

  // Pään nyökkäys (positiivinen): pitch oskilloi
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

  function classify(emaScore) {
    if (emaScore > 0.72) return { emoji: '🔥', label: 'kiinnostaa' };
    if (emaScore > 0.58) return { emoji: '😊', label: 'ihan kiva' };
    if (emaScore > 0.42) return { emoji: '⚪', label: 'neutraali' };
    if (emaScore > 0.28) return { emoji: '😐', label: 'tylsähköä' };
    return { emoji: '💤', label: 'tylsä' };
  }

  function updateUI() {
    const pct = Math.round(interestEMA * 100);
    fillEl.style.width = pct + '%';
    fillEl.style.background = interestEMA > 0.55 ? '#51cf66'
                            : interestEMA > 0.35 ? '#ffc850'
                            : '#ff4d6d';
    const c = classify(interestEMA);
    emojiEl.textContent = c.emoji;
    labelEl.textContent = c.label;
    pctEl.textContent = pct;
    const elapsed = (performance.now() - videoStartT) / 1000;
    timeEl.textContent = elapsed.toFixed(1) + 's';
  }

  // Sensitivity slider mappaa kynnyksiin:
  // 0   = kärsivällinen (kynnys 0.18, neutraaliodotus 12s)
  // 50  = balanced     (kynnys 0.30, neutraaliodotus 7s)
  // 100 = aggressiivinen (kynnys 0.45, neutraaliodotus 3s)
  function thresholds() {
    const t = sensitivity / 100;
    return {
      negThreshold: 0.18 + t * 0.27,           // EMA jonka alle skipataan heti (2.5s+)
      neutralWaitMs: 12000 - t * 9000,         // milloin "ei mitään ylimainoita" -> skip
      minVideoMs: 2500 - t * 1500,             // miten kauan ekat vasta odotetaan
    };
  }

  function maybeSkip() {
    if (!enabled || !isShorts()) return;
    const now = performance.now();
    const elapsed = now - videoStartT;
    if (Date.now() - lastManualScrollT < 5000) return;
    if (Date.now() - lastSkipT < 1500) return;

    const th = thresholds();

    // 1) Pään pudistus = välitön skip
    if (detectHeadShake(now)) { skipNext('shake'); return; }

    // 2) Nyökkäys = pidennä videoStart -> pidetään pidempään
    if (detectNod(now)) {
      videoStartT = now - 100; // "nollaa" mutta merkitsee positiivisuutta
      lastPositiveT = now;
      flashKeep();
    }

    if (elapsed < th.minVideoMs) return;

    // 3) Negatiivinen signaali → skip
    if (interestEMA < th.negThreshold) { skipNext('neg'); return; }

    // 4) Neutraali liian pitkään → skip
    if (interestEMA > 0.55) lastPositiveT = now;
    if (now - lastPositiveT > th.neutralWaitMs && interestEMA < 0.55) {
      skipNext('neutral'); return;
    }
  }

  function skipNext(reason) {
    lastSkipT = Date.now();
    flashSkip(reason);
    const opts = { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40, which: 40, bubbles: true, cancelable: true };
    document.dispatchEvent(new KeyboardEvent('keydown', opts));
    document.dispatchEvent(new KeyboardEvent('keyup', opts));
    interestEMA = 0.5;
    lastPositiveT = performance.now();
  }

  function flashSkip(reason) {
    ui.classList.add('__d-skipping');
    hintEl.textContent = reason === 'shake'   ? '↺ pää pudistus → skip'
                       : reason === 'gesture' ? '👇 ele → skip'
                       : reason === 'neutral' ? '⏭ ei reaktiota → skip'
                       : '✕ negatiivinen → skip';
    setTimeout(() => {
      ui.classList.remove('__d-skipping');
      hintEl.textContent = 'pää pudistus = skip · nyökkäys = pidempään';
    }, 1200);
  }
  function flashKeep() {
    ui.classList.add('__d-keeping');
    hintEl.textContent = '↑ nyökkäys → pidetään pidempään';
    setTimeout(() => {
      ui.classList.remove('__d-keeping');
      hintEl.textContent = 'pää pudistus = skip · nyökkäys = pidempään';
    }, 1200);
  }

  // ---- subscribe to biometrics ----
  const ALPHA = 0.20;
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type !== 'tick') return;
    const p = msg.payload || {};
    if (p.headPose) {
      const t = performance.now();
      yawHist.push({ t, yaw: p.headPose.yaw });
      pitchHist.push({ t, pitch: p.headPose.pitch });
    }
    if (p.ovision) {
      if (p.ovision.pupil && typeof p.ovision.pupil.mean === 'number') {
        const mm = p.ovision.pupil.mean;
        lastPupilMm = mm;
        lastPupilT = performance.now();
        updatePupilBaseline(mm);
      }
      // Eksplisiittinen ele Shortsin yli — alas-swipe = skip
      const g = p.ovision.gesture;
      if (g && g.gesture && enabled && isShorts()) {
        const ts = (g.ts || 0) * 1000; // bridge tagaa s-tarkkuudella
        const fresh = !window.__d_lastGestureTs ||
                      ts > window.__d_lastGestureTs;
        if (fresh) {
          window.__d_lastGestureTs = ts;
          if (g.gesture === 'next' && Date.now() - lastSkipT > 1500) {
            skipNext('gesture');
          } else if (g.gesture === 'prev') {
            videoStartT = performance.now() - 100;
            lastPositiveT = performance.now();
            flashKeep();
          }
        }
      }
    }
    const inst = instantScore(p);
    interestEMA = interestEMA * (1 - ALPHA) + inst * ALPHA;
    updateUI();
    maybeSkip();
  });

  setInterval(updateUI, 250);
  setInterval(maybeSkip, 500); // jotta neutral-skip toimii myös ilman tickejä
  updateUI();
})();
