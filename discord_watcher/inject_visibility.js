// Runs in the PAGE (MAIN) world at document_start so Discord itself always
// believes this tab is visible/focused. We watch several channels in several
// tabs and only one is focused at a time — without this Discord throttles
// rendering of the unfocused tabs and the watcher misses messages.
(() => {
  try {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    Object.defineProperty(document, 'webkitVisibilityState', { configurable: true, get: () => 'visible' });
    document.hasFocus = () => true;
    window.addEventListener('visibilitychange', (e) => e.stopImmediatePropagation(), true);
    window.addEventListener('blur', (e) => e.stopImmediatePropagation(), true);
  } catch (_) {}
})();
