import { describe, expect, it } from "vitest";
import { customSlugError, randomSlug } from "../src/slug";
import { deviceFromUA } from "../src/device";
import { createLink, LinkError, parseLinkForm } from "../src/links";
import { hasSession, issueSession, passwordMatches, sameOrigin } from "../src/auth";
import type { Env } from "../src/types";

const env = (over: Partial<Env> = {}) =>
  ({ BASE_URL: "https://go.example.com", ADMIN_PASSWORD: "correct horse battery", ...over }) as Env;

const form = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};

describe("slugs", () => {
  it("random slugs are 6 base62 chars", () => {
    for (let i = 0; i < 1000; i++) expect(randomSlug()).toMatch(/^[0-9A-Za-z]{6}$/);
  });
  it("uses the whole alphabet", () => {
    const seen = new Set([...Array.from({ length: 2000 }, () => randomSlug()).join("")]);
    expect(seen.size).toBe(62);
  });
  it("validates custom back-halves", () => {
    expect(customSlugError("spring-sale_2026")).toBeNull();
    expect(customSlugError("admin")).toMatch(/reserved/);
    expect(customSlugError("QR")).toMatch(/reserved/);
    expect(customSlugError("has space")).not.toBeNull();
    expect(customSlugError("a/b")).not.toBeNull();
    expect(customSlugError("x".repeat(65))).not.toBeNull();
  });
});

describe("deviceFromUA", () => {
  it.each([
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148", "mobile"],
    ["Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36", "mobile"],
    ["Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 Chrome/120 Safari/537.36", "tablet"],
    ["Mozilla/5.0 (iPad; CPU OS 12_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148", "tablet"],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36", "desktop"],
    ["Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)", "bot"],
    ["WhatsApp/2.23.20.0 A", "bot"],
    ["facebookexternalhit/1.1", "bot"],
    ["curl/8.5.0", "bot"],
    [null, "unknown"],
  ])("%s -> %s", (ua, want) => expect(deviceFromUA(ua)).toBe(want));
});

describe("parseLinkForm", () => {
  const now = 1_700_000_000_000;
  it("accepts a plain URL", () => {
    expect(parseLinkForm(form({ url: "https://example.com/x" }), env(), now)).toEqual({ url: "https://example.com/x" });
  });
  it("rejects non-http URLs", () => {
    expect(() => parseLinkForm(form({ url: "javascript:alert(1)" }), env(), now)).toThrow(LinkError);
  });
  it("requires a fallback for expiry or cap", () => {
    expect(() => parseLinkForm(form({ url: "https://a.com", max_clicks: "5" }), env(), now)).toThrow(/fallback/);
    expect(parseLinkForm(form({ url: "https://a.com", max_clicks: "5" }), env({ DEFAULT_FALLBACK_URL: "https://d.com" }), now).maxClicks).toBe(5);
  });
  it("rejects past expiry and bad caps", () => {
    const base = { url: "https://a.com", fallback_url: "https://f.com" };
    expect(() => parseLinkForm(form({ ...base, expires_ms: String(now - 1) }), env(), now)).toThrow(/future/);
    expect(() => parseLinkForm(form({ ...base, max_clicks: "0" }), env(), now)).toThrow(/cap/);
    expect(() => parseLinkForm(form({ ...base, max_clicks: "1.5" }), env(), now)).toThrow(/cap/);
  });
  it("falls back to UTC when the browser script didn't run", () => {
    const l = parseLinkForm(form({ url: "https://a.com", fallback_url: "https://f.com", expires_local: "2030-01-01T00:00" }), env(), now);
    expect(l.expiresAt).toBe(Date.UTC(2030, 0, 1));
  });
});

/** Minimal D1/KV fake: enough to exercise the duplicate-slug path. */
function fakeEnv() {
  const rows = new Set<string>();
  const kv = new Map<string, string>();
  const DB = {
    prepare(sql: string) {
      let args: unknown[] = [];
      const stmt = {
        bind: (...a: unknown[]) => ((args = a), stmt),
        async run() {
          const slug = args[0] as string;
          if (sql.startsWith("INSERT")) {
            if (rows.has(slug)) throw new Error("D1_ERROR: UNIQUE constraint failed: links.slug: SQLITE_CONSTRAINT");
            rows.add(slug);
          } else if (sql.startsWith("DELETE")) rows.delete(slug);
          return { success: true };
        },
      };
      return stmt;
    },
  };
  const LINKS = { put: async (k: string, v: string) => void kv.set(k, v) };
  return { e: env({ DB: DB as unknown as D1Database, LINKS: LINKS as unknown as KVNamespace }), kv };
}

describe("createLink", () => {
  it("fails loudly on an existing custom slug and never overwrites KV", async () => {
    const { e, kv } = fakeEnv();
    await createLink(e, { url: "https://first.com/", slug: "promo" });
    const err = await createLink(e, { url: "https://second.com/", slug: "promo" }).catch((x) => x);
    expect(err).toBeInstanceOf(LinkError);
    expect(err.status).toBe(409);
    expect(JSON.parse(kv.get("promo")!).url).toBe("https://first.com/");
  });
  it("stores expiry, cap and fallback in the KV record", async () => {
    const { e, kv } = fakeEnv();
    const slug = await createLink(e, { url: "https://a.com/", expiresAt: 5, maxClicks: 3, fallbackUrl: "https://f.com/" });
    expect(slug).toMatch(/^[0-9A-Za-z]{6}$/);
    expect(JSON.parse(kv.get(slug)!)).toEqual({ url: "https://a.com/", exp: 5, max: 3, fb: "https://f.com/" });
  });
});

describe("auth", () => {
  it("checks the password", async () => {
    expect(await passwordMatches(env(), "correct horse battery")).toBe(true);
    expect(await passwordMatches(env(), "wrong")).toBe(false);
    expect(await passwordMatches(env({ ADMIN_PASSWORD: undefined }), "")).toBe(false);
  });
  it("round-trips a session and rejects tampering, expiry and rotation", async () => {
    const now = 1_700_000_000_000;
    const cookie = (await issueSession(env(), now)).split(";")[0];
    const req = (c: string) => new Request("https://go.example.com/admin", { headers: { cookie: c } });
    expect(await hasSession(req(cookie), env(), now)).toBe(true);
    expect(await hasSession(req(cookie.slice(0, -2) + "xx"), env(), now)).toBe(false);
    expect(await hasSession(req(cookie), env(), now + 8 * 86_400_000)).toBe(false);
    expect(await hasSession(req(cookie), env({ ADMIN_PASSWORD: "rotated" }), now)).toBe(false);
  });
  it("refuses cross-site POSTs", () => {
    const r = (h: Record<string, string>) => new Request("https://go.example.com/admin/links", { method: "POST", headers: h });
    expect(sameOrigin(r({ "sec-fetch-site": "same-origin" }))).toBe(true);
    expect(sameOrigin(r({ "sec-fetch-site": "cross-site" }))).toBe(false);
    expect(sameOrigin(r({ origin: "https://evil.example" }))).toBe(false);
    expect(sameOrigin(r({ origin: "https://go.example.com" }))).toBe(true);
  });
});
