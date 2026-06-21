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
// Ring buffer of the last N log lines so the admin dashboard can tail them
// without having to read journald. Stays in process memory only.
const LOG_RING = [];
const LOG_RING_MAX = 500;
function _ringPush(level, args) {
  LOG_RING.push(`[${_ts()}] ${level} ${_serialize(args)}`);
  if (LOG_RING.length > LOG_RING_MAX) LOG_RING.splice(0, LOG_RING.length - LOG_RING_MAX);
}

function _appendLog(level, args) {
  _ringPush(level, args);
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

// --- Stats for the admin dashboard --------------------------------------
// All in-memory; reset on bridge restart. Used purely for observability.
const STARTED_AT = Date.now();
const STATS = {
  ocrBatches: 0,         // total OCR API calls (= batches) since start
  ocrCodesFound: 0,      // total LBOX/LUCID codes returned by OCR
  textCodes: 0,          // codes that came in as plain text (no OCR)
  imagesIngested: 0,     // IMAGE messages received from watcher
  channelActivity: {},   // channelId -> [timestamps of recent ingest events]
  recentCodes: [],       // last 30 codes broadcast { code, source, at }
};
const ACTIVITY_KEEP_MS = 60 * 60 * 1000;     // remember 1h of activity per channel
function _bumpChannelActivity(channelId) {
  if (!channelId) return;
  const now = Date.now();
  const arr = STATS.channelActivity[channelId] || (STATS.channelActivity[channelId] = []);
  arr.push(now);
  // Trim old entries
  while (arr.length && now - arr[0] > ACTIVITY_KEEP_MS) arr.shift();
}
function _recordCodes(codes, source) {
  const now = Date.now();
  for (const c of codes) STATS.recentCodes.push({ code: c, source, at: now });
  if (STATS.recentCodes.length > 30) STATS.recentCodes.splice(0, STATS.recentCodes.length - 30);
}

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

// Comprehensive prompt ported from the v3 server. Handles every evasion
// technique Leo has used so far: plain lines, spoiler fragmentation
// (||…||), character grids in 4 directions, crossword puzzles with decoy
// words, and stylized grunge fonts. Extended to recognise BOTH LBOX-
// and LUCID- prefixes (Leo started dropping both formats).
const ANALYSIS_PROMPT = `You are extracting Lucid Trading redemption codes from a Discord message that may use various evasion techniques.

CODE FORMAT (strict): codes start with either "LBOX-" or "LUCID-" followed by EXACTLY 18 characters. Each of those 18 characters is an UPPERCASE letter A-Z or a digit 0-9. No lowercase, no symbols, no spaces inside the code.

Evasion techniques you MUST handle:

1. PLAIN LINES like "LBOX-XXXXXXXXXXXXXXXXXX" or "LUCID-XXXXXXXXXXXXXXXXXX".

2. SPOILER FRAGMENTATION — codes are split across "||...||" spoiler blocks. The end of one spoiler holds the first piece of a code, the start of the NEXT spoiler holds the rest. Join adjacent fragments ONLY when the result is exactly 18 chars after "LBOX-" or "LUCID-". Decoy spoilers between fragments (e.g. "|| I love you ||") are noise — skip them but still pair the fragments correctly.
   Example: "LBOX-456Q04P3 || || VN04H4IDQ9" -> "LBOX-456Q04P3VN04H4IDQ9".

3. CHARACTER GRIDS — a rectangular block of single A-Z/0-9 characters separated by spaces. Codes may be readable
   (a) left-to-right per row,
   (b) right-to-left per row (mirrored — look for "XOBL" which is "LBOX" reversed, or "DICUL" which is "LUCID" reversed),
   (c) top-to-bottom across rows,
   (d) bottom-to-top across rows.
   The starting row may be arbitrary. Whenever you encounter "LBOX" or "LUCID" in any direction, the next 18 chars in that same direction form the code.

4. CROSSWORD IMAGES — LBOX/LUCID entries appear as horizontal entries in a black-and-white crossword grid, mixed with regular crossword words (decoys like CRANE, MISTY, AURORA). Read each horizontal entry; emit ONLY LBOX- or LUCID-prefixed ones.

5. STYLIZED IMAGES — codes in distressed/grunge fonts (cracked, lava textures) designed to defeat OCR. Read glyph shapes very carefully.

Disambiguate look-alikes by shape: 0 vs O vs Q, 1 vs I, 5 vs S, 8 vs B, 2 vs Z, 6 vs G, D vs 0.

Return STRICT JSON ONLY, no markdown, no commentary:
{"codes":["LBOX-XXXXXXXXXXXXXXXXXX", "LUCID-XXXXXXXXXXXXXXXXXX", ...]}
If you find no valid codes, return {"codes":[]}.`;

// Extracts a JSON object from a string that may contain prose around it.
// Used as fallback for models that don't honour response_format.
function extractJson(text) {
  const m = text.match(/\{[\s\S]*\}/);
  return m ? m[0] : text;
}

// ONE OpenAI call that takes the surrounding message text plus up to 4
// images. Returns the union of valid codes the model found. Way cheaper
// than calling once per image, and the model sees the whole context at
// once (helps with spoiler-fragmented codes that span text + grid).
async function ocrBatch(text, urls) {
  const useOpenRouter = !!OPENROUTER_API_KEY;
  const useOpenAI     = !!OPENAI_API_KEY;
  if (!useOpenRouter && !useOpenAI) {
    console.error('[OCR] No API key in config.json — set openrouterApiKey (free) or openaiApiKey');
    return [];
  }
  if (!urls.length && !(text || '').trim()) return [];

  const t0 = Date.now();
  const content = [{ type: 'text', text: ANALYSIS_PROMPT }];
  if (text && text.trim()) {
    content.push({ type: 'text', text: text.slice(0, 8000) });
  }

  let fetched = 0;
  for (const url of urls.slice(0, 4)) {  // OpenAI accepts more but 4 is plenty for one drop
    try {
      const r = await fetch(url);
      if (!r.ok) { console.error(`[OCR] image fetch ${r.status} for ${url}`); continue; }
      const buf = Buffer.from(await r.arrayBuffer());
      const mime = r.headers.get('content-type') || 'image/png';
      content.push({
        type: 'image_url',
        image_url: { url: `data:${mime};base64,${buf.toString('base64')}`, detail: 'high' },
      });
      fetched++;
    } catch (e) {
      console.error('[OCR] image error:', e.message);
    }
  }
  if (fetched === 0 && !(text || '').trim()) {
    console.error('[OCR] nothing usable to send (no images downloaded, no text)');
    return [];
  }

  let endpoint, headers, model;
  if (useOpenRouter) {
    endpoint = 'https://openrouter.ai/api/v1/chat/completions';
    headers  = { 'Authorization': `Bearer ${OPENROUTER_API_KEY}`, 'Content-Type': 'application/json' };
    model    = OPENROUTER_MODEL;
  } else {
    endpoint = 'https://api.openai.com/v1/chat/completions';
    headers  = { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' };
    model    = OPENAI_MODEL;
  }
  console.log(`[OCR] ${useOpenRouter ? 'OpenRouter' : 'OpenAI'} (${model}) — text=${(text||'').length}c, imgs=${fetched}/${urls.length}`);

  const body = {
    model,
    temperature: 0,
    max_tokens: 1200,
    messages: [{ role: 'user', content }],
  };
  // response_format: json_object is OpenAI-only; OpenRouter relays it
  // inconsistently across models, so we rely on extractJson() as fallback.
  if (!useOpenRouter) body.response_format = { type: 'json_object' };

  const resp = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body) });
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
      .map((c) => String(c).trim().toUpperCase())
      .filter((c) => CODE_VALIDATOR.test(c));
  } catch (e) {
    console.error('[OCR] JSON parse failed:', raw);
  }
  const unique = [...new Set(codes)];
  console.log(`[OCR] ${unique.length} valid codes in ${Date.now() - t0}ms`);
  return unique;
}

