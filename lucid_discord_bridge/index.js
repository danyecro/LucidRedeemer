// Lucid bridge — runs on the AWS VM (or locally for dev).
//
// Two WebSocket servers:
//   • INGEST  — bound to 127.0.0.1 only, no auth. The discord_watcher
//               extension (running in Chrome on the same machine) connects
//               here and pushes CODES / IMAGE messages.
//   • RELAY   — public (proxied by Caddy as wss://relay.DOMAIN). Token
//               required on connect. Receive-only: incoming messages from
//               consumers are ignored, so a malicious client can never inject
//               fake codes for everyone else.
//
// Image OCR (OpenRouter/OpenAI) + cross-channel dedup + optional webhook
// repost live in this file too.

const { WebSocket, WebSocketServer } = require('ws');
const fs = require('fs');
const path = require('path');
const { ensureSeed, validateToken } = require('./auth');

const config = JSON.parse(fs.readFileSync('./config.json', 'utf8'));

// --- Persistent file logging (daily rotation) ---------------------------
const LOG_DIR = path.join(__dirname, 'logs');
try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch (_) {}

function _logFile() {
  const d = new Date();
  const y  = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const da = String(d.getDate()).padStart(2, '0');
  return path.join(LOG_DIR, `bridge-${y}-${mo}-${da}.log`);
}
function _ts() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}
function _serialize(args) {
  return args.map(a => (typeof a === 'string' ? a : (() => {
    try { return JSON.stringify(a); } catch { return String(a); }
  })())).join(' ');
}
function _appendLog(level, args) {
  try {
    fs.appendFileSync(_logFile(), `[${_ts()}] ${level} ${_serialize(args)}\n`);
  } catch (_) {}
}

const _origLog  = console.log.bind(console);
const _origWarn = console.warn.bind(console);
const _origErr  = console.error.bind(console);
console.log   = (...a) => { _appendLog('INFO ', a); _origLog(...a); };
console.warn  = (...a) => { _appendLog('WARN ', a); _origWarn(...a); };
console.error = (...a) => { _appendLog('ERROR', a); _origErr(...a); };
console.log(`[init] Logging to ${_logFile()}`);
// ------------------------------------------------------------------------

// Ports. INGEST is forced to 127.0.0.1 (no external exposure ever). The
// `port` field is kept as a fallback for the legacy single-port setup.
const INGEST_PORT = config.ingestPort || config.port || 3847;
const RELAY_PORT  = config.relayPort  || 8080;

// Seed tokens.json with config.authToken on first run.
ensureSeed(config.authToken);

const OPENAI_API_KEY    = config.openaiApiKey || '';
const OPENAI_MODEL      = config.openaiModel || 'gpt-4o';
const OPENROUTER_API_KEY = config.openrouterApiKey || '';
const OPENROUTER_MODEL   = config.openrouterModel || 'openrouter/free';
const CODE_VALIDATOR = /^(?:LBOX|LUCID)-[A-Z0-9]{18}$/;

// De-dupe images so we don't pay for OCR twice on the same attachment.
// Keyed by the /attachments/<channelId>/<msgId>/<filename> path so that the
// same image served from cdn.discordapp.com vs media.discordapp.net (or at
// different resolutions / signed-URL variants) only OCRs once.
const recentImages = new Map(); // attachmentPath -> timestamp
const IMAGE_TTL_MS = 10 * 60 * 1000;

