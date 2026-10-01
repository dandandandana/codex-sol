# T1 · 最小合同与失败语义

## 1. 适用边界

合同是内部接口，不是 Codex Hook API。T0 CLI 探针确认通用 `PostToolUse` 不提供实际 `changed_paths`，且失败但已改动的命令可能给出空 `tool_response`；因此事件由受控修改工具 `sol_apply_changes`、`sol_apply_patch` 或 Windows Bash Hook runner 根据实际变化产生。受管修改与同步验证在同一工作区跨进程串行；验证同步完成后 wrapper 将结果与短回执附在工具结果中。原始输出只由受管边界捕获。Codex Desktop 既有正常冒烟覆盖旧三工具。新增 CLI 夹具记录了 Shell 非零退出、超时、runner 停止、精确 recall，以及原生 patch 被路由到 `sol_apply_patch`；这四次 CLI 运行启用了单次 `--dangerously-bypass-hook-trust`，不能证明常规 Hook 信任流程。独立 TUI 在无 trust bypass 下完成三个 Hook 的 `/hooks` 审阅；重启后实际验证了原生 patch 被拒并路由到 MCP patch、MCP patch 验证成功、旧超时输出可精确 recall、非零 Shell 失败由 Post 回传。两次按 Esc 停止校验都仍运行并最终 `timeout`；其中一次透明 wire capture 到完整结果仍没有 `notifications/cancelled`，仅适用于该本机 CLI 0.158.0 调用。Node stdio 取消测试不能代替宿主按键取消验收；重启后的 TUI 结构化证据见 [fixtures/t3/tui-evidence.json](fixtures/t3/tui-evidence.json)。Desktop `OpenAI.Codex 26.928.1915.0` 的宿主 core 为 0.159.0，外部 CLI 与 patch exe 为 0.158.0。普通 Shell、143,118 字节输出打包和 keyword recall、原生 patch deny 后相同 patch 经 MCP 验证并可 recall 回执、Shell exit 7 stderr JSON 反馈均通过。GUI Stop 显示 interrupted 后 runner 仍存活，最终 90 秒 timeout；该 Desktop 停止验收失败，停止后的新 MCP patch 和旧 stdout/receipt 精确 recall 均已通过。三项 Hook 定义先前已在 TUI 信任，本轮沿用了同一 Hook 定义，未单独重新审核 Desktop 信任流程；正式结构化记录见 [fixtures/t3/desktop-native-evidence.json](fixtures/t3/desktop-native-evidence.json)。

所有跨进程对象必须先通过 [runtime.schema.json](runtime.schema.json) 对应 `$defs` 校验。未知字段、未知状态、非法 selector 一律拒绝。时间为 UTC ISO 8601；路径为工作区内 `/` 分隔的相对路径。路径解析时禁止越过工作区、拒绝符号链接逃逸。handle 是存储层生成的不可猜测标识，不是文件路径。

取消证据按调用路径区分：TUI 两次 Esc 与旧 Desktop 无桥接 GUI Stop 的运行仍分别以 `timeout` 结束，且未观察到 `notifications/cancelled`；它们是历史宿主原生取消失败，不能改记为通过。Windows Desktop 后续的单项显式事件桥接试验观察到匹配 turn 的 `turn_aborted` 并中断正在运行的 MCP 调用；紧接着的 recovery chat 又通过 MCP patch 和旧 stdout/receipt 的两项精确 recall，详见 [fixtures/t3/cancellation-compat-evidence.json](fixtures/t3/cancellation-compat-evidence.json)。当前证据状态为 `desktop_tui_bridge_passed`：TUI 0.159.2 的 Esc 桥接验收也已通过，停止到响应 571 ms；中断后的 patch 验证通过，旧 stdout/receipt 在纠正召回参数后精确召回成功。两种宿主的 MCP 桥接结果均不覆盖原生 Shell Hook 取消路径。

## 2. 入口与责任

