/**
 * The cron matcher (lib/cron.ts) and the schedule slot-idempotency logic
 * (lib/scheduler.ts's pure helpers) — no network and no database. Run with
 * `npm run test:cron`.
 *
 * The day-of-month/day-of-week OR rule gets the most coverage here on
 * purpose: a sibling repo's scheduler got it wrong and fired a Monday-only
 * schedule every day. See lib/cron.ts's module comment for the full story.
 */
import { parseCron, matchesCron, isDueAt, nextRunAt, describeCron, isValidCron, CRON_PRESETS, slotKeyFor } from "@/lib/cron";

let failures = 0;
const check = (name: string, cond: boolean, got?: unknown) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : `  got: ${JSON.stringify(got)}`}`);
  if (!cond) failures += 1;
};

function utc(iso: string): Date {
  return new Date(iso);
}

// ── Basic field parsing ──────────────────────────────────────────────────

{
  const cron = parseCron("0 13 * * 1-5");
  check("parses minute", [...cron.minute].join(",") === "0", cron.minute);
  check("parses hour", [...cron.hour].join(",") === "13", cron.hour);
  check("dom unrestricted", cron.domRestricted === false, cron);
  check("dow restricted", cron.dowRestricted === true, cron);
  check("dow range 1-5", [...cron.dow].sort().join(",") === "1,2,3,4,5", cron.dow);
}

{
  const cron = parseCron("*/15 * * * *");
  check("step on minute", [...cron.minute].sort((a, b) => a - b).join(",") === "0,15,30,45", cron.minute);
}

{
  const cron = parseCron("5,10,15 0 1 1 0");
  check("comma list on minute", [...cron.minute].sort((a, b) => a - b).join(",") === "5,10,15", cron.minute);
}

{
  const cron = parseCron("0 9-17/2 * * *");
  check("range with step", [...cron.hour].sort((a, b) => a - b).join(",") === "9,11,13,15,17", cron.hour);
}

{
  // 7 means Sunday too, same as 0.
  const cron = parseCron("0 0 * * 7");
  check("dow 7 normalises to Sunday (0)", cron.dow.has(0) && !cron.dow.has(7), cron.dow);
}

for (const bad of ["", "* * * *", "60 * * * *", "* 24 * * *", "* * 0 * *", "* * 32 * *", "* * * 13 *", "* * * * 8", "1-0 * * * *", "*/0 * * * *", "abc * * * *"]) {
  check(`rejects invalid expression "${bad}"`, !isValidCron(bad));
}

// ── DOM/DOW OR rule — the headline bug ───────────────────────────────────

{
  // "0 7 * * 1" — 7am UTC every Monday. dom unrestricted, dow restricted to
  // Monday. Must match Monday and ONLY Monday, at 07:00.
  const cron = parseCron("0 7 * * 1");
  check("dow-only: matches Monday 07:00", matchesCron(cron, utc("2026-09-14T07:00:00Z")));
  // 2026-09-15 is a Tuesday.
  check("dow-only: does NOT match Tuesday 07:00 (the sibling-repo bug)", !matchesCron(cron, utc("2026-09-15T07:00:00Z")));
  check("dow-only: does NOT match Monday 08:00", !matchesCron(cron, utc("2026-09-14T08:00:00Z")));
}

{
  // dom restricted (the 15th), dow unrestricted — only the day-of-month constrains.
  const cron = parseCron("0 9 15 * *");
  check("dom-only: matches the 15th", matchesCron(cron, utc("2026-09-15T09:00:00Z")));
  check("dom-only: does not match the 16th", !matchesCron(cron, utc("2026-09-16T09:00:00Z")));
}

{
  // Both restricted: OR, not AND. dom = the 1st, dow = Friday. 2026-09-17 is
  // neither the 1st nor... wait, use dates where exactly one side matches to
  // prove OR (an AND implementation would reject these; only OR accepts them).
  const cron = parseCron("0 9 1 * 5");
  // 2026-10-01 is a Thursday — matches via dom (the 1st), not via dow.
  check("both-restricted OR: matches via dom alone", matchesCron(cron, utc("2026-10-01T09:00:00Z")));
  // 2026-09-18 is a Friday but not the 1st — matches via dow alone.
  check("both-restricted OR: matches via dow alone", matchesCron(cron, utc("2026-09-18T09:00:00Z")));
  // 2026-09-17 is a Thursday and not the 1st — matches neither.
  check("both-restricted OR: rejects a day matching neither", !matchesCron(cron, utc("2026-09-17T09:00:00Z")));
}

{
  const cron = parseCron("* * * * *");
  check("both unrestricted: matches any day", matchesCron(cron, utc("2026-09-17T00:00:00Z")));
}

// ── isDueAt convenience wrapper ───────────────────────────────────────────

check("isDueAt matches a due minute", isDueAt("0 13 * * 1-5", utc("2026-09-17T13:00:00Z"))); // Thursday
check("isDueAt rejects a weekend", !isDueAt("0 13 * * 1-5", utc("2026-09-19T13:00:00Z"))); // Saturday
check("isDueAt never throws on garbage", isDueAt("not a cron", utc("2026-09-17T13:00:00Z")) === false);

// ── nextRunAt ─────────────────────────────────────────────────────────────

{
  // From Thursday 13:05, the next weekday-13:00 slot is Friday 13:00.
  const next = nextRunAt("0 13 * * 1-5", utc("2026-09-17T13:05:00Z"));
  check("nextRunAt: next weekday slot", next?.toISOString() === "2026-09-18T13:00:00.000Z", next);
}

{
  // From Friday 15:00 exactly, next Friday-15:00 is 7 days later, not the same minute.
  const next = nextRunAt("0 15 * * 5", utc("2026-09-18T15:00:00Z"));
  check("nextRunAt: excludes the exact current minute", next?.toISOString() === "2026-09-25T15:00:00.000Z", next);
}

{
  // Day-of-month 31 in a month that never has one combined with a fixed month
  // that has no 31st: no match within a year.
  const next = nextRunAt("0 0 31 2 *", utc("2026-01-01T00:00:00Z"));
  check("nextRunAt: null for an impossible date", next === null, next);
}

// ── describeCron ──────────────────────────────────────────────────────────

check("describeCron: weekdays preset", describeCron("0 13 * * 1-5") === "Weekdays at 13:00 UTC", describeCron("0 13 * * 1-5"));
check("describeCron: single weekday", describeCron("0 15 * * 5") === "Friday at 15:00 UTC", describeCron("0 15 * * 5"));
check("describeCron: every day", describeCron("0 0 * * *") === "Every day at 00:00 UTC", describeCron("0 0 * * *"));
check("describeCron: invalid input returns a message, not a throw", describeCron("bogus").length > 0);

// ── Presets are all valid and stable ─────────────────────────────────────

for (const preset of CRON_PRESETS) {
  check(`preset "${preset.label}" is a valid cron expression`, isValidCron(preset.value), preset.value);
}

// ── Slot key for the Redis lock ──────────────────────────────────────────

{
  // Same minute, different seconds — same slot key. This is what makes the
  // lock safe against a poll that fires a few seconds late.
  const a = slotKeyFor(utc("2026-09-17T13:05:00Z"));
  const b = slotKeyFor(utc("2026-09-17T13:05:59Z"));
  check("slotKeyFor: stable within the same minute", a === b, { a, b });

  const c = slotKeyFor(utc("2026-09-17T13:06:00Z"));
  check("slotKeyFor: different across minutes", a !== c, { a, c });
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
