# ADR 0001: M0 bootstrap technical baseline

Status: proposed for human G0 review, 2026-11-08.

Repository: https://github.com/oahc09/ai-agent-forge, default main.
Initial checkout d5f4fa53aeae23f484cc06f2d4387d8f7fdf9d76 contained LICENSE only;
working tree was clean, no repository AGENTS or local skills existed.
Authenticated repository access reported push/admin. Existing LICENSE preserved.
Changes use feat/m0-foundation in a separate worktree; no main merge or deploy.

Node 24.22.1 LTS, pnpm 11.25.0, TypeScript strict + ESM; versions and lockfile pinned.
Vitest exercises unit/security/CLI integration. ESLint enforces TypeScript lint rules.
M0 has no production dependencies, provider SDKs or model consumption.
JSON (a YAML-compatible subset) is used for machine configs/backlog to avoid a YAML parser
in this minimal bootstrap. Existing plan remains authoritative and unchanged.

M1 proposes built-in node:sqlite with WAL and transactional projections, but this ADR
must be reviewed before M1 starts. M0 does not implement event persistence, scheduling,
sandbox, grant issuance, real execution adapters or autonomous development.

Install uses registry packages with lock integrity and scripts disabled during bootstrap.
Linux is the initial supported verification platform; macOS/Windows unverified.
Promotion, merge, paid providers and active remote authorization remain disabled.
