import type { Env } from "./types";
import { clearSession, hasSession, issueSession, passwordMatches, sameOrigin } from "./auth";
import { esc, newNonce, page } from "./html";
import { createLink, deleteLink, LinkError, parseLinkForm } from "./links";

const DAY = 86_400_000;
const LIST_DAYS = 14;
const DETAIL_DAYS = 30;

interface LinkRow {
  slug: string;
  url: string;
  created_at: number;
  expires_at: number | null;
  max_clicks: number | null;
  fallback_url: string | null;
  hits: number;
}

function redirect(location: string, cookie?: string): Response {
  const headers = new Headers({ location, "cache-control": "no-store" });
  if (cookie) headers.append("set-cookie", cookie);
  return new Response(null, { status: 303, headers });
}

export async function handleAdmin(req: Request, env: Env, path: string): Promise<Response> {
  const nonce = newNonce();
  if (!env.ADMIN_PASSWORD) {
    return page(
      "Admin disabled",
      `<h1>Admin disabled</h1><p>Set the password first: <code>npx wrangler secret put ADMIN_PASSWORD</code></p>`,
      nonce,
      503,
    );
  }
  if (req.method === "POST" && !sameOrigin(req)) return new Response("Cross-origin request refused", { status: 403 });

  if (path === "/admin/login" && req.method === "POST") {
    const form = await req.formData();
    if (await passwordMatches(env, String(form.get("password") ?? ""))) {
      return redirect("/admin", await issueSession(env));
    }
    return loginPage(nonce, "Wrong password.", 401);
  }

  if (!(await hasSession(req, env))) {
    return req.method === "GET" ? loginPage(nonce) : new Response("Not logged in", { status: 401 });
  }

  if (path === "/admin/logout" && req.method === "POST") return redirect("/admin", clearSession());

  if ((path === "/admin" || path === "/admin/") && req.method === "GET") {
    return dashboard(env, nonce, { created: new URL(req.url).searchParams.get("created") });
  }

  if (path === "/admin/links" && req.method === "POST") {
    const form = await req.formData();
    try {
      const slug = await createLink(env, parseLinkForm(form, env));
      return redirect(`/admin?created=${encodeURIComponent(slug)}`);
    } catch (e) {
      if (!(e instanceof LinkError)) throw e;
      return dashboard(env, nonce, { error: e.message, form, status: e.status });
    }
  }

  const m = path.match(/^\/admin\/links\/([^/]+)(\/delete)?$/);
  if (m) {
    let slug: string;
    try {
      slug = decodeURIComponent(m[1]);
    } catch {
      return new Response("Bad slug", { status: 400 });
    }
    if (m[2] && req.method === "POST") {
      await deleteLink(env, slug);
      return redirect("/admin");
    }
    if (!m[2] && req.method === "GET") return detail(env, nonce, slug);
  }

  return new Response("Not found", { status: 404 });
}

function loginPage(nonce: string, error?: string, status = 200): Response {
  return page(
    "Sign in",
    `<h1>Link admin</h1>
${error ? `<div class="err">${esc(error)}</div>` : ""}
<form class="card" method="post" action="/admin/login" style="max-width:360px;display:grid;gap:12px">
  <label>Password<input type="password" name="password" autocomplete="current-password" autofocus required></label>
  <button type="submit">Sign in</button>
</form>`,
    nonce,
    status,
  );
}

function status(l: LinkRow, now: number): string {
  if (l.expires_at && now >= l.expires_at) return `<span class="pill bad">expired</span>`;
  if (l.max_clicks && l.hits >= l.max_clicks) return `<span class="pill bad">capped</span>`;
  return `<span class="pill">active</span>`;
}

function limits(l: LinkRow): string {
  const parts: string[] = [];
  if (l.expires_at) parts.push(`until ${new Date(l.expires_at).toISOString().slice(0, 16).replace("T", " ")} UTC`);
  if (l.max_clicks) parts.push(`${l.hits}/${l.max_clicks} clicks`);
  return parts.length ? `<div class="muted" style="font-size:12px">${esc(parts.join(" · "))}</div>` : "";
}

function dayLabel(dayIndex: number): string {
  return new Date(dayIndex * DAY).toISOString().slice(5, 10);
}

