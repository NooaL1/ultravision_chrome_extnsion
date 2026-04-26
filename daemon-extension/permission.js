const $ = id => document.getElementById(id);

$('grant').onclick = async () => {
  $('status').textContent = '';
  $('status').className = '';
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    stream.getTracks().forEach(t => t.stop());
    $('status').className = 'ok';
    $('status').textContent = '✓ Lupa myönnetty — käynnistetään…';
    chrome.runtime.sendMessage({ type: 'engine:start' });
    setTimeout(() => window.close(), 1200);
  } catch (e) {
    $('status').className = 'err';
    $('status').innerHTML =
      `⚠ ${e.name}: ${e.message || ''}<br><br>` +
      `Jos olet aiemmin estänyt kameran, mene osoitteeseen ` +
      `<code>chrome://settings/content/camera</code>, poista Daemon estolistalta ja yritä uudelleen.`;
  }
};
