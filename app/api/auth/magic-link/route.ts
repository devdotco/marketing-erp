import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { sendMagicLink } from "@/lib/email";
import { randomBytes } from "crypto";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const { email } = await req.json().catch(() => ({}));
  if (!email || typeof email !== "string") {
    return NextResponse.json({ ok: true }); // don't leak info
  }

  const normalized = email.toLowerCase().trim();

  // Always return ok — don't leak whether email exists
  const user = await prisma.user.findUnique({ where: { email: normalized } });
  if (!user) return NextResponse.json({ ok: true });

  // Create a VerificationToken (same table NextAuth Email provider uses)
  const token = randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h

  // Delete any existing token for this email first
  await prisma.verificationToken.deleteMany({ where: { identifier: normalized } });
  await prisma.verificationToken.create({ data: { identifier: normalized, token, expires } });

  // Build the NextAuth callback URL (same format NextAuth uses)
  const appUrl = process.env.NEXTAUTH_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? "https://marketing.erp.io";
  const callbackUrl = `${appUrl}/api/auth/callback/email?callbackUrl=${encodeURIComponent(appUrl)}&token=${token}&email=${encodeURIComponent(normalized)}`;

  await sendMagicLink(normalized, callbackUrl);

  return NextResponse.json({ ok: true });
}
