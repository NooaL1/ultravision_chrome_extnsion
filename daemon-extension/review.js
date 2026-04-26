// Review page: load session, render audio + transcript + biometric timeline,
// click-to-seek, highlight focus dips.

import { getSession } from './idb.js';

const $ = id => document.getElementById(id);
const audio = $('audio');
const transcriptEl = $('transcript');
const bigtl = $('bigtl'), bctx = bigtl.getContext('2d');
const emostrip = $('emostrip'), ectx = emostrip.getContext('2d');
const dipsEl = $('dips');

const id = new URLSearchParams(location.search).get('id');
if (!id) { document.body.innerHTML = '<p style="padding:40px">Ei istunnon ID:tä</p>'; }

const sess = await getSession(id);
if (!sess) { document.body.innerHTML = '<p style="padding:40px">Istuntoa ei löytynyt</p>'; throw new Error('not found'); }

const url = URL.createObjectURL(sess.audioBlob);
audio.src = url;

document.title = sess.title || 'Istunto';
$('title').textContent = sess.title || 'Istunto';
$('m-dur').textContent = fmtTime(sess.durationMs / 1000);

const bio = sess.bio || [];
const segments = sess.transcript || [];

// stats
const bpms = bio.filter(b => b.bpm).map(b => b.bpm);
$('m-mean-bpm').textContent = bpms.length ? Math.round(bpms.reduce((a,b)=>a+b,0)/bpms.length) : '—';
const focuses = bio.map(b => b.focus || 0);
$('m-mean-focus').textContent = focuses.length ? Math.round(focuses.reduce((a,b)=>a+b,0)/focuses.length * 100) : '—';

// dip detection: continuous spans where focus < 0.35 for >= 6s
const dips = detectDips(bio, 0.35, 6);
$('m-dips').textContent = dips.length;

// Render dips list
if (dips.length === 0) {
  dipsEl.innerHTML = '<div class="empty">Ei merkittäviä focus-pudotuksia. Hyvin pysyit mukana 👏</div>';
} else {
  dipsEl.innerHTML = dips.map(d => {
    const text = transcriptAt(d.start, d.end).slice(0, 140) + '…';
    return `<div class="dip-card" data-t="${d.start}">
      <div class="dip-time">${fmtTime(d.start)}</div>
      <div class="dip-text">${escapeHtml(text || '(ei puhetta)')}</div>
    </div>`;
  }).join('');
  dipsEl.querySelectorAll('.dip-card').forEach(c => {
    c.onclick = () => seek(parseFloat(c.dataset.t));
  });
}

// transcript clickable
if (segments.length === 0) {
  transcriptEl.innerHTML = '<div class="hint" style="opacity:.4">Ei transkriptiota tälle istunnolle.</div>';
} else {
  transcriptEl.innerHTML = segments.map((s, i) => {
    const bp = nearestBio(s.start);
    const dipCls = bp && bp.focus < 0.35 ? 'dip' : (bp && bp.focus > 0.7 ? 'high' : '');
    return `<span class="seg ${dipCls}" data-i="${i}" data-start="${s.start}">
      <span class="ts">${fmtTime(s.start)}</span>${escapeHtml(s.text)}
    </span> `;
  }).join('');
  transcriptEl.querySelectorAll('.seg').forEach(el => {
    el.onclick = () => seek(parseFloat(el.dataset.start));
  });
}

function seek(t) {
  audio.currentTime = t;
  audio.play();
}

audio.ontimeupdate = () => {
  drawBig();
  highlightActive();
};

bigtl.onclick = (e) => {
  const r = bigtl.getBoundingClientRect();
  const x = (e.clientX - r.left) / r.width;
  const t = x * (sess.durationMs / 1000);
  seek(t);
};

drawBig();
drawEmoStrip();

function highlightActive() {
  const t = audio.currentTime;
  let active = null;
  let bestDist = Infinity;
  for (const el of transcriptEl.querySelectorAll('.seg')) {
    const s = parseFloat(el.dataset.start);
    const d = Math.abs(s - t);
    if (s <= t && d < bestDist) { bestDist = d; active = el; }
    el.classList.remove('active');
  }
  if (active) active.classList.add('active');
}

