# ToolRunner / Workspace Specification — M3

对应 CCCP Protocol 1.0、Runtime contract 0.2。M3 实现与真实 Docker 验收已完成；详见 [M3 日志](development_logs/2026-09-17-host-runtime-m3.md)。

## 装配与授权

`ProcessToolRunner.create({docker?,context?,image,namespace?,bindings})` 只接受本机 npipe/unix Docker context、Linux 引擎及启用 seccomp 的环境。image 必须为本地已有的 `repository@sha256:…`，禁止可变 tag 和隐式 volumes。Runner 不自行下载镜像，也不回退到宿主执行。生产 Host 保护其 provider 配置、数据库、Docker endpoint 与 worktree 根目录。

```js
const tool = await ProcessToolRunner.create({
  image: pinnedImageDigest,
  bindings: {
    'verify-unit': {
      domain: 'test_implementation', paths: ['src', 'tests'], write: false,
      argv: ['/usr/local/bin/node', '--test', 'tests/unit.test.mjs'],
      environment: {}, limits: { timeout_ms: 15000 },
    },
  },
});
```

绑定 ID、domain、permission 必须匹配经 Controller 批准的 Operation；changes_decision 必须为 false。每条挂载路径须同时被绑定、Operation、Delegation 与 policy allowlist 覆盖。Host 在调用 Runner 前继续执行既有身份、版本、权限、路径和 attempted-operation 守卫。

只允许显式环境键；Host 当前请求的环境 allowlist 为空，默认不注入宿主变量。敏感名称如 TOKEN/PASSWORD/SECRET/CREDENTIAL/PRIVATE_KEY/API_KEY 也被拒绝。工具输出作为不可信文本保存，不能成为身份、审批或可执行宿主代码。

## 工作区与租约

`GitWorkspaceManager.create({database,root,workspaces?})` 的 `register({workspace_ref,repository,baseRevision='HEAD'})` 将 ref 绑定到确定 commit 和 managed root 内的 detached worktree。重新注册不得改变来源和 commit。Human Directed 的 Profile.repository 必须指向这个已存在的 worktree；不得在已审批后悄悄迁移路径。

检查 worktree 的 realpath 与 Git common directory；租约以 common directory 为共享身份，因此同仓库不同 worktree 也互斥。租约保存 owner UUID、PID、task、期限和随机 fencing ID。时间到期不产生新的写入者；未被替换的同一 owner 可以续租，旧 ID 不能操作新租约。

`reconcileRepository(identity,tool)` 仅在旧 owner 确认死亡后检查其持久尝试，使用原 execution_binding 清理容器，并条件删除旧租约。RUNNING、未证明停止的真实终态都必须核实。不同任务接管仓库也须经过同样步骤。不可访问的 PID 按存活处理，可能需要操作员后续处理。

`HostRuntime.close()` 要求当前调用及工具已结束；核实未知真实进程、释放租约并拒绝后续请求。随后操作员关闭数据库。不要仅通过关闭数据库来释放仍可能运行的工具。`disposeWorkspace(ref,{discardChanges:false})` 拒绝有租约或脏文件的工作区；明确 discardChanges 后才允许 Git 移除精确 worktree，清理前重新检查 managed root 边界。

所有参与 Host 使用同一 SQLite 控制数据库。该租约不约束外部编辑器、管理员或另一个独立数据库中的进程。禁止在工具运行时从宿主替换挂载源路径。Git host commands 使用 `safeGit` 禁用 hooks、fsmonitor 和已配置 filters；这不修改仓库配置或协议守卫。

## 容器执行策略

