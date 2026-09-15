import { jwtVerify, type JWTVerifyGetKey, type KeyObject, type CryptoKey } from "jose";
import {
  MIRROR_AUDIENCE,
  MIRROR_JWT_TYPE,
  MIRROR_MAX_TTL_SECONDS,
  MIRROR_SUBJECT,
  MirrorPayloadError,
  parseEvent,
  parseSnapshot,
  type MirrorEvent,
  type MirrorSnapshot,
} from "./protocol";

export type VerificationKey = CryptoKey | KeyObject | Uint8Array | JWTVerifyGetKey;

export type VerifiedMirror =
  | { kind: "event"; jti: string; expiresAt: Date; event: MirrorEvent }
  | { kind: "snapshot"; jti: string; expiresAt: Date; snapshot: MirrorSnapshot };

/**
 * Verify a shell mirror JWT: the shell's signature, `aud=marketing`, the
 * shell's issuer name, `typ=erp-mirror+jwt` (so a hand-off token cannot be
 * posted as an event), unexpired with a bounded lifetime, a jti to guard replay,
 * no bearer email (so an event can never be redeemed as a sign-in), and exactly
 * one well-formed event or snapshot. Key and issuer are injected for tests.
 */
export async function verifyMirrorToken(
  token: string,
  key: VerificationKey,
  issuer: string,
  now = new Date(),
): Promise<VerifiedMirror> {
  const { payload, protectedHeader } = await jwtVerify(token, key as Parameters<typeof jwtVerify>[1], {
    audience: MIRROR_AUDIENCE,
    issuer,
    algorithms: ["EdDSA"],
    typ: MIRROR_JWT_TYPE,
    subject: MIRROR_SUBJECT,
    currentDate: now,
    clockTolerance: 5,
  });
  if (protectedHeader.typ !== MIRROR_JWT_TYPE) throw new MirrorPayloadError("wrong token type");
  if (typeof payload.jti !== "string" || !payload.jti) throw new MirrorPayloadError("missing jti");
  if (typeof payload.exp !== "number" || typeof payload.iat !== "number") throw new MirrorPayloadError("missing iat/exp");
  if (payload.exp - payload.iat > MIRROR_MAX_TTL_SECONDS) throw new MirrorPayloadError("lifetime too long");
  if ("email" in payload) throw new MirrorPayloadError("a mirror payload never names a person as its bearer");

  const expiresAt = new Date(payload.exp * 1000);
  const hasEvt = "evt" in payload;
  const hasSnap = "snap" in payload;
  if (hasEvt === hasSnap) throw new MirrorPayloadError("expected exactly one of evt or snap");
  return hasEvt
    ? { kind: "event", jti: payload.jti, expiresAt, event: parseEvent(payload.evt) }
    : { kind: "snapshot", jti: payload.jti, expiresAt, snapshot: parseSnapshot(payload.snap) };
}

export interface ReplayGuard {
  claim(jti: string, expiresAt: Date): Promise<boolean>;
}

export function memoryReplayGuard(): ReplayGuard {
  const seen = new Map<string, number>();
  return {
    async claim(jti, expiresAt) {
      const now = Date.now();
      for (const [k, exp] of seen) if (exp < now) seen.delete(k);
      if (seen.has(jti)) return false;
      seen.set(jti, expiresAt.getTime());
      return true;
    },
  };
}
