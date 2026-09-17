# Persistence Specification — M2

协议：CCCP 1.0；Runtime contract 0.2；数据库 schema 1。SQLite 可选后端需要 Node >=24.14；内存后端仍可用于旧环境。

## 数据与事务

`SqliteDatabase.open({path})` 初始化 WAL、FULL synchronous、foreign_keys、禁用扩展加载，并在事务内迁移 PRAGMA user_version。未知更高版本拒绝打开。数据库应位于 workspace 外或被 Discovery 排除的 `.cccp/` 内；不要把运行中的 WAL 数据库仅复制主文件作为备份。

`SqliteStateStore` 实现既有 create/read/CAS/claim/settle，并新增 acquireTask、recover、pending、enqueue、outbox、markOutbox。CAS 的第四参数可传 `{settlements, outbox}`，与状态提交同一事务执行。没有事务内异步回调。

| 实体 | 内容 |
|---|---|
| tasks | 当前数据投影、Store revision、Controller state_version、event hash |
| events | 只追加提交记录，包含任务、时间、前后版本、数据和前序哈希 |
| snapshots | 周期提交检查点、event offset/hash；保存完整可重放前缀 |
| audit_entries | 不可改写的协议审计前缀 |
| operation_attempts | 工具开始前已提交的尝试身份、阶段和终态 |
| inbox | 稳定 key/content hash、PENDING/SETTLED 和原响应 |
| outbox | 稳定 ID、内容及 PENDING/SENDING/DELIVERED/UNCERTAIN 状态 |
| sessions | 宿主安装的 grant、凭证 SHA-256、过期/撤销；不存明文凭证 |
| artifacts | 内容、SHA-256、任务/操作/Discovery 引用及 simulation 标记 |
| task_owners | 活跃 Host owner UUID / PID，防止两个 Host 同时执行同一任务 |
| repository_leases / workspaces | M3 的持久租约与 workspace 注册，详见 TOOL_RUNNER_SPEC |

事件中的数据投影刻意保留完整记录以简化首版校验，有存储与恢复成本；不是通用分布式 event sourcing 引擎。协议审计不能替代数据库访问控制。Runtime 的拒绝诊断日志仍为 Host 进程内日志，已接受的协议状态、审批与 Review 审计持久化。

## 恢复

1. 从认证会话解析 principal 与任务范围，检查请求 workspace/Delegation 引用。
2. 取得任务 owner；旧进程仍存活或生死不明则拒绝。
3. 校验完整事件哈希/版本连续性、最新 snapshot offset/hash、snapshot 后事件、任务/audit/attempts 投影。
4. 通过 ControllerJournal 重放原有公共方法；比对每个命令前后版本、错误码、生成 ID、最终 snapshot 和完整 audit。原时间/ID 只用于重建历史，不产生新的 Human 批准。
5. 恢复 Adapter attempted identities 与 Discovery options；不恢复 busy=true，不运行工具/模型。
6. 对 RUNNING 尝试及未证明停止的真实终态核实旧工具已停止，标为 EFFECT_UNKNOWN，通过既有 REPOSITORY_FAILURE BLOCKED 要求新 Discovery；Human Stop 仍保留。M3 持久化 execution_binding，旧 owner 死亡也必须先核实容器，才能移交仓库租约。
7. 未知 inbox 以 DELIVERY_UNCERTAIN 终结；SENDING outbox 下次调度变为 UNCERTAIN，不自动重投。显式重投也必须保持原稳定 key。

Store/Host 单进程对象不允许被多个 Host 重复装配；不同进程可访问同一数据库，但 CAS 和 task ownership 共同限制写入与调度。Store revision 是数据库并发令牌，不能作为新协议状态。

M2 的 Controller journal 覆盖 Host 当前公开的 Directed、执行、Review、Stop/resume 路径。绕开 Host 直接使用 Core 的第三方控制器不自动获得持久能力。恢复不提供任意 checkpoint 导入 CLI。

## Bridge 与会话

DurableBridge 复用既有 Bridge 的 schema、角色、任务与 repository checks。持久 inbox 覆盖进程重启后的去重。回调提交与 Bridge receipt 之间失联时，保持不确定并要求核实；不能声称任意外部接收方 exactly-once。

`queue` 记录出站 Envelope；`flush(taskId, trustedTransport)` 使用稳定 idempotency_key。retryUncertain 只有在接收方支持幂等、宿主明确决定后才启用；默认关闭。Runtime 内部 receipt 与 Bridge Envelope 在 outbox 中区分，不自动向外发送内部响应。

SqliteIdentityProvider / DurableBridge 的安装配置属于可信宿主，重复安装不得变更旧凭证 grants，也不能解除已持久化的撤销。它们不是密码/OAuth 等生产认证实现。

## CLI 与验收

```text
node src/runtime/cli.mjs migrate path/to/runtime.sqlite
node src/runtime/cli.mjs inspect path/to/runtime.sqlite task-id
node src/runtime/cli.mjs recover path/to/trusted-host-config.mjs
```

recover 配置导出 `createHost()`，返回 `{host,database}`；完整 Runtime 请求从 stdin 输入，不在命令行参数中传凭证。inspect/migrate 是本地数据库操作员入口，不代表远程 Human 身份。

测试：`tests/persistence.test.mjs`、`tests/crash-recovery.test.mjs`。故障夹具用独立 Node 进程和临时目录，真实终止进程验证事务提交前后、工具副作用后、R2 提交后、Stop 后、Outbox ACK 丢失与双进程 CAS。没有运行真实 Agent，也不构成独立 R3。
