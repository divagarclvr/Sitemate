# SiteMate — setup guide (no coding experience needed)

SiteMate is your personal site-meeting assistant. This guide explains **every step and
every command**. Everything used is **free** — no credit card needed anywhere.

How it fits together:

- **The app** runs on your Android phone.
- **The server** is a small program that talks to the AI. It runs on your PC while you're
  testing, and on Render (free hosting) later.
- **Supabase** (free) stores your notes and handles login.
- **Gemini** (Google, free) and **Groq** (free) provide the AI.

> **Privacy note:** on the free plan Google may use what you send to Gemini to improve
> its products. Avoid sending anything you would not want a Google reviewer to see. You
> can switch to a paid AI later with one setting.

---

## How to run a command

Wherever this guide shows a grey box like this:

```bash
npm install
```

1. Open **Command Prompt**: press the Windows key, type `cmd`, press Enter.
2. Go to the SiteMate folder by typing this and pressing Enter:
   ```bash
   cd /d "D:\Aratt Alchemy Essence\sitemate"
   ```
   (`cd` means "change folder"; `/d` lets it switch drives.)
3. Type the command from the grey box and press Enter.

---

## Phase 1 — accounts, database, server, login and AI test

### Step 1. One-time tools on your PC (already done on this PC)

- **Node.js 22 or newer** (runs the server). Check it by running `node -v`. It should print
  `v22…` or higher. If it doesn't, install the "LTS" version from https://nodejs.org.
- **Expo Go** app on your Android phone, from the Play Store.

### Step 2. Download the project's building blocks

```bash
npm install
```
*This downloads the libraries the app and server need into a `node_modules` folder.
It takes a few minutes and only has to be run again when a new phase adds libraries.*

### Step 3. Create your free Supabase project (database + login)

