# MoTA Executor for Codex

把本机 Codex 接入 MoTA Creator 的绑定式 Pull Agent。一个本机 Worker 可以托管多个 Agent，分别心跳、长轮询、续租和回传。Codex 插件提供绑定、检查、日志和启停入口。Worker 由 macOS 的用户级 `launchd` 管理，关闭 Codex 后仍可运行，意外退出后由系统重启。已启动的服务会在以后登录 macOS 时加载，注销或休眠期间暂停接单。

## 安装

准备 macOS、Node.js 22 或更新版本、支持 `exec --json` 和权限配置的 Codex CLI（已验证本机 `0.167.0-alpha.4.1`）。从 Codex 打开并信任本地源码目录。使用压缩包时直接解压，团队仓库分发时可以克隆。

```sh
git clone git@github.com:mota-developer/codex-mota-executor.git
cd codex-mota-executor
```

在 **Plugins** 中从 **MoTA Developer** marketplace 安装 **MoTA Executor**。目录尚未刷新时，重启 Codex 后再查看。支持 CLI 插件安装的版本也可以在克隆目录运行下面的命令。

```sh
codex plugin marketplace add .
codex plugin add codex-mota-executor@mota-developer
```

插件安装后，可在 Codex 聊天中选 **MoTA Executor** 或调用 `$codex-mota-executor:codex-mota-executor`。在终端中用下面的命令查看状态。

```sh
node "/path/to/codex-mota-executor/plugins/codex-mota-executor/bin/mota.mjs" status
```

## 绑定并启动

1. 把 MoTA Creator Center 提供的绑定式 Worker bundle 或完整接入指令保存到当前用户的本机文件，执行 `chmod 600 "/absolute/path"`。运行 `bind --file "/absolute/path"`。CLI 直接读取 Token，在 Codex 中只提供路径。
2. 将 `bind` 或 `status` 显示的 `codexHome` 路径代入下方命令，在终端完成一次 Codex 登录。默认目录是数据目录下的 `codex-auth`。已有该目录的有效登录时可以跳过。
3. 运行 `check <agentCode>`。通过后执行 `enable <agentCode>` 和 `start`。Worker 会连接 Creator，并为已启用的 Agent 领取真实任务。服务已加载时，用 `restart` 应用更改。
4. 查看 `status` 和 `logs`，再到 Creator 页面点 **Test connection**。本机 `check` 使用合成数据，验证的是 Codex 执行和输出契约。Worker 心跳表示队列接口可达，`executorReady` 表示执行器已通过自检，实际任务是否被采纳以 Creator 的 `accepted` 回执为准。

```sh
CODEX_HOME='/absolute/path/from/codexHome' codex login
```

执行器使用上面的独立登录目录和默认 OpenAI 提供方。它在临时工作目录运行，跳过个人 Codex 配置和项目说明，对任务输入筛选字段、清理已知凭据字段后发给模型。接入前先确认这些业务数据获准发往该服务。合成检查、自动自检和任务执行都会占用所登录账号的模型配额。

`bind` 支持 `--model MODEL`、`--codex-bin /absolute/codex`、`--codex-home /absolute/auth-dir` 等设置，完整参数见 `--help`。指定 `--codex-bin` 时，用同一个可执行文件登录。多个 Agent 可以共享登录目录。如需隔离另一套配置与常驻进程，给各命令传同一个 `--data-dir /absolute/path`。

下表列出传给 `node "/path/to/bin/mota.mjs"` 的参数。

| 命令 | 操作 |
| --- | --- |
| `bind --file /absolute/path` | 读取绑定文件，保存 Agent 配置。 |
| `check [agentCode]` | 调用 Codex 处理合成输入，不领取平台任务。 |
| `status` | 查看服务和 Agent 状态。 |
| `logs [--lines N]` | 查看最近 1–200 行 Worker 日志，默认 30 行。 |
| `enable <agentCode>` / `disable <agentCode>` | 启用或停用一个 Agent。 |
| `start` / `stop` / `restart` | 管理本机用户级常驻服务。 |
| `run` | 前台运行，为已启用的 Agent 领取任务，Ctrl+C 停止。 |

## 常驻与恢复

新绑定默认停用。创建绑定后，显式启用 Agent 并启动服务。运行中的 Worker 在下次 `restart` 读取绑定和启停配置，同时换用当前插件代码。停用最后一个 Agent 后，`restart` 会停止已加载的服务。

`stop` 和 `restart` 会先停止发出新认领请求。已发出的长轮询最多等待 40 秒，已认领的任务另有最多 20 秒完成回传。升级时先等新进程完成本地初始化，再删除上一版运行副本。新版启动失败时恢复上一版。

领取租约仍有效或 Creator 重新下发同一 `runId` 时，Worker 按原字节重放已落盘的结果。租约过期且 Creator 未重新下发的记录会再保留 24 小时，随后记为未确认并清理。连续三次自检失败后，Worker 暂停自动自检并继续发送心跳。排查后可先运行 `check`，再用 `restart` 恢复。

默认数据目录是 `~/Library/Application Support/codex-mota-executor/`。Worker 的运行副本和状态独立于插件缓存。卸载前先执行 `stop`，停掉常驻进程和登录项。

| 路径 | 内容 |
| --- | --- |
| `config.json` | 绑定及 Worker 配置，含 Creator Token，属于当前用户的私有文件。 |
| `codex-auth/` | Worker 的 Codex 登录目录。 |
| `runs/` | 各 Agent 的待确认回传和最近回执。待回传结果可能包含业务数据。 |
| `worker.log` | 常驻 Worker 运行日志。 |

## 协议与验证

Pull 协议和岗位 V2 输出契约来自同团队的 [DSH MoTA Executor](https://github.com/mota-developer/dsh-mota-executor)。Codex 版用独立登录和每次任务的临时工作目录执行，检查真实用量并在回传前保存待确认结果。

目前接入范围为绑定式 Pull Agent，换 Token 采用手工换绑。把 Creator 已生效的绑定重新保存到私有文件，执行 `bind` 和 `restart`，原 Worker ID 和 Agent 开关会保留。Creator 发给 Worker 的候选 Token 轮换指令需要独立候选心跳，当前 `bind` 会拒绝这类指令。

在仓库根目录运行 `npm test`。用 `MOTA_TEST_LAUNCHD=1 npm test` 追加实际 LaunchAgent 测试。假队列覆盖认领、续租、回传、停机和重启恢复。生产接入以 Creator 的连接测试和一条真实任务的回执为准。

## Codex 插件规范

仓库用 `.agents/plugins/marketplace.json` 提供私有 marketplace，插件根目录的 `plugin.json` 声明 Agent Plugins 清单，`skills/` 提供 Codex 内的操作入口。OpenAI 的 `@plugin-creator` 用于制作插件。MoTA Creator Center 负责签发 Agent 绑定并派发任务。[OpenAI 插件打包文档](https://developers.openai.com/plugins/build/plugins)
