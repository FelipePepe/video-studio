# Backend image: Express + node:sqlite API, started with tsx (no compile step).
#
# - The process must run with cwd /app: data/jobs, data/cache and the default
#   DB path are resolved against the cwd, so a volume mounted at /app/data
#   holds every piece of runtime state.
# - tsx is a devDependency, so dev dependencies are installed on purpose.
# - The port is not published by compose; only the web service reaches it.
FROM node:22-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable

# lefthook's postinstall (git hooks) is meaningless inside the image.
ENV LEFTHOOK=0

WORKDIR /app

# Manifests first so the dependency layer is cached until they change.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json

RUN pnpm install --frozen-lockfile --filter @video-studio/backend...

COPY tsconfig.base.json ./
COPY backend backend

# uid 1000 (user "node") matches the host user, so the bind-mounted ./data is writable.
RUN mkdir -p /app/data && chown node:node /app/data

USER node

ENV NODE_ENV=production HOST=0.0.0.0 PORT=3001

EXPOSE 3001

HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
    CMD node -e "fetch('http://127.0.0.1:3001/api/config').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--import", "tsx", "backend/src/server.ts"]