function attachmentKey(url) {
  const m = String(url).match(/\/attachments\/[^?#]+/);
  return m ? m[0] : String(url).split('?')[0];
}

// De-dupe codes across channels — the same drop is often cross-posted in all
// watched channels, and we must not redeem or repost it multiple times.
const seenCodes = new Map(); // code -> timestamp
const CODE_TTL_MS = 15 * 60 * 1000;

// Optional: repost detected codes to your own Discord channel via a webhook.
const SHARE_WEBHOOK_URL = config.shareWebhookUrl || '';
const CHANNEL_LABELS = config.channelLabels || {};

// --- Spend cap -----------------------------------------------------------
// Hard limits on how many paid OCR calls we'll make. Two windows so a stuck
// loop can't blow through the daily budget in seconds. When the rolling
// minute cap is hit we cool off; when the daily cap is hit we stop OCR
// entirely until midnight UTC. Counters are in-memory only — a bridge
// restart resets them, which is the correct behaviour after a crash fix.
const OCR_PER_MIN  = Number.isFinite(config.maxOcrCallsPerMinute) ? config.maxOcrCallsPerMinute : 30;
const OCR_PER_DAY  = Number.isFinite(config.maxOcrCallsPerDay)    ? config.maxOcrCallsPerDay    : 1000;
let _ocrMinuteWindow = [];   // timestamps of calls in last 60s
let _ocrDayCount     = 0;
let _ocrDayKey       = '';

function _dayKey() { return new Date().toISOString().slice(0, 10); }

// Returns null when an OCR call is allowed, or a reason string when blocked.
function ocrBudgetCheck() {
  const now = Date.now();
  // Reset daily counter at UTC midnight.
  const today = _dayKey();
  if (today !== _ocrDayKey) { _ocrDayKey = today; _ocrDayCount = 0; }
  // Drop call timestamps older than 60s.
  _ocrMinuteWindow = _ocrMinuteWindow.filter((t) => now - t < 60_000);
  if (_ocrDayCount    >= OCR_PER_DAY)  return `daily cap ${OCR_PER_DAY}/day reached`;
  if (_ocrMinuteWindow.length >= OCR_PER_MIN) return `per-minute cap ${OCR_PER_MIN}/min reached`;
  return null;
}

function ocrBudgetAccount() {
  const now = Date.now();
  const today = _dayKey();
  if (today !== _ocrDayKey) { _ocrDayKey = today; _ocrDayCount = 0; }
  _ocrMinuteWindow.push(now);
  _ocrDayCount += 1;
}

const OCR_PROMPT = `You are an expert OCR system. This image contains a list of redemption codes rendered in a deliberately distressed/grungy anti-OCR font with a cracked lava texture.

STRICT RULES:
- Every code starts with either "LBOX-" or "LUCID-" followed by EXACTLY 18 characters.
- Each of the 18 characters is an UPPERCASE letter A-Z or a digit 0-9. No lowercase, no symbols, no spaces.
- There are usually exactly 10 codes, numbered 1-10. Read every one.
- Read glyph shapes extremely carefully. Disambiguate look-alikes by shape: 0 (zero, narrow/oval) vs O (letter, round), 1 vs I, 5 vs S, 8 vs B, 2 vs Z, 6 vs G, D vs 0.
- If a character is genuinely ambiguous, pick the single most likely one — never output a placeholder.

Return ONLY strict JSON, no markdown, in this exact shape:
{"codes":["LBOX-XXXXXXXXXXXXXXXXXX", "LUCID-XXXXXXXXXXXXXXXXXX", ...]}
If you find no valid codes, return {"codes":[]}.`;

// Extracts a JSON object from a string that may contain prose around it.
// Used as fallback for models that don't honour response_format.
function extractJson(text) {
  const m = text.match(/\{[\s\S]*\}/);
  return m ? m[0] : text;
}

async function ocrImage(url) {
  const useOpenRouter = !!OPENROUTER_API_KEY;
  const useOpenAI     = !!OPENAI_API_KEY;

  if (!useOpenRouter && !useOpenAI) {
    console.error('[OCR] No API key in config.json — set openrouterApiKey (free) or openaiApiKey');
    return [];
  }

  const t0 = Date.now();

  // Download the image in the bridge (avoids CDN/CORS issues, max resolution)
  const imgResp = await fetch(url);
  if (!imgResp.ok) {
    console.error(`[OCR] Image download failed: ${imgResp.status}`);
    return [];
  }
  const buf = Buffer.from(await imgResp.arrayBuffer());
  const mime = imgResp.headers.get('content-type') || 'image/png';
  const dataUrl = `data:${mime};base64,${buf.toString('base64')}`;

  let endpoint, headers, model;

  if (useOpenRouter) {
    endpoint = 'https://openrouter.ai/api/v1/chat/completions';
    headers  = { 'Authorization': `Bearer ${OPENROUTER_API_KEY}`, 'Content-Type': 'application/json' };
    model    = OPENROUTER_MODEL;
    console.log(`[OCR] Using OpenRouter (${model})`);
  } else {
    endpoint = 'https://api.openai.com/v1/chat/completions';
    headers  = { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' };
    model    = OPENAI_MODEL;
    console.log(`[OCR] Using OpenAI (${model})`);
  }

  const body = {
    model,
    temperature: 0,
    max_tokens: 800,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: OCR_PROMPT },
        { type: 'image_url', image_url: { url: dataUrl, detail: 'high' } },
      ],
    }],
  };

  // response_format: json_object is OpenAI-specific; not all OpenRouter models support it
  if (!useOpenRouter) {
    body.response_format = { type: 'json_object' };
  }

  const resp = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const label = useOpenRouter ? 'OpenRouter' : 'OpenAI';
    console.error(`[OCR] ${label} error ${resp.status}: ${await resp.text()}`);
    return [];
  }

  const json = await resp.json();
  const raw = json.choices?.[0]?.message?.content || '{}';
  let codes = [];
  try {
    codes = (JSON.parse(extractJson(raw)).codes || [])
      .map(c => String(c).trim().toUpperCase())
      .filter(c => CODE_VALIDATOR.test(c));
  } catch (e) {
    console.error('[OCR] JSON parse failed:', raw);
  }
  const unique = [...new Set(codes)];
  console.log(`[OCR] ${unique.length} valid codes in ${Date.now() - t0}ms`);
  return unique;
}

