# CCCP v1.0 Design Guide
## ChatGPT ↔ Codex Collaboration Protocol

**Status:** Draft for Review  
**Version:** 1.0  
**Scope:** General-purpose software engineering collaboration  
**Primary Participants:** Human, ChatGPT, Codex  
**Transport / Integration:** Bridge and/or MCP  
**Design Principle:** Human-governed, AI-assisted, bounded-autonomous execution

---

# 1. Purpose

CCCP（ChatGPT ↔ Codex Collaboration Protocol）定义一种通用的软件工程协作协议，用于协调：

- Human 对问题的意图、目标与最终决策；
- ChatGPT 对架构、设计、方案和取舍的讨论与推演；
- Codex 对真实代码仓库的分析、实现、验证与执行；
- Bridge / MCP 对上述参与者之间的信息与工具调用进行传输。

CCCP 的目标不是让 ChatGPT 直接“控制”Codex，也不是要求 Human 审批 AI 的每一个动作。

CCCP 所建立的是：

> **Human 决定边界与最终方向，ChatGPT 负责高层讨论与决策支持，Codex 在明确边界内自主执行。**

CCCP 应能够跨项目复用，而不依赖任何特定项目的 Agent 架构、编程语言、仓库组织方式或开发工具。

---

# 2. Scope

CCCP 主要解决以下问题：

1. Human 想做什么？
2. 当前问题有哪些可能方案？
3. 哪个方案最终被 Human 选择？
4. 这个决定具体意味着什么？
5. AI 被允许自行决定哪些实现细节？
6. AI 可以在什么范围内自主执行？
7. 当 AI 发现原方案不可行时，应该如何处理？
8. 如何避免 Codex “顺手修改”未被授权的内容？
9. 如何区分实现错误与架构决策错误？
10. 如何在 ChatGPT、Codex 和真实 Repository 之间保持上下文一致？

CCCP **不负责规定**：

- 特定项目的架构；
- 特定 LLM 的内部推理方式；
- Codex 的内部 Agent Loop；
- ChatGPT 的模型实现；
- Git 的具体实现方式；
- MCP 本身的协议细节。

---

# 3. Design Principles

## 3.1 Human retains final authority

Human 是所有高层决策的最终权威。

Human 可以：

- 确定 Intent；
- 接受、修改或否决 Proposal；
- 批准 Architecture / Design Decision；
- 定义 Delegation Boundary；
- 覆盖 AI 的建议；
- 在异常情况下直接终止任务。

因此：

> AI 的高置信度不等于 Human 的批准。  
> AI 之间的共识也不等于 Human 的批准。

即：

> **Consensus ≠ Approval**

---

## 3.2 AI autonomy is bounded, not absolute

CCCP 不把 AI 自主性理解为一个简单的 `0~100` 等级。

AI 的实际自主范围由以下因素共同决定：

\[
Autonomy = f(Delegation, Constraints, Permissions, Specification)
\]

其中：

- **Delegation**：AI 可以自行决定什么；
- **Constraints**：AI 必须遵守什么；
- **Permissions**：AI 可以对什么执行操作；
- **Specification**：AI 必须完成什么。

因此：

> **自主执行能力 ≠ 修改一切的权限。**

---

## 3.3 Not specified ≠ authorized

CCCP 的核心安全原则之一：

> **未明确指定，不等于已经获得授权。**

但是这并不意味着 Codex 对每一行代码都必须获得 Human 批准。

因此 CCCP 采用：

> **Least Authority + Default Implementation Autonomy**

即：

- 默认允许完成 Specification 所必需的普通实现细节；
- 默认不允许跨越 Decision Boundary；
- 一旦需要改变架构、目标、公开行为或授权边界，必须升级。

---

## 3.4 Repository is the source of reality

关于“系统现在实际上是什么样”：

> **Repository / Runtime Reality 优先于 AI 的记忆与上下文文档。**

ChatGPT 可以推测系统结构，但 Codex 应通过真实 Repository 验证。

因此：

- Context ≠ Reality；
- Documentation ≠ Reality；
- AI inference ≠ Reality。

如果文档与代码冲突，AI 不应静默选择一方并继续执行，而应报告冲突。

---

## 3.5 HITL is escalation, not a mandatory step

Human-in-the-loop 不应被设计为：

> 每一步都问 Human。

而应被设计为：

> **只有当 AI 的授权范围不足以继续安全执行时，才升级 Human。**

典型触发条件：

- Intent 不清楚；
- Decision 尚未形成；
- Specification 不充分；
- 发现架构冲突；
- 需要跨越 Delegation Boundary；
- 发现原方案不可实现；
- 发生高风险操作；
- 出现重复失败或无法收敛。

如果 Specification 已经充分明确，且 Delegation 足够，则应优先自主执行。

---

# 4. Participants and Roles

## 4.1 Human

Human 是：

**Final Decision Authority**

Human 负责：

- 定义或确认 Intent；
- 对关键方案进行选择；
- 形成最终 Decision；
- 指定 Specification；
- 定义 Delegation Boundary；
- 处理 AI 无法自主解决的冲突；
- 行使最终 Override 权。

Human 不需要亲自决定：

- 函数命名；
- 内部类结构；
- 普通重构方式；
- 测试文件组织；
- 局部算法实现方式；

除非这些事项已经超出 Delegation。

---

## 4.2 ChatGPT

ChatGPT 是：

**Deliberation Partner**

主要职责：

- 理解 Intent；
- 发现问题；
- 提出 Proposal；
- 分析替代方案；
- 进行架构讨论；
- 分析 trade-off；
- 识别 Specification 缺口；
- 审查设计一致性；
- 对 Codex 的 Change Proposal 进行分析；
- 协助 Human 形成最终 Decision。

ChatGPT **没有 Final Decision Authority**。

ChatGPT 可以强烈反对一个方案，但不能把自己的意见变成正式 Decision。

---

## 4.3 Codex

Codex 是：

**Autonomous Repository Executor**

主要职责：

- 观察真实 Repository；
- Discovery；
- 分析现有实现；
- 生成 Implementation Plan；
- 修改代码；
- 执行测试；
- 验证实现；
- 报告结果；
- 提出 Change Proposal。

