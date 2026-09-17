/**
 * A minimal standard 5-field cron parser and matcher: minute hour dom month dow.
 *
 * No dependency was added for this — package.json carries no cron library
 * (checked before writing this), and the surface this app actually needs is
 * small: parse, "does this UTC minute match", and "when is the next match".
 * Everything here is pure (no Date.now(), no I/O) so it is cheap to unit test
 * and safe to import from a client component for the schedule editor's live
 * preview (see components/ui/ScheduleEditor.tsx).
 *
 * All matching is against UTC fields (getUTCMinutes etc). There is no
 * per-workspace timezone anywhere else in this app (Google/GA4 reports, the
 * social schedulers — everything already reasons in UTC or the provider's own
 * clock), so schedules follow that convention rather than inventing a new one.
 * The UI says "UTC" next to the field for the same reason.
 *
 * Day-of-month / day-of-week combine with the POSIX cron rule, not a plain
 * AND: when BOTH fields are restricted (neither is "*"), a date matches if
 * EITHER matches. When only one is restricted, only that one has to match.
 * Get this backwards and a schedule like "0 7 * * 1" (7am UTC every Monday) —
 * dom is unrestricted, dow is restricted to Monday — still needs to skip
 * every other day; a sibling implementation flattened dom/dow into a single
 * AND-of-restricted-fields check and it fired every single day, because an
 * unrestricted dom of "*" was (wrongly) treated as "matches nothing" for the
 * purposes of that intersection instead of "impose no constraint". The tests
 * in test/cron.test.ts pin this down explicitly.
 */

export interface ParsedCron {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  domRestricted: boolean;
  dowRestricted: boolean;
  raw: string;
}

const FIELD_BOUNDS: Record<"minute" | "hour" | "dom" | "month" | "dow", [number, number]> = {
  minute: [0, 59],
  hour: [0, 23],
  dom: [1, 31],
  month: [1, 12],
  // 0 and 7 both mean Sunday in standard cron; normalised to 0 below.
  dow: [0, 7],
};

/** Parses one comma-separated field into the set of values it selects. */
function parseField(field: string, bounds: [number, number]): Set<number> {
  const [min, max] = bounds;
  const values = new Set<number>();

  for (const part of field.split(",")) {
    const piece = part.trim();
    if (piece === "") throw new Error(`Empty entry in cron field "${field}"`);

    let step = 1;
    let rangePart = piece;
    const slashIdx = piece.indexOf("/");
    if (slashIdx !== -1) {
      rangePart = piece.slice(0, slashIdx);
      const stepStr = piece.slice(slashIdx + 1);
      step = Number(stepStr);
      if (!Number.isInteger(step) || step <= 0) {
        throw new Error(`Invalid step "${stepStr}" in cron field "${field}"`);
      }
    }

    let start: number;
    let end: number;
    if (rangePart === "*") {
      start = min;
      end = max;
    } else if (rangePart.includes("-")) {
      const [startStr, endStr] = rangePart.split("-");
      start = Number(startStr);
      end = Number(endStr);
    } else {
      start = end = Number(rangePart);
    }

    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start > end ||
      start < min ||
      end > max
    ) {
      throw new Error(`Invalid range "${rangePart}" in cron field "${field}" (expected ${min}-${max})`);
    }

    for (let v = start; v <= end; v += step) values.add(v);
  }

  return values;
}

/** Parses a standard 5-field cron expression. Throws with a human-readable reason if invalid. */
export function parseCron(expression: string): ParsedCron {
  const raw = expression.trim();
  const parts = raw.split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(
      `Cron schedule must have 5 space-separated fields (minute hour day-of-month month day-of-week), got ${parts.length}: "${raw}"`,
    );
  }
  const [minuteStr, hourStr, domStr, monthStr, dowStr] = parts;

  const minute = parseField(minuteStr, FIELD_BOUNDS.minute);
  const hour = parseField(hourStr, FIELD_BOUNDS.hour);
  const dom = parseField(domStr, FIELD_BOUNDS.dom);
  const month = parseField(monthStr, FIELD_BOUNDS.month);
  const dowRaw = parseField(dowStr, FIELD_BOUNDS.dow);
  const dow = new Set([...dowRaw].map((d) => (d === 7 ? 0 : d)));

  return {
    minute,
    hour,
    dom,
    month,
    dow,
    domRestricted: domStr.trim() !== "*",
    dowRestricted: dowStr.trim() !== "*",
    raw,
  };
}

/** Whether `expression` parses as a valid 5-field cron schedule. Never throws. */
export function isValidCron(expression: string): boolean {
  try {
    parseCron(expression);
    return true;
  } catch {
    return false;
  }
}