async function handleImage(url, sourceChannelId) {
  const key = attachmentKey(url);
  const now = Date.now();
  for (const [k, ts] of recentImages) if (now - ts > IMAGE_TTL_MS) recentImages.delete(k);
  if (recentImages.has(key)) {
    console.log(`[OCR] Skipping already-processed image (${key})`);
    return;
  }

  // Spend cap check BEFORE marking processed — if we're capped we want the
  // image to be retried on the next drop window, not silently swallowed.
  const blocked = ocrBudgetCheck();
  if (blocked) {
    console.warn(`[OCR] SKIP — ${blocked}`);
    return;
  }

  recentImages.set(key, now);
  ocrBudgetAccount();

  try {
    const codes = await ocrImage(url);
    if (codes.length === 0) {
      console.log('[OCR] No valid codes found (probably not a code image)');
      return;
    }
    // Shuffle before dispatching
    for (let i = codes.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [codes[i], codes[j]] = [codes[j], codes[i]];
    }
    console.log(`[OCR] ${codes.length} codes from image:`);
    codes.forEach(c => console.log(`     → ${c}`));
    dispatchCodes(codes, sourceChannelId);
  } catch (e) {
    console.error('[OCR] Failed:', e.message);
  }
}

// De-dupe codes seen within the TTL window; returns only the new ones.
function freshCodes(codes) {
  const now = Date.now();
  for (const [c, ts] of seenCodes) if (now - ts > CODE_TTL_MS) seenCodes.delete(c);
  const fresh = [];
  for (const c of codes) {
    if (seenCodes.has(c)) continue;
    seenCodes.set(c, now);
    fresh.push(c);
  }
  return fresh;
}

// Repost codes to your own Discord channel via a webhook. Fire-and-forget so
// it never delays the redeemer broadcast.
async function shareToWebhook(codes, sourceChannelId) {
  if (!SHARE_WEBHOOK_URL || codes.length === 0) return;
  const label = CHANNEL_LABELS[sourceChannelId] || sourceChannelId || 'unknown';
  const content = codes.map((c) => `\`${c}\`  ·  ${label}`).join('\n').slice(0, 1900);
  try {
    const resp = await fetch(SHARE_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
    });
    if (!resp.ok) console.error(`[Share] Webhook POST failed ${resp.status}: ${await resp.text()}`);
    else console.log(`[Share] Reposted ${codes.length} code(s) from "${label}"`);
  } catch (e) {
    console.error('[Share] Webhook error:', e.message);
  }
}

// Central path for every detected batch: de-dupe, send to the redeemer
// extension FIRST, then repost to the webhook near-simultaneously.
function dispatchCodes(codes, sourceChannelId) {
  const fresh = freshCodes(codes);
  if (fresh.length === 0) {
    console.log('[dispatch] no new codes (all seen recently)');
    return;
  }
  broadcast(fresh);                       // 1) redeemer extension
  shareToWebhook(fresh, sourceChannelId); // 2) repost (fire-and-forget)
}

// --- INGEST WebSocket server (loopback only) ---------------------------
// Accepts CODES/IMAGE messages from the local discord_watcher extension.
// Bound to 127.0.0.1 so it can never be reached from outside the VM.
const ingestWss = new WebSocketServer({ host: '127.0.0.1', port: INGEST_PORT });

ingestWss.on('connection', (ws, req) => {
  console.log(`[Ingest] Watcher connected (${req.socket.remoteAddress})`);
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'CODES' && Array.isArray(msg.codes)) {
        console.log(`[Ingest] ${msg.codes.length} code(s) from channel ${msg.channelId || '?'}:`);
        msg.codes.forEach(c => console.log(`     → ${c}`));
        dispatchCodes(msg.codes, msg.channelId);
      } else if (msg.type === 'IMAGE' && typeof msg.url === 'string') {
        console.log(`[Ingest] Image from "${msg.author || '?'}" (channel ${msg.channelId || '?'}) → running OCR…`);
        handleImage(msg.url, msg.channelId);
      }
    } catch (_) {}
  });
  ws.on('close', () => console.log('[Ingest] Watcher disconnected'));
});

