# M4 Real E2E Audit Report

首次运行日期为 2026-09-17—18。

环境：Windows、Node.js 24.19.0、Codex CLI 0.154.0-alpha.6.2、Docker Desktop 4.91.0、Linux Engine 29.8.0  
模型：`gpt-5.5`（通过现有 ChatGPT 登录）  
镜像：`node@sha256:50c8e8ca1d27439048670df5883f32d57cf81cff6233222c893fd0d9884cbd81`

以下先记录九月的初次验收，再按日期追加复测。独立源码审查的最新状态见 [M4 R3 交接](M4_R3_HANDOFF.md)。

## 正常路径

命令使用 `CCCP_REAL_AGENT_TESTS=1`、固定 Docker context/image 和显式模型运行 `tests/e2e-real-agents.test.mjs`。

审计结果：真实 Codex 在只读 worktree 上生成 `src/value.txt` 候选；Host 将 run/binding 持久化；Docker ToolRunner 应用候选；第二个只读容器运行 fixture test；SQLite EvidenceStore 保存 DIFF 与 TEST_RUN；R1/R2 引用相同真实 Artifact；独立 ChatGPT run 完成 R3。最终状态为 `HUMAN_ACCEPTANCE`，文件内容为 `ready\n`，测试 **PASS**，用时 127.1 秒。

结构化附件：[normal.json](audit/m4/normal.json)。它导出了 2 个完整 Artifact、2 个真实 Agent run 和 21 条协议审计记录。DIFF reference 为 `evidence:7d1dc0c8-3397-45ee-afdd-76202bc9eeef:486d0bed78b4a8e2803b64ec2abc5d8154eed479323dbbbf9e4125506398d1f4`，TEST_RUN reference 为 `evidence:58084551-5119-46d4-a0ed-e263ee6b358f:ac94a89bccd69014a01b792781d9e4de8b34ad88df9fef5c9b2683f9864ffdc3`。实施与 R3 的 provider instance、thread 和 turn 均不同，附件保留完整值及 R3 输出。

## 恢复路径

子 Host 完成真实 Agent、Docker 写入、真实测试和 ImplementationReport 后输出 crash marker，并由操作系统强制终止。新 Host 打开同一 SQLite 数据库和 Git worktree，重放 Controller/audit，取得死亡 owner 的 lease，恢复两个已完成 operation；没有再次调用 apply 或 test。恢复后完成 R1、R2 和新的独立 ChatGPT R3。

最终状态为 `HUMAN_ACCEPTANCE`，operation 数在恢复前后均为 2，文件内容仍为 `ready\n`，测试 **PASS**，用时 110.2 秒。恢复没有产生新的 Delegation、重复副作用或伪造 DONE。

结构化附件：[recovery.json](audit/m4/recovery.json)。DIFF reference 为 `evidence:40dabec7-d90c-4760-858a-ecf21f1cdf2f:36dbce2adc9df39086ff9af3d76cb9b24458a48e5901d7738e58c0a330e2a586`，TEST_RUN reference 为 `evidence:fa7b1090-a03e-4349-a457-6e590a8b6a9e:ce0e4fb382c98ff53c96a7f544e1c3235b35df28c26cd9521294b021fb4382df`。附件同样包含可重算 hash 的 Artifact 内容、真实 run binding 与完整协议审计链。

两个附件均通过本地重算：Artifact `content` 的 SHA-256 等于 `content_hash`，且 `artifact_ref` 精确等于 `evidence:<evidence_id>:<content_hash>`。

## 回归结果

- Docker 单并发全量：200 tests，198 PASS，0 FAIL，2 个真实 Agent E2E 因未设置 opt-in 环境变量而 SKIP；用时 51.3 秒。
- 真实 Agent E2E 单独执行：正常与恢复路径均 PASS。
- Schema/state check：9 个导出 artifact 一致。
- `git diff --check`：通过，仅有工作区 CRLF 提示。

并行 Docker 回归曾暴露 Windows linked-worktree index 在 orphan container 尚未停止时的文件锁竞态。恢复顺序已改为先 reconcile 旧 container/lease、再校验 Git worktree；目标用例和最终全量回归均通过。一次独立 R3 turn 达到 300 秒上限后被正确中断，重试在相同边界内通过；没有将超时结果接受为 Review。

## 协议结论

两条测试均在运行时 R3 后停在 `HUMAN_ACCEPTANCE`。测试的 `CCCP_HUMAN_ACCEPT=1` 分支会调用既有 `acceptTask`。上述试跑未启用该分支，M4 的 Human Acceptance 仍由 Human 根据独立源码审查和验证结果决定。

## 2026-11-16 修订后复测

复测基线是 `a8e5ab5` 加上本次 M4 收尾改动。环境为 Windows、Node.js 24.19.0、Codex CLI 0.155.1、Docker Linux Engine 29.8.0，继续使用上文的固定镜像。审查端通过 ChatGPT 登录运行。

