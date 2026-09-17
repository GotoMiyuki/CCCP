# CCCP 实现规范草案

状态：Implementation Draft，可修改的内部实现约定。对应 CCCP v1.0；不更改 Design Guide 冻结的协议语义。

## 1. 授权与实现范围

本次 Human 指令授权按 Design Guide 实现，并允许自主决定内部实现、目录组织、Schema 细节和测试方式。原始 Guide 保持不变。

本轮建立可运行、可测试的协议参考库及 Adapter / Bridge 接口。实际远端模型接线与具体 MCP 服务部署需要后续集成；此处不选择或依赖特定模型 SDK、CLI 调用格式或 Bridge 服务。

采用 Node.js ESM 和标准库，分成三层：

| 层 | 模块 | 职责 |
|---|---|---|
| Decision | `decision.mjs`, `authority.mjs` | Intent、Proposal、Human Approval、Specification、Delegation |
| Execution | `lifecycle.mjs`, `review.mjs`, `repository.mjs`, `context.mjs`, `adapter.mjs` | 执行状态、判断处理、Reality 同步、工具接口 |
| Transport | `bridge.mjs` | 已认证会话的消息过滤、路由、去重和日志 |
| 共用数据 | `contracts.mjs`, `audit.mjs` | Schema 校验、不可变快照和审计 |

## 2. Schema

`src/contracts.mjs` 是本实现的 Schema 源。运行 `npm run schemas` 导出 JSON Schema；`npm run check` 检查生成物是否与源码一致。

产物使用 JSON Schema Draft 2020-12 声明。运行时校验器仅实现本项目实际使用的关键字；不作为通用 JSON Schema 引擎使用，遇到不支持的关键字立即报错。日期时间采用带时区、可由 JavaScript 解析的 ISO 时间戳。输入为 JSON 数据。

| 文件 | 约束对象 |
|---|---|
| `core.schema.json` | 所有核心数据定义，位于 `$defs` |
| `specification.schema.json` | Objective 和七类可追踪条款 |
| `delegation.schema.json` | Human 授予的域、禁止域、路径 |
| `permissions.schema.json` | 操作权限布尔映射 |
| `project-profile.schema.json` | Repository、默认 Delegation、工具和 Review Policy |
| `message-envelope.schema.json` | 消息类型与对应 Payload 的联合类型 |
| `review-result.schema.json` | 结构化 Review 判断与证据 |
| `state-machine.schema.json` | 两类生命周期状态及 Revision 计数的数据形状 |
| `state-machine.json` | 状态、转移条件和两类生命周期的衔接说明 |

Schema 解决数据形状；引用有效性、当前状态、身份、审批来源、证据覆盖和权限在控制器中验证。合法 JSON **不等于**合法状态转移或获批 Decision。

文本字段必须包含非空白字符，不能用纯空格充当证据。运行时拒绝稀疏数组和无效日历日期；只解析自身定义的 Schema 名称和引用。导出的 Schema 与默认 Policy 常量不可变，Project Profile 仍通过独立数据配置。

### 核心对象

- `Decision` 保存 Goal、Selected Approach、Constraints、Non-goals、Trade-offs 与 Rejected Alternatives，引用 Intent / Proposal。
- `Specification` 引用 Decision，含 `objective`、`scope`、`constraints`、`non_goals`、`acceptance_criteria`、`invariants`、`expected_behavior`、`verification_criteria`。
- 每个 Specification 条款含 `id` 和 `text`；ID 在整个 Specification 内唯一。Acceptance / Verification 至少各一项，其他集合允许显式为空。
- Specification 必须原样保留 Decision 的 Constraints 和 Non-goals；进一步语义一致性由 Review 判断。
- `Delegation` 引用 Decision，并与 Specification 分开存储。
- 批准、Specification 与 Delegation 创建不可变快照。传输来的普通对象不能直接充当可执行的审批记录。

### 身份来源

核心 API 的 `actor` 是宿主提供的可信输入。真实集成必须从认证会话映射身份。测试中的 `{ role: 'human' }` 只是夹具，不是可部署的身份认证机制。

## 3. Decision Lifecycle

正常链路：`INTENT → PROPOSAL → DELIBERATION → DECISION_PENDING → APPROVED → SPECIFIED → DELEGATED`。

- Human 确认 Intent 与 Project Profile。
- Human / ChatGPT / Codex 可提出、讨论和提交候选方案。
- `approve` / `reject` 仅接受 Human。
- `specify` 可由参与者将批准的 Decision 转换为条款；不拥有改变 Decision 的权限。
- `delegate` 仅接受 Human。
- `block` 保存原阶段；Human 明确解决原因后恢复该阶段。

