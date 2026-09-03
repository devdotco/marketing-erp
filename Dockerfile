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
RUN npm run build

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

# BullMQ and its dependencies aren't included in Next.js standalone output
# because they're only used in the worker (not imported by any Next.js page).
# We copy them explicitly so `node worker.js` can resolve them.
COPY --from=builder /app/node_modules/bullmq ./node_modules/bullmq
COPY --from=builder /app/node_modules/ioredis ./node_modules/ioredis
COPY --from=builder /app/node_modules/@ioredis ./node_modules/@ioredis
COPY --from=builder /app/node_modules/cluster-key-slot ./node_modules/cluster-key-slot
COPY --from=builder /app/node_modules/redis-errors ./node_modules/redis-errors
COPY --from=builder /app/node_modules/redis-parser ./node_modules/redis-parser
COPY --from=builder /app/node_modules/standard-as-callback ./node_modules/standard-as-callback
COPY --from=builder /app/node_modules/denque ./node_modules/denque

RUN chmod +x start.sh
RUN chown -R nextjs:nodejs /app

USER nextjs

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

CMD ["./start.sh"]
