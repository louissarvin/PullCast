# PullCast backend — Fastify + Prisma + Discord bot + 4 cron workers on Bun.
# Two-stage build so the final image is small and doesn't ship dev deps.

# ─── Stage 1: builder ─────────────────────────────────────────────────────────
FROM oven/bun:1.1-debian AS builder

# System deps:
#   - openssl: required by Prisma at runtime for TLS to Postgres
#   - libc6, libstdc++6: required by @resvg/resvg-js native binding (share card render)
#   - ca-certificates: required for HTTPS to Renaiss + Discord + Groq
RUN apt-get update -y \
    && apt-get install -y --no-install-recommends \
        openssl \
        libc6 \
        libstdc++6 \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app

# Install deps first (Docker cache layer) — copy only manifest + lockfile
COPY package.json bun.lockb* ./

# Full install (includes devDeps we need for prisma CLI + tsc)
RUN bun install --frozen-lockfile || bun install

# Copy Prisma schema BEFORE `bun run db:generate` so the generator has the file
COPY prisma ./prisma

# Generate Prisma client (writes to prisma/generated/)
RUN bunx prisma generate --config prisma/prisma.config.ts

# Copy the rest of the source
COPY . .

# ─── Stage 2: runtime ─────────────────────────────────────────────────────────
FROM oven/bun:1.1-debian AS runtime

# Same runtime deps — no dev tools, no build tools.
RUN apt-get update -y \
    && apt-get install -y --no-install-recommends \
        openssl \
        libc6 \
        libstdc++6 \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV APP_PORT=3700

WORKDIR /usr/src/app

# Copy the fully-built app from the builder stage
COPY --from=builder /usr/src/app ./

# Drop privileges — the oven/bun image ships a non-root `bun` user
RUN chown -R bun:bun /usr/src/app
USER bun

# Fastify listens on APP_PORT (defaults to 3700). Railway/Fly bind this.
EXPOSE 3700

# Bun runs TypeScript natively — no build step, no dist folder
CMD ["bun", "index.ts"]
