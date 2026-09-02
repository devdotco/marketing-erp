#!/bin/sh

echo "[start] DATABASE_URL prefix: $(echo $DATABASE_URL | cut -c1-40)..."
echo "[start] Running database migrations..."

# Run migrations but don't crash the container if they fail
node /app/node_modules/.bin/prisma migrate deploy 2>&1 || {
  echo "[start] WARNING: migrations failed or already up to date, continuing..."
}

echo "[start] Starting Next.js server..."
exec node server.js
