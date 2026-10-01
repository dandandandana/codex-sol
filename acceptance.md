# V0.1 T1 机械验收

本页验收内部合同、Windows 原生接入和已取得的宿主证据。CLI 0.158.0 与 Codex Desktop 的既有正常冒烟覆盖旧三工具；Windows CLI 异常记录见 [fixtures/t3/cli-native-evidence.json](fixtures/t3/cli-native-evidence.json)。这四次 CLI 调用都带单次 `--dangerously-bypass-hook-trust` 标志，所以只证明这些调用中的行为，不证明常规项目 Hook 信任流程。独立 TUI 无 bypass 完成三个 Hook 的审阅；重启后原生 patch 路由、MCP patch 成功、旧输出 recall 与失败 Shell block 四步均实测通过。历史 TUI Esc 测试中两次 `sol_apply_patch` 校验仍运行并最终 `timeout`；第二次 wire 记录直到完整 response 前都未见 `notifications/cancelled`。旧 Desktop 无桥接 GUI Stop 测试也未终止后台 runner，约 90 秒后 `timeout`。这些是对应版本与配置下的原生宿主取消失败，仍作为历史证据保留。

后续在 Windows Desktop `OpenAI.Codex 26.928.2636.0` / host core 0.159.2 上，独立配置 `CODEX_SOL_HOST_EXECUTABLE` 的显式事件桥接通过一次 MCP patch Stop 场景：收到目标 `turn_aborted` 后约 0.7 秒返回，回执为 `error/interrupted`，runner 已退出且 owner 已清理。同一版本随后在 recovery chat `01a0f569-b285-7b71-b4eb-52dbd55ae6e4` / turn `01a0f569-b5e0-7ed2-a993-f0b1ac5baa03` 完成三项 MCP recovery：追加 patch 并验证 passed；精确召回旧 stdout 的 45 bytes；按 keyword 精确召回 936-byte `error/interrupted` receipt。旧 stdout 的 `complete=false`；receipt archive 本身 `complete=true`，其中 `checks.output.complete=false`，不应混为一谈。正式证据状态为 `desktop_tui_bridge_passed`。TUI 0.159.2 后续 Esc 桥接验收通过：04:01:59.451Z 校验启动，04:01:59.484Z 发送 Esc，04:01:59.516Z 记录目标 `turn_aborted`，04:02:00.054Z 返回；停止到响应 571 ms，回执 `error/interrupted`，validator 和 owner 已清理。中断后的 patch 通过；首次两项 recall 因参数名错误被拒，纠正为合同的 `kind` / `literal` 后，45-byte stdout 与 934-byte receipt 均精确召回，未重放修改。此结果只证明当前桌面/CLI 版本组合的 bridge 与 recovery 路径；没有收到 MCP `notifications/cancelled`，也不代表历史 TUI/native Shell 路径通过或 Windows 整体验收完成。独立 patch exe 为 0.158.0；未改全局设置、安装或升级组件，也未重启 Desktop。细节见 [fixtures/t3/cancellation-compat-evidence.json](fixtures/t3/cancellation-compat-evidence.json)。较早 Desktop `OpenAI.Codex 26.928.1915.0`（host core 0.159.0；独立 CLI/patch exe 0.158.0）的普通 Shell、大输出打包与 recall、native patch 路由和 MCP 验证/回执 recall、Shell exit 7 stderr 反馈及停止后恢复记录见 [fixtures/t3/desktop-native-evidence.json](fixtures/t3/desktop-native-evidence.json)。三项 Hook 定义沿用了先前在 TUI 的信任，本次隔离项目另行逐项核对；具体宿主 UI 证据不能由 Node 定向测试或 CLI 证据替代。`runtime.schema.json` 只描述内部数据，不代表 Codex Hook/API schema。

## Schema 与样例

