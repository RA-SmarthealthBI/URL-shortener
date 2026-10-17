import type { Env, LinkRecord } from "./types";
import { customSlugError, randomSlug } from "./slug";

export interface NewLink {
  url: string;
  slug?: string;
  expiresAt?: number;
  maxClicks?: number;
  fallbackUrl?: string;
}

export class LinkError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

function httpUrl(value: string, field: string): string {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    throw new LinkError(`${field} is not a valid URL.`, 400);
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    throw new LinkError(`${field} must start with http:// or https://.`, 400);
  }
  return u.toString();
}

/** Validates the admin form. Throws LinkError with a user-facing message. */
export function parseLinkForm(form: FormData, env: Env, now = Date.now()): NewLink {
  const str = (k: string) => {
    const v = form.get(k);
    return typeof v === "string" ? v.trim() : "";
  };

  const link: NewLink = { url: httpUrl(str("url"), "Destination URL") };

  const slug = str("slug");
  if (slug) {
    const err = customSlugError(slug);
    if (err) throw new LinkError(err, 400);
    link.slug = slug;
  }

  // expires_ms is filled in by the form's script from the browser's local
  // time; expires_local is the no-JS fallback, interpreted as UTC.
  const expMs = str("expires_ms");
  const expUtc = str("expires_local");
  if (expMs || expUtc) {
    const t = expMs ? Number(expMs) : Date.parse(expUtc + "Z");
    if (!Number.isFinite(t)) throw new LinkError("Expiry is not a valid date.", 400);
    if (t <= now) throw new LinkError("Expiry must be in the future.", 400);
    link.expiresAt = t;
  }

  const max = str("max_clicks");
  if (max) {
    const n = Number(max);
    if (!Number.isInteger(n) || n < 1) throw new LinkError("Click cap must be a whole number ≥ 1.", 400);
    link.maxClicks = n;
  }

  const fb = str("fallback_url");
  if (fb) link.fallbackUrl = httpUrl(fb, "Fallback URL");

  if ((link.expiresAt || link.maxClicks) && !link.fallbackUrl && !env.DEFAULT_FALLBACK_URL) {
    throw new LinkError(
      "Expiry or a click cap needs a fallback URL (or set DEFAULT_FALLBACK_URL in wrangler.toml).",
      400,
    );
  }
  return link;
}

export function toRecord(l: NewLink): LinkRecord {
  const r: LinkRecord = { url: l.url };
  if (l.expiresAt) r.exp = l.expiresAt;
  if (l.maxClicks) r.max = l.maxClicks;
  if (l.fallbackUrl) r.fb = l.fallbackUrl;
  return r;
}

function isUniqueViolation(e: unknown): boolean {
  return /UNIQUE constraint failed|SQLITE_CONSTRAINT/i.test(String((e as Error)?.message ?? e));
}

/**
 * Creates a link. D1's PRIMARY KEY makes the existence check atomic, so two
 * concurrent creates of the same slug cannot both succeed and KV is never
 * overwritten. A custom slug that exists fails with 409; random slugs retry.
 */
export async function createLink(env: Env, link: NewLink, now = Date.now()): Promise<string> {
  const attempts = link.slug ? 1 : 5;
  for (let i = 0; i < attempts; i++) {
    const slug = link.slug ?? randomSlug(6);
    try {
      await env.DB.prepare(
        "INSERT INTO links (slug, url, created_at, expires_at, max_clicks, fallback_url) VALUES (?, ?, ?, ?, ?, ?)",
      )
        .bind(slug, link.url, now, link.expiresAt ?? null, link.maxClicks ?? null, link.fallbackUrl ?? null)
        .run();
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      if (link.slug) throw new LinkError(`The back-half "${slug}" already exists. Nothing was changed.`, 409);
      continue;
    }
    try {
      await env.LINKS.put(slug, JSON.stringify(toRecord(link)));
    } catch (e) {
      // Keep D1 and KV consistent: no registry row without a KV entry.
      await env.DB.prepare("DELETE FROM links WHERE slug = ?").bind(slug).run();
      throw e;
    }
    return slug;
  }
  throw new LinkError("Could not find a free random slug after 5 tries.", 500);
}

export async function deleteLink(env: Env, slug: string): Promise<void> {
  await env.LINKS.delete(slug);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM links WHERE slug = ?").bind(slug),
    env.DB.prepare("DELETE FROM clicks WHERE slug = ?").bind(slug),
  ]);
}