Codex 可以在 Delegation 范围内自主选择实现策略。

但是：

> Codex 不得因为“认为更合理”而自行修改已经批准的 Architecture / Decision。

当实现需要跨越 Decision Boundary 时，Codex 必须升级。

---

## 4.4 Repository

Repository 是：

**Source of Reality**

Repository 是：

- 代码事实来源；
- 当前结构事实来源；
- Git 状态事实来源；
- 测试结果事实来源。

Repository 本身不是 Decision Authority。

---

## 4.5 Bridge

Bridge 是：

**Transport / Integration Layer**

Bridge 负责：

- 消息传输；
- Session 管理；
- Tool routing；
- 权限控制；
- 日志；
- 状态同步；
- 连接 ChatGPT 与本地 Codex。

Bridge：

> **不得自行做业务或架构决策。**

---

# 5. Core Concepts

CCCP v1.0 定义以下核心概念。

---

## 5.1 Intent

Intent = Human 想实现的目标。

Intent 回答：

> “我们到底想解决什么问题？”

Intent 不一定包含具体实现方式。

示例：

> 希望降低 Agent 系统中重复 Review 导致的执行时间。

这属于 Intent，而不是 Architecture。

---

## 5.2 Proposal

Proposal = AI 提出的候选方案。

Proposal 可以来自：

- ChatGPT；
- Codex；
- 其他授权 Agent。

Proposal：

- 可讨论；
- 可比较；
- 可修改；
- 可否决；

但：

> **Proposal 不具有绑定力。**

---

## 5.3 Deliberation

Deliberation = Human 与 AI 对 Proposal 进行分析、比较、质疑与 refinement 的过程。

核心目标：

\[
Proposal \rightarrow Better\ Understanding \rightarrow Decision
\]

Deliberation 可以持续多轮。

---

## 5.4 Decision

Decision = Human 最终批准的方案选择。

Decision 回答：

> “我们最终决定做什么？”

Decision 应至少包含：

- Goal；
- Selected Approach；
- Constraints；
- Non-goals；
- Important Trade-offs；
- Explicitly rejected alternatives。

只有 Human 明确批准后，Proposal 才可以成为 Decision。

---

## 5.5 Specification

Specification = 将 Decision 转换为可执行、可验证约束的表达。

Specification 回答：

> “什么才算真正实现了这个 Decision？”

应至少包含：

- Objective；
- Scope；
- Constraints；
- Non-goals；
- Acceptance Criteria；
- Invariants；
- Expected Behavior；
- Verification Criteria。

Decision 更偏向：

> Why / What

Specification 更偏向：

> Exactly what counts as correct.

---

## 5.6 Delegation

Delegation = Human 授予 AI 的决策空间。

例如：

> 允许 Codex 自行决定模块内部实现方式，但不得改变公共 API。

因此：

```text
Architecture        = Human-controlled
Public API          = Human-controlled
Internal structure  = Codex-delegated
Testing strategy    = Codex-delegated
Implementation      = Codex-delegated
```

Delegation 定义：

> **AI 可以自己决定什么。**

---

## 5.7 Autonomy

Autonomy = AI 在不再次询问 Human 的情况下执行已授权操作的能力。

Autonomy 不是独立于 Delegation 的额外授权。

它实际上是：

\[
Autonomy \subseteq Delegation + Permissions + Constraints
\]

因此：

> Delegation 决定“可以自己决定什么”；  
> Autonomy 决定“可以不再询问就执行什么”。

---

## 5.8 Reality

Reality = Repository / Runtime 当前真实状态。

Reality 包括：

- 当前代码；
- 当前 Git commit；
- 当前工作区；
- 真实依赖；
- 测试结果；
- 实际运行行为。

Reality 是动态的。

---

## 5.9 Context

Context = 为 Human / ChatGPT / Codex 提供共享、持久化上下文的结构化表示。

Context 可以包含：

- Intent；
- Decisions；
- Architecture；
- Known Issues；
- Repository Snapshot；
- Active Task；
- Constraints。

但是：

> **Context 是表示，不是最终权威。**

Context 中任何由 AI 推断产生的信息，都不能自动升级为 Human Decision。

---

# 6. Relationship Between Core Concepts

CCCP 的核心链路：

```text
Intent
  ↓
Proposal
  ↓
Deliberation
  ↓
Human Decision
  ↓
Specification
  ↓
Delegation
  ↓
Autonomy
  ↓
Execution
  ↓
Verification / Review
  ↓
Reality
  ↓
Context Update
```

其中四个最容易混淆的概念必须严格区分：

| Concept | 核心问题 |
|---|---|
| Decision | 我们最终决定做什么？ |
| Specification | 怎样才算完成？ |
| Delegation | AI 可以自行决定什么？ |
| Autonomy | AI 可以在什么情况下无需再次询问就执行？ |

---

# 7. Authority Model

CCCP 采用分层权威模型。

| Domain | Authority |
|---|---|
| Human Intent | Human |
| Final Design Decision | Human |
| Architecture Decision | Human |
| Delegation Boundary | Human |
| Repository Reality | Repository / Runtime |
| Architecture Proposal | ChatGPT / Codex |
| Implementation Strategy | Codex within Delegation |
| Implementation Verification | Codex |
| Design Review | ChatGPT |
| Final Override | Human |

因此：

### Human

拥有：

- Decision Authority；
- Intent Authority；
- Override Authority。

### ChatGPT

拥有：

- Advisory Authority；
- Deliberation Authority；
- Review Authority。

### Codex

拥有：

- Execution Authority；
- Repository Observation Authority；
- Implementation Decision Authority within Delegation。

---

# 8. Decision Boundary

CCCP 的核心安全边界是：

> **Decision Boundary**

Decision Boundary 划定：

```text
Approved Decision
        │
        ▼
Specification
        │
 ┌──────┴──────┐
 │             │
Delegated    Non-delegated
Space        Space
 │             │
 ▼             ▼
Codex may     Escalate
decide        to Human
```

Codex 可以在 Delegated Space 内自由选择 implementation strategy。

