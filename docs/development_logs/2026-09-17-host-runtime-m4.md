# Host Runtime M4 — 真实 Agent、独立 R3 与 E2E

日期：2026-09-17—18。Human 已批准 M4 文件计划。实现保持 CCCP Protocol 1.0 的冻结语义；没有增加生命周期状态、改变 Human Authority 或让 Agent 绕过 Delegation。

## 实现范围

- Codex App Server 真实实施 provider，以及可选 OpenAI Responses review provider；
- 单独客户端、principal 与 run 的 ChatGPT R3 provider；
- routed provider capability 与真实 run 记录；
- Agent 文件候选的路径、大小、Operation 和 Delegation 校验；
- Docker stdin 数据通道，候选不能成为命令、环境变量或宿主回调；
- DIFF、TEST_RUN Artifact 与执行后 repository snapshot 绑定；
- Review frozen input、证据白名单和独立 R3 原样提交校验；
- 未完成真实 Agent run 的恢复对账；
- 正常与强制终止 Host 后恢复的真实 E2E。

## R1

实现检查确认真实 Agent 保持在 Runtime Plane。App Server/Responses 的模型、线程和凭据没有进入 Protocol Core；Controller 仍是生命周期状态转移的唯一入口。模型生成的文件内容只有在 Host 校验并由 M3 Docker ToolRunner 执行后才产生副作用。

## R2 条款证据

| 指南条款 | 证据 | 结论 |
|---|---|---|
| 真实 Codex AgentProvider | `CodexAgentProvider` + App Server 真实 E2E | PASS |
| 独立 ChatGPT R3 | 不同 provider object、principal、process/thread/run；R3 输出原样绑定 | PASS |
| 最小 EvidenceArtifact | SQLite DIFF/TEST_RUN、hash、task/attempt/snapshot/principal 绑定 | PASS |
| 正常真实 E2E | 实施、Docker 写入、真实测试、R1/R2、独立 R3 到 HUMAN_ACCEPTANCE | PASS |
| 恢复真实 E2E | 工具和 report 后强制终止 Host；新 Host 恢复且 operation 数仍为 2，再完成独立 R3 | PASS |
| 冻结协议 | 9 个 schema/state artifacts 一致；冻结 hash 回归继续通过 | PASS |
| 不伪造 Human | 两条 E2E 都停在 HUMAN_ACCEPTANCE，等待真实 Human 接受 | PASS |

结构化审计证据见 [正常路径](../audit/m4/normal.json) 与 [恢复路径](../audit/m4/recovery.json)。两份附件各含 2 个可重算 SHA-256 的完整 Artifact、实施/R3 provider identity 与 thread/turn binding，以及 21 条协议审计记录。

## 独立 R3 修复记录

独立 reviewer 先后指出并由实现修复：外部 binding 落盘窗口、R3 provider provenance、真实 before/after DIFF、App Server 远端停止不可证明、review-only provider capability 误报、routed 子 provider 方法面未校验，以及审计报告缺少可核验附件。最终实现采用 fail-closed App Server recovery、Responses 终态确认、完整 routed 装配校验和结构化 E2E evidence export。

最终回归：Docker 单并发全量 200 tests，198 PASS、0 FAIL、2 个 opt-in 真实 Agent E2E SKIP；两条真实 Agent E2E 已单独 PASS；9 个 schema/state artifacts 一致；`git diff --check` 通过。Windows orphan-container 文件锁竞态通过“先 reconcile，后 Git inspect”的恢复顺序修复。

## 当前限制

本机 Codex CLI `0.154.0-alpha.6.2` 无法使用默认 `gpt-6-astra` 或 `gpt-5.6-terra`，服务端要求更新客户端；真实验收显式使用 `gpt-5.5`。模型仍是宿主配置，Core 未写死。多任务调度、完整 capability negotiation、Threat Model、外部 Conformance 和 CI/release 属于 M5。

运行时 E2E 中的独立 R3 已通过；本轮 M4 源码、设计和审计附件的最终独立 R3 审查已拆分到下一对话。交接材料和判定规则见 [M4 R3 交接](../M4_R3_HANDOFF.md)。最终 Human Acceptance 必须由 Human 明示，当前不伪造 DONE。
