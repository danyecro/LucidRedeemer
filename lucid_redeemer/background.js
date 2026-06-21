// Service-worker side of the redeemer extension.
//
// The actual WebSocket lives in an offscreen document (offscreen.js) so it
// survives MV3 service-worker eviction. This SW just orchestrates:
//   - ensures the offscreen document exists
//   - watches storage for config changes and pushes them to offscreen
//   - receives STATUS/CODES messages back from offscreen and writes them
//     into chrome.storage so content.js + popup can react

const OFFSCREEN_PATH = 'offscreen.html';

// Token-loss-tolerance: even an empty alarm handler keeps the SW responsive
// to chrome.* events and ensures we re-check the offscreen doc periodically.
chrome.alarms.create('keepalive', { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener(() => {
  // No-op: just having a registered handler is enough to wake the SW.
});

async function ensureOffscreen() {
  // chrome.offscreen.hasDocument() is available in Chrome 116+. Fall back to
  // try/catch on createDocument for older versions (createDocument throws if
  // a document already exists).
  if (chrome.offscreen.hasDocument) {
    try {
      if (await chrome.offscreen.hasDocument()) return;
    } catch (_) {}
  }
  try {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_PATH,
      reasons: ['WORKERS'],
      justification: 'Persistent WebSocket connection to the Lucid bridge relay',
    });
  } catch (e) {
    // Likely "already exists" — safe to ignore. Other errors we'll see in
    // the SW console.
    if (!/already/i.test(String(e && e.message))) {
      console.warn('[bg] createDocument failed:', e && e.message);
    }
  }
}

async function readConfig() {
  return chrome.storage.local.get(['mode', 'serverUrl', 'authToken', 'connectionLocked']);
}

async function sendConfigToOffscreen() {
  await ensureOffscreen();
  const cfg = await readConfig();
  try {
    chrome.runtime.sendMessage({ target: 'offscreen', type: 'CONFIG', cfg });
  } catch (e) {
    // Can fail if offscreen isn't ready yet — it will emit READY when it is.
  }
}

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
  console.log('[bg] queued', codes.length, 'code(s) from offscreen');
}

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.from !== 'offscreen') return;
  if (msg.type === 'STATUS') {
    setStatus(msg.status);
  } else if (msg.type === 'CODES') {
    appendCodes(msg.codes || []);
  } else if (msg.type === 'LOG') {
    console.log(msg.line);
  } else if (msg.type === 'READY') {
    // Offscreen just (re)started — push current config so it can connect.
    sendConfigToOffscreen();
  }
});

// React to the user changing connection settings from the popup.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.mode || changes.serverUrl || changes.authToken || changes.connectionLocked) {
    sendConfigToOffscreen();
  }
});

// Boot path: SW first start AND every SW restart (eviction recovery).
(async () => {
  await ensureOffscreen();
  await sendConfigToOffscreen();
})();
