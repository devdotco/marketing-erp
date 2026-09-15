import { NextRequest, NextResponse } from "next/server";
import { IntegrationProvider } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { googleCredentials, googleScopes } from "@/lib/integrations/google";
import { GOOGLE_RESOURCES, type GoogleResource } from "@/lib/integrations/google-resources";
import { describeGoogleAdsError } from "@/lib/integrations/google-ads";
import { runAccess } from "@/lib/integrations/route-auth";
import { CONNECT_METHODS } from "@/lib/integrations/catalog";

export const dynamic = "force-dynamic";

/**
 * Read-only sibling of ../route.ts, for populating an `integration_resource`
 * Run modal / Configure form dropdown (components/ui/ResourceSelect) rather
 * than the integration connect flow. Gated at runAccess() — the same OPERATOR
 * bar POST /api/runs uses — instead of integrationAdmin(): any workspace
 * member who can start a run can see which property it would use, they just
 * can't change the workspace's saved default here (that stays admin-only, on
 * ../route.ts's POST).
 *
 * Always 200s with a `connected` flag rather than using 404/502 for "not
 * connected" / "listing failed" — those are UI states the dropdown renders
 * inline, not request failures. A malformed/unknown provider is still a real
 * 400.
 */
export async function GET(req: NextRequest) {
  const providerParam = (req.nextUrl.searchParams.get("provider") ?? "").toUpperCase();
  const entry = CONNECT_METHODS[providerParam];
  if (!entry || !googleScopes(providerParam) || !Object.values(IntegrationProvider).includes(providerParam as IntegrationProvider)) {
    return NextResponse.json({ error: "Unknown Google integration" }, { status: 400 });
  }

  const who = await runAccess();
  if (!who.ok) return NextResponse.json({ error: who.error }, { status: who.status });

  const connectUrl = `/integrations/connect/${providerParam.toLowerCase()}`;
  const providerLabel = entry.name;

  const integration = await prisma.integration.findUnique({
    where: { workspaceId_provider: { workspaceId: who.workspaceId, provider: providerParam as IntegrationProvider } },
  });
  if (!integration) {
    return NextResponse.json({ connected: false, connectUrl, providerLabel });
  }

  const resource = GOOGLE_RESOURCES[providerParam] ?? null;
  if (!resource) {
    // Connected, but this provider has no resource picker at all (nothing in
    // GOOGLE_RESOURCES for it) — not expected for the providers this field
    // type targets, but handled rather than assumed away.
    return NextResponse.json({ connected: true, noun: null, options: null, selected: null, providerLabel });
  }

  try {
    const creds = (await googleCredentials(integration)) as Parameters<GoogleResource["selected"]>[0];
    const options = await resource.list(creds.access_token);
    return NextResponse.json({
      connected: true,
      noun: resource.noun,
      options,
      selected: resource.selected(creds),
      providerLabel,
    });
  } catch (err) {
    // Connected, but the live call failed (revoked grant, deleted property,
    // developer token missing, ...). Still 200 — the dropdown shows the error
    // inline and the run falls back to the integration's saved default rather
    // than being blocked on a listing failure.
    return NextResponse.json({
      connected: true,
      error: describeGoogleAdsError(err),
      providerLabel,
    });
  }
}
