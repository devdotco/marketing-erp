#!/usr/bin/env node
/**
 * Fetch every published crawler IP-range feed and prove it still parses.
 *
 *   npm run check:crawler-ranges
 *
 * "Verified" is a claim this product makes to a customer about their traffic.
 * It rests on seven third-party URLs that nobody here controls. When one of
 * them moves or changes shape, nothing breaks loudly — verification quietly
 * degrades to "unverified", which looks on the dashboard exactly like a day
 * when the crawlers happened not to be verifiable. That is the failure this
 * script exists to make noisy.
 *
 * Network-dependent, so it is not part of `npm test`. Run it before a deploy
 * and on a schedule, the same way check:models is run.
 */
import fs from "node:fs";

const src = fs.readFileSync(new URL("../lib/crawlers/bots.ts", import.meta.url), "utf8");

// Every ip-ranges URL declared in the roster, deduplicated — Anthropic's one
// feed backs three crawlers.
const urls = [...new Set([...src.matchAll(/method:\s*"ip-ranges",\s*url:\s*([A-Z_]+|"[^"]+")/g)].map((m) => m[1]))]
  .map((token) => {
    if (token.startsWith('"')) return token.slice(1, -1);
    // A shared constant, e.g. ANTHROPIC_BOTS.
    const constMatch = new RegExp(`const ${token} = "([^"]+)"`).exec(src);
    return constMatch ? constMatch[1] : null;
  })
  .filter(Boolean);

if (urls.length === 0) {
  console.error("No ip-ranges URLs found in lib/crawlers/bots.ts — has the roster shape changed?");
  process.exit(2);
}

let failed = false;

for (const url of urls) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) {
      failed = true;
      console.error(`  FAIL  ${url} — HTTP ${res.status}`);
      continue;
    }
    const body = await res.json();
    const prefixes = Array.isArray(body?.prefixes) ? body.prefixes : [];
    const usable = prefixes.filter(
      (p) => typeof (p?.ipv4Prefix ?? p?.ipv6Prefix ?? p?.prefix) === "string",
    );
    if (usable.length === 0) {
      failed = true;
      console.error(`  FAIL  ${url} — 200, but no usable prefixes. The shape has changed.`);
      continue;
    }
    console.log(`  ok    ${url}  (${usable.length} prefixes)`);
  } catch (err) {
    failed = true;
    console.error(`  FAIL  ${url} — ${err?.message ?? err}`);
  }
}

if (failed) {
  console.error(
    "\nAt least one crawler range feed is unreachable or has changed shape.\n" +
      "Verification for those crawlers degrades to reverse DNS where the operator\n" +
      "documents it, and to 'unverified' otherwise. Fix the URL in lib/crawlers/bots.ts.",
  );
  process.exit(1);
}

console.log(`\nAll ${urls.length} crawler range feeds are reachable and parse.`);
