# Deploy: Linear Tech File Portal

All steps are done in the **Cloudflare dashboard** — no terminal needed.

---

## Step 1 — Create the R2 Bucket

1. Cloudflare dashboard → **R2 Object Storage** → **Create bucket**
2. Name: `linearit-files`
3. Click **Create bucket**

---

## Step 2 — Create the D1 Database

1. Dashboard → **Workers & Pages** → **D1** → **Create database**
2. Name: `linearit-files-db`
3. Click **Create**
4. **Copy the Database ID** shown on the next screen (you'll need it in Step 4)

### Run the schema

1. Click into `linearit-files-db` → **Console** tab
2. Paste the entire contents of `schema.sql` into the box
3. Click **Execute**
4. You should see "6 statements executed successfully"

---

## Step 3 — Create the Worker

1. Dashboard → **Workers & Pages** → **Create** → **Create Worker**
2. Name it: `linearit-files`
3. Click **Deploy** (the Hello World placeholder is fine for now)
4. Click **Edit code**
5. Delete everything in the editor, paste the entire contents of `src/index.js`
6. Click **Deploy**

---

## Step 4 — Add Bindings

In the Worker settings → **Settings** → **Bindings**:

### R2 bucket
- Click **Add binding** → **R2 bucket**
- Variable name: `FILES`
- Bucket: `linearit-files`
- Save

### D1 database
- Click **Add binding** → **D1 database**
- Variable name: `DB`
- Database: `linearit-files-db`
- Save

---

## Step 5 — Add the Secret

In the Worker **Settings** → **Variables and Secrets** → **Add variable**:

| Type | Name | Value |
|------|------|-------|
| Secret | `SESSION_SECRET` | Any random 40+ character string (e.g. open [1password.com/password-generator](https://1password.com/password-generator/) and generate a random 40-char string) |

Click **Deploy** after saving.

---

## Step 6 — Enable R2 Presigned URLs (custom domain)

R2 presigned URLs require a public custom domain on the bucket.

1. Go to **R2** → `linearit-files` → **Settings** → **Custom Domains**
2. Add domain: `files-r2.linearit.co` (or any subdomain you own)
3. This adds a DNS record automatically if your domain is on Cloudflare

---

## Step 7 — Add Custom Domain to Worker

1. Worker → **Settings** → **Domains & Routes** → **Add Custom Domain**
2. Enter: `files.linearit.co`
3. Cloudflare creates the DNS record automatically
4. Within ~60 seconds the portal is live at `https://files.linearit.co`

---

## Step 8 — Test it

1. Visit `https://files.linearit.co`
2. Click **Create account**, sign up
3. Upload a file — it should appear in your list
4. Click **Secure Send**, upload a file, set a password, copy the link
5. Open the link in a private/incognito window, enter the password — file downloads and link is burned

---

## Updating the live portal (Transfer tab + big-file uploads)

The portal at files.linearit.co is updated the same way it was set up —
no terminal needed, and **no database step**: the new tables create
themselves the first time the new code runs.

1. Workers & Pages → `linearit-files` → **Edit code**
2. Select everything in the editor, paste the whole of `src/index.js`, **Deploy**
3. Settings → **Triggers** → **Cron Triggers**: change `0 3 * * *` to
   `0 * * * *` (hourly). Expired transfers already stop working the moment
   they expire; this just deletes their files within the hour instead of
   the next morning.

Then sign in and check:

- **My Files** — upload something over 100 MB. It goes up in 16 MB pieces
  with a speed / time-left readout (the old uploader stopped at ~100 MB).
- **Transfer** — add a few files or a folder, pick an expiry, *Upload & get
  link*. Open the link in a private window: each file downloads on its own,
  or *Download all* gives one ZIP. "Your transfers" shows how many times it
  was downloaded, with Copy link / Delete.
- **Secure Send** — big files work here too now.

### What changed, in short

- **Uploads of any size.** Every upload (all three tabs) goes straight into
  R2 in 16 MB parts, four at a time, each retrying on its own if the
  connection drops. Before, the whole file went in one request, which
  Cloudflare caps at 100 MB.
- **Downloads of any size.** Downloads use a signed, time-limited link, so
  the browser saves straight to disk and can resume. Before, the whole file
  was loaded into the browser's memory first.
- **Nothing is compressed.** Files are stored and returned byte for byte.
  "Download all" is a ZIP made with no compression, so the files inside are
  the originals. A transfer only opens once every file has arrived at its
  exact original size.
- **Transfers count toward the plan's storage** while their link is alive,
  and stop counting once they expire or are deleted.
- **Fixed:** the cron used to delete a Secure Send link after its *first*
  download even when it allowed 5 or 10; it now waits for the last one. Its
  entry is now also removed from My Files when the file is deleted.

---

## Optional: Link from your main site

Add a nav link on `linearit.co`:

```html
<a href="https://files.linearit.co">Client Files</a>
```

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| "Unauthorized" on every request | Check `SESSION_SECRET` secret is set and Worker was re-deployed |
| Upload works but download fails | Check R2 binding variable is named exactly `FILES` |
| DB errors | Re-run `schema.sql` in the D1 Console |
| Presigned URLs 403 | Make sure the R2 bucket has a public custom domain set up (Step 6) |
| "This download link has expired" | Signed download links last 6 hours — click Download again for a fresh one |
| Transfer "Download all" missing | Transfers over 40 files are downloaded file by file (the button starts them one after another) |
