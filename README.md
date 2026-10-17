# go-shortener

A self-hosted link shortener with click analytics and QR codes, built to replace Bitly. It runs on Cloudflare Workers with KV and D1, on your own domain, within the free plan, **without moving your company domain's DNS to Cloudflare**.

- `https://go.ra-smarthealth.com/{slug}` → 302 to the destination. The lookup is a single KV read. The click is written to D1 inside `ctx.waitUntil`, so the redirect never waits on the database.
- Slugs are random 6-character base62 by default, or a custom back-half. If you create a slug that already exists, you get a **409 error and nothing is overwritten**.
- Each click logs: slug, timestamp, country and city (`request.cf`), device type (from the User-Agent), referer and outcome. **No IP address is stored.**
- `https://go.ra-smarthealth.com/qr/{slug}` returns a PNG QR code of the short link (`?size=256|512|1024`, default 512), cached at the edge.
- Optional expiry and click cap per link. Once either is reached, visitors get a 302 to a fallback URL instead of an error.
- `/admin`, behind one password: create and delete links, clicks per day for each link, and a detail page per link with top countries, cities, referers and device split.
- No accounts, no third-party scripts, analytics or telemetry. The admin page loads nothing from other origins and sends a strict CSP.

> [!WARNING]
> **These links die with either domain.** Every short link and every printed QR code points at `go.ra-smarthealth.com`, which is served through the helper domain `ra-smarthealth-links.com`. If **either** domain lapses or is transferred, every link you have ever handed out or printed breaks, and whoever registers the lapsed domain next can redirect your printed codes anywhere. Keep both on auto-renew for as long as the printed material exists, and lock them at the registrar. Nobody sees the helper domain, which makes it easy to forget: its name says what it is for on purpose.

## How it works

```
GET /{slug} ──► KV.get(slug) ──► 302 Location: …       (response sent)
                    │
                    └─ ctx.waitUntil ──► D1 INSERT INTO clicks
                                         (+ UPDATE links.hits for capped links)
```

| Store | Holds | Why |
|---|---|---|
| KV `LINKS` | `slug → {url, exp?, max?, fb?, done?}` | Fast reads replicated to every edge, so each redirect costs one KV read. |
| D1 `links` | The link registry | Its `PRIMARY KEY` makes the "slug already exists" check atomic. KV has no compare-and-set, so check-then-put on KV alone could overwrite under a race. The admin list also reads from here. |
| D1 `clicks` | One row per click | Analytics queries. |

## Setup

### Why there are two domains

