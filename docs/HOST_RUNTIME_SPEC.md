# Host Runtime Specification

M4 增加真实 Codex AgentProvider、独立 ChatGPT/OpenAI Review provider、真实 Artifact 绑定及正常/恢复 E2E，详见 [AGENT_PROVIDER_SPEC.md](AGENT_PROVIDER_SPEC.md) 与 [ADR 0004](adr/0004-real-agents-independent-review.md)。真实装配按 provider 能力暴露 `real_agents` 与 `independent_r3`；fake 装配保持关闭。Protocol 仍为 CCCP 1.0。

M3 的 ProcessToolRunner、GitWorkspaceManager、持久仓库租约和真实 Docker 验收已经完成，详见 [TOOL_RUNNER_SPEC.md](TOOL_RUNNER_SPEC.md)。

M2 扩展已实现，见 [PERSISTENCE_SPEC.md](PERSISTENCE_SPEC.md) 和 [ADR 0002](adr/0002-durable-runtime.md)。下文 M1 能力限制与 RT-01～RT-10 保留为历史基线；装配 SQLite State/Evidence/Identity providers 时，Runtime contract 为 0.2、storage schema 为 sqlite-1，支持受验证的 recoverTask。内存装配仍明确拒绝 crash_recovery。真实 Agent 与独立 R3 Provider 的 M4 接线已实现；本轮源码和审计材料的最终独立 R3 审查另行进行，见 [M4 R3 交接](M4_R3_HANDOFF.md)。

状态：Human 批准范围内的实现规范。对应 CCCP Protocol 1.0；Runtime contract 0.2；Runtime implementation 与包版本为 0.2.0。

## 1. 范围与信任边界

HostRuntime 是可信的进程内宿主，持有活跃 Controller，装配六端口。所有端口、会话配置、fake 脚本及 Discovery 注入均由宿主提供，不能来自模型消息。请求、Agent 输出、仓库内容与工具输出不可信。运行于同一 JavaScript 进程的恶意宿主代码不在隔离保证内。

M1 历史基线支持内存记录、fake Agent / ToolRunner、注册式 workspace、内存证据和模拟 workflow。M2 至 M4 已在此基础上加入 SQLite 恢复、Docker ToolRunner、Git worktree、真实 Agent 与独立 R3；Bridge 的协议职责不变。

## 2. 版本与 capability manifest

`HostRuntime.create(options)` 检查六端口所需方法及能力后构造宿主。manifest 含 protocol_versions、runtime_version、contract_version、storage_schema_version、simulation、capabilities 和 provider_capabilities。

内存/fake 装配的 simulation 必须为 true，`real_agents` 与 `independent_r3` 为 false。真实 routed Agent 只有在实施和审查后端均非模拟、审查后端显式声明独立能力时才开启对应 capability。未知或未满足的 requiredCapabilities 拒绝启动，不静默降级。内存 schema 版本不是数据库 migration 版本。

## 3. 请求与上下文

请求统一为 `{ credential, context, payload, idempotency_key? }`；不接受 actor 或 approved 字段。context 为：

```js
{
  task_id, correlation_id, state_version,
  delegation_ref, workspace_ref,
  principal // 可省略，由 credential 解析；若提供必须与认证结果完全一致
}
```

所有调用先复制输入，再认证；IdentityProvider 返回 `{ principal, task_ids }`。凭证只用于认证，不进入审计、幂等摘要或 Provider 请求。缺失/无效 principal、过期/撤销凭证、跨任务访问、伪造角色均拒绝。

创建要求 state_version=0；delegation_ref 必须匹配 payload.delegation.id，workspace_ref 必须指向可信宿主预注册 workspace。workspace 内记录真实规范化目录，绑定后的 task_id 与 repository identity 必须匹配。后续写操作的 state_version 必须匹配 Controller 当前值。correlation_id 用于关联，不充当幂等键。

## 4. Host API 与 Controller 映射

