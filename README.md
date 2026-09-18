# CCCP Reference Implementation

根据 **CCCP v1.0 Design Guide** 实现的首版协议参考库。使用 Node.js 标准库，无第三方运行或测试依赖。

冻结语义以原始 Design Guide 为准。包版本 `0.1.1` 是实现版本，消息中的协议版本仍为 `1.0`。新增 Schema 和实现规范均为可审查的实现草案，未宣布冻结 CCCP v1.1。

## 运行

需要 Node.js 22 或以上。Git Discovery 及 Git 集成测试还需要本机 Git。

```powershell
npm test
npm run check
npm run demo
npm run demo:runtime
npm run runtime -- migrate .cccp/runtime.sqlite
node src/cli.mjs discover .
node src/cli.mjs validate Profile examples/project-profile.json
```

无需运行 `npm install`。演示使用**模拟的 Human 审批、Discovery 和 Review 证据**，不会调用真实模型、修改业务文件或执行远程 Git 操作。测试在系统临时目录建立隔离的文件和 Git 仓库。

## 已实现

- Decision / Specification / Delegation 分离，只有 Human 能批准最终 Decision、授权 Profile 与 Delegation。
- 独立的 Decision 和 Execution 生命周期，支持 Directed 入口。
- 必要内部实现的默认自主权，以及默认禁止域、路径范围和操作权限检查。
- 越权产生 `CHANGE_PROPOSAL` 与 `BLOCKED`；Replan 等待新的 Human 授权。
- R1、逐条证据映射的 R2、按风险路由的独立 R3；可选 Human Acceptance。
- Review 只输出判断，Lifecycle Controller 控制转移、Revision 预算和重复失败检测。
- Git / 文件 Discovery、Context 来源分类、过期检查和审计记录。
- 13 种消息的 Envelope / Payload 校验、会话范围、并发去重和不确定投递处理。
- Codex Adapter 接口、进程内 Bridge、可运行演示和自动测试。
- Host Runtime M0/M1：六端口 contract、内存/fake providers、认证上下文、进程内 CAS/幂等、模拟工具 Evidence 与 contract tests。
- M2：SQLite 状态、证据、会话、持久 Bridge 与受验证恢复；M3 Docker 工具、Git worktree、持久租约和真实隔离验收已完成。
- M4：真实 Codex 实施 Agent、独立 ChatGPT/OpenAI R3 Provider、真实 DIFF/TEST_RUN Evidence，以及正常和 crash-recovery E2E 已完成；两条流程均停在 `HUMAN_ACCEPTANCE`。

Runtime 入口是 `HostRuntime.create({ providers, discovery? })`，通过 `src/index.mjs` 或 `src/runtime/index.mjs` 导入。完整装配示例见 [examples/runtime-workflow.mjs](examples/runtime-workflow.mjs)。`npm run demo:runtime` 经认证模拟会话、fake Agent、fake 工具、Artifact 校验和既有 Controller 完成流程；输出始终标为 `SIMULATION ONLY`。

## 文档与入口

