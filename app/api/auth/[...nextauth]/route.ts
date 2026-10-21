import { NextRequest } from "next/server";
import { handlers } from "@/lib/auth";
import { ensureBase } from "@/lib/base-path";
export const dynamic = "force-dynamic";

/**
 * Put the mount back on the request before Auth.js sees it.
 *
 * Auth.js matches the action against `basePath` ("/marketing/api/auth"), but
 * Next hands this route handler a URL with "/marketing" already stripped. Every
 * action — providers, csrf, session, the Google callback — then failed to parse
 * and answered a bare 400 "Bad request.", so nobody could sign in at all. Next
 * has shipped both behaviours, so add the mount only when it is missing.
 */
function withMount(req: NextRequest): NextRequest {
  const url = new URL(req.url);
  const pathname = ensureBase(url.pathname);
  if (pathname === url.pathname) return req;
  url.pathname = pathname;
  return new NextRequest(url, req);
}

export const GET = (req: NextRequest) => handlers.GET(withMount(req));
export const POST = (req: NextRequest) => handlers.POST(withMount(req));
