# M4 最终独立 R3 审查交接

状态：2026-11-17 独立 R3 因测试证据新鲜度问题 F1 给出 `REJECT`。当前工作树已加入 F1 修订，待独立复审。请在结论中注明审查的提交或工作树。参见 [独立 R3 记录](audit/m4/independent-r3.txt) 和 [M4 开发日志](development_logs/2026-09-17-host-runtime-m4.md)。
最新状态：同日 F1 修订后独立复审为 `APPROVE`，F1 已关闭；M4 可提交 Human Acceptance，尚未形成 Human 接受或 DONE。复审对象为 `a8e5ab5` 加当前未提交修订，详见独立 R3 记录末尾。

## 审查目标

确认 M4 在不改变 CCCP Protocol 1.0 冻结语义的前提下，完成真实 Codex 实施端、独立 ChatGPT/OpenAI R3 provider、Evidence 绑定和正常/恢复 E2E。审查范围只覆盖 M4 及其为实现 M4 所作的 Runtime 改动；M5 的多任务租约、完整 capability negotiation、Threat Model、外部 Conformance、CI/release 不纳入本次结论。

## 必读材料

- [一期架构评估+修改指南](debugging_logs/一期架构评估+修改指南.md) 的 §6.5、M4/M5 和完成纪律；
- [Agent Provider 规范](AGENT_PROVIDER_SPEC.md)；
- [ADR 0004](adr/0004-real-agents-independent-review.md)；
- [M4 E2E 审计报告](M4_E2E_REPORT.md)；
- [M4 开发日志](development_logs/2026-09-17-host-runtime-m4.md)；
- 结构化附件：[正常路径](audit/m4/normal.json)、[恢复路径](audit/m4/recovery.json)；
- 实现与契约测试：`src/runtime/providers/`、`src/runtime/agent-evidence.mjs`、`src/runtime/host-runtime.mjs`、`src/runtime/recovery-coordinator.mjs`、`src/runtime/tools/process-tool-runner.mjs`、`tests/agent-provider.test.mjs`、`tests/e2e-real-agents.test.mjs`。

## 最低核对项

1. 核对 Design Guide、协议 Schema、生命周期状态和 Human Authority 的冻结语义。本次 M4 验收启用 `human_acceptance`，由 Human 根据源码 R3 和测试证据决定是否通过既有 `acceptTask` 完成验收。
2. 实施 Agent 与 R3 使用不同 provider identity、principal、run 和外部 thread/turn 或 response binding；R3 输入由 Host 从冻结上下文和已验证 Artifact 重建。
3. Agent 候选不能直接写工作区，且不能控制命令、环境、挂载、凭据、principal、Delegation 或 approval；真实副作用只能由已授权 Docker ToolRunner 完成。
4. DIFF 和 TEST_RUN 均来自实际工具执行，并绑定 task、attempt、principal、执行后 repository snapshot、内容 hash 和 Artifact reference；审查可复算附件中的 hash/reference。
5. 强制崩溃恢复不会重复 apply/test、不会接受迟到 Agent 输出，并对无法证明已停止的真实 App Server turn fail-closed。
6. capability manifest 只在完整的非模拟 routed 装配上声明 `real_agents`，且只在独立 R3 后端条件满足时声明 `independent_r3`。
7. 两条真实 E2E 都止于 `HUMAN_ACCEPTANCE`；`CCCP_HUMAN_ACCEPT=1` 的测试分支不构成 Human 授权或既有验收结论。
8. 检查初次 Revision 的三项修订和本次收尾。真实 Review 在派发前和提交时使用同一 Artifact 归属与执行周期校验。恢复时，未完成的模拟 Agent 标为 `INTERRUPTED`，未确认停止的真实 Agent 仍要求对账。
9. 核对 F1 的写入代次绑定。先测试再写入、测试后继续写入以及无法确认只读的操作会使早先的通过测试失效。最后一次写入后重新测试的证据在 Host 恢复后仍可用于 Review。回归见 `tests/persistence.test.mjs`。

## 已有可复核结果

- 正常路径：真实 Codex 候选、Docker apply、真实测试、R1/R2、独立 ChatGPT R3，到 `HUMAN_ACCEPTANCE`，127.1 秒通过。
- 恢复路径：工具和 report 后强制终止 Host；重启后 operation 数保持 2，不重复 apply/test，再完成独立 R3，到 `HUMAN_ACCEPTANCE`，110.2 秒通过。
- Docker 单并发全量：200 tests，198 PASS，0 FAIL，2 个未启用 opt-in 的真实 Agent E2E SKIP；`npm run check` 通过 9 个 schema/state artifact；`git diff --check` 通过。
- 2026-11-16 的 [修订后复测](M4_E2E_REPORT.md#2026-11-16-修订后复测) 记录了补齐最终报告及冻结授权记录后的两条真实 Agent E2E。
- 2026-11-17 的 [F1 修订后复测](M4_E2E_REPORT.md#2026-11-17-f1-修订后复测) 记录了 Windows 宿主全量回归及两条真实 Agent E2E 同次通过。最新本地结构化附件位于 `.cccp/m4-audit-2026-11-17-f1/`。

这些是待审查的证据，不是审查结论。

## 输出与状态规则

审查输出第一行必须为 `APPROVE` 或 `REJECT`，随后给出每项发现对应的文件、行或审计字段与理由。`APPROVE` 只表示 M4 可以提交 Human Acceptance；它不把任务推进为 `DONE`。`REJECT` 时应先修复、运行相关回归，再重新执行独立 R3。无论哪种结论，都应追加到 `docs/audit/m4/independent-r3.txt`，并更新 M4 开发日志和 E2E 报告。
