#!/bin/sh

set -eu

echo "Running Prisma migrations..."
cd /app/web
npx --no-install prisma migrate deploy
cd /app

exec node web/server.js
