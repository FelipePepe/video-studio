# Backend image: Express + node:sqlite API, started with tsx (no compile step).
#
# - The process must run with cwd /app/backend: data/jobs, data/cache and the default
#   DB path are resolved against the cwd, so a volume mounted at /app/backend/data
#   holds every piece of runtime state. It also has to be /app/backend because the
#   hoisted installer leaves tsx in backend/node_modules, where `--import tsx` finds it.
# - tsx is a devDependency, so dev dependencies are installed on purpose.
# - The port is not published by compose; only the web service reaches it.
FROM node:22-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable

WORKDIR /app

# Manifests first so the dependency layer is cached until they change.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json

# The root `prepare` script runs `lefthook install`, which needs git (absent here) and is
# meaningless in an image, so install scripts are skipped. esbuild (used by tsx / vite) does not
# need its postinstall: it resolves the native binary from its platform package.
RUN pnpm install --frozen-lockfile --ignore-scripts --filter @video-studio/backend...

COPY tsconfig.base.json ./
COPY backend backend

# uid 1000 (user "node") matches the host user, so the bind-mounted ./data is writable.
RUN mkdir -p /app/backend/data && chown node:node /app/backend/data

USER node

ENV NODE_ENV=production HOST=0.0.0.0 PORT=3001

EXPOSE 3001

HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
    CMD node -e "fetch('http://127.0.0.1:3001/api/config').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

WORKDIR /app/backend

CMD ["node", "--import", "tsx", "src/server.ts"]
