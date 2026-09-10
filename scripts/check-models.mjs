#!/usr/bin/env node
/**
 * Verify every Claude model id this app references exists.
 *
 * Run before a deploy. A date-suffixed snapshot that has been retired (or was
 * never valid) returns 404 not_found_error on the first API call of every run,
 * which is how the Blog Writer agent failed silently for users on 2026-09-08.
 *
 *   npm run check:models
 */
import Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs";

const src = fs.readFileSync(new URL("../lib/ai/models.ts", import.meta.url), "utf8");
const registry = src.match(/export const MODELS = \{([\s\S]*?)\} as const;/);
if (!registry) {
  console.error("Could not find the MODELS registry in lib/ai/models.ts");
  process.exit(2);
}
const ids = [...registry[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);

// Anything still hardcoding a model id bypasses the registry — catch that too.
const strays = [];
for (const dir of ["lib", "app", "workers"]) {
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = `${d}/${entry.name}`;
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name) && full !== "lib/ai/models.ts") {
        const text = fs.readFileSync(full, "utf8");
        for (const m of text.matchAll(/model:\s*"(claude-[^"]+)"/g)) {
          strays.push(`${full}: ${m[1]}`);
        }
      }
    }
  };
  if (fs.existsSync(dir)) walk(dir);
}

const client = new Anthropic();
let failed = false;

for (const id of ids) {
  try {
    const model = await client.models.retrieve(id);
    console.log(`  ok    ${id}  (${model.display_name})`);
  } catch (err) {
    failed = true;
    console.error(`  FAIL  ${id}  — ${err?.message ?? err}`);
  }
}

if (strays.length) {
  failed = true;
  console.error("\nHardcoded model ids found — move these into lib/ai/models.ts:");
  for (const s of strays) console.error(`  ${s}`);
}

if (failed) {
  console.error("\nModel check failed. Do not deploy: agent runs using these models will 404 at the first API call.");
  process.exit(1);
}
console.log("\nAll referenced models are available.");
