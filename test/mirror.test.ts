/**
 * The Marketing/CRM workspace mirror and the automatic CRM connection — pure
 * rules only, no network and no database. Run with `npm run test:mirror`.
 *
 * What a security review would ask: can a mirror event be forged, redirected,
 * replayed or reordered; can the role mapping elevate anyone to SUPER_ADMIN;
 * can a missing org match a local workspace; can an unverified email take over
 * an account; can a workspace call the CRM as an org that is not its own.
 */
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { SignJWT, importPKCS8, importSPKI, jwtVerify, decodeProtectedHeader } from "jose";
import { verifyMirrorToken, memoryReplayGuard } from "@/lib/shell-mirror/verify";
import {
  decideUserLink,
  isNewer,
  marketingRoleFor,
  memberKey,
  orgIdOf,
  parseEvent,
  snapshotRemovals,
  mirrorMayRemove,
  signInMayRestore,
  localAccountVerified,
  mirroredMarketingRole,
} from "@/lib/shell-mirror/protocol";
import { shouldRetryWithKey } from "@/lib/integrations/crm-erp-io";
import { mirrorEnabled, mirrorSecretMatches, readCappedText } from "@/lib/shell-mirror/gate";
import { isPlatformSuperAdmin } from "@/lib/platform-admin";
import { provisionFromShell } from "@/lib/shell-provision";
import { chooseCrmConnection } from "@/lib/integrations/crm-connection";
import { bodyDigest, signCrmAssertion, MARKETING_SERVICE_ISSUER, SERVICE_JWT_TYPE } from "@/lib/integrations/service-assertion";

