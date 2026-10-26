"use client";

import { useSyncExternalStore } from "react";

const noopSubscribe = () => () => {};

/**
 * A timestamp in the viewer's own timezone, labelled with it.
 *
 * Run pages called `toLocaleString()` during the server render, which formats
 * in the server's zone (UTC) and prints no zone at all — "7:49:25 PM" for a run
 * a reviewer in Texas saw finish at 2:49. The server renders the UTC value,
 * labelled as UTC; the browser then swaps in local time.
 */
export function LocalTime({ iso }: { iso: string }) {
  const date = new Date(iso);
  const local = useSyncExternalStore(
    noopSubscribe,
    () =>
      // Explicit fields, not dateStyle/timeStyle: those two cannot be combined
      // with timeZoneName, and the browser throws "Invalid option" during
      // render — which took down every run page (2026-10-26).
      date.toLocaleString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        second: "2-digit",
        timeZoneName: "short",
      }),
    () => `${date.toISOString().replace("T", " ").slice(0, 19)} UTC`,
  );
  return (
    <time dateTime={iso} title={date.toISOString()}>
      {local}
    </time>
  );
}
