"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

interface DeleteButtonProps {
  url: string;
  label?: string;
  confirmMessage?: string;
  style?: React.CSSProperties;
}

export function DeleteButton({ url, label = "Delete", confirmMessage, style }: DeleteButtonProps) {
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  async function handleClick() {
    if (confirmMessage && !window.confirm(confirmMessage)) return;
    setLoading(true);
    try {
      await fetch(url, { method: "DELETE" });
      router.refresh();
    } finally {
      setLoading(false);
    }
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={loading}
      style={{
        padding: "4px 10px",
        background: "transparent",
        border: "1px solid var(--border)",
        borderRadius: 4,
        fontSize: 11,
        fontWeight: 500,
        color: "var(--danger)",
        cursor: loading ? "not-allowed" : "pointer",
        opacity: loading ? 0.6 : 1,
        ...style,
      }}
    >
      {loading ? "…" : label}
    </button>
  );
}
