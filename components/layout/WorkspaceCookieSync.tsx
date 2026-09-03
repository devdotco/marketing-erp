"use client";

import { useEffect } from "react";
import { setActiveWorkspace } from "@/lib/actions/workspace";

// Silently syncs the active_workspace_id cookie on first client render.
// The dashboard layout already resolves the workspace server-side, but
// without this the cookie never gets written when it's missing, so every
// page navigation falls back to a DB lookup indefinitely.
export function WorkspaceCookieSync({ workspaceId }: { workspaceId: string }) {
  useEffect(() => {
    setActiveWorkspace(workspaceId).catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}