/** Whether a parsed schedule is due at this exact UTC minute (seconds/ms ignored). */
export function matchesCron(cron: ParsedCron, date: Date): boolean {
  const minute = date.getUTCMinutes();
  const hour = date.getUTCHours();
  const dom = date.getUTCDate();
  const month = date.getUTCMonth() + 1;
  const dow = date.getUTCDay();

  if (!cron.minute.has(minute)) return false;
  if (!cron.hour.has(hour)) return false;
  if (!cron.month.has(month)) return false;

  const domMatch = cron.dom.has(dom);
  const dowMatch = cron.dow.has(dow);

  // See the module comment: OR only when both are restricted.
  if (cron.domRestricted && cron.dowRestricted) return domMatch || dowMatch;
  if (cron.domRestricted) return domMatch;
  if (cron.dowRestricted) return dowMatch;
  return true;
}

/** `matchesCron`, but parses the expression first. Returns false (not a throw) on a bad schedule. */
export function isDueAt(expression: string, date: Date): boolean {
  try {
    return matchesCron(parseCron(expression), date);
  } catch {
    return false;
  }
}

const MAX_LOOKAHEAD_MINUTES = 366 * 24 * 60; // just over a year — covers Feb 29 and any DOM/DOW combo

/**
 * The next UTC minute at or after `from` (exclusive of `from` itself, since a
 * slot that already fired should not be reported as "next") that this
 * schedule matches. Null if nothing matches within a year — only possible for
 * an expression that can never occur, like day-of-month 31 in February.
 */
export function nextRunAt(expression: string, from: Date): Date | null {
  const cron = parseCron(expression);
  const cursor = new Date(from);
  cursor.setUTCSeconds(0, 0);
  cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);

  for (let i = 0; i < MAX_LOOKAHEAD_MINUTES; i++) {
    if (matchesCron(cron, cursor)) return new Date(cursor);
    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  }
  return null;
}

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/**
 * A best-effort human-readable summary of a cron expression, for the schedule
 * editor's live preview. Covers the shapes the presets and the agent defaults
 * actually produce (a single time, optionally on specific weekdays or a
 * weekday range); anything more exotic falls back to describing each field
 * plainly rather than guessing at English that might be wrong.
 */
export function describeCron(expression: string): string {
  let cron: ParsedCron;
  try {
    cron = parseCron(expression);
  } catch (err) {
    return err instanceof Error ? err.message : "Invalid schedule";
  }

  const isSingleTime = cron.minute.size === 1 && cron.hour.size === 1;
  const timeStr = isSingleTime ? formatTime([...cron.hour][0], [...cron.minute][0]) : null;

  const domAll = !cron.domRestricted;
  const monthAll = cron.month.size === 12;

  if (isSingleTime && domAll && monthAll) {
    if (!cron.dowRestricted) {
      return `Every day at ${timeStr} UTC`;
    }
    const days = [...cron.dow].sort((a, b) => a - b);
    if (days.length === 5 && [1, 2, 3, 4, 5].every((d) => cron.dow.has(d))) {
      return `Weekdays at ${timeStr} UTC`;
    }
    if (days.length === 2 && cron.dow.has(0) && cron.dow.has(6)) {
      return `Weekends at ${timeStr} UTC`;
    }
    return `${days.map((d) => WEEKDAY_NAMES[d]).join(", ")} at ${timeStr} UTC`;
  }

  // Fallback: plain field-by-field description, still readable, not fluent.
  return `At minute ${describeField(cron.minute, 0, 59)} past hour ${describeField(cron.hour, 0, 23)}, day-of-month ${cron.domRestricted ? describeField(cron.dom, 1, 31) : "any"}, month ${monthAll ? "any" : describeField(cron.month, 1, 12)}, day-of-week ${cron.dowRestricted ? describeField(cron.dow, 0, 6) : "any"} (UTC)`;
}

function formatTime(hour: number, minute: number): string {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function describeField(values: Set<number>, min: number, max: number): string {
  if (values.size === max - min + 1) return "every value";
  return [...values].sort((a, b) => a - b).join(",");
}

/** A schedule preset offered in the UI — a label plus the cron expression it sets. */
export interface CronPreset {
  label: string;
  value: string;
}

export const CRON_PRESETS: CronPreset[] = [
  { label: "Weekdays 9am", value: "0 9 * * 1-5" },
  { label: "Weekdays 1pm", value: "0 13 * * 1-5" },
  { label: "Daily at midnight", value: "0 0 * * *" },
  { label: "Fridays 3pm", value: "0 15 * * 5" },
  { label: "Mondays 9am", value: "0 9 * * 1" },
  { label: "1st of the month, 9am", value: "0 9 1 * *" },
];

/**
 * The minute-aligned key that identifies "this schedule slot", used by
 * lib/scheduler.ts as the Redis SET NX lock key (`sched-lock:<configId>:<slotKeyFor(...)>`).
 * Pure and dependency-free on purpose: it lives here rather than in
 * lib/scheduler.ts so test/cron.test.ts can exercise it without pulling in
 * Prisma/BullMQ (which need a live DATABASE_URL/REDIS_URL to construct).
 * Truncates to the minute, so a poll that fires a few seconds late still
 * produces the same key every container computes for that slot.
 */
export function slotKeyFor(date: Date): string {
  return date.toISOString().slice(0, 16); // e.g. "2026-09-17T13:05"
}
