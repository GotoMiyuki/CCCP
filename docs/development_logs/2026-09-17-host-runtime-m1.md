# Host Runtime M1 — 实现与验证

日期：2026-09-17。范围依据 Human 对 M0/M1 文件级计划的批准。状态：M1 实现、自动验证与实施者 R1/R2 完成；未执行真实独立 R3。

## 交付与文件边界

- 新增 `src/runtime/` 共 18 个 ESM 文件：HostRuntime、context、manifest、错误与数据 contracts，六端口及各自内存/fake 实现、Runtime 导出入口。
- 新增 `tests/runtime-contract.test.mjs`、`tests/runtime-workflow.test.mjs`。
- 新增 `examples/runtime-workflow.mjs` 和本日志。
- 修改 `src/index.mjs`（新增导出）、`package.json`（新增 demo:runtime）、`README.md`（入口与能力说明）。
- M0 的 4 个文档文件单列在 M0 日志，不与本阶段实现文件混合。
- 没有修改既有 Controller、Adapter、Bridge、Review、Repository、协议 contracts、9 个 Schema/state artifacts、旧测试或旧 demo。
- 没有新增依赖；package 仍为 0.1.1，protocol 仍为 1.0。Runtime manifest 标为 0.2.0-dev / simulation。

## 实现要点

HostRuntime 经认证会话解析 principal，检查任务/Delegation/workspace 引用与 Controller state_version。Directed 创建只接受 Human；普通异步调用按任务互斥。协议转移仅调用现有公共方法，工具沿 CodexAdapter.execute 的授权、路径及尝试记录检查进入 fake runner。Agent 不得到工具回调，候选报告/Review 不直接推进任务。

StateStore CAS 使用独立 store_revision，保存 Controller 的不可变观察记录。操作失败时仍保存 Controller 已形成的 BLOCKED。Store 失败后停止继续执行，但 Human 仍可停止活跃 Controller。快照不用于重建审批，不提供持久化或重放。

相同幂等请求返回原结果；不同内容冲突；未完成请求拒绝重复调度。重放前重新认证，撤销会话不能利用缓存结果。Human Stop 不等待长操作锁，尝试取消 fake run；迟到结果仍须校验版本。

Evidence 使用字符串内容 SHA-256、任务/操作/执行周期及 Discovery fingerprint 绑定。Runtime 的 Review APPROVE 需引用已验证的模拟 Artifact，随后仍接受 Core 的逐条 R2、条件式 R3 与 Human Acceptance 守卫。UNKNOWN 不升级为 PASS。

## 验证结果 / R1

环境：Windows，Node.js v24.19.0。以下命令均返回 exit code 0：

| 命令 | 结果 |
|---|---|
| `npm test` | **158 PASS / 0 FAIL / 0 skipped**；保留旧 104 项，新增 54 项 |
| `node --test tests/runtime-contract.test.mjs tests/runtime-workflow.test.mjs` | 54 PASS；其中 18 项端口/冻结验证，36 项 Runtime workflow 验证 |
| `npm run check` | Checked 9 schema / state artifacts |
| `npm run demo` | SIMULATION ONLY；DONE；audit_valid=true；messages_delivered=2 |
| `npm run demo:runtime` | SIMULATION ONLY；DONE；audit_valid=true；operations=1；agent_runs=2 |

冻结校验测试逐项读取 M0 日志中的 10 个 SHA-256，Guide 与所有旧 Schema/state artifacts 字节一致。仓库别名回归在 Windows junction 下通过；本次没有 macOS/Linux 实机验证。

R1 静态检查：新增依赖为零；Host 不直接写 Controller.state / 私有状态；fake 脚本为 JSON 数据；凭证不传给 Agent/ToolRunner、不进入 Runtime 审计；Runtime 错误与 execution outcome 未加入协议枚举。旧代码只新增根导出与 npm demo 命令。

## 逐条 R2 证据

| 条款 | 可核验文件 / 测试 | 判断 |
|---|---|---|
| RT-01 冻结与兼容 | runtime-contract 的 `Protocol lifecycle and frozen files retain the M0 baseline`；旧 104 tests；check；旧 demo | PASS |
| RT-02 六端口与 manifest | 六个 factory contract suites；`manifest rejects missing ports, exaggerated capabilities and unavailable required capabilities` | PASS |
| RT-03 身份、作用域、版本 | workflow 的 forged Human、untrusted actor、absent credential、cross-task、wrong Delegation/workspace、stale version、revoked identity、different Codex、serialized Human approval 测试 | PASS |
| RT-04 CAS / 幂等 / 不可变 | MemoryStateStore 3 项；workflow 的 exact retry、concurrent requests、revocation replay；inspect 不暴露 Controller | PASS |
| RT-05 Controller 唯一入口 | `src/runtime/host-runtime.mjs` 公共方法映射；Agent candidate 不推进、freshness/authority block、conditional R3/Human acceptance 测试 | PASS |
| RT-06 Stop 与迟到结果 | running tool Stop、Agent cancellation failure、Codex resume 拒绝、Store fault 仍保留 Human Stop 测试 | PASS |
| RT-07 失败与未知效果 | FAILED_CLEAN / EFFECT_UNKNOWN / INTERRUPTED / thrown failure 四条路径；新 key 也不能重复 Operation；伪造成功退出码；Store failure 保存/故障关闭；恢复保留 Discovery scope | PASS |
| RT-08 Evidence 与 Review | hash/reference/scope、UNKNOWN preservation；R2 顺序/UNKNOWN、unverified text、missing Artifact、forged reviewer、unrecorded/cross-task Artifact、earlier Revision evidence、R3 role/run 测试 | PASS |
| RT-09 模拟闭环 | demo:runtime 经 fake deliberate + implement、fake tool、Artifact、R1/R2、route 到 DONE；Runtime/Protocol audit 都有效；operations=1 证明重复请求未再次执行 | PASS |
| RT-10 M1 范围 | manifest 全部生产能力 false；recoverTask 拒绝；无 SQLite/SDK/process runner/新协议状态；package 无依赖变更 | PASS |

## 已知边界与后续阶段

- 认证只使用宿主安装的测试会话，不能部署为生产登录系统。
- 每个 StateStore 只允许一个活跃 HostRuntime 写者；内存 CAS、幂等、租约与审计不跨重启。
- workspace 注册现有目录；不创建真实 worktree，不删除文件。租约到期拒绝工具执行，M1 没有自动重新取得租约的恢复流程。
- fake ToolRunner 不执行命令；cwd、allowlist、timeout、输出/资源上限仅为 contract 中的策略记录，不代表 OS 强制隔离。
- Artifact 哈希证明内容一致，不能把模拟输出或 Agent 自述证明为真实测试 PASS。
- fake R3 / 不同模拟 principal 只验证路由和权限；未执行真实独立 Agent R3。
- SQLite、事务提交、Inbox/Outbox、snapshot/event 重放、故障重启测试属于 M2；真实工具/隔离属于 M3；真实 Agent 与独立 R3/E2E 属于 M4。

本报告的 R1/R2 是实施者自检与可复现测试证据，不把本次代码标为已获得独立 R3。
