# T1 · 最小合同与失败语义

## 1. 适用边界

合同是内部接口，不是 Codex Hook API。T0 CLI 探针确认通用 `PostToolUse` 不提供实际 `changed_paths`，且失败但已改动的命令可能给出空 `tool_response`；因此事件由受控修改工具 `sol_apply_changes`、`sol_apply_patch` 或 Windows Bash Hook runner 根据实际变化产生。受管修改与同步验证在同一工作区跨进程串行；验证同步完成后 wrapper 将结果与短回执附在工具结果中。原始输出只由受管边界捕获。Codex Desktop 既有正常冒烟覆盖旧三工具。新增 CLI 夹具记录了 Shell 非零退出、超时、runner 停止、精确 recall，以及原生 patch 被路由到 `sol_apply_patch`；这四次 CLI 运行启用了单次 `--dangerously-bypass-hook-trust`，不能证明常规 Hook 信任流程。独立 TUI 在无 trust bypass 下完成三个 Hook 的 `/hooks` 审阅；重启后实际验证了原生 patch 被拒并路由到 MCP patch、MCP patch 验证成功、旧超时输出可精确 recall、非零 Shell 失败由 Post 回传。两次按 Esc 停止校验都仍运行并最终 `timeout`；其中一次透明 wire capture 到完整结果仍没有 `notifications/cancelled`，仅适用于该本机 CLI 0.158.0 调用。Node stdio 取消测试不能代替宿主按键取消验收；重启后的 TUI 结构化证据见 [fixtures/t3/tui-evidence.json](fixtures/t3/tui-evidence.json)。Desktop `OpenAI.Codex 26.928.1915.0` 的宿主 core 为 0.159.0，外部 CLI 与 patch exe 为 0.158.0。普通 Shell、143,118 字节输出打包和 keyword recall、原生 patch deny 后相同 patch 经 MCP 验证并可 recall 回执、Shell exit 7 stderr JSON 反馈均通过。GUI Stop 显示 interrupted 后 runner 仍存活，最终 90 秒 timeout；该 Desktop 停止验收失败，停止后的新 MCP patch 和旧 stdout/receipt 精确 recall 均已通过。三项 Hook 定义先前已在 TUI 信任，本轮沿用了同一 Hook 定义，未单独重新审核 Desktop 信任流程；正式结构化记录见 [fixtures/t3/desktop-native-evidence.json](fixtures/t3/desktop-native-evidence.json)。

既有 SoL 跨进程对象必须先通过 [runtime.schema.json](runtime.schema.json) 对应 `$defs` 校验；新增可选 Context 的请求和职责配置由 [context.mjs](src/architecture/context.mjs) 的 Zod 合同校验，模型产物按本地配置的 JSON Schema 2020-12 经 Ajv 校验，归档仍使用原 CaptureMeta / RawRef。未知字段、未知状态、非法 selector 一律拒绝。时间为 UTC ISO 8601；路径为工作区内 `/` 分隔的相对路径。路径解析时禁止越过工作区、拒绝符号链接逃逸。handle 是存储层生成的不可猜测标识，不是文件路径。

取消证据按调用路径区分：TUI 两次 Esc 与旧 Desktop 无桥接 GUI Stop 的运行仍分别以 `timeout` 结束，且未观察到 `notifications/cancelled`；它们是历史宿主原生取消失败，不能改记为通过。Windows Desktop 后续的单项显式事件桥接试验观察到匹配 turn 的 `turn_aborted` 并中断正在运行的 MCP 调用；紧接着的 recovery chat 又通过 MCP patch 和旧 stdout/receipt 的两项精确 recall，详见 [fixtures/t3/cancellation-compat-evidence.json](fixtures/t3/cancellation-compat-evidence.json)。当前证据状态为 `desktop_tui_bridge_passed`：TUI 0.159.2 的 Esc 桥接验收也已通过，停止到响应 571 ms；中断后的 patch 验证通过，旧 stdout/receipt 在纠正召回参数后精确召回成功。两种宿主的 MCP 桥接结果均不覆盖原生 Shell Hook 取消路径。

## 2. 入口与责任

| 接口 | 输入 | 输出 | 副作用与失败 |
| --- | --- | --- | --- |
| `onChange(event: ChangeEvent)` | 实际改动路径、事件 ID、变更摘要 | `ValidationReceipt` | 串行选择规则、运行命令、归档输出与完整回执；重复 event_id 返回同一回执；运行中断记 `error/interrupted`，不自动重跑。 |
| `sol_apply_patch(patch)` | Codex Begin Patch / End Patch 格式，最多 24,000 UTF-8 字节 | `ManagedCommandResult` | 配置 `CODEX_SOL_PATCH_EXECUTABLE` 为实际 Codex 原生执行文件（Windows `.exe` / Linux ELF），以 `--codex-run-as-apply-patch` 调用引擎；按工作区快照识别真实改动并验证。 |
| 原生 Bash Hook runner | 原宿主 Bash/Shell 的 1–8000 字符命令及 `NativeConfig` | `ManagedCommandResult` 写入私有结果文件 | PreToolUse 改写当前 Shell 命令为本地 runner 启动命令；runner 在宿主 Shell 的工作目录、sandbox/token 下执行 Windows PowerShell 或 Linux Bash，再对比变化并同步验证；PostToolUse 从私有结果文件读取失败结果。 |
| `capture(meta: CaptureMeta, chunks: AsyncIterable<Uint8Array>)` | 包装边界取得的字节流或序列化响应 | `RawRef` | 工具启动前建立临时归档；边收边写，校验大小和 SHA-256，fsync 后原子提交；失败不发 handle。 |
| `pack(meta: PackMeta, refs: RawRef[])` | 已提交原文引用与原工具结果状态 | `ObservationPack` | 按字节预算生成确定性摘要和摘录；不调用模型；失败语义不可改成 `ok`。 |
| `recall(request: RecallRequest)` | handle 与 lines / keyword / bytes selector | `RecallResult` 或 `RecallError` | 每次打开核验 SHA-256，从不可变原文读取；单页最多 8 KiB；不接受任意路径。 |
| workspace lock owner (`LockOwner`) | workspace owner PID 与 runner 状态 | `.codex/sol/managed-modification.owner.json` 持久化记录 | 由 `src/workspace-lock.mjs` 写入和恢复；`src/server.mjs` 将 `lease.setRunner` 接入 `ValidationEngine.onChange` 的 `onRunnerState`。字段与状态由 schema `#/$defs/LockOwner` 定义。 |

`PackMeta` 至少含 `schema_version`、`call_id`、`tool`、`tool_status`、`upstream_complete`。这些是 wrapper 内部参数，不另定义宿主协议。`CaptureMeta` 与所有可持久化对象的字段见 schema。验证 stdout、stderr 分开 capture；非流式结构化工具响应保存完整 UTF-8 JSON envelope，`source_form=response_json` 表示保存形式，不宣称保留网络原始字节。外部资源链接只作为 envelope 内容保存，不下载。

