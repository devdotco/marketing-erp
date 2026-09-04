import { auth } from "@/lib/auth";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { BASE_PATH, withBase } from "@/lib/base-path";

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

  // Public routes — always accessible
  const isPublic =
    pathname.startsWith("/login") ||
    pathname.startsWith("/signup") ||
    pathname.startsWith("/start") ||
    pathname.startsWith("/invite/") ||
    pathname.startsWith("/api/auth") ||
    pathname.startsWith("/api/admin") ||
    pathname.startsWith("/api/cron") ||
    pathname.startsWith("/api/linkedin") ||
    pathname.startsWith("/api/x") ||
    pathname.startsWith("/api/webhooks") ||
    pathname.startsWith("/_next") ||
    pathname.startsWith("/favicon") ||
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