- 最终本地串行回归 194 通过、0 失败、10 个外部测试跳过，Schema/state 检查 9 项通过。与真实 E2E 同时运行的一次本地回归遇到 Windows 临时 Git index `Permission denied`，两组测试分开执行后复测通过。单独启用 Docker 的测试组 8/8 通过。
- 显式使用历史模型 `gpt-5.5` 时，恢复用例收到 `model_not_found`。取消模型覆盖后，正常路径完成实施与两项工具操作，但 R3 在约五分钟后被中断。Host 以 `RECONCILIATION_REQUIRED` 保留租约。
- 使用本机模型配置的恢复路径 75.4 秒通过。重启后工具操作数仍为 2，独立 R3 给出 `APPROVE`，状态达到 `HUMAN_ACCEPTANCE`。
- 正常路径改用 `gpt-6-luna` 做 Reviewer 后，Controller 进入 `REVISION`。从该次 Codex 运行记录取回的审查意见指出，应用前的候选报告称未编辑文件，与应用后的 DIFF 矛盾，而且仅靠两个操作 Artifact 无法核对 Human 授权。正常与恢复 fixture 现都从 Docker 的真实结果补齐最终报告，Host 在真实 Review 输入中提供 Controller 保存的审批记录与 Delegation。E2E 在状态断言前导出审查结果。

- 修订后的两条用例在同一次运行中通过。实施使用本机 Codex 模型配置，审查显式使用 `gpt-6-luna`。正常路径用时 85.7 秒，强制崩溃恢复用时 111.9 秒。两次运行均执行了 2 项工具操作并到达 `HUMAN_ACCEPTANCE`，恢复用例确认没有重放工具副作用。

修订后的 `normal.json` 和 `recovery.json` 由 `CCCP_E2E_AUDIT_DIR=.cccp/m4-audit-2026-11-16-final` 导出至本地。两份记录均复核 Artifact 哈希和引用、协议审计链及 Reviewer 独立性。上文的受版本控制附件对应九月的历史运行。

最终源码 R3 复审与 Human Acceptance 待完成，见 [M4 R3 交接](M4_R3_HANDOFF.md)。

## 2026-11-17 独立源码 R3 复审

结论为 **REJECT**，完整证据见 [独立 R3 记录](audit/m4/independent-r3.txt)。复审对象为 `a8e5ab5` 加当前未提交 M4 修订。最新两份附件的 Artifact 哈希、引用归属、审计链及 reviewer 身份隔离独立复核通过，但 Host 探针复现了“同周期先测试后修改，旧测试仍可认证新实现并进入 HUMAN_ACCEPTANCE”的阻断缺陷。需要修复证据新鲜度校验并补回归，随后重新执行真实 E2E 和独立 R3；现有成功附件不覆盖该路径。

本次实际本地回归为 190 PASS、4 FAIL、10 SKIP；四项失败均为 Windows 沙箱创建 symlink 的 EPERM，不能宣称全量通过。9 项 Schema/state 检查及 diff whitespace 检查通过。本次未重跑真实模型或 Docker opt-in E2E，未形成 Human Acceptance。

## 2026-11-17 F1 修订后复测

- Windows 宿主串行回归 198 通过、0 失败、10 个外部测试按配置跳过。四项 junction 用例在宿主均通过。Schema/state 检查 9 项通过。
- 真实 Codex、固定 Docker 镜像与 `gpt-6-luna` Reviewer 的正常路径和强制崩溃恢复路径在同一次运行中 2/2 通过，分别用时 87.5 和 89.6 秒。两条路径均到达 `HUMAN_ACCEPTANCE`。恢复后操作数仍为 2，无工具重放。
- 本地附件由 `CCCP_E2E_AUDIT_DIR=.cccp/m4-audit-2026-11-17-f1` 导出。复核 `normal.json` 和 `recovery.json` 的哈希、引用归属、审计链及 Reviewer 运行隔离均通过。两个附件均记录一次写入和一次只读测试，且测试的 `test_write_generation` 为 1。

F1 修订及证据交下一轮 [独立源码 R3 复审](M4_R3_HANDOFF.md)。

## 2026-11-17 F1 独立复审：APPROVE

独立复审已关闭 F1，结论为 **APPROVE**，依据见 [独立 R3 记录的最新追加结论](audit/m4/independent-r3.txt)。Reviewer 实际运行宿主串行全量测试：198 PASS、0 FAIL、10 SKIP；Schema/state 9 项通过。额外受控探针确认先测试后写入、只读声明与前后指纹不符、可写测试均被新鲜度门禁拒绝。

Reviewer 独立复核 `.cccp/m4-audit-2026-11-17-f1/` 两份附件的哈希、DIFF 内容、操作归属、测试代次、审计链及独立身份，均通过。本轮未重新调用真实模型或运行 Docker opt-in E2E。APPROVE 允许 M4 提交 Human Acceptance，不构成 Human 接受或 DONE。

## 2026-11-17 Reviewer 证据枚举复测

跳过项复测时，恢复路径的 Reviewer 在两个字段里漏抄了同一个 TEST_RUN 引用的两个字符。Host 返回 `INVALID_EVIDENCE`。修订后，Reviewer 调用的 Schema 从本次冻结输入生成完整引用枚举。27 项 provider 与持久化回归通过，DeepSeek API 探针 1/1 通过。

正常和强制崩溃恢复 E2E 同次通过，分别用时 90.7 和 75.3 秒。两条路径均到达 `HUMAN_ACCEPTANCE`，恢复后操作数为 2。已核对正常路径 12 处和恢复路径 10 处 R3 引用均与冻结证据一致，两份附件的证据哈希和审计链均通过复核。最新附件位于由 Git 忽略的本地目录 `.cccp/m4-audit-2026-11-17-evidence-enum/`。仓库中 `docs/audit/m4/` 的 JSON 对应九月初次运行。
