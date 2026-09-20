# Host Runtime M2 — 持久化与恢复验收

Human 于 2026-09-17 批准 M2/M3 文件计划。M2 已完成实现、实施者 R1 与逐条 R2；不代表真实 Agent 或独立 R3 已通过。

## 文件与实现

新增 SQLite database/state/evidence/session providers、Controller journal、恢复协调器、DurableBridge、Runtime CLI、ADR 0002 与 PERSISTENCE_SPEC；新增 persistence/crash-recovery tests 和隔离子进程 fixtures。Host、contracts、manifest、内存 Store、Runtime 导出、README/package 接入扩展。

Core 只增加 AuditLog 时钟、Directed 审批时间及 ExecutionLifecycle ID 来源的可注入参数，默认行为不变；没有修改协议状态、Schema、角色或守卫条件。恢复调用原有公共方法，比对命令错误、版本与完整审计，不导入私有状态。Adapter attempted identities 通过可信 journal 恢复。

既有 Runtime workflow 测试的等待 helper 从 100 次 immediate polling 改为有上限的 5ms 轮询，以容纳新增的执行前记录步骤；原有断言与场景保留。

## R1 与实测

Windows / Node v24.19.0；内置 SQLite 3.53.3。`npm test`：**172 PASS / 0 FAIL / 0 skipped**，旧 158 项保留，新增 14 项。原始输出：本地 `.cccp/reviews/m2-tests.txt`。M2 测试单独执行同样 14 PASS。

## 逐条 R2

| 条款 | 证据 | 判断 |
|---|---|---|
| schema migration 与版本边界 | migrations 重复打开、未知更高版本拒绝；可选后端限定 Node >=24.14 | PASS |
| 事务同时提交状态/事件/audit/幂等/outbox | transaction failure 回滚测试；CAS/snapshot/tail/settlement 测试 | PASS |
| 恢复不扩大权限、不伪造审批 | approval_before / approval_after 真实子进程 SIGKILL；事件损坏拒绝；公共守卫重放 | PASS |
| 未结束工具不重复副作用 | tool_started 在真实 fixture 文件写入后杀进程；恢复 EFFECT_UNKNOWN；换 key 仍被 OPERATION_ALREADY_ATTEMPTED 拒绝 | PASS |
| R2 与确认丢失一致 | r2_after 在事务提交后、方法返回前杀进程；R2/Review routing/settled receipt 保留 | PASS |
| Human Stop 与撤销跨重启保留 | stop_after SIGKILL；Codex resume 拒绝；SQLite session revocation 重开后仍拒绝 | PASS |
| 持久 Bridge 与未知投递 | 重建 Bridge 不重复投递；Outbox 发送后 SIGKILL，重启变 UNCERTAIN；显式重投保持稳定 key | PASS |
| 跨进程旧写入拒绝 | 两个实际 Node 进程使用同一 Store revision，恰好一个 CAS 成功 | PASS |
| 协议冻结与旧行为不回退 | 全部旧 tests、冻结 Guide/9 artifacts 哈希测试继续通过 | PASS |

## 限制

恢复信任宿主保护的数据库；哈希不是外部签名。当前 snapshot 存完整可重放前缀，重建仍执行历史协议命令，存储/重放成本尚未优化。运行时拒绝诊断 audit 仍在 Host 内存；已接受的协议审批、Review、Stop 与执行审计持久化。会话 provider 是宿主安装 grants，不是生产登录。

M2 对 fake tool 的恢复不声称真实隔离；M3 将核实真实容器是否停止。真实 Agent 与独立 R3 属于 M4。
