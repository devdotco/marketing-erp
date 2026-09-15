/**
 * The workspace mirror and the shell hand-off against an in-memory stand-in for
 * Prisma — no database, no network. Run with `npm run test:mirror`.
 *
 * Two owner-approved gaps (2026-09-15):
 *
 *   1. A missed removal of an org's LAST eligible member is healed by the
 *      reconcile: the shell now sends such orgs as remove-only `retired` entries.
 *   2. A PLATFORM super admin signing in (or mirrored) as an OUTSIDE org is given
 *      no membership there; ordinary people still are, and the super admin keeps
 *      reaching internal workspaces.
 *
 * The fake is installed as `globalThis.prisma` BEFORE lib/prisma is loaded (it
 * reuses a global client when one exists), so every import below is dynamic.
 */

export {};

type Row = Record<string, unknown>;

const db = {
  workspaces: [] as Row[],
  users: [] as Row[],
  members: [] as Row[],
  versions: new Map<string, { version: bigint; removed: boolean }>(),
  writes: [] as string[],
};

function matches(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([k, v]) => {
    if (k === "NOT") return !matches(row, v as Row);
    if (k === "workspaceId_userId") return matches(row, v as Row);
    if (v && typeof v === "object" && "in" in (v as Row)) return ((v as { in: unknown[] }).in).includes(row[k]);
    return row[k] === v;
  });
}
const copy = (r: Row | undefined) => (r ? { ...r } : null);
let seq = 0;
const id = (p: string) => `${p}-${++seq}`;

const fake = {
  workspace: {
    findUnique: async ({ where }: { where: Row }) => copy(db.workspaces.find((w) => matches(w, where))),
    findMany: async ({ where }: { where: Row }) => db.workspaces.filter((w) => matches(w, where)).map((w) => ({ ...w })),
    create: async ({ data }: { data: Row }) => {
      db.writes.push("workspace.create");
      const w = { id: id("ws"), ...data };
      db.workspaces.push(w);
      return { ...w };
    },
    update: async ({ where, data }: { where: Row; data: Row }) => {
      db.writes.push("workspace.update");
      const w = db.workspaces.find((x) => matches(x, where))!;
      Object.assign(w, data);
      return { ...w };
    },
    updateMany: async ({ where, data }: { where: Row; data: Row }) => {
      db.writes.push("workspace.updateMany");
      const hits = db.workspaces.filter((x) => matches(x, where));
      for (const h of hits) Object.assign(h, data);
      return { count: hits.length };
    },
  },
  user: {
    findUnique: async ({ where }: { where: Row }) => copy(db.users.find((u) => matches(u, where))),
    create: async ({ data }: { data: Row }) => {
      db.writes.push("user.create");
      const u = { id: id("user"), image: null, referralSource: null, ...data };
      db.users.push(u);
      return { ...u };
    },
    update: async ({ where, data }: { where: Row; data: Row }) => {
      if (Object.keys(data).length) db.writes.push("user.update");
      const u = db.users.find((x) => matches(x, where))!;
      Object.assign(u, data);
      return { ...u };
    },
  },
  workspaceMember: {
    findUnique: async ({ where }: { where: Row }) => copy(db.members.find((m) => matches(m, where))),
    findFirst: async ({ where }: { where: Row }) => copy(db.members.find((m) => matches(m, where))),
    findMany: async ({ where }: { where: Row }) =>
      db.members.filter((m) => matches(m, where)).map((m) => ({ ...m, user: copy(db.users.find((u) => u.id === m.userId)) })),
    create: async ({ data }: { data: Row }) => {
      db.writes.push("member.create");
      const m = { id: id("m"), ...data };
      db.members.push(m);
      return { ...m };
    },
    update: async ({ where, data }: { where: Row; data: Row }) => {
      db.writes.push("member.update");
      Object.assign(db.members.find((m) => matches(m, where))!, data);
    },
    deleteMany: async ({ where }: { where: Row }) => {
      db.writes.push("member.deleteMany");
      const before = db.members.length;
      db.members = db.members.filter((m) => !matches(m, where));
      return { count: before - db.members.length };
    },
  },
  shellMirrorVersion: {
    findUnique: async ({ where }: { where: { key: string } }) => db.versions.get(where.key) ?? null,
  },
  // claimVersion's compare-and-set, as Postgres would run it: (strings, key, version, removed).
  $queryRaw: async (_sql: TemplateStringsArray, key: string, version: bigint, removed: boolean) => {
    const stored = db.versions.get(key);
    if (stored && stored.version >= version) return [];
    db.versions.set(key, { version, removed });
    return [{ key }];
  },
  $transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn(fake),
};
(globalThis as unknown as { prisma: unknown }).prisma = fake;

