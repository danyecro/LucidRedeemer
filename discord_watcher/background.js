const PORT = 3847;
let ws = null;

chrome.alarms.create('keepalive', { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener(() => {});

function connect() {
  ws = new WebSocket(`ws://localhost:${PORT}`);
  ws.onopen  = () => {
    console.log('[Watcher] Connected to bridge');
    chrome.storage.local.set({ watcherStatus: 'connected' });
  };
  ws.onclose = () => {
    chrome.storage.local.set({ watcherStatus: 'disconnected' });
    setTimeout(connect, 3000);
  };
  ws.onerror = () => ws.close();
}

// Receive codes / images from content script and forward to bridge
chrome.runtime.onMessage.addListener((msg) => {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (msg?.type === 'CODES') {
    console.log('[Watcher] Forwarding', msg.codes.length, 'codes to bridge');
    ws.send(JSON.stringify(msg));
  } else if (msg?.type === 'IMAGE') {
    console.log('[Watcher] Forwarding image to bridge for OCR:', msg.url);
    ws.send(JSON.stringify(msg));
  }
});

connect();
