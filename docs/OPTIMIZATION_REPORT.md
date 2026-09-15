# 后续优化报告

日期：2026-09-15  
授权：Human 指示“继续优化”，沿用原 Design Guide 与冻结语义边界。  
结果：**103 PASS / 0 FAIL；Schema 一致性与模拟工作流检查通过。**

## 修复内容

| 问题与触发方式 | 修复后的行为 | 主要实现 |
|---|---|---|
| 权限或 Loop Protection 阻断后再上报普通 Block，原恢复限制被覆盖 | 按类别保留待解决原因，恢复时检查全部限制 | `src/lifecycle.mjs` |
| Human 终止后 Codex 可调用 resume / requestReplan | Human 终止单独留标记，恢复需 Human 明确授权 | `src/lifecycle.mjs` |
| 重建 Adapter 后操作记录丢失，可再次执行同一操作 | Controller 共享尝试记录，实例重建不清空 | `src/execution-session.mjs`, `src/adapter.mjs` |
| 两个 Adapter 可并发操作；工具仍在运行时能提交完成报告 | Controller 共享锁；运行期间拒绝完成报告 | Adapter / Lifecycle |
| 当前实现者以外的 Codex 身份也能执行计划 | 工具执行身份必须匹配当前实现者 | `src/lifecycle.mjs` |
| Human 终止后运行中工具的成功结果仍正常返回 | 比较状态版本，返回 EXECUTION_INTERRUPTED 并保留最新状态 | `src/adapter.mjs` |
| 纯空格或稀疏数组可充当 Review 证据；无效日期被自动归一化 | 拒绝空白文本、稀疏数组和无效日历日期 | `src/contracts.mjs` 与生成的 Schema |
| Schema 名称可解析到 Object 原型；默认常量可被修改 | 名称 / 引用只匹配自身定义，导出常量与 Schema 只读 | `src/contracts.mjs` |
| 工作区不变但暂存区内容改变，Discovery fingerprint 不变 | 将完整 Git 状态与 index 对象信息纳入指纹 | `src/repository.mjs` |

同时将文件哈希改为流式读取，避免整文件与 Base64 副本同时驻留内存。读取前后检查文件状态，避免接受已检测到中途变化的观察。未提供性能倍数或原子快照保证。

## 验证证据

1. 新增 `tests/hardening.test.mjs` 的 16 项回归，在修复前 **16 FAIL**，证明原实现确有上述问题。
2. 修复后定向测试 **16 PASS / 0 FAIL**。
3. `node --test` 完整测试 **103 PASS / 0 FAIL / 0 SKIP**，退出码 0。
4. `node scripts/export-schemas.mjs --check`：9 个机器可读产物与源定义一致。
5. `node examples/workflow.mjs`：模拟低风险路径 DONE，审计链有效，两个 Review 消息各投递一次。
6. 原始 Guide SHA-256 再次核对未变：

```text
D5FF6D95BDEBC4CB778BE8AF0352017AC26B483DC483D2AD5454C52C3AAEFD7A
```

## 兼容性与状态

协议版本仍为 `1.0`；未增加协议生命周期状态，也未改变 Human Authority、Decision Boundary 或 Review 的职责划分。新增 `state_version`、`blocked_reports`、`human_stopped` 是控制器快照中的实现元数据。

Schema 文本校验现在拒绝纯空白输入。Discovery fingerprint 算法已增强，集成方应重新 Discovery，不能复用旧指纹。这些属于本次已授权的 Schema 与内部实现细化。

真实模型 / MCP 接线、认证宿主、操作系统工具隔离、跨进程持久化和独立 ChatGPT R3 仍未完成。已经运行的宿主回调不能由这层代码自动撤销；本轮保证旧结果不会在状态变化后继续推进任务。

本轮未发现需要改变冻结设计才能修复的问题，因此没有提出设计变更或用新的协议语义绕过阻断。