## 3. 变更与规则

- 适配器必须报告实际改动，包含删除；工具报错但有部分改动仍触发。无改动不生成验证事件，不运行命令。
- `change_digest` 对按路径排序的文件事实计算 SHA-256；每项含路径、最终内容 SHA-256 与普通 POSIX 权限，或显式缺失状态，并带 `content_mode_v1` 策略标记。公开文件 SHA-256 仍只表示原始字节。校验失败不能继续给出 `passed`。
- 只处理 `origin=agent`。验证自身产生的日志、构建产物和 `.codex/sol/` 不创建新事件。
- 规则按配置数组顺序选择：任一 `changed_paths` 命中规则 `globs` 即选该规则；同一事件的所有命中规则依序执行，各命令依序执行。命令 ID 以 `rule.id/command.id` 标识，配置内必须唯一；不去重、不推断测试。
- `watch_paths` 必须覆盖该规则验证依赖的完整项目输入树，包含未提交文件、配置、锁文件和删除状态。`.git/`、`.codex/sol/`、声明的生成物排除。glob 以工作区为根，`/` 分隔，匹配隐藏文件；不允许 `..` 或绝对路径。
- `validation_key = SHA-256(输入树规范快照 + 所选规则与命令配置的规范 JSON)`。快照按相对路径排序，含文件类型、内容 SHA-256、普通 POSIX 权限和指纹策略；Windows mode 为 null，缺失和删除以显式状态表示。不能只看 Git HEAD 或本次修改列表。目录穿越、无法读取或不稳定快照为 `error`，不得 `passed`。
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
- Windows 既有验收保留；2026-10-05 在 WSL2 Ubuntu 24.04 的 Linux 文件系统中运行完整回归，覆盖跨进程锁、退出恢复和 Bash 后代清理，见 [Linux 验收](fixtures/linux/README.md)。其他 Unix 的目录锁崩溃恢复未实测，不能套用 Windows/Linux 的 OS 自动释放行为。

## 7. Windows / Linux 原生操作接入

- `runtime.schema.json` 中的 `NativeConfig` 和 `NativeRequest` 是 runner 的内部合同，不是 Codex Hook 输入 schema。native Hook adapter 支持 Windows PowerShell 与 Linux Bash，其他平台明确报 `CONFIG_ERROR`；`workspace`、`rules`、`node`、`shell` 都必须是绝对路径。运行时把 workspace 解析为真实路径，规则文件须为有界普通 JSON 文件。Linux 的 Node/Bash 路径可经符号链接解析到普通文件，且须具备当前用户的执行权限；Windows 沿用普通文件校验。`timeout_ms`（最大 300,000 ms）和 `generated` 按配置生效，schema_version 仍为 1，无配置迁移。
- Windows 的 `load_profile=false` 使用 PowerShell `-NoProfile`。Linux 的 `true` 使用 Bash `--login -c`，`false` 使用 `--noprofile --norc -c`；非交互 Bash 仍遵循继承的 `BASH_ENV`。配置的 Linux shell 必须是 Bash，不支持把其他 shell 当作 Bash 启动。
- Codex 按 Git 工作区根发现项目 Hook。`.codex/hooks.json` 与 Hook 所属项目根必须对应 Codex 实际识别的 Git 根；嵌套验收目录要单独使用 Hooks 时，应为该目录建立独立 Git 根（`git init` 即可，无需提交），或把配置放到实际 Git 根。`NativeConfig.workspace` 应指向同一项目根，避免 Hook、runner 与受管工作区不一致。
- 项目 `.codex/config.toml` 需启用 `[features] hooks = true`；已有 MCP server 和 feature 设置应合并保留，不改全局配置。CLI/TUI 从 `/hooks` 审阅项目定义；Desktop 从“设置 → 钩子”检查 project Hook 项目、命令、matcher、timeout 和启用状态。
- `validateWorkspacePath` 是无 I/O 的公共路径校验，文件操作与 patch 预检共用。路径使用工作区相对 `/` 分隔形式；空路径、绝对或驱动器形式、NUL、反斜杠、空段及 `.` / `..` 段均拒绝。`.git/`、`.codex/sol/` 是保留路径；Windows 按大小写别名匹配并额外拒绝 ADS、DOS 设备名、尾点/空格及非法文件名字符；Linux 按大小写区分，允许其他符合上述公共约束的文件名。`workspaceFile` 继续执行真实文件系统检查，拒绝链接逃逸；纯词法校验不替代该检查。
- `sol_apply_patch` 只接受普通 Codex Begin Patch / End Patch 格式，最大 24,000 UTF-8 字节。工具用 `argv=[CODEX_SOL_PATCH_EXECUTABLE, '--codex-run-as-apply-patch', patch]` 调用引擎；该变量须是实际 Codex 原生执行文件的绝对路径，不能是 `.cmd` / `.bat` shim 或 npm JS 启动器。Linux 在执行前要求当前用户有执行权限；无权限报 `CONFIG_ERROR`，不启动 patch、不修改文件。
- PreToolUse 对原生 `apply_patch`、`Edit`、`Write` 返回 deny，并告知使用 `sol_apply_patch`。这是路由指引，不会把当前原生调用变成同一 MCP 调用，也不保证覆盖其他写入工具。
- 对 Bash/Shell，PreToolUse 把原命令写入 `.codex/sol/native/` 下的私有请求文件，并把 `updatedInput.command` 改成在原宿主 Shell 中调用本地 Node runner。Linux 启动路径使用 POSIX 单引号转义和 `exec`，原命令留在请求文件中，不拼进启动命令；Windows 沿用 PowerShell 转义。Runner 从 `NativeConfig` 读取实际 shell 路径、是否加载 profile 和超时；执行时保留宿主选择的工作目录，并要求该目录位于配置 workspace 内。Runner 在原 Shell 工具上下文中执行，宿主配置的 sandbox/token 仍是执行边界；但 PreToolUse 返回 `permissionDecision=allow` 与 `updatedInput`，这有独立审批语义，不能据此声称保留普通 Shell 的逐命令 ask 提示。当前宿主验收运行使用 `-a never` 或 `danger-full-access`，受限 sandbox 和 ask 模式未验证。这不是给模型新增的任意命令 MCP 工具。
- Bash 命令长度为 1–8000 字符。工作区锁覆盖实际执行、执行前后变化检测及有变化时的同步验证。无变化不创建事件，也不验证。变化路径按完整集合记录；响应超预算时可省略 `changed_paths` 条目，但保留 `changed_path_count`、`changed_paths_omitted`，并通过 `change_event_raw` handle 精确召回事件。stdout 和 stderr 都捕获，即使退出码非零、超时或取消；结果中的 `execution`、`validation`、`tool_status` 各自表达执行、验证与宿主工具状态。ObservationPack 最大 4 KiB，managed-command envelope 最大 8 KiB。
- PostToolUse 从 `.codex/sol/native/<call_id>.result.json` 读取提交结果；`tool_status` 非 `ok` 时用 `decision:block` 反馈完整 JSON，不依赖宿主 `tool_response`。执行已经发生后，反馈不会撤销它；中断且无提交结果时不自动重放。
- Hook 是受信任项目配置的一部分，不是绝对安全边界。项目 `.codex/` 必须可信，Hook 必须在宿主提供的入口审阅并信任当前精确定义；CLI/TUI 使用 `/hooks`，Desktop 使用“设置 → 钩子”。不要改全局 trust 设置或常态绕过 trust。未信任项目、Hook 未获信任、其他或专业写入工具都可能绕过本层。Linux 已通过真实 Bash runner 的失败反馈、去重、超时、SIGTERM 清理及后续恢复；真实 Codex app-server 另行通过插件装载，不代替 TUI 按 Esc 或 Linux 宿主取消桥接验收。

