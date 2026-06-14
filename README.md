# LucidRedeemer

Automatically harvests promo codes from a Discord channel and redeems them on [lucidtrading.com](https://lucidtrading.com) — hands-free.

---

## How it works

The system has three parts that talk to each other:

```
Discord channel (codes appear here)
        │   ← read inside your own browser tab by…
        ▼
  [ Discord Watcher ]   ← Chrome extension (reads the open Discord tab)
        │
        ▼
  [ Bridge Server ]     ← runs on your PC (Node.js): relays codes + OCRs images
        │
        ▼
  [ Lucid Redeemer ]    ← Chrome extension
        │
        ▼
  dash.lucidtrading.com  (codes get entered & submitted automatically)
```

- **Discord Watcher** is a Chrome extension that reads the Discord channel directly inside your own logged-in browser tab — **no bot, no token**. It detects new codes (text and images) and sends them to the bridge.
- **The Bridge** is a small program that runs in your terminal. It relays codes to the redeemer and reads codes out of any images using AI (OpenRouter's free vision model, or OpenAI). **It never connects to Discord itself.**
- **Lucid Redeemer** is a Chrome extension that receives the codes and types them into the website automatically.

---

## What you need

Before you start, make sure you have the following:

| Requirement | Notes |
|---|---|
| **Google Chrome** | Any recent version works |
| **A Discord account** | Just stay logged into Discord in Chrome — the watcher reads the open page, **no token or bot needed** |
| **Node.js** (v18 or newer) | Download at [nodejs.org](https://nodejs.org) — pick the "LTS" version |
| **OpenRouter API Key** *(recommended, free)* | Free vision models available — get one at [openrouter.ai/keys](https://openrouter.ai/keys) |
| **OpenAI API Key** *(alternative, paid)* | Higher accuracy — get one at [platform.openai.com](https://platform.openai.com) |

> **OpenRouter vs OpenAI for image OCR:** OpenRouter's `openrouter/free` model automatically routes each request to a free model that fits — no need to pick or test individual models (many are rate-limited). OpenAI's GPT-4o is more accurate but costs money per image. Set `openrouterApiKey` in `config.json` to use the free route — if both keys are set, OpenRouter takes priority. The bridge prints a connection check on startup so you know immediately if the key is valid.

#### About the `openrouter/free` model

This is the OCR engine used to read codes out of images. From [OpenRouter's docs](https://openrouter.ai/openrouter/free):

- **What it is:** `openrouter/free` is a router that picks a free model at random from those available on OpenRouter.
- **Smart filtering:** it automatically narrows to models that support what your request needs — in our case **image understanding (vision)** — so OCR keeps working without you choosing a specific model.
- **OpenAI-compatible API:** OpenRouter uses the same request format as OpenAI (`https://openrouter.ai/api/v1/chat/completions`), which is why the bridge can talk to both with the same code.
- **Rate limits:** free models share a daily request cap per account. If you hit it, OCR pauses until the limit resets — adding a small amount of credit to your OpenRouter account raises the daily cap. See [OpenRouter's limits docs](https://openrouter.ai/docs) for current numbers. Plain-text codes don't use OCR at all, so they're never affected.

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
  "port": 3847,

  "openrouterApiKey": "YOUR_OPENROUTER_API_KEY",
  "openrouterModel": "openrouter/free",

  "openaiApiKey": "",
  "openaiModel": "gpt-4o"
}
```

| Field | What to put here |
|---|---|
| `port` | Leave as-is (`3847`) |
| `openrouterApiKey` | **Recommended (free)** — your OpenRouter key. If set, it's used for image OCR instead of OpenAI |
| `openrouterModel` | Leave as-is (`openrouter/free`) — auto-routes to whichever free vision model is available |
| `openaiApiKey` | Your OpenAI key — only used if `openrouterApiKey` is empty |
| `openaiModel` | Leave as-is (`gpt-4o`) |

> **That's all the bridge needs.** Which channel to watch and whose messages to redeem are configured in the **Discord Watcher extension** (its popup), not here — see [The Extensions explained](#the-extensions-explained) below.

### Step 4 – Start the Bridge

Open a terminal **in the `lucid_discord_bridge` folder** and run:

```bash
npm install
node index.js
```

**Windows tip:** Right-click inside the `lucid_discord_bridge` folder while holding Shift → "Open PowerShell window here", then type the two commands above.

You should see something like:
```
[WS] Server listening on ws://localhost:3847
[OpenRouter] Connected ✓  model: openrouter/free  (credits unknown)
```

If the OpenRouter line shows an error, double-check your `openrouterApiKey`. The bridge now just waits for the extensions to connect.

> Keep this terminal window open while using the extensions. If you close it, the bridge stops.

### Step 5 – Load the Chrome extensions

You need to load two unpacked extensions into Chrome:

1. Open Chrome and go to `chrome://extensions/`
2. Enable **Developer mode** — toggle in the top-right corner
3. Click **"Load unpacked"**
4. Navigate to the `lucid_redeemer` folder inside this project and click **Select Folder**
5. Repeat steps 3–4 for the `discord_watcher` folder

Both are needed for the automatic pipeline: **Discord Watcher** captures the codes from Discord, **Lucid Redeemer** redeems them. (If you only ever paste codes by hand, you can skip the watcher.) After loading the watcher, click its icon and configure it — see [Discord Watcher](#discord-watcher-discord_watcher) below.

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
- Automatically navigates to https://dash.lucidtrading.com/#/promo and enters the codes
- Lets you set a delay between codes (to avoid being too fast)
- Has an optional shuffle mode
- Shows a live log of what it's doing
- **Auto Relogin**: if your Lucid session expires mid-run, the extension can automatically sign you back in and navigate back to the promo page. Enable this in the popup and enter your Lucid e-mail and password (stored locally in Chrome, never sent anywhere) or make sure they are stored in chrome and 'remember me' is checked.

You can also paste codes manually in the popup and click **Add to queue**.

### Discord Watcher (`discord_watcher/`)

This is what reads Discord. It runs **inside your normal, logged-in Discord tab** and watches the channel directly — there's no bot and no token, so nothing logs in on your behalf. It detects new codes (plain text and images) and forwards them to the bridge.

> ⚠️ Reading Discord automatically is still against Discord's Terms of Service. To be safe, consider using a **separate Discord account** for this.

Click its icon to configure:
- **Channel ID** — the channel to watch. Right-click the channel → **Copy Channel ID** (enable Developer Mode in Discord settings first). For Lucid this is the main chat: `1344026694691848274`.
- **Code regex** — leave blank to use the default `LBOX-[A-Z0-9]{18}`
- **Watch user ID** — the Discord user ID of the code dropper (most reliable, never changes). Right-click the user → **Copy User ID**. Leo's ID is `447807863990255617` — leave this as-is to watch him.
- **Fallback names** — comma-separated display names, used only when no user ID matches (defaults to Leo's known names). You can add your **own** name here temporarily to test the pipeline by posting a fake code.
- **Watch all images** — process every image in the channel, ignoring the user/name filter

The watcher captures a message if the **user ID matches OR a fallback name matches**.

> 🚫 **Testing warning:** to test, post a *fake* code (not matching `LBOX-[A-Z0-9]{18}`) in the channel. **Never post a real-looking `LBOX-…` code in the Lucid main chat — you'll get banned.**

---

## Troubleshooting

| Problem | Fix |
|---|---|
| Bridge won't start | Make sure Node.js is installed (`node --version` in terminal) |
| "Cannot find module 'ws'" | Run `npm install` inside `lucid_discord_bridge/` |
| Red dot in extension popup | The bridge server isn't running — start it with `node index.js` |
| Code isn't being entered | Try increasing the delay in the popup (default 2000 ms) |
| No codes coming through | Make sure the Discord tab is open on the right channel, and check the **Channel ID** / **Watch user ID** in the Discord Watcher popup |
| Images aren't being read | Check the bridge terminal for `[OCR]` errors — usually a missing/invalid `openrouterApiKey`, or the free daily limit was hit |
