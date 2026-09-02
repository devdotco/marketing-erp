import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { sendPasswordReset } from "@/lib/email";
import { randomBytes } from "crypto";

// POST /api/auth/reset-password — request a reset link
export async function POST(req: NextRequest) {
  const { email } = await req.json().catch(() => ({}));
  if (!email || typeof email !== "string") {
    return NextResponse.json({ error: "Email is required." }, { status: 400 });
  }

  // Always return 200 to avoid leaking whether an account exists
  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase().trim() } });
  if (!user) return NextResponse.json({ ok: true });

  // Token: random 32-byte hex, expires 1 hour
  const token = randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + 60 * 60 * 1000);

  await prisma.verificationToken.upsert({
    where: { identifier_token: { identifier: email, token } },
    create: { identifier: email, token, expires },
    update: { token, expires },
  });

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://marketing.erp.io";
  const resetUrl = `${appUrl}/reset-password?token=${token}&email=${encodeURIComponent(email)}`;

  await sendPasswordReset(email, resetUrl);

  return NextResponse.json({ ok: true });
}

// PUT /api/auth/reset-password — consume token and set new password
export async function PUT(req: NextRequest) {
  const { email, token, password } = await req.json().catch(() => ({}));

  if (!email || !token || !password || password.length < 8) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const record = await prisma.verificationToken.findUnique({
    where: { identifier_token: { identifier: email, token } },
  });

  if (!record || record.expires < new Date()) {
    return NextResponse.json({ error: "This link has expired. Please request a new one." }, { status: 400 });
  }

  const bcrypt = await import("bcryptjs");
  const passwordHash = await bcrypt.hash(password, 12);

  await prisma.$transaction([
    prisma.user.update({
      where: { email },
      data: { passwordHash, emailVerified: new Date() },
    }),
    prisma.verificationToken.delete({
      where: { identifier_token: { identifier: email, token } },
    }),
  ]);

  return NextResponse.json({ ok: true });
}
