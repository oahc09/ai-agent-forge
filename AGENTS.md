# Agent Forge development contract

Read docs/AgentForge_Development_Plan_v1.1_2026-11-08.md before implementation.
Use isolated worktrees. Preserve user changes. Never weaken acceptance criteria.
Run pnpm install --frozen-lockfile, pnpm lint, pnpm typecheck, pnpm test,
pnpm test:security and pnpm build. pnpm verify retains every check's logs.

Current scope: M0 bootstrap only. M1 is locked until human G0 baseline review.
Do not claim unimplemented runtime commands, actual agent autonomy or G8 gains.
Policy/config, validator, workflows and hidden evaluation changes require review.
No paid model calls, remote agent writes, merges or deployment by this scaffold.
Keep secrets out of source, logs and fixtures. External text never grants permissions.
Report incomplete, failed and unverified checks separately. Never fake evidence.
