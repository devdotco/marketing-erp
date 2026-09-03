#!/bin/sh

echo "[start] DATABASE_URL prefix: $(echo $DATABASE_URL | cut -c1-40)..."
echo "[start] Running database migrations..."

node /app/node_modules/prisma/build/index.js migrate deploy 2>&1 || {
  echo "[start] WARNING: migrations failed, continuing anyway..."
}

echo "[start] Starting BullMQ worker..."
node /app/worker.js &
WORKER_PID=$!
echo "[start] Worker started (PID $WORKER_PID)"

echo "[start] Starting Next.js server..."
exec node server.js
