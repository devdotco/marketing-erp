#!/usr/bin/env node
/**
 * The Ed25519 keypair Marketing signs its CRM service assertions with.
 *
 * PRIVATE key → marketing-erp ONLY (MARKETING_SERVICE_PRIVATE_KEY).
 * PUBLIC key  → crm-erp-io (MARKETING_SERVICE_PUBLIC_KEY).
 * A CRM holding the private key could forge Marketing's calls for any
 * organization, which is the whole thing this replaces.
 *
 * Printed single-line with escaped newlines, because Coolify writes env vars
 * into the Dockerfile as ARG lines and a real newline breaks the build. Both
 * apps accept real, escaped and double-escaped newlines.
 *
 *   node scripts/generate-service-keys.mjs
 */
import { generateKeyPairSync } from "node:crypto";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const esc = (pem) => pem.trim().replace(/\n/g, "\\n");
const kid = `marketing-${new Date().toISOString().slice(0, 10)}`;

console.log("# --- marketing-erp (app.erp.io/marketing) ONLY ---------------");
console.log(`MARKETING_SERVICE_PRIVATE_KEY="${esc(privateKey.export({ type: "pkcs8", format: "pem" }))}"`);
console.log(`MARKETING_SERVICE_KEY_ID="${kid}"`);
console.log();
console.log("# --- crm-erp-io (app.erp.io/crm) ------------------------------");
console.log(`MARKETING_SERVICE_PUBLIC_KEY="${esc(publicKey.export({ type: "spki", format: "pem" }))}"`);
