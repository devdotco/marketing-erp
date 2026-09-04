import { NextRequest, NextResponse } from "next/server";
import { signIn } from "@/lib/auth";

/**
 * Where the shell hands off.
 *
 *   app.erp.io/api/shell/auth/module-token?aud=marketing&next=/
 *     → marketing.erp.io/api/auth/shell?token=…&next=/
 *
 * Deliberately NOT under `/api/auth/callback`. That path belongs to NextAuth,
 * which routes it by provider — a bare `/api/auth/callback?token=…` is not a
 * route it has, so it answered `/login?error=Configuration` and a new customer's
 * first impression of the product was a login error. This is the app's own
 * path, and it hands the token to the provider that knows what to do with it.
 */
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token");
  const next = safeNext(req.nextUrl.searchParams.get("next"));

  if (!token) return fail("missing token");

  try {
    // Throws a redirect on success, which is what we want to escape into.
    await signIn("shell", { token, redirectTo: next });
    return fail("sign in did not complete");
  } catch (err) {
    // NextAuth signals its redirect by throwing; anything with a digest is that
    // and must be rethrown or the person never leaves this route.
    if (isRedirect(err)) throw err;
    console.error("[auth] shell hand-off failed:", (err as Error).message);
    return fail("hand-off failed");
  }
}

/** A path inside this app, never a URL — an open redirect on a sign-in route is a way out with a session. */
function safeNext(raw: string | null): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) return "/";
  return raw;
}

function isRedirect(err: unknown): boolean {
  return typeof (err as { digest?: unknown } | null)?.digest === "string"
    && ((err as { digest: string }).digest.startsWith("NEXT_REDIRECT"));
}

/**
 * Back to the login page with something a person can act on.
 *
 * The reason is a fixed short string, never the verification error: why a
 * signature failed is information an attacker is asking for.
 */
function fail(reason: string): NextResponse {
  const url = new URL("/login", process.env.NEXTAUTH_URL ?? "https://marketing.erp.io");
  url.searchParams.set("error", "ShellHandoff");
  url.searchParams.set("detail", reason);
  return NextResponse.redirect(url);
}
