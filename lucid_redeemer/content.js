(() => {
  const MAX_LOG = 200;
  const PROMO_URL = 'https://dash.lucidtrading.com/#/promo';

  // Selectors for the Lucid auto-relogin flow (lucidtrading.com/my-account/)
  const SEL = {
    launchDashboard: 'button.lucid-launch-btn',
    signIn: '#lucidLoginBtn',
    rememberMe: 'input[name="rememberme"]',
    promoNav: 'a[routerlink="/promo"], a[href="#/promo"]',
  };

  const cfg = { autoRelogin: false, delayMs: 5000, lucidEmail: '', lucidPassword: '' };

  const RELOGIN_COOLDOWN_MS = 10000;
  const PROMO_GRACE_MS = 15000;
  let processing = false;
  let lastReloginAt = 0;
  const startedAt = Date.now();

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function appendLog(line) {
    const { log = [] } = await chrome.storage.local.get('log');
    const next = [...log, `[${new Date().toLocaleTimeString()}] ${line}`].slice(-MAX_LOG);
    await chrome.storage.local.set({ log: next });
  }
  function setProgress(text) {
    chrome.storage.local.set({ progress: text });
  }

  function setNativeValue(el, value) {
    const proto = Object.getPrototypeOf(el);
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, value); else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  const visible = (el) => !!el && el.offsetParent !== null;

  function byText(re, sel = 'button, [role="button"], a, input[type="submit"]') {
    return [...document.querySelectorAll(sel)].find((el) => {
      if (!visible(el)) return false;
      return re.test((el.textContent || el.value || '').trim());
    }) || null;
  }

  function findRedeemInput() {
    const inputs = [...document.querySelectorAll('input')].filter(visible);
    return inputs.find((i) => {
      const type = (i.type || 'text').toLowerCase();
      if (!['text', 'search', ''].includes(type)) return false;
      const hint = `${i.placeholder || ''} ${i.getAttribute('aria-label') || ''} ${i.name || ''}`.toLowerCase();
      return /key|code|secret|redeem/.test(hint);
    }) || inputs.find((i) => ['text', 'search', ''].includes((i.type || 'text').toLowerCase())) || null;
  }
  function findRedeemButton() {
    return byText(/unlock|redeem|einl[öo]sen|claim/i);
  }

  function findLoginEmail() {
    return document.querySelector(
      'input[type="email"], input[autocomplete="username"], input[name*="email" i], input[name*="user" i]'
    ) || document.querySelector('input[type="text"]');
  }
  function findLoginPassword() {
    return document.querySelector('input[type="password"]');
  }

  function onPromoPage() {
    return /dash\.lucidtrading\.com/.test(location.host) && /#\/promo/.test(location.href);
  }

  function redeemUiPresent() {
    return !!(findRedeemInput() && findRedeemButton());
  }

  async function redeemCode(code) {
    const input = findRedeemInput();
    const button = findRedeemButton();
    if (!input || !button) {
      await appendLog(`✗ ${code} — input/button not found`);
      return false;
    }
    input.focus();
    setNativeValue(input, code);
    await sleep(100);
    input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }));
    button.click();
    await appendLog(`→ ${code}`);
    return true;
  }

  async function processNext() {
    if (processing || !onPromoPage()) return;
    const { bridgeQueue = [] } = await chrome.storage.local.get('bridgeQueue');
    if (bridgeQueue.length === 0) { setProgress('Idle'); return; }

    processing = true;
    const code = bridgeQueue[0];
    setProgress(`Redeeming ${code}  (${bridgeQueue.length} in queue)`);
    try {
      await redeemCode(code);
    } catch (e) {
      await appendLog(`✗ ${code} — ${e?.message || e}`);
    }
    const { bridgeQueue: q = [] } = await chrome.storage.local.get('bridgeQueue');
    await chrome.storage.local.set({ bridgeQueue: q.filter((c) => c !== code) });

    const jitter = Math.floor(Math.random() * 1001) - 500;
    await sleep(Math.max(100, cfg.delayMs + jitter));
    processing = false;
    processNext();
  }

  // Fills and submits the Lucid login form using locally-stored credentials.
  // Chrome's own autofill won't submit without a real user gesture, so we
  // store the credentials ourselves and inject them here.
  function doSignIn() {
    const emailEl = findLoginEmail();
    const passEl = findLoginPassword();
    if (emailEl && cfg.lucidEmail) {
      emailEl.focus();
      setNativeValue(emailEl, cfg.lucidEmail);
    }
    if (passEl && cfg.lucidPassword) {
      passEl.focus();
      setNativeValue(passEl, cfg.lucidPassword);
    }
    const remember = document.querySelector(SEL.rememberMe);
    if (remember && !remember.checked) remember.click();

    setTimeout(() => {
      const btn = document.querySelector(SEL.signIn);
      if (btn) { appendLog('Auto-Relogin: Sign In'); btn.click(); }
    }, 400);
  }

  // State machine: redeem codes on the promo page, otherwise navigate/login.
  // At most one action per RELOGIN_COOLDOWN_MS to prevent tight loops.
  function tick() {
    if (onPromoPage() && redeemUiPresent()) {
      sessionStorage.removeItem('lucidRedeemerReloads');
      sessionStorage.removeItem('lucidRedeemerSignins');
      processNext();
      return;
    }
    if (!cfg.autoRelogin) return;
    if (Date.now() - lastReloginAt < RELOGIN_COOLDOWN_MS) return;

    if (onPromoPage()) {
      if (Date.now() - startedAt < PROMO_GRACE_MS) return;
      const tries = parseInt(sessionStorage.getItem('lucidRedeemerReloads') || '0', 10);
      if (tries < 3) {
        sessionStorage.setItem('lucidRedeemerReloads', String(tries + 1));
        markRelogin();
        appendLog(`Auto-Relogin: reload promo — UI missing (${tries + 1}/3)`);
        location.reload();
      }
      return;
    }

    if (/dash\.lucidtrading\.com/.test(location.host)) {
      markRelogin();
      appendLog('Auto-Relogin: → #/promo');
      location.hash = '#/promo';
      return;
    }

    // On lucidtrading.com (e.g. /my-account): go to the dashboard.
    // Navigate THIS tab instead of clicking the launch button — that button
    // opens the dashboard in a NEW tab, so clicking it on every cooldown
    // spawned an endless pile of dash tabs.
    const launch = document.querySelector(SEL.launchDashboard);
    if (visible(launch)) {
      markRelogin();
      appendLog('Auto-Relogin: → dashboard');
      location.href = PROMO_URL;
      return;
    }
    const signIn = document.querySelector(SEL.signIn);
    if (visible(signIn)) {
      const tries = parseInt(sessionStorage.getItem('lucidRedeemerSignins') || '0', 10);
      if (tries < 3) {
        sessionStorage.setItem('lucidRedeemerSignins', String(tries + 1));
        markRelogin();
        doSignIn();
      } else if (tries === 3) {
        sessionStorage.setItem('lucidRedeemerSignins', '4');
        appendLog('Auto-Relogin: Sign In failed — please log in manually once.');
      }
    }
  }

  // The cooldown timestamp is persisted so it survives cross-origin navigation
  // (lucidtrading.com ↔ dash.lucidtrading.com). Without this the in-memory
  // value resets on every page load and the relogin could loop fast.
  function markRelogin() {
    lastReloginAt = Date.now();
    chrome.storage.local.set({ reloginLastAt: lastReloginAt });
  }

  function loadConfig(done) {
    chrome.storage.local.get(
      ['autoRelogin', 'delayMs', 'lucidEmail', 'lucidPassword', 'reloginLastAt'],
      (s) => {
        cfg.autoRelogin = !!s.autoRelogin;
        cfg.delayMs = s.delayMs || 5000;
        cfg.lucidEmail = s.lucidEmail || '';
        cfg.lucidPassword = s.lucidPassword || '';
        if (typeof s.reloginLastAt === 'number' && s.reloginLastAt > lastReloginAt) {
          lastReloginAt = s.reloginLastAt;
        }
        if (done) done();
      }
    );
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    loadConfig();
    if (changes.bridgeQueue) processNext();
  });

  // Run the first tick only after the persisted cooldown has loaded, so a
  // freshly navigated page doesn't immediately act and bypass the throttle.
  loadConfig(() => tick());
  window.addEventListener('hashchange', tick);
  setInterval(tick, 2000);
})();
