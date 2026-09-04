import { NextRequest, NextResponse } from "next/server";
import { signIn } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const { email } = await req.json().catch(() => ({}));
  if (!email || typeof email !== "string") {
    return NextResponse.json({ ok: true });
  }

  const normalized = email.toLowerCase().trim();

  // Always return ok — don't leak whether email exists
  const user = await prisma.user.findUnique({ where: { email: normalized } });
  if (!user) return NextResponse.json({ ok: true });

  try {
    // signIn("email") triggers NextAuth's EmailProvider flow:
    // - generates a token in the correct format
    // - stores it in VerificationToken table
    // - calls our sendVerificationRequest (which sends via SendGrid)
    const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://app.erp.io/marketing";
    await signIn("sendgrid", {
      email: normalized,
      redirectTo: appUrl,
      redirect: false,
    });
  } catch (err) {
    // signIn may throw a redirect on some code paths — ignore it
    const digest = (err as { digest?: string })?.digest;
    if (!digest?.startsWith("NEXT_REDIRECT")) {
      console.error("[magic-link] signIn error:", err);
    }
  }

  return NextResponse.json({ ok: true });
}