Codex 不可以通过“实现选择”间接修改 Non-delegated Space。

---

# 9. Default Delegation

为了避免两种极端：

### 极端 A

Codex 可以随意修改任何东西。

结果：

> uncontrolled autonomy

### 极端 B

Codex 每个实现细节都必须询问 Human。

结果：

> AI 退化成代码输入工具。

CCCP v1.0 采用默认策略：

## Default Allowed

默认允许：

- 普通内部实现；
- 局部重构；
- 函数 / 类内部结构调整；
- 测试实现；
- 必要的代码整理；
- 满足 Specification 所必需的局部修改；
- Implementation Plan 的生成与调整。

## Default Not Allowed

默认不允许：

- 改变 Architecture Decision；
- 改变核心系统边界；
- 改变 Public API；
- 改变 External Behavior；
- 扩大任务 Scope；
- 引入未经授权的新外部依赖；
- 改变数据模型 / 协议契约；
- 删除重要功能；
- 进行破坏性操作；
- 修改正式 Git 发布流程；
- Push 到远程仓库。

这些规则可以由 Project Profile 覆盖。

---

# 10. Architecture Plan vs Implementation Plan

CCCP 明确区分两个层次。

## 10.1 Architecture Plan

回答：

> 系统应该怎么设计？

形成方式：

```text
Human
  ↕
ChatGPT
  ↓
Architecture Proposal
  ↓
Human Approval
  ↓
Architecture Decision
```

Architecture Plan 必须得到 Human 批准。

---

## 10.2 Implementation Plan

回答：

> 如何在 Repository 中实现已经批准的设计？

Codex 可以：

- 自行生成；
- 自行调整；
- 自行优化；

前提是：

> 不越过 Specification 与 Delegation Boundary。

因此 Human 不必给 Codex 一份包含每个文件、每个函数具体改法的“施工图”。

---

# 11. Execution Lifecycle

CCCP 不使用一个巨大状态机来同时描述“决策形成”和“代码执行”。

而采用两个相互连接的生命周期：

- **Decision Lifecycle**：负责形成 Human-approved Decision、Specification 与 Delegation；
- **Execution Lifecycle**：负责在批准边界内完成 Discovery、Implementation、Verification 与 Review。

Review 是 Execution Lifecycle 中的质量判断机制，但 **Reviewer 本身不拥有状态机控制权**。

> **Review produces judgment; the Lifecycle Controller determines transition.**

---

## 11.1 Decision Lifecycle

```text
INTENT
  ↓
PROPOSAL
  ↓
DELIBERATION
  ↓
DECISION_PENDING
  ↓
APPROVED
  ↓
SPECIFIED
  ↓
DELEGATED
```

异常：

```text
DELIBERATION → BLOCKED
DECISION_PENDING → REJECTED
```

---

## 11.2 Execution Lifecycle

Execution Lifecycle 的正常路径为：

```text
DISCOVERY
   ↓
IMPLEMENTATION_PLANNED
   ↓
IMPLEMENTING
   ↓
VERIFYING
   │
   │ R1: Implementation Verification
   ↓
SPEC_REVIEW
   │
   │ R2: Specification Compliance Review
   ↓
REVIEW_ROUTING
   │
   ├── Architecture Review Not Required
   │        ↓
   │       DONE
   │
   └── Architecture Review Required
            ↓
      ARCHITECTURE_REVIEW
            │
            │ R3: Decision / Architecture Review
            ↓
           DONE
```

其中：

- **R1** 主要由 Codex 执行；
- **R2** 主要由 Codex 执行；
- **R3** 主要由 ChatGPT 执行；
- Human 保留最终 Override Authority。

---

## 11.3 Review Routing

并非所有任务都必须进入 ChatGPT Architecture Review。

在 R2 通过后，系统进入 `REVIEW_ROUTING`。

Review Router 根据当前任务的：

- Specification；
- Delegation Boundary；
- Change Scope；
- Risk；
- Project Profile；
- Implementation Report；
- Unexpected Deviations；

判断是否需要独立的 Decision / Architecture Review。

低风险且完全处于 Delegation Boundary 内的任务可以：

```text
R1 PASS
   ↓
R2 PASS
   ↓
REVIEW_ROUTING
   ↓
R3 NOT REQUIRED
   ↓
DONE
```

架构敏感任务则：

```text
R1 PASS
   ↓
R2 PASS
   ↓
REVIEW_ROUTING
   ↓
R3 REQUIRED
   ↓
ChatGPT Architecture Review
   ↓
DONE / REVISION / REPLAN / BLOCKED
```

Review Routing 的目的不是减少 Review 质量，而是避免：

> 对低风险、机械性、已经充分验证的修改进行没有额外信息价值的重复 Review。

---

## 11.4 Review Escalation Triggers

以下情况原则上应触发 R3：

- Architecture-sensitive change；
- 跨模块职责调整；
- Public API / Contract 相关修改；
- 接近 Delegation Boundary 的实现；
- Implementation 与原计划出现显著偏离；
- Codex 无法高置信度判断 Decision compliance；
- Repository Reality 与 Context / Architecture 描述发生冲突；
- Project Profile 明确要求独立 Architecture Review。

Project Profile 可以增加、删除或强化具体 Trigger。

对于特别重要的任务，还可以规定：

```text
R1
 ↓
R2
 ↓
R3
 ↓
HUMAN_ACCEPTANCE
 ↓
DONE
```

但 Human Acceptance 不应成为所有任务的固定步骤。

---

## 11.5 Failure Transitions

### Implementation Failure

```text
VERIFYING
   ↓
REVISION
   ↓
IMPLEMENTING
```

例如：

- compilation failure；
- test failure；
- runtime error；
- static check failure。

---

### Specification Failure

如果实现未满足 Specification，但原 Decision 仍然有效：

```text
SPEC_REVIEW
   ↓
REVISION
   ↓
IMPLEMENTING
```

---

### Architecture / Decision Conflict

如果 R3 发现实现发生 architecture drift，但可以在当前 Decision 下修正：

```text
ARCHITECTURE_REVIEW
   ↓
REVISION
   ↓
IMPLEMENTING
```