| 项目 | 实现约束 |
|---|---|
| 命令 | 固定绝对容器 executable + argv；宿主 execFile/spawn 不使用 shell |
| 文件系统 | 仅挂载绑定子树；无仓库根、.git 或 Docker socket；非递归 bind，按绑定 RO/RW |
| 路径 | 拒绝 traversal、symlink/junction 及祖先链接、硬链接、特殊文件、Git 元数据；再次清点后开始执行 |
| cwd | 固定 `/workspace`，对应授权子树；不暴露其余仓库内容 |
| 网络 | Docker network none；可用容器内部 loopback，不可连接外部网络 |
| 权限 | 只读根文件系统，cap-drop ALL，no-new-privileges，默认 seccomp，无 privileged/host namespace |
| 资源 | 1 CPU、64 PID、配置内存且禁止额外 swap、CPU/file-size/nofile ulimit；16 MiB /tmp tmpfs |
| 时间与输出 | Host timeout，合并 stdout/stderr 字节上限；超限终止容器，log-driver none |
| 子进程 | 容器进程 namespace + init；取消/超时检查停止并移除容器，不能仅杀 Docker CLI |

memory/cpu/file-size/timeout/output 上限取 Host policy 与可信绑定中的较小值。目录必须预先存在；文件新增通过授权父目录进行。inventory 默认限制 20,000 个条目、64 MiB 文件内容；包含 node_modules 等 ignored 文件。每文件大小限制不等于整个工作区磁盘配额。

## 尝试、结果与恢复

实际工具额外实现 `describeAttempt({task_id,attempt_id,workspace})` 和 `reconcile({task_id,attempt_id,workspace,execution_binding})`。manifest 对声明 os_sandbox 的 provider 强制要求这两个方法。M1 fake provider 不要求它们。

Host 先持久化 execution_binding 和 RUNNING，然后调度。容器名称由 namespace、workspace、task、attempt 的哈希确定；Docker label 进一步核实所有权。恢复使用保存的身份与 context，不能因重新配置 namespace 或 provider 而漏掉旧进程。引擎不可访问不等于容器不存在。

结果包含 outcome、stdout/stderr、exit_code、时间、execution 参数、process_tree_stopped、interruption_reason 和 simulation=false。repository_before/after 是挂载子树完整内容及模式的清单摘要，区别于协议 Discovery；Evidence 仍绑定本次审批周期的 Discovery，内容包含实际运行结果。

| Runtime outcome | 判断 |
|---|---|
| SUCCEEDED | exit 0，已确认停止，后置 inventory 成功 |
| FAILED_CLEAN | 非零退出，无中断，已确认停止，前后完整清单一致 |
| INTERRUPTED | 超时、取消、资源/信号终止，且已确认停止及后置清单 |
| EFFECT_UNKNOWN | 有文件变化的失败、容器状态无法核实、后置清单不可靠等 |

失败、未知和中断均经既有 REPOSITORY_FAILURE → BLOCKED 流程处理。Human Stop 先写入 Controller；取消异步进行，后续结果不得清除 Stop 或成为通过证据。恢复不重跑命令，未完成尝试标为 EFFECT_UNKNOWN；换 idempotency key 也不能绕过当前 cycle 的已尝试 Operation。

## 验收方式

`npm test` 默认运行本地契约、真实 Git/进程/SQLite，并明确跳过依赖外部环境的 Docker/真实 Agent E2E。Docker 测试需设置 `CCCP_DOCKER_TESTS=1`；M4 真实 Agent E2E 需设置 `CCCP_REAL_AGENT_TESTS=1`。实际测试要求 Node >=24.14、Git、可用 Linux Docker 与包含 `/usr/local/bin/node` 的固定镜像。

在可信操作员准备镜像并记录 digest 后，PowerShell 执行：

```powershell
$env:CCCP_DOCKER_IMAGE = 'node@sha256:<已核实的 64 位摘要>'
$env:CCCP_DOCKER_TESTS = '1'
node --test tests/process-tool-runner.test.mjs
Remove-Item Env:CCCP_DOCKER_TESTS
Remove-Item Env:CCCP_DOCKER_IMAGE
```

测试只在系统临时目录创建仓库/worktree 和带 org.cccp.execution label 的容器。显式启用时缺少镜像/引擎是失败，不能当作 skip。场景包括挂载/环境/网络、junction、clean/unknown、输出、资源、超时与 detached 子进程、真实 Artifact、Human Stop、Host SIGKILL 后 orphan 清理。真实 Agent 接线和独立 R3 仍不属于 M3。
