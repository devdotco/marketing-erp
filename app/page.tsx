import { getServerSession } from "@/lib/session";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { SHELL_SESSION_COOKIE, shellHandoffUrl } from "@/lib/shell-handoff";

/**
 * The bare mount: `app.erp.io/marketing`, with nothing after it.
 *
 * Next does not run `proxy.ts` — where the SSO fast path otherwise lives — for
 * this exact URL (see erp-io-bare-mount-no-middleware: the app switcher links
 * here directly, and every other page under `/marketing/*` is a "deeper path"
 * the proxy does see). So the same fast path has to be duplicated here, or a
 * suite user with a live shell session but no Marketing session falls straight
 * through to the public `/start` sign-up page instead of being handed off
 * silently — which is the bug this page existed to cause.
 *
 * Guarded on there being no `error`/`reason` query param for the same reason
 * proxy.ts is: a refused hand-off must never auto-retry into a loop. (In
 * practice nothing redirects back to this exact bare path with either param —
 * the shell's mint sends refusals to its own pages, and this app's callback
 * failures land on `/login` — but the guard is free and matches the pattern
 * used estate-wide.)
 */
export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await getServerSession();
  if (session?.user) redirect("/agents");

  const params = await searchParams;
  const alreadyTried = params.error !== undefined || params.reason !== undefined;
  const shellCookie = (await cookies()).get(SHELL_SESSION_COOKIE)?.value;
  if (shellCookie && !alreadyTried) {
    redirect(shellHandoffUrl("/").toString());
  }

  redirect("/start");
}