如果发现原 Decision / Architecture 本身需要改变：

```text
ARCHITECTURE_REVIEW
   ↓
REPLAN_PROPOSED
   ↓
DECISION_PENDING
```

---

### Blocked

任何阶段如果发现：

- 信息不足；
- 权限不足；
- Specification 冲突；
- Repository 状态无法安全处理；
- 无法在 Delegation Boundary 内继续；

则：

```text
Any State
   ↓
BLOCKED
```

---

## 11.6 Review and Control Separation

Reviewer 不直接执行状态转移。

Reviewer 输出：

```text
APPROVE
REVISION_RECOMMENDED
REPLAN_RECOMMENDED
BLOCKED
```

Lifecycle Controller 根据：

- Review Result；
- 当前状态；
- Revision Budget；
- Delegation；
- Project Policy；

决定真正的状态转移。

因此：

```text
Reviewer
   ↓
Judgment
   ↓
Lifecycle Controller
   ↓
State Transition
```

而不是：

```text
Reviewer
   ↓
直接再次调用 Implementer
   ↓
再次 Review
   ↓
无限循环
```

---

# 12. Revision vs Replan

这是 CCCP 中非常重要的区别。

## REVISION

意味着：

> Decision 没错，Implementation 有问题。

例如：

- Bug；
- 测试失败；
- 局部逻辑错误；
- 边界条件遗漏；
- 实现与 Specification 不一致。

处理：

```text
VERIFY
 ↓
REVISION
 ↓
IMPLEMENT
```

不需要重新讨论 Architecture。

---

## REPLAN

意味着：

> 原来的 Decision / Architecture 已经无法继续。

例如：

- 关键假设错误；
- Repository 现实与设计严重冲突；
- 原接口无法满足需求；
- 现有架构无法实现 Specification；
- 需要改变公共行为。

Codex 可以：

> **提出 Replan Proposal**

但不得：

> **自行执行 Replan。**

流程：

```text
Codex
  ↓
CHANGE_PROPOSAL
  ↓
ChatGPT Deliberation
  ↓
Human Decision
  ↓
New Specification
  ↓
Implementation
```

---

# 13. BLOCKED State

当 AI 无法在当前授权范围内继续时，应进入：

> `BLOCKED`

典型原因：

- 缺失必要信息；
- Decision 不明确；
- Specification 冲突；
- Repository 状态异常；
- 权限不足；
- 架构不可实现；
- 高风险操作需要授权；
- 重复 Revision 无法解决。

BLOCKED 不等于失败。

它表示：

> “在当前 Decision + Specification + Delegation 下，我无法安全继续。”

---

# 14. Loop Protection

AI 系统必须防止无限循环。

CCCP 要求至少考虑：

### Revision Budget

例如：

```text
max_revision_attempts = 2
```

超过后：

```text
REVISION → REPLAN_PROPOSED
```

或：

```text
REVISION → BLOCKED
```

### Repeated Failure Detection

如果多次 Revision：

- 失败原因相同；
- Contract violation 相同；
- Test failure 相同；

系统不应继续盲目重试。

### State Progress Guarantee

任何 loop 都应满足：

> 每次重新执行都必须产生新的信息、状态或解释。

不允许：

```text
review
→ same failure
→ same patch
→ same review
→ same failure
```

无限循环。

---

# 15. Review Protocol

CCCP 使用：

> **Hierarchical, risk-triggered review model**

Review 分为三个层级：

```text
R1 — Implementation Verification
R2 — Specification Compliance Review
R3 — Decision / Architecture Review
```

三个层级检查不同的问题，不应机械重复彼此的工作。

---

## 15.1 R1 — Implementation Verification

**Primary Executor:** Codex

核心问题：

> **“实现本身是否能够正确工作？”**

主要检查：

- Compilation；
- Unit Tests；
- Integration Tests；
- Runtime Behavior；
- Static Analysis；
- Type Checking；
- Lint；
- Expected Outputs；
- Project-specific Verification Commands。

R1 是最接近 Repository Reality 的 Review 层。

原则：

> **Claims about implementation correctness should be grounded in executable evidence whenever possible.**

R1 失败通常属于：

> `IMPLEMENTATION_FAILURE`

默认结果：

```text
REVISION_RECOMMENDED
```

---

## 15.2 R2 — Specification Compliance Review

**Primary Executor:** Codex

核心问题：

> **“当前实现是否满足已经批准的 Specification？”**

Codex 应根据：

- Acceptance Criteria；
- Constraints；
- Invariants；
- Non-goals；
- Scope；
- Delegation Boundary；

逐项检查实现。

R2 不应只输出：

```text
Specification satisfied.
```

而应尽可能建立：

> **Requirement → Evidence**

映射。

例如：

```text
AC-01: PASS
Requirement:
Maximum automatic revision attempts = 2.

Evidence:
src/controller.py
tests/test_controller.py::test_revision_budget


AC-02: PASS
Requirement:
Reviewer must support REPLAN.

Evidence:
ReviewDecision.REPLAN
tests/test_reviewer.py::test_replan_result


C-01: PASS
Requirement:
Public API must remain unchanged.

Evidence:
No public interface changes detected.
```

如果某项无法验证，应标记：

```text
UNKNOWN
```

而不是假设：

```text
PASS
```

R2 失败通常属于：

> `SPECIFICATION_COMPLIANCE_FAILURE`

如果 Decision 本身仍然有效：

```text
REVISION_RECOMMENDED
```

如果 Codex 发现 Specification 本身不可满足，则不应自行改变 Specification，而应：

```text
REPLAN_RECOMMENDED
```

或：

```text
BLOCKED
```

---

## 15.3 R3 — Decision / Architecture Review

**Primary Executor:** ChatGPT  
**Execution:** Conditional

核心问题：

> **“实现是否仍然符合 Human 真正批准的 Decision 与 Architecture，而不仅仅满足 Specification 的字面要求？”**

主要检查：

- Decision compliance；
- Architecture compliance；
- Responsibility boundaries；
- Architectural invariants；
- Scope creep；
- Design drift；
- Hidden behavior changes；
- Trade-off preservation；
- Non-goal violations；
- Implementation 是否通过局部正确性绕过了高层设计意图。