| 接口 | 输入 | 输出 | 副作用与失败 |
| --- | --- | --- | --- |
| `onChange(event: ChangeEvent)` | 实际改动路径、事件 ID、变更摘要 | `ValidationReceipt` | 串行选择规则、运行命令、归档输出与完整回执；重复 event_id 返回同一回执；运行中断记 `error/interrupted`，不自动重跑。 |
| `sol_apply_patch(patch)` | Codex Begin Patch / End Patch 格式，最多 24,000 UTF-8 字节 | `ManagedCommandResult` | Windows 配置 `CODEX_SOL_PATCH_EXECUTABLE` 为实际 Codex `.exe` 后，以 `--codex-run-as-apply-patch` 调用原生 patch 引擎；按工作区快照识别真实改动并验证。 |
| Windows Bash Hook runner | 原宿主 Bash/Shell 的 1–8000 字符命令及 `NativeConfig` | `ManagedCommandResult` 写入私有结果文件 | PreToolUse 改写当前 Shell 命令为本地 runner 启动命令；runner 在宿主 Shell 的工作目录、sandbox/token 下执行配置的 PowerShell，再对比变化并同步验证；PostToolUse 从私有结果文件读取失败结果。 |
| `capture(meta: CaptureMeta, chunks: AsyncIterable<Uint8Array>)` | 包装边界取得的字节流或序列化响应 | `RawRef` | 工具启动前建立临时归档；边收边写，校验大小和 SHA-256，fsync 后原子提交；失败不发 handle。 |
| `pack(meta: PackMeta, refs: RawRef[])` | 已提交原文引用与原工具结果状态 | `ObservationPack` | 按字节预算生成确定性摘要和摘录；不调用模型；失败语义不可改成 `ok`。 |
| `recall(request: RecallRequest)` | handle 与 lines / keyword / bytes selector | `RecallResult` 或 `RecallError` | 每次打开核验 SHA-256，从不可变原文读取；单页最多 8 KiB；不接受任意路径。 |
| workspace lock owner (`LockOwner`) | workspace owner PID 与 runner 状态 | `.codex/sol/managed-modification.owner.json` 持久化记录 | 由 `src/workspace-lock.mjs` 写入和恢复；`src/server.mjs` 将 `lease.setRunner` 接入 `ValidationEngine.onChange` 的 `onRunnerState`。字段与状态由 schema `#/$defs/LockOwner` 定义。 |

`PackMeta` 至少含 `schema_version`、`call_id`、`tool`、`tool_status`、`upstream_complete`。这些是 wrapper 内部参数，不另定义宿主协议。`CaptureMeta` 与所有可持久化对象的字段见 schema。验证 stdout、stderr 分开 capture；非流式结构化工具响应保存完整 UTF-8 JSON envelope，`source_form=response_json` 表示保存形式，不宣称保留网络原始字节。外部资源链接只作为 envelope 内容保存，不下载。

## 3. 变更与规则

- 适配器必须报告实际改动，包含删除；工具报错但有部分改动仍触发。无改动不生成验证事件，不运行命令。
- `change_digest` 对按路径排序的改动清单计算 SHA-256；每项含路径、最终文件原始字节 SHA-256 或显式删除标记。校验失败不能继续给出 `passed`。
- 只处理 `origin=agent`。验证自身产生的日志、构建产物和 `.codex/sol/` 不创建新事件。
- 规则按配置数组顺序选择：任一 `changed_paths` 命中规则 `globs` 即选该规则；同一事件的所有命中规则依序执行，各命令依序执行。命令 ID 以 `rule.id/command.id` 标识，配置内必须唯一；不去重、不推断测试。
- `watch_paths` 必须覆盖该规则验证依赖的完整项目输入树，包含未提交文件、配置、锁文件和删除状态。`.git/`、`.codex/sol/`、声明的生成物排除。glob 以工作区为根，`/` 分隔，匹配隐藏文件；不允许 `..` 或绝对路径。
- `validation_key = SHA-256(输入树规范快照 + 所选规则与命令配置的规范 JSON)`。快照按相对路径排序，含文件类型与内容 SHA-256，缺失和删除以显式状态表示；不能只看 Git HEAD 或本次修改列表。目录穿越、无法读取或不稳定快照为 `error`，不得 `passed`。
- 规则未命中返回 `skipped/no_rule`。同一 `event_id` 重复投递复用原回执；不同事件即使 `validation_key` 相同，也重新运行。
- 命令只用 `argv` 执行，不经 shell，不自动安装或修复。默认单命令 120000 ms，总预算 300000 ms；首个非成功后，剩余命令记 `skipped`。超时终止其进程树。
- 运行前后对比完整输入快照；不同则顶层 `stale/input_changed`，已执行检查保留实际状态，不重试。`passed` 仅意味着列出的检查通过且快照稳定。

