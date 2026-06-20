// Client-token store for the public relay. Tokens live in tokens.json next to
// this file; everything is read fresh on every check so revocation takes
// effect immediately without restarting the bridge.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TOKENS_FILE = path.join(__dirname, 'tokens.json');

function load() {
  try {
    const data = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'));
    if (Array.isArray(data.tokens)) return data;
  } catch (_) {}
  return { tokens: [] };
}

function save(data) {
  fs.writeFileSync(TOKENS_FILE, JSON.stringify(data, null, 2));
}

// On first run, seed tokens.json from config.authToken as the admin token.
function ensureSeed(envToken) {
  if (fs.existsSync(TOKENS_FILE)) return;
  const seed = { tokens: [] };
  if (envToken) {
    seed.tokens.push({
      token: envToken,
      label: 'admin',
      createdAt: new Date().toISOString(),
      expiresAt: null,
      enabled: true,
    });
  }
  save(seed);
}

function isExpired(rec) {
  return !!rec.expiresAt && Date.now() > new Date(rec.expiresAt).getTime();
}

// Returns the token record if valid, else null. Reads fresh every call so the
// admin can revoke/change tokens without restarting the server.
function validateToken(token) {
  if (!token) return null;
  const rec = load().tokens.find((t) => t.token === token);
  if (!rec || !rec.enabled || isExpired(rec)) return null;
  return rec;
}

function findRec(data, needle) {
  return data.tokens.find((t) => t.token === needle || t.label === needle);
}

function addToken(label, days) {
  const data = load();
  const rec = {
    token: crypto.randomBytes(24).toString('hex'),
    label: label || 'unnamed',
    createdAt: new Date().toISOString(),
    expiresAt: days ? new Date(Date.now() + days * 86400000).toISOString() : null,
    enabled: true,
  };
  data.tokens.push(rec);
  save(data);
  return rec;
}

function setEnabled(needle, enabled) {
  const data = load();
  const rec = findRec(data, needle);
  if (!rec) return null;
  rec.enabled = enabled;
  save(data);
  return rec;
}

function removeToken(needle) {
  const data = load();
  const before = data.tokens.length;
  data.tokens = data.tokens.filter((t) => t.token !== needle && t.label !== needle);
  save(data);
  return data.tokens.length < before;
}

function listTokens() {
  return load().tokens;
}

module.exports = {
  ensureSeed,
  validateToken,
  addToken,
  setEnabled,
  removeToken,
  listTokens,
};
