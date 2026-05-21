(() => {
  const INPUT_SEL = 'input.secret-redeem__input';
  const BUTTON_SEL = 'button.secret-redeem__btn';
  const MAX_LOG = 200;

  let running = false;
  let abort = false;
  let pendingQueue = [];
  let pendingDelayMs = 5000;

  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

  async function appendLog(line) {
    const { log = [] } = await chrome.storage.local.get('log');
    const next = [...log, `[${new Date().toLocaleTimeString()}] ${line}`].slice(-MAX_LOG);
    await chrome.storage.local.set({ log: next });
  }

  async function setProgress(text) {
    await chrome.storage.local.set({ progress: text });
  }

  function findInput() {
    return document.querySelector(INPUT_SEL);
  }

  function findButton() {
    return document.querySelector(BUTTON_SEL);
  }

  // Angular reactive forms hook into the native value setter.
  // Setting .value directly bypasses Angular; we must use the prototype setter
  // and dispatch an 'input' event so ngModel/formControl picks up the change.
  function setNativeValue(el, value) {
    const proto = Object.getPrototypeOf(el);
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) {
      setter.call(el, value);
    } else {
      el.value = value;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  async function waitForElement(selector, timeoutMs = 5000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const el = document.querySelector(selector);
      if (el) return el;
      await sleep(100);
    }
    return null;
  }

  async function processCode(code) {
    const input = await waitForElement(INPUT_SEL, 3000);
    const button = await waitForElement(BUTTON_SEL, 3000);
    if (!input || !button) {
      await appendLog(`✗ ${code} — input/button not found`);
      return;
    }
    input.focus();
    setNativeValue(input, code);
    await sleep(80);
    input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }));
    button.click();
    await appendLog(`→ Sent ${code}`);
  }

  async function run(codes, delayMs) {
    if (running) return;
    running = true;
    abort = false;
    await setProgress(`Running 0/${codes.length}`);
    for (let i = 0; i < codes.length; i++) {
      if (abort) {
        await appendLog('■ Stopped by user');
        break;
      }
      const code = codes[i];
      await setProgress(`Running ${i + 1}/${codes.length}: ${code}`);
      try {
        await processCode(code);
      } catch (e) {
        await appendLog(`✗ ${code} — ${e?.message || e}`);
      }
      if (i < codes.length - 1 && !abort) {
        const jitter = Math.floor(Math.random() * 1001) - 500;
        await sleep(Math.max(100, delayMs + jitter));
      }
    }
    running = false;
    await setProgress(abort ? 'Stopped' : 'Done');
    if (!abort && pendingQueue.length > 0) flushPending();
  }

  function queueCodes(codes, delayMs) {
    pendingDelayMs = delayMs;
    for (const code of codes) {
      if (!pendingQueue.includes(code)) pendingQueue.push(code);
    }
    if (!running) flushPending();
  }

  function flushPending() {
    if (pendingQueue.length === 0 || running) return;
    const batch = pendingQueue.splice(0);
    run(batch, pendingDelayMs);
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'START') {
      run(msg.codes, msg.delayMs);
      sendResponse({ ok: true });
    } else if (msg?.type === 'STOP') {
      abort = true;
      pendingQueue = [];
      sendResponse({ ok: true });
    }
    return true;
  });

  // Receive codes from background via storage instead of sendMessage
  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== 'local' || !changes.bridgeQueue) return;
    const codes = changes.bridgeQueue.newValue;
    if (!Array.isArray(codes) || codes.length === 0) return;
    const { delayMs = 5000 } = await chrome.storage.local.get('delayMs');
    await chrome.storage.local.set({ bridgeQueue: [] });
    queueCodes(codes, delayMs);
  });
})();
