import { cookies } from "next/headers";

/**
 * The active-workspace cookie, written in one place.
 *
 * Not in lib/actions/workspace.ts: every export of a "use server" file is a
 * callable endpoint, and this writes the cookie WITHOUT checking membership —
 * callers must already have established it (setActiveWorkspace checks; the
 * shell hand-off has just created the membership itself).
 */
export const ACTIVE_WORKSPACE_COOKIE = "active_workspace_id";

export async function writeActiveWorkspaceCookie(workspaceId: string): Promise<void> {
  const jar = await cookies();
  jar.set(ACTIVE_WORKSPACE_COOKIE, workspaceId, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: process.env.NODE_ENV === "production",
    domain: process.env.NODE_ENV === "production" ? ".erp.io" : undefined,
    maxAge: 60 * 60 * 24 * 30, // 30 days
  });
}
