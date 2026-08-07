# Linear Sign — sign.linearit.co

A lightweight e-signature tool (think Zoho Sign) for Linear IT and its clients:
upload a PDF, drop **signature / initials / date / text / name / email / checkbox**
fields on it, send it out for signature, and track every document's status.
Completed documents are stamped server-side and finished with a tamper-evident
**Signature Certificate** page (who signed, when, from which IP, plus a SHA-256
hash of the original).

It is a **separate, isolated Cloudflare Worker** — like `vault-worker` and
`device-worker`. It shares nothing with the other Workers, so it can't affect
chat / vault / device / time.

```
sign-worker/         ← this folder: the Worker (API + PDF stamping)
  src/index.js
  wrangler.toml
  package.json        (pdf-lib is bundled at deploy)
/sign/               ← the front-end (served from the GitHub Pages site and
  index.html            reverse-proxied by the Worker at sign.linearit.co)
  app.js
```

## How it works

- **Senders** (your staff) sign in with their email + a 6-digit code emailed via
  Resend. An email must be listed in the `ADMIN_EMAILS` secret to be a sender.
- **Signers** (recipients) do **not** log in. Each recipient gets a private link
  containing a random per-recipient token: `https://sign.linearit.co/?d=…&t=…`.
  Opening it shows only the fields assigned to them.
- PDFs live in **R2** (`linear-sign-files`); documents, recipients, fields and the
  audit trail live in **D1** (`linear_sign`). Tables auto-create on first request.
- When the last signer finishes, the Worker loads the original from R2, stamps
  every field with **pdf-lib** (signatures as embedded PNGs, text/date/name drawn
  with Helvetica), appends the certificate page, writes the signed PDF back to R2,
  marks the document `completed`, and emails a download link to everyone.

## One-time setup

Run from **this** folder:

```bash
cd sign-worker
npm install

# 1) Create the D1 database, then paste the printed id into wrangler.toml
npx wrangler d1 create linear_sign

# 2) Create the R2 bucket for the PDFs
npx wrangler r2 bucket create linear-sign-files

# 3) Encrypted secrets (survive every deploy)
npx wrangler secret put AUTH_SECRET      # any long random string (>= 32 chars)
npx wrangler secret put RESEND_API_KEY   # the same key you use for chat/vault
npx wrangler secret put EMAIL_FROM       # ->  Linear IT <alert@linearit.co>
npx wrangler secret put ADMIN_EMAILS     # who may SEND documents (comma-separated)

# 4) Deploy — also provisions the sign.linearit.co Custom Domain + DNS
npx wrangler deploy
```

Then browse to **https://sign.linearit.co**, sign in with an `ADMIN_EMAILS`
address, and create your first document.

> The `database_id` in `wrangler.toml` is a placeholder
> (`PASTE_LINEAR_SIGN_D1_DATABASE_ID_HERE`). Replace it with the id printed by
> `wrangler d1 create` before the first deploy.

## Local development

```bash
npx wrangler dev
# set DEV_MODE=1 as a var to have sign-in codes returned in the API response
# (and shown in the UI) instead of requiring email delivery.
```

## API surface (summary)

Sender (Bearer token):
`POST /api/auth/{start,code,login}`, `GET/POST /api/docs`,
`GET/PUT/DELETE /api/docs/:id`, `POST /api/docs/:id/{send,remind,void}`,
`GET /api/docs/:id/{file,signed}`.

Signer (per-recipient `?token=`):
`GET /api/sign/:id`, `GET /api/sign/:id/{file,signed}`,
`POST /api/sign/:id/{view,complete,decline}`.

## Notes

- Max upload: 25 MB PDF. Encrypted / password-protected PDFs are rejected at
  upload with a clear message.
- Only **drafts** are editable; **sent** documents can be reminded or voided;
  **completed** documents are immutable and downloadable.
- Signing order is optional (`Sign in order`): when on, recipients are emailed
  one at a time in order; when off, everyone is emailed at once.
