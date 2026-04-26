const $ = id => document.getElementById(id);

function refresh() {
  chrome.runtime.sendMessage({ type: 'engine:state' }, (s) => {
    if (chrome.runtime.lastError || !s) {
      $('status').textContent = 'Pysähdyksissä';
      return;
    }
    const lines = [];
    if (s.error) lines.push(`<span style="color:#ff6b6b">⚠ ${s.error}</span>`);
    lines.push(`HR: ${s.bpm ? s.bpm.toFixed(0) + ' bpm' : '—'}`);
    lines.push(`SNR: ${typeof s.snr === 'number' ? s.snr.toFixed(1) + ' dB' : '—'}`);
    lines.push(`FPS: ${typeof s.fps === 'number' ? s.fps.toFixed(1) : '—'}`);
    lines.push(`Kasvot: ${s.face ? '✓' : '×'}`);
    lines.push(`Katse: ${s.gaze ? `${s.gaze.x.toFixed(0)}, ${s.gaze.y.toFixed(0)}` : '—'}`);
    $('status').innerHTML = lines.join('<br>');
  });
}

$('start').onclick = () => {
  // Avaa lupa-välilehti — popup on huono konteksti getUserMedialle
  // (Chrome ei aina näytä prompttia popupissa, ja deny on pysyvä).
  chrome.tabs.create({ url: chrome.runtime.getURL('permission.html') });
  window.close();
};
$('cal').onclick   = () => chrome.runtime.sendMessage({ type: 'engine:calibrate' });
$('stop').onclick  = () => chrome.runtime.sendMessage({ type: 'engine:stop' }, refresh);
$('lecture').onclick  = () => { chrome.tabs.create({ url: chrome.runtime.getURL('lecture.html') }); window.close(); };
$('sessions').onclick = () => { chrome.tabs.create({ url: chrome.runtime.getURL('sessions.html') }); window.close(); };

refresh();
setInterval(refresh, 1000);
