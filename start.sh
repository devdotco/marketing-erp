#!/bin/sh
set -e

echo "[start] Running database migrations..."
npx prisma migrate deploy

echo "[start] Starting Next.js server..."
exec node server.js
