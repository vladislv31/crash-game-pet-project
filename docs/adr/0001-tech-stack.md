# 0001. Tech stack

- **Status:** Accepted
- **Date:** 2026-10-12

## Context

We need a real-time multiplayer game that can be load-tested, scaled horizontally, and observed. It also has to be close to what iGaming backends use in production.

## Decision

| Area            | Choice                                                                                                  |
| --------------- | ------------------------------------------------------------------------------------------------------- |
| Language        | TypeScript (strict), Node.js 22                                                                         |
| Repo            | npm workspaces monorepo: `apps/game-server`, `apps/web`, `apps/load-generator`, `packages/contracts`    |
| Server          | NestJS                                                                                                  |
| WebSocket       | Raw `ws` (no Socket.IO): less overhead and full control, which matters for connection-limit experiments |
| DB              | PostgreSQL + TypeORM (migrations via CLI)                                                               |
| Cache / bus     | Redis: pub/sub for broadcast, locks for round leader                                                    |
| Frontend        | React + Vite (player UI + test dashboard in one app)                                                    |
| Load generation | Custom Node bot runner (controlled from the dashboard); k6 as a second opinion                          |
| Metrics         | prom-client → Prometheus → Grafana                                                                      |
| Load balancer   | nginx (or HAProxy) in docker-compose                                                                    |
| Tests           | Jest                                                                                                    |
| Auth            | Fake auth: username → token, no passwords                                                               |

## Alternatives

- Socket.IO: rooms and reconnect for free, but it adds protocol overhead and hides what we want to learn.
- Fastify + plain ws instead of NestJS: lighter and more "bare metal", but further from typical iGaming codebases.
- Prisma instead of TypeORM: nicer DX, weaker control over locking and raw transactions.
