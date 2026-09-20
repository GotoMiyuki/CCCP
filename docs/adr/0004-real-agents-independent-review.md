# ADR 0004 — 真实 Agent、独立 R3 与证据绑定

状态：M4 实现与真实 E2E 完成；本轮变更的最终独立 R3 审查已拆分为单独交接，尚未形成 Human Acceptance。对应 CCCP Protocol 1.0；不新增协议状态或权限。

## 决策

真实 Codex 通过独立的 Codex App Server 进程接入 `AgentProvider`。Agent 在只读 sandbox 中检查隔离 worktree，返回受 JSON Schema 约束的协议输出和文件候选；候选不会直接写入仓库。Host 先持久记录 run 和外部执行绑定，再校验路径、大小、Delegation 和已批准 Operation，最后把候选作为数据交给 Docker ToolRunner 执行。

R3 由单独的 `ChatGPTReviewProvider` 或 `OpenAIReviewProvider` 执行。它使用不同 principal、run、thread/response 和 provider 路由，只接收冻结的 Decision、Specification、ImplementationReport、执行后 repository snapshot 以及已验证的 DIFF/TEST_RUN Artifact。R3 输出不能自称 Human，也不能引用输入白名单之外的证据。

App Server 后端复用本机可信 ChatGPT 登录；Responses 后端只从宿主构造参数读取 API key。凭据不进入 Runtime request、任务状态、日志或仓库。两个后端都保持在 Runtime Plane，Protocol Core 不依赖 OpenAI API、CLI 或模型名称。

## 恢复边界

真实 run 在外部调用前写入 RUNNING 记录，并尽早补写 process/thread/turn/response binding。重启发现未完成 run 时必须调用 provider reconciliation；不能证明旧执行停止则拒绝恢复。App Server 的本地 pid 不能证明远端 turn 已停止，也可能在重启后被复用，因此当前实现不会用 pid 猜测安全终态。已完成工具操作通过持久 attempt 和 Artifact 恢复，不自动重复执行。旧 Docker execution 在 Git worktree 检查前完成 reconciliation，避免挂载锁与恢复读取竞态。只读模型请求即使产生迟到结果也会被丢弃，不能推进 Controller。

## 取舍

当前 App Server 采用一 run 一进程，便于取消、记录和隔离，代价是启动开销。实施 Agent 不直接获得写权限；这比允许模型绕过 ToolRunner 修改 worktree 多一步，但保留 M3 的实际执行边界。完整 capability/version 协商、多任务调度与发布策略属于 M5。

## 验收边界

正常与恢复 E2E 都已实际调用独立 ChatGPT R3 provider，并在 `HUMAN_ACCEPTANCE` 停止。该运行时 R3 证明接线、身份隔离和证据绑定可用，不等同于对本轮源代码、ADR 和审计附件的独立设计审查。后者已明确移交，审查输入、核对项和可接受结论见 [M4 R3 交接](../M4_R3_HANDOFF.md)。在该审查和 Human 明示接受前，不得声称 M4 达到 `DONE`。
