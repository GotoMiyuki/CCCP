# CCCP v0.2.0 用户指南

**我现在打开 CCCP，第一句话应该输入在哪里？** 按第 1 节启动讨论，在终端提示符后输入自己的需求。你可以生成并批准草稿。想体验真实实施、测试和审查，可以从日期示例开始。

下文的命令均在 **CCCP 项目根目录**（能看到 `package.json` 的目录）打开 PowerShell 后执行。模型配置和真实任务命令要在**同一个终端窗口**里运行。

## 1. 讨论需求、批准草稿和查询任务

需要 Node.js 24.14 或以上、Git 和所选服务的 API 凭据。从 CCCP 项目根目录打开 PowerShell，选择下面一种方式。

**使用 DeepSeek。** 如果你已经把 `DEEPSEEK_API_KEY` 保存在本地的 `.env.deepseek.local`，可直接运行：

```powershell
node --env-file=.env.deepseek.local src/chat/cli.mjs --config examples/chat-deepseek-config.json
```

也可以在终端临时输入 key。配置默认使用 `deepseek-flash`，需要改模型时设置 `CCCP_CHAT_MODEL`。

```powershell
$chatKey = Read-Host 'DeepSeek API key' -AsSecureString
$env:DEEPSEEK_API_KEY = [System.Net.NetworkCredential]::new('', $chatKey).Password
Remove-Variable chatKey
npm.cmd run chat -- --config examples/chat-deepseek-config.json
```

**使用 OpenAI。** 选用你的 API 项目支持 Structured Outputs 的模型。

```powershell
$env:CCCP_CHAT_MODEL = Read-Host '讨论模型 ID'
$chatKey = Read-Host 'OpenAI API key' -AsSecureString
$env:OPENAI_API_KEY = [System.Net.NetworkCredential]::new('', $chatKey).Password
Remove-Variable chatKey
npm.cmd run chat
```

在 `你 >` 后输入需求，例如“CLI 的报错不够明确，请和我讨论应该展示哪些信息”。继续补充“不改现有退出码”。输入 `/draft` 生成草稿。看完可以继续讨论并再次输入 `/draft`，用 `/show 1` 查阅第 1 版，用 `/history` 查看已保存的对话。

准备提交时，先用 `/show` 核对最新版的目标、验收条件、建议路径、操作范围、验证命令和基准提交。如果显示的是第 2 版，就输入 `/approve 2`。如果已有后续讨论、生成过新版或仓库 HEAD 已变化，先用 `/draft` 生成并核对当前版本。

审批成功会显示任务 ID、状态 `DISCOVERY` 和独立 Git worktree 的位置。工作区基于草稿列出的提交，源仓库中的未提交改动留在原工作区。用 `/task` 查看任务详情，重复输入同一批准命令会返回同一个任务。每个会话提交一项任务，另一项需求可开启新会话。

输入 `/exit` 后复制终端显示的会话 ID，下次从同一个目录在原启动命令末尾加上 `--resume <会话ID>`。用 npm 启动时，首个参数前加 `--`，例如 `npm.cmd run chat -- --resume <会话ID>`。用 DeepSeek 时保留原命令中的 `--config examples/chat-deepseek-config.json`。会话和草稿保存在本地 `.cccp/chat.sqlite`。没有 API 凭据时仍可恢复和查看已保存的内容。macOS 或 Linux 下使用 `npm`。

批准记录与原始请求保存在会话库，Runtime 任务记录在 `.cccp/chat-runtime.sqlite`，worktree 保留在 `.cccp/chat-worktrees/`。如果批准后终端中断，恢复会话后用 `/task` 查看是否有已提交的任务。若重复批准时提示 `DELIVERY_UNCERTAIN`，说明 Runtime 收到过提交但当前没有可确认的任务记录。

默认项目是 CCCP 自己的仓库。想让讨论围绕另一项目，可复制[示例配置](../examples/chat-config.json)，设置项目描述、建议修改的路径和验证命令，再通过 `npm.cmd run chat -- --config <配置路径>` 开启新会话。仓库路径相对于配置文件。恢复用该配置开启的会话时，带上同一个 `--config`。阶段 A 只向模型发送讨论内容、上一版草稿和用于讨论的项目配置摘要。草稿里的路径与命令用于核对需求。

