// WARNING: Using a Discord user token (selfbot) violates Discord ToS.
// Your account may be banned. Use at your own risk.

const { WebSocket, WebSocketServer } = require('ws');
const fs = require('fs');
const path = require('path');

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

if (!config.token || config.token === 'your-discord-user-token-here') {
  console.error('[!] Set your token in config.json first.');
  process.exit(1);
}

const codeRegex = new RegExp(config.codePattern || 'LBOX-[A-Z0-9]{18}', 'g');
const channelIds = new Set(config.channelIds || []);
const PORT = config.port || 3847;
const BUFFER_MS = 500;

const OPENAI_API_KEY = config.openaiApiKey || '';
const OPENAI_MODEL = config.openaiModel || 'gpt-4o';
const CODE_VALIDATOR = /^LBOX-[A-Z0-9]{18}$/;

// De-dupe images so we don't pay for OCR twice on the same attachment
const recentImages = new Map(); // urlBase -> timestamp
const IMAGE_TTL_MS = 10 * 60 * 1000;

const OCR_PROMPT = `You are an expert OCR system. This image contains a list of redemption codes rendered in a deliberately distressed/grungy anti-OCR font with a cracked lava texture.

STRICT RULES:
- Every code has the exact format: "LBOX-" followed by EXACTLY 18 characters.
- Each of the 18 characters is an UPPERCASE letter A-Z or a digit 0-9. No lowercase, no symbols, no spaces.
- There are usually exactly 10 codes, numbered 1-10. Read every one.
- Read glyph shapes extremely carefully. Disambiguate look-alikes by shape: 0 (zero, narrow/oval) vs O (letter, round), 1 vs I, 5 vs S, 8 vs B, 2 vs Z, 6 vs G, D vs 0.
- If a character is genuinely ambiguous, pick the single most likely one — never output a placeholder.

Return ONLY strict JSON, no markdown, in this exact shape:
{"codes":["LBOX-XXXXXXXXXXXXXXXXXX", ...]}
If you find no valid codes, return {"codes":[]}.`;

async function ocrImage(url) {
  if (!OPENAI_API_KEY) {
    console.error('[OCR] No openaiApiKey in config.json');
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

  const body = {
    model: OPENAI_MODEL,
    temperature: 0,
    max_tokens: 800,
    response_format: { type: 'json_object' },
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: OCR_PROMPT },
        { type: 'image_url', image_url: { url: dataUrl, detail: 'high' } },
      ],
    }],
  };

  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    console.error(`[OCR] OpenAI error ${resp.status}: ${await resp.text()}`);
    return [];
  }

  const json = await resp.json();
  const content = json.choices?.[0]?.message?.content || '{}';
  let codes = [];
  try {
    codes = (JSON.parse(content).codes || [])
      .map(c => String(c).trim().toUpperCase())
      .filter(c => CODE_VALIDATOR.test(c));
  } catch (e) {
    console.error('[OCR] JSON parse failed:', content);
  }
  const unique = [...new Set(codes)];
  console.log(`[OCR] ${unique.length} valid codes in ${Date.now() - t0}ms`);
  return unique;
}

async function handleImage(url) {
  const base = url.split('?')[0];
  const now = Date.now();
  for (const [k, ts] of recentImages) if (now - ts > IMAGE_TTL_MS) recentImages.delete(k);
  if (recentImages.has(base)) {
    console.log('[OCR] Skipping already-processed image');
    return;
  }
  recentImages.set(base, now);

  try {
    const codes = await ocrImage(url);
    if (codes.length === 0) {
      console.log('[OCR] No valid codes found (probably not a code image)');
      return;
    }
    // Shuffle before broadcasting
    for (let i = codes.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [codes[i], codes[j]] = [codes[j], codes[i]];
    }
    console.log(`[OCR] Broadcasting ${codes.length} codes from image:`);
    codes.forEach(c => console.log(`     → ${c}`));
    broadcast(codes);
  } catch (e) {
    console.error('[OCR] Failed:', e.message);
  }
}

let codeBuffer = [];
let bufferTimer = null;

function bufferCode(code) {
  if (!codeBuffer.includes(code)) codeBuffer.push(code);
  clearTimeout(bufferTimer);
  bufferTimer = setTimeout(() => {
    const batch = codeBuffer.splice(0);
    for (let i = batch.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [batch[i], batch[j]] = [batch[j], batch[i]];
    }
    console.log(`[+] Sending ${batch.length} shuffled codes`);
    broadcast(batch);
  }, BUFFER_MS);
}

// --- WebSocket server for the Chrome extension ---
const wss = new WebSocketServer({ port: PORT });
const clients = new Set();

wss.on('connection', (ws) => {
  clients.add(ws);
  console.log(`[WS] Client connected (${clients.size} total)`);

  // Relay CODES / run OCR on IMAGE messages from the discord_watcher extension
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'CODES' && Array.isArray(msg.codes)) {
        console.log(`[WS] Relaying ${msg.codes.length} matches from extension:`);
        msg.codes.forEach(c => console.log(`     → ${c}`));
        broadcast(msg.codes);
      } else if (msg.type === 'IMAGE' && typeof msg.url === 'string') {
        console.log(`[WS] Image from "${msg.author || '?'}" → running OCR…`);
        handleImage(msg.url);
      }
    } catch (_) {}
  });

  ws.on('close', () => {
    clients.delete(ws);
    console.log(`[WS] Client disconnected (${clients.size} total)`);
  });
});

wss.on('listening', () => console.log(`[WS] Server listening on ws://localhost:${PORT}`));

function broadcast(codes) {
  const msg = JSON.stringify({ type: 'CODES', codes });
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}

// --- Minimal Discord Gateway client ---
const GATEWAY = 'wss://gateway.discord.gg/?v=10&encoding=json';

function connectGateway() {
  let heartbeatTimer = null;
  let sequence = null;

  const gw = new WebSocket(GATEWAY);

  gw.on('message', (raw) => {
    const { op, d, s, t } = JSON.parse(raw);
    if (s !== null) sequence = s;

    if (op === 10) {
      // HELLO — start heartbeat and identify
      heartbeatTimer = setInterval(() => {
        gw.send(JSON.stringify({ op: 1, d: sequence }));
      }, d.heartbeat_interval);

      gw.send(JSON.stringify({
        op: 2,
        d: {
          token: config.token,
          intents: 512, // GUILD_MESSAGES
          properties: { os: 'windows', browser: 'Chrome', device: '' },
        },
      }));
    } else if (op === 0) {
      if (t === 'READY') {
        console.log(`[Discord] Logged in as ${d.user.username}#${d.user.discriminator}`);
        console.log(`[Discord] Watching ${channelIds.size} channel(s): ${[...channelIds].join(', ')}`);
      } else if (t === 'MESSAGE_CREATE') {
        if (!channelIds.has(d.channel_id)) return;
        const matches = d.content.match(codeRegex);
        if (!matches) return;
        for (const code of matches) bufferCode(code);
      }
    } else if (op === 7) {
      // Reconnect requested
      gw.close();
    } else if (op === 9) {
      console.error('[Discord] Invalid session — check your token.');
      process.exit(1);
    }
  });

  gw.on('close', () => {
    clearInterval(heartbeatTimer);
    console.log('[Discord] Disconnected, reconnecting in 5s...');
    setTimeout(connectGateway, 5000);
  });

  gw.on('error', (err) => {
    console.error('[Discord] Gateway error:', err.message);
  });
}

connectGateway();