// Buffer images per Discord message so all attachments of the same drop
// OCR in a single OpenAI call. Without this each image would burn its own
// call, even with dedup. Without msgId (older watcher / edge case) we
// bucket by attachment path so the image still gets OCR'd, just on its own.
const BATCH_WINDOW_MS = 600;
const pendingBatches = new Map(); // bucketKey -> { urls, text, channelId, timer }

function handleImage(url, sourceChannelId, msgId, messageText) {
  const key = attachmentKey(url);
  const now = Date.now();
  for (const [k, ts] of recentImages) if (now - ts > IMAGE_TTL_MS) recentImages.delete(k);
  if (recentImages.has(key)) {
    console.log(`[OCR] Skipping already-processed image (${key})`);
    return;
  }
  recentImages.set(key, now);

  const bucketKey = msgId || key;
  let batch = pendingBatches.get(bucketKey);
  if (!batch) {
    batch = { urls: [], text: '', channelId: null, timer: null };
    pendingBatches.set(bucketKey, batch);
  }
  batch.urls.push(url);
  if (messageText && !batch.text)   batch.text = messageText;
  if (sourceChannelId && !batch.channelId) batch.channelId = sourceChannelId;

  // (Re)arm the flush timer — each new image extends the window slightly so
  // late-arriving attachments of the same message land in the same batch.
  clearTimeout(batch.timer);
  batch.timer = setTimeout(() => flushImageBatch(bucketKey), BATCH_WINDOW_MS);
}

