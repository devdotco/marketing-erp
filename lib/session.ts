/**
 * Read-only session helper for Server Components.
 *
 * NextAuth v5's auth() can try to refresh/write the session cookie when called
 * from Server Components, which throws in Next.js 16. This helper decodes the
 * JWT directly (read-only) and never sets any cookies.
 *
 * Use this everywhere in Server Component pages instead of auth().
 * auth() is still correct in Route Handlers and Server Actions.
 */
import { decode } from "@auth/core/jwt";
import { cookies } from "next/headers";

export interface ServerSession {
  user: {
    id: string;
    email: string | null;
    name: string | null;
    image: string | null;
    isSuperAdmin: boolean;
  };
}

export async function getServerSession(): Promise<ServerSession | null> {
  const isProd = process.env.NODE_ENV === "production";
  const cookieName = isProd
    ? "__Secure-next-auth.session-token"
    : "next-auth.session-token";

  const cookieStore = await cookies();
  const tokenValue = cookieStore.get(cookieName)?.value;
  if (!tokenValue) return null;

  try {
    const token = await decode({
      token: tokenValue,
      secret: process.env.NEXTAUTH_SECRET!,
      salt: cookieName,
    });

    if (!token?.sub) return null;

    return {
      user: {
        id: token.sub,
        email: (token.email as string) ?? null,
        name: (token.name as string) ?? null,
        image: (token.picture as string) ?? null,
        isSuperAdmin: false,
      },
    };
  } catch {
    return null;
  }
}
