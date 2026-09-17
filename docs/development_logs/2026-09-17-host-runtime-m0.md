# Host Runtime M0 — 架构与冻结基线

日期：2026-09-17。Human 已批准 M0/M1 文件级计划；本记录不代表真实独立 R3。

## 本阶段文件

- `docs/adr/0001-host-runtime-layer.md`
- `docs/HOST_RUNTIME_SPEC.md`
- `docs/IMPLEMENTATION_SPEC.md`（仅新增 Runtime 文档入口段落）
- 本日志

本阶段 diff 与后续 M1 代码分开审查。原有未跟踪的 `docs/debugging_logs/` 是 Human 提供的输入，未修改。

## 基线与验证

- HEAD：`68fde8ef76ec5adcd125126b4e6dd3997c7ecd3b`
- 平台：Windows，Node.js v24.19.0。
- 批准前只读验证：`npm test` 104 PASS / 0 FAIL；`npm run check` Checked 9；`npm run demo` 模拟 DONE、audit_valid=true、messages_delivered=2。
- M0 文档写入后：`npm run check` Checked 9。
- 仓库别名回归在 Windows junction 下通过；未执行 macOS 实机复测。

冻结基线 SHA-256（按文件原始字节）：

```text
CCCP v1.0 Design Guide.md d5ff6d95bdebc4cb778be8af0352017ac26b483dc483d2ad5454c52c3aaefd7a
schemas/core.schema.json 0d08c83f01b080b2aff72355151848139e2fa34effc3e1011f075cb1c65e5f20
schemas/delegation.schema.json f918e96c861d69ff34b031f3bd10ec1dc7df78e52d306a13345a9fe62c09dd0e
schemas/message-envelope.schema.json 6556b167d708a72c69f1e042dc45886fe7451a385edc1342b9947aa99429caa5
schemas/permissions.schema.json 53240b7c3a1bf8633a62b596e3693712b285755093bd65b7892b9887b3d2026d
schemas/project-profile.schema.json ae69722bd311e7a09bfad27d0108dc989cd5bf3085e150ef028e42bcf3555a1e
schemas/review-result.schema.json dbcb11e4a40cef3e201d87a2ad90b568b505ac8a7b88b867502f850ff5cd992f
schemas/specification.schema.json 270e6d436a5870caa131b380f5000c87f0be042d95a4522e51a5f60128b62809
schemas/state-machine.json ed1d6c253277db1b5ababd7eae3ac5901247a70cddb5da9265b1de5720ab87b8
schemas/state-machine.schema.json c7c3534b56f4c9b6c445eae8891b04bfceb28df531c4eaa5572c4d8fbbefed98
```

## R1 / R2

R1：检查相对文档链接、现有 Core/Adapter 公共方法与规范中的映射，Schema consistency 通过。M0 未修改代码。

| M0 退出条款 | R2 证据 | 判断 |
|---|---|---|
| 模块职责与数据所有权明确 | ADR 决策表、SPEC §1/4/5/6 | PASS |
| 错误、停止、未知效果边界明确 | SPEC §4/6/7；Store 故障不回滚审批 | PASS |
| 协议/实现/contract/存储版本分开 | ADR 版本段、SPEC §2 | PASS |
| 六端口与 unsupported 能力明确 | SPEC §2/5；无恢复、SDK、sandbox 提前实现 | PASS |
| 冻结语义与既有 artifacts 保留 | 上述哈希，Checked 9，M0 仅文档 diff | PASS |

此 R1/R2 为实施者检查与逐项可核验证据，不是独立 ChatGPT R3。
