# ADR 0001: Host Runtime 层

- 状态：Accepted for M0/M1 implementation（Human 于 2026-09-17 批准文件级计划）
- 日期：2026-09-17
- 协议：CCCP 1.0；实现基线：cccp-reference 0.1.1
- 依据：`../debugging_logs/一期架构评估+修改指南.md`，M0 与 M1

## 背景

Core 已拥有审批、Delegation、Review、状态守卫与审计，Adapter 已拥有执行前授权、Discovery freshness 和进程内操作协调。缺少的是承担身份解析、Provider 装配、任务绑定和运行记录的宿主层。将 SDK、数据库或进程控制放进 Core 会混合协议语义与执行机制。

## 决策

新增 `src/runtime/`。HostRuntime 装配 IdentityProvider、AgentProvider、StateStore、ToolRunner、WorkspaceManager、EvidenceStore。协议状态只能经 DecisionLifecycle / ExecutionLifecycle 的既有公共方法改变；工具通过既有 CodexAdapter 执行前检查。Provider 不获得 Controller 或任意宿主回调。

RuntimeContext 显式绑定任务、认证 principal、Controller state_version、Delegation、workspace 与 correlation。IdentityProvider 来自可信宿主配置；请求中的角色不是认证依据。M1 的 startTask 使用认证 Human 的 Directed 流程，不接受序列化的“已批准 Controller”。

数据所有权：

| 所有者 | 拥有的数据 | 不承担的责任 |
|---|---|---|
| Controller | 审批记录、协议状态、Review、版本与协议审计 | SDK、数据库与运行环境 |
| HostRuntime | 活跃 Controller、操作编排、身份与引用绑定、Runtime 审计 | 自行批准或推导新权限 |
| StateStore | 不可变任务观察记录、Store revision、幂等与操作记录 | 校验业务状态转移、反序列化审批 |
| AgentProvider / ToolRunner | run / operation 的模拟结果与取消记录 | 直接推进任务、授予工具能力 |
| WorkspaceManager | workspace 注册、任务绑定与租约 | 凭路径字符串认定真实仓库身份 |
| EvidenceStore | Artifact 内容、哈希与归属 | 证明文本描述真实、自动给予 PASS |

M1 使用单个 HostRuntime 独占一个 StateStore 的写入。Store revision 用于存储 CAS，state_version 原样来自 Controller；工具调用或审计写入不必导致协议版本增加。内存快照只是观察记录，不含完整可恢复状态。Store 写入异常后宿主禁止继续该任务；不尝试通过 JSON 恢复或回滚 Controller。

Runtime outcome 为 SUCCEEDED、FAILED_CLEAN、EFFECT_UNKNOWN、INTERRUPTED，均不是协议状态。结果未知或中断时保留操作记录，调用既有 BLOCKED 机制并要求重新 Discovery；没有自动工具重试。Human Stop 可立即调用既有 override，迟到结果不能覆盖停止。

## 版本与能力

协议仍为 1.0；Runtime contract 使用独立版本 `0.1`，Runtime 实现标记 `0.2.0-dev`，包版本保持 0.1.1。M1 manifest 必须标为 simulation，持久状态、崩溃恢复、真实 Agent、OS sandbox、跨进程租约和真实独立 R3 为不支持。模拟取消不是进程树取消。

## 替代方案与后果

1. 直接扩展 Controller：代码少，但会把供应商与持久化机制耦合到协议守卫，未采用。
2. 同时引入 SQLite / SDK / sandbox：可较快演示真实接线，但难以区分契约问题与后端问题，留给 M2–M4。
3. 单纯序列化 Controller.snapshot：遗漏尝试记录、审批来源及其他私有状态，不能用于可信恢复，未采用。

本决策增加端口和验证代码，但使后续后端有可复用 contract tests。M1 不提供生产认证、真实隔离、跨重启幂等或独立 R3 结论。协议冻结文件及既有 Schema 保持字节不变。若后续必要行为无法用冻结语义表达，应提交独立 CHANGE_PROPOSAL，由 Human 决定。

## 验收

见 `../HOST_RUNTIME_SPEC.md` 的验收条款和逐 milestone 开发日志。M0/M1 自动测试与自检不代替真实独立 R3。
