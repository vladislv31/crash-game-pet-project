# 0010. Containerization

- **Status:** Accepted
- **Date:** 2026-11-23

## Context

The apps so far run only on the host through npm scripts. Every deployment target ahead (a VM, a container service, Kubernetes) and the CI pipeline run images, not source trees. An image built once from a commit must run the same everywhere, carry no secrets, and stop cleanly: the game server finishes the current round's work on SIGTERM (`enableShutdownHooks`), and a kill mid-round is what experiment 3 provokes on purpose, not what a routine deploy should do.

The repository is an npm workspaces monorepo with one `package-lock.json` at the root and a types-only `@crash/contracts` package.

## Decision

- **One image per app:** `game-server`, `load-generator`, `web`. Each app has its `Dockerfile` in its own folder; the build context is the repository root, so the root lockfile and `tsconfig.base.json` are available: `docker build -f apps/game-server/Dockerfile .`.
- **Base image `node:24-slim`** (Debian, glibc), the major version from `.nvmrc`.
- **Multi-stage builds:** a `deps` stage copies only the package manifests, so dependency installation is cached until a manifest changes; a `build` stage installs all dependencies of the app and compiles it; the `runtime` stage installs production dependencies only and copies the compiled output. Compilers, tests and sources stay out of the final image.
- **The process runs as the unprivileged `node` user and is PID 1:** `CMD ["node", "dist/main"]`, not an npm script, so SIGTERM reaches the app directly.
- **Configuration only through environment variables.** `.env` files never enter the build context (`.dockerignore`); the server already reads `.env` only when the file exists. The commit is baked in at build time (`--build-arg COMMIT_HASH=...`) and appears in every log line (ADR-0005).
- **Logs go to stdout** as today; collecting them is the platform's job.
- **No `HEALTHCHECK` in the image.** Each orchestrator defines its own probe against `GET /health`, and the slim image carries no HTTP client to call it with.
- **Migrations still run on server start.** Fine for one instance; with several replicas starting at once they race, so this is revisited when the server is deployed with more than one replica.

## Alternatives

- **`node:24-alpine`:** smaller, but musl libc occasionally breaks native modules and behaves differently from the glibc the code is developed against.
- **Distroless:** smaller attack surface, but no shell to look inside a running container while the deployment is being learned; worth revisiting once it is stable.
- **One image for all apps:** fewer builds, but every app would ship the others' dependencies, and they are deployed and scaled separately.
- **Building on the host and copying `dist` into the image:** faster locally, but the result depends on the host's Node and `node_modules` and is not reproducible in CI.

## Consequences

- A changed manifest of any workspace invalidates the dependency layer of every image, since `npm ci` needs all manifests to match the lockfile.
- `serviceVersion` in logs comes from `npm_package_version`, which only npm sets; under `node dist/main` it reads `unknown`. `commitHash` identifies the build instead.
- Images are the unit that CI builds and every later deployment step consumes.