| 方法 | payload / 行为 |
|---|---|
| startTask | `{ intent, decision, specification, delegation, profile }`；认证 Human → DecisionLifecycle.directed → ExecutionLifecycle；拒绝同名任务 |
| inspectTask | `{}`；返回不可变任务观察记录，允许读取新版本以构造后续请求 |
| discoverTask | Discovery options；CodexAdapter.discover |
| planTask | `{ summary, operations }`；ExecutionLifecycle.plan |
| beginTask | `{ progress? }`；CodexAdapter.begin，执行 freshness 检查 |
| dispatchAgent | `{ kind, run_id, template_version, input, review_level? }`；kind 为 deliberate / implement / review，结果仅为候选输出 |
| executeTool | `{ operation_id, attempt_id }`；必须有 idempotency_key，通过 Adapter 定位已授权 Operation 并调用 ToolRunner |
| submitReport | ImplementationReport；ExecutionLifecycle.report |
| submitReview | `{ review, evidence_refs }`；先验证 Artifact 引用，再 ExecutionLifecycle.applyReview |
| routeReview | `{}`；ExecutionLifecycle.route |
| acceptTask | `{ reason }`；ExecutionLifecycle.accept |
| stopTask | `{ reason }`；认证 Human → override(state=BLOCKED)，不等待正在运行的任务锁 |
| resumeTask | `{ resolution, discovery? }`；先对账所有未证明停止的真实 Agent/tool execution，再由宿主重新观察 Repository block 的 Discovery，最后调用 ExecutionLifecycle.resume；忽略外部伪造观察 |
| recoverTask | 明确 UNSUPPORTED_CAPABILITY；不使用 JSON 重建已批准任务 |

写方法返回 `{ context, snapshot, result }`；context 含最新 state_version。inspectTask 另含 specification、delegation、协议审计，供构造报告/Review；没有可变 Controller 句柄。

普通任务操作互斥，同任务并发操作返回 OPERATION_IN_PROGRESS；不同任务独立。Human Stop 绕过普通操作锁，立即更新 Controller。每次异步返回后校验执行版本；旧结果不能推进任务。Stop 记录后对活跃 fake run 尝试取消，取消失败只记录 Runtime 错误，不撤销停止。取消不保证真实外部副作用已停止。Repository 阻断恢复保留原 Discovery options；DONE 后释放内存写租约，保留 workspace 的任务绑定供检查。租约到期后拒绝工具调用；M1 不自动重新取得失效租约或恢复任务。

## 5. 六端口 contract

端口方法均可异步；capabilities 必须显式返回 `simulation`，并可声明 cancellation、recovery、backend 与端口特有能力。fake 端口保持 `simulation: true`；真实端口必须使用 Runtime 支持并验证的 backend，避免把模拟执行声明成生产能力。

| 端口 | 方法 | M1 实现 |
|---|---|---|
| IdentityProvider | capabilities, authenticate(credential), revoke(credential) | MemoryIdentityProvider；宿主安装 principal、task_ids、expires_at；可注入时钟 |
| AgentProvider | capabilities, deliberate(request), implement(request), review(request), cancel(runId), inspect(runId) | FakeAgentProvider；宿主配置数据脚本；记录 provider/model、principal、role、template、context/repository snapshot、Delegation、allowed_tools、schema 名称、run ID、统计与终止原因 |
| StateStore | capabilities, create(taskId, record), read(taskId), compareAndSwap(taskId, revision, record), claim(key, hash), settle(key, result) | MemoryStateStore；独立 store_revision、不可变记录、原子内存 claim/CAS |
| ToolRunner | capabilities, run(request), cancel(attemptId), inspect(attemptId) | FakeToolRunner；记录上下文、授权 Operation、策略、fingerprint、outcome、输出、退出码、时间与模拟标记 |
| WorkspaceManager | capabilities, createWorkspace(taskId, repositoryRef, baseRevision), inspectWorkspace(ref), acquireLease(identity, taskId, mode), renewLease(id), releaseLease(id), disposeWorkspace(ref) | MemoryWorkspaceManager；预注册现有目录，realpath 校验、单写者内存租约；不创建文件/worktree；dispose 仅解绑 |
| EvidenceStore | capabilities, put(artifact), read(id), verify(ref, scope) | MemoryEvidenceStore；字符串内容 SHA-256、不可变引用、task/operation 归属校验 |

fake 脚本为 JSON 数据，不接受函数或执行命令。Agent 输出由 Host 按 Proposal / ImplementationReport / ReviewResult 校验，不能自动调用批准、report 或 applyReview。Agent run 绑定 context/principal；implement 仅允许活跃计划的 Codex，review 的角色和阶段对应既有 Review 规则。R3 不能复用实施 run；fake R3 始终是模拟。

