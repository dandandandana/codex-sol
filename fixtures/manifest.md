# V0.1 fixture 清单

既有阶段验收（2026-10-04）见 [current-stage/README.md](current-stage/README.md)：主项目 126/126、审计 0 漏洞；独立普通需求 27/27，外部黑盒 20/20。其后变更状态 Context 切片的最新记录见 [context-state/README.md](context-state/README.md)。前一目录保存回归失败/修复、检查输入、实际模型 STDIO 调用、源码与声明 SHA 和独立验收；D 盘功能项目保留为测试夹具，未发布。自动声明维护与宿主自动接入的边界分别报告。

本清单把开工单和 Windows 原生接入要求映射到稳定的验收 ID。`tests/` 已覆盖核心行为；标为“待验收”的宿主路径仍需真实宿主证据，并按范围区分 CLI、TUI 和 Desktop。Codex 按 Git 工作区根发现项目 Hooks：嵌套验收目录要独立启用时需先 `git init`（无需提交），或者把配置放在实际 Git 根。宿主 transcript 单独标注来源与适用范围。

## 已有宿主证据

| ID | 文件 | 证据与边界 |
| --- | --- | --- |
| T0-CLI-01 | [t0/cli-evidence.json](t0/cli-evidence.json) | Codex CLI 0.158.0 通用 Hook 探针。成功的 `apply_patch` 响应中没有 `changed_paths`；失败但已写文件的 Bash 调用退出码为 7、`tool_response` 为空，也没有 `changed_paths`。它支持“由受控修改 wrapper 产生唯一事件”的 CLI 决策，不提供桌面版冒烟证据，也不是 ChangeEvent 输入样例。 |
| T4-CLI-01 | `slop/codex-sol-e2e/` 本地探针（不入 Git） | CLI 0.158.0 真实调用 `codex_sol.sol_apply_changes`，模型收到 `passed/all_checks_passed` 和完整回执 handle。项目生成物显式排除后输入快照稳定。桌面版独立冒烟见 T4-DESKTOP-01。 |
| T4-DESKTOP-01 | [桌面冒烟聊天](thread://01a0eda3-66f6-7ed3-a3c8-347304f257b0?hostId=local)；`slop/codex-sol-desktop-smoke/` 本地测试目录（不入 Git） | Codex Desktop 独立调用 `sol_apply_changes`、`sol_read_file`、`sol_recall`：修改 `app.py` 返回 `tool_status=ok`、`changed_paths=["app.py"]`、`passed/all_checks_passed`、执行 1 个检查及回执 handle；读取 33,779 字节 `trace.txt` 返回 `packed`，RawRef SHA-256 与本地文件一致；关键词召回返回完整锚点行，`truncated=false`、`next_cursor=null`。独立 Python unittest 为 2 tests OK。句柄和归档是 `slop/` 中的本机证据，清理测试目录后无法再次从本地归档召回；该记录只覆盖三个显式接入工具，不覆盖普通 `apply_patch`、Shell、其他 MCP 工具透明拦截或全量异常路径。 |

| ID | 文件 | 证据与边界 |
| --- | --- | --- |
| T3-CLI-02 | [t3/cli-native-evidence.json](t3/cli-native-evidence.json)；`D:/zzd/slop/codex-sol-host-runs/` event logs 与 `D:/zzd/slop/codex-sol-windows-acceptance/.codex/sol/` 归档（均不入 Git） | CLI 0.158.0 / Windows / gpt-6-luna 的四次运行：`failure-shell-01` 捕获 `SHELL_HOST_FAILURE` 且管理结果保留 exit 7；`native-02` packed 输出 143,118 bytes、recall 精确命中 anchor、普通 `apply_patch` 被路由至成功的 `sol_apply_patch`；`abnormal-03` 记录 validator exit 7、timeout、`RUNNER_STOPPED` 及两个初始错误范围查询；`recall-04` 用 keyword 精确召回失败与 timeout 输出。四次都使用单次 `--dangerously-bypass-hook-trust`，不证明常规 trust 审阅流程。trace 文件为 143,116 bytes；PowerShell 捕获流多 2 bytes，哈希不同，不能混称。工作区保留供 TUI 复用，记录时 native `.running` marker 为 0。 |
| T3-TUI-01 | `D:/zzd/slop/codex-sol-host-runs/tui-acceptance/tui-capture.ansi.txt`、`esc-before-proxy.started.json`、`esc-before-proxy.receipt.json`（不入 Git）；TUI thread `01a0f19c-2379-7822-bf47-698b6340e87d` | 独立 PTY TUI，未使用 trust bypass；三项 Hook 经 `/hooks` 审阅后 Active。普通 Shell 已返回 wrapped JSON。`sol_apply_patch` 创建 `tui_cancel_01.py` 并启动 validator PID 5968（09:19:34Z）；按 Esc（约 09:19:44.7Z）时 UI 显示 interrupted，但 validator 仍运行，最终事件 `bc592666-44fd-4659-814d-57ebf5456dc2` 的 receipt `63be2c33-6a7e-4774-b60f-f5fe209d07b6` 为 `timeout`、30,307 ms、`complete=false`。这不是宿主取消成功；进程最终退出且锁已清除。 |
| T3-TUI-02 | `D:/zzd/slop/codex-sol-host-runs/tui-acceptance/esc-wire-immediate.json`、`esc-with-proxy.receipt.json` 与 `protocol.jsonl`（不入 Git） | 第二次 TUI Esc 运行中，Codex CLI 0.158.0 透传协议记录：`sol_apply_patch` 的 `tools/call` id `2` 在 09:30:26.567Z 开始，validator PID 50012 在 09:30:26.755Z 启动；09:30:26.892Z 按 Esc 后，09:30:46.990Z 检查仍存活，代理未收到 `notifications/cancelled`。完整 protocol 到 09:30:57.001Z 才收到 id `2` 的结果：事件 `7911482e-1340-4b6d-8379-42cbdfa169b7`，receipt `9ea39067-8369-436e-b40d-ac2f48e91e9a` 为 `timeout`、30,273 ms；stdout handle `WH3x3juHyX_-KlrWycUhMOv2lumEz3SZ` 为 `complete=false`。随后 PID 退出且 owner 文件不存在。只说明这次本机 CLI 0.158.0 TUI 调用未发送取消通知，不泛化到 Desktop 或其他版本；重启恢复结果见 T3-TUI-03。 |
| T3-TUI-03 | [t3/tui-evidence.json](t3/tui-evidence.json)（正式结构化 TUI 证据）；原始 PTY、receipt 与 wire 文件见忽略路径 `D:/zzd/slop/codex-sol-host-runs/tui-acceptance/` | 独立 TUI 无 trust bypass 完成三项 Hook 审阅，首轮普通 Shell wrapper passed；随后重启 TUI 的四步恢复验收通过：原生 `apply_patch` 被 Hook 拒绝并明确指向同 patch 的 `sol_apply_patch`；MCP patch 新增 `tui_recovered_01.py` 并 `passed/all_checks_passed`（event `d3cf5a03-a763-4716-92dc-b4169b552a38`、receipt `0a56b6b6-b1e6-4992-9ce3-8c392712b5ab`、89 ms）；对旧 timeout handle `WH3x3juHyX_-KlrWycUhMOv2lumEz3SZ` 的精确 recall 返回 `TEST_MODE=wait waiting_for_release pid=50012`（原始源 `complete=false`）；故意 exit 7 的 Shell 失败经 Post hook 以 `tool_status=error` 返回。收尾确认两个旧 runner 已退出、owner 不存在、receipts 从 7 增至 8、旧 receipt/hash 不变。该重启恢复测试不等于活动验证进程硬崩溃测试，也不覆盖 Esc 取消缺口、Desktop、受限 sandbox 或 ask 审批。 |
| T3-DESKTOP-01 | [正式结构化证据](t3/desktop-native-evidence.json)；UI 原始记录 `D:/zzd/slop/codex-sol-host-runs/desktop-acceptance/hooks-ui.txt`（忽略目录） | Windows Desktop `OpenAI.Codex 26.928.1915.0`（host core 0.159.0；独立 CLI/patch exe 0.158.0）。项目启用 `[features] hooks = true` 后，`codex features list` 显示 `hooks stable true`；Settings → Hooks 显示三项项目 Hook 启用并核对 command、matcher、30 秒 timeout。相同 Hook 定义先前已在 TUI 信任，本轮沿用该定义，未单独重新审核 Desktop 信任流程；未改全局配置或重启 Desktop。普通 Shell managed JSON、大输出 pack 与 keyword anchor recall、native patch deny 后同 patch 经 MCP 验证并 recall receipt、Shell exit 7 stderr JSON 反馈通过。GUI Stop 后聊天显示 interrupted，但后台 runner/owner 仍存活且未观察到取消通知；约 90 秒后 timeout 并清理，Stop 验收失败。第一次点击晚于 30 秒工具返回，不算有效复现。随后新聊天 MCP patch 与旧 timeout stdout/receipt recall 通过，runner/owner 清理完成；该检查不代表 Desktop 重启或硬崩溃恢复。Desktop 整体验收未通过。 |
| T3-DESKTOP-02 | [正式结构化证据](t3/cancellation-compat-evidence.json)；隔离 Git fixture `D:/zzd/slop/codex-sol-stop-compat-20261001/`（不入 Git） | Windows Desktop `OpenAI.Codex 26.928.2636.0` / host core 0.159.2，独立 patch exe 0.158.0。新 fixture 首次 project trust 后，先启动新 project chat，再点输入框旁“审查钩子”；在弹窗中逐项展开三项 Hook，核对 command、matcher、30 秒 timeout 后点击“全部允许”。此前 Settings → Hooks 只显示旧项目 Hook；普通 Shell marker JSON passed。无桥接基线中，GUI Stop 后未发送取消，validator 以 90,273 ms timeout 结束。显式事件桥接复测使用 thread `01a0f566-816d-7430-860b-040e858c99ee`、turn `01a0f566-853d-7d53-b85f-e361a9e3b3a8`、MCP request id `2`：request 02:59:20.019Z 开始，runner PID 27020 于 02:59:20.368Z 启动；GUI Stop 发生于 02:59:38.576–02:59:38.657Z，response 于 02:59:39.358Z 返回。目标 rollout 的明确 `turn_aborted` 使既有 signal 中断，receipt `48a0a92b-5159-4f74-a001-598d693c678a` 为 `error/interrupted`，总 duration 19,016 ms（不是取消延迟）；stdout 45 bytes、`complete=false`、handle `neJeilNU-ifO4K1Jros1w7vu8EX29W0-`，receipt handle `TCWriEFq1jc7aaf6FbZhwtYgMhtVH2ls`。02:59:57.128Z 检查 child 已退出且 owner 不存在；此桥接不合成 MCP `notifications/cancelled`，日志中该通知仍为 0。随后 recovery chat `01a0f569-b285-7b71-b4eb-52dbd55ae6e4` / turn `01a0f569-b5e0-7ed2-a993-f0b1ac5baa03` 的三项 MCP 调用通过：追加 `desktop_recovery_20261001_events.py` 的 `sol_apply_patch` passed（event `bd49c6e3-61c7-4f94-956e-31dd6224a0d7`，receipt handle `e3S8NI0gD-e7k4HXJAyMGI-WDOsvQX1l`）；对旧 stdout handle `neJeilNU-ifO4K1Jros1w7vu8EX29W0-` 做 45-byte 精确 lines recall（包含实际 validator PID 27020）；对旧 receipt handle `TCWriEFq1jc7aaf6FbZhwtYgMhtVH2ls` 做 936-byte 精确 keyword recall。旧 receipt 的状态为 `error/interrupted`、`duration_ms=19,016`，原 stdout source `complete=false`；receipt archive 本身 `complete=true`，其 `checks.output.complete=false`。曾尝试用跨进程 `turn/status` 作为停止信号的结果因 unfinished-turn 假阳性被否决，未作为证据或实现依据。证据 JSON 当前状态为 `desktop_tui_bridge_passed`，TUI 显式事件桥接见 T3-TUI-04；该 Desktop/core 组合下的显式事件中断和三项 recovery 调用通过，不覆盖 TUI Esc、native Shell Stop、Full Access 外受限/ask 或 Windows 整体兼容性。 |

| T3-TUI-04 | [取消桥接结构化证据](t3/cancellation-compat-evidence.json)；`D:/zzd/slop/codex-sol-host-runs/stop-compat-20261001/tui01592/` 原始证据（不入 Git） | TUI 0.159.2，无 trust bypass，复用已登录隔离终端。校验 04:01:59.451Z 启动，Esc 04:01:59.484Z，目标 `turn_aborted` 04:01:59.516Z，response 04:02:00.054Z；取消延迟 571 ms。receipt `40ab882e-fe98-42a0-b0c0-7bf8db3c6c18` 为 `error/interrupted`，check duration 651 ms；validator PID 32652 已退出，owner 不存在。stdout 45 bytes、`complete=false`；receipt archive 934 bytes、`complete=true`。恢复 patch passed，首次两个错误 selector 被接口拒绝；随后用合同 `kind` / `literal` 精确召回 stdout 和 receipt，未重放修改。新 TUI 启动的 workspace routing discovery 错误单独记录，不算工具测试；不覆盖 native Shell Stop、受限 sandbox/ask 或 Linux。 |

## Windows 原生接入

| ID | 场景 | 机械断言 | 当前状态 |
| --- | --- | --- | --- |
| NI-01 | `sol_apply_patch` 使用 Codex 原生 patch 引擎 | 24,000 UTF-8 字节上限；上下文 patch 成功与上下文失败；拒绝盘符/绝对路径、越界、反斜杠、大小写别名 `.git` / `.codex/sol`、ADS 与 junction 逃逸。 | `tests/native-integration.test.mjs` 定向 10/10 通过，含 UTF-8 字节上限回归；不覆盖 Hook 注册或 CLI/Desktop UI。 |
| NI-02 | 受管 Shell 执行、变化检测和输出归档 | 成功及非零退出均捕获 stdout/stderr；非零退出前有改动仍验证；无变化不验证；timeout/cancel 保留不完整输出、不遗留继续运行的子进程；输出可 recall。 | `tests/native-integration.test.mjs` 定向 10/10 通过；Node 子进程测试不能代表宿主停止。TUI 两次 Esc 与旧 Desktop 无桥接 GUI Stop 均未终止正在运行的 validator，最终 timeout；见 T3-TUI-01/02 和 T3-DESKTOP-01。T3-DESKTOP-02 证明可选桥接只取消 MCP request，不等于原生 Shell Hook 的 Stop 已通过。 |
| NI-03 | PreToolUse / PostToolUse Hook 改写与失败反馈 | Bash 命令限制 1–8000 字符；PreToolUse 在宿主 Shell 内调用 runner；原生 `apply_patch`、`Edit`、`Write` 返回 deny 并指向 `sol_apply_patch`；PostToolUse 从私有结果文件读取失败并 `decision:block`。 | `tests/native-hook.test.mjs` 定向 5/5 通过；CLI/TUI 也观察到 wrapper 结果。TUI Esc 未及时取消正在运行的 validator；一次 wire 记录未见宿主发出取消通知，不能把 Node 取消测试当作宿主按钮通过。 |
| NI-04 | Codex CLI/Desktop Hook 信任与真实异常 | 项目 `.codex/` 信任后，在宿主入口审阅当前精确 hash；确认异常结果可见且不会依赖 `tool_response`，同时记录副作用不会回滚。 | CLI 异常运行记录于 T3-CLI-02，但都使用单次 trust bypass。TUI 无 bypass 审阅三项 Hook 并验证 Shell、MCP patch 路由/验证、recall 与 exit 7 反馈；两次 Esc 均以 `timeout` 收尾。Desktop 新配置启用三项 Hook；相同 Hook 定义先前已在 TUI 信任，本轮沿用该定义，未单独重新审核 Desktop 信任流程。Desktop 普通 Shell、大输出 recall、patch 路由/验证/receipt recall 和 Shell exit 7 反馈通过；GUI Stop 未终止 runner，停止验收失败，随后新聊天恢复 patch 与 timeout stdout/receipt recall 通过。CLI/TUI 使用 `-a never` 或 `danger-full-access`；PreToolUse 的 `permissionDecision=allow` + `updatedInput` 有独立审批语义，受限 sandbox 和普通 ask 审批均未验证。旧 Desktop 夹具缺 Hooks 且不是独立 Git 根，修正后验收见 T3-DESKTOP-01。 |
| NI-05 | Linux 原生 Hook 接入 | 本轮不实现、不测试、不验收。 | 按用户要求暂缓；无 Linux 工作。 |

## Optional MCP 宿主取消桥接

| ID | 场景 | 机械断言 | 当前状态 |
| --- | --- | --- | --- |
| HC-01 | 用 Codex rollout 中的明确 `turn_aborted` 事件中断在途 MCP 请求 | 可选 `CODEX_SOL_HOST_EXECUTABLE` 指向安装的 Codex exe 绝对路径；仅以 `thread/read(includeTurns=false)` 取线程 metadata，核实匹配 thread、turn、workspace cwd、session 与 rollout path；只接受目标 turn 明确 `turn_aborted`。核实失败 fail closed；不得以 `turn/status`/unfinished-turn 状态推断取消，不合成 MCP cancellation notification、不重放。 | `tests/host-cancellation.test.mjs` 18/18 通过；真实 Desktop bridge Stop 与三项后续 MCP recovery 见 T3-DESKTOP-02：Codex Desktop/core 0.159.2、patch exe 0.158.0，明确事件后 receipt `error/interrupted`，19,016 ms 为总运行时间、Stop 至 response 约 0.7 秒，runner/owner 已清理；后续 patch passed、旧 stdout 和 receipt 精确 recall 通过，receipt archive 完整但其输出 RawRef 不完整。旧无桥接 TUI/Desktop 取消失败仍有效；Linux、其他版本、native Shell、受限 sandbox/ask 未验证。 |

## Action Fusion 与回执

| ID | 页面要求的场景 | 机械断言 | 当前状态 |
| --- | --- | --- | --- |
| AF-01 | 无实际改动 | 不产生 ChangeEvent，不调用 runner，不生成 passed 回执。 | `tests/mcp.test.mjs` 已测 |
| AF-02 | 一次调用修改多个文件 | 只产生一个 agent ChangeEvent；`changed_paths` 包含每个实际新增、修改或删除路径，且 digest 对应完整排序清单。 | `tests/mcp.test.mjs` 已测新增与删除 |
| AF-03 | 修改后工具失败 | 即使工具退出非零，只要工作树有实际改动，仍产生一个事件并执行匹配规则。 | `tests/mcp.test.mjs` 已测部分修改后删除失败 |
| AF-04 | 重复投递同一事件 | 重复 `event_id` 返回同一回执；验证命令调用次数不增加。 | `tests/validation.test.mjs` 已测回执与执行次数 |
| AF-05 | `origin=validation` | Schema 可识别合同枚举值；`onChange` 不运行规则，返回 `skipped` 或在入口处拒绝/过滤，绝不能递归验证。 | `tests/validation.test.mjs` 已测 |
| VR-01 | 验证成功 | 退出码 0 的检查记为 `passed`，`reason=success`；只有所有已列检查通过且输入快照稳定时，回执顶层才可为 `passed`。 | `tests/validation.test.mjs`、CLI 实测与桌面版三工具冒烟 |
| VR-02 | 验证失败 | 非零退出码记为 `failed`，`reason=nonzero_exit`；后续命令记为 `skipped`，`reason=prior_failure`；顶层不得为 `passed`。 | `tests/validation.test.mjs` 已测 |
| VR-03 | 验证超时 | 状态为 `timeout`，`reason=timeout`；进程树终止，保留已捕获输出；后续命令记为 `skipped`，`reason=prior_failure`，不得重试。 | `tests/validation.test.mjs` 已测状态、跳过与子进程树 |
| VR-04 | 无规则、快照变化、存储失败 | 分别保留 `skipped/no_rule`、`stale/input_changed`、`error/storage` 语义；均不能转成 `passed`。 | `tests/validation.test.mjs` 已测 |
| VR-05 | 验证输出归档与中断恢复失败 | stderr capture 启动失败时不继续 runner；回执提交失败、后快照失败时保留已知 checks；遗留 running 标记恢复为 `error/interrupted`，重复调用不重跑旧验证；missing-cwd 返回可诊断失败。 | `tests/validation-failure.test.mjs` 5/5 通过 |

## ObservationPack 与 recall

| ID | 页面要求的场景 | 机械断言 | 当前状态 |
| --- | --- | --- | --- |
| OP-01 | 8 KiB 阈值下方：8191 字节 | `mode=inline`；原始字节可从 RawRef 召回且 SHA-256 一致。 | `tests/pack.test.mjs` 已测 |
| OP-02 | 8 KiB 阈值：8192 字节 | `mode=inline`；边界按原始字节数计算。 | `tests/pack.test.mjs` 已测 |
| OP-03 | 8 KiB 阈值上方：8193 字节 | `mode=packed`；完整原文可召回，预览范围准确、遗漏字节数正确。 | `tests/pack.test.mjs` 已测 |
| OP-04 | 1 MiB 日志 | 原文完整落盘；分段 recall 拼接后 SHA-256 与原文一致；模型可见 pack 的序列化 UTF-8 大小不超过 4096 字节。 | `tests/pack.test.mjs` 已测全量分页拼接与 SHA-256 |
| OP-05 | 读取期间取消或上游失败 | 直接 capture/read 调用保留已成功捕获的精确字节前缀；`RawRef.complete=false`，且该 handle 仍可 recall。内部 ObservationPack 保留错误/未知工具状态，不声称上游完整。MCP SDK 2.2.0 取消请求时可能抑制 JSON-RPC 响应，因此不要求客户端收到部分 handle。 | `tests/capture-failure.test.mjs` 8/8 通过；覆盖取消、源读取失败，以及超 8 KiB 上游失败仍满足 envelope 预算 |
| OP-06 | capture begin/write/commit 失败 | begin 失败不启动源，summary 为 `tool_may_have_executed=false`；write/commit 失败为 `true`。三者都返回 `storage_error`，不公开未提交 handle、不重放、不旁路原文；失败临时文件保留且资源关闭。 | `tests/capture-failure.test.mjs` 8/8 通过；覆盖各失败阶段、资源关闭及 RawRef 不匹配时关闭已打开资源 |
| RC-01 | 超长行 | 可分页拆分；每页字节范围连续且精确，不静默丢弃行尾。 | `tests/store-recall.test.mjs` 已测 |
| RC-02 | CRLF | 按 LF 分行且回读保留 CR 字节；拼接原文逐字节一致。 | `tests/store-recall.test.mjs` 已测 |
| RC-03 | 中文 UTF-8 | 行与关键词检索不拆坏 UTF-8；字节模式仍返回精确 base64。 | `tests/store-recall.test.mjs` 已测 |
| RC-04 | 无末尾换行 | 最后一段仍计作一行，范围和内容准确。 | `tests/store-recall.test.mjs` 已测 |
| RC-05 | 二进制及无效 UTF-8 | bytes selector 返回 base64；lines/keyword 返回 `UNSUPPORTED_ENCODING`。 | `tests/store-recall.test.mjs` 已测 |

## Context 后续验收（2026-10-03）

最新阶段状态：博客只作为 Hook 夹具，不继续标签产品开发。新增 context/blog-hook-closeout-evidence.json 保存四次真实宿主回调、包装器推理前停止、核心非阻塞、源码不变和配置/进程清理；可复跑 context/run-blog-hooks.mjs。生命周期 12 项及 Native Hook 5 项回归通过，已有模型注入证据保留。Hook 本阶段已收尾并转入 MCP：新增真实召回范围提示和单行 JSON 说明，实际 STDIO 校验已覆盖。当前完整 113/113、审计 0 漏洞；下文早期证据按当时范围保留，实际 compact 和 Desktop Context 未验收。

| ID | 场景 | 结果与边界 |
| --- | --- | --- |
| CTX-01 | 真模型写前交接与召回 | CLI 0.158.0：plan / implement 产物均接受，消费者 ready，省略字段通过 recall 展开；notes 未映射，源码 SHA 不变，task_complete=false。两次 INVALID_RANGE 后纠正成功。证据：context/cli-evidence.json |
| CTX-02 | 未解决策略 | 原 CLI 场景产物带未解决项，下游 blocked；不以接受替代完成。首次项目配置未加载 MCP 与召回审批失败记录也保留在新证据中。 |
| CTX-03 | 按会话恢复 | context-hook.test.mjs 8/8：opt-in、会话隔离、来源重建、上游过期、坏引用、新任务并发、真实 STDIO 绑定、入口参数。使用实际 CLI 会话 ID 的合成 resume / compact 独立进程适配器验收通过。 |
| CTX-04 | 宿主注入和信任 | 修复 literal 项目键与 PowerShell 命令后，CLI 0.158.0 三回合、五次实际 Hook 调用通过。精确定义哈希仅本次调用可信，无 trust bypass；模型回报精确恢复引用，源码各回合不变。证据：context/host-hooks-evidence.json；复跑：context/run-hooks.mjs。交互式信任界面、实际 compact 和 Desktop Context 未验收；原失败记录保留。 |
| CTX-05 | UserPromptSubmit 按需提示 | 定向 Hook 测试 12/12；完整检查 104/104。无绑定/有效 ready 静默，过期或阻塞给短引用，不新增归档/绑定、不保存用户 prompt、不阻止发送。最新真实 CLI 收到 stale 后重新 prepare；恢复后静默。过期阶段省略 SessionStart 以单独验该路径。context/host-hooks-evidence.json 为最新实际证据，context/prompt-hook-evidence.json 保留早期尝试。 |


## M-001 架构索引验收（2026-10-03）

| ID | 场景 | 结果与边界 |
| --- | --- | --- |
| ARCH-01 | 固定上游独立复用 | Normify 0.5.4 十个原文件 SHA 核验一致；无 DSH 宿主依赖，独立编译真实仓库 19 模块 / 38 能力 / 58 静态导入，无阻塞。fixtures/architecture/local-index-evidence.json |
| ARCH-02 | 归属、UID 与代码事实 | 8 项新测试包含 UID 改名、指纹漂移、重叠归属、缺失导出与真实禁止依赖，均有相应失败诊断；不是完整调用图。tests/architecture.test.mjs |
| ARCH-03 | 职责与新鲜度 | 按角色 opt-in，包不超过 4096 字节、完整记录可 recall；目标外登记源码变化使 submit 和 prompt 过期。真实 STDIO 注册第七工具并返回固定来源。 |
| ARCH-04 | 独立博客 TUI | 用户授权 D 盘新建项目，真实交互 TUI 创建；12 项检查、真实 Edge 列表/详情/返回/手机宽度通过。父 agent 修复测试 HTTP 随机端口传输，保留真实断言。 |
| ARCH-05 | 真模型查询与交接 | TUI 31 次调用包含 7 次范围失败及纠正；查询发现 escapeHtml/readPosts 与归属/影响，首次下游因未补齐依据 blocked。补读后修订方案 accepted、无未解决项，随后额度耗尽；独立真实 STDIO 消费同一产物返回 ready，分别记录。fixtures/architecture/blog-tui-evidence.json |
| ARCH-06 | 边界与检查 | 112/112、审计 0 漏洞；原失败/取消证据保留。源码 SHA 不变，task_complete=false；标签未实现，完整 TUI ready 回合未验收；当时 M-002 状态/门禁/收尾仍待实现。revision 未核验 Git，博客 40 零占位明确不是提交身份。 |


## 工作区锁与进程恢复（既有证据）

| ID | 页面要求的场景 | 机械断言 | 当前状态 |
| --- | --- | --- | --- |
| LK-01 | 同 workspace 的跨进程串行及等待取消 | 修改与同步验证不重叠。直接 lock/capture 测试断言内部快速 `INTERRUPTED` 和适用时的部分 RawRef；stdio 测试断言取消请求在放锁后不再修改、后续请求可运行，不要求 MCP SDK 返回 `INTERRUPTED` payload。 | `tests/failure-protocol.test.mjs` 4/4 通过；覆盖跨进程串行和等待取消 |
| LK-02 | 主进程和 validator 整树退出后的恢复 | 当前 Windows 验收中 OS 释放 native lock；下一条新修改可运行，旧 running 验证不重放，原 `.running` 记录保留。 | `tests/failure-protocol.test.mjs` 4/4 通过；覆盖 Windows 上的整树退出和新修改恢复，Linux 与其他 Unix 未实测 |
| LK-03 | 主进程退出但 runner 仍存活 | 已有 owner 记录指向独立存活 runner 时，新 MCP server 继续等待；取消等待不修改，runner 退出后新修改可运行。 | `tests/failure-protocol.test.mjs` 4/4 通过；覆盖 owner 状态恢复及真实 MCP server 等待；Windows Job 行为会随 parent 结束 child，未声称复现“单杀主进程、留下其子 runner” |
| LK-04 | owner 损坏、启动停在 `starting` 或遗留旧 lock 目录 | 返回 `RECOVERY_REQUIRED`；不得自动删除 owner/旧 lock，需先确认相关进程退出再人工处理。其他 Unix 目录锁崩溃需人工恢复。 | `tests/workspace-lock.test.mjs` 5/5 通过；在 Windows 覆盖 dead idle、损坏 owner、未知 starting、legacy lock 和 operation error；Linux 与其他 Unix 未实测 |

## M-002 首片夹具

| ID | 场景 | 机械验证 |
| --- | --- | --- |
| CHANGE-01 | 登记与绑定 | tests/change.test.mjs：当前查询、归属、核验复用候选；真实 STDIO 越界/缺绑定拒绝、部分写入与旧版本拒绝；单一可写变更与并发串行 |
| CHANGE-02 | 失效、取消与恢复 | 全工作区输入变化、显式扩围、取消、真实 server/validator 整树退出与重启；不重放、保留真实修改 |
| CHANGE-03 | 发布与检查证据 | 坏指针拒绝、归档发布故障、生成排除、写前取消、原生 Codex patch 同租约只产生一次事件、失败回执及失效；始终 task_complete=false |

未验证 IF-004 完成收尾、变更状态职责注入或新的宿主 Hook 门禁。原生 patch 案例需配置已有 CODEX_SOL_PATCH_EXECUTABLE；其余夹具不需要模型调用。

CHANGE-01–03 本片完整检查 124/124、0 跳过，审计 0 漏洞；本机 Windows 原生 patch / 取消 / 整树退出实际运行。fixtures/architecture/change-index-evidence.json 保存当前 20 模块 / 41 能力 / 66 静态导入索引与实施边界。此处“未验证 IF-004 与 Context 注入”只描述首片交付当时的边界，后续证据见对应小节。

## IF-004 维护、复核与完成夹具（2026-10-04）

| ID | 场景 | 当前证据 |
| --- | --- | --- |
| CLOSE-01 | 前后架构事实、声明意图与维护建议 | tests/architecture-maintenance.test.mjs：14 项，删除/移动、旧/新使用方、未登记、未覆盖、UID 与声明/policy 改变 |
| CLOSE-02 | 逐规则来源、计划、复用与再验证 | tests/validation-reuse.test.mjs：19 个计数测试；默认 never、显式 watched_inputs、条件/输入/规则改变、完整性、legacy、去重与失败/取消 |
| CLOSE-03 | 当前版本语义复核及有效完成发布 | tests/closure.test.mjs：21 个计数测试；原文关联、完整 coverage、累计检查、零额外 runner、失败/中断/发布漂移、完成后失效、配置及 PATH 身份缺口 |
| CLOSE-04 | 真实协议与 IF-004 阶段索引 | STDIO 完整工具路径含分页 recall；四/六/十三工具兼容；[索引](closure/index-evidence.json) 为 20/44/66，无阻塞 |

完整检查 **180/180、0 跳过、审计 0 漏洞**；本机已有 CLI 原生 patch、Windows 受管写入取消与整树退出回归实际运行。输入 SHA、命令和日志摘要在 [检查记录](closure/check-evidence.json)，[详细边界](closure/README.md) 区分程序测试、模型使用与宿主注入。历史目录保留原结果；未新增付费模型回合或把旧 dirty 夹具改为 completed。

## 变更状态进入 Context（2026-10-04）

程序场景、Hook 参数和验收边界见 [context-state/README.md](context-state/README.md)。`sol_context_prepare` 可显式绑定当前变更，`change_state` 是共享协调器核验后的只读投影；会话恢复/提醒仅对应本会话明确绑定，不转绑，不新建状态归档或启动 runner。绑定 Hook 显式载入与 MCP 一致的验证规则及 generated 配置，并核验合成 SHA；无配置或不匹配时不可报告当前状态。

本 Context slice `npm run check` **199/199、0 跳过、依赖审计 0 漏洞**；59 个运行/检查输入前后 SHA 一致，见 [context-state/check-evidence.json](context-state/check-evidence.json)。当时索引 ready：20 模块 / 44 能力 / 70 静态导入，见 [context-state/index-evidence.json](context-state/index-evidence.json)。历史 IF-004 **180/180** 与 66 条索引保留于前一小节；后续 Host 事件和插件验收见下一节。

## 宿主门禁与本地插件（2026-10-04）

本轮实际宿主、package 和运行输入证据集中在 [Host 验收说明](host/README.md)：

- `host-evidence.json`：0.160 app-server 的 SessionStart 恢复、UserPromptSubmit 提醒及实际 compact；fresh PreToolUse 原生 `apply_patch` deny、MCP 越界拒绝和合法写+marker check；Stop false actionable block / true `{}`；independent reviewer complete 后 thread/resume 恢复当前 `task_complete=true`。TUI 0.158 初始 Hook 通过但同 session 两次 resume 以 `code=-32603` discovery timeout 失败并保留；随后已安装 bundled CLI 0.160 的同 session 真实 PTY resume、ready 状态、Hook 与正常 hash 校验通过，源码 SHA 不变。较早失败回合仍保留，模型不被描述为独立 reviewer。
- `package-evidence.json`：隔离 `CODEX_HOME` local marketplace read/install/restart 后四个 Hook 与十三个架构工具可用；最终隔离加载 passed，package 包含 1772 个文件。Hook 定义按本次调用精确 hash 审阅，没有使用 trust bypass。当前包使用嵌入 `src/plugin-bootstrap.cjs` 的 legacy MCP args、显式 `plugin_launcher`，不是公开发布或自动安装。
- `index-evidence.json`：最新索引 **ready 21/47/77**，3 条非阻塞 warning；CommonJS bootstrap 为 `non_javascript_source`，不声称静态分析得出不存在的 exports。
- `check-evidence.json`：标准 `npm run check` 在 Node **v24.11.0** / npm 元数据 **11.6.1** 下通过 **229/229、0 失败、0 跳过，npm audit 0 漏洞**；75 个运行/检查输入前后 SHA 一致。保留此前一次新 fixture argv 过长失败及修正记录，另一次默认 24 并行下 native timeout timing 失败；后一单测独立复跑通过，未修改 `core.killTree`。标准检查的 Node test concurrency 设为 4，全部断言和跨进程、取消、后代终止覆盖保留；这不代表高负载硬实时保证。

Host 边界见 [合同 §15](../contracts.md#15-宿主写门禁与本地插件接入)：Hook 只覆盖已注册并受信任的事件/匹配工具，不覆盖普通 Shell、Desktop GUI 或所有原生写路径。TUI 0.158 初始 `/hooks` 审阅、Context prepare、Stop `{}` 和源码 SHA 不变通过；同 session 两次 resume 因 account/read workspace discovery timeout（`code=-32603`）失败并保留。随后已安装 bundled CLI 0.160 的同 session真实 PTY resume 与四条 Hook 正常 hash 校验通过；Desktop GUI、稳定自主连续任务、固定 A/B token/费用和公开发布均未验收。
