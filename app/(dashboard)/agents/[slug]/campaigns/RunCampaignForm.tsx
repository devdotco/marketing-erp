"use client";

import { useActionState } from "react";
import Link from "next/link";
import { runEmailCampaign, type ActionResult } from "@/lib/actions/email-campaigns";

/** "Draft now", or a test run for any date (subject prefixed "[TEST] ", never schedulable). */
export function RunCampaignForm({ campaignId, defaultDate }: { campaignId: string; defaultDate: string }) {
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(runEmailCampaign, null);
  return (
    <form action={action} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginTop: 10, fontSize: 12 }}>
      <input type="hidden" name="campaignId" value={campaignId} />
      <label>
        Send date{" "}
        <input
          type="date"
          name="sendDate"
          defaultValue={defaultDate}
          style={{ background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6, padding: "4px 8px", color: "var(--text)", fontSize: 12 }}
        />
      </label>
      <label style={{ display: "flex", gap: 4, alignItems: "center" }}>
        <input type="checkbox" name="test" defaultChecked /> Test run
      </label>
      <button className="btn btn-secondary btn-sm" disabled={pending}>{pending ? "…" : "Draft now"}</button>
      {state && !state.ok && <span style={{ color: "var(--danger)" }}>{state.error}</span>}
      {state?.ok && (
        <span style={{ color: "var(--success)" }}>
          {state.message} <Link href={`/runs/${state.id}`}>Open the run</Link>
        </span>
      )}
    </form>
  );
}
