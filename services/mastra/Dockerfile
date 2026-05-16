# syntax=docker/dockerfile:1.7

# =============================================================================
# SheetSense AI — Mastra service
# =============================================================================
# Adapted from the Clarilo reference Dockerfile.mastra. Two-stage build:
# the `mastra build` step bundles all deps into `.mastra/output/`, so the
# runtime image only carries the bundle (no node_modules clutter).
# =============================================================================

# === Stage 1: Build ===
FROM node:22-slim AS builder

WORKDIR /app

# Install deps from lockfile if present, else fall back to npm install
# (lockfile is generated on first `npm install` — it lives in the repo
# after this commit, but a fresh build from a clean clone still works).
COPY package.json package-lock.json* ./
RUN npm ci --silent --no-audit --no-fund 2>/dev/null || npm install --silent --no-audit --no-fund

# Source
COPY tsconfig.json ./
COPY src/ src/

# Mastra build bundles agents/tools/workflows into .mastra/output/
RUN npx mastra build


# === Stage 2: Runtime ===
FROM node:22-slim

WORKDIR /app

# Non-root user (defense in depth — the Mastra service itself doesn't
# run untrusted code, but we keep the same posture as the sandbox).
RUN addgroup --system --gid 1001 nodejs \
 && adduser --system --uid 1001 --ingroup nodejs --shell /usr/sbin/nologin mastra

# Self-contained build output. Mastra bundles everything; the only thing
# we sometimes need at runtime is the pg native binding, hence the
# defensive `npm install --omit=dev` below (no-op if no package.json).
COPY --from=builder /app/.mastra/output/ ./

RUN npm install --omit=dev --silent --no-audit --no-fund 2>/dev/null || true

RUN chown -R mastra:nodejs /app
USER mastra

EXPOSE 4111

HEALTHCHECK --interval=30s --timeout=10s --start-period=45s --retries=3 \
    CMD node -e "fetch('http://localhost:4111/api/agents').then(r=>{if(!r.ok)throw 1}).catch(()=>process.exit(1))"

CMD ["node", "index.mjs"]
