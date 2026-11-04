"use server";

/**
 * Templates and campaign types for the Email Marketing agent.
 *
 * Editing either is WORKSPACE_ADMIN: a campaign type decides what goes to a
 * whole SendGrid list, the same bar as approving its runs. Starting a draft
 * run is OPERATOR, like "Run now" anywhere else; a draft sends nothing.
 */
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireWorkspaceAccess, resolveWorkspaceId } from "@/lib/actions/workspace";
import { createAgentRun } from "@/lib/agents/create-run";
import { parseTemplate, templateGroups } from "@/lib/email-campaigns/template";
import { htmlProblem } from "@/lib/email-campaigns/checks";
import { isValidTimezone, nextOccurrence, parseLocalDate, parseTime } from "@/lib/email-campaigns/schedule";

export type ActionResult = { ok: true; id?: string; message?: string } | { ok: false; error: string };

const CAMPAIGNS_PATH = "/agents/email-marketing/campaigns";

async function workspaceFor(role: "WORKSPACE_ADMIN" | "OPERATOR") {
  const workspaceId = await resolveWorkspaceId();
  if (!workspaceId) throw new Error("No workspace selected");
  const { session } = await requireWorkspaceAccess(workspaceId, role);
  return { workspaceId, userId: session.user.id as string };
}

function lines(value: FormDataEntryValue | null): string[] {
  return String(value ?? "")
    .split(/[\n,]/)
    .map((v) => v.trim())
    .filter(Boolean);
}

export async function saveEmailTemplate(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  const { workspaceId, userId } = await workspaceFor("WORKSPACE_ADMIN");
  const id = String(form.get("id") ?? "");
  const name = String(form.get("name") ?? "").trim();
  const html = String(form.get("html") ?? "");
  if (!name) return { ok: false, error: "Give the template a name." };
  if (html.length > 400_000) return { ok: false, error: "That HTML is over 400 KB. Email clients clip anything near 100 KB anyway." };

  const parsed = parseTemplate(html);
  if (parsed.errors.length) return { ok: false, error: parsed.errors.join(" ") };
  const broken = htmlProblem(html);
  if (broken) return { ok: false, error: `The HTML is malformed: ${broken}.` };

  if (id) {
    const updated = await prisma.emailTemplate.updateMany({ where: { id, workspaceId }, data: { name, html, updatedBy: userId } });
    if (updated.count !== 1) return { ok: false, error: "Template not found." };
  } else {
    const created = await prisma.emailTemplate.create({ data: { workspaceId, name, html, updatedBy: userId } });
    revalidatePath(CAMPAIGNS_PATH);
    return { ok: true, id: created.id, message: `Saved. ${parsed.sections.length} editable sections in ${templateGroups(parsed).length} groups.` };
  }
  revalidatePath(CAMPAIGNS_PATH);
  return { ok: true, id, message: `Saved. ${parsed.sections.length} editable sections in ${templateGroups(parsed).length} groups.` };
}

export async function deleteEmailTemplate(id: string): Promise<ActionResult> {
  const { workspaceId } = await workspaceFor("WORKSPACE_ADMIN");
  const used = await prisma.emailCampaign.count({ where: { workspaceId, templateId: id } });
  if (used > 0) return { ok: false, error: `${used} campaign type${used === 1 ? " uses" : "s use"} this template. Point ${used === 1 ? "it" : "them"} elsewhere first.` };
  await prisma.emailTemplate.deleteMany({ where: { id, workspaceId } });
  revalidatePath(CAMPAIGNS_PATH);
  return { ok: true };
}

function int(form: FormData, key: string, min: number, max: number, extra: number[] = []): number | null {
  const n = Number(form.get(key));
  return Number.isInteger(n) && ((n >= min && n <= max) || extra.includes(n)) ? n : null;
}