let failures = 0;
const check = (name: string, cond: boolean, got?: unknown) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : `  got: ${JSON.stringify(got)}`}`);
  if (!cond) failures += 1;
};
async function rejects(name: string, fn: () => Promise<unknown>, match?: RegExp) {
  try {
    await fn();
    check(name, false, "did not throw");
  } catch (err) {
    check(name, !match || match.test((err as Error).message), (err as Error).message);
  }
}
function throws(name: string, fn: () => unknown) {
  try {
    fn();
    check(name, false, "did not throw");
  } catch {
    check(name, true);
  }
}

const ISS = "https://app.vb.co";
const pair = generateKeyPairSync("ed25519");
const shellPriv = await importPKCS8(pair.privateKey.export({ type: "pkcs8", format: "pem" }) as string, "EdDSA");
const shellPub = await importSPKI(pair.publicKey.export({ type: "spki", format: "pem" }) as string, "EdDSA");

const ORG = { id: "cmsn7u9hq0008dudveaejn28c", name: "Audience Bloom Services, LLC", slug: "seo-co" };
const evt = {
  type: "member.upserted",
  version: 1_757_000_000_000_000,
  org: ORG,
  member: { user: { id: "su-tim", email: "Tim@Dev.co", name: "Tim", emailVerified: true }, role: "OPERATOR" },
};

async function signMirror(
  claims: Record<string, unknown>,
  o: { aud?: string; typ?: string; iat?: number; ttl?: number; jti?: string | null; key?: typeof shellPriv } = {},
) {
  const iat = o.iat ?? Math.floor(Date.now() / 1000);
  const jwt = new SignJWT(claims)
    .setProtectedHeader({ alg: "EdDSA", typ: o.typ ?? "erp-mirror+jwt" })
    .setIssuer(ISS)
    .setAudience(o.aud ?? "marketing")
    .setSubject("shell:mirror")
    .setIssuedAt(iat)
    .setExpirationTime(iat + (o.ttl ?? 60));
  if (o.jti !== null) jwt.setJti(o.jti ?? randomUUID());
  return jwt.sign(o.key ?? shellPriv);
}

// ─── Event signature / audience / type / expiry ─────────────────────────────
{
  const v = await verifyMirrorToken(await signMirror({ evt }), shellPub, ISS);
  check("mirror: accepts a shell-signed event for aud=marketing", v.kind === "event");
  check("mirror: lower-cases the member email", v.kind === "event" && v.event.type === "member.upserted" && v.event.member.user.email === "tim@dev.co");

  const other = generateKeyPairSync("ed25519");
  const otherPriv = await importPKCS8(other.privateKey.export({ type: "pkcs8", format: "pem" }) as string, "EdDSA");
  await rejects("mirror: rejects another key's signature", async () => verifyMirrorToken(await signMirror({ evt }, { key: otherPriv }), shellPub, ISS));
  await rejects("mirror: rejects an event addressed to CRM", async () => verifyMirrorToken(await signMirror({ evt }, { aud: "crm" }), shellPub, ISS), /aud/);
  await rejects("mirror: rejects a hand-off token (typ JWT) posted as an event", async () => verifyMirrorToken(await signMirror({ evt }, { typ: "JWT" }), shellPub, ISS));
  await rejects("mirror: rejects the wrong issuer", async () => verifyMirrorToken(await signMirror({ evt }), shellPub, "https://app.erp.io"), /iss/);
  await rejects("mirror: rejects a payload naming a bearer email (never a sign-in)", async () => verifyMirrorToken(await signMirror({ evt, email: "nate@dev.co" }), shellPub, ISS));
  await rejects("mirror: rejects an expired event", async () => verifyMirrorToken(await signMirror({ evt }, { iat: Math.floor(Date.now() / 1000) - 3600 }), shellPub, ISS), /exp/);
  await rejects("mirror: rejects an over-long lifetime", async () => verifyMirrorToken(await signMirror({ evt }, { ttl: 3600 }), shellPub, ISS), /lifetime/);
  await rejects("mirror: rejects a token with no jti", async () => verifyMirrorToken(await signMirror({ evt }, { jti: null }), shellPub, ISS), /jti/);
  await rejects("mirror: rejects both evt and snap at once", async () => verifyMirrorToken(await signMirror({ evt, snap: { version: 1, orgs: [] } }), shellPub, ISS));
}

// ─── Replay ─────────────────────────────────────────────────────────────────
{
  const guard = memoryReplayGuard();
  const exp = new Date(Date.now() + 60_000);
  check("replay: first presentation accepted", await guard.claim("j1", exp));
  check("replay: second presentation refused", !(await guard.claim("j1", exp)));
}

// ─── Idempotent, ordered upserts ─────────────────────────────────────────────
{
  check("order: first version applies", isNewer(null, 5));
  check("order: duplicate is a no-op", !isNewer(BigInt(5), 5));
  check("order: stale is a no-op", !isNewer(BigInt(6), 5));
  let stored: bigint | null = null;
  let member = false;
  const deliver = (v: number, next: boolean) => { if (isNewer(stored, v)) { stored = BigInt(v); member = next; } };
  deliver(10, true); deliver(20, false); deliver(10, true);
  check("order: added → removed → late retry of added ends removed", member === false);
  check("order: keys are per org and shell user", memberKey(ORG.id, "u1") === `member:${ORG.id}:u1`);
}

// ─── Role mapping ────────────────────────────────────────────────────────────
{
  check("roles: shell SUPER_ADMIN lands as WORKSPACE_ADMIN, never SUPER_ADMIN", marketingRoleFor("SUPER_ADMIN", null) === "WORKSPACE_ADMIN");
  check("roles: WORKSPACE_ADMIN → WORKSPACE_ADMIN", marketingRoleFor("WORKSPACE_ADMIN", "VIEWER") === "WORKSPACE_ADMIN");
  check("roles: OPERATOR → OPERATOR (demotes an admin)", marketingRoleFor("OPERATOR", "WORKSPACE_ADMIN") === "OPERATOR");
  check("roles: VIEWER → VIEWER", marketingRoleFor("VIEWER", "OPERATOR") === "VIEWER");
  check("roles: an existing platform SUPER_ADMIN is kept, whatever the shell says", marketingRoleFor("VIEWER", "SUPER_ADMIN") === "SUPER_ADMIN");
  check("roles: unknown or missing role is the least access", marketingRoleFor("PLATFORM_ADMIN", null) === "VIEWER" && marketingRoleFor(null, null) === "VIEWER");
  throws("roles: an event with a non-ladder role is refused", () => parseEvent({ ...evt, member: { ...evt.member, role: "SUPER_DUPER" } }));
}

// ─── A missing org never matches ─────────────────────────────────────────────
{
  for (const bad of ["", "  ", null, undefined, 7]) {
    throws(`null-org: orgIdOf(${JSON.stringify(bad)}) refuses`, () => orgIdOf(bad));
    throws(`null-org: event with org.id ${JSON.stringify(bad)} refuses`, () => parseEvent({ ...evt, org: { ...ORG, id: bad } }));
  }
  const noOrg = chooseCrmConnection({ shellOrgId: null, serviceConfigured: true, legacy: null, serviceBaseUrl: "https://app.erp.io/crm" });
  check("null-org: a workspace with no org never gets a service connection", !noOrg.ok && noOrg.code === "no_org", noOrg);
  const blank = chooseCrmConnection({ shellOrgId: "   ", serviceConfigured: true, legacy: null, serviceBaseUrl: "https://app.erp.io/crm" });
  check("null-org: a blank org id is no org", !blank.ok, blank);
  await rejects("null-org: an assertion cannot be signed without an org", () => signCrmAssertion({ shellOrgId: "", method: "GET", path: "/x", body: "" }, shellPriv), /organization/);
}

// ─── User linking ────────────────────────────────────────────────────────────
{
  const su = { id: "su-1", emailVerified: true };
  check("link: uses the account carrying the shell id", decideUserLink(su, { id: "m1", email: "a@x.co", shellUserId: "su-1", emailVerified: true }, null).action === "use");
  check("link: links an unlinked account on a verified email", decideUserLink(su, null, { id: "m2", email: "a@x.co", shellUserId: null, emailVerified: true }).action === "link");
  check("link: refuses on an unverified email", decideUserLink({ ...su, emailVerified: false }, null, { id: "m2", email: "a@x.co", shellUserId: null, emailVerified: true }).action === "refuse");
  check("link: never moves an account to another shell user", decideUserLink(su, null, { id: "m3", email: "a@x.co", shellUserId: "su-OTHER", emailVerified: true }).action === "refuse");
  check("link: never links a Marketing account that was never verified (pre-hijack)", decideUserLink(su, null, { id: "m4", email: "a@x.co", shellUserId: null, emailVerified: false }).action === "refuse");
  check("link: a password sign-up is not verified; a magic-link or shell-created account is",
    !localAccountVerified({ emailVerified: null, referralSource: "digitalmarketers.ai" })
    && localAccountVerified({ emailVerified: new Date(), referralSource: null })
    && localAccountVerified({ emailVerified: null, referralSource: "erp.io shell" }));
  check("link: creates when nobody has the address (verified)", decideUserLink(su, null, null).action === "create");
  check("link: never creates an account for an unverified address", decideUserLink({ ...su, emailVerified: false }, null, null).action === "refuse");
  check("link: skips an unverified person even when already linked", decideUserLink({ ...su, emailVerified: false }, { id: "m1", email: "a@x.co", shellUserId: "su-1", emailVerified: true }, null).action === "refuse");
}

// ─── Snapshot removals ───────────────────────────────────────────────────────
{
  const { remove, unmanaged } = snapshotRemovals(
    [
      { shellUserId: "keep", source: "mirror", role: "OPERATOR" },
      { shellUserId: "gone", source: "mirror", role: "OPERATOR" },
      { shellUserId: "invited", source: "app", role: "OPERATOR" },
      { shellUserId: "old", source: "legacy", role: "WORKSPACE_ADMIN" },
      { shellUserId: "operator", source: "mirror", role: "SUPER_ADMIN" },
      { shellUserId: null, source: "mirror", role: "VIEWER" },
    ],
    new Set(["keep"]),
  );
  check("snapshot: removes only a mirror-created, linked member absent from the snapshot", remove.length === 1 && remove[0].shellUserId === "gone", remove);
  check("snapshot: keeps in-app invites, legacy rows, SUPER_ADMIN and unlinked accounts", unmanaged.map((u) => u.shellUserId).join(",") === "invited,old,operator,", unmanaged);
  check("snapshot: mirrorMayRemove refuses an app row", !mirrorMayRemove({ shellUserId: "u", source: "app", role: "VIEWER" }));
  check("snapshot: mirrorMayRemove refuses SUPER_ADMIN even from the mirror", !mirrorMayRemove({ shellUserId: "u", source: "mirror", role: "SUPER_ADMIN" }));
}

// ─── Only mirror-created memberships follow the shell's role ────────────────
{
  check("re-role: a mirror row follows the shell", mirroredMarketingRole("VIEWER", { role: "WORKSPACE_ADMIN", source: "mirror" }) === "VIEWER");
  check("re-role: an invited row keeps its role", mirroredMarketingRole("VIEWER", { role: "WORKSPACE_ADMIN", source: "app" }) === "WORKSPACE_ADMIN");
  check("re-role: a legacy row keeps its role", mirroredMarketingRole("SUPER_ADMIN", { role: "OPERATOR", source: "legacy" }) === "OPERATOR");
  check("re-role: SUPER_ADMIN kept on a mirror row, never granted on a new one", mirroredMarketingRole("VIEWER", { role: "SUPER_ADMIN", source: "mirror" }) === "SUPER_ADMIN" && mirroredMarketingRole("SUPER_ADMIN", null) === "WORKSPACE_ADMIN");
}

// ─── Automatic CRM connection ────────────────────────────────────────────────
{
  const base = { serviceBaseUrl: "https://app.erp.io/crm" };
  const linked = chooseCrmConnection({ ...base, shellOrgId: ORG.id, serviceConfigured: true, legacy: { apiKey: "crmio_mkt_x", crmUrl: "https://evil.example" } });
  check("connection: a linked workspace uses the signed service path", linked.ok && linked.via === "service");
  check("connection: …and ignores a legacy key and its URL", linked.ok && linked.target.baseUrl === "https://app.erp.io/crm" && linked.target.auth.kind === "service");
  check("connection: …asserting its OWN org", linked.ok && linked.target.auth.kind === "service" && linked.target.auth.shellOrgId === ORG.id);
  check("connection: a stored key rides along as a 401 fallback while service keys roll out", linked.ok && linked.target.fallbackKey === "crmio_mkt_x");
  check("fallback: retried only for a signed call refused with 401 and a key on hand",
    shouldRetryWithKey(401, { baseUrl: "b", auth: { kind: "service", shellOrgId: "o" }, fallbackKey: "k" })
    && !shouldRetryWithKey(403, { baseUrl: "b", auth: { kind: "service", shellOrgId: "o" }, fallbackKey: "k" })
    && !shouldRetryWithKey(401, { baseUrl: "b", auth: { kind: "service", shellOrgId: "o" } })
    && !shouldRetryWithKey(401, { baseUrl: "b", auth: { kind: "key", apiKey: "k" }, fallbackKey: "k" }));
  const fallback = chooseCrmConnection({ ...base, shellOrgId: null, serviceConfigured: true, legacy: { apiKey: "crmio_mkt_x" } });
  check("connection: an unlinked workspace falls back to a legacy key", fallback.ok && fallback.via === "key");
  const unconfigured = chooseCrmConnection({ ...base, shellOrgId: ORG.id, serviceConfigured: false, legacy: null });
  check("connection: a linked workspace on a server without a signing key says so", !unconfigured.ok && unconfigured.code === "service_unconfigured");
}

// ─── Service assertion (must match crm-erp-io src/lib/auth/marketing-assertion.ts) ─
{
  const mk = generateKeyPairSync("ed25519");
  const mkPriv = await importPKCS8(mk.privateKey.export({ type: "pkcs8", format: "pem" }) as string, "EdDSA");
  const mkPub = await importSPKI(mk.publicKey.export({ type: "spki", format: "pem" }) as string, "EdDSA");
  const body = JSON.stringify({ segmentId: "seg_1" });
  const token = await signCrmAssertion({ shellOrgId: ORG.id, method: "post", path: "/api/marketing-erp/sequences/s1/activate", body }, mkPriv);
  const { payload } = await jwtVerify(token, mkPub, { issuer: MARKETING_SERVICE_ISSUER, audience: "crm", typ: SERVICE_JWT_TYPE });
  check("assertion: sub is the workspace's shell org", payload.sub === ORG.id);
  check("assertion: bound to method, path and body", payload.htm === "POST" && payload.htu === "/api/marketing-erp/sequences/s1/activate" && payload.bdy === bodyDigest(body));
  check("assertion: single-use jti and a 60s lifetime", typeof payload.jti === "string" && (payload.exp! - payload.iat!) === 60);
  check("assertion: typ marks it as a service assertion", decodeProtectedHeader(token).typ === SERVICE_JWT_TYPE);
  const other = await signCrmAssertion({ shellOrgId: ORG.id, method: "POST", path: "/x", body }, mkPriv);
  check("assertion: every signature has its own jti", (await jwtVerify(other, mkPub)).payload.jti !== payload.jti);
}

// ─── Blocker 1: a removed member does not come back through the hand-off ──────
{
  const removedAt = BigInt(1_757_000_000) * BigInt(1_000_000);
  check("tombstone: a token minted before the removal cannot recreate the membership", !signInMayRestore({ version: removedAt, removed: true }, 1_757_000_000 - 60));
  check("tombstone: a token minted at the same second cannot either", !signInMayRestore({ version: removedAt, removed: true }, 1_757_000_000));
  check("tombstone: a token with no iat cannot either", !signInMayRestore({ version: removedAt, removed: true }, undefined));
  check("tombstone: a token minted after re-adding in the shell can", signInMayRestore({ version: removedAt, removed: true }, 1_757_000_001));
  check("tombstone: someone never removed is unaffected", signInMayRestore(null, undefined) && signInMayRestore({ version: removedAt, removed: false }, 1));
}

// ─── Blocker 5/8: the hand-off never creates anything for an unverified address ─
{
  const base = { sub: "su-x", email: "x@evil.example", name: "X", org: "cmsn7u9hq0008dudveaejn28c", orgName: "Audience Bloom", role: "OPERATOR" };
  await rejects("hand-off: a MISSING email_verified claim is refused before any write", () => provisionFromShell({ ...base }), /not verified/);
  await rejects("hand-off: email_verified false is refused before any write", () => provisionFromShell({ ...base, emailVerified: false }), /not verified/);
}

// ─── Kill switch, body cap, dedicated secret ────────────────────────────────
{
  check("gate: off unless MIRROR_MODULES names marketing", !mirrorEnabled("marketing", undefined) && !mirrorEnabled("marketing", "crm") && mirrorEnabled("marketing", "crm,marketing"));
  const big = "x".repeat(5_000);
  check("gate: oversized body refused by content-length", (await readCappedText(new Request("https://x/", { method: "POST", body: big, headers: { "content-length": "5000" } }), 1_000)) === null);
  const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(big)); c.close(); } });
  check("gate: oversized body refused while streaming", (await readCappedText(new Request("https://x/", { method: "POST", body: stream, duplex: "half" } as RequestInit), 1_000)) === null);
  check("gate: small body read", (await readCappedText(new Request("https://x/", { method: "POST", body: "tok" }), 1_000)) === "tok");
  check("gate: only SHELL_MIRROR_SECRET, fail closed when unset", mirrorSecretMatches("m", "m") && !mirrorSecretMatches("service", "m") && !mirrorSecretMatches("", undefined));
}

// ─── Internal isolation: /superadmin is platform-only ────────────────────────
{
  const calls: unknown[] = [];
  const fakeDb = (row: { id: string } | null) => ({
    workspaceMember: { findFirst: async (args: unknown) => { calls.push(args); return row; } },
  });
  check("superadmin: no SUPER_ADMIN membership, no access", !(await isPlatformSuperAdmin("u-customer", fakeDb(null))));
  check("superadmin: derived only from a SUPER_ADMIN membership", JSON.stringify(calls[0]) === JSON.stringify({ where: { userId: "u-customer", role: "SUPER_ADMIN" }, select: { id: true } }), calls[0]);
  check("superadmin: an operator is let in", await isPlatformSuperAdmin("u-nate", fakeDb({ id: "m" })));
  check("superadmin: nobody without a user id", !(await isPlatformSuperAdmin(null, fakeDb({ id: "m" }))));
  check("superadmin: the mirror's top role is never SUPER_ADMIN, for any shell role", ["SUPER_ADMIN", "WORKSPACE_ADMIN", "OPERATOR", "VIEWER", "PLATFORM_ADMIN", null].every((r) => marketingRoleFor(r, null) !== "SUPER_ADMIN"));
  const internal = parseEvent({ ...evt, org: { ...ORG, internal: true } });
  check("isolation: the internal flag survives parsing", internal.org.internal === true && parseEvent(evt).org.internal === undefined);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