`DecisionLifecycle.directed(...)` 对应 Guide §32 的 Directed 模式：Human 直接提交已选定的 Decision、Specification、Delegation，创建真实审批记录。不会凭空补造 AI Deliberation。

Autonomous 模式中的内部实现策略通过已批准边界内的 `plan` / `begin` 执行；不会形成 AI 可批准高层 Decision 的旁路。

## 4. Delegation 与 Permissions

授权判定需要同时满足：

1. 操作不改变当前批准的 Decision。
2. 域位于默认内部实现空间，或被 Human Profile / Delegation 显式允许。
3. Profile / Delegation 未显式禁止该域。禁止优先。
4. 所有声明路径在 Delegation 路径内。
5. 所有要求的 Permission 为 `true`。

Profile 中的默认禁止域包含 Guide §9 的 Architecture / API / External Behavior / Scope / 新依赖 / 数据契约 / 重要功能删除 / 破坏性操作 / 发布流程 / 远程 Git 操作。Human 覆盖默认限制时，需要修改 Profile 中对应的禁止项并提供所需授权；单纯增加 `allowed` 不覆盖已有 `forbidden`。

默认必要内部实现仍可执行。若项目希望进一步收紧默认允许域，应显式列入 `forbidden`。权限缺省视为未授予。

路径采用仓库相对路径，`.` 代表整个仓库，不支持 glob；目录按路径段匹配。拒绝父级跳转、绝对路径、Windows 驱动器和替代数据流写法。Adapter 还检查现有祖先的实际路径，防止符号链接或 junction 跳出仓库。

操作的域与描述是宿主工具绑定的元数据。范围检查不能取代操作系统权限或针对任意代码的沙箱。

## 5. Execution Lifecycle

创建执行对象必须提供已进入 `DELEGATED` 的 `DecisionLifecycle`。Core 不接收从任意 JSON 恢复的“已批准”状态。

| API / 条件 | 转移 |
|---|---|
| `observe` | 在 DISCOVERY / REVISION 记录真实观察 |
| `plan` | DISCOVERY → IMPLEMENTATION_PLANNED；允许调整局部实施计划 |
| `begin`，Reality fingerprint 一致 | IMPLEMENTATION_PLANNED / REVISION → IMPLEMENTING |
| `report` | IMPLEMENTING → VERIFYING |
| R1 APPROVE 且有 PASS / evidence | VERIFYING → SPEC_REVIEW |
| R2 APPROVE 且全部条款有 PASS / evidence | SPEC_REVIEW → REVIEW_ROUTING |
| `route` | REVIEW_ROUTING → DONE 或 ARCHITECTURE_REVIEW |
| R3 APPROVE | ARCHITECTURE_REVIEW → DONE 或 HUMAN_ACCEPTANCE |
| Human `accept` | HUMAN_ACCEPTANCE → DONE |
| 可在当前 Decision 修正 | Review 阶段 → REVISION |
| 原 Decision 需要变化 | → REPLAN_PROPOSED，衔接 Decision Layer |
| 信息、权限或 Reality 不足 | → BLOCKED |

`IMPLEMENT_REPORT` 必须绑定当前 Specification 与 Discovery，报告 ID 不得复用，变更文件须位于已委托且已列入计划的路径中。Review 绑定当前 Report ID。

### Revision / Replan / Blocked

- **Revision** 保持 Decision：控制器在开始修订时递增计数，要求新的信息、状态或修正说明。
- **Replan** 创建可审计的 Change Proposal。新的 Decision、Specification 和 Delegation 必须经 Human 流程形成，才能调用 `adoptDecision` 回到 Discovery。
- **Blocked** 保存具体原因和原阶段。普通信息恢复回原阶段；Repository 异常要求新的 Discovery。Specification 冲突由 Human 明确解决或 Replan，不允许 AI 直接改条款。
- **Authority Block** 需要 Human 新授权；若仅 Delegation 改变且 Decision / Specification 完全相同，可 `replaceDelegation`，无需假装 Architecture 已改变。
- **Loop Protection** 不能用 `resume` 清零。Human 可明确 Override，或批准新的 Decision 周期。
- **Human Override** 可显式接受为 DONE 或终止为 BLOCKED；独立记录理由，保留实际 Review 状态，不伪造 PASS。

阻断原因按类别保留，新增原因不能覆盖未解决的权限、Specification 或 Loop Protection 要求。`blocked` 展示最新原因，`blocked_reports` 保留各类待解决报告。Human 终止另有 `human_stopped` 标记，Codex 不能通过补写 Block、`resume` 或 `requestReplan` 解除它。Human 明确恢复或批准新 Decision 时仍需满足其余未解决条件。

