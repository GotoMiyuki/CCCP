# Codex Adapter 接口草案

对应 Design Guide §4.3、§20、§21、§24、§36。Adapter 将真实仓库观察与受限操作连接到 Execution Layer；不解释或批准 Architecture。

## 接口

```js
const adapter = new CodexAdapter({ controller, actor: authenticatedCodex });
await adapter.discover();
controller.plan(authenticatedCodex, { summary, operations });
await adapter.begin();
await adapter.execute(operationId, hostBoundTool);
controller.report(authenticatedCodex, implementationReport);
```

| 方法 | 输入与行为 |
|---|---|
| `discover(options)` | 观察 Profile repository，将结果送交 Controller；仅在 DISCOVERY / REVISION 使用 |
| `begin({progress})` | 用同一观察范围重新 Discovery；调用方不能覆盖 fresh fingerprint |
| `execute(operationId, handler)` | IMPLEMENTING 状态下定位已授权计划操作，校验路径，再调用宿主绑定工具 |

`discovery` 可注入为构造参数，便于测试或接入另一种真实 Repository 观察方式；生产宿主不能接受消息提供的伪造 Discovery 函数。

执行按 Controller 串行化。多个 Adapter 实例共享操作锁、观察选项和尝试记录；重新创建 Adapter 不会获得第二次执行机会。同一 Decision / Revision 周期内每个 Operation ID 最多尝试一次。操作只能由当前实现者执行。工具抛错时实际副作用可能不明确，因此进入 Repository BLOCKED，重新观察后再决定恢复，不盲目再次调用工具。

Discovery、begin 和 execute 的异步结果均校验控制器状态版本。若等待期间 Human 终止、Override 或任务状态已改变，返回 `EXECUTION_INTERRUPTED`，不覆盖更新后的状态。工具未结束时不能提交 Implementation Report。

该保护会阻止旧结果继续推进任务，但不能撤销已运行回调的副作用。宿主如需中止正在运行的实际工具，仍须提供工具层取消能力。Human 终止后即使回调正常返回，任务也不会自动恢复。

代码或测试发现实现错误，应提交 Implementation Report 和结构化 R1 / R2 判断，由 Controller 进入 REVISION。修订前重新 `discover`，然后 `begin({ progress: '新的分析、状态或修正说明' })`。执行器不自行重试或调用 Reviewer。

## 宿主责任

1. 提供已认证 Codex identity，并将真实 Human 授权交给 Decision Layer。
2. 将工具的真实影响绑定到 Operation 的 `domain`、`paths`、`permission` 和 `changes_decision`；不可由模型把任意命令标记为“内部实现”后获得额外能力。
3. 在工具 / OS 层实施文件和网络权限。回调是可信宿主代码，不是 JavaScript 沙箱。
4. 实际执行 Project Profile 中获准的 verification commands，并将命令、退出码、输出或测试符号写入 Review evidence。
5. 生成可追踪 Implementation Report，报告实际变更和偏离。
6. 仅在 Router 要求时将 R3 交给独立 ChatGPT / Human；收到 Judgment 后由 Controller 应用。

首版不启动特定 Codex CLI，不提供模型调用或网络 Git 操作。外部 Adapter 可以保持相同接口，接入实际 Codex 工具；需要另行验证身份映射、权限隔离和工具结果真实性。
