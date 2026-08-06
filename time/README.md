# Linear Time — the day tracker

A small, friendly app that greets each worker in the morning, asks what they're
working on, quietly checks in every 30 minutes ("still on this, or something
else?"), and turns the whole day into a tidy timesheet — task, from-time,
to-time, duration, total — that managers can read at **time.linearit.co**.

It's built the same way as the Vault: the app lives once in this repo under
`/time/`, and the `linear-time` Worker (in `../time-worker/`) serves it at
**time.linearit.co** and stores the data in Cloudflare D1.

- **App (this folder):** `index.html`, `app.js`, `sw.js`, `manifest.webmanifest`, `assets/`
- **Backend + deploy:** see [`../time-worker/README.md`](../time-worker/README.md)

---

## How a worker's day flows

1. **Good morning.** The app opens and greets them, then asks for the first task.
   Three quick tiles — **🍳 Breakfast**, **🏃 Exercise**, **☕ Break** — plus a box
   to type anything else.
2. **Once-a-day tiles.** As soon as a tile is used it disappears for the rest of
   the day. Log breakfast once and it won't ask again until tomorrow. Typed tasks
   have no limit.
3. **The clock runs.** A big timer shows how long the current task has taken. Two
   buttons are always there: **Switch task** and **End task**.
4. **The 30-minute nudge.** Half an hour in, a gentle pop-up (and a desktop
   notification) asks *"Still on this task?"* → **Yes, keep going** resets the
   timer for another 30 minutes; **No** ends it and asks what's next.
5. **End → what's next?** The moment a task ends, the app immediately asks for the
   name of the next one. Nothing to remember.
6. **After 5 PM: wrap up.** From 5:00 PM on, the app asks whether to wrap up the
   day. There's also an **End day** button available at all times. Ending the day
   closes any running task and shows a short summary — and they can **Start working
   again** any time to reopen it.
7. **Midnight is handled.** If a task is still running when the date changes, it's
   closed automatically and the next morning starts fresh.

**Sign in once, ever.** After the first setup on a computer, the session is kept
indefinitely — the worker never sees the sign-in screen again on that machine
(unless they sign out).

**Reminders reach them even when the app is closed.** With reminders enabled, the
server pushes the 30-minute check-in and the after-5pm wrap-up to the installed
app in the background — the app window doesn't need to be open (the browser just
needs its normal background process running, which installed apps keep).

Everything is timestamped on the server, so the timesheet is exact even if the
computer sleeps or the app is closed and reopened.

---

## Roles

| Role | Granted by | Sees |
|---|---|---|
| **Super admin** | being in the `ADMIN_EMAILS` secret | all companies + management |
| **Company admin** | a super admin (Reports → Admins tab) | one company's reports |
| **Worker** | signing in with email + a company join code | their own tracker |

Sign-in is always **email + a 6-digit code** — no passwords.

---

## Setup, start to finish

### 1. Deploy the backend (once)
Follow [`../time-worker/README.md`](../time-worker/README.md). In short: create the
D1 database, set the four secrets (`AUTH_SECRET`, `RESEND_API_KEY`, `EMAIL_FROM`,
`ADMIN_EMAILS` = your email), then — to get background reminders when the app is
closed — generate and set the push keys (`node gen-vapid.mjs`, then
`VAPID_PUBLIC` / `VAPID_PRIVATE_JWK` / `VAPID_SUBJECT`), and `npx wrangler deploy`.
The `/time/` app is already live on GitHub Pages, so there's nothing else to build.
(If you skip the VAPID keys, everything still works — reminders just need the app
to be open.)

### 2. First sign-in as super admin
1. Open **https://time.linearit.co** and sign in with the email you put in
   `ADMIN_EMAILS`. You'll land on the **Reports** dashboard.
2. Go to the **Companies** tab → **Create + get code**. Each company gets a short
   **join code** (e.g. `K7QMP4`). Create one per company you support.
3. (Optional) **Admins** tab → appoint a manager's email to a company. They'll
   sign in with their own email and see only that company's reports.

### 3. Onboard a worker (do this once per computer)
1. Send them their **company join code**.
2. On their computer, open **https://time.linearit.co**, and **install it as an
   app** (see the next section — this is also what makes it launch at login).
3. First launch: they enter their **email**, get a 6-digit code, and type their
   **name + company code**. Done — from then on it's just email + code, and the
   token keeps them signed in for the day.

