const channelIdsEl  = document.getElementById('channelIds');
const codePatternEl = document.getElementById('codePattern');
const watchUserIdEl = document.getElementById('watchUserId');
const watchNamesEl  = document.getElementById('watchNames');
const watchAllEl    = document.getElementById('watchAll');
const dot           = document.getElementById('dot');
const statusLabel   = document.getElementById('statusLabel');

const DEFAULT_NAMES = ['leothetiger', 'leo', 'LeoTheTiger'];

function listToText(value) {
  const arr = Array.isArray(value) ? value : String(value || '').split(',');
  return arr.map((s) => String(s).trim()).filter(Boolean).join(', ');
}
function textToList(text) {
  return String(text || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

chrome.storage.local.get(
  ['channelIds', 'channelId', 'codePattern', 'watchUserId', 'watchNames', 'watchAll', 'watcherStatus'],
  (s) => {
    // Prefer the new list; fall back to the legacy single-channel key.
    channelIdsEl.value  = listToText(s.channelIds != null ? s.channelIds : s.channelId);
    codePatternEl.value = s.codePattern || '';
    watchUserIdEl.value = s.watchUserId || '';
    watchNamesEl.value  = listToText(s.watchNames != null ? s.watchNames : DEFAULT_NAMES);
    watchAllEl.checked  = !!s.watchAll;
    updateStatus(s.watcherStatus);
  }
);

channelIdsEl.addEventListener('input', save);
codePatternEl.addEventListener('input', save);
watchUserIdEl.addEventListener('input', save);
watchNamesEl.addEventListener('input', save);
watchAllEl.addEventListener('change', save);

function save() {
  const names = textToList(watchNamesEl.value);
  chrome.storage.local.set({
    channelIds: textToList(channelIdsEl.value),
    codePattern: codePatternEl.value.trim() || 'LBOX-[A-Z0-9]{18}',
    watchUserId: watchUserIdEl.value.trim(),
    watchNames: names.length ? names : DEFAULT_NAMES,
    watchAll: watchAllEl.checked,
  });
}

function updateStatus(status) {
  const connected = status === 'connected';
  dot.className = 'dot ' + (connected ? 'connected' : 'disconnected');
  statusLabel.textContent = 'Bridge: ' + (connected ? 'connected' : 'disconnected');
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.watcherStatus) {
    updateStatus(changes.watcherStatus.newValue);
  }
});
