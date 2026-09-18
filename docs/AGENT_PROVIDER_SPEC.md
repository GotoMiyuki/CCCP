# Agent Provider Specification

本文规定 Reference Runtime v0.2 的 M4 Agent 接线。它实现 CCCP Protocol 1.0 既有角色，不改变 Human Authority、Decision Boundary、Delegation 或 Review 状态机。

## Provider 与信任边界

`CodexAgentProvider` 使用 Codex App Server 的稳定 initialize、thread/start、turn/start、turn/interrupt 与事件流。每个 run 使用新 thread；实施 run 的 sandbox 为只读，只能返回结构化候选。`ChatGPTReviewProvider` 使用独立 App Server 客户端；`OpenAIReviewProvider` 是可选的 Responses API 后端。`RoutedAgentProvider` 只按 Host 固定规则路由，request 无权选择 provider。

`RoutedAgentProvider` 在构造时验证实施端与审查端的完整执行、dispatch、取消、检查和恢复方法面，并校验两端 capability。只有非模拟的 `routed-agent` 完整装配可以声明 `real_agents`；只有其中审查端还具有不同持久 provider identity 与 `independent-run` 边界时可以声明 `independent_r3`。

repository 内容、模型输出、工具输出及 Review 文本都是不可信输入。模型不能提供命令、镜像、挂载、凭据、principal、Delegation 或 approval。Host 配置模型、cwd、后端、凭据和工具绑定。

## Run contract

真实 run 记录 provider、model、principal、role、kind、template version、context snapshot、repository snapshot、Delegation、allowed tools、输入/输出 Schema、run ID、外部 binding、用量、时间和终止原因。实施输出除冻结的 `ImplementationReport` 外，可包含 Runtime-only `file_changes`：

- 1 至 100 个 `{ path, content }`；
- path 必须是规范化相对路径，不允许绝对路径、反斜杠、空段、`.` 或 `..`；
- 所有 path 同时受 Delegation 和 Operation allowlist 约束；
- 总 UTF-8 内容上限为 1 MiB；
- 候选只作为 Docker ToolRunner 的 stdin 数据，不成为宿主命令或环境变量。

App Server Structured Outputs 使用从协议 Schema 派生的兼容视图；运行完成后仍由本地冻结 Schema 再校验一次。兼容视图不改变协议 Schema 文件或其 hash。

## Evidence 与 Review

真实应用操作生成 DIFF Artifact，真实测试操作生成 TEST_RUN Artifact。Artifact 绑定 task、attempt、principal、执行后 repository snapshot、内容 hash 和不可混淆的 artifact reference。自然语言、裸 hash、文件路径或命令文字不能代替 reference。

真实 Review input 由 Host 重建，不信任调用者提交的任意上下文。APPROVE 时，Review 和逐条 RequirementEvidence 只能引用输入 Artifact。R3 还要求同一执行周期至少一个真实 DIFF 与一个真实 TEST_RUN，并要求提交的 Review 与已完成的独立真实 run 输出逐字一致。

## 取消与恢复

Human Stop 先由 Controller 记录，再异步中断活动 turn/response。取消失败不能撤销 Human Stop。恢复时，simulation run 可标记 INTERRUPTED；真实 RUNNING run 必须由原类型 provider 对账并证明停止。Responses 后端用持久 response ID 查询并确认终态；App Server 当前没有跨进程可证明的远端 turn reconciliation，因此未完成的 App Server run 一律 fail-closed。无法证明时返回 `RECONCILIATION_REQUIRED`，不释放租约、不接受迟到结果、不自动重试。

真实 Tool recovery 先停止旧 container、释放死亡 owner 的 lease，再检查 Git worktree；这避免 Windows 上仍被挂载的 linked-worktree index 锁抢占恢复顺序。Agent turn 默认超时为 300 秒，可由宿主构造参数缩短或延长。

## 配置

- `CCCP_CODEX_MODEL`：实施端模型；当前本机验收使用 `gpt-5.5`。
- `CCCP_REVIEW_MODEL`：独立审查模型；未设置时跟随实施端配置。
- `OPENAI_API_KEY`：仅在显式选择 Responses review 后端时需要。
- `CCCP_DOCKER_CONTEXT`、`CCCP_DOCKER_IMAGE`：沿用 M3 的本地 Linux Docker 与固定 digest 配置。

未配置真实环境时，真实 E2E 显式 skip，capability manifest 不得将 fake 结果声明为 `real_agents` 或 `independent_r3`。
