# syntax=docker/dockerfile:1

# Stage 1: Install dependencies
FROM node:22-alpine AS deps
WORKDIR /app

# Install pnpm (pinned to match dev environment)
RUN npm install -g pnpm@10.32.1

# Copy root workspace files
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY web/package.json ./web/
COPY web/prisma ./web/prisma/

# Approve build scripts for native dependencies and install
RUN printf 'onlyBuiltDependencies[]=@parcel/watcher\nonlyBuiltDependencies[]=@prisma/engines\nonlyBuiltDependencies[]=@swc/core\nonlyBuiltDependencies[]=esbuild\nonlyBuiltDependencies[]=msw\nonlyBuiltDependencies[]=prisma\nonlyBuiltDependencies[]=sharp\n' > .npmrc \
    && pnpm install --filter ./web --frozen-lockfile

# Stage 2: Build the application
FROM node:22-alpine AS builder
WORKDIR /app

RUN npm install -g pnpm@10.32.1

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/web/node_modules ./web/node_modules
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY web ./web

# Set environment variables for build
ARG NEXT_PUBLIC_APP_VERSION=dev
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production
ENV NEXT_PUBLIC_APP_VERSION=$NEXT_PUBLIC_APP_VERSION
# Build-time placeholders (overridden at runtime)
ENV BETTER_AUTH_URL=http://localhost:3000
ENV BETTER_AUTH_SECRET=build-time-placeholder-secret-key
ENV DATABASE_URL=postgresql://build:build@localhost:5432/build

# Build the application
WORKDIR /app/web
RUN pnpm build

# Stage 3: Database migration runner (lightweight, only Prisma CLI)
FROM node:22-alpine AS migrate
WORKDIR /app

RUN npm install -g pnpm@10.32.1

# Copy only what Prisma migrate needs
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/web/node_modules ./web/node_modules
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY --from=builder /app/web/package.json ./web/package.json
COPY --from=builder /app/web/prisma ./web/prisma
COPY --from=builder /app/web/prisma.config.ts ./web/prisma.config.ts

WORKDIR /app/web
CMD ["npx", "prisma", "migrate", "deploy"]

# Stage 4: Production runner (minimal, standalone only)
FROM node:22-alpine AS runner
WORKDIR /app

ARG NEXT_PUBLIC_APP_VERSION=dev
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV NEXT_PUBLIC_APP_VERSION=$NEXT_PUBLIC_APP_VERSION
ENV NODE_OPTIONS="--max-old-space-size=512"

# Create non-root user
RUN addgroup --system --gid 1001 nodejs \
    && adduser --system --uid 1001 nextjs

# Copy standalone server output (includes minimal node_modules)
COPY --from=builder --chown=nextjs:nodejs /app/web/.next/standalone ./
# Next serves static assets relative to /app/web/server.js inside standalone
COPY --from=builder --chown=nextjs:nodejs /app/web/.next/static ./web/.next/static
COPY --from=builder --chown=nextjs:nodejs /app/web/public ./web/public

USER nextjs

EXPOSE 3000

ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

CMD ["node", "web/server.js"]