## 4. 归档、打包与召回

- wrapper 在调用上游前确认目录可写和剩余空间并建立临时归档。capture 的 begin 失败时工具不启动；write 或 commit 失败时返回 `ObservationPack.mode=storage_error`，summary 标记 `tool_may_have_executed=false|true`。调用一旦可能开始便不重放；存储失败即停止消费，不把未归档原文经其他通道旁路返回。未提交的 capture 不公开 handle，临时文件保留，打开的资源关闭。
- 每次成功提交的调用生成不同 handle；原文及 meta 提交后不可变。meta 记录工作区、调用、工具、UTC 时间、大小、SHA-256、编码、完整性和保存形式。后端遇到上游取消或读取失败时，已成功捕获的字节前缀仍提交为 `RawRef.complete=false`，可通过 handle recall；不会声称上游完整。只保证包装边界实际收到的字节。MCP SDK 2.2.0 收到 `notifications/cancelled` 后会 abort handler signal 并抑制已取消请求的 JSON-RPC 响应，所以此路径不保证客户端收到带有部分 handle 的响应。
- 所有受管输出归档。原始总量 `<= 8192` 字节用 `inline`；`> 8192` 用 `packed`。packed 的完整模型可见 JSON 序列化后 `<= 4096` UTF-8 字节，摘要只说明状态、大小、完整性与遗漏量。摘录取头尾、标注字节范围；长行按预算切分且标不完整。不可把原文通过其他可见通道旁路送入 trajectory。
- 完整 `ValidationReceipt` JSON 先归档。每个 check 含非空 `reason`，明确成功、失败或跳过的具体原因；顶层 `reason` 说明整体状态。可见摘要 `<= 4096` UTF-8 字节，包含事件和代码摘要、顶层状态、已执行/跳过数量与原因、首个失败、退出码、耗时、原文 handle 和完整回执 handle。超预算时省略逐项明细，不能把隐藏的检查说成未执行。归档失败使顶层为 `error/storage`，保留已知检查结果。
- `lines`：1 起始、两端包含，UTF-8 有效文本，LF 分行；保留 CRLF 原字节，末尾无换行仍是一行。`keyword`：大小写敏感的字面子串，默认上下文 2 行、允许 0–10，重叠窗口合并并按原文排序。`bytes`：0 起始、左闭右开；返回 base64 以保证逐字节精确，包括文本切片。
- 每次 recall 序列化响应 `<= 8192` UTF-8 字节；分页 cursor 绑定工作区、handle、SHA-256、selector 和下一偏移，禁止串用。超长单行拆页并给精确字节范围。无命中返回空 `chunks`、`truncated=false`、`next_cursor=null`。

## 5. 状态与失败分支

