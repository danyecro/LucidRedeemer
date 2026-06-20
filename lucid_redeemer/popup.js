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

// Relay-server mode UI
const modeServerBtn       = document.getElementById('modeServerBtn');
const modeLocalBtn        = document.getElementById('modeLocalBtn');
const serverSection       = document.getElementById('serverSection');
const localSection        = document.getElementById('localSection');
const serverLoginForm     = document.getElementById('serverLoginForm');
const serverConnectedView = document.getElementById('serverConnectedView');
const serverUrlEl         = document.getElementById('serverUrl');
const authTokenEl         = document.getElementById('authToken');
const lockedServerEl      = document.getElementById('lockedServer');
const connectBtn          = document.getElementById('connectBtn');
const removeBtn           = document.getElementById('removeBtn');

const bridgeDot   = document.getElementById('bridgeDot');
const bridgeLabel = document.getElementById('bridgeLabel');

const state = { mode: 'server', connectionLocked: false };

async function loadState() {
  const s = await chrome.storage.local.get([
    'codesText', 'delayMs', 'randomize', 'log', 'progress',
    'autoRelogin', 'lucidEmail', 'lucidPassword',
    'mode', 'serverUrl', 'authToken', 'connectionLocked',
    'bridgeStatus',
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

  state.mode             = s.mode || 'server';
  state.connectionLocked = !!s.connectionLocked;
  serverUrlEl.value      = s.serverUrl || '';
  authTokenEl.value      = s.authToken || '';
  lockedServerEl.textContent = s.serverUrl || '';

  renderMode();
  updateBridgeUI(s.bridgeStatus);
}

function renderMode() {
  const isServer = state.mode === 'server';
  modeServerBtn.classList.toggle('active', isServer);
  modeLocalBtn.classList.toggle('active', !isServer);
  serverSection.style.display = isServer ? '' : 'none';
  localSection.style.display  = isServer ? 'none' : '';
  serverLoginForm.style.display     = state.connectionLocked ? 'none' : '';
  serverConnectedView.style.display = state.connectionLocked ? '' : 'none';
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

// ---- mode switch ----
modeServerBtn.addEventListener('click', () => {
  state.mode = 'server';
  chrome.storage.local.set({ mode: 'server' });
  renderMode();
});
modeLocalBtn.addEventListener('click', () => {
  state.mode = 'local';
  chrome.storage.local.set({ mode: 'local' });
  renderMode();
});

// ---- relay connect / remove ----
connectBtn.addEventListener('click', () => {
  const url   = serverUrlEl.value.trim();
  const token = authTokenEl.value.trim();
  if (!url || !token) {
    progressEl.textContent = 'Server URL and auth code are required';
    return;
  }
  state.connectionLocked = true;
  lockedServerEl.textContent = url;
  chrome.storage.local.set({
    serverUrl: url,
    authToken: token,
    connectionLocked: true,
  });
  renderMode();
});

removeBtn.addEventListener('click', () => {
  state.connectionLocked = false;
  chrome.storage.local.set({ connectionLocked: false });
  renderMode();
});

// ---- queue controls (work in any mode) ----
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

// ---- bridge status indicator ----
function updateBridgeUI(status) {
  const labels = {
    connected: 'connected',
    disconnected: 'disconnected',
    unconfigured: 'not configured',
    idle: '—',
  };
  bridgeDot.className = 'bridge-dot ' + (status || 'disconnected');
  bridgeLabel.textContent = 'Bridge: ' + (labels[status] || '—');
}

// ---- live storage updates ----
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.log) {
    statusEl.textContent = (changes.log.newValue || []).join('\n');
    statusEl.scrollTop = statusEl.scrollHeight;
  }
  if (changes.progress) {
    progressEl.textContent = changes.progress.newValue || '';
  }
  if (changes.bridgeStatus) {
    updateBridgeUI(changes.bridgeStatus.newValue);
  }
});

loadState();