例如：

Human Decision：

```text
Extend Reviewer so it can express REPLAN.
Do not move planning responsibility into Reviewer.
```

Codex 的实现：

```text
Reviewer
 ├─ review()
 ├─ generate_replan()
 ├─ decompose_task()
 └─ route_agents()
```

即使：

```text
Tests = PASS
Specification checks = mostly PASS
```

R3 仍可能发现：

> Reviewer 已经吸收 Planner / Orchestrator 的职责，产生 Architecture Drift。

因此：

```text
R3 → REVISION_RECOMMENDED
```

或者在无法保持原 Decision 的情况下：

```text
R3 → REPLAN_RECOMMENDED
```

---

## 15.4 R3 Is Not Universally Mandatory

ChatGPT Architecture Review 不应成为所有任务的固定步骤。

例如：

```text
Update README command
Fix typo
Rename private variable
Add missing unit test
Small delegated internal refactor
```

如果：

- R1 PASS；
- R2 PASS；
- 未触发 Architecture Review 条件；

则可以直接：

```text
DONE
```

而无需把任务再次发送给 ChatGPT。

因此：

> **Independent review is required when it adds decision-level information, not merely because another model is available.**

---

## 15.5 Self-Verification vs Independent Review

CCCP 区分：

### Self-Verification

Codex：

```text
Implement
   ↓
R1
   ↓
R2
```

属于 Executor 对自己工作的结构化验证。

---

### Independent Review

ChatGPT：

```text
R3
```

作为与具体 implementation process 相对独立的 Decision / Architecture reviewer。

CCCP 不要求：

> 每一次 Codex 修改都必须由另一个模型重新检查。

而采用：

> **Local verification first; independent review when justified.**

---

## 15.6 Human Review

Human 不承担普通 implementation review 的固定职责。

Human 主要处理：

- Final Decision；
- Architecture Decision；
- Delegation changes；
- REPLAN；
- Boundary-crossing Change Proposal；
- High-risk approval；
- Final Override。

对于 Project Profile 明确规定的重大任务，可以要求：

```text
R3 PASS
   ↓
HUMAN_ACCEPTANCE
   ↓
DONE
```

否则 Human 不应成为流水线瓶颈。

---

## 15.7 Review Authority

Review 的执行者拥有：

> **Assessment Authority**

但不自动拥有：

> **Transition Authority**

因此：

```text
Reviewer:
"I recommend REVISION."
```

并不等价于：

```text
Reviewer:
"Immediately start another implementation cycle."
```

实际 transition 由 Lifecycle Controller 根据 Policy 决定。

这一原则适用于：

- Codex R1；
- Codex R2；
- ChatGPT R3。

---

# 16. Review Result

Review Result 必须是：

> **Structured, evidence-based, and actionable**

Review 不应只返回自然语言评价。

---

## 16.1 Conceptual Review Result

CCCP v1.0 推荐以下概念结构：

```json
{
  "review_level": "R1 | R2 | R3",
  "reviewer": "codex | chatgpt | human",
  "decision": "approve | revise | replan | blocked",
  "confidence": 0.0,

  "findings": [],
  "evidence": [],
  "failed_requirements": [],

  "implementation_status": "pass | fail | unknown",
  "specification_compliance": "pass | fail | unknown",
  "architecture_compliance": "pass | fail | unknown",

  "boundary_violation": false,
  "reason": ""
}
```

具体机器可读 Schema 留待 Implementation Specification 冻结。

---

## 16.2 Evidence Requirement

Review Result 应尽可能包含 Evidence。

Evidence 可以包括：

- file；
- symbol；
- diff；
- test；
- command output；
- runtime observation；
- Specification clause；
- Decision reference；
- Architecture invariant。

例如：

```text
Finding:
Revision budget is correctly enforced.

Evidence:
src/loop/controller.py: LoopController
tests/test_loop.py::test_revision_budget
pytest: PASS
```

Review 的目标不是增加文字长度，而是提高：

> **Traceability**

---

## 16.3 UNKNOWN Is Valid

Reviewer 不得因为缺少证据而默认：

```text
PASS
```

应允许：

```text
UNKNOWN
```

例如：

```text
architecture_compliance: unknown
```

这可能触发：

- additional discovery；
- R3；
- BLOCKED；
- Human clarification。

因此：

> **Unknown is information; fabricated confidence is not.**

---

## 16.4 Review Decision Semantics

### APPROVE

表示：

> 当前 Review Level 未发现阻止任务继续的问题。

注意：

```text
R1 APPROVE
```

只代表 implementation verification 通过。

它不自动意味着：

```text
R2 PASS
R3 PASS
Human Approval
```

---

### REVISE

表示：

> 当前 Decision / Architecture 仍然成立，但 implementation 需要修正。

通常：

```text
REVISE
   ↓
Lifecycle Controller
   ↓
REVISION
   ↓
IMPLEMENTING
```

---

### REPLAN

表示：

> 当前问题无法仅通过 implementation revision 正确解决，可能需要改变 Decision / Architecture / Specification。

Reviewer 只能提出：

```text
REPLAN_RECOMMENDED
```

不能自行批准新 Decision。

随后：

```text
Lifecycle Controller
   ↓
REPLAN_PROPOSED
   ↓
DECISION_PENDING
   ↓
Human + ChatGPT Deliberation
```

---

### BLOCKED

表示：

> 当前信息、权限、环境或约束不足以继续安全执行。

例如：

- missing information；
- permission denied；
- conflicting specification；
- repository unavailable；
- authority boundary exceeded。

---

## 16.5 Review Result Does Not Control the Loop

Review Result 是：

> **Judgment**

而不是：

> **Control instruction**

因此：

```text
Review Result
     ↓
Lifecycle Controller
     ↓
Policy Evaluation
     ↓
State Transition
```

Lifecycle Controller 应考虑：

```text
review_result
current_state
revision_count
failure_history
delegation
risk
project_profile
```

再决定下一状态。

这也是 Loop Protection 的基础。

---

# 17. Change Proposal

