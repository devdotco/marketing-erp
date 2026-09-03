import { redirect } from "next/navigation";
import { getServerSession } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import OnboardingForm from "./OnboardingForm";

export const metadata = { title: "Get started — marketing.erp.io" };

export default async function OnboardingPage() {
  const session = await getServerSession();
  if (!session?.user) redirect("/login");

  // If the user already has a completed workspace, skip onboarding
  const completedProfile = await prisma.businessProfile.findFirst({
    where: {
      workspace: { members: { some: { userId: session.user.id } } },
      onboardingCompletedAt: { not: null },
    },
  });

  if (completedProfile) redirect("/agents");

  return <OnboardingForm />;
}