- `runtime.schema.json` 必须是可解析 JSON，声明 JSON Schema Draft 2020-12，且可由 Draft 2020-12 validator 自身检查。
- `rules.example.json` 必须通过 `#/$defs/RulesConfig` 校验。配置项、命令、事件、回执、归档、打包与召回对象均拒绝未知字段；版本固定为整数 `1`。
- `native.example.json` 必须通过 `#/$defs/NativeConfig` 校验。`workspace`、`rules`、`node`、`shell` 是示例用绝对 Windows 路径；样例不得含本机真实用户路径。NativeConfig 的结构校验不证明目标文件或宿主版本存在。
- 各对象状态只接受 schema 声明的枚举。负向校验至少覆盖未知 receipt/check/tool/pack 状态、未知 recall error code、未知 selector kind、非法 selector 字段和未知对象字段。
- 路径负向校验至少覆盖绝对路径、盘符路径、反斜杠、`..` 路径段和重复分隔符。事件路径非空且唯一；工作目录 `.` 唯一表示工作区根。
- Python 样例的 `watch_paths: ["**/*"]` 覆盖项目输入树中的所有层级和隐藏文件，包括测试读取的 JSON、文本 fixture、配置与锁文件。运行时默认排除 `.git/`、`.codex/sol/`，并排除项目显式声明的生成物；这些默认排除不应缩小配置要求覆盖的其他输入。
- recall selector 只接受 `lines`、`keyword`、`bytes` 三种严格分支；`lines` 从 1 起，`bytes` 从 0 起，`context_lines` 仅为 0–10，默认语义为 2。范围起止顺序、文件实际长度和 cursor 绑定由运行时检查。
- recall 结果必须且只能带 `text` 或 `base64` 内容之一。`truncated=false` 时 `next_cursor=null`；`truncated=true` 时必须有非空 cursor。非 `IO_ERROR` 的 `retryable` 必须为 false。
- `origin` 仍按合同枚举 `agent|validation`。`origin=validation` 可通过形状校验，但调用 `onChange` 不得运行规则，必须返回 `skipped` 或在事件入口过滤；这是防止验证输出递归触发的负向夹具要求。
- 每个 CheckResult 都必须有非空 `reason`。通过命令使用 `success`，非零退出使用 `nonzero_exit`，超时使用 `timeout`，后续未运行命令使用 `prior_failure`；未命中规则、runner 错误等分支须给出对应可辨识原因。
- `CaptureMeta` 表示调用方已知的来源上下文；归档记录将其与最终 `RawRef` 一起持久化。最终字节数、SHA-256、媒体类型和完整性必须来自实际捕获结果，不能由调用方伪造来替代捕获校验。

建议在仓库根目录运行以下只读检查（不安装依赖）：

```powershell
python -c 'import json; from pathlib import Path; from jsonschema import Draft202012Validator, FormatChecker; p=Path("codex-sol"); schema=json.loads((p/"runtime.schema.json").read_text(encoding="utf-8")); Draft202012Validator.check_schema(schema); validator=Draft202012Validator({"$ref":"#/$defs/RulesConfig", **schema}, format_checker=FormatChecker()); example=json.loads((p/"rules.example.json").read_text(encoding="utf-8")); validator.validate(example); print("Draft 2020-12 schema and rules example: OK")'
```

本轮另单独用项目 `assertContract('NativeConfig', native.example.json)` 校验 NativeConfig 样例；这不等于完整测试套件。

## Windows 原生接入验收