任何试图跨越 Decision Boundary 的行为，都必须转换为：

> `CHANGE_PROPOSAL`

例如：

```text
Current Decision:
Do not add new agents.

Codex discovers:
Existing architecture cannot satisfy requirement.

Invalid behavior:
"Add another agent."

Valid behavior:
CHANGE_PROPOSAL:
"Current architecture cannot satisfy X.
Adding component Y would solve it.
Trade-offs: A / B / C."
```

这样：

> Codex 可以发现问题，但不能偷偷改变规则。

---

# 18. Context Protocol

推荐 Repository 内建立专门的 AI Context 区域，例如：

```text
docs/
└── ai/
    ├── SNAPSHOT.md
    ├── ARCHITECTURE.md
    ├── DECISIONS.md
    ├── ACTIVE_TASK.md
    ├── KNOWN_ISSUES.md
    └── ...
```

这些文件不是硬性规定，而是 Recommended Convention。

Context 应尽可能记录：

```text
source_commit
updated_at
generated_by
status
```

例如：

```yaml
source_commit: abc123
generated_by: codex
status: current
```

当：

```text
Repository HEAD != source_commit
```

Context 可能已经过期。

此时 Codex 应重新 Discovery，而不是无条件相信旧 Context。

---

# 19. Context Authority Rule

Context 可以保存：

- Human Decision；
- AI Proposal；
- Repository Snapshot；
- Historical Information。

但必须能够区分它们。

建议至少区分：

```text
HUMAN_DECISION
AI_PROPOSAL
AI_INFERENCE
REPOSITORY_FACT
HISTORICAL_CONTEXT
```

其中：

> `AI_INFERENCE` 永远不能自动升级为 `HUMAN_DECISION`。

---

# 20. Repository Discovery

Codex 在进入 Implementation 前，应能够回答：

1. 当前 branch 是什么？
2. 当前 commit 是什么？
3. Working tree 是否 dirty？
4. 与任务相关的文件有哪些？
5. 当前架构实际上是什么？
6. 当前测试状态是什么？
7. 是否存在与 Context 冲突的 Reality？
8. 是否存在已有实现可以复用？

因此 Discovery 是：

> **Execution 前的 Reality Synchronization。**

---

# 21. Git Protocol

CCCP 不强制规定具体 Git workflow，但应至少能够记录：

```text
repository
branch
base_commit
current_commit
working_tree_status
changed_files
```

默认原则：

### Allowed

Codex 可以根据 Delegation：

- 创建修改；
- 创建本地 commit；
- 运行 diff；
- 检查历史。

### Restricted

默认需要明确授权：

- Push；
- Force Push；
- 修改远程分支；
- 删除远程分支；
- 破坏性 Git 操作。

Git 权限最终由 Project Profile 决定。

---

# 22. Communication Model

CCCP 消息应至少包含统一 Envelope。

概念结构：

```json
{
  "protocol": "CCCP",
  "version": "1.0",
  "message_type": "...",
  "message_id": "...",
  "task_id": "...",
  "timestamp": "...",
  "repository": {
    "path": "...",
    "branch": "...",
    "commit": "..."
  },
  "payload": {}
}
```

建议增加：

```text
request_id
parent_message_id
idempotency_key
```

以支持：

- 重试；
- 去重；
- Session tracking；
- Message lineage；
- Bridge failure recovery。

---

# 23. Message Types

CCCP v1.0 建议保留以下核心消息类型：

```text
DISCOVERY_REQUEST
DISCOVERY_REPORT

DESIGN_PROPOSAL
DECISION_REQUEST
DESIGN_DECISION

IMPLEMENT_REQUEST
IMPLEMENT_REPORT

REVIEW_REQUEST
REVIEW_RESULT

CHANGE_PROPOSAL
REPLAN_PROPOSAL

BLOCKED_REPORT
```

具体 Payload Schema 不在本 Design Guide 中冻结。

---

# 24. Three-Layer Architecture

CCCP 应明确分为三层。

## Layer 1 — Decision Layer

处理：

```text
Intent
Proposal
Deliberation
Decision
Specification
Delegation
```

参与者：

```text
Human + ChatGPT
```

---

## Layer 2 — Execution Layer

处理：

```text
Discovery
Plan
Implement
Verify
Review
Revision
Replan
Done
Blocked
```

参与者：

```text
Codex + ChatGPT + Human as required
```

---

## Layer 3 — Transport Layer

处理：

```text
Bridge
MCP
Session
Messages
Permissions
Tools
Logging
```

原则：

> Transport Layer 不得改变 Decision Layer 的语义。

---

# 25. Bridge Boundary

Bridge 的职责是：

```text
ChatGPT
   ↕
Bridge
   ↕
Codex
   ↕
Repository
```

Bridge 可以：

- 转发请求；
- 暴露工具；
- 管理认证；
- 管理 Session；
- 过滤权限；
- 保存日志。

Bridge 不应：

- 自己解释 Intent；
- 自己修改 Architecture；
- 自己批准 Change Proposal；
- 自己扩大 Delegation。

换言之：

> **Bridge 是管道，不是决策者。**

---

# 26. Project Profile

CCCP Core 不应包含具体项目规则。

项目差异通过：

> **Project Profile**

表达。

例如：

```yaml
project:
  name: example-project

repository:
  default_branch: main

delegation:
  allowed:
    - internal_implementation
    - test_structure
    - local_refactor

  forbidden:
    - architecture_change
    - public_api_change
    - scope_expansion
    - new_dependency

permissions:
  push: false

verification:
  commands:
    - pytest
    - mypy

context:
  path: docs/ai/
```

不同仓库可以拥有不同 Profile。

---

# 27. Core vs Project Profile

## CCCP Core

定义：

- Concepts；
- Authority；
- Decision Model；
- Delegation Model；
- State Model；
- Review Model；
- Conflict Handling；
- Message Semantics。

Core 应尽可能稳定。

---

## Project Profile

定义：

- Repository；
- Languages；
- Tools；
- Tests；
- Context Files；
- Default Delegation；
- Permission Rules；
- Project-specific Constraints。

Profile 可以变化。

---

# 28. Failure Handling

