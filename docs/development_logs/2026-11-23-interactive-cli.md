# CCCP CLI 交互开发日志

整理日期为 2026-11-23，覆盖交互宿主阶段 A–D。此前的 v0.2.0 已经能通过 Runtime 和测试宿主跑通实施、测试与审查。本轮补上终端入口，让用户能自己提需求、确认授权、查看实际结果，并在试跑后决定是否验收。日期示例已通过真实 DeepSeek 和 Docker 的端到端联调，独立真人试用仍待记录。[v0.2.0 开发总结](2026-11-19-v0.2.0-summary.md) · [交互宿主设计与计划](../INTERACTIVE_HOST_DESIGN_AND_PLAN.md)

## A · 需求讨论和草稿

新增 `npm run chat`。用户直接输入需求，也可以回答模型的澄清问题或补充要求。用 `/draft` 生成结构化草稿，用 `/show [版本]` 核对目标、约束、验收条件和建议修改范围。CLI 将对话和各版草稿保存在本地 SQLite，退出后可用会话 ID 恢复，查看记录无需模型凭据。无效 JSON、缺少必要字段或超出项目范围的建议路径会在保存草稿前被拒绝。[CLI 实现](../../src/chat/cli.mjs) · [讨论回归](../../tests/interactive-chat.test.mjs)

讨论端支持 OpenAI 和 DeepSeek 的 Responses API。由于本轮可用的实测凭据是 DeepSeek，阶段 A 补了 DeepSeek 讨论端，阶段 C 再用同一把 key 接通日期示例的实施与审查。讨论请求传入对话、上一版候选草稿和项目配置摘要。模型给出的澄清问题、答复和草稿由 CLI 展示，由用户决定是否批准。[讨论适配器](../../src/chat/responses.mjs) · [用户指南](../USER_GUIDE.md#2-chatting_agent-和-coding_agent-在哪里选)

## B · 从草稿交接到 Runtime

用户查看当前草稿后输入 `/approve <版本>`。CLI 核对草稿版本、后续讨论和 Git HEAD，再把批准的内容映射成 Intent、Decision、Specification、Delegation 和 Profile。批准绑定任务 ID、内容摘要和基准提交，Runtime 创建独立的 Git worktree，任务进入 `DISCOVERY`。此时模型运行和工具操作计数均为零，用户用 `/run` 显式启动日期示例的实施。[交接实现](../../src/chat/task-handoff.mjs)

回归覆盖了过期草稿、基线变化、重复批准和回执丢失。重复提交只得到一个任务。worktree 基于获批提交创建，源仓库里未提交的修改不会被带入该任务。[批准与恢复回归](../../tests/chat-task-handoff.test.mjs)

## C · 按用户需求执行日期示例

`--demo` 初始化一个独立的日期校验仓库，授权范围限定为 `src/date.mjs` 与 `tests/checks.mjs`。CLI 向实施端发送获批规格与两个文件，模型返回候选内容。Runtime 检查授权，Docker 应用候选并在只读容器执行测试。R1 核对应用与测试，R2 逐条关联规格和证据，独立 R3 审查决策、授权及实际改动。用户用 `/task` 查看 worktree、差异、测试输出和审查结论。[实施入口](../../src/chat/demo-execution.mjs) · [日期示例指南](../USER_GUIDE.md#运行自己的日期示例需求)

真实联调在同一基线分别完成“四月”和“六月”最多 30 天的任务，两项均到达 `HUMAN_ACCEPTANCE`。另一次六月尝试因 R2 缺少逐条证据被阻塞，测试通过和 R2 返回 `APPROVE` 也无法推进状态。旧有 M4 的真实 Codex 正常和崩溃恢复路径在阶段 C 复跑均通过。此次本地记录保存在 `.cccp/stage-c-smoke-sj1oM6/` 和 `.cccp/stage-c-m4-regression/`。

## D · 暂缓、恢复和人工验收

`/defer [理由]` 写入审计并保留 `HUMAN_ACCEPTANCE`。退出后以 `--resume <会话ID>` 重开，可找回原任务、worktree 和证据。核对结果后，用户用 `/accept <理由>` 确认。CLI 核对 worktree 的 HEAD 仍是获批提交，Runtime 复核 R3 证据，通过后才进入 `DONE`，保留验收理由及证据引用。重复验收返回原回执。发现未对账的外部运行时，CLI 显示 `RECONCILIATION_REQUIRED` 和对应 ID，恢复会话只查看已有记录。[Runtime 接口](../HOST_RUNTIME_SPEC.md#4-host-api-与-controller-映射) · [验收回归](../../tests/chat-demo-execution.test.mjs)

阶段 D 启用 Docker 的全量回归为 209 项通过、3 项外部模型用例按配置跳过。随后用真实 `deepseek-flash` 单独完成四月示例的讨论、实施与审查。Docker 测试 4/4 通过，R1、R2 和独立 R3 均批准。单独试跑确认 4 月 30 日返回 `valid`，4 月 31 日返回 `invalid date`，退出码为 1。测试操作者暂缓后在新进程恢复，验收到 `DONE`。最终审计有 1 次暂缓和 1 次验收，恢复过程没有新增模型运行或工具操作。[试用记录](../INTERACTIVE_HOST_TRIAL.md)

## 当前使用边界

- 用户通过 CLI 与 `chatting_agent` 讨论，通过终端命令批准草稿和验收结果。CLI 保存会话与批准记录到 `.cccp/chat.sqlite`。实施和审查由 Runtime 分别派发，任务状态、证据和审计保存在 `.cccp/chat-runtime.sqlite`，实际改动留在 `.cccp/chat-worktrees/`。
- 自有 Git 仓库可配置讨论与任务交接。用户从讨论一路跑到 `DONE` 的完整交互执行入口当前限于日期示例。讨论模型用 `CCCP_CHAT_MODEL` 配置，日期示例的实施与 R2 用 `CCCP_CODING_MODEL`，独立 R3 用 `CCCP_DEEPSEEK_MODEL`。
- 现有验证覆盖实现、跨进程恢复和真实模型联调。产品验收还需要用户亲自完成一次试用，记录哪些步骤能独立操作、哪些提示需要改进。[用户指南](../USER_GUIDE.md) · [真人试用脚本](../INTERACTIVE_HOST_DESIGN_AND_PLAN.md#首次真人试用脚本)
