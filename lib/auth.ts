import NextAuth from "next-auth";
import { PrismaAdapter } from "@auth/prisma-adapter";
import CredentialsProvider from "next-auth/providers/credentials";
import GoogleProvider from "next-auth/providers/google";
import SendGridProvider from "next-auth/providers/sendgrid";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { verifyShellToken } from "@/lib/shell-token";
import { provisionFromShell } from "@/lib/shell-provision";
import { $Enums } from "@prisma/client";
type MemberRole = $Enums.MemberRole;

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      name?: string | null;
      email?: string | null;
      image?: string | null;
      isSuperAdmin: boolean;
    };
  }
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: PrismaAdapter(prisma),
  // The app is mounted at /marketing, and NextAuth builds its own callback URLs
  // from this rather than from Next's basePath. Left at the default it would
  // send providers to app.erp.io/api/auth/callback/… — the SHELL's origin, which
  // has no such route.
  basePath: "/marketing/api/auth",
  // Required when running behind Cloudflare / Traefik — without this NextAuth v5
  // throws UntrustedHost on every session check
  trustHost: true,
  // JWT strategy is required for CredentialsProvider — database sessions don't
  // support credentials-based auth in NextAuth v5
  session: { strategy: "jwt" },

  // Shared .erp.io cookie so all subdomains share a single session
  cookies: {
    sessionToken: {
      name:
        process.env.NODE_ENV === "production"
          ? "__Secure-next-auth.session-token"
          : "next-auth.session-token",
      options: {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        secure: process.env.NODE_ENV === "production",
        domain:
          process.env.NODE_ENV === "production" ? ".erp.io" : undefined,
      },
    },
  },

  providers: [
    CredentialsProvider({
      name: "credentials",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) return null;
        try {
          const user = await prisma.user.findUnique({
            where: { email: credentials.email as string },
          });
          if (!user?.passwordHash) return null;
          const valid = await bcrypt.compare(
            credentials.password as string,
            user.passwordHash
          );
          if (!valid) return null;
          return { id: user.id, email: user.email, name: user.name, image: user.image };
        } catch (err) {
          console.error("[auth] authorize error:", err);
          return null;
        }
      },
    }),

    /**
     * Arriving from app.erp.io.
     *
     * A provider rather than a bespoke route because NextAuth owns session
     * creation here: minting a session cookie by hand beside it is how two
     * notions of "signed in" start to disagree. The token is the credential —
     * short-lived, single-audience, signed by the shell — and it is verified
     * before anything is written.
     *
     * Local password and Google sign-in keep working alongside this. Somebody
     * who already has an account here is matched on their email rather than
     * given a second one.
     */
    CredentialsProvider({
      id: "shell",
      name: "erp.io",
      credentials: { token: { label: "Shell token", type: "text" } },
      async authorize(credentials) {
        const token = credentials?.token;
        if (typeof token !== "string" || !token) return null;
        try {
          const claims = await verifyShellToken(token);
          const user = await provisionFromShell(claims);
          return { id: user.id, email: user.email, name: user.name, image: user.image };
        } catch (err) {
          // Never surfaced to the browser: the reason a signature failed is a
          // signature oracle. Logged so a real misconfiguration is findable.
          console.error("[auth] shell hand-off rejected:", (err as Error).message);
          return null;
        }
      },
    }),

    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID ?? "",
      clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
      allowDangerousEmailAccountLinking: true,
    }),

    // SendGrid email provider for magic links — no nodemailer required
    SendGridProvider({
      apiKey: process.env.SENDGRID_API_KEY ?? "",
      from: process.env.EMAIL_FROM ?? "noreply@erp.io",
    }),
  ],

  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.sub = user.id;
      }
      return token;
    },

    async session({ session, token }) {
      if (session.user && token?.sub) {
        session.user.id = token.sub;
        try {
          const superAdminMembership = await prisma.workspaceMember.findFirst({
            where: { userId: token.sub, role: "SUPER_ADMIN" as MemberRole },
          });
          session.user.isSuperAdmin = !!superAdminMembership;
        } catch {
          session.user.isSuperAdmin = false;
        }
      }
      return session;
    },
  },

  pages: {
    signIn: "/login",
    error: "/login",
    verifyRequest: "/verify-request",
  },
});