CCCP 必须区分至少四类 Failure。

## 28.1 Implementation Failure

Decision 正确，实现错误。

→ `REVISION`

---

## 28.2 Specification Failure

Specification 不完整或有歧义。

→ `BLOCKED` / `DECISION_PENDING`

---

## 28.3 Architecture Failure

Architecture 无法满足目标。

→ `REPLAN_PROPOSED`

---

## 28.4 Authority Failure

AI 试图执行超出权限的操作。

→ `AUTHORITY_BOUNDARY_EXCEEDED`

然后：

```text
CHANGE_PROPOSAL
        ↓
Human / ChatGPT Deliberation
```

---

# 29. Security Principles

CCCP 的安全模型应遵循：

## Least Authority

AI 只拥有完成任务所需的最低权限。

## Explicit Escalation

越过 Boundary 必须显式升级。

## No Silent Scope Expansion

AI 不得默默扩大任务范围。

## No Self-Approval

提出 Change Proposal 的 AI 不应自行批准该 Proposal。

## Reality Verification

涉及 Repository 的重要判断应尽可能由真实 Repository 验证。

## Auditability

重要 Decision、Change Proposal、Revision 和 Replan 应能够追溯。

---

# 30. Canonical Workflow

CCCP 的标准工作流采用：

> **Decision Formation → Bounded Execution → Hierarchical Review → Escalation when necessary**

---

## 30.1 Full Workflow

```text
                         HUMAN
                           │
                        Intent
                           │
                           ▼
                 ┌───────────────────┐
                 │    ChatGPT        │
                 │   Deliberation    │
                 └─────────┬─────────┘
                           │
                     Design Proposal
                           │
                           ▼
                    Human Decision
                           │
                           ▼
                    Specification
                           │
                           ▼
                      Delegation
                           │
═══════════════════════════╪══════════════════════════
       Decision Layer      │       Execution Layer
                           ▼
                    Codex Discovery
                           │
                           ▼
                 Implementation Plan
                           │
                           ▼
                    Implementation
                           │
                           ▼
              ┌────────────────────────┐
              │ R1                     │
              │ Implementation         │
              │ Verification           │
              │                        │
              │ Codex                  │
              └───────────┬────────────┘
                          │
                 FAIL ────┼──── PASS
                   │      │
                   ▼      ▼
               REVISION   R2
                      Specification
                         Review
                         Codex
                           │
                  FAIL ───┼──── PASS
                    │     │
                    ▼     ▼
               REVISION   REVIEW_ROUTING
                               │
                    ┌──────────┴──────────┐
                    │                     │
              R3 NOT REQUIRED        R3 REQUIRED
                    │                     │
                    ▼                     ▼
                  DONE          ┌─────────────────┐
                                │ R3              │
                                │ Decision /      │
                                │ Architecture    │
                                │ Review          │
                                │ ChatGPT         │
                                └────────┬────────┘
                                         │
                       ┌─────────────────┼─────────────────┐
                       │                 │                 │
                    APPROVE           REVISE            REPLAN
                       │                 │                 │
                       ▼                 ▼                 ▼
                     DONE           REVISION       REPLAN_PROPOSED
                                         │                 │
                                         ▼                 ▼
                                  IMPLEMENTING       DELIBERATION
                                                           │
                                                           ▼
                                                    Human Decision
                                                           │
                                                           ▼
                                                 New Specification
                                                           │
                                                           ▼
                                                     Implementation
```

---

## 30.2 Low-Risk Fast Path

对于：

- 明确；
- 局部；
- 低风险；
- 完全位于 Delegation Boundary 内；

的任务：

```text
Specification
     ↓
Codex
     ↓
Implement
     ↓
R1 Verify
     ↓
R2 Spec Review
     ↓
PASS
     ↓
DONE
```

这是 CCCP 的默认高效率路径。

---

## 30.3 Architecture-Sensitive Path

对于架构敏感任务：

```text
Human Decision
      ↓
Specification
      ↓
Delegation
      ↓
Codex
      ↓
Implementation
      ↓
R1
      ↓
R2
      ↓
REVIEW_ROUTING
      ↓
R3 REQUIRED
      ↓
ChatGPT
      ↓
APPROVE
      ↓
DONE
```

---

## 30.4 Revision Path

如果实现有问题，但 Decision 仍然正确：

```text
R1 / R2 / R3
      ↓
REVISION_RECOMMENDED
      ↓
Lifecycle Controller
      ↓
Revision Budget Check
      ↓
IMPLEMENTING
      ↓
R1
      ↓
...
```

如果重复出现相同失败：

```text
Repeated Failure
      ↓
Loop Protection
      ↓
REPLAN_PROPOSED
      or
BLOCKED
```

---

## 30.5 Replan Path

如果发现原 Decision / Architecture 无法继续：

```text
Codex / ChatGPT
      ↓
REPLAN_RECOMMENDED
      ↓
Lifecycle Controller
      ↓
REPLAN_PROPOSED
      ↓
ChatGPT + Human
   Deliberation
      ↓
Human Decision
      ↓
New Specification
      ↓
New Delegation
      ↓
Codex Execution
```

Codex 可以提出新的方案，但：

> **不得自行批准并执行跨越原 Decision Boundary 的新架构。**

---

## 30.6 Blocked Path

任何阶段都可以：

```text
Any State
    ↓
BLOCKED
```

然后根据 Block 原因：

```text
BLOCKED
   │
   ├── Missing Information
   │        ↓
   │      Human
   │
   ├── Specification Conflict
   │        ↓
   │   Deliberation
   │
   ├── Authority Boundary
   │        ↓
   │  Change Proposal
   │
   └── Repository / Environment Problem
            ↓
       Resolve Reality
```

解决后从适当状态恢复，而不是默认从头执行整个任务。

---

## 30.7 Canonical Review Principle

CCCP 的标准 Review 原则最终归纳为：

```text
Repository Reality
        ↑
      Codex
 ┌───────────────┐
 │ R1 Verify     │
 │ R2 Spec Check │
 └───────┬───────┘
         │
    Review Router
         │
         │ when required
         ▼
      ChatGPT
 ┌──────────────────┐
 │ R3 Decision /    │
 │ Architecture     │
 └────────┬─────────┘
          │
          │ escalation when required
          ▼
        Human
 ┌──────────────────┐
 │ Final Authority  │
 └──────────────────┘
```

