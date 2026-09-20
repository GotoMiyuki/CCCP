# ADR 0002: Durable Runtime 与受验证的恢复

状态：Accepted，Human 于 2026-09-17 批准 M2/M3 文件计划。协议保持 CCCP 1.0。

采用 Node 内置 `node:sqlite`，SQLite provider 要求 Node >=24.14。延迟导入 SQLite，不提高内存 Core/M1 的 Node 22 基线；无新增 npm 依赖。替代方案是第三方 SQLite 包（增加原生安装与升级成本）或数据库服务（增加部署与协调复杂度），本期不采用。

数据库使用 WAL、synchronous=FULL、短同步 BEGIN IMMEDIATE 事务。每次条件提交同时写 tasks、append-only events、协议 audit、operation_attempts、幂等 settlement 及 outbox。周期 snapshot 绑定 event offset/hash。Store revision 与 Controller state_version 分开；Store 不拥有业务状态机。

恢复的信任根是宿主保护的数据库及会话配置。哈希校验检测损坏，不构成外部签名；能任意改写整个数据库和宿主代码的攻击者不在此保证内。请求不能传入恢复审批的 JSON。

为了完整保留私有守卫数据，保存 Controller 公共调用日志、原始审批输入、审批时间、审计时间与生成 ID。恢复先校验事件/快照/投影，再通过原有公共方法重放并逐条比对错误结果、版本与审计。仅为确定性重放增加时钟/ID 注入，不添加私有状态导入入口。快照保存可重放前缀，当前实现仍重放协议调用前缀，未优化为 O(1) 恢复。

工具调用不在可重放命令集合内。实际启动前持久记录尝试和 Adapter session 的 attempted identities。恢复 RUNNING 时默认 EFFECT_UNKNOWN，要求停止核实与新 Discovery；不重复执行，不清除 Human Stop。未知 inbox/outbox 投递默认拒绝自动重投。

同一 durable task 由一个活跃 Host 进程拥有。新 owner 只可在旧 owner 明确释放或进程已死亡后取得任务；PID 存活不确定时拒绝接管。此保守策略可能需要运维处理 PID 重用，但避免把过期时间误认作旧进程已停止。

真实工具隔离见后续 ADR 0003；真实 Agent 与独立 R3 仍属于 M4。
