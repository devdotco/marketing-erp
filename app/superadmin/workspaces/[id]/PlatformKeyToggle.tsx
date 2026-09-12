"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { apiFetch } from "@/lib/base-path";

/**
 * Whether this workspace may run on the platform's own Anthropic key.
 *
 * Off is the correct answer for every customer: their runs belong on their key,
 * on their account, under their own limits. On is for the workspaces we operate
 * ourselves, where billing ourselves through a tenant key would be theatre.
 */
export function PlatformKeyToggle({
  workspaceId,
  initial,
  hasOwnKey,
  designated,
  slug,
}: {
  workspaceId: string;
  initial: boolean;
  hasOwnKey: boolean;
  /** Whether the slug appears in PLATFORM_KEY_WORKSPACES. */
  designated: boolean;
  slug: string;
}) {
  const [allowed, setAllowed] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  function toggle(next: boolean) {
    setError(null);
    const previous = allowed;
    setAllowed(next);
    startTransition(async () => {
      try {
        const res = await apiFetch("/api/admin/platform-key", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ workspaceId, allowPlatformKey: next }),
        });
        if (!res.ok) throw new Error((await res.json()).error || "Could not save");
        router.refresh();
      } catch (e) {
        setAllowed(previous);
        setError(e instanceof Error ? e.message : "Could not save");
      }
    });
  }

  return (
    <div>
      <label style={{ display: "flex", gap: 10, alignItems: "flex-start", cursor: "pointer" }}>
        <input
          type="checkbox"
          checked={allowed}
          disabled={pending}
          onChange={(e) => toggle(e.target.checked)}
          style={{ marginTop: 3 }}
        />
        <span>
          <span style={{ fontSize: 13, display: "block", fontWeight: 600 }}>
            May use the platform Anthropic key
          </span>
          <span style={{ fontSize: 11, color: "var(--text-dim)" }}>
            {hasOwnKey
              ? "This workspace has its own key, which is used first either way."
              : allowed && designated
                ? "This workspace has no key of its own, so its runs are billed to us."
                : "This workspace has no key of its own, so agent runs will refuse until one is connected."}
          </span>
        </span>
      </label>
      {!designated && (
        <p style={{ fontSize: 11, color: "var(--text-dim)", margin: "8px 0 0", paddingLeft: 24 }}>
          This toggle is only half the gate. <code>{slug}</code> is not in{" "}
          <code>PLATFORM_KEY_WORKSPACES</code>, so this workspace cannot use our key whatever
          the toggle says. Adding it takes a deploy — deliberately, so no single click or
          stray database write can put someone on our account.
        </p>
      )}
      {error && <p style={{ fontSize: 11, color: "var(--danger)", margin: "6px 0 0" }}>{error}</p>}
    </div>
  );
}
