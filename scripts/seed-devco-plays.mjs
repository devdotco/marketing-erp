#!/usr/bin/env node
/**
 * Backfills Dev.co's own three outbound plays as real OutboundPlay rows, with the ICPs that used
 * to be hardcoded straight into every outbound agent handler (outbound-scout.ts's
 * ICP_DEFINITIONS/APOLLO_FILTERS, outbound-email.ts's CAMPAIGN_MAP, outbound-linkedin.ts's
 * AIMFOX_CAMPAIGN_MAP — all removed as part of the Outbound Engine rebuild).
 *
 * Only touches the Dev.co workspace (slug "dev-co", falling back to a workspace named "dev.co" if
 * the slug ever changes) — every other workspace is untouched, and running this against a
 * workspace with no Dev.co match is a no-op, not an error.
 *
 * Idempotent: a play that already exists (by slug, in the Dev.co workspace) is left exactly as it
 * is — this never overwrites an edit an admin already made on the Outbound Engine page. Safe to
 * run again after a deploy.
 *
 * Campaign fields are seeded as NAMES (DEV-01-SAAS-V1, DEV-01-LI-V1, ...), matching the exact
 * by-name convention outbound-email.ts/outbound-linkedin.ts fall back to when a play has no
 * resolved campaign id yet — once Instantly/Aimfox are connected for this workspace, the first run
 * resolves each name to a real id, or an admin can pick it directly from the dropdown on the
 * Outbound Engine page.
 *
 * Usage:
 *   node scripts/seed-devco-plays.mjs
 *   DATABASE_URL=postgres://... node scripts/seed-devco-plays.mjs   (if not already in the env)
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// Production's slug is "devco"; "dev-co" kept in case it is ever recreated with a hyphen.
const DEVCO_WORKSPACE_SLUGS = ["devco", "dev-co"];
const DEVCO_WORKSPACE_NAME = "dev.co";

const PLAYS = [
  {
    slug: "DEV-01",
    name: "SaaS Engineering Capacity",
    config: {
      icp: {
        titles: ["CTO", "VP Engineering", "Head of Engineering", "VP of Engineering", "Founder"],
        seniorities: [],
        departments: [],
        employeeRanges: ["51,500"],
        industries: ["B2B SaaS", "software"],
        geographies: ["United States", "Canada"],
        technologies: [],
        exclusions: [],
      },
      serviceOffer: "Supplemental development pod — flexible capacity without permanent headcount. For B2B SaaS/software companies, 50-500 employees, roughly $10M-$250M estimated revenue.",
      proofPoints: [
        "5+ open engineering roles, engineering headcount grew 10%+ in the past 12 months, recent Series A-C funding, a new CTO under 6 months, a product launch, or a tech migration are all signals worth leading with.",
      ],
      scoringWeights: {},
      routingThresholds: { emailAndLinkedin: 80, emailOnly: 65, watchlist: 50 },
      instantlyCampaignName: "DEV-01-SAAS-V1",
      aimfoxCampaignName: "DEV-01-LI-V1",
      autoAdvance: true,
      dailySourcingCap: 30,
    },
  },
  {
    slug: "DEV-02",
    name: "Agency White-Label Fulfillment",
    config: {
      icp: {
        titles: ["CEO", "Owner", "Founder", "Head of Operations", "Managing Director"],
        seniorities: [],
        departments: [],
        employeeRanges: ["11,200"],
        industries: ["marketing agency", "creative agency", "digital agency"],
        geographies: ["United States", "Canada", "United Kingdom"],
        technologies: [],
        exclusions: [],
      },
      serviceOffer: "Invisible white-label development partner — extend capacity, keep the client relationship. For marketing/creative/digital agencies, 10-200 employees.",
      proofPoints: [
        "New client wins published, project manager job postings (a delivery-demand signal), service-line expansion, or case studies added within the last 90 days are all worth leading with.",
      ],
      scoringWeights: {},
      routingThresholds: { emailAndLinkedin: 80, emailOnly: 65, watchlist: 50 },
      instantlyCampaignName: "DEV-02-AGENCY-V1",
      aimfoxCampaignName: "DEV-02-LI-V1",
      autoAdvance: true,
      dailySourcingCap: 30,
    },
  },
  {
    slug: "DEV-03",
    name: "PE-Backed Modernization",
    config: {
      icp: {
        titles: ["CTO", "CIO", "VP Engineering", "CEO", "Chief Information Officer"],
        seniorities: [],
        departments: [],
        employeeRanges: ["101,2000"],
        industries: [],
        geographies: ["United States", "Canada"],
        technologies: [],
        exclusions: [],
      },
      serviceOffer: "Development/modernization team — accelerate the transformation roadmap. For PE-backed portfolio companies, 100-2000 employees, any industry with visible technical complexity/debt.",
      proofPoints: [
        "A PE acquisition announced within the last 18 months, a platform company making add-on acquisitions, \"digital transformation\" language, a legacy tech stack showing up in job postings, or open cloud architect/DevOps roles are all worth leading with.",
      ],
      scoringWeights: {},
      routingThresholds: { emailAndLinkedin: 80, emailOnly: 65, watchlist: 50 },
      instantlyCampaignName: "DEV-03-PE-V1",
      aimfoxCampaignName: "DEV-03-LI-V1",
      autoAdvance: true,
      dailySourcingCap: 30,
    },
  },
];

async function main() {
  const workspace =
    (await prisma.workspace.findFirst({ where: { slug: { in: DEVCO_WORKSPACE_SLUGS } } })) ??
    (await prisma.workspace.findFirst({ where: { name: { equals: DEVCO_WORKSPACE_NAME, mode: "insensitive" } } }));

  if (!workspace) {
    console.log(`No workspace found (slug ${DEVCO_WORKSPACE_SLUGS.join("/")} or name "${DEVCO_WORKSPACE_NAME}") — nothing to seed.`);
    return;
  }

  console.log(`Seeding Dev.co plays into workspace ${workspace.id} (${workspace.name} / ${workspace.slug})`);

  for (const play of PLAYS) {
    const existing = await prisma.outboundPlay.findUnique({
      where: { workspaceId_slug: { workspaceId: workspace.id, slug: play.slug } },
    });
    if (existing) {
      console.log(`  ${play.slug}: already exists — left untouched.`);
      continue;
    }
    await prisma.outboundPlay.create({
      data: {
        workspaceId: workspace.id,
        slug: play.slug,
        name: play.name,
        enabled: true,
        config: play.config,
      },
    });
    console.log(`  ${play.slug}: created ("${play.name}").`);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