### 运行自己的日期示例需求

准备好本地 Linux Docker 和第 3 节的固定 Node 镜像，再从 CCCP 根目录启动。下面的命令使用已保存的 DeepSeek 凭据。若凭据已在终端环境中，可用 `npm.cmd run chat -- --demo`。

```powershell
node --env-file=.env.deepseek.local src/chat/cli.mjs --demo
```

首次启动会在 `.cccp/chat-date-demo/` 初始化日期示例。该示例的日期函数目前允许每个月最多 31 天。你可以输入“把四月的上限限定为 30 天，保留其他月份的规则，补充四月 30 日通过和 31 日拒绝的测试”。

1. 输入 `/draft`。确认草稿包括 `src/date.mjs` 与 `tests/checks.mjs`、预期行为和验收用例。根据显示的版本号输入批准命令，如 `/approve 1`。
2. 输入 `/run`。DeepSeek 根据批准的规格提出改动。Docker 应用候选并执行只读测试，随后 Runtime 核对测试结果、逐条规格和独立 R3 审查。讨论、实施与审查共用 `DEEPSEEK_API_KEY`，各自有独立的运行记录。实施模型用 `CCCP_CODING_MODEL` 配置，独立审查模型用 `CCCP_DEEPSEEK_MODEL` 配置，均默认 `deepseek-flash`。
3. 用 `/task` 查看改动前后、测试输出、逐条验收情况和独立审查。若到达 `HUMAN_ACCEPTANCE`，可从输出中的 worktree 运行 `node src/date.mjs 2024 4 30` 和 `node src/date.mjs 2024 4 31`，亲自核对结果。
4. 需要之后再确认时，输入 `/defer`，也可以附上原因，例如 `/defer 等我试跑两个日期`。输入 `/exit` 后，在原启动命令末尾加 `--resume <会话ID>`，重新打开就能看到同一任务、worktree 和暂缓记录。用 `/task` 查看完整证据。
5. 核对完成后，输入带理由的命令，例如 `/accept 四月 30 日通过，31 日按预期拒绝`。任务变为 `DONE`，`/task` 会显示验收人、时间、理由和关联的 R3 证据。重复验收会显示已保存的决定。仅查看或验收已有结果时，可以用 `node src/chat/cli.mjs --demo --resume <会话ID>`，无需加载模型凭据或启动 Docker。

人工验收前会核对获批提交和最近一次 R3 审查的证据。如果测试后的文件内容变了，任务保留待验收状态。可以恢复到审核过的内容后再确认，或为新改动创建任务。任务出现 `BLOCKED` 时，先用 `/task` 查看失败原因及变更提议。若显示 `RECONCILIATION_REQUIRED`，其中列出的工具或模型运行仍需要对账。重开会话不会重新发出这些操作。

### 预设执行示例

第 3 节的完整执行与审查由测试宿主装配，使用独立的预设任务。

| 你想做什么 | v0.2.0 实际从哪里取得输入 |
|---|---|
| 提交需求、确认允许改什么 | 真实示例的宿主脚本（负责启动和协调任务的本地程序）从预设数据取得目标、决策、验收要求、授权范围和项目配置，以 Human 身份调用 `startTask`。这些内容由程序提供。 |
| 告诉 coding agent 开始写代码 | 测试脚本调用 `dispatchAgent`，在 `input.instruction` 中给出“把示例文件改成 ready”的指令。没有用于替换这段话的命令行参数。 |
| 中途追问、补充要求，或批准扩大范围 | 当前示例没有对话框、追问命令或重新授权提示。另开聊天发消息不会更新这次运行。 |
| 查看结果、决定是否接受 | 示例把差异、测试和独立审查写入可选的审计文件，读法见第 3 节。默认用例到 `HUMAN_ACCEPTANCE` 后结束并清理临时工作区，不会停在终端等你输入“接受”。 |