## 8. Optional MCP host cancellation bridge

- `CODEX_SOL_HOST_EXECUTABLE` is optional. When unset, the MCP SDK signal path is unchanged. When set, it must be an absolute path to the installed Codex executable (`.exe` on the tested Windows setup), not a `.cmd` / `.bat` shim. This environment variable is read by the MCP server; it is independent of project Hooks and does not modify global configuration.
- The bridge applies to `sol_apply_changes`, `sol_apply_patch`, and `sol_read_file`, plus the opt-in `sol_change_*` lifecycle tools including review/completion. Context/query tools use the MCP SDK signal directly. `sol_recall` is short and read-only and does not start a host reader. Native Bash/Shell Hook cancellation is a separate host-tool path and is not covered by this optional MCP bridge.
- For each eligible request, a separate app-server reader initializes and issues only `thread/read` with `includeTurns: false`, then exits. The adapter checks the request's `x-codex-turn-metadata`, matching thread ID, workspace cwd, absolute rollout path, session metadata, and a `task_started` row for the target turn. It then scans only the matching thread's rollout log and aborts the existing MCP handler signal only for an explicit `event_msg` / `turn_aborted` row whose `turn_id` matches. Normal MCP SDK cancellation continues to use its existing signal route. The reader does not start or resume a thread; the bridge does not infer cancellation from `turns/list` or another process's unfinished-turn status, or synthesize an MCP cancellation notification.
- Polling interval is 500 ms. The reader RPC has a 5,000 ms total timeout and bounded 1,000 ms close wait. Rollout files over 256 MiB, partial JSONL lines over 2 MiB, replaced/truncated files, malformed rows, mismatched metadata, or unavailable RPC/path evidence fail closed. Once running, a rollout verification fault aborts the existing signal with `HOST_STATE_ERROR`; runner process-tree cleanup, partial output capture, receipt behavior, and lock release follow their existing routes. A target host abort retains the existing `INTERRUPTED` route. Neither case retries the mutation or can produce a false `passed` receipt.
- Host compatibility was exercised only on Windows with Codex CLI 0.159.2 and Desktop core 0.159.2 (the separate patch executable in the fixture was 0.158.0). These app-server/rollout details are not treated as a stable public API or a guarantee for later versions. The current Desktop guarded Stop test is recorded separately from earlier TUI/unguarded Desktop native cancellation failures in [fixtures/t3/cancellation-compat-evidence.json](fixtures/t3/cancellation-compat-evidence.json); it does not complete Windows-wide acceptance.

## 9. 可选 Context：写前职责交接

