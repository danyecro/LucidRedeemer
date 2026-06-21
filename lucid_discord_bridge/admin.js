// Read-only admin dashboard.
//
// Binds to 127.0.0.1 only. Public access is via Caddy at /admin/* with
// HTTP Basic Auth — see deploy/Caddyfile.
//
// Endpoints:
//   GET /            HTML status page (auto-refreshes its data)
//   GET /api/status  JSON: services, ocr counters, consumers, channel
//                    activity, chrome process info, recent codes
//   GET /api/logs    JSON: { lines: ["..."], total }  — bridge ring buffer
//
// All systemd / ps lookups are best-effort — never throw, never block.

const http = require('http');
const { execFile } = require('child_process');

function startAdmin({ port, logRing, stats, getConsumers, getIngestClients, getPendingBatches, getRecentImagesCount, getSeenCodesCount, getBudget, channelLabels, startedAt }) {
  function sh(cmd, args, cb) {
    execFile(cmd, args, { timeout: 1500 }, (err, stdout) => cb(err ? '' : String(stdout).trim()));
  }
  function probeServices(cb) {
    const services = ['lucid-bridge', 'lucid-vnc', 'caddy'];
    const out = {};
    let remaining = services.length;
    if (!remaining) return cb(out);
    services.forEach((s) => {
      sh('/usr/bin/systemctl', ['is-active', s], (state) => {
        out[s] = state || 'unknown';
        if (--remaining === 0) cb(out);
      });
    });
  }
  function probeChrome(cb) {
    sh('/usr/bin/pgrep', ['-u', 'ubuntu', '-af', '/opt/google/chrome/chrome '], (out) => {
      const lines = out.split('\n').filter(Boolean);
      const main = lines.find((l) => l.includes('--no-first-run') || !l.includes('--type='));
      cb({ running: lines.length > 0, processes: lines.length, command: main || null });
    });
  }
  function activityCounts() {
    const now = Date.now();
    const out = {};
    for (const [chId, arr] of Object.entries(stats.channelActivity || {})) {
      // bucket: 5 min and 1 h
      const last5 = arr.filter((t) => now - t < 5 * 60 * 1000).length;
      const last60 = arr.filter((t) => now - t < 60 * 60 * 1000).length;
      out[chId] = { label: channelLabels[chId] || chId, last5m: last5, last1h: last60 };
    }
    return out;
  }

  function jsonStatus(cb) {
    probeServices((services) => {
      probeChrome((chrome) => {
        cb({
          uptime_sec: Math.round((Date.now() - startedAt) / 1000),
          now: new Date().toISOString(),
          services,
          chrome,
          ingest: { connected: getIngestClients() },
          relay:  { consumers: getConsumers() },
          ocr: {
            batches_total: stats.ocrBatches,
            codes_total:   stats.ocrCodesFound,
            text_codes_total: stats.textCodes,
            images_ingested: stats.imagesIngested,
            pending_batches: getPendingBatches(),
            recent_images_dedup_size: getRecentImagesCount(),
            seen_codes_dedup_size:    getSeenCodesCount(),
            budget: getBudget(),
          },
          channels: activityCounts(),
          recent_codes: stats.recentCodes.slice(-20).reverse(),
        });
      });
    });
  }

  const HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Lucid relay — admin</title>
<style>
  :root { --bg:#1e1e1e; --fg:#e0e0e0; --muted:#888; --card:#262626; --ok:#089981; --bad:#c0392b; --warn:#c08a2b; --acc:#3b82f6; }
  body { background:var(--bg); color:var(--fg); font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; margin:0; padding:14px; }
  h1 { font-size:18px; margin:0 0 12px; font-weight:600; }
  h2 { font-size:11px; text-transform:uppercase; letter-spacing:.5px; color:var(--muted); margin:14px 0 6px; font-weight:600; }
  .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(280px,1fr)); gap:10px; }
  .card { background:var(--card); border-radius:6px; padding:10px 12px; font-size:12px; }
  .row { display:flex; justify-content:space-between; padding:3px 0; }
  .row .k { color:var(--muted); }
  .row .v { font-family:ui-monospace,Menlo,monospace; }
  .dot { display:inline-block; width:8px; height:8px; border-radius:50%; margin-right:6px; vertical-align:middle; background:#555; }
  .dot.ok   { background:var(--ok); }
  .dot.bad  { background:var(--bad); }
  .dot.warn { background:var(--warn); }
  pre.log { background:#0f0f0f; color:#cfcfcf; padding:10px; border-radius:6px; font-size:11px; line-height:1.4; max-height:50vh; overflow:auto; margin:0; }
  .small { font-size:10px; color:var(--muted); }
  table { width:100%; border-collapse:collapse; font-size:12px; }
  td { padding:3px 6px; border-bottom:1px solid #333; }
  td.k { color:var(--muted); width:55%; }
  td.v { text-align:right; font-family:ui-monospace,Menlo,monospace; }
  .code { font-family:ui-monospace,Menlo,monospace; font-size:11px; }
  .pill { display:inline-block; padding:1px 6px; border-radius:4px; font-size:10px; background:#333; margin-left:4px; }
</style>
</head>
<body>
<h1>Lucid relay <span class="small" id="uptime"></span></h1>

<div class="grid">
  <div class="card">
    <h2>Services</h2>
    <div id="svc"></div>
  </div>
  <div class="card">
    <h2>Chrome (watcher host)</h2>
    <div id="chrome"></div>
  </div>
  <div class="card">
    <h2>Watcher → Bridge</h2>
    <div id="ingest"></div>
  </div>
  <div class="card">
    <h2>Relay consumers</h2>
    <div id="relay"></div>
  </div>
  <div class="card">
    <h2>OCR</h2>
    <table id="ocr"></table>
  </div>
  <div class="card">
    <h2>Channel activity (msgs from watcher)</h2>
    <table id="channels"></table>
  </div>
</div>

<h2>Recent codes broadcast</h2>
<div class="card"><div id="codes" class="code"></div></div>

<h2>Live log (last 200 lines, refresh every 3 s)</h2>
<pre class="log" id="log">loading…</pre>

<script>
function fmtSecs(s){ if(s<60)return s+'s'; if(s<3600)return Math.floor(s/60)+'m '+(s%60)+'s'; return Math.floor(s/3600)+'h '+Math.floor((s%3600)/60)+'m'; }
function dot(active){ return '<span class="dot '+(active==='active'?'ok':(active==='inactive'?'bad':'warn'))+'"></span>'; }
function escapeHtml(s){return String(s).replace(/[&<>"']/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":"&#39;"}[c]));}

async function refresh() {
  const s = await fetch('api/status').then((r)=>r.json()).catch(()=>null);
  if (!s) return;
  document.getElementById('uptime').textContent = '· up ' + fmtSecs(s.uptime_sec) + ' · ' + new Date(s.now).toLocaleTimeString();

  // services
  const svc = document.getElementById('svc');
  svc.innerHTML = Object.entries(s.services).map(([k,v]) =>
    '<div class="row"><span class="k">'+dot(v)+k+'</span><span class="v">'+v+'</span></div>').join('');

  // chrome
  const ch = document.getElementById('chrome');
  ch.innerHTML =
    '<div class="row"><span class="k">'+dot(s.chrome.running?'active':'inactive')+'process running</span><span class="v">'+(s.chrome.running?'yes':'no')+'</span></div>' +
    '<div class="row"><span class="k">child processes</span><span class="v">'+s.chrome.processes+'</span></div>';

  // ingest
  const ing = document.getElementById('ingest');
  const watcherUp = s.ingest.connected > 0;
  ing.innerHTML =
    '<div class="row"><span class="k">'+dot(watcherUp?'active':'inactive')+'watcher connected</span><span class="v">'+s.ingest.connected+'</span></div>' +
    '<div class="row"><span class="k">images ingested (total)</span><span class="v">'+s.ocr.images_ingested+'</span></div>' +
    '<div class="row"><span class="k">text codes (total)</span><span class="v">'+s.ocr.text_codes_total+'</span></div>';

  // relay
  const rel = document.getElementById('relay');
  if (s.relay.consumers.length === 0) {
    rel.innerHTML = '<div class="row"><span class="k">'+dot('warn')+'no consumers</span></div>';
  } else {
    rel.innerHTML = s.relay.consumers.map((c) =>
      '<div class="row"><span class="k">'+dot('active')+escapeHtml(c.label)+'</span><span class="v">'+escapeHtml(c.ip||'?')+'</span></div>').join('');
  }

  // ocr
  const ocrT = document.getElementById('ocr');
  ocrT.innerHTML =
    '<tr><td class="k">batches sent (total)</td><td class="v">'+s.ocr.batches_total+'</td></tr>' +
    '<tr><td class="k">codes found by OCR</td><td class="v">'+s.ocr.codes_total+'</td></tr>' +
    '<tr><td class="k">pending batches</td><td class="v">'+s.ocr.pending_batches+'</td></tr>' +
    '<tr><td class="k">spend cap (this minute)</td><td class="v">'+s.ocr.budget.minute_used+' / '+s.ocr.budget.minute_cap+'</td></tr>' +
    '<tr><td class="k">spend cap (today UTC)</td><td class="v">'+s.ocr.budget.day_used+' / '+s.ocr.budget.day_cap+'</td></tr>' +
    '<tr><td class="k">image dedup buffer</td><td class="v">'+s.ocr.recent_images_dedup_size+'</td></tr>' +
    '<tr><td class="k">code dedup buffer</td><td class="v">'+s.ocr.seen_codes_dedup_size+'</td></tr>';

  // channels
  const chT = document.getElementById('channels');
  const channels = Object.entries(s.channels);
  if (channels.length === 0) {
    chT.innerHTML = '<tr><td class="k">no activity yet</td><td></td></tr>';
  } else {
    chT.innerHTML = channels.map(([id, c]) => {
      const stale = c.last5m === 0;
      return '<tr><td class="k">'+dot(stale?'bad':'ok')+escapeHtml(c.label)+' <span class="pill">'+id.slice(-6)+'</span></td>' +
             '<td class="v">'+c.last5m+'/5m · '+c.last1h+'/h</td></tr>';
    }).join('');
  }

  // codes
  const codes = document.getElementById('codes');
  if (s.recent_codes.length === 0) {
    codes.innerHTML = '<div class="row"><span class="k">no codes yet</span></div>';
  } else {
    codes.innerHTML = s.recent_codes.map((r) => {
      const age = Math.round((Date.now() - r.at) / 1000);
      return '<div class="row"><span class="v">'+escapeHtml(r.code)+'</span>' +
             '<span class="k">'+escapeHtml(r.source)+' · '+fmtSecs(age)+' ago</span></div>';
    }).join('');
  }
}

async function refreshLog() {
  const l = await fetch('api/logs').then((r)=>r.json()).catch(()=>null);
  if (!l) return;
  const el = document.getElementById('log');
  const wasAtBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 10;
  el.textContent = l.lines.join('\\n');
  if (wasAtBottom) el.scrollTop = el.scrollHeight;
}

refresh(); refreshLog();
setInterval(refresh,   3000);
setInterval(refreshLog, 3000);
</script>
</body>
</html>`;

  const server = http.createServer((req, res) => {
    // Caddy strips /admin prefix before forwarding; we accept both.
    const path = req.url.replace(/^\/admin/, '') || '/';

    if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(HTML);
      return;
    }
    if (req.method === 'GET' && path === '/api/status') {
      jsonStatus((data) => {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(data));
      });
      return;
    }
    if (req.method === 'GET' && path === '/api/logs') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ lines: logRing.slice(-200), total: logRing.length }));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  });

  server.listen(port, '127.0.0.1', () => {
    console.log(`[Admin] Dashboard on http://127.0.0.1:${port} (Caddy /admin/*)`);
  });
  return server;
}

module.exports = { startAdmin };
