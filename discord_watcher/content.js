(() => {
  const BUFFER_MS = 500;
  let codeRegex = /LBOX-[A-Z0-9]{18}/g;
  let configuredChannelId = '';
  let watchUser = 'leothetiger';
  let watchAll = false;
  let codeBuffer = [];
  let bufferTimer = null;
  const processedImages = new Set();

  chrome.storage.local.get(
    ['channelId', 'codePattern', 'watchUser', 'watchAll'],
    ({ channelId = '', codePattern = '', watchUser: wu = 'leothetiger', watchAll: wa = false }) => {
      configuredChannelId = channelId;
      if (codePattern) codeRegex = new RegExp(codePattern, 'g');
      watchUser = (wu || 'leothetiger').toLowerCase();
      watchAll = !!wa;
    }
  );
  chrome.storage.onChanged.addListener((c) => {
    if (c.channelId)   configuredChannelId = c.channelId.newValue || '';
    if (c.codePattern) codeRegex = new RegExp(c.codePattern.newValue || 'LBOX-[A-Z0-9]{18}', 'g');
    if (c.watchUser)   watchUser = (c.watchUser.newValue || 'leothetiger').toLowerCase();
    if (c.watchAll)    watchAll = !!c.watchAll.newValue;
  });

  function getCurrentChannelId() {
    const m = location.pathname.match(/\/channels\/\d+\/(\d+)/);
    return m ? m[1] : null;
  }

  // ---- text codes (unchanged) ----
  function bufferCode(code) {
    if (!codeBuffer.includes(code)) codeBuffer.push(code);
    clearTimeout(bufferTimer);
    bufferTimer = setTimeout(() => {
      const batch = codeBuffer.splice(0);
      for (let i = batch.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [batch[i], batch[j]] = [batch[j], batch[i]];
      }
      console.log('[Watcher] Sending', batch.length, 'text codes:', batch);
      chrome.runtime.sendMessage({ type: 'CODES', codes: batch });
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

  function extractImageUrls(node) {
    const urls = new Set();
    const consider = (el) => {
      if (!el || el.nodeType !== Node.ELEMENT_NODE) return;
      if (el.tagName === 'A' && (el.href || '').includes('/attachments/')) urls.add(el.href);
      if (el.tagName === 'IMG') {
        const s = el.src || el.getAttribute('src') || '';
        if (s.includes('/attachments/')) urls.add(s);
      }
    };
    // the node itself (querySelectorAll only matches descendants)
    consider(node);
    node.querySelectorAll && node.querySelectorAll('a[href*="/attachments/"], img')
      .forEach(consider);
    return [...urls];
  }

  function authorMatches(author, authorId) {
    if (watchAll) return true;
    // If watchUser is all digits, treat it as a Discord user ID (stable).
    if (/^\d{15,}$/.test(watchUser)) return authorId === watchUser;
    // Otherwise match the display name (case-insensitive, trimmed).
    return !!author && author.toLowerCase() === watchUser;
  }

  function handleImageContainer(node, attempt = 0) {
    const { id: authorId, name: author } = resolveAuthor(node);
    const urls = extractImageUrls(node);

    // Verbose diagnostics — tells us exactly what Discord exposes
    console.log(
      `[Watcher][img] attempt=${attempt} author=${JSON.stringify(author)} ` +
      `authorId=${JSON.stringify(authorId)} watchUser=${JSON.stringify(watchUser)} ` +
      `watchAll=${watchAll} urls=${urls.length}`
    );

    if (urls.length === 0) {
      if (attempt < 5) setTimeout(() => handleImageContainer(node, attempt + 1), 400);
      else console.log('[Watcher][img] gave up — no attachment URL found');
      return;
    }

    // Avatar can render a moment after the attachment — retry author lookup
    if (!watchAll && !authorId && !author && attempt < 5) {
      setTimeout(() => handleImageContainer(node, attempt + 1), 400);
      return;
    }

    if (!authorMatches(author, authorId)) {
      console.log(
        `[Watcher][img] SKIP — author="${author}" id="${authorId}" ≠ watchUser="${watchUser}"`
      );
      return;
    }

    for (const url of urls) {
      const key = url.split('?')[0];
      if (processedImages.has(key)) continue;
      processedImages.add(key);
      console.log(`[Watcher][img] → forwarding for OCR (author="${author}" id="${authorId}"):`, key);
      chrome.runtime.sendMessage({ type: 'IMAGE', url, author, authorId });
    }
  }

  const observer = new MutationObserver((mutations) => {
    if (configuredChannelId && getCurrentChannelId() !== configuredChannelId) return;

    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;

        // 1) plain-text codes
        const text = node.textContent || '';
        codeRegex.lastIndex = 0;
        const matches = text.match(codeRegex);
        if (matches) matches.forEach(bufferCode);

        // 2) image attachments
        const hasImg =
          (node.tagName === 'IMG') ||
          (node.querySelector && node.querySelector('img, a[href*="/attachments/"]'));
        if (hasImg) handleImageContainer(node);
      }
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });
  console.log('[Watcher] MutationObserver active (text + images, user:', watchUser, ')');
})();
