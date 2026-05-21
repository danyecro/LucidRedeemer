const codesEl = document.getElementById('codes');
const delayEl = document.getElementById('delay');
const randomizeEl = document.getElementById('randomize');
const startBtn = document.getElementById('start');
const stopBtn = document.getElementById('stop');
const statusEl = document.getElementById('status');
const progressEl = document.getElementById('progress');

async function loadState() {
  const { codesText = '', delayMs = 5000, randomize = false, log = [], progress = 'Idle' } =
    await chrome.storage.local.get(['codesText', 'delayMs', 'randomize', 'log', 'progress']);
  codesEl.value = codesText;
  delayEl.value = delayMs;
  randomizeEl.checked = randomize;
  statusEl.textContent = log.join('\n');
  progressEl.textContent = progress;
  statusEl.scrollTop = statusEl.scrollHeight;
}

async function saveInputs() {
  await chrome.storage.local.set({
    codesText: codesEl.value,
    delayMs: parseInt(delayEl.value, 10) || 5000,
    randomize: randomizeEl.checked,
  });
}

codesEl.addEventListener('input', saveInputs);
delayEl.addEventListener('input', saveInputs);
randomizeEl.addEventListener('change', saveInputs);

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

startBtn.addEventListener('click', async () => {
  await saveInputs();
  let codes = codesEl.value
    .split('\n')
    .map(c => c.trim())
    .filter(Boolean);
  if (codes.length === 0) {
    progressEl.textContent = 'No codes to send';
    return;
  }
  if (randomizeEl.checked) {
    for (let i = codes.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [codes[i], codes[j]] = [codes[j], codes[i]];
    }
  }
  const delayMs = Math.max(500, parseInt(delayEl.value, 10) || 5000);
  await chrome.storage.local.set({ log: [], progress: 'Starting…' });
  statusEl.textContent = '';
  progressEl.textContent = 'Starting…';

  const tab = await getActiveTab();
  if (!tab || !/lucidtrading\.com/.test(tab.url || '')) {
    progressEl.textContent = 'Open a lucidtrading.com tab first';
    return;
  }
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'START', codes, delayMs });
  } catch (e) {
    progressEl.textContent = 'Could not reach page. Reload the tab.';
  }
});

stopBtn.addEventListener('click', async () => {
  const tab = await getActiveTab();
  if (tab) {
    try { await chrome.tabs.sendMessage(tab.id, { type: 'STOP' }); } catch (e) {}
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.log) {
    statusEl.textContent = (changes.log.newValue || []).join('\n');
    statusEl.scrollTop = statusEl.scrollHeight;
  }
  if (changes.progress) {
    progressEl.textContent = changes.progress.newValue || '';
  }
});

const bridgeDot = document.getElementById('bridgeDot');
const bridgeLabel = document.getElementById('bridgeLabel');

function updateBridgeUI(status) {
  const connected = status === 'connected';
  bridgeDot.className = 'bridge-dot ' + (connected ? 'connected' : 'disconnected');
  bridgeLabel.textContent = 'Discord Bridge: ' + (connected ? 'verbunden' : 'getrennt');
}

chrome.storage.local.get('bridgeStatus', ({ bridgeStatus }) => updateBridgeUI(bridgeStatus));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.bridgeStatus) {
    updateBridgeUI(changes.bridgeStatus.newValue);
  }
});

loadState();
