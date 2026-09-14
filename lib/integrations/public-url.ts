/**
 * Guard for URLs a customer typed that the SERVER then fetches with their
 * credentials attached (today: the WordPress site URL, from both the connect
 * verifier and On-site Publisher).
 *
 * Without it a workspace admin could aim our worker at localhost, the Docker
 * network, or the cloud metadata address and read the response back through a
 * failed-run message. Resolves the name and refuses any private, loopback,
 * link-local or otherwise non-public address. Callers also pass
 * `redirect: "error"` so a public host cannot 30x us somewhere private.
 *
 * Server-only (node:dns). Not a full DNS-rebinding defence — the lookup and
 * the fetch resolve separately — but it closes the plain version.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

function privateV4(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number);
  return (
    a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function privateV6(ip: string): boolean {
  const v = ip.toLowerCase();
  if (v === "::" || v === "::1") return true;
  if (v.startsWith("::ffff:")) return privateV4(v.slice(7));
  return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(v);
}

export function isPrivateAddress(ip: string): boolean {
  return isIP(ip) === 4 ? privateV4(ip) : privateV6(ip);
}

/** Throws a customer-legible error unless every address the host resolves to is public. */
export async function assertPublicUrl(raw: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Site URL is not a valid URL");
  }
  if (url.protocol !== "https:") throw new Error("Site URL must use https");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) {
    throw new Error("Site URL must be a public website address");
  }
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true, verbatim: true }).catch(() => []);
  if (addresses.length === 0) throw new Error(`Couldn't find ${host} — check the Site URL`);
  if (addresses.some((a) => isPrivateAddress(a.address))) {
    throw new Error("Site URL must be a public website address");
  }
}