const { applySnapshot, mirrorContext, RETIRED_REMOVAL_DETAIL } = await import("@/lib/shell-mirror/apply");
const { parseSnapshot, PLATFORM_SUPER_ADMIN_REFUSAL, platformAdminMayJoin } = await import("@/lib/shell-mirror/protocol");
const { provisionFromShell } = await import("@/lib/shell-provision");
const { isPlatformSuperAdmin } = await import("@/lib/platform-admin");

let failures = 0;
const check = (name: string, cond: boolean, got?: unknown) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : `  got: ${JSON.stringify(got, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`}`);
  if (!cond) failures += 1;
};

const CUSTOMER = "cmcustomer0000000000000001";
const BRAND = "cmbrandorg0000000000000001";
const V1 = 1_757_000_000_000_000;
const verified = (idv: string, email: string, role = "OPERATOR") => ({ user: { id: idv, email, name: email, emailVerified: true }, role: role as "OPERATOR" });

function reset() {
  db.workspaces = [
    { id: "ws-admin", name: "Platform", slug: "platform", shellOrgId: null },
    { id: "ws-brand", name: "Brand", slug: "brand", shellOrgId: BRAND },
    { id: "ws-cust", name: "Customer", slug: "customer", shellOrgId: CUSTOMER },
  ];
  db.users = [
    { id: "u-nate", email: "nate@dev.co", shellUserId: "su-nate", name: "Nate", image: null, emailVerified: new Date(), referralSource: null },
    { id: "u-last", email: "last@cust.com", shellUserId: "su-last", name: "Last", image: null, emailVerified: new Date(), referralSource: null },
    { id: "u-stays", email: "stays@cust.com", shellUserId: "su-stays", name: "Stays", image: null, emailVerified: new Date(), referralSource: null },
    { id: "u-invited", email: "invited@cust.com", shellUserId: "su-invited", name: "Invited", image: null, emailVerified: new Date(), referralSource: null },
  ];
  db.members = [
    // nate@dev.co is a PLATFORM super admin: a SUPER_ADMIN membership somewhere.
    { id: "m-nate-admin", workspaceId: "ws-admin", userId: "u-nate", role: "SUPER_ADMIN", source: "legacy" },
    { id: "m-nate-brand", workspaceId: "ws-brand", userId: "u-nate", role: "WORKSPACE_ADMIN", source: "legacy" },
    { id: "m-last", workspaceId: "ws-cust", userId: "u-last", role: "WORKSPACE_ADMIN", source: "mirror" },
    { id: "m-stays", workspaceId: "ws-cust", userId: "u-stays", role: "OPERATOR", source: "mirror" },
    { id: "m-invited", workspaceId: "ws-cust", userId: "u-invited", role: "OPERATOR", source: "app" },
  ];
  db.versions = new Map();
  db.writes = [];
}
const custMembers = () => db.members.filter((m) => m.workspaceId === "ws-cust").map((m) => m.id).sort();
const retiredSnap = (memberUserIds: string[], version = V1) => ({ version, orgs: [], retired: [{ orgId: CUSTOMER, memberUserIds }] });

// ─── Gap 1: a missed last-member removal is healed by reconcile ─────────────
{
  reset();
  check("wire: a shell older than `retired` parses as an empty list", JSON.stringify(parseSnapshot({ version: V1, orgs: [] }).retired) === "[]");
  let threw = false;
  try { parseSnapshot({ version: V1, orgs: [], retired: [{ orgId: "", memberUserIds: [] }] }); } catch { threw = true; }
  check("wire: an empty retired org id is refused", threw);

  const dry = mirrorContext(true);
  await applySnapshot(retiredSnap(["su-stays"]), dry);
  check("retired dry run: lists the removal with its reason, writes nothing",
    JSON.stringify(dry.report) === JSON.stringify([{ kind: "member.removed", orgId: CUSTOMER, email: "last@cust.com", detail: RETIRED_REMOVAL_DETAIL }]) && db.writes.length === 0 && db.versions.size === 0,
    { report: dry.report, writes: db.writes });

  const run = mirrorContext(false);
  await applySnapshot(retiredSnap(["su-stays"]), run);
  check("retired: the absent mirror-created member is removed; present and in-app members stay",
    JSON.stringify(custMembers()) === JSON.stringify(["m-invited", "m-stays"]), custMembers());
  check("retired: the removal records a tombstone", db.versions.get(`member:${CUSTOMER}:su-last`)?.removed === true, [...db.versions]);

  reset();
  await applySnapshot(retiredSnap([]), mirrorContext(false));
  check("retired: an EMPTY org (its last member removed) loses every mirror-created member, keeps in-app",
    JSON.stringify(custMembers()) === JSON.stringify(["m-invited"]), custMembers());

  const writes = db.writes.length;
  const again = mirrorContext(false);
  await applySnapshot(retiredSnap([]), again);
  const newer = mirrorContext(false);
  await applySnapshot(retiredSnap([], V1 + 1_000_000), newer);
  check("retired: idempotent — a re-run (same or newer version) writes and reports nothing",
    again.report.length === 0 && newer.report.length === 0 && db.writes.length === writes, { again: again.report, newer: newer.report });

  reset();
  db.members.push({ id: "m-sa", workspaceId: "ws-cust", userId: "u-nate", role: "SUPER_ADMIN", source: "mirror" });
  await applySnapshot(retiredSnap([]), mirrorContext(false));
  check("retired: a SUPER_ADMIN row is never removed", db.members.some((m) => m.id === "m-sa"));

  reset();
  db.versions.set(`member:${CUSTOMER}:su-last`, { version: BigInt(V1 + 5), removed: false });
  const stale = mirrorContext(false);
  await applySnapshot(retiredSnap([]), stale);
  check("retired: version ordering — older than the member's last applied state is stale",
    stale.report.find((r) => r.email === "last@cust.com")?.kind === "stale" && db.members.some((m) => m.id === "m-last"), stale.report);

  reset();
  const none = mirrorContext(false);
  await applySnapshot(
    { version: V1, orgs: [], retired: [{ orgId: "cmneverprojected000000001", memberUserIds: ["su-brand-new"] }, { orgId: CUSTOMER, memberUserIds: ["su-last", "su-stays", "su-brand-new"] }] },
    none,
  );
  check("retired: an ineligible org gets no new projection — no workspace, user, membership or rename",
    none.report.length === 0 && db.writes.length === 0 && db.workspaces.length === 3 && db.workspaces.find((w) => w.id === "ws-cust")!.name === "Customer",
    { report: none.report, writes: db.writes });

  reset();
  const both = mirrorContext(true);
  await applySnapshot({ version: V1, orgs: [{ org: { id: CUSTOMER, name: "Customer", slug: "c" }, members: [verified("su-last", "last@cust.com", "WORKSPACE_ADMIN"), verified("su-stays", "stays@cust.com")] }], retired: [{ orgId: CUSTOMER, memberUserIds: [] }] }, both);
  check("retired: an org listed live AND retired is treated as live only", !both.report.some((r) => r.kind === "member.removed"), both.report);
}

// ─── Gap 2: platform super admins and outside orgs ──────────────────────────
{
  const claims = (org: string, extra: Record<string, unknown> = {}) => ({
    sub: "su-nate", email: "nate@dev.co", name: "Nate", org, orgName: "Org", role: "SUPER_ADMIN", emailVerified: true, issuedAt: 1_757_000_000, ...extra,
  });

  check("rule: a super admin may join only an org the shell says is internal",
    !platformAdminMayJoin({}, true) && !platformAdminMayJoin({ internal: false }, true) && platformAdminMayJoin({ internal: true }, true) && platformAdminMayJoin({}, false));

  reset();
  const out = await provisionFromShell(claims(CUSTOMER));
  check("sign-in: a platform super admin acting as an outside org gets no membership (and is still signed in)",
    out.user.id === "u-nate" && out.workspaceId === null && !db.members.some((m) => m.userId === "u-nate" && m.workspaceId === "ws-cust") && !db.writes.includes("member.create"),
    { out, writes: db.writes });

  reset();
  const fresh = await provisionFromShell(claims("cmbrandnewcustomer00000001", { orgInternal: false }));
  check("sign-in: …nor a workspace for an outside org that has none", fresh.workspaceId === null && db.workspaces.length === 3 && !db.writes.includes("workspace.create"), db.writes);

  reset();
  db.members.push({ id: "m-nate-cust", workspaceId: "ws-cust", userId: "u-nate", role: "VIEWER", source: "mirror" });
  const existing = await provisionFromShell(claims(CUSTOMER, { role: "WORKSPACE_ADMIN" }));
  check("sign-in: an existing row there is left exactly as it is (lands there, not re-roled)",
    existing.workspaceId === "ws-cust" && db.members.find((m) => m.id === "m-nate-cust")!.role === "VIEWER" && db.writes.every((w) => !w.startsWith("member.")), { existing, writes: db.writes });

  reset();
  const alice = await provisionFromShell({ sub: "su-alice", email: "alice@cust.com", name: "Alice", org: CUSTOMER, orgName: "Customer", role: "OPERATOR", emailVerified: true, issuedAt: 1_757_000_000 });
  check("sign-in: an ordinary user still gets one, sourced `mirror`",
    alice.workspaceId === "ws-cust" && db.members.some((m) => m.workspaceId === "ws-cust" && m.userId === alice.user.id && m.source === "mirror" && m.role === "OPERATOR"), db.members);

  reset();
  const brand = await provisionFromShell(claims(BRAND, { orgInternal: true }));
  check("sign-in: the platform super admin still reaches an internal workspace (existing membership untouched)",
    brand.workspaceId === "ws-brand" && db.members.find((m) => m.id === "m-nate-brand")!.role === "WORKSPACE_ADMIN", { brand, members: db.members });
  check("sign-in: …and is still a platform super admin", await isPlatformSuperAdmin("u-nate"));

  reset();
  db.members = db.members.filter((m) => m.id !== "m-nate-brand");
  const brandNew = await provisionFromShell(claims(BRAND, { orgInternal: true }));
  check("sign-in: in an internal org without a row, today's provisioning is kept (mirror, never SUPER_ADMIN)",
    brandNew.workspaceId === "ws-brand" && db.members.some((m) => m.workspaceId === "ws-brand" && m.userId === "u-nate" && m.source === "mirror" && m.role === "WORKSPACE_ADMIN"), db.members);

  // The reconcile must not undo the sign-in rule within 15 minutes.
  reset();
  const mirrorOut = mirrorContext(false);
  await applySnapshot({ version: V1, orgs: [{ org: { id: CUSTOMER, name: "Customer", slug: "c" }, members: [verified("su-nate", "nate@dev.co", "WORKSPACE_ADMIN"), verified("su-last", "last@cust.com", "WORKSPACE_ADMIN"), verified("su-stays", "stays@cust.com")] }], retired: [] }, mirrorOut);
  check("mirror: a platform super admin in an outside org is refused, not added",
    mirrorOut.report.some((r) => r.kind === "link.refused" && r.email === "nate@dev.co" && r.detail === PLATFORM_SUPER_ADMIN_REFUSAL) && !db.members.some((m) => m.userId === "u-nate" && m.workspaceId === "ws-cust"),
    mirrorOut.report);

  reset();
  db.members = db.members.filter((m) => m.id !== "m-nate-brand");
  const mirrorBrand = mirrorContext(false);
  await applySnapshot({ version: V1, orgs: [{ org: { id: BRAND, name: "Brand", slug: "b", internal: true }, members: [verified("su-nate", "nate@dev.co", "WORKSPACE_ADMIN")] }], retired: [] }, mirrorBrand);
  check("mirror: in an internal org the platform super admin is still mirrored",
    db.members.some((m) => m.userId === "u-nate" && m.workspaceId === "ws-brand" && m.source === "mirror"), mirrorBrand.report);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