接入方可以对照[宿主装配](../tests/fixtures/real-agent-host.mjs)、[任务调用顺序](../tests/e2e-real-agents.test.mjs)和[宿主接口](HOST_RUNTIME_SPEC.md)。

## 2. chatting_agent 和 coding_agent 在哪里选？

讨论端由交互宿主读取配置。实施和审查端由仓库自带的**真实测试宿主**读取配置。

| 你想换的角色 | 当前接法 | 在哪里调整 |
|---|---|---|
| 陪你讨论需求的 `chatting_agent` | 交互宿主支持 DeepSeek 和 OpenAI 的 Responses API，用于多轮讨论和草稿生成。 | 按第 1 节选择讨论端。DeepSeek 使用 `DEEPSEEK_API_KEY`，OpenAI 使用 `OPENAI_API_KEY`。两者均可用 `CCCP_CHAT_MODEL` 覆盖配置中的模型。 |
| 写代码的 `coding_agent` | 当前真实宿主通过本机 Codex App Server 生成修改候选，由宿主调用 Docker 应用修改和测试。 | `CCCP_CODEX_MODEL` 选择这个 Codex 后端可以使用的模型。省略时沿用本机 Codex 配置。更换实施服务商需要实现并接入实施 Provider。 |
| 实施后独立审查的模型（R3） | 宿主支持独立的 ChatGPT 会话、OpenAI Responses API 或 DeepSeek 审查端。审查者读取任务证据并给出判断。 | 按下表选择。改变审查模型只影响 R3，不会创建前端聊天入口。 |

**真实示例按从上到下的顺序选择审查端，第一项满足即生效。**

| 当前 PowerShell 进程中的设置 | 最终使用的审查端 |
|---|---|
| `DEEPSEEK_API_KEY` 有值 | DeepSeek。用 `CCCP_DEEPSEEK_MODEL` 指定模型，省略时使用代码默认值 `deepseek-flash`。 |
| 上一项未命中，且 `OPENAI_API_KEY` 和 `CCCP_REVIEW_MODEL` 都有值 | OpenAI Responses API，使用 `CCCP_REVIEW_MODEL`。仅设置 API key 不会触发这个分支。 |
| 其余情况 | 使用本机 Codex 登录启动独立 ChatGPT 审查会话。模型依次取 `CCCP_REVIEW_MODEL`、`CCCP_CODEX_MODEL`、本机默认配置。 |

**最短路径：用现有 Codex 登录跑实施和审查。** 在专用于本次试跑的终端执行下面的命令，让两个角色都使用本机默认模型。清理只作用于这个终端进程。

```powershell
Remove-Item Env:DEEPSEEK_API_KEY, Env:OPENAI_API_KEY, Env:CCCP_CODEX_MODEL, Env:CCCP_REVIEW_MODEL -ErrorAction SilentlyContinue
```

想让两个角色用不同模型，再执行下面两行，分别输入当前账号可用的模型 ID。想保留某个角色的默认设置就跳过对应行。

```powershell
$env:CCCP_CODEX_MODEL = Read-Host '实施模型 ID'
$env:CCCP_REVIEW_MODEL = Read-Host '独立审查模型 ID'
```

**如果想让 DeepSeek 做审查**，可以保留上述 Codex 实施配置，再执行下面两行。输入 key 时终端会隐藏字符。本示例脚本从进程环境读取凭据；把 key 写入普通配置 JSON 不会接入模型。

```powershell
$keyInput = Read-Host 'DeepSeek API key' -AsSecureString
$env:DEEPSEEK_API_KEY = [System.Net.NetworkCredential]::new('', $keyInput).Password
```

**如果想用 OpenAI API 做审查**，在上述最短路径的干净环境中设置 `CCCP_REVIEW_MODEL`，再按同样方式读取 key 并赋给 `$env:OPENAI_API_KEY`。实现中已有 DeepSeek 的独立接口验证，Codex + DeepSeek 组合的完整流程稳定性仍待验证。后端接线与已知边界见[模型接入规范](AGENT_PROVIDER_SPEC.md)和[版本验证记录](development_logs/2026-11-19-v0.2.0-summary.md)。