- `CODEX_SOL_PATCH_EXECUTABLE` 指向安装的 Codex 实际 `.exe` 绝对路径，不是 `.cmd` / `.bat` shim。`sol_apply_patch` 接受标准 Begin Patch / End Patch 上下文格式，最大 24,000 UTF-8 字节；拒绝越界、junction/symlink 逃逸、`.git/`、`.codex/sol/` 的大小写别名和 ADS 路径。
- 项目 `.codex/hooks.json` 保留既有 hooks，并注册 SessionStart、PreToolUse 与 Bash PostToolUse。Hook 命令形式为 `node "<入口绝对路径>" --config "<native.json 绝对路径>"`。项目 `.codex/` 必须可信；CLI/TUI 在 `/hooks` 审阅定义，Desktop 在“设置 → 钩子”查看项目条目，逐项确认 command、matcher、timeout 并启用。Hook 定义修改后重新审阅。不得通过全局 trust 或常态绕过审核来验收。
- 项目 `.codex/config.toml` 需在保留现有 MCP 配置的同时启用 `[features] hooks = true`；已有 `[features]` 表时合并该键，不重复声明。当前 Desktop 项目配置执行 `codex features list` 返回 exit 0，输出 `hooks stable true`；未改全局设置或重启 Desktop。
- `CODEX_SOL_HOST_EXECUTABLE` 可选，须指向安装后的 Codex `.exe` 绝对路径。设置后，只有 `sol_apply_changes`、`sol_apply_patch` 和 `sol_read_file` 使用只读 app-server `thread/read`（`includeTurns: false`）并扫描匹配 thread/turn 的 rollout 日志；仅显式 `turn_aborted` 事件取消现有 MCP signal。未设置时保留 MCP SDK 原行为。该桥接不覆盖 `sol_recall` 或原生 Shell Hook；不同进程读取到的 unfinished-turn 状态不能作为取消证据。RPC、metadata、cwd、rollout path 或日志核验失败须 fail closed 为 `HOST_STATE_ERROR` / `host_state_error`，不得 `passed` 或重放。实现预算和版本边界见 [contracts.md](contracts.md#8-optional-mcp-host-cancellation-bridge)。
- CLI/TUI 的审阅入口是 `/hooks`；Desktop 的入口是“设置 → 钩子”（Settings → Hooks）。Desktop 聊天输入 `/hooks` 显示“无命令”不代表 project Hooks 未加载；应在设置页检查三项项目 Hook 的命令、matcher、30 秒 timeout 与启用开关。
- Codex 按 Git 工作区根发现项目 Hook。配置应位于 Codex 实际识别的 Git 根；若嵌套验收目录要独立加载 Hook，需在该目录执行 `git init` 建立独立根（无需提交），否则把 `.codex/hooks.json` 放到实际根。`NativeConfig.workspace` 需与该项目根一致。
- PreToolUse 对原生 `apply_patch`、`Edit`、`Write` 拒绝并指向 `sol_apply_patch`；这是路由提示，不是对同一原生调用的透明 MCP 替换。未匹配的宿主工具不受覆盖。
- Shell 命令限定为 1–8000 字符；Hook 在原宿主 Shell 中启动本地 Node runner，使用配置的实际 PowerShell exe、版本、profile 设置和 timeout，保留宿主 cwd 与 sandbox/token。runner 将 cwd 限定在配置 workspace 内，并在同一 workspace 锁内完成执行、前后变化检测和有变化时的验证。PreToolUse 返回 `permissionDecision=allow` 与 `updatedInput`，因此不声称保留普通 Shell 的逐命令 ask 提示；本轮 CLI/TUI 使用 `-a never` 或 `danger-full-access`，受限 sandbox 与 ask 模式未验证。
- 覆盖无变化（不验证）、成功变化、非零退出但已修改、超时和取消；捕获 stdout 与 stderr。检查 `execution`、`validation`、`tool_status` 分离表达，确认输出 ObservationPack 不超过 4 KiB、完整 managed-command envelope 不超过 8 KiB；路径列表省略时 `changed_path_count` / `changed_paths_omitted` 正确，`change_event_raw` 可精确 recall 完整清单。
- PostToolUse 必须从 `.codex/sol/native/<call_id>.result.json` 读取已提交失败结果，并以 `decision:block` 反馈；不依赖宿主 `tool_response`。异常或 block 不撤销已经发生的文件副作用，不得自动重放无结果的已启动请求。
- Hook 不是绝对安全边界。未信任项目、Hook 未获信任、其他或专业写入工具可能绕过。Linux 原生 Hook 接入按用户要求推后，本轮不实现也不验收。

用例映射和已验证状态见 [fixtures/manifest.md](fixtures/manifest.md) 的 NI 系列及 HC-01。CLI 异常证据见 T3-CLI-02，TUI 的信任审阅、Shell 路由和 Esc 取消失败见 T3-TUI-01/02/03；CLI trust bypass 与 TUI timeout 都不能标为完整通过。旧 Desktop 无桥接 GUI Stop 失败见 T3-DESKTOP-01；带显式事件桥接的 Desktop MCP patch Stop 单项通过见 T3-DESKTOP-02，但这不覆盖 native Shell、TUI 或整体 Windows 验收。

## 行为验收夹具

按 [fixtures/manifest.md](fixtures/manifest.md) 的 ID 构造并执行用例。必须满足：

- 无改动不产生事件；一次多文件修改合并成一个事件；工具失败但确有修改仍会验证；重复 `event_id` 复用原回执且不重复执行命令。
- `origin=validation` 不触发验证。未命中规则为 `skipped/no_rule`；输入变化为 `stale/input_changed`；中断为 `error/interrupted`；存储失败为 `error/storage`。以上状态都不能变成 `passed` 或 `ok`。
- 退出码 0 才能将检查记为 `passed`；首个非成功后停止，后续检查 `skipped`；命令按 argv 执行，超时终止进程树。只有快照稳定且所有已列检查通过，顶层才可为 `passed`。
- RawRef 的 SHA-256 与捕获字节一致。重复打开先验证 hash；丢失、损坏、越界、坏 cursor、非 UTF-8 行检索返回合同中的区分错误，不构造假 handle。
- 原始输出 `<=8192` 字节使用 inline，`>8192` 使用 packed；完整序列化后的模型可见 ObservationPack 和 ValidationReceipt 各不超过 4096 UTF-8 字节，recall 每页不超过 8192 UTF-8 字节。预算包括 JSON/base64/envelope 开销，必须按字节计量。
- stdout 与 stderr 分开归档；结构化响应存储完整 UTF-8 JSON envelope 并标记 `source_form=response_json`。外部链接不下载。上游截断或中断必须保留 `complete=false` 与原工具状态。
- 直接 capture/read 调用在取消或源失败时应保留已捕获前缀为 `RawRef.complete=false` 并可 recall；内部结果带 `INTERRUPTED` 或源错误。MCP SDK 2.2.0 收到取消通知后会中止 handler signal 并抑制 JSON-RPC 响应，因此不要求客户端收到中断 payload 或部分 handle。capture begin/write/commit 失败均返回 `storage_error`；summary 区分 `tool_may_have_executed=false|true`，未提交 handle 不公开，调用不重放，未归档原文不走旁路，临时文件保留且 capture 资源关闭。
- 同一 workspace 的受管修改和同步验证须跨进程串行；等待锁的取消须快速中断 handler 且不改文件。Windows named pipe 与 Linux abstract socket 按 `workspaceId` 互斥，不用网络端口；持锁期间 owner 文件记录 runner 的 `starting/running/idle`。主进程退出由 OS 释放 native lock；runner 存活时继续等待，runner 退出后新的事件可以运行且不会重放旧验证。恢复新事件会保留旧 receipts、observations 和 `.running` 证据；同一事件重新投递时，其 `.running` 标记转成 `error/interrupted` 回执。owner 损坏或 `starting` 时不能确认 child PID，应返回 `RECOVERY_REQUIRED`；先确认相关进程退出，再处理 owner。旧版 lock 目录不自动删除。其他 Unix 目录锁崩溃需人工恢复；Linux/其他 Unix 未在当前 Windows 环境实测。
- 验证 stdout/stderr capture 启动失败、回执提交失败及后快照失败时保留已知检查结果。新事件在崩溃后恢复不会清理旧 observations、receipts 或 `.running` 证据；若相同事件重新投递，其 `.running` 标记转为持久化的 `error/interrupted` 回执，不重跑验证。
- lines 按 LF 分行且保留 CRLF 原字节；末尾无换行仍为一行。keyword 大小写敏感、按字面匹配、窗口合并后按原文顺序返回。bytes 左闭右开并用 base64；分页 cursor 绑定 workspace、handle、hash、selector 和下一偏移。

`fixtures/t0/cli-evidence.json` 记录早期 CLI Hook 探针；`fixtures/t3/cli-native-evidence.json` 记录四次 Windows CLI 原生异常运行的 event item、RawRef、SHA-256、召回片段和清理状态。T3 日志和 `.codex/sol` 归档存于被忽略的本机 `slop/` 路径，不是运行时依赖；四次运行使用单次 trust bypass，不能作为常规 Hook 审阅的证据。TUI 原生终端记录和取消 receipt 位于忽略路径 `D:/zzd/slop/codex-sol-host-runs/tui-acceptance/`；第一次 Esc 后的 receipt `63be2c33-6a7e-4774-b60f-f5fe209d07b6` 为 `timeout`，30,307 ms、`complete=false`。第二次 wire 记录 `esc-wire-immediate.json` 与 `esc-with-proxy.receipt.json` 显示，直到 09:30:57.001Z 的完整 response 才结束，event `7911482e-1340-4b6d-8379-42cbdfa169b7`、receipt `9ea39067-8369-436e-b40d-ac2f48e91e9a` 为 `timeout`、30,273 ms；此前没有发出 `notifications/cancelled`。这些运行都不算宿主取消通过。重启后的 TUI 已验证 native patch deny→MCP patch passed（event d3cf5a03-a763-4716-92dc-b4169b552a38）、旧输出精确 recall，以及 intentional Shell exit 7 的 Post block；正式结构化结果见 [t3/tui-evidence.json](fixtures/t3/tui-evidence.json)。直接 capture/lock 与 Node stdio 取消测试不代替宿主按键取消。故障归档和锁恢复夹具见 `tests/capture-failure.test.mjs`、`tests/validation-failure.test.mjs`、`tests/workspace-lock.test.mjs` 与 `tests/failure-protocol.test.mjs`。桌面版旧三工具冒烟的句柄和归档位于忽略 Git 的 `slop/codex-sol-desktop-smoke/`，清理该目录后无法从本地归档再次召回；Desktop 新聊天的普通 Shell、大输出 recall、patch 路由/验证/回执 recall、Shell exit 7 与 Stop 后恢复验收见 [fixtures/t3/desktop-native-evidence.json](fixtures/t3/desktop-native-evidence.json)；Stop 未终止 runner，故停止验收失败。Linux 原生 Hook 本轮不在范围内。

## 2026-10-01 最终检查

| 检查 | 环境 / 命令 | 结果 |
| --- | --- | --- |
| 运行环境 | Windows、Node.js 24.11.0、npm 11.6.3 | 当前检查环境 |
| 完整检查 | `npm run check`（显式事件桥接实现） | 退出码 0；81/81 测试通过、0 skipped；官方 npm registry audit 发现 0 vulnerabilities |
| Native 定向测试 | `tests/native-integration.test.mjs` | 10/10 通过；覆盖 Windows 原生 patch 与 managed shell 回归，包括 UTF-8 字节上限；不覆盖 Hook 注册、trust 或真实客户端 UI |
| Native Hook 定向测试 | `tests/native-hook.test.mjs` | 5/5 通过；校验 Hook adapter 行为，不代替宿主 UI 验收 |
| Host cancellation adapter 定向测试 | `tests/host-cancellation.test.mjs` | 18/18 通过；覆盖只读 app-server metadata、显式目标事件、边界故障和 reader/rollout 清理；不代替真实宿主 UI 验收 |
| CLI 原生异常 | `D:/zzd/slop/codex-sol-windows-acceptance`；证据见 T3 fixture | CLI 日志直接记录 Shell exit 7、timeout、runner stopped、精确 recall、native patch 路由与验证回执；四次运行均使用单次 trust bypass，未验证常规项目信任流程 |
| TUI Hook | [正式 TUI 记录](fixtures/t3/tui-evidence.json)；`D:/zzd/slop/codex-sol-host-runs/tui-acceptance` | 无 bypass 审阅三项 Hook；重启后 patch 路由、MCP patch、recall、Shell exit 7 block 通过。两次 Esc 取消都以 timeout 结束（30,307 / 30,273 ms），第二次 wire 未见 `notifications/cancelled`，见 T3-TUI-01/02/03。 |
| Desktop Hook（历史无桥接验收） | Desktop `OpenAI.Codex 26.928.1915.0`（host core 0.159.0；独立 CLI/patch exe 0.158.0）；[旧 Desktop 结构化证据](fixtures/t3/desktop-native-evidence.json) | 旧配置下普通 Shell、大输出 recall、patch 路由/验证、Shell exit 7 与恢复检查通过；GUI Stop 后 runner 仍运行，约 90 秒 timeout 后清理。首次 Stop 点击发生在工具已返回后，不计作有效复现。该行保留当时无桥接结果，当前桥接验收见下一行。 |
| Desktop MCP cancellation bridge 与 recovery | Desktop `OpenAI.Codex 26.928.2636.0` / host core 0.159.2；patch exe 0.158.0；[当前显式事件与 recovery 证据](fixtures/t3/cancellation-compat-evidence.json) | 独立 Git fixture、首次项目 Hook 审阅均完成；unset bridge 的基线 Stop 未取消 runner，validator 90,273 ms 后 timeout。启用显式事件桥接后，目标 `turn_aborted` 将 MCP patch 运行中断，receipt `error/interrupted`、总时长 19,016 ms，GUI Stop 到 response 约 0.7 秒；child 已退出、owner 已移除。后续 recovery chat `01a0f569-b285-7b71-b4eb-52dbd55ae6e4` 实测三项 MCP 调用：patch `desktop_recovery_20261001_events.py` passed（event `bd49c6e3-61c7-4f94-956e-31dd6224a0d7`），旧 stdout 的 45-byte 精确 lines recall，以及 936-byte 旧 `error/interrupted` receipt 的精确 keyword recall；原 stdout `complete=false`，receipt archive `complete=true` 且 `checks.output.complete=false`。这是 bridge 与 recovery 专项兼容验收，不覆盖 TUI、native Shell 或 Windows 整体验收。 |
| TUI MCP cancellation bridge 与 recovery | TUI 0.159.2；无 Hook trust bypass；[当前结构化证据](fixtures/t3/cancellation-compat-evidence.json) | Esc 到 response 571 ms；目标事件为 `turn_aborted`；校验回执 `error/interrupted`、时长 651 ms，进程已退出、owner 已清理。恢复 patch passed；两项召回纠正参数后精确通过，stdout 保留 `complete=false`，receipt archive 为 `complete=true`。复用已登录的独立 TUI；本次新启动受 workspace routing discovery 错误阻挡，不能将旧会话测试写作新启动验收。 |
| Schema 与样例 | `Draft202012Validator.check_schema`；校验 `rules.example.json` | 既有基线通过 |
| NativeConfig 样例 | `assertContract('NativeConfig', native.example.json)` | 通过；完整最终检查另由 `npm run check` 确认 81/81 |
| lint / format / typecheck | 项目配置 | 未配置 |
| 宿主异常验收范围 | 旧三工具正常冒烟、T3 CLI 夹具及 TUI/Desktop Hook 实测 | T3 CLI 使用单次 trust bypass；TUI 正常路由和失败反馈通过；历史无桥接 Esc / GUI Stop 失败记录保留。Desktop 与 TUI 显式事件桥接和恢复检查通过；原生 Shell Stop、受限 sandbox 与 ask 尚未验证，Linux 按本轮范围推后。 |
