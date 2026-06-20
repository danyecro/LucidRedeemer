# AWS deploy — Lucid relay on a single Ubuntu VM

End state: one EC2 instance running an XFCE desktop with Chrome (logged in to Discord, watching the channels with the `discord_watcher` extension) plus the Node bridge and Caddy. Everything reachable from the outside is `wss://relay.YOURDOMAIN` — end-users only need the `lucid_redeemer` extension and an access code.

> Tested for Ubuntu 24.04 LTS on a `t3.large`/`t3.xlarge`. The pipeline runs comfortably on 8 GB RAM with 3 Discord tabs open.

---

## 0. EC2 + Networking

- Launch Ubuntu 24.04, 30+ GB gp3 root volume, key-pair you control.
- **Security Group**: inbound `22/tcp` (your IP only), `80/tcp` + `443/tcp` (anywhere — needed for Let's Encrypt + the relay), `5901/tcp` (your IP only — for VNC) — nothing else.
- **DNS**: A-record `relay.yourdomain.com` → EC2 public IP. Wait for propagation (`dig +short relay.yourdomain.com` should show the IP) before installing Caddy.

```bash
ssh ubuntu@<EC2_IP>
sudo apt update && sudo apt -y upgrade
```

---

## 1. XFCE desktop + VNC

```bash
sudo apt install -y xubuntu-desktop-minimal dbus-x11 tigervnc-standalone-server
```

Set a VNC password and a minimal `xstartup` so XFCE actually launches:

```bash
mkdir -p ~/.vnc
vncpasswd                                  # set a strong password
cat > ~/.vnc/xstartup <<'EOF'
#!/bin/sh
unset SESSION_MANAGER
unset DBUS_SESSION_BUS_ADDRESS
exec startxfce4
EOF
chmod +x ~/.vnc/xstartup

# Disable the screen locker — otherwise Discord/Chrome lose focus while you
# are not connected over VNC, and the watcher stops seeing new messages.
xfconf-query -c xfce4-screensaver -p /lock/enabled -s false || true
xfconf-query -c xfce4-screensaver -p /saver/enabled -s false || true

# Start the VNC server on :1 (port 5901).
vncserver :1 -geometry 1920x1080 -localhost no
```

Connect from your laptop with any VNC client (TigerVNC, RealVNC) to `<EC2_IP>:5901`.

---

## 2. Google Chrome

```bash
wget -qO- https://dl.google.com/linux/linux_signing_key.pub | sudo gpg --dearmor -o /usr/share/keyrings/google.gpg
echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google.gpg] https://dl.google.com/linux/chrome/deb/ stable main" | sudo tee /etc/apt/sources.list.d/google-chrome.list
sudo apt update && sudo apt install -y google-chrome-stable
```

In the XFCE session, launch Chrome with GPU off (EC2 has no GPU; software rendering is what we want):

```bash
google-chrome --disable-gpu --disable-software-rasterizer
```

Sign in to Discord (use a **dedicated account** for this — using your real account for automated reading still violates Discord ToS). Open the three channels you want to watch, each in its own tab.

---

## 3. Node 20 + the bridge

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs git
git clone https://github.com/danyecro/LucidRedeemer.git ~/lucid
cd ~/lucid/lucid_discord_bridge
npm install --omit=dev

cp config.example.json config.json
# Edit config.json:
#   authToken: long random string — this becomes the "admin" token in tokens.json
#   openrouterApiKey: your OpenRouter key (free model is fine)
#   shareWebhookUrl + channelLabels: optional, for the aggregation channel
nano config.json
```

Issue a token for the first end-user:

```bash
node manage-tokens.js add "first-user" 30   # 30-day expiry; omit for never
node manage-tokens.js list
```

Install the systemd unit so the bridge auto-starts on reboot:

```bash
sudo cp ~/lucid/deploy/lucid-bridge.service /etc/systemd/system/lucid-bridge.service
sudo sed -i "s|__USER__|$USER|g; s|__DIR__|$HOME/lucid/lucid_discord_bridge|g" \
  /etc/systemd/system/lucid-bridge.service
sudo systemctl daemon-reload
sudo systemctl enable --now lucid-bridge
sudo journalctl -u lucid-bridge -f       # follow the log; expect:
                                          # [Ingest] Listening on ws://127.0.0.1:3847
                                          # [Relay]  Listening on ws://0.0.0.0:8080
```

---

## 4. Caddy (auto-TLS reverse proxy)

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy

sudo cp ~/lucid/deploy/Caddyfile /etc/caddy/Caddyfile
# Replace relay.example.com with your real subdomain:
sudo sed -i "s|relay.example.com|relay.YOURDOMAIN.com|g" /etc/caddy/Caddyfile
sudo systemctl reload caddy
sudo journalctl -u caddy -f      # expect "obtained certificate" within ~30s
```

Caddy listens on 80/443, fetches the Let's Encrypt cert, and proxies `wss://relay.YOURDOMAIN.com` → `127.0.0.1:8080`.

---

## 5. Load the watcher extension in Chrome (on the VM)

Inside the XFCE session, in the same Chrome that's logged into Discord:

1. `chrome://extensions` → enable Developer mode → **Load unpacked** → pick `~/lucid/discord_watcher`.
2. Click the watcher icon → fill in:
   - **Channel IDs**: the three channel IDs you watch
   - **Watch user ID**: the dropper's Discord ID
   - leave **Fallback names** as-is unless he renames
   - **Watch all senders**: OFF for source channels; ON only for a relay/webhook channel
   - **Read inline code spans**: ON
3. Make sure the three Discord tabs stay open.

The bridge log should now show `[Ingest] Watcher connected` and `[Ingest] N code(s) from channel …` whenever Leo drops.

---

## 6. End-user setup (each person you give a token to)

They install the `lucid_redeemer` extension and the popup:

- **Mode**: "Use relay server"
- **Server URL**: `wss://relay.YOURDOMAIN.com`
- **Auth code**: whatever you generated with `manage-tokens.js add`
- Open `https://dash.lucidtrading.com/#/promo` in a tab — that's it.

When a drop happens, `[Relay] broadcast … -> N consumer(s)` appears in the bridge log; the user's extension queues the codes and redeems them with the configured delay.

---

## Operations cheat sheet

```bash
# Issue / revoke tokens
node ~/lucid/lucid_discord_bridge/manage-tokens.js list
node ~/lucid/lucid_discord_bridge/manage-tokens.js add "<label>" [days]
node ~/lucid/lucid_discord_bridge/manage-tokens.js revoke "<label>"

# Service control
sudo systemctl restart lucid-bridge
sudo journalctl -u lucid-bridge -f
sudo systemctl reload caddy
sudo journalctl -u caddy -f

# Update the bridge after a git pull
cd ~/lucid && git pull && cd lucid_discord_bridge && npm install --omit=dev
sudo systemctl restart lucid-bridge
```

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| Relay clients get `close 4001` | token revoked or missing — re-check with `manage-tokens.js list` |
| Caddy can't get a cert | DNS A-record not propagated, or port 80 blocked in the Security Group |
| Watcher connects but no codes flow | wrong channel IDs in the watcher popup, or wrong sender filter — check Chrome DevTools console on the Discord tab |
| OCR returns garbage / 5↔S | OpenRouter free model variance — switch `openrouterModel` to a paid alternative, or set `openaiApiKey` (GPT-4o is more accurate) |
| Bridge crash loop | `journalctl -u lucid-bridge -n 200` — usually missing `config.json` or a parse error |

## Scaling later (not now)

When you want redundancy or region spread:
- Spin up a second VM in another region, same setup, **own subdomain** (`relay-eu`, `relay-us`, …). End-users can switch URLs.
- Or have one central relay VM and treat the watcher VMs as remote ingest clients — then `INGEST_PORT` needs an auth layer too. We can design that when you actually need it.