| 条件 | 输出 | 必须保留的证据 / 行为 |
| --- | --- | --- |
| 无改动 | 无 `ChangeEvent`、无验证 | 工具原始状态不改变 |
| 无匹配规则 | `skipped/no_rule` | 不声称验证通过 |
| 命令退出码 0 / 非 0 | `passed` / `failed` | 退出码、耗时、stdout/stderr handle |
| 命令超时 | `timeout` | 终止进程树，保存已收到输出；后续检查 skipped |
| 命令找不到、权限或 runner 异常 | `error` | 诊断原因，后续检查 skipped |
| 输入快照变化 | `stale/input_changed` | 已运行检查的真实结果，禁止 passed |
| 重复 event_id / 中断后 running | 原回执 / `error/interrupted` | 不自动重跑 |
| 工具上游失败 / 超时 / 截断 | `tool_status=error/timeout/unknown`、必要时 `complete=false` | 不重写为 ok，不声称上游完整 |
| 上游取消或读取失败 | 后端保留已成功捕获前缀，`RawRef.complete=false`，ObservationPack 带错误语义 | 直接 capture/read 调用可取得中断结果和部分 handle；MCP SDK 取消请求可能不返回 JSON-RPC 响应，客户端不保证取得 handle |
| capture begin 失败 | `mode=storage_error`、`tool_may_have_executed=false` | 不启动上游，不发布 handle |
| capture write / commit 失败 | `mode=storage_error`、`tool_may_have_executed=true` | 停止消费，不重放、不旁路未归档原文；不发布未提交 handle，保留临时文件并关闭资源 |
| 回执注入失败 | 适配器显式失败，或 wrapper 响应携带回执 | 不声称下一轮已见 |
| recall handle 缺失 / 篡改 | `NOT_FOUND` / `CORRUPT` | 不从 summary 重建 |
| recall 越界 / cursor 错配 / 非 UTF-8 行检索 / I/O 失败 | `INVALID_RANGE` / `INVALID_CURSOR` / `UNSUPPORTED_ENCODING` / `IO_ERROR` | `retryable` 只对可重试 I/O 为 true |
| 等待工作区锁时取消 | handler 内部以 `INTERRUPTED` 中断 | 快速结束，尚未开始修改，无工作区改动；经 MCP SDK 2.2.0 取消时不保证客户端收到 JSON-RPC 响应 |
| 配置的宿主桥接观察到目标 turn 的 `turn_aborted` | 既有 MCP signal 被 abort；检查记录 `error/interrupted` | runner 按既有取消路径清理进程树并保留部分输出/回执；不发合成 `notifications/cancelled`，不自动重放 |
| 配置的宿主 metadata、RPC、路径或 rollout 日志无法核实 | `HOST_STATE_ERROR` / `error/host_state_error` | 调用开始前 fail closed；运行中故障中止检查并记 `host_state_error`，不得伪报 `passed` 或重放 |
| native lock 所有者主进程退出、runner 仍存活 | 后续修改继续等待；runner 退出后允许新的修改 | 不终止、不重放旧验证；新事件保留旧 receipts、observations 与 `.running` 证据；同一事件重新投递会将其 `.running` 转为 `error/interrupted` 回执 |
| owner 记录损坏，或 owner 显示 `starting` 且无法确认 child PID | `RECOVERY_REQUIRED` | 先确认相关进程均已退出，再人工检查并处理 owner 记录 |
| 发现旧版 `managed-modification.lock/` 目录 | `RECOVERY_REQUIRED` | 不自动删除；停掉旧进程后再人工清理 |

## 6. 跨进程互斥与恢复

- 锁作用范围是同一 `workspaceId` 的受管文件修改及其同步验证。Windows 使用原生 named pipe，Linux 使用 abstract Unix socket；两者均不监听网络端口。Node.js 最低版本为 20.8。其他 Unix 平台沿用保守的目录锁，崩溃后需要人工恢复。
- Windows 和 Linux 的原生锁由操作系统随主进程退出释放。持锁期间，`.codex/sol/managed-modification.owner.json` 持久化 owner PID 和 runner 状态 `starting`、`running` 或 `idle`。主进程退出而 runner 仍运行时，新进程继续等待；runner 结束后可接收新的修改。新事件恢复不会清理旧 receipts、observations 或 `.running` 证据；若重新投递同一个事件，会将该事件的 `.running` 标记转为已持久化的 `error/interrupted` 回执，不重放旧验证。
- 等锁的请求可取消；handler 内部应快速以 `INTERRUPTED` 结束，且在获得锁和开始修改前不得产生工作区改动。MCP SDK 2.2.0 对 `notifications/cancelled` 会 abort handler signal 并抑制该请求的 JSON-RPC 响应；stdio 验收不得要求客户端收到 `INTERRUPTED` payload。
- owner 文件损坏，或验证启动期间主进程退出、状态停在 `starting` 且无法确认 child PID 时，必须返回 `RECOVERY_REQUIRED`。人工处理前先确认相关 Codex-SoL 主进程和验证 runner 均已退出。旧版 `.codex/sol/managed-modification.lock/` 目录也不会自动清理，需先停旧进程再清理。
- 当前工作环境为 Windows；Linux 与其他 Unix 平台未在此环境实测。其他 Unix 的目录锁崩溃恢复不能套用 Windows/Linux 的 OS 自动释放行为。

