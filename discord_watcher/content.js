(() => {
  const BUFFER_MS = 500;
  const DEFAULT_NAMES = ['leothetiger', 'leo', 'LeoTheTiger'];

  let codeRegex = /(?:LBOX|LUCID)-[A-Z0-9]{18}/g;
  let watchChannelIds = new Set();
  let watchUserId = '';
  let watchNames = normalizeNames(DEFAULT_NAMES);
  let watchAll = false;
  // Webhook posts often render codes inside <code class="inline"> spans. When
  // on, we read those nodes explicitly in addition to the plain-text regex
  // scan — covers Discord webhook formatting like `LBOX-...` · Source.
  let extractInlineCodes = true;
  let codeBuffer = [];
  let bufferTimer = null;
  const processedImages = new Set();

  // Accepts an array or a comma-separated string; returns a lowercased,
  // trimmed, de-duplicated list of names (with any leading @ stripped).
  function normalizeNames(value) {
    const arr = Array.isArray(value)
      ? value
      : String(value || '').split(',');
    const cleaned = arr
      .map((s) => String(s).toLowerCase().replace(/^@/, '').trim())
      .filter(Boolean);
    return [...new Set(cleaned)];
  }

  // Accepts an array or comma-separated string of channel IDs.
  function normalizeChannels(value) {
    const arr = Array.isArray(value) ? value : String(value || '').split(',');
    return new Set(arr.map((s) => String(s).trim()).filter(Boolean));
  }

  chrome.storage.local.get(
    ['channelIds', 'channelId', 'codePattern', 'watchUserId', 'watchNames', 'watchAll', 'extractInlineCodes'],
    (s) => {
      // Prefer the new list; fall back to the legacy single-channel key.
      watchChannelIds = normalizeChannels(s.channelIds != null ? s.channelIds : s.channelId);
      if (s.codePattern) codeRegex = new RegExp(s.codePattern, 'g');
      watchUserId = String(s.watchUserId || '').trim();
      watchNames = s.watchNames != null ? normalizeNames(s.watchNames) : normalizeNames(DEFAULT_NAMES);
      watchAll = !!s.watchAll;
      if (typeof s.extractInlineCodes === 'boolean') extractInlineCodes = s.extractInlineCodes;
    }
  );
  chrome.storage.onChanged.addListener((c) => {
    if (c.channelIds)  watchChannelIds = normalizeChannels(c.channelIds.newValue);
    else if (c.channelId) watchChannelIds = normalizeChannels(c.channelId.newValue);
    if (c.codePattern) codeRegex = new RegExp(c.codePattern.newValue || '(?:LBOX|LUCID)-[A-Z0-9]{18}', 'g');
    if (c.watchUserId) watchUserId = String(c.watchUserId.newValue || '').trim();
    if (c.watchNames)  watchNames = normalizeNames(c.watchNames.newValue);
    if (c.watchAll)    watchAll = !!c.watchAll.newValue;
    if (c.extractInlineCodes && typeof c.extractInlineCodes.newValue === 'boolean') {
      extractInlineCodes = c.extractInlineCodes.newValue;
    }
  });

  function getCurrentChannelId() {
    const m = location.pathname.match(/\/channels\/\d+\/(\d+)/);
    return m ? m[1] : null;
  }

  // Read the channel id straight from the message element. Discord message
  // <li>s have id "chat-messages-<channelId>-<messageId>". This is far more
  // reliable than the URL — it also works for stage-channel chat overlays and
  // threads, where the URL doesn't reflect the chat you're actually reading.
  function channelIdFromNode(node) {
    const li = (node.closest && node.closest('li[id^="chat-messages-"]'))
      || (node.querySelector && node.querySelector('li[id^="chat-messages-"]'));
    const m = li && (li.id || '').match(/chat-messages-(\d+)-/);
    return m ? m[1] : getCurrentChannelId();
  }

  function matchCodes(text) {
    if (!text) return [];
    codeRegex.lastIndex = 0;
    return text.match(codeRegex) || [];
  }

  // Collect codes from a freshly added DOM node. Always does the plain
  // textContent regex scan; when extractInlineCodes is on, also reads every
  // <code class="inline"> element (Discord renders webhook code-blocks that
  // way, and on some channel layouts textContent alone misses them).
  function extractCodesFromNode(node) {
    const out = new Set();
    for (const c of matchCodes(String(node.textContent || ''))) out.add(c);
    if (extractInlineCodes) {
      if (node.matches && node.matches('code.inline')) {
        for (const c of matchCodes(node.textContent)) out.add(c);
      }
      if (node.querySelectorAll) {
        node.querySelectorAll('code.inline').forEach((el) => {
          for (const c of matchCodes(el.textContent)) out.add(c);
        });
      }
    }
    return [...out];
  }

  // ---- text codes ----
  let bufferChannelId = null;
  function bufferCode(code, channelId) {
    if (channelId) bufferChannelId = channelId;
    if (!codeBuffer.includes(code)) codeBuffer.push(code);
    clearTimeout(bufferTimer);
    bufferTimer = setTimeout(() => {
      const batch = codeBuffer.splice(0);
      for (let i = batch.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [batch[i], batch[j]] = [batch[j], batch[i]];
      }
      const cid = bufferChannelId || getCurrentChannelId();
      console.log('[Watcher] Sending', batch.length, 'text codes from channel', cid, ':', batch);
      chrome.runtime.sendMessage({ type: 'CODES', codes: batch, channelId: cid });
    }, BUFFER_MS);
  }

  // ---- image handling ----
  const AVATAR_SEL = 'img[src*="/avatars/"], img[src*="/users/"]';
  const USERNAME_SEL = '[class*="username"]';

  function idFromAvatar(img) {
    const s = img && (img.src || img.getAttribute('src'));
    if (!s) return null;
    const m = s.match(/\/(?:avatars|users)\/(\d{15,})/);
    return m ? m[1] : null;
  }

  // Robust author resolution that does NOT depend on Discord's obfuscated
  // class names or the `li[id^="chat-messages-"]` structure.
  //
  // Strategy: walk up the ancestor chain from the image. At each ancestor,
  // search its subtree (and its preceding siblings — Discord groups messages
  // so the avatar lives on the first message of a group) for an avatar image.
  // The first avatar with a Discord user-id wins.
  function resolveAuthor(startNode) {
    let el = startNode;
    let hops = 0;
    while (el && el !== document.body && hops < 30) {
      let probe = el;
      let sib = 0;
      while (probe && sib < 15) {
        let av = null;
        if (probe.matches && probe.matches(AVATAR_SEL)) av = probe;
        if (!av && probe.querySelector) av = probe.querySelector(AVATAR_SEL);
        const id = idFromAvatar(av);
        if (id) {
          let nameEl = null;
          if (probe.querySelector) nameEl = probe.querySelector(USERNAME_SEL);
          return { id, name: nameEl ? nameEl.textContent.trim() : null };
        }
        probe = probe.previousElementSibling;
        sib++;
      }
      el = el.parentElement;
      hops++;
    }
    return { id: null, name: null };
  }

  // De-dupe attachments by their /attachments/<channelId>/<msgId>/<filename>
  // path — Discord serves the same image via both <a href="…full-res…"> and
  // <img src="…thumbnail…">, and via two hosts (cdn.discordapp.com and
  // media.discordapp.net) at multiple resolutions. Without dedup we OCR the
  // same image up to 4–6 times per drop, each one a separate paid API call.
  // Prefer the <a> URL because that's the full-resolution original.
  function extractImageUrls(node) {
    const byPath = new Map(); // path -> { url, from }
    const consider = (el) => {
      if (!el || el.nodeType !== Node.ELEMENT_NODE) return;
      let url = null;
      if (el.tagName === 'A' && (el.href || '').includes('/attachments/')) {
        url = el.href;
      } else if (el.tagName === 'IMG') {
        const s = el.src || el.getAttribute('src') || '';
        if (s.includes('/attachments/')) url = s;
      }
      if (!url) return;
      const m = url.match(/\/attachments\/[^?#]+/);
      if (!m) return;
      const path = m[0];
      const existing = byPath.get(path);
      // Keep the first seen, OR upgrade IMG->A (full-res over thumbnail).
      if (!existing || (el.tagName === 'A' && existing.from === 'IMG')) {
        byPath.set(path, { url, from: el.tagName });
      }
    };
    // the node itself (querySelectorAll only matches descendants)
    consider(node);
    node.querySelectorAll && node.querySelectorAll('a[href*="/attachments/"], img')
      .forEach(consider);
    return [...byPath.values()].map((v) => v.url);
  }

  // Match by IDENTITY (any one is enough — this is an OR, never an AND):
  //   1. the configured Discord user id (stable), or
  //   2. one of the configured display names (case-insensitive fallback).
  // watchAll bypasses both and accepts every author in the channel.
  function authorMatches(author, authorId) {
    if (watchAll) return true;
    if (watchUserId && authorId === watchUserId) return true;
    if (author) {
      const n = String(author).toLowerCase().replace(/^@/, '').trim();
      if (n && watchNames.includes(n)) return true;
    }
    return false;
  }

  function handleImageContainer(node, channelId, attempt = 0) {
    const { id: authorId, name: author } = resolveAuthor(node);
    const urls = extractImageUrls(node);

    // Verbose diagnostics — tells us exactly what Discord exposes
    console.log(
      `[Watcher][img] attempt=${attempt} channel=${channelId} author=${JSON.stringify(author)} ` +
      `authorId=${JSON.stringify(authorId)} watchUserId=${JSON.stringify(watchUserId)} ` +
      `watchNames=${JSON.stringify(watchNames)} watchAll=${watchAll} urls=${urls.length}`
    );

    if (urls.length === 0) {
      if (attempt < 5) setTimeout(() => handleImageContainer(node, channelId, attempt + 1), 400);
      else console.log('[Watcher][img] gave up — no attachment URL found');
      return;
    }

    // Avatar can render a moment after the attachment — retry author lookup
    if (!watchAll && !authorId && !author && attempt < 5) {
      setTimeout(() => handleImageContainer(node, channelId, attempt + 1), 400);
      return;
    }

    if (!authorMatches(author, authorId)) {
      console.log(
        `[Watcher][img] SKIP — author="${author}" id="${authorId}" does not match watch config`
      );
      return;
    }

    for (const url of urls) {
      const key = url.split('?')[0];
      if (processedImages.has(key)) continue;
      processedImages.add(key);
      console.log(`[Watcher][img] → forwarding for OCR (author="${author}" id="${authorId}"):`, key);
      chrome.runtime.sendMessage({ type: 'IMAGE', url, author, authorId, channelId: channelId || getCurrentChannelId() });
    }
  }

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;

        // Channel id comes from the message element itself, so stage-channel
        // overlays and threads work too. With no list configured, watch all.
        const channelId = channelIdFromNode(node);
        if (watchChannelIds.size && (!channelId || !watchChannelIds.has(channelId))) continue;

        // 1) text codes (plain text + optional <code class="inline"> scan)
        const matches = extractCodesFromNode(node);
        if (matches.length) {
          // Apply the author filter, but fail OPEN: text codes are free
          // (no OCR) and LBOX/LUCID-specific, so when the author can't be
          // resolved we still forward rather than risk dropping a valid drop.
          const { id: authorId, name: author } = resolveAuthor(node);
          const resolved = !!(authorId || author);
          if (!resolved || authorMatches(author, authorId)) {
            matches.forEach((code) => bufferCode(code, channelId));
          } else {
            console.log(`[Watcher] SKIP text codes — author="${author}" id="${authorId}" does not match`);
          }
        }

        // 2) image attachments
        const hasImg =
          (node.tagName === 'IMG') ||
          (node.querySelector && node.querySelector('img, a[href*="/attachments/"]'));
        if (hasImg) handleImageContainer(node, channelId);
      }
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });
  console.log('[Watcher] MutationObserver active (text + images). channels:', [...watchChannelIds], 'watchUserId:', watchUserId, 'watchNames:', watchNames);
})();
