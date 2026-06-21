// Hosts the persistent WebSocket connection to the bridge relay.
//
// Lives in an offscreen document so it survives MV3 service-worker eviction.
// The service worker (background.js) sends config updates here and receives
// status changes + incoming codes back via runtime messages.

let ws = null;
let reconnectTimer = null;
let currentCfg = null;
let intendedConnect = false;

function statusToSW(s) {
  try { chrome.runtime.sendMessage({ from: 'offscreen', type: 'STATUS', status: s }); } catch (_) {}
}
function codesToSW(codes) {
  try { chrome.runtime.sendMessage({ from: 'offscreen', type: 'CODES', codes }); } catch (_) {}
}
function logToSW(line) {
  try { chrome.runtime.sendMessage({ from: 'offscreen', type: 'LOG', line }); } catch (_) {}
}

function open(url) {
  try {
    ws = new WebSocket(url);
  } catch (e) {
    statusToSW('disconnected');
    logToSW('[offscreen] open threw: ' + (e && e.message));
    reconnectTimer = setTimeout(connect, 3000);
    return;
  }
  ws.onopen = () => {
    logToSW('[offscreen] WS open');
    statusToSW('connected');
  };
  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === 'CODES' && Array.isArray(msg.codes) && msg.codes.length) {
        codesToSW(msg.codes);
      }
      // HELLO and other meta messages: accepted but ignored.
    } catch (e) {
      logToSW('[offscreen] message parse error: ' + (e && e.message));
    }
  };
  ws.onclose = (ev) => {
    logToSW('[offscreen] WS close code=' + ev.code + ' reason=' + (ev.reason || ''));
    statusToSW('disconnected');
    if (intendedConnect) reconnectTimer = setTimeout(connect, 3000);
  };
  ws.onerror = () => {
    try { ws.close(); } catch (_) {}
  };
}

function connect() {
  clearTimeout(reconnectTimer);
  try { ws && ws.close(); } catch (_) {}
  ws = null;

  const cfg = currentCfg || {};
  const mode = cfg.mode || 'server';

  if (mode === 'local') {
    intendedConnect = true;
    open('ws://localhost:3847');
    return;
  }

  if (!cfg.connectionLocked || !cfg.serverUrl || !cfg.authToken) {
    intendedConnect = false;
    statusToSW('unconfigured');
    return;
  }

  let url;
  try {
    url = new URL(String(cfg.serverUrl).trim());
    url.searchParams.set('token', String(cfg.authToken).trim());
  } catch (_) {
    intendedConnect = false;
    statusToSW('unconfigured');
    return;
  }
  intendedConnect = true;
  open(url.toString());
}

// CONFIG arrives from the service worker on startup and whenever any of
// mode/serverUrl/authToken/connectionLocked changes in storage. We only
// (re)connect when the config actually differs, to avoid burning a fresh
// WS handshake on every SW wakeup (which happens often because content.js
// writes to storage every ~2s).
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.target !== 'offscreen') return;
  if (msg.type === 'CONFIG') {
    const nextCfg = msg.cfg || {};
    const same = currentCfg
      && currentCfg.mode === nextCfg.mode
      && currentCfg.serverUrl === nextCfg.serverUrl
      && currentCfg.authToken === nextCfg.authToken
      && currentCfg.connectionLocked === nextCfg.connectionLocked;
    if (same && ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      // Already on the right config and the socket is alive — nothing to do.
      return;
    }
    currentCfg = nextCfg;
    connect();
  } else if (msg.type === 'PING') {
    // Health check from SW; SW can detect a dead offscreen this way later.
    try { chrome.runtime.sendMessage({ from: 'offscreen', type: 'PONG', wsState: ws ? ws.readyState : -1 }); } catch (_) {}
  }
});

// Tell the SW we're alive as soon as the script runs. The SW takes that as
// the signal to push the current config.
try { chrome.runtime.sendMessage({ from: 'offscreen', type: 'READY' }); } catch (_) {}
