const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** Paths the worker serves itself; they can never be slugs. */
export const RESERVED = new Set(["admin", "qr", "favicon.ico", "robots.txt"]);

const CUSTOM_SLUG = /^[A-Za-z0-9_-]{1,64}$/;

/** Random base62 slug using rejection sampling so every character is equally likely. */
export function randomSlug(length = 6): string {
  let out = "";
  const buf = new Uint8Array(length * 2);
  while (out.length < length) {
    crypto.getRandomValues(buf);
    for (const b of buf) {
      // 248 = 62 * 4; bytes >= 248 would bias the first 8 characters.
      if (b < 248) out += BASE62[b % 62];
      if (out.length === length) break;
    }
  }
  return out;
}

export function customSlugError(slug: string): string | null {
  if (!CUSTOM_SLUG.test(slug)) return "Custom back-half must be 1-64 characters of A-Z, a-z, 0-9, '-' or '_'.";
  if (RESERVED.has(slug.toLowerCase())) return `"${slug}" is reserved.`;
  return null;
}