The free plan only connects a Worker to a hostname if Cloudflare is the authoritative DNS for the whole domain ("full setup"). Proxying a single subdomain while the rest of the DNS stays elsewhere needs the Business plan ([zone setups](https://developers.cloudflare.com/dns/zone-setups), [partial setup](https://developers.cloudflare.com/dns/zone-setups/partial-setup/index.md)).

`ra-smarthealth.com` holds the company website, email, n8n, Vikunja and several GitHub Pages sites, all on Wix DNS. Moving it to serve a link shortener isn't worth the risk. Instead:

- **`ra-smarthealth-links.com`** is a helper domain registered at Cloudflare. It is empty and nobody sees it.
- **[Cloudflare for SaaS](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/plans/)** on that zone lets another domain's hostname point at it with a CNAME. 100 custom hostnames are included on the Free plan.
- **`go.ra-smarthealth.com`** is added as a custom hostname. In Wix you **add** a CNAME (and the verification records Cloudflare asks for); no existing record changes.
- The Worker is attached to the helper zone with the route `*/*`, which catches custom-hostname traffic ([Worker as origin](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/start/advanced-settings/worker-as-origin)).

```
visitor → go.ra-smarthealth.com ──CNAME (Wix)──► fallback.ra-smarthealth-links.com
                                                    │ Cloudflare for SaaS
                                                    ▼
                                         Worker (route */* on the helper zone)
```

You need Node 20+ and:

```bash
npm install
npx wrangler login
```

### 1. Create the KV namespace and the D1 database

```bash
npx wrangler kv namespace create LINKS
npx wrangler d1 create go-shortener
```

Each command prints an ID. Paste them into `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "LINKS"
id = "<kv namespace id>"

[[d1_databases]]
binding = "DB"
database_name = "go-shortener"
database_id = "<d1 database id>"
```

Then create the tables:

```bash
npm run db:migrate          # wrangler d1 migrations apply go-shortener --remote
```

### 2. Set the admin password (secret, never in `wrangler.toml`)

```bash
npx wrangler secret put ADMIN_PASSWORD
```

Use a long random password (20+ characters). There is no lockout after failed attempts (see [Security notes](#security-notes)). Changing the secret logs out every existing session.

Optionally set `DEFAULT_FALLBACK_URL` in `wrangler.toml` (for example the company homepage). Links with an expiry or a cap then don't each need their own fallback.

### 3. Deploy the Worker

```bash
npm run deploy
```

This attaches the Worker to `ra-smarthealth-links.com` with the route `*/*`. Nothing is reachable at `go.ra-smarthealth.com` yet.

### 4. Fallback origin on the helper zone (Cloudflare dashboard)

1. **ra-smarthealth-links.com → DNS → Records → Add record**: type `AAAA`, name `fallback`, IPv6 `100::`, **Proxied** (orange cloud). `100::` is a placeholder: the Worker answers before traffic would go anywhere.
2. **SSL/TLS → Custom Hostnames**: enable Cloudflare for SaaS if asked, and set the **fallback origin** to `fallback.ra-smarthealth-links.com`. Wait until it shows as active.

### 5. Add `go.ra-smarthealth.com` as a custom hostname

1. Still in **SSL/TLS → Custom Hostnames → Add custom hostname**: enter `go.ra-smarthealth.com` and keep the default certificate options.
2. Cloudflare then lists the records it needs at the domain's DNS provider. Expect a CNAME and one or two TXT records (hostname ownership and certificate validation). Copy them exactly.

### 6. Add the records in Wix

In **Wix → Domains → ra-smarthealth.com → Manage DNS records**, **add**:

| Type | Host | Value |
|---|---|---|
| CNAME | `go` | `fallback.ra-smarthealth-links.com` |
| TXT | as shown by Cloudflare | as shown by Cloudflare |

Do not edit or delete any existing record. Back in Cloudflare, the custom hostname and its certificate should turn **Active**; that can take minutes to a few hours.

### 7. Use it

Open `https://go.ra-smarthealth.com/admin`, sign in, and create a link.

`workers_dev = false` keeps the Worker off `*.workers.dev`. Requests to `ra-smarthealth-links.com` itself also reach the Worker; that is harmless (it only knows slugs, `/qr/` and `/admin`), and the QR codes always encode `BASE_URL`.

### Local development

```bash
cp .dev.vars.example .dev.vars   # sets ADMIN_PASSWORD for wrangler dev only
npm run db:migrate:local
npm run dev                      # http://localhost:8787/admin
npm test                         # unit tests
npm run typecheck
```

Locally, `request.cf` holds mock values, so every click shows the same city.

## Behaviour you should know about

**Expiry and click caps aren't exact to the click.** KV is eventually consistent and caches reads at each edge for up to about 60 seconds ([KV docs: how KV works](https://developers.cloudflare.com/kv/concepts/how-kv-works/)). The cap works like this:

1. Each non-bot click on a capped link increments `links.hits` in D1.
2. When `hits` reaches the cap, the Worker writes `done: true` to the KV record.
3. Edges that cached the old record keep redirecting to the destination until their cache expires. A link that is being clicked heavily at the moment it hits the cap can overshoot by however many clicks arrive in that window.
4. Expiry is checked against the clock on every request, so it is exact.

I chose this over checking D1 on every redirect because you asked that redirects never wait on the database. If you need a hard cap (for example, limited coupon codes), this design is the wrong tool.

**Other consistency effects (same ~60 second window):** a deleted link can keep redirecting briefly. A slug visited *before* it was created can keep returning 404 briefly.

**Bots.** Slack, WhatsApp, iMessage, LinkedIn and others fetch a link when it is *pasted*, to build a preview. Those requests are logged with `device = bot`. They are excluded from the per-day, country, city and referer numbers, and they don't use up a click cap. They do appear in the device split. Detection is a User-Agent regex (`src/device.ts`), so it misses bots that pretend to be browsers. `robots.txt` disallows everything, so search engines don't follow your short links.

**Device type is coarse.** Since iPadOS 13, iPads send a desktop Safari User-Agent by default, so most iPads count as desktop.

**Referer is often empty.** Browsers default to `strict-origin-when-cross-origin`, so you usually get only the origin, and apps such as email clients and messengers often send nothing. Those clicks show as "(none / direct)".

**Days are UTC.** Per-day charts bucket clicks by UTC day.

**Expired or capped links still log clicks** (outcome `expired` or `capped`), so you can see that printed material is still being scanned. The detail page shows how many clicks went to the fallback.

**HEAD requests redirect but aren't logged.**

**QR codes.**
- The PNG encodes `BASE_URL/{slug}`, the tracked short link, never the destination. Print material keeps counting clicks.
- It is cached with `immutable` for a year at the edge (per data centre) and in browsers. The image can only change if you change `BASE_URL`.
- 512 px is the default. At ~13 px per module it is plenty for print at a few centimetres. Use `?size=1024` for large formats.
- The Cache API only works on a custom domain or route, not on `workers.dev`.

## Free-plan budget

These are the limits the design is sized against. I couldn't reach Cloudflare's docs from the environment this was built in, so check the current numbers on the linked pages:

| Limit (Free plan) | Value | Source |
|---|---|---|
| Worker requests | 100,000 / day | [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) |
| Worker CPU time | 10 ms / request | [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) |
| KV reads / writes | 100,000 / 1,000 per day | [KV limits](https://developers.cloudflare.com/kv/platform/limits/) |
| D1 rows read / written | 5,000,000 / 100,000 per day | [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) |

What each operation costs:

- **A click** = 1 KV read, plus 3 D1 rows written: the row and two index entries. D1 counts index writes as written rows ([D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)). A click on a capped link writes 1 more row.
  - **D1 writes are the binding constraint:** roughly **30,000 logged clicks per day**.
  - Past that, the redirect still works; only the click log row is lost, because logging runs in `waitUntil` and its errors are caught.
- **KV writes** happen only when you create a link and once when a link reaches its cap, so the 1,000/day limit doesn't constrain clicks.
- **QR rendering** is the one CPU-heavy path. With the PNG options in `src/qr.ts`, a 512 px code took about 5–6 ms in Node on the build machine. The library defaults took about 20 ms. `?size=1024` took about 20 ms, which can exceed the 10 ms free-plan limit on a cache miss. I measured in Node, not on Cloudflare's hardware: after deploying, check CPU time under **Workers → go-shortener → Metrics**. Each size is rendered once per data centre and then served from cache.
- **The admin dashboard** reads only the last 14 days of clicks, using the `ts` index. The per-link page aggregates that link's whole history, which reads one row per click it has ever had.

## Admin

- Sign-in sets a `__Host-` cookie: `HttpOnly`, `Secure`, `SameSite=Strict`, 7 days, HMAC-signed with a key derived from `ADMIN_PASSWORD`. No session storage is needed.
- Creating a link: destination (http/https only), optional back-half (`A–Z a–z 0–9 - _`, up to 64 characters), optional expiry (entered in your browser's local time), optional click cap, and fallback URL.
- `admin`, `qr`, `robots.txt` and `favicon.ico` are reserved.
- Deleting a link removes its KV entry, its registry row and its click history. Printed QR codes for it then return 404. If you only want it to stop, give it an expiry and a fallback instead.

## Security notes

- **The password is the only barrier.** There is no rate limiting on `/admin/login`. Use a long random password. If you want throttling, add a Cloudflare WAF rate-limiting rule on `/admin/login`; the free plan includes one rule ([docs](https://developers.cloudflare.com/waf/rate-limiting-rules/)).
- **Open redirect by design.** Anyone with the password can point a slug anywhere. Visitors trust your domain, so treat the password accordingly.
- **CSRF:** state-changing POSTs require the `SameSite=Strict` cookie. Requests that a browser marks as cross-site (`Sec-Fetch-Site`) or that carry a foreign `Origin` are refused.
- **XSS:** all output is escaped. The admin page sends a CSP with per-response nonces, no third-party sources and `frame-ancestors 'none'`.

## Backups

The links and click history live only in your Cloudflare account. Export them now and then:

```bash
npx wrangler d1 export go-shortener --remote --output backup.sql
```

## Moving off Bitly

This does not migrate anything. Existing `bit.ly/...` links and QR codes already printed keep pointing at Bitly. If you used a **Bitly custom domain that you own**, you can point that domain at this Worker and recreate the same back-halves with the custom back-half field, and old prints keep working. Otherwise, keep Bitly until the old material is out of circulation.

## Project layout

```
src/index.ts      router
src/redirect.ts   KV lookup, expiry/cap/fallback, click logging in waitUntil
src/links.ts      validation, atomic create (D1 PK), delete
src/qr.ts         PNG QR via qrcode + Cache API
src/admin.ts      /admin pages and queries
src/auth.ts       password check, signed session cookie, CSRF guard
src/device.ts     User-Agent → desktop | mobile | tablet | bot | unknown
src/slug.ts       random base62 slugs, custom slug rules
migrations/       D1 schema
```