ingestWss.on('listening', () =>
  console.log(`[Ingest] Listening on ws://127.0.0.1:${INGEST_PORT} (local watcher only)`));

// --- RELAY WebSocket server (public, token-gated, receive-only) ---------
// Consumers (other people's Redeemer extensions) connect here with a token
// (?token=...). They ONLY receive CODES broadcasts; any data they send is
// dropped silently so they can't inject fake codes.
const relayWss = new WebSocketServer({ port: RELAY_PORT });
const consumers = new Set();

function clientIp(req) {
  return req.headers['cf-connecting-ip']
      || (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
      || req.socket.remoteAddress
      || '?';
}

relayWss.on('connection', (ws, req) => {
  const ip = clientIp(req);
  let token = '';
  try {
    token = new URL(req.url, 'http://localhost').searchParams.get('token') || '';
  } catch (_) {}

  const rec = validateToken(token);
  if (!rec) {
    console.log(`[Relay] REJECT ${ip} — invalid or revoked token`);
    ws.close(4001, 'unauthorized');
    return;
  }

  ws._label = rec.label;
  consumers.add(ws);
  console.log(`[Relay] ACCEPT "${rec.label}" from ${ip} (${consumers.size} connected)`);

  try { ws.send(JSON.stringify({ type: 'HELLO' })); } catch (_) {}

  // Silently discard anything a consumer sends — relay is one-way.
  ws.on('message', () => {});

  // Keep the connection alive through Caddy / browser idle timeouts.
  const pingTimer = setInterval(() => {
    if (ws.readyState === ws.OPEN) {
      try { ws.ping(); } catch (_) {}
    }
  }, 30000);

  ws.on('close', () => {
    clearInterval(pingTimer);
    consumers.delete(ws);
    console.log(`[Relay] "${rec.label}" disconnected (${consumers.size} connected)`);
  });
  ws.on('error', () => {});
});

relayWss.on('listening', () =>
  console.log(`[Relay] Listening on ws://0.0.0.0:${RELAY_PORT} (public, token required)`));

console.log(`[OCR] Spend cap: ${OCR_PER_MIN}/min, ${OCR_PER_DAY}/day`);

// Drop already-connected consumers whose token gets revoked or expires.
setInterval(() => {
  for (const ws of consumers) {
    // Token lives on the underlying record; re-check by label is cheap and
    // good enough since labels are unique in tokens.json in practice.
    const recs = require('./auth').listTokens().filter((t) => t.label === ws._label && t.enabled);
    if (recs.length === 0) {
      console.log(`[Relay] dropping "${ws._label}" — token revoked/disabled`);
      try { ws.close(4001, 'token revoked'); } catch (_) {}
    }
  }
}, 60000);

// Each consumer gets a freshly shuffled order so they don't all hammer the
// same code first.
function broadcast(codes) {
  let sent = 0;
  for (const ws of consumers) {
    if (ws.readyState !== WebSocket.OPEN) continue;
    const ordered = codes.slice();
    for (let i = ordered.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [ordered[i], ordered[j]] = [ordered[j], ordered[i]];
    }
    ws.send(JSON.stringify({ type: 'CODES', codes: ordered }));
    sent++;
  }
  if (sent > 0) console.log(`[Relay] broadcast ${codes.length} code(s) -> ${sent} consumer(s)`);
}

// --- OpenRouter connection check on startup ---
async function testOpenRouterConnection() {
  if (!OPENROUTER_API_KEY) return;
  try {
    const resp = await fetch('https://openrouter.ai/api/v1/auth/key', {
      headers: { 'Authorization': `Bearer ${OPENROUTER_API_KEY}` },
    });
    if (resp.ok) {
      const { data } = await resp.json();
      const credits = data?.limit_remaining != null
        ? `$${Number(data.limit_remaining).toFixed(4)} remaining`
        : 'credits unknown';
      console.log(`[OpenRouter] Connected ✓  model: ${OPENROUTER_MODEL}  (${credits})`);
    } else {
      console.error(`[OpenRouter] Key check failed (${resp.status}) — double-check openrouterApiKey in config.json`);
    }
  } catch (e) {
    console.error('[OpenRouter] Could not reach openrouter.ai —', e.message);
  }
}

testOpenRouterConnection();
