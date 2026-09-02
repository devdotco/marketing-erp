import { NextRequest, NextResponse } from "next/server";
import { signIn } from "@/lib/auth";

// NextAuth v5 Email provider is triggered via signIn("email")
// This route wraps it so the client can call it as a JSON API
export async function POST(req: NextRequest) {
  const { email } = await req.json().catch(() => ({}));
  if (!email || typeof email !== "string") {
    return NextResponse.json({ error: "Email required" }, { status: 400 });
  }

  try {
    await signIn("email", {
      email: email.toLowerCase().trim(),
      redirect: false,
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[magic-link]", err);
    // Return ok anyway — don't leak whether the email exists
    return NextResponse.json({ ok: true });
  }
}
