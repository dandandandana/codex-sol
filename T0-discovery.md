# T0 · 接入调查（CLI 探针与桌面版三工具冒烟已完成）

本页记录开工前已核实的事实。V0.1 的范围和验收以 [Notion 开工单](https://app.notion.com/p/3e831ddb72338111ada4dffbdd87713b) 为准。用户已决定同时覆盖 Windows 桌面版和本机 CLI；桌面版三个受管工具的独立真实冒烟已通过，Hook 旁路、宿主配置细节和其他异常行为仍按边界事项记录。

## 已核实

- 本机 `codex-cli 0.158.0`，`codex features list` 显示 `hooks` 已启用。Windows 桌面版与 CLI 共用同一 Codex host 的 MCP 配置，但需要各自验证工具可见性及调用结果；参见 [OpenAI Docs：MCP](https://learn.chatgpt.com/docs/extend/mcp)。
- [Codex Hooks 文档](https://learn.chatgpt.com/docs/hooks)列出 `PostToolUse` 对 Bash、`apply_patch`、MCP 和多数本地函数工具的覆盖。Bash 非零退出后也会触发。事件包括 `tool_use_id`、`tool_input`、`tool_response`，但没有承诺提供 `changed_paths`。
- 同一文档说明 `PostToolUse` 可用 `additionalContext` 给模型补充信息，也可用 `continue: false` 替换原工具的模型可见结果；这仍需在目标运行环境验证。文档同时说明部分专用工具可能绕过默认 Hook 路径，且多个匹配 Hook 会并行运行。
- `updatedMCPToolOutput` 和 `suppressOutput` 目前不受支持。因此 ObservationPack 的完整截获与归档仍按 Notion 契约放在受管工具的返回边界；不能把所有内置工具计入覆盖范围。
- [SoL-Pi 的 Action Fusion](https://github.com/NVlabs/SoL-Pi/blob/1559b5cb12c72da4a485bc50fe326586b216fb19/src/sol-pi/extensions/action-fusion/index.ts)通过重注册 Pi 的编辑/写入工具，在同一工具调用内执行模型提供的可选 `then_run`。Codex-SoL 的既定规则是由配置选择固定 `argv`，不接收模型生成的验证命令。

## 接入验收与余项

1. **已完成（桌面版冒烟）**：独立验证受管修改工具的可见性、实际变更与短回执进入下一轮；证据见下方桌面版记录和[桌面冒烟聊天](thread://01a0eda3-66f6-7ed3-a3c8-347304f257b0?hostId=local)。
2. **已完成（桌面版冒烟）**：对受包装文本工具制造大输出，保存原始字节、模型可见打包结果并精确召回锚点行；stdio MCP 集成测试仍作为内部行为证据。完整回执、句柄和哈希见下方桌面版记录。
3. **待补（宿主边界）**：检查 Hook 超时、脚本失败和其他 Hook 并存时的行为，并记录桌面版版本、信任状态、配置位置和 rollout 开关。

## CLI 真实探针（2026-09-29）

在忽略版本管理的 `slop/codex-sol-probe/` 独立 Git 工作区配置同步 `PreToolUse` / `PostToolUse` 命令 Hook。仅此隔离运行用 `--dangerously-bypass-hook-trust` 跳过交互式信任审查；未改用户级 Hook 配置。
已将不含本机路径与会话 ID 的关键结果保存为 [CLI 证据夹具](fixtures/t0/cli-evidence.json)；完整本机 rollout 仍在忽略版本管理的探针目录中，未作为可移植交付物。

- `apply_patch` 新建 `demo.txt`：前后 Hook 均触发，`tool_use_id` 相同；`PostToolUse` 有工具文本结果，无 `changed_paths`。Hook 输出的 `SOL_T0_RECEIPT_VISIBLE` 出现在下一次模型决策中。
- PowerShell 单命令写入 `demo-fail.txt` 后 `exit 7`：文件实际存在，`PostToolUse` 仍触发，但 `tool_response` 是空字符串。CLI rollout 记录退出码 7；下一轮模型同样收到了 Hook 标记。
- 一次尝试误用了 WindowsApps 的 `bash.exe`，进程创建失败，未产生文件；随后改用 PowerShell 完成上述失败后改动探针。这一失败不能作为修改事件证据。
- 两次有效探针均未获得 Hook 提供的实际改动路径。任意 Bash 命令也不能仅从命令文本可靠推断变更。故首版不由通用 Hook 生产 `ChangeEvent`。

## 当前结论

CLI Hook 证据已排除“通用 Hook 直接给出可靠 `changed_paths`”的假设。V0.1 采用一个受管修改工具 wrapper 作为唯一 `ChangeEvent` 生产者，修改返回前同步验证并携带短回执。Hook 可作为将来扩展的接入选项，但不参与首版事件生产。ObservationPack 只承诺覆盖显式接入的工具。

## CLI MCP 真实调用（2026-09-29）

在忽略版本管理的 `slop/codex-sol-e2e/` 目标项目中，CLI 0.158.0 通过项目 `.codex/config.toml` 发现 `codex_sol.sol_apply_changes`，实际写入 `hello.py`。首次 `py_compile` 产生未声明的 `__pycache__`，回执正确返回 `stale/input_changed`。配置生成物排除后再次修改，模型可见结果含 `passed/all_checks_passed`、一次执行和完整回执 handle。此证据确认 CLI 修改工具、同步验证和回执返回链路；桌面版三工具独立冒烟见下方记录。

## Codex Desktop 三工具冒烟（2026-09-29）

在[桌面冒烟聊天](thread://01a0eda3-66f6-7ed3-a3c8-347304f257b0?hostId=local)中，使用 `D:\zzd\slop\codex-sol-desktop-smoke\` 的项目 MCP 配置独立调用三个受管工具：

- `sol_apply_changes` 修改 `app.py`；`tool_status=ok`，`changed_paths=["app.py"]`，验证状态为 `passed/all_checks_passed`，执行 1 个检查，并返回 `evidence_handle=Fq0g98hi-AUSJdIqbVRLzrvp-QO8h4x9`。持久化回执中的 `python/unit-tests` 为 `passed/success`，`exit_code=0`。
- `sol_read_file` 读取 `trace.txt`，返回 `mode=packed`、`bytes=33779`、`omitted_bytes=30426`，RawRef handle 为 `MvNPhnatuVJJnsLcGpyUZQEKsb99zvmB`；SHA-256 `1623aa3d472d340a9097bcac7d95a83e37d4024e3a1379dc8167efce11288de7` 与本地文件一致。
- `sol_recall` 使用 `keyword=TRACE_ANCHOR=codex-sol-desktop-smoke`、`context_lines=0` 精确召回 `TRACE_ANCHOR=codex-sol-desktop-smoke|payload=exact-recall-check`；`truncated=false`，`next_cursor=null`。
- 独立 Python unittest 为 2 tests OK。测试目录位于忽略 Git 的 `slop/` 下；句柄和归档是本机证据，清理该目录后无法再次从本地归档召回。

这次实测确认桌面版三个显式接入工具的可见性、修改验证、打包读取和精确召回链路。普通 `apply_patch`、Shell、其他 MCP 工具的透明拦截，以及 Hook 失败/超时和全量异常用例仍不在本次冒烟覆盖内。
