                    # ── stage 1: build frontend ──────────────────────────────────────────────────
FROM node:24-slim AS frontend-build
WORKDIR /app

# Install frontend dependencies before copying sources so code-only changes can
# reuse the dependency layer.
COPY frontend/package.json frontend/package-lock.json frontend/
RUN cd frontend && npm ci --omit=dev
COPY frontend/ frontend/
RUN cd frontend && npm run build

# ── stage 2: production runtime ─────────────────────────────────────────────
FROM node:24-slim
WORKDIR /app

# better-sqlite3 needs build tools
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

# Install backend deps only
COPY backend/package.json backend/package-lock.json backend/
RUN cd backend && npm ci --omit=dev

# Copy backend source
COPY backend/*.js backend/
COPY backend/swim/ backend/swim/
COPY backend/data/ backend/data/
# v5.0.0+ — correlation layer + feed scoring subsystems
COPY backend/context/ backend/context/
COPY backend/feed/ backend/feed/
# Shared FAA registry job module (startup self-heal + weekly refresh)
# and CLI ingest script (fly ssh console one-shot).
COPY backend/jobs/ backend/jobs/
COPY backend/scripts/ backend/scripts/

# Copy built frontend from stage 1
COPY --from=frontend-build /app/frontend/dist frontend/dist

# SQLite data lives on a Fly volume mounted at /data
ENV DB_DIR=/data
ENV PORT=3001

EXPOSE 3001

CMD ["node", "backend/index.js"]
