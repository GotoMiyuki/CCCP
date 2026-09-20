# M4 Real E2E Audit Report

日期：2026-09-17—18  
环境：Windows、Node.js 24.19.0、Codex CLI 0.154.0-alpha.6.2、Docker Desktop 4.91.0、Linux Engine 29.8.0  
模型：`gpt-5.5`（通过现有 ChatGPT 登录）  
镜像：`node@sha256:50c8e8ca1d27439048670df5883f32d57cf81cff6233222c893fd0d9884cbd81`

本报告记录运行时 E2E 中实际执行的独立 R3 provider；它不替代对本轮 M4 源码和审计材料的最终独立 R3 审查。后者已拆分至下一对话，交接包见 [M4 R3 交接](M4_R3_HANDOFF.md)。

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

两条路径都故意停在 `HUMAN_ACCEPTANCE`。测试代码不会把 fixture 或 Agent 输出冒充真实 Human 接受；设置 `CCCP_HUMAN_ACCEPT=1` 也只会在取得真实 Human 明示批准后执行既有 `acceptTask`。M4 的最后 DONE 只能在独立审查者检查本报告、全量测试和源码审计并给出结论后，由 Human 显式批准。运行时 R3 已在两条 E2E 内完成；最终独立源码审查尚未执行。