## 3. 怎么亲手跑一个使用真实模型的任务？

这个例子在临时 Git 仓库里把 `src/value.txt` 从 `pending` 改成 `ready`，运行测试，再请独立模型审查。它会使用所选模型账号的额度。只想先看一遍结果，可以直接打开[已保存的正常运行结果](audit/m4/normal.json)。

**准备环境。** 需要 Node.js 24.14 或以上、Git、已登录且终端可调用的 Codex CLI，以及运行本地 Linux 容器的 Docker。先检查：

```powershell
node --version
git --version
codex --version
docker context show
docker info --format '{{.OSType}}'
```

最后一行应输出 `linux`。选择好第 2 节的模型后，准备测试使用的固定 Node 镜像。下面的摘要来自[仓库的真实运行报告](M4_E2E_REPORT.md)。本机还没有这个镜像时，`docker pull` 会下载它。

```powershell
$env:CCCP_DOCKER_CONTEXT = (docker context show).Trim()
$env:CCCP_DOCKER_IMAGE = 'node@sha256:50c8e8ca1d27439048670df5883f32d57cf81cff6233222c893fd0d9884cbd81'
```

**运行正常路径并保留结果。** 在同一个终端执行：

```powershell
docker pull $env:CCCP_DOCKER_IMAGE
$env:CCCP_REAL_AGENT_TESTS = '1'
Remove-Item Env:CCCP_HUMAN_ACCEPT -ErrorAction SilentlyContinue
$env:CCCP_E2E_AUDIT_DIR = Join-Path $PWD ('.cccp/user-demo-' + [guid]::NewGuid().ToString('N'))
node --test --test-name-pattern='real Codex implementation' tests/e2e-real-agents.test.mjs
```

这里仅选择正常路径。看到目标用例通过后，读取**本次**报告：

```powershell
$run = Get-Content -Raw (Join-Path $env:CCCP_E2E_AUDIT_DIR 'normal.json') | ConvertFrom-Json
$run.state
$run.agent_runs | Select-Object kind, provider, model, status
$run.artifacts | Select-Object type, content | Format-List
($run.agent_runs | Where-Object kind -eq 'review').output | ConvertTo-Json -Depth 8
```

依次确认：状态为 `HUMAN_ACCEPTANCE`；实施和审查记录中的服务商符合预期（`configured-default` 表示沿用本机配置）；`DIFF` 与 `TEST_RUN` 能说明改了什么、测试是否通过；最后读审查者的理由。这份 JSON 可以在测试清理后继续查看。若目标用例显示 `SKIP`，检查当前终端的 `CCCP_REAL_AGENT_TESTS` 是否为 `1`。若报模型不可用，检查角色实际走的后端以及你设置的模型 ID。试跑结束后关闭这个专用终端即可结束本次进程环境配置。

## 4. 只想看看流程或检查自己的仓库

以下命令使用 Node.js 22 或以上，无需安装 npm 依赖、配置模型或启动 Docker。仓库检查需安装 Git。

| 想做什么 | 在 CCCP 根目录执行 | 怎么读结果 |
|---|---|---|
| 看协议演示 | `npm.cmd run demo` | `SIMULATION ONLY` 表示审批和证据由脚本提供，`DONE` 表示预设流程结束。 |
| 看宿主模拟调用 | `npm.cmd run demo:runtime` | `operations` 和 `agent_runs` 是模拟调用次数。 |
| 查看当前仓库 | `node src/cli.mjs discover .` | 核对 `repository.path`、`working_tree_status` 和 `changed_files`。查看其他项目时，把点换成带引号的目录路径。 |
| 检查项目配置 | `node src/cli.mjs validate Profile examples/project-profile.json` | `Profile: valid` 表示配置通过格式校验。打开[示例配置](../examples/project-profile.json)可查看允许和禁止的操作、验证命令和人工验收开关。 |

macOS 或 Linux 下将 `npm.cmd` 换成 `npm`。第 2、3 节的环境变量设置和结果读取示例使用 PowerShell。
