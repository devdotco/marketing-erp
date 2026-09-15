import { timingSafeEqual } from "node:crypto";

/** The kill switch and limits in front of the mirror endpoints. Pure; tested in test/mirror.test.ts. */

/** `MIRROR_MODULES` on THIS app must name `marketing`, or events are refused and reconcile does nothing. */
export function mirrorEnabled(module: "crm" | "marketing", value = process.env.MIRROR_MODULES): boolean {
  return (value ?? "").split(",").map((s) => s.trim()).includes(module);
}

/** Largest event body accepted before any verification work. */
export const MAX_EVENT_BYTES = 1_000_000;

/** The body as text, or null when larger than `max` — by content-length and while streaming. */
export async function readCappedText(req: Request, max = MAX_EVENT_BYTES): Promise<string | null> {
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > max) return null;
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Constant-time check of the dedicated `SHELL_MIRROR_SECRET`. Unset refuses everything. */
export function mirrorSecretMatches(given: string | null, expected = process.env.SHELL_MIRROR_SECRET): boolean {
  if (!expected) return false;
  const a = Buffer.from(given ?? "");
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