## 7. Windows 原生操作接入

- `runtime.schema.json` 中的 `NativeConfig` 和 `NativeRequest` 是 runner 的内部合同，不是 Codex Hook 输入 schema。当前 native Hook adapter 仅支持 Windows；`workspace`、`rules`、`node`、`shell` 都必须是绝对路径。运行时把 workspace 解析为真实路径，规则文件须为有界普通 JSON 文件，Node 和 PowerShell 配置须指向普通可执行文件。`load_profile`、`timeout_ms`（最大 300,000 ms）和 `generated` 按配置生效。
- Codex 按 Git 工作区根发现项目 Hook。`.codex/hooks.json` 与 Hook 所属项目根必须对应 Codex 实际识别的 Git 根；嵌套验收目录要单独使用 Hooks 时，应为该目录建立独立 Git 根（`git init` 即可，无需提交），或把配置放到实际 Git 根。`NativeConfig.workspace` 应指向同一项目根，避免 Hook、runner 与受管工作区不一致。
- 项目 `.codex/config.toml` 需启用 `[features] hooks = true`；已有 MCP server 和 feature 设置应合并保留，不改全局配置。CLI/TUI 从 `/hooks` 审阅项目定义；Desktop 从“设置 → 钩子”检查 project Hook 项目、命令、matcher、timeout 和启用状态。
- `sol_apply_patch` 只接受普通 Codex Begin Patch / End Patch 格式，最大 24,000 UTF-8 字节，路径为工作区相对路径。会拒绝越界路径、分隔符/ADS、`.git/` 和 `.codex/sol/`（大小写别名也拒绝），并在真实文件解析时拒绝经 junction / symlink 逃逸。工具用 `argv=[CODEX_SOL_PATCH_EXECUTABLE, '--codex-run-as-apply-patch', patch]` 调用引擎；该变量必须是安装后真正的 Codex `.exe` 绝对路径，不能是 `.cmd` 或 `.bat` shim。已有三工具行为保持兼容，新增 MCP 工具为 `sol_apply_patch`。
- PreToolUse 对原生 `apply_patch`、`Edit`、`Write` 返回 deny，并告知使用 `sol_apply_patch`。这是路由指引，不会把当前原生调用变成同一 MCP 调用，也不保证覆盖其他写入工具。
- 对 Bash/Shell，PreToolUse 把原命令写入 `.codex/sol/native/` 下的私有请求文件，并把 `updatedInput.command` 改成在原宿主 Shell 中调用本地 Node runner。Runner 从 `NativeConfig` 读取实际 PowerShell 路径、是否加载 profile 和超时；执行时保留宿主选择的工作目录，并要求该目录位于配置 workspace 内。Runner 在原 Shell 工具上下文中执行，宿主配置的 sandbox/token 仍是执行边界；但 PreToolUse 返回 `permissionDecision=allow` 与 `updatedInput`，这有独立审批语义，不能据此声称保留普通 Shell 的逐命令 ask 提示。当前 CLI/TUI 验收运行使用 `-a never` 或 `danger-full-access`，受限 sandbox 和 ask 模式未验证。这不是给模型新增的任意命令 MCP 工具。
- Bash 命令长度为 1–8000 字符。工作区锁覆盖实际执行、执行前后变化检测及有变化时的同步验证。无变化不创建事件，也不验证。变化路径按完整集合记录；响应超预算时可省略 `changed_paths` 条目，但保留 `changed_path_count`、`changed_paths_omitted`，并通过 `change_event_raw` handle 精确召回事件。stdout 和 stderr 都捕获，即使退出码非零、超时或取消；结果中的 `execution`、`validation`、`tool_status` 各自表达执行、验证与宿主工具状态。ObservationPack 最大 4 KiB，managed-command envelope 最大 8 KiB。
- PostToolUse 从 `.codex/sol/native/<call_id>.result.json` 读取提交结果；`tool_status` 非 `ok` 时用 `decision:block` 反馈完整 JSON，不依赖宿主 `tool_response`。执行已经发生后，反馈不会撤销它；中断且无提交结果时不自动重放。
- Hook 是受信任项目配置的一部分，不是绝对安全边界。项目 `.codex/` 必须可信，Hook 必须在宿主提供的入口审阅并信任当前精确定义；CLI/TUI 使用 `/hooks`，Desktop 使用“设置 → 钩子”。不要改全局 trust 设置或常态绕过 trust。未信任项目、Hook 未获信任、其他或专业写入工具都可能绕过本层。本轮 Linux 原生 Hook 接入按用户要求暂缓，不实现或验收。

