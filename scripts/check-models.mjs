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

/**
 * Answer-engine model ids (lib/answer-engines/models.ts).
 *
 * Only Anthropic ids can be verified against a live API from here — we hold no
 * key for the others, and BYOK means we never will. What CAN be enforced is
 * that they all live in one file, so a stale id is a one-line fix found by
 * reading one file rather than a hunt through four clients. That is the half
 * of the Anthropic lesson that transfers.
 */
const engineSrc = fs.readFileSync(new URL("../lib/answer-engines/models.ts", import.meta.url), "utf8");
const engineRegistry = engineSrc.match(/export const ENGINE_MODELS[^=]*= \{([\s\S]*?)\};/);
if (!engineRegistry) {
  console.error("Could not find ENGINE_MODELS in lib/answer-engines/models.ts");
  process.exit(2);
}
const engineIds = [...engineRegistry[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
const engineStrays = [];
/**
 * Ids that must not appear outside the registry.
 *
 * Anthropic's are caught separately. Ids naming a different modality — image,
 * speech, embedding — are excluded: those are other product surfaces with
 * their own modules (lib/images/*, lib/voice/*), and sweeping them in here
 * would fail the build on untouched code, which is how a useful check gets
 * switched off. This gate is about the models that answer a tracked prompt.
 */
const ENGINE_ID_PATTERN = /"(gpt-[\w.-]+|o\d[\w.-]*|gemini-[\w.-]+|sonar[\w.-]*)"/g;
const ENGINE_ID_HOLDERS = ["lib/answer-engines/models.ts"];
const OTHER_MODALITIES = /(image|tts|speech|audio|embed|whisper|realtime)/i;

// Anything still hardcoding a model id bypasses the registry — catch that too.
const strays = [];

/**
 * Files allowed to construct an Anthropic client.
 *
 * `new Anthropic()` with no argument reads ANTHROPIC_API_KEY — the platform key
 * — so anywhere else it appears is tenant work billed to us. That is not
 * hypothetical: lib/social/generate.ts held one at module scope and wrote social
 * copy on our account for a tenant's LinkedIn, because it is a cron route and
 * the BYOK sweep only covered agent handlers.
 *
 * lib/ai/client.ts is the resolver itself. lib/ai/models.ts uses it for a
 * health check that retrieves model metadata and spends no tokens.
 */
const KEY_HOLDERS = ["lib/ai/client.ts", "lib/ai/models.ts"];
const rogueClients = [];

/**
 * Scan code, not prose. A comment explaining why `new Anthropic()` must not
 * appear should not itself trip the check that enforces it.
 */
const stripComments = (text) =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
for (const dir of ["lib", "app", "workers"]) {
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = `${d}/${entry.name}`;
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name)) {
        const text = stripComments(fs.readFileSync(full, "utf8"));
        for (const m of text.matchAll(/model:\s*"(claude-[^"]+)"/g)) {
          strays.push(`${full}: ${m[1]}`);
        }
        if (!ENGINE_ID_HOLDERS.includes(full)) {
          for (const m of text.matchAll(ENGINE_ID_PATTERN)) {
            if (!OTHER_MODALITIES.test(m[1])) engineStrays.push(`${full}: ${m[1]}`);
          }
        }
        if (!KEY_HOLDERS.includes(full) && /new Anthropic\s*\(/.test(text)) {
          rogueClients.push(full);
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

console.log("\nAnswer-engine models (lib/answer-engines/models.ts) — not verifiable from here, BYOK:");
for (const id of engineIds) console.log(`  set   ${id}`);

if (engineStrays.length) {
  failed = true;
  console.error("\nAnswer-engine model ids found outside the registry — move them into");
  console.error("lib/answer-engines/models.ts, or a stale one becomes four edits instead of one:");
  for (const s of engineStrays) console.error(`  ${s}`);
}

if (strays.length) {
  failed = true;
  console.error("\nHardcoded model ids found — move these into lib/ai/models.ts:");
  for (const s of strays) console.error(`  ${s}`);
}

if (rogueClients.length) {
  failed = true;
  console.error(
    "\nAnthropic clients built outside lib/ai/client.ts — these run on the PLATFORM key,",
  );
  console.error("so a tenant's work would be billed to us. Take the client as an argument and");
  console.error("let the caller resolve it with resolveAnthropic(workspaceId):");
  for (const f of rogueClients) console.error(`  ${f}`);
}

if (failed) {
  console.error("\nCheck failed. Do not deploy.");
  process.exit(1);
}
console.log("\nAll referenced models are available, every Anthropic client is workspace-scoped,\nand every answer-engine id lives in the registry.");
