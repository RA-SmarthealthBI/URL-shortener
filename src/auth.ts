import type { Env } from "./types";

export const COOKIE = "__Host-go_admin";
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
const enc = new TextEncoder();

// The HMAC key is derived from ADMIN_PASSWORD itself, so rotating the secret
// invalidates every existing session. No session storage needed.
async function key(password: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", enc.encode(password), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

async function mac(password: string, msg: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.sign("HMAC", await key(password), enc.encode(msg)));
}

function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** Constant-time password check: compares HMACs, not the raw strings. */
export async function passwordMatches(env: Env, attempt: string): Promise<boolean> {
  const pw = env.ADMIN_PASSWORD;
  if (!pw) return false;
  return equalBytes(await mac(pw, "pw:" + attempt), await mac(pw, "pw:" + pw));
}

export async function issueSession(env: Env, now = Date.now()): Promise<string> {
  const exp = now + SESSION_MS;
  const sig = b64url(await mac(env.ADMIN_PASSWORD!, `session:${exp}`));
  return `${COOKIE}=${exp}.${sig}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_MS / 1000}`;
}

export function clearSession(): string {
  return `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

export async function hasSession(req: Request, env: Env, now = Date.now()): Promise<boolean> {
  if (!env.ADMIN_PASSWORD) return false;
  const cookie = req.headers.get("cookie") ?? "";
  const m = cookie.match(new RegExp(`(?:^|;\\s*)${COOKIE}=(\\d+)\\.([A-Za-z0-9_-]+)`));
  if (!m) return false;
  const exp = Number(m[1]);
  if (!(exp > now)) return false;
  const expected = b64url(await mac(env.ADMIN_PASSWORD, `session:${exp}`));
  return equalBytes(enc.encode(expected), enc.encode(m[2]));
}

/**
 * CSRF guard for state-changing requests. SameSite=Strict already keeps the
 * cookie off cross-site POSTs; this also refuses anything a browser labels as
 * cross-site. Sec-Fetch-Site is preferred over comparing Origin to req.url
 * because `wrangler dev` rewrites req.url to the production hostname.
 */
export function sameOrigin(req: Request): boolean {
  const site = req.headers.get("sec-fetch-site");
  if (site) return site === "same-origin" || site === "none";
  const origin = req.headers.get("origin");
  return origin === null || origin === new URL(req.url).origin;
}
