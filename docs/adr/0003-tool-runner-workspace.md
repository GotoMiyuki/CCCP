# ADR 0003 — Docker 工具执行与 Git 工作区

状态：Human 已批准 M2/M3 文件计划及 Docker 后端；实现已提交到工作区，真实容器退出条件尚待验收。协议保持 CCCP 1.0。

## 决策

M3 使用本机 Linux Docker 引擎执行 Host 预注册的工具绑定，使用 Git detached worktree 隔离任务文件，使用同一 SQLite 控制数据库中的仓库租约约束写入者。不上线真实 Agent，不新增协议状态。

操作开始前，Host 原子记录尝试、原 Docker context、容器身份与镜像摘要。恢复只清理既有执行，不重新运行命令。租约超时和旧 Host 死亡都不足以证明容器已停止；接管须完成原执行身份的核实与清理。

工具只见到明确挂载的授权子树。容器根文件系统只读，网络关闭，移除 capabilities，启用 no-new-privileges、默认 seccomp、资源限制与有界临时目录。命令、参数、镜像和环境来自可信 Host 绑定；模型不能提供宿主回调、任意命令或挂载。

宿主的 Git 操作禁用 hooks、fsmonitor 与自定义 clean/smudge/process filters，避免工作区创建和 Discovery 成为容器之外的执行入口。自定义 filter 内容不会在 checkout 时展开。

## 取舍

选择 Docker 增加了外部引擎和固定镜像前提，允许在 Windows 宿主通过 Linux 容器实现统一的执行约束。未选择裸子进程或 Node permission model 作为恶意工具隔离边界。无 Docker 时明确不可用，不退回宿主执行。

首版拒绝整个仓库根、Git 元数据、symlink/junction、硬链接和特殊文件挂载。新增文件须放在已批准且存在的目录挂载内。完整挂载内容清单包含 ignored 文件，超出清单上限时拒绝运行。

首版采用每个共享 Git repository 一个写入者；不同 worktree 仍互斥。所有参与 Host 必须使用同一个控制数据库。超时不会强制回收仍存活的 owner，牺牲可用性来避免重叠执行；同一未被替换的 owner 可以续租。PID 生死不明也按仍存活处理。

文件限制是每文件大小；不声称提供整个宿主磁盘配额、多租户内核安全或抵御可信 Host 管理员。宿主和 Docker 管理接口仍须受保护。

## 证据与状态

规范见 [TOOL_RUNNER_SPEC](../TOOL_RUNNER_SPEC.md)，验收状态见 [M3 日志](../development_logs/2026-09-17-host-runtime-m3.md)。实际 Git、跨进程租约、路径和恢复守卫检查已有证据；容器网络、资源、取消和 orphan cleanup 的端到端测试必须在 Docker 恢复后通过，才能宣布 M3 完成。未进行独立 R3。
