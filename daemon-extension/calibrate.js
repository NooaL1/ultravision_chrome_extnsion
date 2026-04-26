const banner = document.getElementById('banner');

addEventListener('keydown', e => { if (e.key === 'Escape') window.close(); });

(async () => {
  try {
    webgazer.params.showVideoPreview = false;
    webgazer.params.showFaceOverlay = false;
    webgazer.params.showFaceFeedbackBox = false;
    webgazer.params.showGazeDot = false;
    webgazer.saveDataAcrossSessions(true);
    webgazer.setRegression('ridge').setGazeListener(()=>{});
    await webgazer.begin();
    try { webgazer.showVideoPreview(false).showPredictionPoints(false).showFaceOverlay(false).showFaceFeedbackBox(false); } catch {}
  } catch (e) {
    banner.textContent = 'WebGazer init failasi: ' + (e?.message || e);
    return;
  }

  // 13 pistettä
  const positions = [
    [0.05,0.05],[0.5,0.05],[0.95,0.05],
    [0.05,0.5],[0.3,0.3],[0.5,0.5],[0.7,0.3],
    [0.3,0.7],[0.95,0.5],[0.7,0.7],
    [0.05,0.95],[0.5,0.95],[0.95,0.95],
  ];
  const CLICKS = 5;

  for (let i = 0; i < positions.length; i++) {
    const [px, py] = positions[i];
    const x = innerWidth * px, y = innerHeight * py;
    banner.innerHTML = `Pidä katse <b>punaisessa pallossa</b> ja klikkaa ${CLICKS} kertaa &nbsp;·&nbsp; ${i+1} / ${positions.length}`;
    const dot = document.createElement('div');
    dot.className = 'dot';
    dot.style.left = x + 'px'; dot.style.top = y + 'px';
    dot.textContent = String(CLICKS);
    document.body.appendChild(dot);
    await new Promise(r => setTimeout(r, 350));
    let c = 0;
    await new Promise(res => {
      dot.onclick = (ev) => {
        ev.stopPropagation();
        webgazer.recordScreenPosition(x, y, 'click');
        c++; dot.textContent = String(CLICKS - c);
        if (c >= CLICKS) {
          dot.classList.add('done');
          setTimeout(() => { dot.remove(); res(); }, 150);
        }
      };
    });
  }

  // Validointi: katso 2s keskipistettä
  const cx = innerWidth/2, cy = innerHeight/2;
  banner.innerHTML = 'Katso <b>vihreää palloa</b> 2 sekuntia (älä klikkaa)';
  const valDot = document.createElement('div');
  valDot.className = 'dot done';
  valDot.style.left = cx + 'px'; valDot.style.top = cy + 'px';
  document.body.appendChild(valDot);
  await new Promise(r => setTimeout(r, 500));

  const samples = [];
  const tEnd = performance.now() + 2000;
  while (performance.now() < tEnd) {
    const pred = await webgazer.getCurrentPrediction();
    if (pred) samples.push([pred.x, pred.y]);
    await new Promise(r => setTimeout(r, 50));
  }
  valDot.remove();

  let avgErr = NaN;
  if (samples.length > 5) {
    let sum = 0;
    for (const [x,y] of samples) sum += Math.hypot(x - cx, y - cy);
    avgErr = sum / samples.length;
  }

  const quality = isFinite(avgErr)
    ? (avgErr < 80 ? '✓ hyvä' : avgErr < 160 ? '~ ok' : '× heikko')
    : '?';
  banner.innerHTML = `Tallennettu — keskivirhe ±${isFinite(avgErr)?avgErr.toFixed(0):'?'}px (${quality}). Sulkeutuu…`;
  setTimeout(() => window.close(), 2200);
})();