| 内容 | 位置 |
|---|---|
| 冻结设计 | [CCCP v1.0 Design Guide.md](CCCP%20v1.0%20Design%20Guide.md) |
| 实现约定、Schema、状态规则 | [docs/IMPLEMENTATION_SPEC.md](docs/IMPLEMENTATION_SPEC.md) |
| Codex Adapter 接入边界 | [docs/CODEX_ADAPTER_SPEC.md](docs/CODEX_ADAPTER_SPEC.md) |
| Bridge API 与身份边界 | [docs/BRIDGE_API_SPEC.md](docs/BRIDGE_API_SPEC.md) |
| Host Runtime API、六端口与能力边界 | [docs/HOST_RUNTIME_SPEC.md](docs/HOST_RUNTIME_SPEC.md) |
| Host Runtime 架构决策 | [docs/adr/0001-host-runtime-layer.md](docs/adr/0001-host-runtime-layer.md) |
| SQLite、事务与恢复 | [docs/PERSISTENCE_SPEC.md](docs/PERSISTENCE_SPEC.md) |
| Docker 工具、工作区和持久租约 | [docs/TOOL_RUNNER_SPEC.md](docs/TOOL_RUNNER_SPEC.md) |
| 真实 Agent、独立 R3 Provider 与恢复边界 | [docs/AGENT_PROVIDER_SPEC.md](docs/AGENT_PROVIDER_SPEC.md) |
| M4 架构决策 | [docs/adr/0004-real-agents-independent-review.md](docs/adr/0004-real-agents-independent-review.md) |
| M4 真实 E2E 审计报告 | [docs/M4_E2E_REPORT.md](docs/M4_E2E_REPORT.md) |
| M4 最终独立 R3 审查交接 | [docs/M4_R3_HANDOFF.md](docs/M4_R3_HANDOFF.md) |
| M2 验证 | [docs/development_logs/2026-09-17-host-runtime-m2.md](docs/development_logs/2026-09-17-host-runtime-m2.md) |
| M3 实现与验收 | [docs/development_logs/2026-09-17-host-runtime-m3.md](docs/development_logs/2026-09-17-host-runtime-m3.md) |
| M0 冻结基线与 R1/R2 | [docs/development_logs/2026-09-17-host-runtime-m0.md](docs/development_logs/2026-09-17-host-runtime-m0.md) |
| M1 验证与 R1/R2 | [docs/development_logs/2026-09-17-host-runtime-m1.md](docs/development_logs/2026-09-17-host-runtime-m1.md) |
| 条款与实现、测试对应关系 | [docs/CONFORMANCE.md](docs/CONFORMANCE.md) |
| 本次实现与验证报告 | [docs/IMPLEMENTATION_REPORT.md](docs/IMPLEMENTATION_REPORT.md) |
| 后续加固与回归结果 | [docs/OPTIMIZATION_REPORT.md](docs/OPTIMIZATION_REPORT.md) |
| 开发日志 | [docs/development_logs/2026-09-16-v0.1.1-macos-compatibility.md](docs/development_logs/2026-09-16-v0.1.1-macos-compatibility.md) |
| 对外导出 | `src/index.mjs` |
| 机器可读产物 | `schemas/` |

## 使用边界

这是可执行的协议核心和集成参考实现。M2 已提供 SQLite 状态、Artifact、会话、持久 Bridge 与受验证的崩溃恢复。M3 Docker 后端已用固定 digest 完成真实容器验收。M4 已接入通过现有 ChatGPT 登录运行的真实 Codex 实施端和独立 ChatGPT R3；可选 OpenAI Responses review 后端仅在宿主显式提供 API key 时启用。生产级身份管理、MCP 接线和 CI/release 仍不属于本轮范围。宿主负责提供真实身份与受限工具；不能将消息中的角色声明当作认证。

Bridge 的会话、去重和审计保存在内存中；可导出审计记录，但未提供崩溃后重放。审计哈希可检测记录改动，不是外部签名。代码无法仅凭自然语言判断一个实现是否暗中改变架构，仍需依据真实证据执行 R2 / R3。

独立 R3 的运行时机制已由两条真实 E2E 验证；**本次 M4 代码、文档和审计证据尚未获得最终独立 R3 审查**，该审查已拆分为单独交接，见 [M4 R3 交接](docs/M4_R3_HANDOFF.md)。

M0/M1 的历史基线与 Runtime contract/workflow 测试保留；当前完整回归结果及运行环境见 [M4 E2E 报告](docs/M4_E2E_REPORT.md)。Runtime 标记为 `0.2.0-dev`，包版本保持 `0.1.1`，协议保持 `1.0`。

M1 内存装配仍关闭 durable state/crash recovery。M2 可选 SQLite providers 使用内置 node:sqlite，要求 Node >=24.14，无新增 npm 包；凭证只存哈希。恢复通过既有 Controller 公共接口重放并验证审计，不接受请求上传的审批 snapshot。工具未知效果与不确定投递不自动重试。M3 Docker 后端和 M4 真实模型接线均已完成验收；最终独立代码审查与 Human Acceptance 仍待完成。
