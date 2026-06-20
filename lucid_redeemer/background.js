// Connects to a remote relay (wss://…?token=…) configured from the popup,
// receives CODES messages, and appends them to bridgeQueue for the content
// script to redeem on dash.lucidtrading.com.
//
// Legacy: if mode === 'local', we keep the old behaviour of connecting to
// ws://localhost:3847 (used when running the bridge on the same machine).

let ws = null;
let reconnectTimer = null;

chrome.alarms.create('keepalive', { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener(() => {});

function setStatus(s) {
  chrome.storage.local.set({ bridgeStatus: s });
}

async function appendCodes(codes) {
  const { bridgeQueue = [], receivedCodes = [] } =
    await chrome.storage.local.get(['bridgeQueue', 'receivedCodes']);
  const queue = bridgeQueue.slice();
  for (const c of codes) if (!queue.includes(c)) queue.push(c);
  const received = [...receivedCodes, ...codes].slice(-200);
  await chrome.storage.local.set({ bridgeQueue: queue, receivedCodes: received });
  console.log('[Bridge] received', codes.length, 'code(s)');
}

function openWs(url, onOpen, onClose) {
  try {
    ws = new WebSocket(url);
  } catch (_) {
    setStatus('disconnected');
    reconnectTimer = setTimeout(connect, 3000);
    return;
  }
  ws.onopen = onOpen;
  ws.onmessage = async (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === 'CODES' && Array.isArray(msg.codes) && msg.codes.length) {
        await appendCodes(msg.codes);
      }
      // HELLO and others are accepted but ignored.
    } catch (e) {
      console.error('[Bridge] message error:', e);
    }
  };
  ws.onclose = () => {
    setStatus('disconnected');
    if (onClose) onClose();
    reconnectTimer = setTimeout(connect, 3000);
  };
  ws.onerror = () => {
    try { ws.close(); } catch (_) {}
  };
}

async function connect() {
  clearTimeout(reconnectTimer);
  try { ws && ws.close(); } catch (_) {}
  ws = null;

  const s = await chrome.storage.local.get([
    'mode', 'serverUrl', 'authToken', 'connectionLocked',
  ]);
  const mode = s.mode || 'server';

  if (mode === 'local') {
    // Backwards-compatible single-machine setup.
    openWs('ws://localhost:3847', () => {
      console.log('[Bridge] connected (local)');
      setStatus('connected');
    });
    return;
  }

  // mode === 'server' — only connect when the user has locked in a config.
  if (!s.connectionLocked || !s.serverUrl || !s.authToken) {
    setStatus('unconfigured');
    return;
  }

  let url;
  try {
    url = new URL(String(s.serverUrl).trim());
    url.searchParams.set('token', String(s.authToken).trim());
  } catch (_) {
    setStatus('unconfigured');
    return;
  }

  openWs(url.toString(), () => {
    console.log('[Bridge] connected (relay)');
    setStatus('connected');
  });
}

// Reconnect whenever the user changes mode or relay settings.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.mode || changes.serverUrl || changes.authToken || changes.connectionLocked) {
    connect();
  }
});

connect();
