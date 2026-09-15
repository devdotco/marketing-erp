import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { ReplayGuard } from "./verify";

/**
 * Database-backed, single-use acceptance of signed shell events. The primary
 * key is the guard: a second insert of the same jti fails on the constraint, so
 * two requests racing with one captured token cannot both be applied.
 */
export function dbReplayGuard(namespace: "shell"): ReplayGuard {
  return {
    async claim(jti, expiresAt) {
      if (Math.random() < 0.02) {
        void prisma.signedRequestReceipt
          .deleteMany({ where: { expiresAt: { lt: new Date(Date.now() - 60_000) } } })
          .catch(() => {});
      }
      try {
        await prisma.signedRequestReceipt.create({ data: { jti: `${namespace}:${jti}`, expiresAt } });
        return true;
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return false;
        throw err;
      }
    },
  };
}
