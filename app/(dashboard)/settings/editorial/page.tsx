import { redirect } from "next/navigation";
import { getServerSession } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { requireWorkspaceAccess, resolveWorkspaceId } from "@/lib/actions/workspace";
import { NEUTRAL_PROFILE } from "@/lib/content/editorial";
import { EditorialForm } from "./EditorialForm";

export const dynamic = "force-dynamic";
export const metadata = { title: "Editorial profile — marketing.erp.io" };

export default async function EditorialSettingsPage() {
  const session = await getServerSession();
  if (!session?.user) redirect("/login");

  const workspaceId = await resolveWorkspaceId();
  if (!workspaceId) redirect("/settings");
  await requireWorkspaceAccess(workspaceId, "WORKSPACE_ADMIN");

  const saved = await prisma.editorialProfile.findUnique({ where: { workspaceId } });

  return (
    <div className="scrollable">
      <div style={{ marginBottom: 20 }}>
        <h1 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>Editorial profile</h1>
        <p style={{ fontSize: 13, color: "var(--text-muted)", margin: "6px 0 0", maxWidth: 620 }}>
          The rules every piece of content written here is held to. They go into the writer&rsquo;s
          instructions and they are checked again, in code, on the finished draft — so a banned word
          is not a preference, it is a defect that gets sent back. Nothing here is inherited from
          anyone else&rsquo;s house style.
        </p>
      </div>

      <EditorialForm
        workspaceId={workspaceId}
        savedPreset={saved?.preset ?? NEUTRAL_PROFILE.key}
        savedOverrides={(saved?.overrides ?? {}) as Record<string, unknown>}
      />
    </div>
  );
}
