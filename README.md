# Agent Forge

自主研发、多 Agent 融合与可验证自我进化平台，按 [v1.1 计划](docs/AgentForge_Development_Plan_v1.1_2026-11-08.md) 分 Gate 实施。

**当前：M1 已验证、M2 离线 SDK/Context；用户已批准 M3+ 宿主辅助预览，尚非真实自主 Coding Agent。**
提供 strict TypeScript monorepo、拒绝危险配置的离线引导策略、CLI 初始化/诊断、测试及不可覆盖报告框架。没有真实模型调用或远程写入实现。
G0 已获用户批准继续，G1 已通过独立审查和 CI。G2 因真实 Adapter 授权与环境隔离阻塞；M3–M7 未验收，G8 未验证。

## 本地复现

需要 Linux、Node.js 24.22.1、pnpm 11.25.0 和 Git。

```sh
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm test:security
pnpm build
pnpm verify
pnpm forge init /tmp/forge-policy.json --json
pnpm forge doctor /tmp/forge-policy.json --json
node dist/apps/cli/src/index.js doctor /tmp/forge-policy.json --json
```

init 只创建指定的本地配置，不覆盖文件。doctor 校验配置，同时明确返回 runtimeReady=false。
当前配置只接受 observeOnly=true、fake、预算 0、无出站网络、无 push/merge/deploy。
配置校验不是 OS 沙箱或已实现的 Runtime 权限屏障。

默认验证报告在 artifacts/PREVIEW/<run-id>/，仅验证宿主辅助预览实现；原里程碑验收状态仍是 NOT_VERIFIED。全量测试保留 M0/M1/M2 回归。CI 无论成功或失败均上传 artifacts。
首次依赖安装需要 registry 网络；安装后所有测试离线，不需要商业模型 token。
沙箱内可通过 `pnpm install --frozen-lockfile --store-dir <可写目录>` 设置 pnpm store。

## 实施状态与审核

- [技术基线 ADR](docs/adr/0001-stack.md)
- [上游来源锁](docs/sources-lock.md)
- [威胁模型](docs/threat-model.md)
- [验收与阻塞](docs/acceptance.md)
- [40 项任务清单](backlog.json)

G8 要求真实连续 30 日、≥30 个真实任务以及独立真实模型对照实验。
离线 Fixture 不构成自举、自进化收益或产品目标完成的证据。

## M1 continuation

The user approved continuing from G0 on 2026-11-08. M1 adds transactional SQLite events,
replay, offline task scheduling, lease fencing, durable approval cards and an independent
fixed Fake process. See [runtime runbook](docs/operations.md) and [ADR 0002](docs/adr/0002-runtime.md).
Runtime initialization: `pnpm forge init --state-dir /path/to/private-state`.
This still is not a real coding agent: no paid provider, sandboxed third-party agent,
GitHub delivery or autonomous development claim. G2–G8 remain unverified.

真实执行前的必要配置与实际环境错误见 [M2 阻塞记录](docs/m2-blockers.md)。没有把 Fake 当真实执行器，也没有绕过沙箱限制。

## 宿主辅助预览

用户已批准在当前环境用子 agent 继续 M3 及后续可实现部分，保留原 G2/G8 未通过。新增 AutoDev/Fusion、运营与试点账本、Radar/Gene/实验元数据库及离线测试；尚未接入 CLI 自主运行或真实 Provider。
详见 [边界与实现映射](docs/host-assisted-preview.md)、[复现与恢复演练](docs/host-preview-runbook.md)。
