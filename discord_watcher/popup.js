const channelIdEl = document.getElementById('channelId');
const codePatternEl = document.getElementById('codePattern');
const watchUserEl = document.getElementById('watchUser');
const watchAllEl = document.getElementById('watchAll');
const dot = document.getElementById('dot');
const statusLabel = document.getElementById('statusLabel');

chrome.storage.local.get(
  ['channelId', 'codePattern', 'watchUser', 'watchAll', 'watcherStatus'],
  ({ channelId = '', codePattern = '', watchUser = 'leothetiger', watchAll = false, watcherStatus }) => {
    channelIdEl.value = channelId;
    codePatternEl.value = codePattern;
    watchUserEl.value = watchUser;
    watchAllEl.checked = watchAll;
    updateStatus(watcherStatus);
  }
);

channelIdEl.addEventListener('input', save);
codePatternEl.addEventListener('input', save);
watchUserEl.addEventListener('input', save);
watchAllEl.addEventListener('change', save);

function save() {
  chrome.storage.local.set({
    channelId: channelIdEl.value.trim(),
    codePattern: codePatternEl.value.trim() || 'LBOX-[A-Z0-9]{18}',
    watchUser: watchUserEl.value.trim() || 'leothetiger',
    watchAll: watchAllEl.checked,
  });
}

function updateStatus(status) {
  const connected = status === 'connected';
  dot.className = 'dot ' + (connected ? 'connected' : 'disconnected');
  statusLabel.textContent = 'Bridge: ' + (connected ? 'verbunden' : 'getrennt');
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.watcherStatus) {
    updateStatus(changes.watcherStatus.newValue);
  }
});
