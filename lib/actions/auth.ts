"use server";

import { prisma } from "@/lib/prisma";
import bcrypt from "bcryptjs";
import { signIn } from "@/lib/auth";
import { redirect } from "next/navigation";
import { z } from "zod";

const SignUpSchema = z.object({
  name: z.string().min(2, "Name must be at least 2 characters"),
  email: z.string().email("Invalid email address"),
  password: z.string().min(8, "Password must be at least 8 characters"),
  workspaceName: z.string().min(2, "Workspace name must be at least 2 characters").optional(),
  referralSource: z.string().optional(),
});

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
}

async function uniqueSlug(base: string): Promise<string> {
  let slug = slugify(base);
  let attempt = 0;
  while (true) {
    const candidate = attempt === 0 ? slug : `${slug}-${attempt}`;
    const existing = await prisma.workspace.findUnique({ where: { slug: candidate } });
    if (!existing) return candidate;
    attempt++;
  }
}

export async function signUp(formData: FormData) {
  const raw = {
    name: formData.get("name"),
    email: formData.get("email"),
    password: formData.get("password"),
    workspaceName: formData.get("workspaceName") || undefined,
    referralSource: formData.get("referralSource") || undefined,
  };

  const parsed = SignUpSchema.safeParse(raw);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const { name, email, password, workspaceName, referralSource } = parsed.data;

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    return { error: "An account with this email already exists." };
  }

  const passwordHash = await bcrypt.hash(password, 12);

  const user = await prisma.user.create({
    data: {
      name,
      email,
      passwordHash,
      referralSource: referralSource || null,
    },
  });

  // Create default workspace
  const wsName = workspaceName || `${name}'s Workspace`;
  const slug = await uniqueSlug(wsName);

  const workspace = await prisma.workspace.create({
    data: {
      name: wsName,
      slug,
      members: {
        create: {
          userId: user.id,
          role: "WORKSPACE_ADMIN",
        },
      },
      businessProfile: {
        create: {
          businessName: wsName,
          onboardingStep: 1,
        },
      },
    },
  });

  // Sign in immediately after registration
  await signIn("credentials", {
    email,
    password,
    redirect: false,
  });

  // Redirect based on referral — marketing wedge goes straight to onboarding
  const destination =
    referralSource === "digitalmarketers.ai"
      ? `/onboarding?workspace=${workspace.id}`
      : `/onboarding?workspace=${workspace.id}`;

  redirect(destination);
}

export async function loginWithCredentials(formData: FormData) {
  const email = formData.get("email") as string;
  const password = formData.get("password") as string;
  const callbackUrl = (formData.get("callbackUrl") as string) || "/";

  try {
    await signIn("credentials", { email, password, redirectTo: callbackUrl });
  } catch {
    return { error: "Invalid email or password." };
  }
}
