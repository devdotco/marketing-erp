"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";

interface SocialAccount {
  id: string;
  platform: "LINKEDIN" | "TWITTER_X";
  accountType: "PERSONAL" | "COMPANY";
  displayName: string;
  username: string | null;
}

const CHAR_LIMITS: Record<string, number> = {
  LINKEDIN: 3000,
  TWITTER_X: 280,
};

function platformLabel(platform: string): string {
  return platform === "LINKEDIN" ? "LI" : "X";
}

export default function SocialComposePage() {
  const [accounts, setAccounts] = useState<SocialAccount[]>([]);
  const [loadingAccounts, setLoadingAccounts] = useState(true);
  const [selectedAccountId, setSelectedAccountId] = useState<string>("");
  const [content, setContent] = useState("");
  const [scheduleMode, setScheduleMode] = useState<"now" | "later">("now");
  const [scheduledAt, setScheduledAt] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<{ type: "success" | "error"; message: string } | null>(null);

  useEffect(() => {
    async function fetchAccounts() {
      try {
        const res = await fetch("/api/social/accounts");
        if (res.ok) {
          const data: SocialAccount[] = await res.json();
          setAccounts(data);
          if (data.length > 0) setSelectedAccountId(data[0].id);
        }
      } catch {
        // silently fail
      } finally {
        setLoadingAccounts(false);
      }
    }
    fetchAccounts();
  }, []);

  const selectedAccount = accounts.find((a) => a.id === selectedAccountId);
  const charLimit = selectedAccount ? (CHAR_LIMITS[selectedAccount.platform] ?? 3000) : 3000;
  const charCount = content.length;
  const overLimit = charCount > charLimit;

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!selectedAccountId || !content.trim()) return;
      if (overLimit) return;
      if (scheduleMode === "later" && !scheduledAt) return;

      setSubmitting(true);
      setFeedback(null);

      try {
        const body: Record<string, unknown> = {
          socialAccountId: selectedAccountId,
          content,
          status: scheduleMode === "now" ? "PUBLISHED" : "SCHEDULED",
        };
        if (scheduleMode === "later") {
          body.scheduledAt = new Date(scheduledAt).toISOString();
        }

        const res = await fetch("/api/social/posts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });

        if (res.ok) {
          setFeedback({
            type: "success",
            message: scheduleMode === "now" ? "Post published successfully!" : "Post scheduled successfully!",
          });
          setContent("");
          setScheduledAt("");
          setScheduleMode("now");
        } else {
          const err = await res.json().catch(() => ({}));
          setFeedback({
            type: "error",
            message: (err as { error?: string }).error ?? "Failed to publish post. Please try again.",
          });
        }
      } catch {
        setFeedback({ type: "error", message: "Network error. Please try again." });
      } finally {
        setSubmitting(false);
      }
    },
    [selectedAccountId, content, scheduleMode, scheduledAt, overLimit]
  );

  return (
    <div className="scrollable">
      {/* Header */}
      <div style={{ marginBottom: 24 }}>
        <div style={{ marginBottom: 6 }}>
          <Link
            href="/social"
            style={{ fontSize: 12, color: "var(--text-muted)", textDecoration: "none" }}
          >
            ← Social
          </Link>
        </div>
        <h1 style={{ fontSize: 22, fontWeight: 700, letterSpacing: "-0.02em", marginBottom: 4 }}>
          Compose Post
        </h1>
        <p style={{ fontSize: 13, color: "var(--text-muted)" }}>
          Write and publish or schedule a post to LinkedIn or X
        </p>
      </div>

      <form onSubmit={handleSubmit}>
        <div
          style={{
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: 8,
            padding: 24,
            display: "flex",
            flexDirection: "column",
            gap: 20,
            maxWidth: 680,
          }}
        >
          {/* Account selector */}
          <div>
            <label
              style={{
                display: "block",
                fontSize: 11,
                fontWeight: 600,
                letterSpacing: "0.06em",
                textTransform: "uppercase",
                color: "var(--text-dim)",
                marginBottom: 8,
              }}
            >
              Account
            </label>
            {loadingAccounts ? (
              <div style={{ fontSize: 13, color: "var(--text-muted)" }}>Loading accounts…</div>
            ) : accounts.length === 0 ? (
              <div
                style={{
                  padding: "12px 16px",
                  background: "var(--surface-2)",
                  border: "1px solid var(--border)",
                  borderRadius: 6,
                  fontSize: 13,
                  color: "var(--text-muted)",
                }}
              >
                No connected accounts.{" "}
                <Link href="/social/accounts" style={{ color: "var(--accent)", textDecoration: "none" }}>
                  Connect an account →
                </Link>
              </div>
            ) : (
              <select
                value={selectedAccountId}
                onChange={(e) => setSelectedAccountId(e.target.value)}
                style={{
                  width: "100%",
                  padding: "9px 12px",
                  background: "var(--bg)",
                  border: "1px solid var(--border)",
                  borderRadius: 6,
                  fontSize: 13,
                  color: "var(--text)",
                  appearance: "auto",
                }}
              >
                {accounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    [{platformLabel(account.platform)}]{" "}
                    {account.displayName}
                    {account.username ? ` (@${account.username})` : ""}{" "}
                    — {account.accountType === "PERSONAL" ? "Personal" : "Company"}
                  </option>
                ))}
              </select>
            )}
          </div>

          {/* Content textarea */}
          <div>
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 8 }}>
              <label
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  letterSpacing: "0.06em",
                  textTransform: "uppercase",
                  color: "var(--text-dim)",
                }}
              >
                Content
              </label>
              <span
                style={{
                  fontSize: 12,
                  fontVariantNumeric: "tabular-nums",
                  color: overLimit ? "var(--danger)" : charCount > charLimit * 0.9 ? "var(--warning)" : "var(--text-dim)",
                  fontWeight: overLimit ? 600 : 400,
                }}
              >
                {charCount} / {charLimit}
              </span>
            </div>
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="What do you want to share?"
              rows={8}
              style={{
                width: "100%",
                padding: "10px 12px",
                background: "var(--bg)",
                border: overLimit ? "1px solid var(--danger)" : "1px solid var(--border)",
                borderRadius: 6,
                fontSize: 13,
                color: "var(--text)",
                lineHeight: 1.6,
                resize: "vertical",
                fontFamily: "inherit",
                boxSizing: "border-box",
              }}
            />
            {overLimit && (
              <p style={{ fontSize: 11, color: "var(--danger)", marginTop: 4 }}>
                {charCount - charLimit} characters over the limit
              </p>
            )}
          </div>

          {/* Schedule toggle */}
          <div>
            <label
              style={{
                display: "block",
                fontSize: 11,
                fontWeight: 600,
                letterSpacing: "0.06em",
                textTransform: "uppercase",
                color: "var(--text-dim)",
                marginBottom: 10,
              }}
            >
              Timing
            </label>
            <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
              {[
                { value: "now", label: "Post now" },
                { value: "later", label: "Schedule for later" },
              ].map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => setScheduleMode(option.value as "now" | "later")}
                  style={{
                    padding: "7px 14px",
                    borderRadius: 6,
                    fontSize: 13,
                    fontWeight: 500,
                    cursor: "pointer",
                    border: "1px solid var(--border)",
                    background: scheduleMode === option.value ? "var(--accent)" : "var(--surface-2)",
                    color: scheduleMode === option.value ? "#fff" : "var(--text-muted)",
                    transition: "background 0.15s, color 0.15s",
                  }}
                >
                  {option.label}
                </button>
              ))}
            </div>

            {scheduleMode === "later" && (
              <div>
                <label
                  style={{
                    display: "block",
                    fontSize: 11,
                    fontWeight: 600,
                    letterSpacing: "0.06em",
                    textTransform: "uppercase",
                    color: "var(--text-dim)",
                    marginBottom: 6,
                  }}
                >
                  Schedule date & time
                </label>
                <input
                  type="datetime-local"
                  value={scheduledAt}
                  onChange={(e) => setScheduledAt(e.target.value)}
                  min={new Date().toISOString().slice(0, 16)}
                  required={scheduleMode === "later"}
                  style={{
                    padding: "9px 12px",
                    background: "var(--bg)",
                    border: "1px solid var(--border)",
                    borderRadius: 6,
                    fontSize: 13,
                    color: "var(--text)",
                    fontFamily: "inherit",
                  }}
                />
              </div>
            )}
          </div>

          {/* Feedback */}
          {feedback && (
            <div
              style={{
                padding: "10px 14px",
                borderRadius: 6,
                fontSize: 13,
                fontWeight: 500,
                background:
                  feedback.type === "success" ? "var(--success-bg)" : "rgba(239,68,68,0.1)",
                border:
                  feedback.type === "success" ? "1px solid var(--success)" : "1px solid var(--danger)",
                color: feedback.type === "success" ? "var(--success)" : "var(--danger)",
              }}
            >
              {feedback.message}
            </div>
          )}

          {/* Submit */}
          <div style={{ display: "flex", gap: 10 }}>
            <button
              type="submit"
              disabled={
                submitting ||
                !content.trim() ||
                !selectedAccountId ||
                overLimit ||
                accounts.length === 0 ||
                (scheduleMode === "later" && !scheduledAt)
              }
              className="btn btn-primary btn-sm"
              style={{
                opacity:
                  submitting ||
                  !content.trim() ||
                  !selectedAccountId ||
                  overLimit ||
                  accounts.length === 0 ||
                  (scheduleMode === "later" && !scheduledAt)
                    ? 0.5
                    : 1,
                cursor:
                  submitting ||
                  !content.trim() ||
                  !selectedAccountId ||
                  overLimit ||
                  accounts.length === 0 ||
                  (scheduleMode === "later" && !scheduledAt)
                    ? "not-allowed"
                    : "pointer",
              }}
            >
              {submitting
                ? "Submitting…"
                : scheduleMode === "now"
                ? "Post"
                : "Schedule"}
            </button>
            <Link href="/social" className="btn btn-secondary btn-sm">
              Cancel
            </Link>
          </div>
        </div>
      </form>
    </div>
  );
}