async function dashboard(
  env: Env,
  nonce: string,
  opts: { created?: string | null; error?: string; form?: FormData; status?: number },
): Promise<Response> {
  const now = Date.now();
  const today = Math.floor(now / DAY);
  const firstDay = today - LIST_DAYS + 1;

  const [links, daily] = await env.DB.batch([
    env.DB.prepare("SELECT * FROM links ORDER BY created_at DESC LIMIT 500"),
    // Bots (link-preview fetchers) are excluded from click counts.
    env.DB.prepare(
      `SELECT slug, ts / ${DAY} AS day, COUNT(*) AS c FROM clicks
       WHERE ts >= ? AND device != 'bot' GROUP BY slug, day`,
    ).bind(firstDay * DAY),
  ]);

  const perDay = new Map<string, number[]>();
  for (const r of daily.results as { slug: string; day: number; c: number }[]) {
    const arr = perDay.get(r.slug) ?? perDay.set(r.slug, new Array(LIST_DAYS).fill(0)).get(r.slug)!;
    const i = r.day - firstDay;
    if (i >= 0 && i < LIST_DAYS) arr[i] = r.c;
  }

  const f = (k: string) => esc(opts.form?.get(k) ?? "");
  const rows = (links.results as unknown as LinkRow[])
    .map((l) => {
      const days = perDay.get(l.slug) ?? new Array(LIST_DAYS).fill(0);
      const max = Math.max(1, ...days);
      const total = days.reduce((a, b) => a + b, 0);
      const spark = days
        .map((c, i) => `<i style="height:${(c / max) * 100}%" title="${dayLabel(firstDay + i)}: ${c}"></i>`)
        .join("");
      const href = `/admin/links/${encodeURIComponent(l.slug)}`;
      return `<tr>
  <td><a href="${href}"><code>${esc(l.slug)}</code></a>${limits(l)}</td>
  <td class="trunc" title="${esc(l.url)}">${esc(l.url)}</td>
  <td><div class="spark">${spark}</div></td>
  <td class="num">${total}</td>
  <td>${status(l, now)}</td>
  <td><a href="/qr/${encodeURIComponent(l.slug)}" target="_blank">PNG</a></td>
</tr>`;
    })
    .join("");

  const created = opts.created
    ? `<div class="okmsg">Created <a href="${esc(env.BASE_URL)}/${esc(opts.created)}"><code>${esc(env.BASE_URL)}/${esc(opts.created)}</code></a></div>`
    : "";

  return page(
    "Links",
    `<header><h1>Links</h1>
<form method="post" action="/admin/logout"><button class="ghost" type="submit">Sign out</button></form></header>
${opts.error ? `<div class="err" role="alert">${esc(opts.error)}</div>` : ""}${created}
<form class="card grid" method="post" action="/admin/links" id="create">
  <label style="grid-column:1/-1">Destination URL<input name="url" type="url" required placeholder="https://example.com/long/page" value="${f("url")}"></label>
  <label>Custom back-half (optional)<input name="slug" pattern="[A-Za-z0-9_\\-]{1,64}" placeholder="random 6 chars" value="${f("slug")}"></label>
  <label>Expires (optional, your local time)<input name="expires_local" type="datetime-local" value="${f("expires_local")}"></label>
  <label>Click cap (optional)<input name="max_clicks" type="number" min="1" step="1" value="${f("max_clicks")}"></label>
  <label>Fallback URL (when expired/capped)<input name="fallback_url" type="url" placeholder="${esc(env.DEFAULT_FALLBACK_URL || "required with expiry or cap")}" value="${f("fallback_url")}"></label>
  <input type="hidden" name="expires_ms">
  <button type="submit">Shorten</button>
</form>
<script nonce="${nonce}">
document.getElementById("create").addEventListener("submit", (e) => {
  const v = e.target.expires_local.value;
  e.target.expires_ms.value = v ? String(new Date(v).getTime()) : "";
});
</script>
<h2>All links <span class="muted" style="font-weight:400;font-size:13px">· human clicks per day, last ${LIST_DAYS} days (UTC)</span></h2>
<div class="table"><table>
<thead><tr><th>Short link</th><th>Destination</th><th>Per day</th><th class="num">${LIST_DAYS}d</th><th>Status</th><th>QR</th></tr></thead>
<tbody>${rows || `<tr><td colspan="6" class="muted">No links yet.</td></tr>`}</tbody>
</table></div>`,
    nonce,
    opts.status ?? 200,
  );
}

function hbars(rows: { k: string | null; c: number }[], empty = "No data yet."): string {
  if (!rows.length) return `<p class="muted">${empty}</p>`;
  const max = Math.max(...rows.map((r) => r.c));
  return `<table class="kv"><tbody>${rows
    .map(
      (r) => `<tr><td title="${esc(r.k ?? "")}">${esc(r.k ?? "(unknown)")}</td>
<td><div class="hbar"><i style="width:${(r.c / max) * 100}%"></i></div></td>
<td class="num">${r.c}</td></tr>`,
    )
    .join("")}</tbody></table>`;
}

