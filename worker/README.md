# Linear Phone — Worker

The API + IVR for the Linear Phone softphone. One Cloudflare Worker handles:

- **SignalWire webhooks** — inbound voice IVR (`/voice`), inbound SMS
  (`/sms/inbound`), call status (`/voice/status`), voicemail (`/voice/voicemail`).
- **Softphone API** (`/api/*`) — login, texting, calls, contacts, voicemail.
- **WebRTC token** (`/api/token`) — mints a SignalWire RELAY JWT for the browser.

## Files
- `src/index.js` — the whole worker (paste into Cloudflare → `linear-ivr` → Edit code).
- `schema.sql` — D1 tables (run once in the D1 console).

## Deploy
Full step-by-step (dashboard / iPad friendly): **[`../phone/DEPLOY.md`](../phone/DEPLOY.md)**.

## Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/voice` | SignalWire | Inbound call IVR (LaML) |
| POST | `/voice/status` | SignalWire | Call status → call log |
| POST | `/voice/voicemail` | SignalWire | Save voicemail + missed call |
| POST | `/sms/inbound` | SignalWire | Save inbound text |
| POST | `/api/login` | — | Returns a 30-day bearer token |
| POST | `/api/token` | Bearer | Mint RELAY JWT for the browser |
| GET | `/api/threads` | Bearer | Conversation list |
| GET | `/api/thread?number=` | Bearer | One conversation |
| POST | `/api/sms/send` | Bearer | Send a text |
| GET/POST | `/api/calls` | Bearer | Call log / append |
| GET | `/api/voicemail` | Bearer | Voicemail list |
| GET/POST | `/api/contacts` | Bearer | Contacts list / save |
| POST | `/api/contacts/delete` | Bearer | Delete contact |

Auth uses HMAC-signed bearer tokens (no cookies → works cleanly on Safari/iPad).
