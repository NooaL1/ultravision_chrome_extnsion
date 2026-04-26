// Service worker — orchestrates offscreen + relays messages to all tabs.

const OFFSCREEN_URL = 'offscreen.html';

async function ensureOffscreen() {
  if (chrome.offscreen.hasDocument) {
    if (await chrome.offscreen.hasDocument()) return;
  }
  try {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ['USER_MEDIA'],
      justification: 'Webcam access for heart rate (rPPG) and gaze estimation.'
    });
  } catch (e) {
    if (!String(e).includes('Only a single offscreen')) console.error(e);
  }
}

async function broadcast(msg) {
  const tabs = await chrome.tabs.query({});
  for (const t of tabs) {
    if (!t.id) continue;
    chrome.tabs.sendMessage(t.id, msg).catch(() => {});
  }
}

let lastTick = { bpm: null, snr: null, gaze: null, face: false, blendshapes: null, emotion: null };

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return false;

  // Async + needs response
  if (msg.type === 'engine:start') {
    (async () => {
      await ensureOffscreen();
      chrome.runtime.sendMessage({ type: 'offscreen:start' }).catch(()=>{});
      sendResponse({ ok: true });
    })();
    return true;
  }
  if (msg.type === 'engine:stop') {
    (async () => {
      try { await chrome.offscreen.closeDocument(); } catch {}
      lastTick = { bpm: null, snr: null, gaze: null, face: false, blendshapes: null, emotion: null };
      broadcast({ type: 'state', running: false });
      sendResponse({ ok: true });
    })();
    return true;
  }
  if (msg.type === 'engine:calibrate') {
    (async () => {
      await ensureOffscreen();
      const w = await chrome.windows.create({
        url: chrome.runtime.getURL('calibrate.html'),
        type: 'popup', state: 'fullscreen'
      });
      sendResponse({ ok: true, windowId: w.id });
    })();
    return true;
  }

  // Sync responses
  if (msg.type === 'engine:state') {
    sendResponse(lastTick);
    return false;
  }

  // Fire-and-forget from offscreen
  if (msg.type === 'tick') {
    Object.assign(lastTick, msg.payload);
    broadcast({ type: 'tick', payload: lastTick });
    return false;
  }
  if (msg.type === 'state') {
    broadcast(msg);
    return false;
  }
  return false;
});

chrome.action.onClicked.addListener(ensureOffscreen);
