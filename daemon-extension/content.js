// Daemon HUD — sci-fi diagnostic panel injected into every page.

(() => {
  if (window.__daemonInjected) return;
  window.__daemonInjected = true;

  const root = document.createElement('div');
  root.id = '__daemon-root';
  root.innerHTML = `
    <div id="__d-pill" title="Klikkaa avataksesi paneeli">
      <span class="__d-pulse"></span>
      <span class="__d-bpm-mini">--</span>
      <span class="__d-unit-mini">bpm</span>
    </div>
    <div id="__d-panel">
      <div class="__d-corner __d-tl"></div><div class="__d-corner __d-tr"></div>
      <div class="__d-corner __d-bl"></div><div class="__d-corner __d-br"></div>
      <div id="__d-handle">
        <div class="__d-title">DAEMON · live biometrics</div>
        <button id="__d-close">×</button>
      </div>
      <div class="__d-grid">
        <div class="__d-cell __d-bpm-cell">
          <div class="__d-section-label">CARDIO</div>
          <div class="__d-bpm-big">
            <span class="__d-pulse __d-pulse-big"></span>
            <span id="__d-bpm-big">--</span>
            <span class="__d-bpm-unit">bpm</span>
          </div>
          <div class="__d-meta-row">
            <span>SNR <b id="__d-snr">—</b></span>
            <span>FPS <b id="__d-fps">—</b></span>
            <span>face <b id="__d-face">—</b></span>
          </div>
        </div>

        <div class="__d-cell">
          <div class="__d-section-label">ROI ×50 <span class="__d-hint">(skin pulse magnified)</span></div>
          <canvas id="__d-amp" width="60" height="45"></canvas>
        </div>

        <div class="__d-cell __d-wide">
          <div class="__d-section-label">rPPG WAVEFORM</div>
          <canvas id="__d-wave" width="320" height="60"></canvas>
        </div>

        <div class="__d-cell __d-wide">
          <div class="__d-section-label">FFT SPECTRUM <span class="__d-hint" id="__d-peak"></span></div>
          <canvas id="__d-spec" width="320" height="60"></canvas>
        </div>

        <div class="__d-cell __d-wide">
          <div class="__d-section-label">AFFECT <span class="__d-hint" id="__d-emolabel">neutral</span></div>
          <div class="__d-shapes" id="__d-shapes"></div>
        </div>

        <div class="__d-cell __d-wide">
          <div class="__d-section-label">EMOTION TIMELINE · 30s</div>
          <canvas id="__d-emoline" width="320" height="40"></canvas>
        </div>

        <div class="__d-cell __d-wide">
          <div class="__d-section-label">BPM TREND · 60s</div>
          <canvas id="__d-bpmline" width="320" height="40"></canvas>
        </div>

        <div class="__d-cell __d-wide __d-seetrue" id="__d-seetrue">
          <div class="__d-section-label">SEETRUE
            <span class="__d-hint" id="__d-st-conn">offline</span>
          </div>
          <div class="__d-st-row">
            <div class="__d-st-pupil">
              <div class="__d-st-eye">
                <span class="__d-st-eye-lbl">L</span>
                <span class="__d-st-pupil-track"><span class="__d-st-pupil-fill" id="__d-pupL"></span></span>
                <span class="__d-st-pupil-num" id="__d-pupL-num">—</span>
              </div>
              <div class="__d-st-eye">
                <span class="__d-st-eye-lbl">R</span>
                <span class="__d-st-pupil-track"><span class="__d-st-pupil-fill" id="__d-pupR"></span></span>
                <span class="__d-st-pupil-num" id="__d-pupR-num">—</span>
              </div>
            </div>
            <div class="__d-st-meta">
              <div>sacc <b id="__d-st-sacc">—</b>/s</div>
              <div>dwell <b id="__d-st-dwell">—</b></div>
              <div>evt <b id="__d-st-evt">—</b></div>
            </div>
          </div>
        </div>

        <!-- WEBCAM- ja LASIEN KAMERA -solut piilotettu oletuksena.
             Videokuvat näkyvät natiivissa cv2-ikkunassa bridge.py:n kautta
             (sulavampi, ei chrome msg-passing-overheadia).
             Cellit jätetty DOMiin ettei content.js:n koodi tarvitse muutoksia. -->
        <div class="__d-cell __d-wide" id="__d-webcam-cell" style="display:none">
          <div class="__d-section-label">WEBCAM · face mesh
            <span class="__d-hint">native cv2 window</span>
          </div>
          <canvas id="__d-webcam" width="240" height="180"></canvas>
        </div>

        <div class="__d-cell __d-wide" id="__d-scene-cell" style="display:none">
          <div class="__d-section-label">LASIEN KAMERA · gaze overlay
            <span class="__d-hint" id="__d-scene-hint">native cv2 window</span>
          </div>
          <canvas id="__d-scene" width="240" height="180"></canvas>
        </div>
      </div>
      <div class="__d-foot">
        <span id="__d-gazestat">gaze ·</span>
        <span id="__d-error" class="__d-err"></span>
      </div>
    </div>
    <div id="__d-gaze"></div>
  `;
  (document.documentElement || document.body).appendChild(root);

  const $ = id => root.querySelector(id);
  const pill   = $('#__d-pill');
  const panel  = $('#__d-panel');
  const handle = $('#__d-handle');
  const closeBtn = $('#__d-close');
  const bpmMini  = pill.querySelector('.__d-bpm-mini');
  const bpmBig   = $('#__d-bpm-big');
  const snrEl    = $('#__d-snr');
  const fpsEl    = $('#__d-fps');
  const faceEl   = $('#__d-face');
  const peakEl   = $('#__d-peak');
  const emoLabel = $('#__d-emolabel');
  const shapesEl = $('#__d-shapes');
  const errEl    = $('#__d-error');
  const gazeStat = $('#__d-gazestat');
  const gazeBall = $('#__d-gaze');

  const ampCv  = $('#__d-amp');
  const ampCtx = ampCv.getContext('2d');
  const ampImg = ampCtx.createImageData(60, 45);

  // Webkamera-preview canvas (face mesh overlaylla, offscreen.js renderöi)
  const webcamCv  = $('#__d-webcam');
  const webcamCtx = webcamCv.getContext('2d');
  const webcamImg = webcamCtx.createImageData(240, 180);

  // SeeTrue scene-cam canvas (lasit-etukameran kuva + gaze-piste)
  const sceneCv      = $('#__d-scene');
  const sceneCtx     = sceneCv.getContext('2d');
  const sceneHintEl  = $('#__d-scene-hint');
  let _sceneImageEl  = null;          // <img>-elementti dataURL-purkamiseen
  let _sceneLastUrl  = null;          // välttääksemme saman framin uudelleenlatauksen
  let _sceneImageReady = false;

  // SeeTrue cell
  const stCell    = $('#__d-seetrue');
  const stConnEl  = $('#__d-st-conn');
  const pupLFill  = $('#__d-pupL');
  const pupRFill  = $('#__d-pupR');
  const pupLNum   = $('#__d-pupL-num');
  const pupRNum   = $('#__d-pupR-num');
  const stSaccEl  = $('#__d-st-sacc');
  const stDwellEl = $('#__d-st-dwell');
  const stEvtEl   = $('#__d-st-evt');
  // SEETRUE-osio on AINA näkyvissä — chipin teksti kertoo yhteyden tilan.
  // Tämä on käyttäjälle paljon parempi kuin että cell ilmestyy/häviää.
  stCell.style.display = 'flex';
  stConnEl.textContent = 'bridge offline';
  stConnEl.style.color = '#ff8c8c';
  let lastSeetrueT = performance.now();

  const waveCv  = $('#__d-wave');
  const waveCtx = waveCv.getContext('2d');
  const specCv  = $('#__d-spec');
  const specCtx = specCv.getContext('2d');
  const emoCv   = $('#__d-emoline');
  const emoCtx  = emoCv.getContext('2d');
  const bpmCv   = $('#__d-bpmline');
  const bpmCtxC = bpmCv.getContext('2d');

  // ---- panel show/hide & drag ----
  let panelOpen = false;
  function setPanel(open) {
    panelOpen = open;
    panel.classList.toggle('__d-open', open);
    pill.classList.toggle('__d-hidden', open);
  }
  pill.onclick = () => setPanel(true);
  closeBtn.onclick = (e) => { e.stopPropagation(); setPanel(false); };

  // drag
  let dragging = false, dx = 0, dy = 0;
  handle.addEventListener('mousedown', (e) => {
    if (e.target === closeBtn) return;
    dragging = true;
    const r = panel.getBoundingClientRect();
    dx = e.clientX - r.left; dy = e.clientY - r.top;
    panel.style.transition = 'none';
    e.preventDefault();
  });
  addEventListener('mousemove', (e) => {
    if (!dragging) return;
    panel.style.left = (e.clientX - dx) + 'px';
    panel.style.top  = (e.clientY - dy) + 'px';
    panel.style.right = 'auto';
  });
  addEventListener('mouseup', () => { dragging = false; panel.style.transition = ''; });

  // ---- webcam preview rendering ----
  // offscreen.js piirtää webkameran preview-kuvan + face-mesh-overlayn ja
  // lähettää raw pixelit. Me vain blittaamme ne canvasille.
  function renderWebcam(payload) {
    if (!payload || !payload.pixels) return;
    const data = webcamImg.data;
    const src = payload.pixels;
    // Uint8ClampedArray takes a structuredClone. Kopioidaan suoraan.
    for (let i = 0; i < data.length; i++) data[i] = src[i];
    webcamCtx.putImageData(webcamImg, 0, 0);
  }

  // ---- SeeTrue scene-cam rendering ----
  // Bridge lähettää JPEG/base64. Pidämme yhden Image-elementin ja vaihdamme
  // sen src:n vain kun saamme uuden framen. Gaze-overlay piirretään aina
  // uusiksi olipa frame uusi tai ei — gaze-piste päivittyy 50 Hz vaikka
  // scene-frame tulee vain ~15 fps.
  let _sceneLastGaze = null;
  function renderScene(scene, gaze) {
    if (gaze) _sceneLastGaze = gaze;
    if (scene && scene.dataUrl && scene.dataUrl !== _sceneLastUrl) {
      _sceneLastUrl = scene.dataUrl;
      if (!_sceneImageEl) _sceneImageEl = new Image();
      _sceneImageEl.onload = () => {
        _sceneImageReady = true;
        drawScene(_sceneImageEl, _sceneLastGaze);
      };
      _sceneImageEl.src = scene.dataUrl;
      return;
    }
    // Sama scene-frame kuin viime kerralla → vain re-paint gaze overlaylla
    if (_sceneImageReady && _sceneImageEl) {
      drawScene(_sceneImageEl, _sceneLastGaze);
    }
  }
  function drawScene(img, gaze) {
    const W = sceneCv.width, H = sceneCv.height;
    sceneCtx.clearRect(0, 0, W, H);
    try { sceneCtx.drawImage(img, 0, 0, W, H); } catch {}
    // Gaze piste — gx/gy on normalisoitu 0..1 scene-camera coords
    if (gaze && typeof gaze.gx === 'number' && typeof gaze.gy === 'number'
        && gaze.gx >= -0.05 && gaze.gx <= 1.05
        && gaze.gy >= -0.05 && gaze.gy <= 1.05) {
      const x = gaze.gx * W;
      const y = gaze.gy * H;
      // Crosshair + ring
      sceneCtx.strokeStyle = '#ff4d6d';
      sceneCtx.lineWidth = 2;
      sceneCtx.shadowColor = '#ff4d6d';
      sceneCtx.shadowBlur = 8;
      sceneCtx.beginPath();
      sceneCtx.arc(x, y, 12, 0, Math.PI * 2);
      sceneCtx.stroke();
      sceneCtx.beginPath();
      sceneCtx.moveTo(x - 18, y); sceneCtx.lineTo(x - 6, y);
      sceneCtx.moveTo(x + 6, y);  sceneCtx.lineTo(x + 18, y);
      sceneCtx.moveTo(x, y - 18); sceneCtx.lineTo(x, y - 6);
      sceneCtx.moveTo(x, y + 6);  sceneCtx.lineTo(x, y + 18);
      sceneCtx.stroke();
      // Pieni täytetty piste keskelle
      sceneCtx.shadowBlur = 0;
      sceneCtx.fillStyle = '#fff';
      sceneCtx.beginPath();
      sceneCtx.arc(x, y, 2.5, 0, Math.PI * 2);
      sceneCtx.fill();
    }
  }

  // ---- gaze ball ----
  let smoothX = 0, smoothY = 0, gazeSeen = false, lastGazeT = 0;
  function placeGaze(sx, sy) {
    const chromeH = window.outerHeight - window.innerHeight;
    const vx = sx - window.screenX;
    const vy = sy - window.screenY - chromeH;
    if (!gazeSeen) { smoothX = vx; smoothY = vy; gazeSeen = true; }
    else {
      smoothX = smoothX*0.5 + vx*0.5;
      smoothY = smoothY*0.5 + vy*0.5;
    }
    gazeBall.style.transform = `translate(${smoothX}px, ${smoothY}px)`;
    gazeBall.style.display = 'block';
    lastGazeT = performance.now();
  }
  setInterval(() => {
    const fresh = performance.now() - lastGazeT < 2000;
    gazeStat.textContent = fresh ? 'gaze ✓' : 'gaze ·';
    gazeStat.className = fresh ? 'ok' : '';
    if (!fresh) gazeBall.style.display = 'none';
  }, 500);

  // ---- blendshape colors ----
  const COLOR_BY_PREFIX = {
    mouth: '#ff6b9c', eye: '#5c9eff', brow: '#ffc850',
    jaw: '#a78bfa', nose: '#51cf66', cheek: '#ff8c42'
  };
  function colorFor(name) {
    for (const k in COLOR_BY_PREFIX) if (name.startsWith(k)) return COLOR_BY_PREFIX[k];
    return '#888';
  }
  function renderShapes(shapes) {
    if (!shapes || shapes.length === 0) { shapesEl.innerHTML = ''; return; }
    shapesEl.innerHTML = shapes.map(s => {
      const pct = Math.min(100, Math.round(s.score * 100));
      return `<div class="__d-bar">
        <span class="__d-name">${s.name}</span>
        <span class="__d-track"><span class="__d-fill" style="width:${pct}%;background:${colorFor(s.name)}"></span></span>
        <span class="__d-pct">${pct}</span>
      </div>`;
    }).join('');
  }

  // ---- amplified ROI canvas ----
  function renderAmp(pixels) {
    if (!pixels) return;
    // pixels saapuu Uint8ClampedArrayna (structuredClone). Luodaan ImageData siitä.
    const data = ampImg.data;
    for (let i=0; i<data.length; i++) data[i] = pixels[i];
    ampCtx.putImageData(ampImg, 0, 0);
  }

  // ---- waveform ----
  function renderWave(wf) {
    if (!wf || wf.length === 0) return;
    const W = waveCv.width, H = waveCv.height;
    waveCtx.clearRect(0, 0, W, H);
    // grid
    waveCtx.strokeStyle = 'rgba(255,255,255,.05)'; waveCtx.lineWidth = 1;
    for (let i=1; i<4; i++) {
      const y = (H/4)*i; waveCtx.beginPath(); waveCtx.moveTo(0, y); waveCtx.lineTo(W, y); waveCtx.stroke();
    }
    // line
    waveCtx.strokeStyle = '#ff4d6d'; waveCtx.lineWidth = 1.6;
    waveCtx.shadowColor = '#ff4d6d'; waveCtx.shadowBlur = 8;
    waveCtx.beginPath();
    const stride = wf.length / W;
    for (let i=0; i<W; i++) {
      const v = wf[Math.floor(i*stride)] || 0;
      const y = H - v*(H-4) - 2;
      if (i === 0) waveCtx.moveTo(i, y); else waveCtx.lineTo(i, y);
    }
    waveCtx.stroke();
    waveCtx.shadowBlur = 0;
  }

  // ---- spectrum ----
  // Float32Array hukkuu joskus structuredClonessa ja saapuu plain-objektina
  // {0:0.1, 1:0.2, length:N}. for..of kaatuu siinä — pakotetaan Array index-pohjaisesti.
  function _toNumArray(x) {
    if (!x) return null;
    if (Array.isArray(x)) return x;
    if (typeof x.length === 'number') {
      const out = new Array(x.length);
      for (let i = 0; i < x.length; i++) out[i] = x[i];
      return out;
    }
    // Fallback: object with numeric keys
    const keys = Object.keys(x).filter(k => /^\d+$/.test(k));
    if (keys.length === 0) return null;
    const out = new Array(keys.length);
    for (const k of keys) out[+k] = x[k];
    return out;
  }
  function renderSpec(spec) {
    if (!spec) return;
    const W = specCv.width, H = specCv.height;
    specCtx.clearRect(0, 0, W, H);
    const powers = _toNumArray(spec.powers);
    const bpms   = _toNumArray(spec.bpms);
    if (!powers || powers.length === 0) return;
    let mx = 0; for (let i=0;i<powers.length;i++) { if (powers[i] > mx) mx = powers[i]; }
    if (mx === 0) return;
    specCtx.fillStyle = '#5c9eff'; specCtx.shadowColor = '#5c9eff'; specCtx.shadowBlur = 6;
    const bw = W / powers.length;
    for (let i=0; i<powers.length; i++) {
      const h = (powers[i]/mx) * (H-4);
      specCtx.fillRect(i*bw, H - h, Math.max(1, bw-1), h);
    }
    specCtx.shadowBlur = 0;
    // peak marker
    if (typeof spec.peak === 'number' && bpms && bpms.length) {
      const peakIdx = Math.round((spec.peak - bpms[0]) / (bpms[bpms.length-1] - bpms[0]) * (powers.length-1));
      specCtx.strokeStyle = '#ff4d6d'; specCtx.lineWidth = 1;
      specCtx.beginPath();
      const px = peakIdx * bw + bw/2;
      specCtx.moveTo(px, 0); specCtx.lineTo(px, H); specCtx.stroke();
      peakEl.textContent = `peak ${spec.peak.toFixed(0)} bpm`;
    }
  }

  // ---- emotion timeline ----
  const EMO_COLORS = {
    happy:'#51cf66', sad:'#5c9eff', surprised:'#ffc850', angry:'#ff4d6d',
    disgusted:'#a78bfa', focused:'#22b8cf', tired:'#888', neutral:'rgba(255,255,255,.15)'
  };
  function renderEmoTimeline(timeline) {
    if (!timeline) return;
    const W = emoCv.width, H = emoCv.height;
    emoCtx.clearRect(0, 0, W, H);
    if (timeline.length === 0) return;
    const now = performance.now();
    const dur = 30000;
    for (const e of timeline) {
      const x = W - ((now - e.t) / dur) * W;
      if (x < 0) continue;
      const c = EMO_COLORS[e.label] || '#666';
      const h = Math.max(2, e.score * H);
      emoCtx.fillStyle = c;
      emoCtx.fillRect(x-1, H - h, 2, h);
    }
  }

  // ---- bpm trend ----
  function renderBpmTrend(timeline) {
    if (!timeline || timeline.length < 2) return;
    const W = bpmCv.width, H = bpmCv.height;
    bpmCtxC.clearRect(0, 0, W, H);
    let mn=Infinity, mx=-Infinity;
    for (const p of timeline) { if (p.bpm<mn) mn=p.bpm; if (p.bpm>mx) mx=p.bpm; }
    if (mx-mn < 4) { mn = (mn+mx)/2 - 2; mx = mn + 4; }
    const span = mx - mn;
    const now = performance.now();
    const dur = 60000;
    bpmCtxC.strokeStyle = '#ff4d6d'; bpmCtxC.lineWidth = 1.4;
    bpmCtxC.shadowColor = '#ff4d6d'; bpmCtxC.shadowBlur = 6;
    bpmCtxC.beginPath();
    let first = true;
    for (const p of timeline) {
      const x = W - ((now - p.t) / dur) * W;
      const y = H - ((p.bpm - mn) / span) * (H-4) - 2;
      if (first) { bpmCtxC.moveTo(x, y); first = false; } else bpmCtxC.lineTo(x, y);
    }
    bpmCtxC.stroke();
    bpmCtxC.shadowBlur = 0;
    bpmCtxC.fillStyle = 'rgba(255,255,255,.4)';
    bpmCtxC.font = '9px monospace';
    bpmCtxC.fillText(mx.toFixed(0), 2, 10);
    bpmCtxC.fillText(mn.toFixed(0), 2, H-2);
  }

  // ---- main state apply ----
  let bpmPulse;
  function applyState(p) {
    if (!p) return;
    if (typeof p.bpm === 'number' && p.bpm > 0) {
      bpmMini.textContent = p.bpm.toFixed(0);
      bpmBig.textContent = p.bpm.toFixed(0);
      const dur = (60 / p.bpm) + 's';
      pill.querySelector('.__d-pulse').style.animationDuration = dur;
      const big = panel.querySelector('.__d-pulse-big');
      if (big) big.style.animationDuration = dur;
    }
    if (typeof p.snr === 'number') snrEl.textContent = p.snr.toFixed(1);
    if (typeof p.fps === 'number') fpsEl.textContent = p.fps.toFixed(1);
    if (p.face === false) { faceEl.textContent = '×'; faceEl.style.color = '#ff8c8c'; }
    else if (p.face === true) { faceEl.textContent = '✓'; faceEl.style.color = '#51cf66'; }
    if (p.error) { errEl.textContent = '⚠ ' + p.error; }
    else if (p.error === null) errEl.textContent = '';
    if (p.emotion) {
      const sc = Math.round((p.emotion.score || 0) * 100);
      emoLabel.textContent = p.emotion.label + (sc ? ' · ' + sc + '%' : '');
      emoLabel.style.color = EMO_COLORS[p.emotion.label] || '#fff';
    }
    // Yksittäisen renderin virhe ei saa estää muita (esim. SEETRUE-osiota)
    const safe = (fn, arg, name) => {
      try { fn(arg); } catch (e) { console.warn('[content]', name, 'error', e); }
    };
    if (p.blendshapes)     safe(renderShapes,      p.blendshapes,     'renderShapes');
    if (p.ampPixels)       safe(renderAmp,         p.ampPixels,       'renderAmp');
    if (p.waveform)        safe(renderWave,        p.waveform,        'renderWave');
    if (p.spectrum)        safe(renderSpec,        p.spectrum,        'renderSpec');
    if (p.emotionTimeline) safe(renderEmoTimeline, p.emotionTimeline, 'renderEmoTimeline');
    if (p.bpmTimeline)     safe(renderBpmTrend,    p.bpmTimeline,     'renderBpmTrend');
    if (p.webcamPreview)   safe(renderWebcam,      p.webcamPreview,   'renderWebcam');
    // Lasit-skenekameran kuva + gaze overlayn päälle. Tarvitsee
    // sekä scene-payloadin että uusimman gaze-koordinaatin.
    if (p.ovision && p.ovision.scene) {
      try { renderScene(p.ovision.scene, p.ovision.gaze); }
      catch (e) { console.warn('[content] renderScene error', e); }
      if (sceneHintEl) {
        const ageMs = performance.now() - (p.ovision.scene.ts || 0) * 1000;
        sceneHintEl.textContent = ageMs < 2000 ? 'live' : 'stale';
        sceneHintEl.style.color = ageMs < 2000 ? '#51cf66' : '#ffc850';
      }
    }
    if (p.gaze) { try { placeGaze(p.gaze.x, p.gaze.y); } catch (e) { console.warn('[content] placeGaze', e); } }
    // fusion.connected päivittää bridge-yhteyden tilan; varsinaisen 3-tilaisen
    // chipin renderöinti tehdään renderSeetrue:ssa kun ovision-snapshot saapuu.
    if (p.fusion && typeof p.fusion.connected === 'boolean') {
      // Näytä SEETRUE-osio heti kun bridge-yhteys nousee, ettei käyttäjä jää
      // ihmettelemään mistä SEETRUE-status edes näkyisi.
      stCell.style.display = 'flex';
      lastSeetrueT = performance.now();
      if (!p.fusion.connected) {
        stConnEl.textContent = 'bridge offline';
        stConnEl.style.color = '#ff8c8c';
      }
    }
    if (p.ovision) renderSeetrue(p.ovision);
  }

  // Pupil bars normalized to a typical adult range (2–7 mm).
  // Keep a slow-EMA baseline so the bar fills around 50% in steady state.
  const PUP_MIN = 2.0, PUP_MAX = 7.0;
  let pupBaseline = null;
  function renderSeetrue(ov) {
    if (!ov) return;
    lastSeetrueT = performance.now();
    stCell.style.display = 'flex';
    // ── 3-tilainen yhteyden tila ─────────────────────────────────────────────
    //  red    bridge offline       — WebSocket ei pystyssä
    //  amber  bridge ✓ · SeeTrue  — bridge auki mutta ei gaze-dataa
    //  green  live · N/s          — gaze virtaa
    const br = ov.bridge;
    const heartbeatFresh = br && (performance.now() - (br.ts || 0) < 4000);
    if (!ov.connected) {
      stConnEl.textContent = 'bridge offline';
      stConnEl.style.color = '#ff8c8c';
    } else if (!heartbeatFresh || !br.seetrue_alive) {
      const age = heartbeatFresh ? br.last_event_age_s : null;
      stConnEl.textContent = (age == null)
        ? 'bridge ✓ · SeeTrue silent'
        : `bridge ✓ · SeeTrue ${age.toFixed(0)}s ago`;
      stConnEl.style.color = '#ffc850';
    } else {
      const rate = br.msgs_per_sec || 0;
      stConnEl.textContent = `live · ${rate.toFixed(0)}/s`;
      stConnEl.style.color = '#51cf66';
    }
    if (ov.pupil) {
      const valid = (v) => Number.isFinite(v) && v > 0.5 && v < 12;
      const L = valid(ov.pupil.L) ? ov.pupil.L : null;
      const R = valid(ov.pupil.R) ? ov.pupil.R : null;
      const setPup = (fill, num, mm) => {
        if (mm === null) { fill.style.width = '0%'; num.textContent = '—'; return; }
        const f = Math.max(0, Math.min(1, (mm - PUP_MIN) / (PUP_MAX - PUP_MIN)));
        fill.style.width = (f * 100).toFixed(0) + '%';
        num.textContent = mm.toFixed(2);
      };
      setPup(pupLFill, pupLNum, L);
      setPup(pupRFill, pupRNum, R);
      // Color tint vs slow baseline (engagement vs disengagement proxy)
      if (typeof ov.pupil.mean === 'number') {
        if (pupBaseline === null) pupBaseline = ov.pupil.mean;
        else pupBaseline = pupBaseline * 0.995 + ov.pupil.mean * 0.005;
        const delta = ov.pupil.mean - pupBaseline;
        const color = delta > 0.05 ? '#51cf66' : delta < -0.05 ? '#ffc850' : '#5c9eff';
        pupLFill.style.background = color;
        pupRFill.style.background = color;
      }
    }
    if (typeof ov.saccadePerSec === 'number') {
      stSaccEl.textContent = ov.saccadePerSec.toFixed(1);
    }
    if (typeof ov.fixDwellMs === 'number') {
      stDwellEl.textContent = ov.fixDwellMs > 0
        ? (ov.fixDwellMs / 1000).toFixed(1) + 's'
        : '—';
    }
    if (ov.gaze && ov.gaze.event) {
      stEvtEl.textContent = ov.gaze.event.toLowerCase();
    }
  }
  // SEETRUE-osio pysyy näkyvissä — jos data lakkaa virtaamasta, chip muuttuu
  // punaiseksi/keltaiseksi mutta itse cell ei piiloudu. Käyttäjälle
  // ennustettavampaa kuin että UI vilkkuu.
  setInterval(() => {
    if (lastSeetrueT && performance.now() - lastSeetrueT > 5000) {
      stConnEl.textContent = 'no data (5s)';
      stConnEl.style.color = '#ff8c8c';
    }
  }, 1000);

  // Debug counters näkyvät vain konsolissa — auttaa diagnosoimaan jos
  // SEETRUE-osio ei päivity vaikka offscreen vakuuttaa lähettäneensä dataa.
  let _tickCount = 0, _ovisionCount = 0;
  setInterval(() => {
    if (_tickCount > 0) {
      console.log(`[content] ticks=${_tickCount} ovision=${_ovisionCount} ` +
        `lastSeetrueAge=${((performance.now() - lastSeetrueT)/1000).toFixed(1)}s`);
    }
  }, 2000);

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg) return;
    if (msg.type === 'state' && msg.running === false) {
      pill.classList.add('__d-hidden');
      setPanel(false);
      gazeBall.style.display = 'none';
      return;
    }
    if (msg.type === 'tick') {
      _tickCount++;
      if (msg.payload && msg.payload.ovision) _ovisionCount++;
      pill.classList.remove('__d-hidden');
      try {
        applyState(msg.payload);
      } catch (e) {
        console.error('[content] applyState error', e, msg.payload);
      }
    }
  });

  chrome.runtime.sendMessage({ type: 'engine:state' }, (state) => {
    if (chrome.runtime.lastError || !state) return;
    pill.classList.remove('__d-hidden');
    applyState(state);
  });
})();
