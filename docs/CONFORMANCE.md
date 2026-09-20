# Guide → Implementation → Evidence

本表用于 R2 自检与后续独立 R3 审查，不把测试通过等同于 Human 对设计变更的批准。

| ID | Design Guide 要求 | 实现 | 自动验证证据 |
|---|---|---|---|
| AC-01 | §3、§5–7 Human 最终批准；Proposal / Consensus 不是 Decision | `decision.mjs` | `core.test.mjs`: Human approval is required; execution cannot begin from Proposal |
| AC-02 | §5 Decision / Specification / Delegation / Autonomy 分离 | 核心 Schema、审批快照、`authorize`、`begin` | execution requires approval; snapshots immutable; ordinary implementation remains autonomous |
| AC-03 | §8–9 Least Authority 与默认内部自主 | `authority.mjs` | 每个默认禁止域、显式 deny、权限与 scope 测试 |
| AC-04 | §10 Implementation Plan 可在边界内调整 | `plan` | 默认内部实现、非法计划阻断、文件范围测试 |
| AC-05 | §11 两类生命周期与 Review/Control 分离 | `DecisionLifecycle`, `ExecutionLifecycle`, `review.mjs` | review creation has no side effects; R1 alone cannot complete execution |
| AC-06 | §11.3–4、§15 R3 是条件 Review | `routeReview` | 所有默认 trigger、低风险快速路径、Profile 自定义、风险和偏离测试 |
| AC-07 | §12 Revision 保持 Decision；Replan 重新批准 | `applyReview`, `adoptDecision` | R1/R2 implementation failures revise; Replan waits for new Human Decision |
| AC-08 | §13、§30.6 BLOCKED 按原因恢复 | `block`, `resume`, `replaceDelegation` | Repository 重新观察；R2 原阶段恢复；越权不能自批恢复 |
| AC-09 | §14 Revision Budget / 同因检测 / 状态进展 | 私有计数、失败签名、进展记录 | revision budgets; repeated identical failure; progress required; rediscovery cannot bypass count |
| AC-10 | §15–16 R1 / R2 / R3 分层证据，UNKNOWN 合法 | `validateReview`, `assessReview` | R1 UNKNOWN；R2 覆盖 / UNKNOWN；独立 R3；旧 Report Review 拒绝 |
| AC-11 | §17、§28–29 越界显式 CHANGE_PROPOSAL | `checkOperation`, `report`, `requestReplan` | denied operation produces Change Proposal and BLOCKED |
| AC-12 | §18–19 Context 来源不可升级为权威 | `ContextStore` | inference cannot be promoted or paraphrased as Human Decision |
| AC-13 | §20–21 Repository / Git 是 Reality 来源 | `discover` | 真文件 fingerprint；Git 无提交 / dirty / clean / detached；重命名解析 |
| AC-14 | §22–23 Envelope / 核心消息语义 | `contracts.mjs`, `Bridge` | 版本、payload、身份、task / repository、schema 生成一致性 |
| AC-15 | §24–25 Bridge 不做架构 / 业务决策 | 独立 Transport API | AI DESIGN_DECISION 被拒；Human Decision 只转发；Bridge 无执行状态 |
| AC-16 | §26–27 Core 与 Project Profile 分离 | `Profile` Schema、`defaultProfile` | 自定义 trigger、权限覆盖、可选 Human Acceptance |
| AC-17 | §29 Auditability / No Self-Approval | `AuditLog`, Human guard, independent R3 | 审计篡改检测；AI 审批拒绝；R3 实现者隔离 |
| AC-18 | §32 Directed 模式 | `DecisionLifecycle.directed` | Human 直接设计，不伪造 Deliberation |
| AC-19 | §7、§15.6 Human Final Override | `override` | 显式接受 DONE，保留空 Review，不伪造 PASS |
| AC-20 | §35–36 非冻结实现层逐项落地 | Schema / State / Message / Delegation / Profile / Adapter / Bridge / Demo | schema source 一致性、Adapter 真文件集成、Bridge 并发去重 |

## 本次任务约束

| ID | 约束 | 证据 |
|---|---|---|
| C-01 | 不修改原始 Design Guide | 实现前后 SHA-256 相同，见实现报告 |
| C-02 | 不自行改变冻结 Core / Authority / Boundary / Review 语义 | 本表、实现规范、控制器与 M4 E2E；本轮源码的最终独立 R3 审查待按 [M4 R3 交接](M4_R3_HANDOFF.md) 执行 |
| C-03 | Schema、目录和测试方式属于授权内部实现空间 | Human 原始任务明确允许；新增文件均位于工作目录 |
| C-04 | 设计不能落地则 CHANGE_PROPOSAL / BLOCKED | 首版范围未发现必须改变 Guide 才能落地的冲突；运行时越权 / 不可继续路径有结构化输出 |

## 验证的实际边界

自动测试验证可执行规则，不能证明任意自然语言 Decision 与任意代码修改语义等价。M4 已以真实宿主完成独立 R3 provider、Docker 工具、Evidence 和跨进程恢复 E2E；证据见 [M4 E2E 报告](M4_E2E_REPORT.md)。对本轮整体设计和实现的独立源码审查仍待按 [M4 R3 交接](M4_R3_HANDOFF.md) 执行。

## 后续回归证据

新增 `tests/hardening.test.mjs`，对应以下已冻结要求的实现修复：

| 对应要求 | 回归场景 |
|---|---|
| AC-01、AC-03、AC-08、AC-09、AC-19 | 新 Block 不覆盖权限 / Specification / 循环阻断；Human 终止不能被 Codex 恢复或转入 Replan |
| AC-05、AC-09 | 多个 Adapter 共享锁和尝试记录；运行中操作禁止完成报告；旧异步结果不能推进任务 |
| AC-10、AC-14 | 纯空白证据、稀疏数组、非法日期和原型属性 Schema 名称被拒绝 |
| AC-13 | 工作区文件相同但暂存区内容不同，fingerprint 必须变化 |
| AC-16 | 默认 Policy 常量和 Schema 只读，避免被调用方意外修改 |

最新完整测试为 **103 PASS / 0 FAIL**。详见 [OPTIMIZATION_REPORT.md](OPTIMIZATION_REPORT.md)。