1. Go to https://supabase.com, choose **Start your project**, and sign in with GitHub or email.
2. Choose **New project**:
   - Name: `sitemate`
   - Database password: click **Generate**, then **copy it into a safe place** (you'll need it once).
   - Region: **South Asia (Mumbai)**
   - Plan: **Free**
3. Wait about 2 minutes while it's created.
4. **Create the tables:** open **SQL Editor** in the left menu and choose **New query**.
   Open the file `supabase\migrations\0001_init.sql` in Notepad, copy everything,
   paste it into the editor, and click **Run**. It should say *Success. No rows returned*.
5. **Make the login email send a 6-digit code:** go to **Authentication → Emails (Templates)**.
   In both the **Magic Link** and **Confirm signup** templates, replace the body with:
   ```
   <h2>Your SiteMate code</h2>
   <p>{{ .Token }}</p>
   ```
   and click **Save**.
   *(Supabase's free email service sends only a few emails per hour. If a code
   doesn't arrive, wait a few minutes before asking again.)*
6. **Collect these values** for Step 5:
   - **Project URL:** Project Settings → Data API (looks like `https://abcd.supabase.co`)
   - **Publishable key:** Project Settings → API Keys (starts with `sb_publishable_`)
   - **Database connection string:** click **Connect** at the top → **Transaction pooler**
     → copy the URI, then replace `[YOUR-PASSWORD]` with the password from step 2.

### Step 4. Get your free AI keys

- **Gemini:** go to https://aistudio.google.com, sign in with your Google account, click
  **Get API key → Create API key**, and copy it.
- **Groq** (backup AI, and speech-to-text from Phase 2): go to https://console.groq.com,
  sign up, open **API Keys → Create API Key**, and copy it.

### Step 5. Fill in the settings files

1. In the folder `apps\api`, copy `.env.example` and rename the copy to `.env`.
   Open it in Notepad and fill in `DATABASE_URL`, `SUPABASE_URL`, `ALLOWED_EMAILS`
   (your email), `GEMINI_API_KEY` and `GROQ_API_KEY`.
2. In the folder `apps\mobile`, copy `.env.example`, rename it to `.env`, and fill in:
   - `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (from Step 3)
   - `EXPO_PUBLIC_API_BASE_URL`: your PC's address on Wi-Fi. To find it, run `ipconfig`
     and look for **IPv4 Address** under your Wi-Fi adapter (for example `192.168.1.10`).
     Then write `http://192.168.1.10:8080`.

> **Windows tip:** if Notepad saves the file as `.env.txt`, choose **Save as type: All files**.
> `.env` files hold your secret keys. Never send them to anyone or upload them.

### Step 6. Start the server (keep this window open)

```bash
npm run api
```
*This starts the SiteMate server on your PC, on port 8080. When it's ready you'll see
`Server listening at http://0.0.0.0:8080`. If Windows asks whether to allow Node.js
on the network, choose **Private networks → Allow**.*

If you see *"Your apps/api/.env file has problems"*, the message lists exactly which
line to fix.

### Step 7. Start the app (open a second Command Prompt window)

```bash
cd /d "D:\Aratt Alchemy Essence\sitemate"
```
```bash
npm run mobile
```
*This starts Expo, which sends the app to your phone. A QR code appears.*

On your phone, **connect to the same Wi-Fi as the PC**, open **Expo Go**, and scan the QR code.

### Step 8. Test it on your phone

1. Enter your email, then tap **Send code**.
2. Type the 6-digit code from the email, then tap **Sign in**. You'll see 5 tabs: Today · Record · Notes · Chat · More.
3. Open **More** and tap **Check server**. You should see ✅ *Server is running*.
4. Tap **Test AI**. You should see ✅ for **Main AI (Gemini)** and **Backup AI (Groq)**,
   each replying with "steel bar" written in Tamil, Kannada, Telugu, Malayalam and Hindi.

**If something fails:**

| Message | What to do |
|---|---|
| *Can't reach the SiteMate server* | Make sure the server window from Step 6 is still open, the phone is on the same Wi-Fi, and the IP address in `apps\mobile\.env` is correct. Office Wi-Fi often blocks phone-to-PC traffic; try your home Wi-Fi or phone hotspot. |
| *…is not allowed to use this SiteMate server* | Put that exact email in `ALLOWED_EMAILS` in `apps\api\.env`, then restart the server (Ctrl+C, then `npm run api`). |
| ❌ Main AI, with "API key not valid" | Check `GEMINI_API_KEY` in `apps\api\.env`. |
| ❌ Main AI, with "model not found" | Google renamed the model. In AI Studio, check the list of free models and update `GEMINI_MODEL`. |
| App settings missing (red box) | Fill in `apps\mobile\.env`, then restart Expo with `npx expo start --clear`. |

### Step 9 (optional now, needed by Phase 5). Put the server online, free

Once you do this, the app works anywhere, not just on your Wi-Fi.

1. Create a free GitHub account at https://github.com, create a **private** repository
   called `sitemate`, and upload this folder. I can do the upload for you when you're ready.
2. Go to https://render.com, sign up with GitHub, then choose **New → Blueprint** and pick the repo.
   Render reads `render.yaml` and asks for the secret values (the same ones from `apps\api\.env`).
3. When it finishes, Render shows an address like `https://sitemate-api.onrender.com`.
   Put that into `EXPO_PUBLIC_API_BASE_URL` in `apps\mobile\.env`.
4. The free server sleeps after 15 minutes without use, so the first request after that
   takes 30–60 seconds. That's normal.

---

## Commands reference

| Command | What it does |
|---|---|
| `npm install` | Downloads or updates the libraries |
| `npm run api` | Starts the server on your PC (restarts itself when files change) |
| `npm run mobile` | Starts Expo so your phone can load the app |
| `npm test` | Runs the automatic checks for the server (they should all pass) |
| `npm run typecheck` | Checks the code for mistakes without running it |

## Where things are

- `CLAUDE.md`: the full technical design (architecture, database, API, phases)
- `apps/api`: the server
- `apps/mobile`: the phone app
- `packages/shared`: definitions used by both
- `supabase/migrations`: database setup scripts
