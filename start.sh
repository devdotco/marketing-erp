#!/bin/sh

echo "[start] DATABASE_URL prefix: $(echo $DATABASE_URL | cut -c1-40)..."
echo "[start] Running database migrations..."

# Fail, loudly, rather than serve against a schema that does not match.
#
# This used to warn and carry on. On 2026-09-04 a full disk made the migration
# fail, the app started anyway, and it served for hours with a column missing —
# surfacing as a login bug two hours later, in a different application, with
# nothing pointing back here. A failed deploy is a worse minute and a much
# better hour: Coolify marks it failed and the previous container keeps serving.
if ! node /app/node_modules/prisma/build/index.js migrate deploy 2>&1; then
  echo "[start] FATAL: migrations failed — refusing to start against an unknown schema"
  exit 1
fi

echo "[start] Starting BullMQ worker..."
node /app/worker.js &
WORKER_PID=$!
echo "[start] Worker started (PID $WORKER_PID)"

echo "[start] Starting Next.js server..."
exec node server.js
