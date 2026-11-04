/**
 * "Monthly, Nth weekday" calendars for email campaign types: the Press Release
 * goes out on the first Wednesday at 09:00 America/Denver, the Dashboard email
 * on the third Thursday. Each send is drafted on the last `draftWeekday`
 * (Monday) before it, at `draftTime` (17:47), so the draft is waiting by 6 PM.
 *
 * Everything else in this app's scheduler is UTC cron (lib/cron.ts). A fixed
 * UTC time cannot express "9 AM Mountain" across a DST change, and cron cannot
 * express "third Thursday" at all, so this computes instants in the campaign's
 * own IANA zone with Intl and no dependency.
 *
 * The draft day is derived from the SEND day, never the other way round, so a
 * Wednesday Dec 2 send is drafted on Monday Nov 30 across the month boundary.
 * Pure: no Date.now(), no I/O.
 */

export interface MonthlySchedule {
  /** 0 = Sunday … 6 = Saturday. */
  sendWeekday: number;
  /** 1–5, or -1 for the last such weekday of the month. */
  sendNth: number;
  /** "HH:MM", in `timezone`. */
  sendTime: string;
  timezone: string;
  draftWeekday: number;
  draftTime: string;
}

/** The calendar fields of an EmailCampaign row (structural, so this module stays Prisma-free). */
export function campaignSchedule(c: MonthlySchedule): MonthlySchedule {
  return {
    sendWeekday: c.sendWeekday,
    sendNth: c.sendNth,
    sendTime: c.sendTime,
    timezone: c.timezone,
    draftWeekday: c.draftWeekday,
    draftTime: c.draftTime,
  };
}

export interface LocalDate {
  year: number;
  /** 1–12. */
  month: number;
  day: number;
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const ORDINALS: Record<number, string> = { 1: "first", 2: "second", 3: "third", 4: "fourth", 5: "fifth", [-1]: "last" };

export function parseTime(value: string): { hour: number; minute: number } {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) throw new Error(`"${value}" is not a time like 09:00`);
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) throw new Error(`"${value}" is not a valid time`);
  return { hour, minute };
}

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The wall-clock fields of `instant` in `tz`. */
function wallClock(instant: Date, tz: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(instant);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour") % 24, minute: get("minute"), second: get("second") };
}

/** The UTC instant at which the wall clock in `tz` reads the given date and time. */
export function zonedInstant(date: LocalDate, hour: number, minute: number, tz: string): Date {
  const target = Date.UTC(date.year, date.month - 1, date.day, hour, minute);
  // Two passes: the first lands within the right offset, the second corrects across a DST edge.
  let guess = target;
  for (let i = 0; i < 2; i++) {
    const w = wallClock(new Date(guess), tz);
    const seen = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute);
    guess += target - seen;
  }
  return new Date(guess);
}

/** Today's date in `tz` at `instant`. */
export function localDateOf(instant: Date, tz: string): LocalDate {
  const w = wallClock(instant, tz);
  return { year: w.year, month: w.month, day: w.day };
}

function weekdayOf(date: LocalDate): number {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
}

function addDays(date: LocalDate, days: number): LocalDate {
  const d = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** The Nth `weekday` of a month, or null when the month has no fifth one. */
export function nthWeekdayOf(year: number, month: number, weekday: number, nth: number): LocalDate | null {
  if (nth === -1) {
    const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const lastDate = { year, month, day: last };
    return addDays(lastDate, -((weekdayOf(lastDate) - weekday + 7) % 7));
  }
  const first = { year, month, day: 1 };
  const day = 1 + ((weekday - weekdayOf(first) + 7) % 7) + (nth - 1) * 7;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day <= daysInMonth ? { year, month, day } : null;
}

/** The last `draftWeekday` strictly before the send day. */
export function draftDateFor(send: LocalDate, draftWeekday: number): LocalDate {
  const back = (weekdayOf(send) - draftWeekday + 7) % 7 || 7;
  return addDays(send, -back);
}

export interface Occurrence {
  /** The send day, in the campaign's zone, as YYYY-MM-DD. The dedupe key for a run. */
  sendDate: string;
  sendAt: Date;
  draftAt: Date;
}

export function formatLocalDate(d: LocalDate): string {
  return `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;
}

export function parseLocalDate(value: string): LocalDate | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const date = { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
  const check = new Date(Date.UTC(date.year, date.month - 1, date.day));
  return check.getUTCMonth() + 1 === date.month && check.getUTCDate() === date.day ? date : null;
}

/** The send and draft instants for a given send day, whatever the calendar says. */
export function occurrenceOn(s: MonthlySchedule, send: LocalDate): Occurrence {
  const st = parseTime(s.sendTime);
  const dt = parseTime(s.draftTime);
  return {
    sendDate: formatLocalDate(send),
    sendAt: zonedInstant(send, st.hour, st.minute, s.timezone),
    draftAt: zonedInstant(draftDateFor(send, s.draftWeekday), dt.hour, dt.minute, s.timezone),
  };
}

/** Occurrences whose send month falls in [from's month - 1, from's month + count]. */
function occurrencesAround(s: MonthlySchedule, from: Date, count: number): Occurrence[] {
  const today = localDateOf(from, s.timezone);
  const out: Occurrence[] = [];
  for (let i = -1; i <= count; i++) {
    const m0 = today.month - 1 + i;
    const year = today.year + Math.floor(m0 / 12);
    const month = (((m0 % 12) + 12) % 12) + 1;
    const send = nthWeekdayOf(year, month, s.sendWeekday, s.sendNth);
    if (send) out.push(occurrenceOn(s, send));
  }
  return out;
}

/** The next send strictly after `from`. */
export function nextOccurrence(s: MonthlySchedule, from: Date): Occurrence | null {
  return occurrencesAround(s, from, 14).find((o) => o.sendAt.getTime() > from.getTime()) ?? null;
}

/** The next `count` sends after `from`, for the calendar preview. */
export function upcomingOccurrences(s: MonthlySchedule, from: Date, count: number): Occurrence[] {
  return occurrencesAround(s, from, count + 14).filter((o) => o.sendAt.getTime() > from.getTime()).slice(0, count);
}

/** The occurrence whose draft is due in the UTC minute starting at `slot`, if any. */
export function draftDueAt(s: MonthlySchedule, slot: Date): Occurrence | null {
  const minute = Math.floor(slot.getTime() / 60_000);
  return occurrencesAround(s, slot, 2).find((o) => Math.floor(o.draftAt.getTime() / 60_000) === minute) ?? null;
}

export function describeSchedule(s: MonthlySchedule): string {
  const tz = s.timezone === "America/Denver" ? "MT" : s.timezone;
  return `${ORDINALS[s.sendNth] ?? `#${s.sendNth}`} ${WEEKDAYS[s.sendWeekday]} of each month at ${s.sendTime} ${tz}; drafted the ${WEEKDAYS[s.draftWeekday]} before at ${s.draftTime} ${tz}`;
}

/** "Thu, Nov 19" in the campaign's zone. */
export function shortDate(instant: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric" }).format(instant);
}

/** "9:00 AM MT, Thu, Nov 19, 2026". */
export function longDateTime(instant: Date, tz: string): string {
  const time = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(instant);
  const date = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric", year: "numeric" }).format(instant);
  return `${time} ${tz === "America/Denver" ? "MT" : tz}, ${date}`;
}

/** The day before the send: when the approver is expected to load it. */
export function loadDayFor(o: Occurrence, tz: string): string {
  const send = parseLocalDate(o.sendDate)!;
  return shortDate(zonedInstant(addDays(send, -1), 12, 0, tz), tz);
}
