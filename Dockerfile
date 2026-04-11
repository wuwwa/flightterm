                    # ── stage 1: build frontend ──────────────────────────────────────────────────
FROM node:20-slim AS frontend-build
WORKDIR /app

# Copy root package.json (needed by "file:.." dependency)
COPY package.json ./

# Install frontend deps and build
COPY frontend/ frontend/
RUN cd frontend && npm install --omit=dev && npm run build

# ── stage 2: production runtime ─────────────────────────────────────────────
FROM node:20-slim
WORKDIR /app

# better-sqlite3 needs build tools
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

# Copy root package.json
COPY package.json ./

# Install backend deps only
COPY backend/package.json backend/package-lock.json backend/
RUN cd backend && npm ci --omit=dev

# Copy backend source
COPY backend/*.js backend/
COPY backend/swim/ backend/swim/
COPY backend/data/ backend/data/

# Copy built frontend from stage 1
COPY --from=frontend-build /app/frontend/dist frontend/dist

# SQLite data lives on a Fly volume mounted at /data
ENV DB_DIR=/data
ENV PORT=3001

EXPOSE 3001

CMD ["node", "backend/index.js"]
