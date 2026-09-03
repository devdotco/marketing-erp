import { auth } from "@/lib/auth";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export default auth((req: NextRequest & { auth: { user?: { id: string; isSuperAdmin?: boolean } } | null }) => {
  const { pathname } = req.nextUrl;
  const session = req.auth;

  // Public routes — always accessible
  const isPublic =
    pathname.startsWith("/login") ||
    pathname.startsWith("/signup") ||
    pathname.startsWith("/start") ||
    pathname.startsWith("/invite/") ||
    pathname.startsWith("/api/auth") ||
    pathname.startsWith("/api/admin") ||
    pathname.startsWith("/api/webhooks") ||
    pathname.startsWith("/_next") ||
    pathname.startsWith("/favicon") ||
    pathname === "/";

  if (isPublic) return NextResponse.next();

  // Must be authenticated for all other routes
  if (!session?.user) {
    const loginUrl = new URL("/login", req.url);
    loginUrl.searchParams.set("callbackUrl", pathname);
    return NextResponse.redirect(loginUrl);
  }

  // Super admin routes — require SUPER_ADMIN role
  if (pathname.startsWith("/superadmin") && !session.user.isSuperAdmin) {
    return NextResponse.rewrite(new URL("/403", req.url));
  }

  // Onboarding route — accessible to all authenticated users
  if (pathname.startsWith("/onboarding")) return NextResponse.next();

  return NextResponse.next();
});

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.png$|.*\\.svg$).*)"],
};
