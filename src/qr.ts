// qrcode's package.json "browser" field (which wrangler honours) swaps in a
// canvas-only build without toBuffer; the server entry has the PNG renderer.
import QRCode from "qrcode/lib/server";
import type { Env } from "./types";

const SIZES = new Set([256, 512, 1024]);

// pngjs defaults try all five row filters and deflate at level 9: ~20 ms of
// CPU for 512 px, over the free plan's 10 ms. The "up" filter on RGBA is ~4x
// cheaper and still compresses a QR code to a few KB.
const RENDERER_OPTS = { filterType: 2, deflateLevel: 6 };

export function renderQrPng(text: string, width: number): Promise<Uint8Array> {
  return QRCode.toBuffer(text, {
    type: "png",
    width,
    margin: 4,
    errorCorrectionLevel: "M",
    // Not in @types/qrcode, but passed straight through to pngjs.
    rendererOpts: RENDERER_OPTS,
  } as QRCode.QRCodeToBufferOptions);
}

/**
 * PNG QR code for go.mydomain.com/{slug}. The image only encodes the short
 * link, so it never changes for a given slug and can be cached hard: print
 * material keeps pointing at the tracked link even if the destination changes.
 */
export async function handleQr(req: Request, env: Env, ctx: ExecutionContext, slug: string): Promise<Response> {
  const url = new URL(req.url);
  const size = Number(url.searchParams.get("size") ?? 512);
  if (!SIZES.has(size)) return new Response("size must be 256, 512 or 1024", { status: 400 });

  // Normalised cache key: ignore any other query params.
  const cacheKey = new Request(`${url.origin}/qr/${encodeURIComponent(slug)}?size=${size}`);
  const cache = caches.default;
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  // Don't mint QR codes for slugs that don't exist.
  if (!(await env.LINKS.get(slug))) return new Response("Link not found", { status: 404 });

  const png = await renderQrPng(`${env.BASE_URL}/${slug}`, size);
  const res = new Response(png, {
    headers: {
      "content-type": "image/png",
      "cache-control": "public, max-age=31536000, immutable",
      "content-disposition": `inline; filename="qr-${slug}-${size}.png"`,
    },
  });
  // Cache API is per data centre and only works on a custom domain/route.
  ctx.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}
