# Web image: builds the React SPA and serves it with nginx, which also
# reverse-proxies /api/ to the backend service (see docker/nginx.conf).

FROM node:22-slim AS build

RUN corepack enable

# lefthook's postinstall (git hooks) is meaningless inside the image.
ENV LEFTHOOK=0

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json

RUN pnpm install --frozen-lockfile --filter @video-studio/frontend...

COPY tsconfig.base.json ./
COPY frontend frontend

RUN pnpm --filter @video-studio/frontend build

FROM nginx:1.27-alpine

# Replace the stock default server block.
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/frontend/dist /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=15s --timeout=5s --start-period=5s --retries=3 \
    CMD wget -qO- http://127.0.0.1/ >/dev/null || exit 1
