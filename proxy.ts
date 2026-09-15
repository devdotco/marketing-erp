import { auth } from "@/lib/auth";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { BASE_PATH, withBase } from "@/lib/base-path";
import { SHELL_SESSION_COOKIE, shellHandoffUrl } from "@/lib/shell-handoff";

/** The path as this app names it, whether or not the mount arrived attached. */
function stripBase(pathname: string): string {
  if (pathname === BASE_PATH) return "/";
  return pathname.startsWith(`${BASE_PATH}/`) ? pathname.slice(BASE_PATH.length) : pathname;
}

export default auth((req: NextRequest & { auth: { user?: { id: string; isSuperAdmin?: boolean } } | null }) => {
  // The mount, removed before anything is matched.
  //
  // What `nextUrl.pathname` contains here is not something to assume: Next has
  // shipped it both with the base path stripped and with it present, and this
  // file has to be right either way. With the mount left on, NONE of the public
  // prefixes below match — `/marketing/start` does not start with `/start` — so
  // every route in the app became private at once and bounced to a sign-in page
  // on the shell's origin. Stripping it when present makes the rules below read
  // as app paths, which is what they are.
  const pathname = stripBase(req.nextUrl.pathname);
  const session = req.auth;

  // Infrastructure routes — never gated, and never candidates for the SSO fast
  // path below. `/api/auth` in particular is where the shell hand-off itself is
  // REDEEMED (`/api/auth/shell`) and where NextAuth's own routes live: sending
  // either of those back to the shell for a token they were about to consume is
  // exactly the redirect loop the fast path has to avoid.
  const isInfra =
    pathname.startsWith("/invite/") ||
    pathname.startsWith("/api/auth") ||
    pathname.startsWith("/api/admin") ||
    pathname.startsWith("/api/cron") ||
    pathname.startsWith("/api/linkedin") ||
    pathname.startsWith("/api/x") ||
    pathname.startsWith("/api/webhooks") ||
    // Shell workspace-mirror: authenticated by the shell's signature (events)
    // or the shell service secret (reconcile), never by a browser session.
    pathname.startsWith("/api/shell-mirror") ||
    // Deploy gate and uptime monitor — must answer without a session, and it
    // reports only whether the configured Claude models resolve.
    pathname.startsWith("/api/health") ||
    pathname.startsWith("/_next") ||
    pathname.startsWith("/favicon");

  if (isInfra) return NextResponse.next();

  // FAST PATH. Signed in to the suite (the shell's `__vibe_session` cookie is
  // present — readable here because every module now shares app.erp.io as its
  // origin) but not yet to Marketing: hand off silently rather than showing
  // `/login` or the public `/start` sign-up page. This is what makes
  // `app.erp.io/marketing` land suite users straight in their workspace
  // instead of the "create your free account" page.
  //
  // Two things keep this from looping:
  //  - `session` (Marketing's OWN session) is checked FIRST. An existing
  //    Marketing session is never bounced back to the shell just because the
  //    shell cookie is also present — the ordering bug fixed in Sign on
  //    2026-09-15 was exactly this check running before the module's session.
  //  - Guarded on there being no `error`/`reason` query param, and excluded
  //    from `/api/*` (a `fetch()` call gets the pre-existing 401/redirect
  //    behavior below, not a cross-origin bounce a program cannot follow). The
  //    shell's mint never redirects a refusal back to this app — see
  //    app-erp-io module-token/route.ts — but a bare guard against retrying
  //    costs nothing and matches the pattern used estate-wide.
  //
  // `pathname` is passed as `next` UNMOUNTED — the module's own callback adds
  // the mount back with `withBase`.
  if (!session?.user && !pathname.startsWith("/api/")) {
    const shellCookie = req.cookies.get(SHELL_SESSION_COOKIE)?.value;
    const alreadyTried = req.nextUrl.searchParams.has("error") || req.nextUrl.searchParams.has("reason");
    if (shellCookie && !alreadyTried) {
      return NextResponse.redirect(shellHandoffUrl(`${pathname}${req.nextUrl.search}`));
    }
  }

  // Public routes — reachable with no session of any kind (nobody to hand off)
  const isPublic =
    pathname.startsWith("/login") ||
    pathname.startsWith("/signup") ||
    pathname.startsWith("/start") ||
    pathname === "/";

  if (isPublic) return NextResponse.next();

  // Must be authenticated for all other routes
  if (!session?.user) {
    // `withBase`, because `new URL("/login", req.url)` resolves against the
    // ORIGIN — which is now shared with the shell, so a bare "/login" is the
    // shell's sign-in for a different application.
    const loginUrl = new URL(withBase("/login"), req.url);
    loginUrl.searchParams.set("callbackUrl", withBase(pathname));
    return NextResponse.redirect(loginUrl);
  }

  // Super admin routes — require SUPER_ADMIN role
  if (pathname.startsWith("/superadmin") && !session.user.isSuperAdmin) {
    return NextResponse.rewrite(new URL(withBase("/403"), req.url));
  }

  // Onboarding route — accessible to all authenticated users
  if (pathname.startsWith("/onboarding")) return NextResponse.next();

  return NextResponse.next();
});

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.png$|.*\\.svg$).*)"],
};
