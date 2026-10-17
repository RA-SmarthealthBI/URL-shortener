import type { Env } from "./types";
import { handleAdmin } from "./admin";
import { handleQr } from "./qr";
import { handleRedirect } from "./redirect";

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const { pathname } = new URL(req.url);

    if (pathname === "/admin" || pathname.startsWith("/admin/")) return handleAdmin(req, env, pathname);

    if (req.method !== "GET" && req.method !== "HEAD") return new Response("Method not allowed", { status: 405 });

    if (pathname === "/robots.txt") {
      // Keep crawlers from following (and inflating) short links.
      return new Response("User-agent: *\nDisallow: /\n", { headers: { "content-type": "text/plain" } });
    }

    const qr = pathname.match(/^\/qr\/([A-Za-z0-9_-]{1,64})$/);
    if (qr) return handleQr(req, env, ctx, qr[1]);

    const slug = pathname.match(/^\/([A-Za-z0-9_-]{1,64})$/);
    if (slug) return handleRedirect(req, env, ctx, slug[1]);

    return new Response("Not found", { status: 404, headers: { "content-type": "text/plain" } });
  },
} satisfies ExportedHandler<Env>;