export async function saveEmailCampaign(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  const { workspaceId, userId } = await workspaceFor("WORKSPACE_ADMIN");
  const id = String(form.get("id") ?? "");
  const name = String(form.get("name") ?? "").trim();
  if (!name) return { ok: false, error: "Give the campaign type a name." };

  const templateId = String(form.get("templateId") ?? "");
  const template = await prisma.emailTemplate.findFirst({ where: { id: templateId, workspaceId } });
  if (!template) return { ok: false, error: "Pick a template." };
  const keys = new Set(parseTemplate(template.html).sections.flatMap((s) => [s.key, s.group]));
  const editableSections = form.getAll("editableSections").map(String).filter((k) => keys.has(k));
  if (editableSections.length === 0) return { ok: false, error: "Choose at least one section the agent may change." };

  const changeLevel = String(form.get("changeLevel") ?? "light");
  if (!["light", "moderate", "fresh"].includes(changeLevel)) return { ok: false, error: "Unknown change level." };

  const sourceUrls = lines(form.get("sourceUrls"));
  for (const u of sourceUrls) {
    try {
      if (new URL(u).protocol !== "https:") return { ok: false, error: `${u} must use https.` };
    } catch {
      return { ok: false, error: `${u} is not a full URL.` };
    }
  }
  const notifyEmails = lines(form.get("notifyEmails")).map((e) => e.toLowerCase());
  const badEmail = notifyEmails.find((e) => !/^\S+@\S+\.\S+$/.test(e));
  if (badEmail) return { ok: false, error: `${badEmail} is not an email address.` };

  const sendWeekday = int(form, "sendWeekday", 0, 6);
  const sendNth = int(form, "sendNth", 1, 5, [-1]);
  const draftWeekday = int(form, "draftWeekday", 0, 6);
  if (sendWeekday === null || sendNth === null || draftWeekday === null) return { ok: false, error: "Pick the send week, send day and draft day." };
  const sendTime = String(form.get("sendTime") ?? "").trim();
  const draftTime = String(form.get("draftTime") ?? "").trim();
  const timezone = String(form.get("timezone") ?? "").trim();
  try {
    parseTime(sendTime);
    parseTime(draftTime);
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  if (!isValidTimezone(timezone)) return { ok: false, error: `${timezone} is not an IANA time zone, like America/Denver.` };

  const data = {
    name,
    enabled: form.get("enabled") === "on",
    templateId,
    listIds: form.getAll("listIds").map(String).filter(Boolean),
    segmentIds: form.getAll("segmentIds").map(String).filter(Boolean),
    editableSections,
    changeLevel,
    sourceUrls,
    brief: String(form.get("brief") ?? "").slice(0, 8000),
    monthlyPush: String(form.get("monthlyPush") ?? "").slice(0, 4000),
    sendWeekday,
    sendNth,
    sendTime,
    timezone,
    draftWeekday,
    draftTime,
    notifyEmails,
    updatedBy: userId,
  };

  if (data.enabled && data.listIds.length === 0 && data.segmentIds.length === 0) {
    return { ok: false, error: "An enabled campaign needs a SendGrid list or segment to send to." };
  }

  let savedId = id;
  if (id) {
    const updated = await prisma.emailCampaign.updateMany({ where: { id, workspaceId }, data });
    if (updated.count !== 1) return { ok: false, error: "Campaign type not found." };
  } else {
    savedId = (await prisma.emailCampaign.create({ data: { ...data, workspaceId } })).id;
  }
  revalidatePath(CAMPAIGNS_PATH);
  return { ok: true, id: savedId, message: "Saved." };
}

export async function deleteEmailCampaign(id: string): Promise<ActionResult> {
  const { workspaceId } = await workspaceFor("WORKSPACE_ADMIN");
  await prisma.emailCampaign.deleteMany({ where: { id, workspaceId } });
  revalidatePath(CAMPAIGNS_PATH);
  return { ok: true };
}

/**
 * Draft one send now. With no date it drafts the next send on the calendar;
 * with `test`, it builds for any date, prefixes "[TEST] " and can never be
 * scheduled.
 */
export async function runEmailCampaign(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  const { workspaceId, userId } = await workspaceFor("OPERATOR");
  const campaign = await prisma.emailCampaign.findFirst({ where: { id: String(form.get("campaignId") ?? ""), workspaceId } });
  if (!campaign) return { ok: false, error: "Campaign type not found." };
  const test = form.get("test") === "on";

  let sendDate = String(form.get("sendDate") ?? "").trim();
  if (sendDate && !parseLocalDate(sendDate)) return { ok: false, error: "Use a date like 2026-11-19." };
  if (!sendDate) {
    const next = nextOccurrence(campaign, new Date());
    if (!next) return { ok: false, error: "The calendar has no upcoming send." };
    sendDate = next.sendDate;
  }

  const config = await prisma.agentConfig.findUnique({ where: { workspaceId_agentSlug: { workspaceId, agentSlug: "email-marketing" } } });
  if (!config?.enabled) return { ok: false, error: "Turn the Email Marketing agent on first." };

  const run = await createAgentRun({
    workspaceId,
    agentConfigId: config.id,
    input: { campaignId: campaign.id, sendDate, ...(test ? { test: true } : {}) },
    triggeredBy: userId,
  });
  return { ok: true, id: run.id, message: `Drafting ${campaign.name} for ${sendDate}${test ? " (test)" : ""}.` };
}
