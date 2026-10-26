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
      date.toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "medium",
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