async function flushImageBatch(bucketKey) {
  const batch = pendingBatches.get(bucketKey);
  if (!batch) return;
  pendingBatches.delete(bucketKey);

  // Spend cap is now per BATCH (= per OpenAI call), not per image. So a
  // 4-image drop = 1 unit against the budget.
  const blocked = ocrBudgetCheck();
  if (blocked) {
    console.warn(`[OCR] SKIP batch ${bucketKey} — ${blocked}`);
    return;
  }
  ocrBudgetAccount();
  STATS.ocrBatches += 1;

  try {
    console.log(`[OCR] batch ${bucketKey}: ${batch.urls.length} image(s), text=${batch.text.length}c`);
    const codes = await ocrBatch(batch.text, batch.urls);
    if (codes.length === 0) {
      console.log(`[OCR] batch ${bucketKey}: no valid codes`);
      return;
    }
    STATS.ocrCodesFound += codes.length;
    for (let i = codes.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [codes[i], codes[j]] = [codes[j], codes[i]];
    }
    console.log(`[OCR] batch ${bucketKey}: ${codes.length} codes`);
    codes.forEach((c) => console.log(`     → ${c}`));
    dispatchCodes(codes, batch.channelId);
  } catch (e) {
    console.error(`[OCR] batch ${bucketKey} failed:`, e.message);
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
  _recordCodes(fresh, CHANNEL_LABELS[sourceChannelId] || sourceChannelId || 'unknown');
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
        STATS.textCodes += msg.codes.length;
        _bumpChannelActivity(msg.channelId);
        console.log(`[Ingest] ${msg.codes.length} code(s) from channel ${msg.channelId || '?'}:`);
        msg.codes.forEach(c => console.log(`     → ${c}`));
        dispatchCodes(msg.codes, msg.channelId);
      } else if (msg.type === 'IMAGE' && typeof msg.url === 'string') {
        STATS.imagesIngested += 1;
        _bumpChannelActivity(msg.channelId);
        console.log(`[Ingest] Image from "${msg.author || '?'}" (channel ${msg.channelId || '?'}, msgId ${msg.msgId || '?'}) → buffering`);
        handleImage(msg.url, msg.channelId, msg.msgId, msg.messageText);
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
  ws._ip = ip;
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

// --- Admin dashboard (HTTP, loopback only) ------------------------------
const { startAdmin } = require('./admin');
const ADMIN_PORT = config.adminPort || 9090;
startAdmin({
  port: ADMIN_PORT,
  logRing: LOG_RING,
  stats: STATS,
  startedAt: STARTED_AT,
  channelLabels: CHANNEL_LABELS,
  getIngestClients:  () => ingestWss.clients.size,
  getConsumers:      () => [...consumers].map((ws) => ({ label: ws._label || '?', ip: ws._ip || '?' })),
  getPendingBatches: () => pendingBatches.size,
  getRecentImagesCount: () => recentImages.size,
  getSeenCodesCount:    () => seenCodes.size,
  getBudget: () => ({
    minute_used: _ocrMinuteWindow.length,
    minute_cap:  OCR_PER_MIN,
    day_used:    _ocrDayCount,
    day_cap:     OCR_PER_DAY,
  }),
});
