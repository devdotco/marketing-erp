/**
 * Constant-time secret comparison. Server-only (node:crypto).
 */
import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Compare two secrets without leaking where they differ, or how long the
 * expected one is. Both sides are hashed first so the buffers handed to
 * timingSafeEqual are always the same length; an empty value never matches.
 */
export function constantTimeEqual(presented: string | null | undefined, expected: string | null | undefined): boolean {
  if (!presented || !expected) return false;
  const a = createHash("sha256").update(presented, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}