async function detail(env: Env, nonce: string, slug: string): Promise<Response> {
  const link = await env.DB.prepare("SELECT * FROM links WHERE slug = ?").bind(slug).first<LinkRow>();
  if (!link) return page("Not found", `<h1>No link "${esc(slug)}"</h1><p><a href="/admin">Back</a></p>`, nonce, 404);

  const now = Date.now();
  const today = Math.floor(now / DAY);
  const firstDay = today - DETAIL_DAYS + 1;
  const human = "slug = ?1 AND device != 'bot'";

  const [days, countries, cities, devices, referers, outcomes] = await env.DB.batch([
    env.DB.prepare(`SELECT ts / ${DAY} AS day, COUNT(*) AS c FROM clicks WHERE ${human} AND ts >= ?2 GROUP BY day`).bind(
      slug,
      firstDay * DAY,
    ),
    env.DB.prepare(`SELECT country AS k, COUNT(*) AS c FROM clicks WHERE ${human} GROUP BY k ORDER BY c DESC LIMIT 10`).bind(slug),
    env.DB.prepare(
      `SELECT city || ', ' || COALESCE(country, '?') AS k, COUNT(*) AS c FROM clicks WHERE ${human} AND city IS NOT NULL GROUP BY k ORDER BY c DESC LIMIT 10`,
    ).bind(slug),
    env.DB.prepare("SELECT device AS k, COUNT(*) AS c FROM clicks WHERE slug = ?1 GROUP BY k ORDER BY c DESC").bind(slug),
    env.DB.prepare(`SELECT referer AS k, COUNT(*) AS c FROM clicks WHERE ${human} GROUP BY k ORDER BY c DESC LIMIT 10`).bind(slug),
    env.DB.prepare(`SELECT outcome AS k, COUNT(*) AS c FROM clicks WHERE ${human} GROUP BY k`).bind(slug),
  ]);

  const series = new Array(DETAIL_DAYS).fill(0);
  for (const r of days.results as { day: number; c: number }[]) {
    const i = r.day - firstDay;
    if (i >= 0 && i < DETAIL_DAYS) series[i] = r.c;
  }
  const max = Math.max(1, ...series);
  const chart = series
    .map(
      (c, i) =>
        `<div title="${dayLabel(firstDay + i)}: ${c}"><i style="height:${(c / max) * 100}%"></i><span>${i % 5 === 4 || i === DETAIL_DAYS - 1 ? dayLabel(firstDay + i) : "&nbsp;"}</span></div>`,
    )
    .join("");

  type KC = { k: string | null; c: number };
  const outcomeRows = outcomes.results as KC[];
  const total = outcomeRows.reduce((a, r) => a + r.c, 0);
  const fellBack = outcomeRows.filter((r) => r.k !== "ok").reduce((a, r) => a + r.c, 0);
  const short = `${env.BASE_URL}/${link.slug}`;
  const qr = `/qr/${encodeURIComponent(link.slug)}`;

  return page(
    `${link.slug} · Links`,
    `<p><a href="/admin">← All links</a></p>
<header><h1><code>${esc(short)}</code> ${status(link, now)}</h1></header>
<div class="cols">
  <div class="card">
    <p style="margin-top:0">→ <a href="${esc(link.url)}" rel="noreferrer">${esc(link.url)}</a></p>
    ${limits(link)}
    ${link.fallback_url ? `<p class="muted">Fallback: ${esc(link.fallback_url)}</p>` : ""}
    <p><strong style="font-size:28px">${total}</strong> human clicks all-time${fellBack ? ` <span class="muted">(${fellBack} sent to fallback)</span>` : ""}</p>
    <p class="muted" style="font-size:12px">Created ${new Date(link.created_at).toISOString().slice(0, 10)}</p>
    <form method="post" action="/admin/links/${encodeURIComponent(link.slug)}/delete" id="del">
      <button class="danger" type="submit">Delete link and its clicks</button>
    </form>
  </div>
  <div class="card" style="text-align:center">
    <img src="${qr}?size=256" width="200" height="200" alt="QR code for ${esc(short)}">
    <p>Download: <a href="${qr}?size=512" download>512 px</a> · <a href="${qr}?size=1024" download>1024 px</a></p>
  </div>
</div>
<h2>Clicks per day <span class="muted" style="font-weight:400;font-size:13px">· last ${DETAIL_DAYS} days, UTC, bots excluded</span></h2>
<div class="card"><div class="days">${chart}</div></div>
<div class="cols">
  <div><h2>Top countries</h2>${hbars(countries.results as KC[])}</div>
  <div><h2>Devices <span class="muted" style="font-weight:400;font-size:13px">· incl. bots</span></h2>${hbars(devices.results as KC[])}</div>
  <div><h2>Top cities</h2>${hbars(cities.results as KC[])}</div>
  <div><h2>Top referers</h2>${hbars(
    (referers.results as KC[]).map((r) => ({ k: r.k ?? "(none / direct)", c: r.c })),
  )}</div>
</div>
<script nonce="${nonce}">
document.getElementById("del").addEventListener("submit", (e) => {
  if (!confirm("Delete ${esc(link.slug)}? Printed QR codes for it will stop working.")) e.preventDefault();
});
</script>`,
    nonce,
  );
}
