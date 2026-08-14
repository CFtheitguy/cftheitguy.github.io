# `analytics-worker` — who actually visits www.linearit.co

GitHub Pages keeps **no logs and gives you no analytics at all**. There is no
dashboard, no visitor list, nothing. But `www.linearit.co` is proxied through
Cloudflare, so every request already crosses Cloudflare's edge — and a Worker
sitting on that path can see and record it.

This Worker returns the page exactly as GitHub Pages served it, then writes one
row per page view into a D1 database. No third-party tracker, no cookie, no
consent banner, no script tag in any of the 88 HTML files.

For each page view it records:

| Column | What it tells you |
| --- | --- |
| `ts`, `path`, `status` | what they opened, when, and whether it worked |
| `ip` | the visitor's address (or a salted hash — see **Privacy**) |
| `country`, `city`, `region` | where they were |
| `asn`, `org` | **the network they came from** |
| `ua`, `referer` | browser/device, and what linked them here |
| `is_bot` | crawler/monitor heuristic, so you can filter noise out |

`org` is the interesting one. It is the organisation that owns the visitor's IP
range. Home and mobile visitors show their ISP (`Verizon`, `Spectrum`), which
tells you nothing — but visitors from an office often show **the company
itself**, which is the closest you get to a name without paying for a
reverse-IP service.

This Worker is completely separate from `linear-chat`, `linear-vault`,
`linear-time`, `linear-sign` and `speed-worker`: its own folder, its own config,
its own database. It shares nothing with them.

---

## It cannot take the site down

It sits in front of the entire main site, so that is the first thing to be sure
of. Every path in `src/index.js` fails **open**:

- The origin response is fetched and returned **first**; logging happens after
  the response is already on its way (`ctx.waitUntil`), so it can never delay or
  block a page.
- If D1 is unreachable, the insert fails silently and the page still serves.
- If the beacon injection throws, the visitor gets the untouched original.
- If the whole logging block throws, it is caught and ignored.

The failure mode is "you stop collecting data", never "the site is down".

To back it out completely: `npx wrangler delete` from this folder. That removes
the Worker and its route together, and the site goes back to being served
straight from GitHub Pages through Cloudflare, exactly as it is today.

---

## One-time setup (run from this folder)

You must be logged into the **same Cloudflare account** that owns `linearit.co`.

```bash
cd analytics-worker
npm install
npx wrangler login                                  # once per machine
npx wrangler d1 create linear_analytics             # copy the printed id...
```

Paste that id into `wrangler.toml` as `database_id` (it ships as
`PASTE_DATABASE_ID_HERE`, and deploy fails loudly until you replace it — on
purpose, so you can't deploy a Worker that silently records nothing).

```bash
npx wrangler d1 execute linear_analytics --remote --file=./schema.sql
npx wrangler deploy --dry-run                       # validate first
npx wrangler deploy
```

Open the site, click around, then run the first query below. Rows should appear
within a second or two.

---

## Seeing the data

Run these with `npx wrangler d1 execute linear_analytics --remote --command "..."`,
or paste them into the D1 console in the Cloudflare dashboard.

**The last 50 real visits**

```sql
SELECT ts, path, city, region, country, org, ip
FROM visits WHERE is_bot = 0
ORDER BY id DESC LIMIT 50;
```

**Which organisations have been on the site this month** — the "who" query

```sql
SELECT org, country, COUNT(*) AS hits, COUNT(DISTINCT ip) AS people,
       MAX(ts) AS last_seen
FROM visits
WHERE is_bot = 0 AND ts > datetime('now', '-30 days')
GROUP BY org ORDER BY hits DESC;
```

**One visitor's whole session** — what a specific person actually read

```sql
SELECT ts, path, referer FROM visits
WHERE ip = '203.0.113.9' ORDER BY id;
```

**Most-read pages, last 7 days**

```sql
SELECT path, COUNT(*) AS views, COUNT(DISTINCT ip) AS people
FROM visits
WHERE is_bot = 0 AND ts > datetime('now', '-7 days')
GROUP BY path ORDER BY views DESC LIMIT 25;
```

**Where visitors are coming from** (external referrers only)

```sql
SELECT referer, COUNT(*) AS hits FROM visits
WHERE is_bot = 0 AND referer != '' AND referer NOT LIKE '%linearit.co%'
GROUP BY referer ORDER BY hits DESC;
```

**Somebody who came back more than once**

```sql
SELECT ip, org, city, COUNT(*) AS views, MIN(ts) AS first_seen, MAX(ts) AS last_seen
FROM visits WHERE is_bot = 0
GROUP BY ip HAVING views > 1 ORDER BY last_seen DESC;
```

---

## Settings (`[vars]` in `wrangler.toml`)

| Var | Default | What it does |
| --- | --- | --- |
| `RETENTION_DAYS` | `90` | Nightly cron deletes rows older than this, so the table cannot grow forever. |
| `HASH_IPS` | `"false"` | `"true"` stores a salted one-way hash instead of the address. |
| `IP_SALT` | `"linearit"` | Only used when hashing. Changing it breaks matching against old rows. |
| `WEB_ANALYTICS_TOKEN` | `""` | If set, injects the Cloudflare Web Analytics beacon into every HTML page. |

### About `WEB_ANALYTICS_TOKEN`

**Leave it empty if you used Web Analytics' _automatic_ setup.** Because
`linearit.co` is proxied, Cloudflare can inject the beacon at the edge itself —
no token, no code, nothing for this Worker to do. Only set this if you chose
manual setup and want the beacon on all 88 HTML pages without editing them
individually.

---

## Privacy

Recording visitor IPs is processing personal data in the EU/UK, and increasingly
in US state law too. Two things worth knowing:

- Set `HASH_IPS = "true"` if you only care about *"a visitor from Hudson Valley
  Dental read the pricing page three times"* rather than the address itself.
  Repeat-visit detection still works; the raw address is never stored.
- `RETENTION_DAYS` keeps the window short by default. Ninety days is a
  defensible retention period; a year is harder to justify.

No cookie is set and no data leaves your own Cloudflare account, which is why
this needs no consent banner in the way a third-party tracker would.

---

## What this does not do

It gives you **networks, not names**. A visitor from a home broadband
connection is `Comcast` and always will be. Identifying individual people or
mapping a company to a contact needs a commercial reverse-IP product (Vector,
RB2B, Dealfront); those drop a script tag and typically identify 20–40% of US
business traffic. This Worker is the free, self-owned layer underneath that.
