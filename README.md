# LucidRedeemer

Automatically harvests promo codes from a Discord channel and redeems them on [lucidtrading.com](https://lucidtrading.com) — hands-free.

---

## How it works

The system has three parts that talk to each other:

```
Discord channel (codes appear here)
        │
        ▼
  [ Bridge Server ]  ← runs on your PC in the background (Node.js)
        │
        ▼
  [ Lucid Redeemer ]  ← Chrome extension
        │
        ▼
  lucidtrading.com  (codes get entered & submitted automatically)
```

- **The Bridge** is a small program that runs in your terminal. It watches Discord for new codes (via the Discord API) and can even read codes out of images using AI (OpenAI GPT-4o). It then forwards those codes to the Chrome extension in real time.
- **Lucid Redeemer** is a Chrome extension that receives the codes and types them into the website automatically.
- **Discord Watcher** (optional) is a second Chrome extension that watches Discord directly inside your browser as a backup channel.

---

## What you need

Before you start, make sure you have the following:

| Requirement | Notes |
|---|---|
| **Google Chrome** | Any recent version works |
| **Node.js** (v18 or newer) | Download at [nodejs.org](https://nodejs.org) — pick the "LTS" version |
| **Discord User Token** | See instructions below |
| **OpenRouter API Key** *(recommended, free)* | Free vision models available — get one at [openrouter.ai/keys](https://openrouter.ai/keys) |
| **OpenAI API Key** *(alternative, paid)* | Higher accuracy — get one at [platform.openai.com](https://platform.openai.com) |

> **OpenRouter vs OpenAI for image OCR:** OpenRouter's `openrouter/free` model automatically routes each request to a free model that fits — no need to pick or test individual models (many are rate-limited). OpenAI's GPT-4o is more accurate but costs money per image. Set `openrouterApiKey` in `config.json` to use the free route — if both keys are set, OpenRouter takes priority. The bridge prints a connection check on startup so you know immediately if the key is valid.

#### About the `openrouter/free` model

This is the OCR engine used to read codes out of images. From [OpenRouter's docs](https://openrouter.ai/openrouter/free):

- **What it is:** `openrouter/free` is a router that picks a free model at random from those available on OpenRouter.
- **Smart filtering:** it automatically narrows to models that support what your request needs — in our case **image understanding (vision)** — so OCR keeps working without you choosing a specific model.
- **OpenAI-compatible API:** OpenRouter uses the same request format as OpenAI (`https://openrouter.ai/api/v1/chat/completions`), which is why the bridge can talk to both with the same code.
- **Rate limits:** free models share a daily request cap per account. If you hit it, OCR pauses until the limit resets — adding a small amount of credit to your OpenRouter account raises the daily cap. See [OpenRouter's limits docs](https://openrouter.ai/docs) for current numbers. Plain-text codes don't use OCR at all, so they're never affected.

### How to get your Discord User Token

> ⚠️ Using a user token for automation violates Discord's Terms of Service. Your account could be banned. Use at your own risk.

**Easy way — Chrome extension (recommended):**

Install [Discord Get User Token](https://chromewebstore.google.com/detail/discord-get-user-token/accgjfooejbpdchkfpngkjjdekkcbnfd) from the Chrome Web Store. Open Discord in your browser, click the extension icon, and it copies your token with one click.

**Manual way — Developer Tools:**

1. Open Discord in your **browser** (not the desktop app)
2. Press `F12` to open Developer Tools
3. Go to the **Network** tab
4. Press `Ctrl+R` to reload the page
5. In the filter box, type `api`
6. Click on any request that appears, go to **Headers**, and look for `Authorization` under "Request Headers"
7. Copy that value — that's your token

### How to get an OpenRouter API Key (recommended, free)

1. Go to [openrouter.ai/keys](https://openrouter.ai/keys)
2. Sign in (Google/GitHub login works)
3. Click **"Create Key"**, give it any name, and copy the key
4. Paste it into `openrouterApiKey` in `config.json`

### How to get an OpenAI API Key (alternative, paid)

1. Go to [platform.openai.com/api-keys](https://platform.openai.com/api-keys)
2. Log in or create an account
3. Click **"Create new secret key"**
4. Copy the key (you won't see it again)

---

## Installation

### Step 1 – Install Node.js

1. Go to [nodejs.org](https://nodejs.org) and download the **LTS** installer
2. Run the installer and click through (all defaults are fine)
3. Verify it worked: open a terminal (search "cmd" on Windows or "Terminal" on Mac) and type:
   ```
   node --version
   ```
   You should see something like `v20.x.x`.

### Step 2 – Download this repo

Either clone it with Git:
```bash
git clone https://github.com/danyecro/LucidRedeemer.git
cd LucidRedeemer
```

Or click the green **Code** button on GitHub → **Download ZIP** and unzip it somewhere easy to find (e.g. your Desktop).

### Step 3 – Configure the Bridge

1. Open the `lucid_discord_bridge` folder
2. Copy `config.example.json` and rename the copy to `config.json`
3. Open `config.json` with any text editor (Notepad works) and fill in your values:

```json
{
  "token": "YOUR_DISCORD_USER_TOKEN",
  "channelIds": ["123456789012345678"],
  "codePattern": "LBOX-[A-Z0-9]{18}",
  "port": 3847,

  "watchUserId": "",
  "watchNames": ["leothetiger", "leo", "LeoTheTiger"],
  "watchAll": false,

  "openrouterApiKey": "sk-or-...",
  "openrouterModel": "openrouter/free",

  "openaiApiKey": "",
  "openaiModel": "gpt-4o"
}
```

| Field | What to put here |
|---|---|
| `token` | Your Discord user token (from Step above) |
| `channelIds` | The ID of the Discord channel to watch. Right-click the channel in Discord → **Copy Channel ID** (you need Developer Mode on in Discord settings) |
| `codePattern` | Leave as-is unless codes have a different format |
| `port` | Leave as-is (`3847`) |
| `watchUserId` | **Who to watch.** The Discord user ID of the person who drops codes (right-click them → **Copy User ID**). This is the most reliable filter — only their messages are processed |
| `watchNames` | **Fallback if `watchUserId` is empty or doesn't match.** A list of possible display names (case-insensitive). Defaults to Leo's known names |
| `watchAll` | Set to `true` to process codes from **everyone** in the channel (ignores `watchUserId`/`watchNames`) |
| `openrouterApiKey` | **Recommended (free)** — your OpenRouter key. If set, this is used for image OCR instead of OpenAI |
| `openrouterModel` | Leave as-is (`openrouter/free`) — auto-routes to whichever free vision model is available |
| `openaiApiKey` | Your OpenAI key — only used if `openrouterApiKey` is empty |
| `openaiModel` | Leave as-is (`gpt-4o`) |

> **How the author filter works:** the bridge processes a message if `watchUserId` matches the sender **OR** the sender's name is in `watchNames`. The user ID is checked first because it never changes; names are the fallback for when you don't have the ID. Set `watchAll: true` to disable filtering entirely.

### Step 4 – Start the Bridge

Open a terminal **in the `lucid_discord_bridge` folder** and run:

```bash
npm install
node index.js
```

**Windows tip:** Right-click inside the `lucid_discord_bridge` folder while holding Shift → "Open PowerShell window here", then type the two commands above.

You should see something like:
```
WebSocket server running on port 3847
[OpenRouter] Connected ✓  model: openrouter/free  ($0.0000 remaining)
[Discord] Logged in as YourName#0000
[Discord] Watching 1 channel(s): 123456789012345678
[Discord] Author filter: id="-" names=[leothetiger, leo]
```

If the OpenRouter line shows an error, double-check your `openrouterApiKey`. The "Author filter" line confirms whose messages will be processed.

> Keep this terminal window open while using the extensions. If you close it, the bridge stops.

### Step 5 – Load the Chrome extensions

You need to load two unpacked extensions into Chrome:

1. Open Chrome and go to `chrome://extensions/`
2. Enable **Developer mode** — toggle in the top-right corner
3. Click **"Load unpacked"**
4. Navigate to the `lucid_redeemer` folder inside this project and click **Select Folder**
5. Repeat steps 3–4 for the `discord_watcher` folder (optional — only needed if you also want the browser-based Discord watcher)

### Step 6 – Open your tabs in separate windows

For best results, keep Discord and Lucid Trading in **two separate Chrome windows** (not just two tabs in the same window):

- **Window 1** — open `discord.com` and navigate to the channel you're watching
- **Window 2** — open `https://dash.lucidtrading.com/#/promo`

This way the Lucid Redeemer extension always has a visible Lucid tab to work with, even when you switch focus to the Discord window.

### Step 7 – Verify everything is connected

Click the **Lucid Redeemer** extension icon in your Chrome toolbar. You should see a **green dot** next to "Bridge". If it's red, the bridge server isn't running — go back to Step 4.

---

## The Extensions explained

### Lucid Redeemer (`lucid_redeemer/`)

The main extension. It:
- Connects to the bridge and waits for incoming codes
- Automatically navigates to lucidtrading.com and enters the codes
- Lets you set a delay between codes (to avoid being too fast)
- Has an optional shuffle mode
- Shows a live log of what it's doing
- **Auto Relogin**: if your Lucid session expires mid-run, the extension can automatically sign you back in and navigate back to the promo page. Enable this in the popup and enter your Lucid e-mail and password (stored locally in Chrome, never sent anywhere).

You can also paste codes manually in the popup and click **Add to queue**.

### Discord Watcher (`discord_watcher/`) — Optional

A second way to capture codes. Instead of the bridge reading Discord in the background, this extension monitors Discord directly inside your browser tab. Useful as a fallback or if you prefer not to use a Discord user token in the bridge.

Click its icon to configure:
- **Channel ID** — the channel to watch
- **Code regex** — leave blank to use the default `LBOX-[A-Z0-9]{18}`
- **Watch user ID** — the Discord user ID of the code dropper (most reliable). Right-click the user → **Copy User ID**
- **Fallback names** — comma-separated display names, used only when no user ID matches (defaults to Leo's known names)
- **Watch all images** — process every image in the channel, ignoring the user/name filter

Just like the bridge, the watcher accepts a message if the **user ID matches OR a fallback name matches**.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| Bridge won't start | Make sure Node.js is installed (`node --version` in terminal) |
| "Cannot find module 'ws'" | Run `npm install` inside `lucid_discord_bridge/` |
| Red dot in extension popup | The bridge server isn't running — start it with `node index.js` |
| Code isn't being entered | Try increasing the delay in the popup (default 2000 ms) |
| Discord connection fails | Your token may be wrong or expired — re-copy it from the browser |
| No codes coming through | Double-check your `channelIds` — use **Copy Channel ID** from Discord |
