"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { apiFetch } from "@/lib/base-path";

export function RunActions({ runId }: { runId: string }) {
  const [rejectReason, setRejectReason] = useState("");
  const [showReject, setShowReject] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  function handleApprove() {
    setError(null);
    startTransition(async () => {
      const res = await apiFetch(`/api/runs/${runId}/approve`, { method: "POST" });
      if (!res.ok) {
        const d = await res.json();
        setError(d.error ?? "Failed to approve");
      } else {
        router.refresh();
      }
    });
  }

  function handleReject() {
    setError(null);
    startTransition(async () => {
      const res = await apiFetch(`/api/runs/${runId}/reject`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: rejectReason }),
      });
      if (!res.ok) {
        const d = await res.json();
        setError(d.error ?? "Failed to reject");
      } else {
        setShowReject(false);
        router.refresh();
      }
    });
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, alignItems: "flex-end" }}>
      <div style={{ display: "flex", gap: 8 }}>
        <button onClick={handleApprove} disabled={pending} className="btn btn-primary btn-sm">
          {pending ? "…" : "Approve"}
        </button>
        <button onClick={() => setShowReject(!showReject)} disabled={pending} className="btn btn-danger btn-sm">
          Reject
        </button>
      </div>

      {showReject && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, width: 260 }}>
          <textarea
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            placeholder="Optional reason for rejection…"
            rows={3}
            className="input"
            style={{ fontSize: 12, resize: "vertical" }}
          />
          <button onClick={handleReject} disabled={pending} className="btn btn-danger btn-sm">
            {pending ? "Rejecting…" : "Confirm reject"}
          </button>
        </div>
      )}

      {error && <p style={{ fontSize: 11, color: "var(--danger)" }}>{error}</p>}
    </div>
  );
}