`replaceDelegation` 只解决授权原因；其他原因仍保持 BLOCKED，Loop Protection 不能借此被重置。已解决的当前 Change Proposal 从快照中清除，历史保留在审计中。

控制器快照提供 `state_version` 作为内部异步操作校验标记，不是新协议状态。旧操作返回时若版本已变化，结果不能推动当前任务。运行中的 Adapter 操作尚未结束时，Controller 拒绝提交完成报告或开始恢复 / 新授权执行；Human 的终止与 Override 仍可立即记录。

本参考 Profile 默认允许两次自动修订，同一失败出现两次即停止。Guide 中的数值是示例，这两个数值属于可调整的实现 Policy。

Revision 中途发生 Repository Block / rediscovery 仍保留修订义务、计数和失败历史。重复 Report / Review ID 不能用于重放旧审批。

## 6. Review Model

Review 数据采用 Guide §11.6 的判断名称：`APPROVE`、`REVISION_RECOMMENDED`、`REPLAN_RECOMMENDED`、`BLOCKED`。§16 的 `revise / replan` 概念映射到这两个 recommendation 值。

`validateReview` 与 `assessReview` 只返回判断。`ExecutionLifecycle.applyReview` 才根据当前状态、判断和 Policy 改变状态。Reviewer 没有实现器回调或自动重试入口。

- R1：默认 Codex，Human 也可执行。只批准 implementation verification。
- R2：默认 Codex；必须对 Objective 和所有七类条款给出 `requirement_id → status + evidence`。未知、不完整或空证据不能当作 PASS。
- R3：默认独立 ChatGPT，Human 也可执行；身份不得与当前实现者相同。只审批当前 Review Level，不会改变 Human Decision。

Router 读取 Profile、Report、操作域、Reality / Context 冲突和 R2 的架构判断。默认采用 Guide §11.4 的触发项。Unexpected Deviations 会触发计划偏离，非 low 风险要求 R3，架构判断未知默认触发独立 Review。Profile 可改变具体 trigger 集合、强制 R3 或要求 Human Acceptance。

Guide 允许按项目配置 Reviewer 与 Review Policy；本参考实现选用上述默认角色集合。不同执行角色需要在后续项目集成中提供明确 Human Policy，不能在未授权时伪装现有身份。

## 7. Reality 与 Context

Discovery 通过真实 Git 命令读取 branch / commit / status，并读取相关文件内容生成 fingerprint。指纹包含完整 porcelain 状态以及 `git ls-files --stage -z` 的暂存区对象信息，因此仅改变 staged 内容也能检测。支持普通目录、无提交仓库、detached HEAD、重命名和脏工作区。普通目录的 branch / commit 为 `null`，不虚构 commit。

`relatedPaths` 默认 `['.']`。遍历默认排除 `.git`、`node_modules`、`.cccp`、`coverage` 目录，不跟随符号链接。Fingerprint 覆盖观察范围内文件内容、链接目标及 Git 状态；不能代表未观察的外部依赖或整个运行环境。

文件内容按块流式哈希，避免整文件读取及 Base64 副本。指纹还包含文件 mode；读取前后检查文件身份、大小和修改信息，发现变化则拒绝此次观察。此检查不是操作系统层面的原子快照，也不锁定仓库。Fingerprint 是不透明实现值；升级后应重新 Discovery，不能把旧算法结果当作当前观察。

Architecture / Reuse 的观察说明和测试证据由宿主提供；未运行测试则保持 `unknown`。Discovery 不自动运行 Profile 的命令。执行前 Adapter 再次扫描以校验观察是否过期。Revision 的最新观察通过 `adapter.discover()` 更新。

Context 支持 `HUMAN_DECISION`、`AI_PROPOSAL`、`AI_INFERENCE`、`REPOSITORY_FACT`、`HISTORICAL_CONTEXT`。现有条目的种类不可重标记。Human Decision 条目必须引用真实获批记录并保存其精确序列化内容；AI 摘要应放在 AI 类型中。

没有 commit、来源 commit 不一致或显式 stale 时均要求 rediscovery。内容层面的架构冲突仍由 Discovery / Review 报告，不能单靠 commit 比较排除。

## 8. Audit 与恢复边界

批准、授权、状态转移、Review、Change Proposal、Context 更新和 Bridge 投递记录结构化事件。事件不可变，包含递增序号和前序哈希；可使用 `AuditLog.verify` 验证导出的链是否一致。

当前实现是单进程参考库。审计、控制器和会话状态不持久化；跨进程恢复、崩溃一致性和外部签名未实现。集成方不能把内存级去重称为跨重启 exactly-once，也不能从未验证的 Context 重建 Human 批准。