ToolRunner 请求包含固定 workspace/cwd、Operation、Delegation、文件/环境/网络/工具 allowlist、timeout、输出及资源上限等策略描述。这些字段在 M1 仅验证与记录，实际 OS 执行约束属于 M3。模型不能提供命令或宿主回调替代受信工具绑定。

## 6. StateStore、幂等与错误

一个 Store 仅配一个活跃 Host 写者。Store 保存 Controller snapshot、审批观察、协议审计及操作观察；snapshot 不含完整私有状态，不能恢复 Controller。Store 不复制状态机。store_revision 每次保存增加；state_version 完全由 Controller 决定。

幂等键按 task / principal / 方法分区。摘要包含原始 context 与 payload，不含 credential。认证及当前作用域检查先于去重；完全相同的已完成请求返回已保存结果，允许其携带原版本。相同键不同内容报 IDEMPOTENCY_CONFLICT；进行中的重复返回 OPERATION_IN_PROGRESS；不重新执行。错误也终结该键，不盲目重试。新键仍受 Adapter 每个周期 Operation 仅尝试一次的限制。

Core 错误保留原 code。Runtime 错误含 code，审计仅记录关联 ID、动作和错误码，不记录凭证或未认证自报 Human。Core 在抛错前形成的 BLOCKED 等状态仍保存。Store 写入失败时任务进入宿主不可继续的故障标记，后续执行拒绝；Human 仍可停止活跃 Controller，但保存失败会返回 RUNTIME_STATE_UNAVAILABLE，可通过 inspectTask 查看活跃状态。这是 Runtime 故障而非新协议状态。M1 不声称 Controller 与 Store 跨崩溃原子一致。

## 7. 工具结果与 Evidence

SUCCEEDED、FAILED_CLEAN、EFFECT_UNKNOWN、INTERRUPTED 是 Runtime execution outcome，不加入 EXECUTION_STATES。失败没有自动重试；未知效果或中断先保存尝试结果，再通过既有 BLOCKED / Repository failure 要求重新 Discovery。throw、无效响应、丢失结果默认 EFFECT_UNKNOWN，不能据错误推断无副作用。SUCCEEDED 不代表任务 DONE。

EvidenceArtifact 至少含 evidence_id、type、task_id、operation_id、repository_snapshot、producer、status、principal、content_hash、artifact_ref、created_at、simulation 与字符串 content。哈希校验只能证明存储内容一致；模拟输出不是真实测试通过。

Review 的协议 Schema 不变。Runtime 额外要求 APPROVE 携带通过哈希/归属校验且 status=pass 的 evidence_refs。Review evidence 及逐条 requirement evidence 使用 `evidence:<id>:<hash>` 引用已验证 Artifact；不自动替换文本或升级 UNKNOWN。Artifact 必须属于当前任务和当前执行周期的已记录操作，且绑定当前 Discovery fingerprint。之后仍由 Core 检查完整条款、Review 顺序与角色。M1 demo 全程明确标记 SIMULATION ONLY。

## 8. 可验证条款

- RT-01：冻结 Guide / 既有 Schema 字节不变，旧测试、Schema check、旧 demo 通过。
- RT-02：六端口及 manifest 可校验；不支持能力不能被宣称为支持。
- RT-03：认证、角色、任务、workspace、Delegation 引用和版本拒绝路径不触发 Provider 执行，并可审计。
- RT-04：内存 CAS、幂等冲突与不可变性可由通用 factory contract tests 验证。
- RT-05：所有协议转移使用现有公共接口；fake 输出不能自批或直接完成任务。
- RT-06：Human Stop 对未完成异步调用有效；Codex 无法解除停止，旧结果无法推进。
- RT-07：工具未知效果、中断与异常不盲目重试；Controller 错误路径也保存观察状态。
- RT-08：Evidence 哈希与归属可验证；R2 UNKNOWN、不完整证据和不合法 R3 不能通过。
- RT-09：模拟 workflow 经 Runtime 完成；输出和审计明确 simulation，不宣称真实独立 R3。
- RT-10：恢复、真实 Agent、SQLite、真实隔离均不提前实现；无新依赖，无协议新状态。

运行示例见 `../examples/runtime-workflow.mjs`；测试见 `../tests/runtime-contract.test.mjs`、`../tests/runtime-workflow.test.mjs`。M0/M1 的 R1 和逐条 R2 证据在对应开发日志中。