## 8. Optional MCP host cancellation bridge

- `CODEX_SOL_HOST_EXECUTABLE` is optional. When unset, the MCP SDK signal path is unchanged. When set, it must be an absolute path to the installed Codex executable (`.exe` on the tested Windows setup), not a `.cmd` / `.bat` shim. This environment variable is read by the MCP server; it is independent of project Hooks and does not modify global configuration.
- The bridge applies only to `sol_apply_changes`, `sol_apply_patch`, and `sol_read_file`. `sol_recall` is short and read-only and does not start a host reader. Native Bash/Shell Hook cancellation is a separate host-tool path and is not covered by this optional MCP bridge.
- For each eligible request, a separate app-server reader initializes and issues only `thread/read` with `includeTurns: false`, then exits. The adapter checks the request's `x-codex-turn-metadata`, matching thread ID, workspace cwd, absolute rollout path, session metadata, and a `task_started` row for the target turn. It then scans only the matching thread's rollout log and aborts the existing MCP handler signal only for an explicit `event_msg` / `turn_aborted` row whose `turn_id` matches. Normal MCP SDK cancellation continues to use its existing signal route. The reader does not start or resume a thread; the bridge does not infer cancellation from `turns/list` or another process's unfinished-turn status, or synthesize an MCP cancellation notification.
- Polling interval is 500 ms. The reader RPC has a 5,000 ms total timeout and bounded 1,000 ms close wait. Rollout files over 256 MiB, partial JSONL lines over 2 MiB, replaced/truncated files, malformed rows, mismatched metadata, or unavailable RPC/path evidence fail closed. Once running, a rollout verification fault aborts the existing signal with `HOST_STATE_ERROR`; runner process-tree cleanup, partial output capture, receipt behavior, and lock release follow their existing routes. A target host abort retains the existing `INTERRUPTED` route. Neither case retries the mutation or can produce a false `passed` receipt.
- Host compatibility was exercised only on Windows with Codex CLI 0.159.2 and Desktop core 0.159.2 (the separate patch executable in the fixture was 0.158.0). These app-server/rollout details are not treated as a stable public API or a guarantee for later versions. The current Desktop guarded Stop test is recorded separately from earlier TUI/unguarded Desktop native cancellation failures in [fixtures/t3/cancellation-compat-evidence.json](fixtures/t3/cancellation-compat-evidence.json); it does not complete Windows-wide acceptance.

## 本文档不做的事（Out-of-Scope）

不把 `runtime.schema.json` 当作宿主 Hook schema，也不声称原生 patch 被透明替换成 MCP 调用。CLI 夹具中的单次 trust bypass 不代替项目 Hook 审阅。TUI 信任审阅及重启后的路由、patch、recall、失败 Shell 反馈已有实测；两次宿主 Esc 取消仍以 `timeout` 收尾，不得写作取消通过，新版 TUI 显式事件桥接已另行通过 Esc 验收。旧 Desktop 无桥接 GUI Stop 同样未终止 validator；Desktop 与 TUI 的显式事件桥接、后续修改与精确召回已通过，但不能覆盖历史失败、原生 Shell 或 Windows 所有运行模式。受限 sandbox 与 ask 审批也未测试。不实现 Architecture State / Normify 或页面列出的后续能力。