- `CODEX_SOL_CONTEXT_RULES` 指向工作区内的普通配置文件；未设置或为空不注册 Context 工具。配置用 `schema_version=1`，声明 role 的 goal / allowed_operations / sources / require_targets / output_schema / blocking_field / consumers，以及可选 input。配置无效则启动失败，不静默禁用；调用期间配置变化使旧 context 失效。allowed_operations 是模型指引，不能替代实际工具权限。
- `sol_context_prepare({task:{id,goal,constraints?},role,targets?,upstream_handle?,architecture_query?})`：从当前职责配置和明确目标路径选材；返回 Context 包的 status、task、role、version、来源与原文引用、diagnostics、output_schema、consumers、能力状态及 raw。缺必需来源、目标或上游时 status=blocked；未选择架构材料和未接入的变更状态明确 unavailable。返回值 delivery=full，不删除历史、不创建受管变更。
- `sol_context_submit({context_handle,task_id,role,version,output,evidence_handles?})`：确认所用准备结果、任务与职责、当前选定来源、配置和引用，再校验产物结构。接受后归档并返回 accepted=true、raw、version、blocked、evidence_count、task_complete=false；字段错误 OUTPUT_INVALID、目标关联错误 TASK_MISMATCH、来源或版本变化 CONTEXT_STALE、消费者不符 CONSUMER_MISMATCH、前置缺失 CONTEXT_BLOCKED；NOT_FOUND / CORRUPT 等存储错误按原类别返回。结构与归档接受不是语义正确、检查通过或任务完成。
- 下游 prepare 要求完整 task 身份/目标/约束与产物一致，且 producer / consumer 双向配置匹配。consumers.fields 的键是下游字段、值是上游字段，只映射必需输出字段。blocking_field 为必需字符串数组，所有消费者必须映射它；非空时阻止下游实施。合法但包含未解决项的产物可以接受。只有显式 evidence_handles 核验为 SoL 引用，complete=false 的证据保留其不完整状态，不洗成通过；模型文本里的其他引用没有机器真实性保证。
- 包完整序列化最多 4096 UTF-8 字节；可展开内容通过 omitted 与对应 raw handle 标明，不截断任务约束、版本、诊断和上游阻塞项。Schema 或来源清单被省略时必须召回准备结果 raw 后再使用；源码开头摘录的 omitted_bytes 表示未读原文量。必需信息超预算则 CONTEXT_BUDGET，不伪造摘要。配置 128 KiB、源码单文件 1 MiB、提交 64 KiB、Context 归档记录 256 KiB；超限 SOURCE_LIMIT / INPUT_LIMIT 或 CONFIG_ERROR。原源码通过原 sol_recall 按页读取。
- 原文、准备结果、模型产物和下游投影都沿用不可变 SoL 归档；持久 handle 可以跨本服务重启使用，先核验当前来源，再恢复材料。prepare / submit 共用受管工作区锁并响应 MCP SDK signal；本轮未接宿主取消桥接。失败不发布成功回执，不重放操作；成功归档可因后续步骤失败保留为未被采用的历史材料。
- 此版本只核验写前交接和选定来源，不能对修改后的实现产物套用“来源完全不变”规则；变更协调、检查证据关联及完成状态在 M-002 接入。会话交付去重、差量、可选 Skill、独立线程尚未完成。CLI 只读交接已有实测；Hook 状态见 §10。详细职责边界见 [architecture.md](architecture.md#44-hookmcpskill-的职责与注入位置)。

## 10. Context 会话绑定与恢复

- `ContextSessions` 为宿主适配指针，不是任务状态机。成功 prepare 后从 `_meta['x-codex-turn-metadata']` 读取 UUID thread_id / turn_id，绑定 thread_id 到已核验的 prepare RawRef。无元数据则不绑定；元数据存在但无效返回 SESSION_BINDING_INVALID。不增加工具参数，不改变包预算。
- `.codex/sol/context-sessions/<SHA256(小写 session_id)>.json` 保存 schema_version=1、workspace_id、session_id、context。禁止链接和非普通对象；指针最大 2048 字节，核对工作区、RawRef 字段和归档类型。共享锁内复用 writeAtomicJSON 原子发布；native runner 也使用该发布函数。历史归档不删除。
- `src/context-hook.mjs` 处理配置已启用的 SessionStart startup / resume / clear / compact 和 UserPromptSubmit，要求 event.cwd 为配置工作区。参数 --workspace / --rules 或对应环境变量；stdin UTF-8 JSON 最大 128 KiB，成功输出一行 Hook JSON。其他事件/未启用输出 `{}`；非法输入/参数退出 1，配置或恢复失败输出 context_unavailable 指引，不伪造成功状态。
- 同会话恢复按归档的 task / role / targets / upstream_handle 调用核心 prepare，核验当前来源与上游，再返回 additionalContext：任务、职责、目标、当前版本、status、diagnostics、blockers、能力状态及引用。完整模型产物和源码不注入开发者上下文；引号中的任务与阻塞字段是任务数据。无绑定仅提供入口提示。完整恢复文本上限 4096 字节，超限 CONTEXT_BUDGET。
- 恢复发布绑定前比较原 handle，若期间有新任务/职责绑定则 SESSION_CHANGED，不覆盖新任务。坏指针、归档缺失或上游过期不得降级为“无任务”；恢复不重放修改、不提交产物、不标完成。SessionStart 不依赖 MCP 就绪，Hook 配置超时由宿主执行。
- `ContextSessions.remind(session_id)` 在共享锁内读取同一绑定与 prepare 归档，通过 ContextEngine.fresh 核对当前配置、选定来源和递归上游。无绑定或当前 ready 返回 null；CONTEXT_STALE 返回过期提示；仍有效但 blocked 返回阻塞提示。其他引用/配置错误保留原错误，不假装没有任务。只读取材料，不生成归档、改写绑定或重建任务；锁的临时运行元数据仍沿用原机制。
- UserPromptSubmit 只在上述提醒/错误时输出该事件的 hookSpecificOutput.additionalContext；正常情况 `{}`，不返回 decision=block。context_reminder 最多 4096 UTF-8 字节，字段为 prior_task_id、role、prepared_version、freshness、reason、context 和 next；不重复目标、约束、源码、Schema 或模型产物，实际阻塞详情经 context 引用读取。prior_task_id 是此前明确准备的任务数据，不把新请求强行绑定给旧任务；模型自行判断继续或改变目标。用户 prompt 正文不用于关键词分类、持久化或日志输出。
- 读取工具注解：sol_recall 为只读、幂等、非破坏性、非开放外部访问；sol_read_file 非破坏性且非开放外部访问，但因归档副作用不标只读/幂等。注解不改变路径和引用校验，也不取代宿主权限。
- 当前已验证本地适配器、CLI 元数据绑定及 CLI 五次真实 Hook 注入和精确定义哈希信任；交互式信任界面、Desktop 和实际 compact 未验收，不据此完成 M-003。

## 11. 可选架构查询与 Context 选材

- Context 顶层 `architecture:{path}` 指向工作区内的声明；职责 `architecture:true` 请求其材料，缺全局声明为 CONFIG_ERROR。服务初始化时仅启用的实例注册 `sol_architecture_query({paths?:string[],capability?:string})`，默认各为 `[]` / `""`；路径最多 16 项，关键词最多 256 字符，空关键词列出登记能力。路径选择归属、关键词字面匹配选择能力；反向静态导入返回所选模块的直接使用方。
- 声明 schema_version=1、modules 和 policy 由固定 Normify engine 校验与编译。上限：声明 256 KiB、100 模块、256 来源文件、单来源 1 MiB、来源合计 8 MiB；模块 source/apis/deps 分别 32/32/64，policy rules 64，JSON 深度 20。越界、链接及非普通来源拒绝读取；临时编译目录始终清理，不修改源码或声明。
- 返回 status、engine 固定版本/commit/编译状态、owners、candidates、impact、declared_impact、diagnostics、uncovered、coverage、version 与 raw。每条真实事实带源码位置和 SHA；active rpc 的导出必须存在。声明依赖与静态导入分别核验 policy；结构、指纹、归属冲突和缺失导出保持阻塞。revision 未校验 Git，仅为声明元数据。
- 沿用工作区锁、MCP signal、ObservationStore 和 recall。工具归档材料，因此不是只读/幂等操作；它不编辑来源或标记完成。包最大 4096 UTF-8 字节，省略清单附数量和 raw 引用，完整查询记录最大 256 KiB；超限明确失败。动态调用、外部包、非 JS 与未登记目标显示未覆盖，不声称全量调用图。
- prepare 的 architecture_query 仅用于当前职责的候选筛选；归属始终来自 targets。材料和全部索引来源版本进入归档，submit / prompt 新鲜度核对及恢复沿用同一查询；非目标登记来源变化也返回 CONTEXT_STALE。旧版无架构记录维持原指纹与恢复规则。查询 ready、上游编译通过或产物 accepted 都不代表语义正确、标签实现或任务完成。


## 本文档不做的事（Out-of-Scope）

2026-10-03 阶段接续：博客只作为 Hook 测试夹具；现有 SessionStart / UserPromptSubmit 已完成此次收尾，主线进入 MCP。`sol_recall` 仍保持原参数、8 KiB 预算和拒绝越界行为；INVALID_RANGE 的 message 新增实际有效范围，行号 1-based inclusive，字节 0-based end exclusive，空对象提示 bytes 0..0。Context/architecture 归档保持单行原文；工具说明要求从 lines 1..1 开始并用同一 selector 跟随 cursor。初始化工具集合和跨工具说明采用同一份配置，调用期间仍实时核对配置和来源，不因启动快照而绕过新鲜度校验。

不把 `runtime.schema.json` 当作宿主 Hook schema，也不声称原生 patch 被透明替换成 MCP 调用。CLI 夹具中的单次 trust bypass 不代替项目 Hook 审阅。TUI 信任审阅及重启后的路由、patch、recall、失败 Shell 反馈已有实测；两次宿主 Esc 取消仍以 `timeout` 收尾，不得写作取消通过，新版 TUI 显式事件桥接已另行通过 Esc 验收。旧 Desktop 无桥接 GUI Stop 同样未终止 validator；Desktop 与 TUI 的显式事件桥接、后续修改与精确召回已通过，但不能覆盖历史失败、原生 Shell 或 Windows 所有运行模式。受限 sandbox 与 ask 审批也未测试。Normify 查询按 §11，MCP 变更与完成按 §12–13；在本段对应的早期验收阶段，宿主范围门禁、Stop 核对和变更状态职责注入尚待验证，后续接入结果见 §14–15 与 [Host 验收](fixtures/host/README.md)。

## 12. 架构模式的变更登记与写入绑定（M-002 首片）

- 仅服务启动配置了 architecture.path 的实例注册 sol_change_open/status/resume/abandon 及 §13 的 review/complete。默认四工具、纯 Context 六工具保持原输入；架构模式十三工具，两个写入 Schema 的 change:{id,version} 必填。查询归档包含 workspace_id，变更引用同时验证工作区、tool/kind、完整性、SHA 和版本。
- open 接收 task:{id,goal}、requirement_ref、scope:[{path,module_uid}]、acceptance、expected_architecture_version、reuse:{decision,reason,query_handle,capability?}；带 change 为显式调整，否则登记新变更。当前查询必须与当前架构版本一致；reuse/extend 必须选查询中的 verified static_export 能力。existing source 的模块 UID 必须一致；不在声明中的新文件、文档或配置需明确指派已有 active/planned 模块。首片不支持跨模块分段文件写入。
- scope 是最多 50 个普通相对文件，大小写别名去重，生成排除目录/匹配 glob 不得作为目标。一个工作区同时一条可写变更；调整保留任务 ID，并包含所有累计变化。输入快照沿用 snapshotInputs 与 generated 排除；元数据最大 128 KiB，完整记录最大 256 KiB；超限报错，不静默删输入。模型决定需求/复用语义，程序校验身份、引用、路径和版本。
- bind、目标检查、pending 发布、实际操作、SoL 同步验证和状态发布使用同一原工作区租约；patch 用原安装 CLI，不重复加锁或产生第二个 ChangeEvent。已有源与移动目标均检查范围。无变化不生成验证事件、不增加证据 generation。失败的已写内容仍纳入累计路径；存储/快照失败保留 pending 并报告错误，不能自动重试写入。
- status 检查全工作区非生成输入、Context 配置及实际验证配置/排除设置；变化使旧 latest_validation 失效，增加 generation，范围外累计路径成为 blocker。状态刷新可能更新版本，返回的绑定为唯一当前版本。调整用有效新查询解释范围及配置变化；源码改动造成声明指纹漂移时，须先在已登记范围内维护声明再扩围。
- 不可变 change_record 归档先成功，再原子写 .codex/sol/architecture/active-change.json。指针包含工作区、change ID/version 与完整 RawRef；坏指针/坏归档失败，不降级为无任务。历史 previous_handle 留存。工作区锁的进程恢复沿用既有语义，存活 validator 或不明 starting 状态不得被抢锁。
- cancel 或重启发现 pending 为 interrupted；status 记录真实影响并清 pending，不重放。resume({change}) 显式回到 dirty，保留 blocker；abandon({change,reason}) 保存原因及历史，不回滚，允许下一条登记。状态包最多 4096 UTF-8 字节，详细原文可 recall，超预算的 blocker 路径明确列省略并保留代码与引用。
- 当前状态为 open/dirty/checking/completed/interrupted/abandoned。latest_validation 仍是原单次操作回执，不证明累计检查覆盖或语义复核；只有 §13 完成证据有效且已发布才 task_complete=true。IF-004 交付时，变更状态职责 Context 注入和新的 PreToolUse/Stop 门禁尚未接入；现有 Context accepted 仍是写前产物交接。后续状态投影按 §14、PreToolUse/Stop 门禁按 §15 接入，历史范围与当前实现分别记录。

## 13. 架构维护、复核与完成收尾（IF-004）

Linux 的逐规则运行条件核验包括实际检查程序的当前执行权限。即使程序字节不变，撤销执行权限也会使对应缓存证据失效；只影响该规则，保留历史回执，不自动重跑。恢复执行权限后，原字节及其他输入、环境条件仍相同时可重新核验为有效。

- 新登记在原记录增加可选 baseline_architecture_ref，保存初始架构/source/declaration facts 及真实 UTF-8 来源引用；显式调整保留此初始材料。旧记录先核验原始正文 SHA 再 parse，可选字段不通过默认值改写身份。缺初始事实返回 BEFORE_IMPACT_UNAVAILABLE，不从当前图伪造历史，也不将未经批准的初始快照称为认可基线。
- sol_change_review 的严格输入由 changeReviewSchema 定义：prepare 为 `{change,phase:"prepare"}`；submit 为 `{change,phase:"submit",review_context_handle,review}`。仅 open/dirty 接受。prepare 固定需求/验收集合、累计路径、scope、源码、声明/policy、Context 配置和规则计划；返回 4096-byte packet 与完整归档。单来源 1 MiB UTF-8，归档 JSON 256 KiB；越限或来源变化明确失败。
- maintenance 基于前后声明和 JavaScript 事实，返回 affected_uids、impact_paths、suggestions、uncovered、blockers。建议带两侧版本及位置；声明与静态关系只比较同类关系。影响使用两侧反向传递静态导入，删除保留旧路径、移动保留两侧、未登记累计正式 JS 源码阻塞；声明/policy 变化保守纳入所有模块。动态、间接、外部及缺侧材料保持未覆盖，不声称安全选测或完整调用图。
- LLM 通过原 sol_apply_changes/patch 绑定写入维护声明，随后重新 prepare。review 包含 `method:self_review|separate_review`、modules、acceptance、uncovered、可选 checks_not_applicable 及 unresolved。modules 每项为 `{uid,disposition:preserved|changed|removed,contract_refs,evidence_handles,rationale,unresolved}`；acceptance 为 `{index,evidence_handles,check_ids,rationale,unresolved}`；uncovered 为 `{index,evidence_handles,rationale,unresolved}`；免检查项为 `{path,evidence_handles,rationale}`。完整对象最大 64 KiB，受影响 UID、验收索引、未覆盖索引及免检查路径须各覆盖一次；检查 ID 只能来自当前计划。
- 引用只能来自本次捕获的前/后来源且完整可核验，每一项需当前来源；模块项需自身当前源码，无 source/移除模块需当前声明，移除模块有旧 source 时也需旧侧依据；按路径产生的未覆盖项需该路径来源。模型承担契约/行为判断，程序核对结构、版本和引用关联；复核方式只保存 reported 与 identity_verified=false。accepted 不证明语义或独立身份；嵌套未解决项统一阻塞完成。
- 必需规则由累计实际变化和前后影响路径使用项目 globs 确定，保留 trigger_paths/check_ids。watch_paths 只决定输入依赖，不充当行为覆盖；未匹配源码/配置保持 REQUIRED_CHECK_MISSING。声明自身由已有 Normify/source/policy 校验覆盖；未登记 md/txt/rst/adoc 资料可由逐路径检查不适用依据解释。generated 排除不能隐藏累计历史。
- ValidationEngine.plan 是纯计划；revalidate({rule_ids,paths,operation_id?}) 使用原队列、runner、快照、取消和归档，operation_id 相同去重且参数不同拒绝。再验证不生成 ChangeEvent、不改源码。原 ValidationReceipt/receiptSummary 字段与真实修改事件去重保持兼容，另归档 validation_provenance，并在私有回执记录关联原 receipt_ref/provenance_ref。
- Rule.reuse 可选 never/watched_inputs，默认 never。watched_inputs 是项目对重要输入覆盖及外部条件的明确声明，只有仍完整、通过且逐规则配置、命令、排除、seed/watch 输入、检查 ID 和运行条件相同才复用。运行条件包含 Node/OS/环境摘要、绝对执行文件身份和内容；环境只保存摘要，不输出值。未知、旧、损坏或 incomplete 证据不复用。freshness 与复用许可分开，reuse=never 的本次通过证据仍可保持有效；PATH/相对执行文件无法核验，不能发布 completed。
- sol_change_complete 输入为 `{change,review_handle}`，仅 open/dirty 接受当前 review_ref；旧版、未解决或阻塞先返回未完成。其后在同一工作区租约内持久化 checking/pending，按同变更历史核验允许复用的规则，只补跑缺失/过期规则并保存原回执。先核验来源、实际检查输出、复核与当前 basis，再归档 change_completion；最终 change_record 归档后、已同步临时指针 rename 前再次核验规则、执行条件和工作区输入，成功才发布 completed。状态及额外完成诊断合计最多 4096 字节，省略 blocker 路径保留代码、数量和 review_context_handle。
- status 对完成引用、当前需求/范围/配置、架构、逐规则 freshness 和全部归档完整性重新核验，不启动 runner。完成后的源码、执行文件或证据变化使当前 dirty，清当前复核/完成引用但保留历史。规则文件变化返回 CHANGE_RULES_CHANGED，需重启服务、显式调整及重新复核；无法核验执行路径会说明使用实际绝对路径。取消或崩溃保留 interrupted，发布失败保留未完成/可恢复 pending，显式 resume，不重放写入或旧操作。
- 交付证据见 [闭环验收](fixtures/closure/README.md)。本切片没有新增 Hook、Skill、依赖或第二套任务存储；当前只是捕获版本满足约定复核/检查的证明，未验证稳定自主架构维护、Desktop/TUI 新模型回合、成本节省或完整 M-003。

## 14. 变更状态进入 Context

2026-10-04 已实现。`sol_context_prepare` 可显式绑定当前变更；同一只读投影也供 fresh/submit 与会话恢复、提醒核验。实现与程序验收边界见 [变更状态 Context 夹具](fixtures/context-state/README.md)。注入矩阵见 [architecture.md §4.13](architecture.md#413-变更状态的职责注入合同已实现)。

- **唯一事实来源**：变更状态、scope、复核/完成及有效性由 ChangeCoordinator 核验；Context 只保存不可变投影与引用，ContextSessions 仍只保存会话到 Context 的指针。不得增加另一份可变任务状态或另造检查结果。
- **显式输入**：`sol_context_prepare` 接受可选 `change:{id,version}`，复用现有 `changeBindingSchema`。绑定要求同工作区、当前变更、当前持久版本，并匹配 `task.id` 与 `goal`；`targets` 只决定读取选材，不扩张写入 scope。没有绑定不读取其他聊天的工作区任务；已接入但未绑定时 `capabilities.change_state='not_bound'`，缺少核验能力时为 `'unavailable'`，均不能推断“没有任务”或“已经完成”。
- **兼容**：默认四工具、纯 Context 六工具和不消费变更的旧调用维持既有写前行为；不强制创建变更或新增角色。不带 change 的规划产物不会在后续 open 时被自动绑定。旧归档按原始字段/原指纹核验，不通过默认值增加投影或改变身份；新字段仅在新准备结果中出现。
- **投影字段**：新绑定结果的 `change_state` 包含 `availability:'bound'`、`change:{id,version}`、`task_id`、`state`、`scope_count`、`selected_scope:[{path,in_scope,module_uid?}]`、`blocking:{count,codes}`、`latest_validation`、`review:{ref,validity}`、`completion:{ref,validity}`、`raw`、`needs_status_refresh`、`task_complete`、`next` 和 `version`。`validity` 为 `absent|current|stale`；有历史核验时 `latest_validation.interpretation='historical_only'`。完整 scope、原始需求、证据正文和检查内容沿既有 handle 召回；新字段不补写旧归档，也不改变旧 Context fingerprint。任务与阻塞文本是数据，不覆盖系统或工具指令。
- **完成与检查表述**：仅完整且当前有效的 completed 证据允许 task_complete=true。latest_validation 描述历史真实结果，不能直接代表当前累计检查有效；null 不等于失败或必须重跑。当前复核/完成的完整性及新鲜度必须重核，不能信任旧状态字面值或模型自述。
- **只读公共边界**：共享 `ChangeCoordinator.inspectLocked`，调用方已持工作区租约；接口不取锁、不归档、不改动变更指针、不跑检查。Context prepare/fresh/submit 与会话恢复/提醒在各自锁内复用此核验；禁止嵌套调用会取锁并持久刷新的 `status()`。普通 `sol_change_status` 仍负责持锁和发布刷新后的版本。恢复维持 read → prepare → `expectedHandle` 保护下的 bind，不在外面再套锁调用这些取锁方法。
- **发现漂移/遗留操作**：只读投影可报告 dirty/interrupted、阻塞和 needs_status_refresh，但 binding 仍是当前真实持久记录的版本；不能生成未发布版本或允许拿它继续写。下一步先显式 sol_change_status 取得已刷新绑定，再按需要调整、resume 或准备新材料。无法取得锁或核验时给出 busy/unavailable/原错误，不能回退为旧 completed。
- **绑定新鲜度**：新 Context 的版本包含绑定身份和状态投影版本；归档前重新核验。fresh/submit 同时核对现有来源/上游及绑定投影，源码未变的 scope、验收、review、pending/interrupted、完成引用或证据有效性变化也会使绑定 Context 过期。投影版本依据真实事实及有效性，不依据提醒时间或任意 generation 单独推断检查失败。漂移时持久绑定保持原样；须先 `sol_change_status` 刷新后才能以新版本继续写。
- **规划交接**：未绑定规划维持现有来源与上游核验；已绑定规划在随后调整 scope/需求后，须用新绑定重新 prepare/submit 规划再准备实施。不得为了复用旧方案忽略生产者 Context 的过期判断，也不得只更新绑定版本就把旧产物当成当前依据。
- **恢复与提醒**：只恢复本会话显式绑定的同一变更 ID、同一 `task.id` 与 `goal`；管理版本可更新到当前持久版本。另一 ID、目标不同或坏引用报告缺口，不转绑。SessionStart 沿用 read → prepare → `expectedHandle` bind；若旧 producer 已 stale，返回 `context_restore status='stale'`、状态码、旧材料 ref 与独立当前 `change_state`，不 bind，也不把旧材料说成 ready。当前有效的 completed 仍保留 `task_complete=true`，不要求重做 implementation。UserPromptSubmit 仅在状态变化、阻塞或错误时提醒，正常时输出 `{}`；只读核验不新建归档、不改会话/变更指针、不启动 runner。用户 prompt 不作关键词分类或自动绑定。
- **Hook 配置来源**：绑定状态核验需要与 MCP 一致的验证规则、generated 排除和职责配置，复用已有项目配置机制及共享核心组装。独立 command Hook 不继承 MCP 的进程环境；必须显式取得验证规则与排除配置，并以 `requireRecordedConfig=true` 核对当前规则及 generated 的合成 SHA 与持久变更的 `rules_sha`。缺少验证路径、配置不匹配或无法确认此前记录的规则配置时报告 `CHANGE_UNAVAILABLE`；不能把缺失排除项当默认值，也不能用新规则文件推断可靠状态。坏配置按原错误 fail closed。MCP 自身仍可按既有流程报告规则配置变化并要求刷新/重启。未绑定的旧 Context 恢复不新增验证配置依赖。
- **职责产物**：写前 plan/implement 继续采用配置 output_schema（样例 plan/constraints/unresolved 与 steps/unresolved）；受管写入返回真实结果和新绑定。写后复核直接消费现有 sol_change_review prepare，并按其 Schema submit；Context 只引导并引用该材料。完成只调用 sol_change_complete，由程序给出真实判定，不要求模型提交 completed=true 或另建收尾 Context 产物。
- **预算与取消**：工具结果和恢复/提醒文本各沿用 4096 UTF-8 字节上限；完整 scope、源码、契约、维护建议和检查内容按原引用 recall，不重复全量注入。身份、当前状态/有效性、阻塞和下一步不可因裁剪失真，必需内容超预算明确失败。signal 贯穿核验、归档与锁等待，INTERRUPTED/HOST_STATE_ERROR 不能被宽泛 catch 洗成普通 stale 或有效完成。

最小行为已由本片程序回归覆盖，场景及边界见 [Context 状态验收](fixtures/context-state/README.md)；以下条款仍是接口验收基线：

1. 相同源码、scope/验收调整或 review 提交后，旧绑定 Context 过期；不带绑定的纯 Context 保持原规则。
2. 遗留 checking/pending、interrupted 以及已发布 completed 的恢复，显示重新核验后的状态和正确下一步，不重放、不自动完成。
3. 源码不变但输出归档损坏、绝对执行文件改变或规则变化，恢复/提醒不能认可旧完成；缺配置/坏引用不伪装无任务。
4. 无绑定、不同 task/goal、另一变更及会话绑定并发更新，不继承或覆盖其他任务；恢复保持 expectedHandle 保护。
5. 当前有效且无阻塞的 prompt 不注入重复包；源码未变的状态变化会提醒。只读核验、提醒不启动 runner、不写变更指针；恢复仅有既有 Context/会话发布副作用。
6. 所有新材料/提醒满足既有预算，详细材料可召回；锁等待取消释放资源，无嵌套取锁；四/六/十三工具和原写前 Schema 兼容。

实现分工位于 `src/architecture/change.mjs`（共用核验和投影）、`context.mjs`（绑定与版本）、`session.mjs` / `context-hook.mjs`（恢复与提醒）和 `server.mjs`（共享核心组装及工具说明）；回归进入现有 Context、Hook 和闭环测试。本片不增加数据库、后台执行器、新 Hook 事件、Skill、新工具或依赖。

## 15. 宿主写门禁与本地插件接入

本节记录 2026-10-04 在既有 Context 状态切片之后接入的宿主门禁与本地插件装配。程序和实际宿主证据见 [Host 与插件验收](fixtures/host/README.md)；它不把本项目声明为稳定自主代理或 SoL-Pi 整体完成。

### PreToolUse 写入核验

- 门禁只在项目显式启用 architecture Context 时运行。PreToolUse 的 MCP 受管写调用必须匹配当前宿主会话已绑定的 Context、同一 task identity 与当前持久 `change:{id,version}`。Hook 预检和 MCP 实际写入各自在工作区锁内使用 ChangeCoordinator；执行时重新核验，避免把调用前预检当成长期授权。变更 ID/版本漂移、目标越界或配置不可核验时 fail closed。
- `sol_apply_patch` 会核验补丁中的每个实际写入路径，包括 move 的源路径与目标路径；`sol_apply_changes` 核验显式列出的每个目标。Hook 的只读 preflight 与 MCP 写入时的 guard 共用变更协调器边界，避免仅靠调用前检查授权。
- 已启用架构模式时，原生 `apply_patch`、`Edit`、`Write` 被拒并指引到 MCP 受管写入；这只是拒绝被支持事件匹配到的原生入口，不会透明替换调用。未匹配的写工具、只读工具和 Shell 不由这条门禁覆盖。
- PreToolUse 只读核验不创建归档、不更改会话或活动变更指针、不运行 runner。通过只表示门禁接受该受管请求，后续结果仍以 MCP 执行与验证回执为准。

### Stop 收尾行为

- `stop_hook_active:true` 时立即返回 `{}`，不再提出另一轮动作。仅当宿主明确提供 `false`，且当前状态有一个可执行的收尾步骤时，返回一次 actionable `decision=block` 与具体下一步。
- blocked、等待外部条件、interrupted、abandoned 或无法取得有效宿主 flag 时，返回 unfinished 提示并允许本轮结束，不重放写入。当前有效且由累计必需检查、复核和完成证据共同核验的 completed 返回 `{}`；状态名称、Context accepted、索引 ready 或单次检查 passed 本身都不够。
- 此 Hook 不替模型继续执行，不自动 resume，也不把“允许结束”改写为任务完成。未完成任务仍须通过状态工具查看和显式处置。

### 项目 opt-in、入口身份与打包

- 插件仅读取项目 `.codex/sol-project.json`：有 Git 时归最近真实 Git 根；没有 Git 时只读取精确 cwd，不向父目录猜测。配置为最多 32 KiB 的严格 UTF-8 JSON；`validation_rules` 必需，规则文件最多 256 KiB，`context_rules` 可选；`generated_paths` 最多 128 项且唯一。项目源路径要求 workspace-relative regular files，拒绝 symlink、绝对路径、遍历及保留元数据目录。`patch_executable` / `host_executable` 如配置必须是实际绝对文件。
- `plugin_launcher` 是可选的配置字符串（单行、最多 4096 个字符），但 legacy MCP bootstrap 必须显式提供它，并要求绝对路径指向实际 regular `plugin-launcher.mjs`。Hook 和 MCP 都核对它与当前被加载入口的 realpath 完全一致；不同缓存目录或版本不会静默混用。
- 对 Codex 0.160，root portable manifest 的 Hooks 不被该宿主读取，legacy MCP args 也不展开 `PLUGIN_ROOT`。默认本地包因此省略 root portable MCP manifest，把 `src/plugin-bootstrap.cjs` 静态源码嵌入 legacy MCP args；host 保留的项目 cwd 再读取显式 `plugin_launcher`。`--format portable` 保留，但此项目接入路径尚未在真实宿主验证。
- package 输出必须是全新目录，拒绝覆盖已有输出、路径逃逸和 symlink；仅从白名单复制运行源码、vendor、既有依赖、Schema、manifest、样例和指南，不带入 `.codex/sol`、环境文件、Git 历史或聊天数据。该本地 package 验收不等于公开发布或自动安装。

### 插件运行环境与边界

- Hook 与 MCP 入口重新启动时使用相同的最小 OS 环境白名单，过滤任意秘密和传输变量；完整实际子进程环境摘要仍参与检查证据的新鲜度核验，环境值不输出。已有 `execution_path` 可选配置（单行、最多 16384 个字符）用于明确 runtime/check 实际 `PATH`，避免宿主临时 PATH 随重启改变运行条件。省略时沿用真实继承的 PATH，并承担其变化导致证据失效的后果；额外 env-dependent checks 当前不支持。
- fresh 0.160 host run 已实测原生 `apply_patch` deny、MCP 越界拒绝及合法写入/验证、Stop false/true flag、Context 生命周期恢复/提醒/compact 和隔离 profile 的插件读取/安装/重启。较早一轮中模型选择 MCP patch而未触发原生拒绝、三次无效 review 与后续 PATH/范围失败仍作为历史保留。fresh run 中模型只 prepare review 并报告 unfinished；独立 reviewer 提交合法 refs 并 complete，之后实际 thread/resume 恢复当前有效完成证据。该分工不称模型自主语义闭环。
- Hook 仅覆盖实际注册且被宿主信任的事件与匹配工具；不能阻止未匹配工具或声明为全局防绕过。TUI 0.158 初始 `/hooks` 审阅、Context prepare、Stop `{}` 和源码 SHA 不变通过；同 session 的两次 0.158 resume 因 account/read workspace discovery timeout（`code=-32603`）失败并保留。随后已安装的 bundled CLI 0.160 在同 session 真实 PTY resume 通过，SessionStart 恢复 ready 且 handle/pointer 匹配，UserPromptSubmit 和 Stop 返回 `{}`，源码 SHA 不变，四条 Hook 精确 hash 正常匹配且未 bypass。Desktop GUI 操作、稳定自主连续任务或固定 A/B token/费用收益未验证。准确宿主版本和逐项记录以 [Host 证据](fixtures/host/host-evidence.json)、[package 证据](fixtures/host/package-evidence.json)、[检查证据](fixtures/host/check-evidence.json) 与 [索引证据](fixtures/host/index-evidence.json) 为准。

## 16. 架构演进的内部合同（2026-10-06）

本节补充当前内部行为，沿用四/六/十三工具、公开请求与 schema_version=1。源码职责、回归和本轮边界见 [架构演进验收](fixtures/architecture-evolution/README.md)。

`sol_apply_changes` 委托 `managed-write.mjs`：路径预检、文件效果、唯一 ChangeEvent 与同步验证共用工作区租约。现有文件同内容时不替换 inode；实际替换保留普通 POSIX 权限，新文件使用 0600。带特殊 POSIX 位的现有文件在替换前报 METADATA_UNSUPPORTED。未承诺 ACL、owner 或扩展属性的完整保留。私有 JSON 指针仍采用自己的私有权限策略。部分写入不回滚或重放；后置事实读取失败时明确 changed_paths_known=false，已知发布路径和错误保留。

`workspace.mjs` 是文件事实 owner；`workspace-snapshot.mjs` 是 glob、generated 排除、输入快照与 change digest owner。FileFacts 含 file/missing、内容 SHA-256 和普通 mode；输入指纹标记为 content_mode_v1。窄 watch 根据固定前缀保守剪枝，相关链接和不稳定事实仍拒绝；协调器的完整工作区核对继续使用完整范围。权限单独变化使输入证据失效。旧 content-only 快照先按原 bytes/body hash 严格验证，再作历史解释，未知 mode 不能获得新缓存、复核或完成资格。显式 status 在同一租约内升级活动记录并串接旧 handle，旧归档字节不改写，格式升级不伪报成文件修改。

进程层分别保存 launch_status=not_started/started/unknown、capture_error 和 cleanup_error；退出码为 null 不能证明未执行。公开 CheckResult 通过 toCheckResult 保持原严格六字段，内部事实留在受管执行结果。启动后归档失败保留 may-have-executed、已经提交的 stdout/stderr 引用和实际文件效果；取消原因与归档错误可同时保留。idle 或租约清理失败不覆盖已知 outcome、回执与事件。runner 的非 idle 状态只有持久化成功后才记入本进程状态；已确认 idle 的失败释放路径允许后续租约恢复。

ObservationStore.withVerifiedRead 在同次有界扫描内核验完整 raw SHA、真实行索引及 meta/文件身份，再发布候选结果。collector 只借用扫描缓冲，需保留的字节必须复制；finish 在证明成功后执行，fd 在所有路径关闭。pack/recall 与有界 JSON 记录消费方均复用此入口，生产读取不再在验证后另读 raw。bytes/lines 每页仍完整扫描；keyword 最多两次且绑定同一 meta。流式收集降低全长 Buffer 分配，保留每页完整核验的 O(P*N) 读取成本，不以 mtime 或局部哈希替代证明。readVerified 的缓冲兼容入口仍保留，正式记录消费须显式给出字节上限；openVerified 仅为弃用兼容方法，不能作为新的验证后 raw 读取路径。

ArchiveRecords 只负责有界不可变记录和引用核验，无任务状态；Context 的配置解析仍只有一个 owner。runtime.mjs 统一 MCP/Hook 装配，未绑定 Hook 不启用额外验证器。ChangeCoordinator 独占活动任务发布：写入 pending、执行和全部下游证据共用 operation/call ID；先归档 outcome，再原子发布按 ID 的证据指针，最后发布 settled。证据指针不能发布任务完成。status 可恢复已核实 outcome，缺证据保持 interrupted/unknown，resume 不自动重放；不扫描孤儿档案猜测结果。review_policy_id 进入 prepare、submit、complete 与只读 freshness，仅准则变化也使旧复核失效。

launcher 的 check-config 复用运行入口的配置、规则唯一性/ID 上限、职责 schema 与路径校验，不创建 store、执行检查、握手宿主或改指针。valid 只表示 coverage 所列项目通过；架构声明是 path_only，host_compatibility 是 not_checked。tool_count 表示配置的注册模式，不能表示查询 ready 或任务完成。错误仅报告有限 code/stage/cause，保留 HOST_STATE_ERROR，避免私密路径、环境值、完整 stderr 与堆栈进入诊断。CI portable 与真实 native 分离，后者要求明确配置已有原生 Codex；workflow 声明不等同实际远端运行证据。
