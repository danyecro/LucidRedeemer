const codesEl       = document.getElementById('codes');
const delayEl       = document.getElementById('delay');
const randomizeEl   = document.getElementById('randomize');
const startBtn      = document.getElementById('start');
const stopBtn       = document.getElementById('stop');
const statusEl      = document.getElementById('status');
const progressEl    = document.getElementById('progress');
const autoReloginEl = document.getElementById('autoRelogin');
const lucidEmailEl  = document.getElementById('lucidEmail');
const lucidPassEl   = document.getElementById('lucidPassword');

async function loadState() {
  const s = await chrome.storage.local.get([
    'codesText', 'delayMs', 'randomize', 'log', 'progress',
    'autoRelogin', 'lucidEmail', 'lucidPassword',
  ]);
  codesEl.value          = s.codesText || '';
  delayEl.value          = s.delayMs || 5000;
  randomizeEl.checked    = !!s.randomize;
  autoReloginEl.checked  = !!s.autoRelogin;
  lucidEmailEl.value     = s.lucidEmail || '';
  lucidPassEl.value      = s.lucidPassword || '';
  statusEl.textContent   = (s.log || []).join('\n');
  progressEl.textContent = s.progress || 'Idle';
  statusEl.scrollTop     = statusEl.scrollHeight;
}

function saveInputs() {
  chrome.storage.local.set({
    codesText: codesEl.value,
    delayMs:   parseInt(delayEl.value, 10) || 5000,
    randomize: randomizeEl.checked,
  });
}

codesEl.addEventListener('input', saveInputs);
delayEl.addEventListener('input', saveInputs);
randomizeEl.addEventListener('change', saveInputs);

autoReloginEl.addEventListener('change', () => {
  chrome.storage.local.set({ autoRelogin: autoReloginEl.checked });
});
lucidEmailEl.addEventListener('input', () => {
  chrome.storage.local.set({ lucidEmail: lucidEmailEl.value });
});
lucidPassEl.addEventListener('input', () => {
  chrome.storage.local.set({ lucidPassword: lucidPassEl.value });
});

startBtn.addEventListener('click', async () => {
  saveInputs();
  let codes = codesEl.value.split('\n').map((c) => c.trim()).filter(Boolean);
  if (codes.length === 0) {
    progressEl.textContent = 'No codes to queue';
    return;
  }
  if (randomizeEl.checked) {
    for (let i = codes.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [codes[i], codes[j]] = [codes[j], codes[i]];
    }
  }
  const { bridgeQueue = [] } = await chrome.storage.local.get('bridgeQueue');
  const merged = bridgeQueue.slice();
  for (const c of codes) if (!merged.includes(c)) merged.push(c);
  await chrome.storage.local.set({ bridgeQueue: merged });
  progressEl.textContent = `${codes.length} added (queue: ${merged.length})`;
});

stopBtn.addEventListener('click', () => {
  chrome.storage.local.set({ bridgeQueue: [], progress: 'Queue cleared' });
  progressEl.textContent = 'Queue cleared';
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

const bridgeDot   = document.getElementById('bridgeDot');
const bridgeLabel = document.getElementById('bridgeLabel');

function updateBridgeUI(status) {
  const connected = status === 'connected';
  bridgeDot.className = 'bridge-dot ' + (connected ? 'connected' : 'disconnected');
  bridgeLabel.textContent = 'Discord Bridge: ' + (connected ? 'connected' : 'disconnected');
}

chrome.storage.local.get('bridgeStatus', ({ bridgeStatus }) => updateBridgeUI(bridgeStatus));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.bridgeStatus) {
    updateBridgeUI(changes.bridgeStatus.newValue);
  }
});

loadState();
