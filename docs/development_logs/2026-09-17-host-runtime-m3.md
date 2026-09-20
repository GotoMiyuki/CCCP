# Host Runtime M3 — 实现与容器验收

日期：2026-09-17。Human 已批准 M2/M3 文件计划和 Docker 后端。M3 实现与真实 Docker 隔离验收已完成；未接入真实 Agent，未增加协议状态，未获得独立 R3。

## 文件与变更

- `src/runtime/tools/process-tool-runner.mjs`：本机 Linux Docker preflight、固定镜像/argv、路径挂载、资源限制、取消、持久执行身份和 orphan reconciliation。
- `src/runtime/tools/effect-reconciler.mjs`：含 ignored 文件的挂载内容清单、链接拒绝、结果分类、必须核实的尝试判定。
- `src/runtime/workspace/{git-workspace-manager,repository-lease}.mjs`：固定 commit 的 worktree、SQLite 共享仓库租约、死亡 owner 核实、续租和安全移除。
- `src/runtime/{host-runtime,recovery-coordinator,capability-manifest,index}.mjs`：执行前持久化绑定、真实 Artifact 标记、不可证明停止的终态恢复、关闭前清理。
- `src/safe-git.mjs`、`src/repository.mjs`：宿主 Git 禁用 hooks/fsmonitor/custom filters；不改变 Discovery 的协议字段和状态守卫。
- `src/runtime/controller-journal.mjs`：集成复查发现缺失 `accept`，补齐 Human Acceptance 的恢复记录；未修改其既有 Human 权限条件。
- `tests/{workspace,process-tool-runner,persistence}.test.mjs` 与对应 fixtures：真实 Git/进程租约、路径、安全 Git、接受/未知终态恢复，以及 7 项显式 Docker 验收。
- ADR 0003、TOOL_RUNNER_SPEC、HOST_RUNTIME_SPEC、PERSISTENCE_SPEC、README 和本日志同步。

## 已运行检查

Windows / Node v24.19.0 / Git 2.45.1.windows.1。

显式设置 Docker 测试环境后的 `npm test`：**187 PASS / 0 FAIL / 0 skipped**，共 187 项；真实 Docker tests 已全部通过。M2 基线 172 项保留，新增 15 项 M3 检查通过。`.cccp/reviews/m3-tests.txt` 保留的是较早一次默认跳过容器测试的输出，不作为最终 Docker 验收原始证据。

`npm run check`：9 个 schema/state artifacts 一致。冻结 Guide 与 9 个 artifacts 的原始字节哈希测试通过。原协议 workflow 和 Runtime simulation demo 均为模拟 DONE、audit_valid=true；不能视为本任务完成独立审查。

| M3 条款 | 实际证据 | 状态 |
|---|---|---|
| workspace/base revision/task 绑定 | 临时真实 Git 仓库与 detached worktrees、重新绑定拒绝、脏/有租约清理拒绝 | PASS |
| 跨进程单写者与恢复 | 实际子进程取得过期租约；仍存活时拒绝接管；SIGKILL 后仍需核实 orphan 才释放 | PASS |
| path/junction/hardlink/.git | 临时实际文件和 junction/hardlink；清单包含 ignored 文件变化 | PASS（宿主预检） |
| 宿主 Git 不运行仓库命令 | 安装会写 marker 的 hook/fsmonitor/filter，worktree/Discovery 后 marker 不存在 | PASS |
| 接受和未知终态不丢失 | Human Acceptance 重开数据库仍为同一 DONE/audit；合成故障 provider 的未知终态无法被 fake replacement 隐藏 | PASS |
| 容器挂载、环境、网络、资源 | 固定 digest 镜像与 Linux Docker 显式测试 | PASS |
| 超时、输出洪泛、detached 子进程 | 真实引擎核实停止、输出上限和副作用不再变化 | PASS |
| 真实 Artifact、Human Stop、Host SIGKILL orphan 恢复 | 真实容器、Host 与持久数据库验证 | PASS |
| 保持 CCCP 1.0 / 无真实 Agent | 冻结哈希、旧测试、manifest real_agents/independent_r3=false | PASS |

因此本日志完成 M3 实施者 R1 与逐条 R2 证据整理；这不是独立 ChatGPT R3 结论。

## Docker 阻挡及已做的环境操作

本机安装 Docker Desktop 4.75.0。最初 Linux 引擎 pipe 不存在；已按批准启动 Docker，日志先报告 `Docker/run/dockerInference` 遗留 socket 无法访问。确认相关进程停止后，单个 socket 无法改名，于是将 `C:/Users/99662/AppData/Local/Docker/run` 原位改名为 `run.cccp-m3-backup`，创建空 run 目录后重新启动；原目录内容仍保留。

随后日志报告 `C:/Users/99662/AppData/Local/docker-secrets-engine/engine.sock` 同类故障。只读取了目录项，目录仅有一个 0 字节 ReparsePoint socket；未读取凭据内容。正常 `docker desktop stop --timeout 20` 超时。

后续“停止多个 Docker 进程、备份 secrets-engine 运行时目录后重启”的操作被自动审批拒绝，理由是硬编码 PID 可能过期、误杀进程及影响凭据/运行时状态的风险。该拒绝操作未执行，未移动 secrets-engine 目录；没有重置 Docker、删除镜像/容器/卷、修改配置或绕过拒绝。

Human 随后批准了具体修复方案。执行时重新确认没有 Docker 相关进程、secrets-engine 目录只有 `engine.sock`，然后把该目录改名为 `docker-secrets-engine.cccp-m3-backup` 并创建空目录后启动 Docker；没有触碰镜像、容器、卷或配置。Docker 仍因 `Docker/run/dockerInference` socket 失败。随后 Docker 自己的 backend 日志记录错误对话框发起了 `Reset to factory defaults`；这不是 Runtime 工作流或本次命令执行的操作。为避免干扰该恢复过程，未再启动 Docker、拉取镜像或执行容器测试。恢复完成后必须先由操作员确认 Docker 数据状态和引擎可用性，再继续 M3 验收。

恢复出厂设置完成后再次启动 Docker，Linux engine pipe 仍未出现；新 backend 同样在创建 socket 时失败。Human 授权后已核验 Docker Inc 有效签名的更新包，安装完成后版本为 4.91.0.239619。随后 Docker Desktop 恢复可用；`desktop-linux` 报告 Docker Engine 29.8.0、Linux/WSL2、seccomp、memory/swap/CPU/PID 限制均可用。固定镜像 `node@sha256:50c8e8ca1d27439048670df5883f32d57cf81cff6233222c893fd0d9884cbd81` 的 8 项真实验收全部通过，测试容器已清理。

Docker 恢复与最终验收已经完成；历史修复方案保存在 `.cccp/reviews/docker-repair-plan.md`。任何未来环境修复仍须重新核实进程和目录现状，不能复用旧 PID。

## 评审材料

`.cccp/reviews/m2-durable-runtime.patch` 保留 M2 阶段快照。`.cccp/reviews/m3-tools-workspace.patch` 以 M2 快照为基线，包含集成复查补充的接受恢复修复。工作区变更未提交 Git commit。协议与 Runtime 文档分别标注历史基线和当前验收状态。