function drawBig() {
  const W = bigtl.width, H = bigtl.height;
  bctx.clearRect(0, 0, W, H);
  if (bio.length < 2) return;
  const dur = sess.durationMs / 1000;

  // dip backgrounds
  bctx.fillStyle = 'rgba(255,200,80,.18)';
  for (const d of dips) {
    const x1 = (d.start / dur) * W;
    const x2 = (d.end / dur) * W;
    bctx.fillRect(x1, 0, Math.max(2, x2 - x1), H);
  }

  // mid divider
  bctx.strokeStyle = 'rgba(255,255,255,.08)';
  bctx.beginPath(); bctx.moveTo(0, H/2); bctx.lineTo(W, H/2); bctx.stroke();

  // BPM (top half)
  const bpmsArr = bio.filter(b => b.bpm).map(b => b.bpm);
  if (bpmsArr.length > 1) {
    let mn = Math.min(...bpmsArr), mx = Math.max(...bpmsArr);
    if (mx - mn < 6) { mn = (mn+mx)/2 - 3; mx = mn + 6; }
    bctx.strokeStyle = '#ff4d6d'; bctx.lineWidth = 1.6;
    bctx.shadowColor = '#ff4d6d'; bctx.shadowBlur = 4;
    bctx.beginPath();
    let first = true;
    for (const b of bio) {
      if (!b.bpm) continue;
      const x = (b.t / dur) * W;
      const y = H/2 - ((b.bpm - mn) / (mx - mn)) * (H/2 - 8) - 6;
      if (first) { bctx.moveTo(x, y); first = false; } else bctx.lineTo(x, y);
    }
    bctx.stroke(); bctx.shadowBlur = 0;
    bctx.fillStyle = 'rgba(255,255,255,.4)';
    bctx.font = '10px monospace';
    bctx.fillText(`${mx.toFixed(0)}`, 4, 12);
    bctx.fillText(`${mn.toFixed(0)}`, 4, H/2 - 4);
  }

  // Focus (bottom half)
  bctx.strokeStyle = '#51cf66'; bctx.lineWidth = 1.6;
  bctx.shadowColor = '#51cf66'; bctx.shadowBlur = 4;
  bctx.beginPath();
  for (let i = 0; i < bio.length; i++) {
    const b = bio[i];
    const x = (b.t / dur) * W;
    const y = H - (b.focus || 0) * (H/2 - 8) - 6;
    if (i === 0) bctx.moveTo(x, y); else bctx.lineTo(x, y);
  }
  bctx.stroke(); bctx.shadowBlur = 0;

  // playback cursor
  const cx = (audio.currentTime / dur) * W;
  bctx.strokeStyle = '#fff'; bctx.lineWidth = 1;
  bctx.beginPath(); bctx.moveTo(cx, 0); bctx.lineTo(cx, H); bctx.stroke();
}

const EMO_COLORS = {
  happy:'#51cf66', sad:'#5c9eff', surprised:'#ffc850', angry:'#ff4d6d',
  disgusted:'#a78bfa', focused:'#22b8cf', tired:'#888', neutral:'rgba(255,255,255,.1)'
};
function drawEmoStrip() {
  const W = emostrip.width, H = emostrip.height;
  ectx.clearRect(0, 0, W, H);
  const dur = sess.durationMs / 1000;
  if (bio.length < 1) return;
  const bw = Math.max(2, W / bio.length);
  for (const b of bio) {
    const x = (b.t / dur) * W;
    const c = EMO_COLORS[b.emotion] || '#666';
    const h = Math.max(4, (b.emoScore || 0) * H);
    ectx.fillStyle = c;
    ectx.fillRect(x, H - h, bw, h);
  }
}

function detectDips(bio, threshold, minSec) {
  const dips = [];
  let inDip = false, start = 0;
  for (let i = 0; i < bio.length; i++) {
    const b = bio[i];
    if (b.focus < threshold && !inDip) { inDip = true; start = b.t; }
    else if (b.focus >= threshold && inDip) {
      const end = b.t;
      if (end - start >= minSec) dips.push({ start, end });
      inDip = false;
    }
  }
  if (inDip && bio.length) {
    const end = bio[bio.length-1].t;
    if (end - start >= minSec) dips.push({ start, end });
  }
  return dips;
}

function transcriptAt(t1, t2) {
  return segments
    .filter(s => s.end >= t1 && s.start <= t2)
    .map(s => s.text).join(' ');
}

function nearestBio(t) {
  if (!bio.length) return null;
  let best = bio[0], bd = Math.abs(bio[0].t - t);
  for (const b of bio) { const d = Math.abs(b.t - t); if (d < bd) { bd = d; best = b; } }
  return best;
}

function fmtTime(s) {
  if (!isFinite(s)) return '—';
  const m = Math.floor(s/60), ss = Math.floor(s%60);
  return `${m}:${String(ss).padStart(2,'0')}`;
}
function escapeHtml(s) {
  return (s || '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
