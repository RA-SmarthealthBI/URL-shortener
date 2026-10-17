import type { Env, LinkRecord } from "./types";
import { deviceFromUA } from "./device";

type Outcome = "ok" | "expired" | "capped";

export async function handleRedirect(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  slug: string,
): Promise<Response> {
  const rec = await env.LINKS.get<LinkRecord>(slug, "json");
  if (!rec) return new Response("Link not found", { status: 404, headers: { "content-type": "text/plain" } });

  const now = Date.now();
  let outcome: Outcome = "ok";
  if (rec.exp && now >= rec.exp) outcome = "expired";
  else if (rec.done) outcome = "capped";

  let target = rec.url;
  if (outcome !== "ok") {
    target = rec.fb || env.DEFAULT_FALLBACK_URL || "";
    if (!target) return new Response("This link is no longer active", { status: 410 });
  }

  // HEAD requests (uptime checkers, some unfurlers) are not clicks.
  if (req.method === "GET") ctx.waitUntil(logClick(req, env, slug, rec, outcome, now));

  return new Response(null, {
    status: 302,
    headers: {
      location: target,
      // Every click must reach the worker to be counted.
      "cache-control": "private, no-store",
    },
  });
}

async function logClick(
  req: Request,
  env: Env,
  slug: string,
  rec: LinkRecord,
  outcome: Outcome,
  now: number,
): Promise<void> {
  const cf = (req.cf ?? {}) as { country?: string; city?: string };
  const device = deviceFromUA(req.headers.get("user-agent"));
  const referer = req.headers.get("referer")?.slice(0, 512) ?? null;

  const insert = env.DB.prepare(
    "INSERT INTO clicks (slug, ts, country, city, device, referer, outcome) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).bind(slug, now, cf.country ?? null, cf.city ?? null, device, referer, outcome);

  try {
    // Only capped links pay for a counter update; bots don't use up the cap.
    if (!rec.max || outcome !== "ok" || device === "bot") {
      await insert.run();
      return;
    }
    const [, counted] = await env.DB.batch<{ hits: number }>([
      insert,
      env.DB.prepare("UPDATE links SET hits = hits + 1 WHERE slug = ? RETURNING hits").bind(slug),
    ]);
    const hits = counted.results[0]?.hits ?? 0;
    // Flag the KV record exactly when the cap is reached, plus a retry every
    // 100 clicks over in case that write failed. Writing on every click past
    // the cap would burn the KV daily write quota while edge caches catch up.
    if (hits === rec.max || (hits > rec.max && (hits - rec.max) % 100 === 0)) {
      await env.LINKS.put(slug, JSON.stringify({ ...rec, done: true } satisfies LinkRecord));
    }
  } catch (e) {
    // The visitor is already redirected; a lost log row is the only casualty.
    console.error("click log failed", slug, e);
  }
}