因此 CCCP 不采用：

> **Every change must be reviewed by every participant.**

而采用：

> **Verify locally, review against specification, escalate independent review according to risk and authority boundaries.**

其最终目标是在以下四者之间取得平衡：

**Correctness × Architectural Integrity × Autonomy × Efficiency**

---

# 31. Example

假设 Human 提出：

> “希望减少系统中 Agent 重复 Review 导致的运行时间。”

---

## Step 1 — Intent

```text
INTENT:
Reduce redundant review cycles and execution cost.
```

---

## Step 2 — Proposal

ChatGPT：

```text
Proposal A:
Introduce explicit review state transitions.

Proposal B:
Reduce reviewer sensitivity.

Proposal C:
Introduce revision budget and failure classification.
```

---

## Step 3 — Deliberation

Human + ChatGPT 比较：

- correctness；
- complexity；
- maintainability；
- failure modes；
- compatibility。

---

## Step 4 — Decision

Human：

```text
Use explicit state transitions + revision budget.
Do not reduce review quality threshold.
```

这时才形成：

> DESIGN_DECISION

---

## Step 5 — Specification

例如：

```text
Maximum automatic revision attempts = 2.

Repeated identical failure must not trigger
an identical revision indefinitely.

Reviewer must distinguish:
- approve
- revise
- replan
- blocked
```

---

## Step 6 — Delegation

Human：

```text
Codex may:
- modify internal controller structure
- add state enums
- add schemas
- add tests

Codex may not:
- change the overall architecture
- remove reviewer
- add a new agent
- change external API
```

---

## Step 7 — Codex

Codex 发现：

> 当前 Reviewer API 无法表达 REPLAN 状态。

Codex 不应：

```text
直接修改 architecture
```

而应：

```text
CHANGE_PROPOSAL

"The current API cannot represent REPLAN.
Suggested extension: X."
```

然后进入 Deliberation。

---

# 32. Operating Modes

CCCP 不要求所有任务都采用同样程度的 Human participation。

可以支持三种典型模式。

## Collaborative

适用于：

- 问题不清晰；
- 架构尚未确定；
- 多种方案存在明显 trade-off。

```text
Human ↔ ChatGPT
```

---

## Directed

适用于：

- Human 已经明确设计；
- Specification 足够完整。

```text
Human
 ↓
Specification
 ↓
Codex
```

Codex 直接执行。

---

## Autonomous

适用于：

- Intent 清楚；
- Delegation 已预先确定；
- 风险较低；
- AI 可以在边界内完成整个任务。

```text
Human
 ↓
Intent + Delegation
 ↓
AI proposes / decides within scope
 ↓
Codex executes
```

Autonomous Mode 不意味着 AI 获得无限权限。

---

# 33. Fundamental Rules

CCCP v1.0 最核心的规则可以压缩为以下十条。

### Rule 1

**Human owns final decisions.**

### Rule 2

**Proposal is not Decision.**

### Rule 3

**Consensus is not Approval.**

### Rule 4

**Decision defines what should happen.**

### Rule 5

**Specification defines what counts as correct.**

### Rule 6

**Delegation defines what AI may decide.**

### Rule 7

**Autonomy defines what AI may execute without re-asking.**

### Rule 8

**Not specified does not mean authorized.**

### Rule 9

**Codex may propose boundary-crossing changes, but may not self-approve them.**

### Rule 10

**Reality comes from the Repository / Runtime, not from AI memory.**

---

# 34. Design Philosophy

CCCP 最终追求的并不是：

> “让 AI 更听话。”

也不是：

> “让 Human 控制 AI 的每一个动作。”

真正目标是建立一个：

> **清晰决策、明确边界、充分自主、可审计升级的协作系统。**

即：

\[
Human\ Authority
+
AI\ Deliberation
+
Bounded\ Autonomy
+
Repository\ Reality
\]

形成：

> **Human-governed, AI-assisted, repository-grounded autonomous software engineering.**

---

# 35. Version 1.0 Boundary

CCCP v1.0 在概念层面冻结以下内容：

- 参与者与角色；
- Authority Model；
- Core Concepts；
- Decision / Specification / Delegation / Autonomy distinction；
- Decision Boundary；
- Human Escalation；
- Execution Lifecycle；
- Revision / Replan / Blocked；
- Review Model；
- Context / Reality distinction；
- Core / Profile separation；
- Bridge boundary；
- 基本 Message Semantics。

CCCP v1.0 **暂不冻结**：

- 最终 JSON Schema；
- MCP Tool 名称；
- Bridge API；
- Codex Adapter 实现；
- 具体 Permission Schema；
- Git Hook；
- Context 文件的最终目录结构；
- 完整状态机机器可读定义。

这些内容应在：

> **CCCP v1.1 — Implementation Specification**

中定义。

---

# 36. Recommended Next Specification

在完成本 Design Guide 后，下一阶段应按以下顺序实现：

```text
CCCP v1.0 Design Guide
        ↓
CCCP v1.1 Core Schema
        ↓
State Machine Schema
        ↓
Message Envelope Schema
        ↓
Delegation / Permission Schema
        ↓
Project Profile Schema
        ↓
Codex Adapter Specification
        ↓
Bridge API Specification
        ↓
Reference Implementation
```

这样可以避免在协议概念尚未稳定之前，过早被某一个 Bridge、Codex CLI 或具体项目的实现细节绑死。

---

# 37. Final Definition

CCCP 可以用一句话定义：

> **CCCP is a human-governed collaboration protocol in which ChatGPT supports deliberation and architectural reasoning, Codex autonomously executes within explicitly delegated boundaries, and the repository remains the source of implementation reality.**

中文定义：

> **CCCP 是一种以 Human 为最终决策者、以 ChatGPT 为讨论与架构推演伙伴、以 Codex 为受边界约束的自主执行者，并以真实 Repository 作为事实来源的软件工程协作协议。**