### 4. Read the timesheets (end of day)
Open **time.linearit.co** → **Reports** → pick the **date** (and optionally a
person) → **Load**. You'll see, per person: every task with its start, end and
duration, a subtotal, and a grand total. **Export CSV** downloads it as a
spreadsheet.

---

## Make it open automatically when the computer starts

Installing Linear Time as an app gives it its own window (no browser tabs, no
address bar) and is what lets it auto-start at login.

### Windows — Microsoft Edge (recommended, has a built-in toggle)
1. Open **https://time.linearit.co** in Edge.
2. Click the **install icon** in the address bar (a monitor with a ⤓), or
   **⋯ menu → Apps → Install this site as an app** → **Install**.
3. Open **`edge://apps`**, right-click **Linear Time**, and turn on
   **"Start app when you sign in to your computer."**

That's it — it launches into the morning greeting every time they log in.

### Windows — Google Chrome
1. Open the site in Chrome → **⋮ menu → Cast, save, and share → Install page as
   app** (or the install icon in the address bar) → **Install**.
2. Add it to startup: press **Win + R**, type **`shell:startup`**, Enter. Copy the
   **Linear Time** shortcut Chrome created (Start menu → right-click → Open file
   location) into that Startup folder.

### Windows — mass rollout (many workers, via GPO / Intune / a login script)
Drop a shortcut (or run this command) in each user's Startup so it opens as an app
window at login — no install click needed:

```bat
"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --app=https://time.linearit.co/
```
or with Chrome:
```bat
"C:\Program Files\Google\Chrome\Application\chrome.exe" --app=https://time.linearit.co/
```
Push it via **Group Policy** (User Config → Preferences → Windows Settings →
Shortcuts, target = the Startup folder) or an **Intune** platform script. Workers
still sign in once with their email + company code the first time.

### macOS — Chrome or Edge
1. Open the site → **⋮/⋯ menu → … → Install Linear Time** → **Install**.
2. **System Settings → General → Login Items → +** and add **Linear Time**.
   (Or, once it's open, right-click its **Dock** icon → **Options → Open at
   Login**.)

### iPhone / iPad / Android (optional)
Open the site → **Share → Add to Home Screen** (iOS) or **Install app**
(Android). It runs full-screen like a native app.

---

## Notifications & background reminders

The first time a worker opens the tracker, a banner offers to **Enable**
reminders. Tapping **Enable** does two things:

1. Shows the 30-minute check-in and after-5pm wrap-up as desktop notifications
   while the app is open (even behind other windows).
2. **Subscribes the device to Web Push**, so the Worker's cron (every 5 minutes)
   can deliver those same nudges **even when the app window is fully closed**.

For (2) to work when the app is closed, two things must be true:

- **Push keys are set on the Worker** (`VAPID_PUBLIC` / `VAPID_PRIVATE_JWK` /
  `VAPID_SUBJECT` — see setup step 1). Without them the cron runs but sends
  nothing, and reminders fall back to in-app only.
- **The browser's background process is allowed to run.** Installed apps
  (PWAs) keep it running by default on Windows and macOS. If a worker uses the
  plain browser tab instead of the installed app, make sure the browser's
  *"Continue running background apps when [browser] is closed"* setting is on
  (Chrome/Edge → Settings → System). Installing the app (the recommended setup)
  handles this automatically.

Reminders are gentle and throttled — at most one push every ~25 minutes per
person, and the after-5pm nudge stops once they end their day.

---

## Testing tips

- **See codes without email:** set `DEV_MODE=1` in `time-worker/.dev.vars` and run
  `npx wrangler dev`; the sign-in response includes the code.
- **Don't want to wait 30 minutes?** In the browser console on the tracker page:
  `localStorage.setItem('lt_checkin_min','1')` then reload — check-ins now fire
  after 1 minute. Remove it to go back to 30.
- **Reset a test worker:** sign out (top-right), or clear the site's storage.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| "Company code isn't valid" | Codes are case-insensitive but must match. Regenerate in Companies → **New code** if needed. |
| No email arrives | Check `RESEND_API_KEY` / `EMAIL_FROM` secrets on the Worker; look at `npx wrangler tail`. |
| App won't install | Must be opened over **https** (time.linearit.co). Some managed browsers disable install — use the `--app=` Startup shortcut instead. |
| Timer stopped overnight | Expected if the app was fully closed; the server still has exact start/end times, and a task left running is auto-closed at midnight. |
| Manager sees the wrong company | Company admins are pinned to one company; re-appoint them in the Admins tab. |
