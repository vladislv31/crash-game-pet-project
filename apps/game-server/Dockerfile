# syntax=docker/dockerfile:1
# Build from the repository root (ADR-0010):
#   docker build -f apps/game-server/Dockerfile --build-arg COMMIT_HASH=$(git rev-parse --short HEAD) -t crash/game-server .
ARG NODE_VERSION=24

FROM node:${NODE_VERSION}-slim AS deps
WORKDIR /app
# npm ci checks the whole lockfile, so every workspace manifest is needed, not only this app's.
COPY package.json package-lock.json ./
COPY packages/contracts/package.json packages/contracts/
COPY apps/game-server/package.json apps/game-server/
COPY apps/load-generator/package.json apps/load-generator/
COPY apps/web/package.json apps/web/

FROM deps AS build
RUN --mount=type=cache,target=/root/.npm npm ci --workspace game-server --include-workspace-root
COPY tsconfig.base.json ./
COPY packages/contracts packages/contracts
COPY apps/game-server apps/game-server
RUN npm run build --workspace game-server

FROM deps AS runtime
ENV NODE_ENV=production
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev --workspace game-server
COPY --from=build /app/apps/game-server/dist apps/game-server/dist
# Late, so a new commit does not invalidate the dependency layer above.
ARG COMMIT_HASH=unknown
ENV COMMIT_HASH=${COMMIT_HASH}
USER node
WORKDIR /app/apps/game-server
EXPOSE 3000
# node itself is PID 1, so SIGTERM reaches Nest's shutdown hooks; npm would not forward it.
CMD ["node", "dist/main"]
