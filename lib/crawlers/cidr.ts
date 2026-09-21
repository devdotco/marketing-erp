/**
 * IP-in-CIDR matching, for both families.
 *
 * This exists because "verified crawler" is a claim we make to a customer, and
 * a matcher that is quietly wrong makes it confidently. The naive version —
 * string-prefix comparison — passes every test someone writes by hand and then
 * says 10.1.2.3 is inside 10.1.2.0/24 and also inside 10.1.20.0/24.
 *
 * Both families are normalised to a BigInt and compared under a mask, so /17
 * and /119 work the same as /24 and /64. (BigInt(n) rather than the nicer `n`
 * literal throughout: this repo targets ES2017, where the literal form is a
 * compile error.) IPv6 handles "::" compression and the
 * IPv4-mapped form (::ffff:1.2.3.4), which is how an IPv4 address often
 * arrives from a dual-stack edge.
 */

export interface Cidr {
  base: bigint;
  bits: number;
  /** 4 or 6. A v4 address is never inside a v6 range, or vice versa. */
  family: 4 | 6;
}

/** Parse "1.2.3.0/24" or "2600:1f18::/32". Returns null for anything malformed. */
export function parseCidr(input: string): Cidr | null {
  const [addr, prefix] = input.trim().split("/");
  if (!addr || prefix === undefined) return null;

  const parsed = parseIp(addr);
  if (!parsed) return null;

  const bits = Number(prefix);
  const max = parsed.family === 4 ? 32 : 128;
  if (!Number.isInteger(bits) || bits < 0 || bits > max) return null;

  // Normalise the base: a range written as 1.2.3.4/24 means 1.2.3.0/24, and
  // treating the host bits as significant would reject every address in it.
  return { base: applyMask(parsed.value, bits, max), bits, family: parsed.family };
}

export function parseIp(input: string): { value: bigint; family: 4 | 6 } | null {
  const addr = input.trim();
  if (!addr) return null;

  if (addr.includes(":")) {
    const v6 = parseIpv6(addr);
    return v6 === null ? null : { value: v6, family: 6 };
  }
  const v4 = parseIpv4(addr);
  return v4 === null ? null : { value: v4, family: 4 };
}

export function ipInCidr(ip: string, cidr: Cidr): boolean {
  const parsed = parseIp(ip);
  if (!parsed) return false;

  // An IPv4-mapped v6 address is the same host as its v4 form. Compare it as
  // v4 so a v4 range still matches when the edge hands us ::ffff:1.2.3.4.
  let value = parsed.value;
  let family = parsed.family;
  if (family === 6 && value >= V4_MAPPED_BASE && value <= V4_MAPPED_MAX) {
    value = value - V4_MAPPED_BASE;
    family = 4;
  }

  if (family !== cidr.family) return false;
  const max = family === 4 ? 32 : 128;
  return applyMask(value, cidr.bits, max) === cidr.base;
}

export function ipInAny(ip: string, cidrs: Cidr[]): boolean {
  return cidrs.some((c) => ipInCidr(ip, c));
}

const V4_MAPPED_BASE = BigInt(0xffff) << BigInt(32);
const V4_MAPPED_MAX = V4_MAPPED_BASE + BigInt(0xffffffff);

function applyMask(value: bigint, bits: number, max: number): bigint {
  if (bits === 0) return BigInt(0);
  const hostBits = BigInt(max - bits);
  return (value >> hostBits) << hostBits;
}

function parseIpv4(addr: string): bigint | null {
  const parts = addr.split(".");
  if (parts.length !== 4) return null;
  let value = BigInt(0);
  for (const part of parts) {
    // Reject "01" and "1e2" and "" — Number() is far too permissive here, and
    // a leading zero is octal in some resolvers and decimal in others.
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = (value << BigInt(8)) | BigInt(octet);
  }
  return value;
}

function parseIpv6(addr: string): bigint | null {
  let text = addr;

  // A trailing IPv4 part (::ffff:1.2.3.4) becomes two hextets.
  const v4Match = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (v4Match) {
    const v4 = parseIpv4(v4Match[1]);
    if (v4 === null) return null;
    const high = (v4 >> BigInt(16)) & BigInt(0xffff);
    const low = v4 & BigInt(0xffff);
    text = text.slice(0, v4Match.index) + high.toString(16) + ":" + low.toString(16);
  }

  const halves = text.split("::");
  if (halves.length > 2) return null;

  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  if (halves.length === 1 && head.length !== 8) return null;
  if (head.length + tail.length > 8) return null;

  const groups =
    halves.length === 2
      ? [...head, ...Array(8 - head.length - tail.length).fill("0"), ...tail]
      : head;

  let value = BigInt(0);
  for (const group of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
    value = (value << BigInt(16)) | BigInt(parseInt(group, 16));
  }
  return value;
}
