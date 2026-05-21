const PORT = 3847;
let ws = null;

chrome.alarms.create('keepalive', { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener(() => {});

function updateStatus(status) {
  chrome.storage.local.set({ bridgeStatus: status });
}

async function forwardCodes(codes) {
  const { delayMs = 5000 } = await chrome.storage.local.get('delayMs');

  const allTabs = await chrome.tabs.query({});
  const tab = allTabs.find(t => /lucidtrading\.com/.test(t.url || ''));

  if (!tab) {
    console.log('[Bridge] No lucidtrading.com tab found — queuing for later');
    await chrome.storage.local.set({ bridgeQueue: codes });
    return;
  }

  // Primary: sendMessage to content script
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'QUEUE_CODES', codes, delayMs });
    console.log('[Bridge] Codes sent to content script via sendMessage');
    await chrome.storage.local.set({ bridgeQueue: [] });
    return;
  } catch (e) {
    console.warn('[Bridge] sendMessage failed:', e.message, '— trying storage fallback');
  }

  // Fallback: write to storage (content script storage listener picks it up)
  await chrome.storage.local.set({ bridgeQueue: codes });
}

// Flush storage queue when a lucidtrading.com tab loads
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete' || !/lucidtrading\.com/.test(tab.url || '')) return;
  const { bridgeQueue = [] } = await chrome.storage.local.get('bridgeQueue');
  if (bridgeQueue.length === 0) return;
  const { delayMs = 5000 } = await chrome.storage.local.get('delayMs');
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'QUEUE_CODES', codes: bridgeQueue, delayMs });
    await chrome.storage.local.set({ bridgeQueue: [] });
    console.log('[Bridge] Flushed queued codes to freshly loaded tab');
  } catch (_) {}
});

function connect() {
  ws = new WebSocket(`ws://localhost:${PORT}`);

  ws.onopen = () => {
    console.log('[Bridge] Connected to bridge server');
    updateStatus('connected');
  };

  ws.onmessage = async (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === 'CODES' && Array.isArray(msg.codes) && msg.codes.length > 0) {
        console.log('[Bridge] Received', msg.codes.length, 'codes:', msg.codes);
        await forwardCodes(msg.codes);
      }
    } catch (e) {
      console.error('[Bridge] onmessage error:', e);
    }
  };

  ws.onclose = () => {
    updateStatus('disconnected');
    setTimeout(connect, 3000);
  };

  ws.onerror = (e) => {
    console.error('[Bridge] WS error:', e);
    ws.close();
  };
}

connect();
