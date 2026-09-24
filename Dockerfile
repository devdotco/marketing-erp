FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

ARG NEXT_PUBLIC_APP_URL=https://marketing.erp.io
ARG NEXT_PUBLIC_DASHBOARD_URL=https://dashboard.erp.io

ENV NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL
ENV NEXT_PUBLIC_DASHBOARD_URL=$NEXT_PUBLIC_DASHBOARD_URL
ENV NEXT_TELEMETRY_DISABLED=1

RUN npx prisma generate
# BUILD_ID becomes `deploymentId` in next.config.ts, which stamps every asset URL
# so a tab running an older build is recognisable as skew. Coolify exposes
# SOURCE_COMMIT to the RUNNING container but does NOT pass it as a build arg, so
# it is used when present and falls back to a timestamp. `:-` not `-`, because an
# empty arg would otherwise be taken as a real value and stamp nothing.
ARG SOURCE_COMMIT
RUN BUILD_ID="${SOURCE_COMMIT:-$(date +%s)}" npm run build

FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN apk add --no-cache openssl && \
    addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=builder /app/node_modules/prisma ./node_modules/prisma
COPY --from=builder /app/node_modules/.bin/prisma ./node_modules/.bin/prisma
COPY --from=builder /app/dist/worker.js ./worker.js
COPY start.sh ./start.sh


RUN chmod +x start.sh
RUN chown -R nextjs:nodejs /app

USER nextjs

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

CMD ["./start.sh"]
