# Codex-SoL V0.1

为受管文件操作提供同步验证回执（Validation Receipt），并将大输出归档成可精确召回的 ObservationPack。项目参考 SoL-Pi commit `1559b5cb12c72da4a485bc50fe326586b216fb19`；[Notion 开工单](https://app.notion.com/p/3e831ddb72338111ada4dffbdd87713b) 最后编辑于 2026-09-27。接口和范围以本仓库合同为准。

## MCP 工具

| 工具 | 用途 |
| --- | --- |
| `sol_apply_changes` | 写入或删除多个工作区文件，按实际变化验证。 |
| `sol_apply_patch` | 使用 Codex 原生 patch 引擎应用 Begin Patch 格式并验证。 |
| `sol_read_file` | 归档读取结果；大输出返回有预算的打包结果。 |
| `sol_recall` | 按 handle 精确召回原文。 |

V0.1 覆盖以上 MCP 工具和按项目配置的 Windows Bash/Shell Hook。Hook 只包装已配置的 Bash/Shell；原生 `apply_patch`、`Edit`、`Write` 通过拒绝提示路由到显式 MCP 调用，不透明替换当前调用。未匹配的宿主工具、其他 MCP 工具及专业写入工具不受 Hook 覆盖。Architecture State / Normify、Reducer、compact、语义摘要、自动修复和后台验证不在本版范围内。

Windows V0.1 的显式 MCP 链路、项目 Hook 路由、验证回执与精确召回已实现。Desktop core 0.159.2 和 TUI 0.159.2 启用可选取消桥接后，分别通过 GUI Stop 与 Esc 中断：目标 `turn_aborted` 取消校验，后台进程和锁释放，部分输出保留。停止到响应分别约 0.7 秒和 0.57 秒；随后修改与旧输出/回执召回通过。完整检查为 81/81 测试通过，依赖审计 0 个漏洞。

历史无桥接取消失败和 CLI 单次 Hook trust bypass 记录继续保留；当前结果覆盖上述版本的 MCP 桥接与恢复，不覆盖原生 Shell Stop、受限 sandbox、ask 审批或 Linux。未修改全局配置、安装或升级组件，也未重启 Desktop。详见 [acceptance.md](acceptance.md)、[fixtures/manifest.md](fixtures/manifest.md) 和[取消桥接证据](fixtures/t3/cancellation-compat-evidence.json)。

## 接入 MCP

需要 Node.js 20.8 或更新版本。在本目录运行 `npm install`，将 [rules.example.json](rules.example.json) 复制到目标项目并按项目修改。规则命令是固定 `argv`，不由模型生成，也不经 shell。

在目标项目 `.codex/config.toml` 中新增 MCP server，保留已有配置；将尖括号值替换成真实绝对路径。`CODEX_SOL_PATCH_EXECUTABLE` 必须指向安装的 Codex 实际 `.exe`，不能指向 `.cmd` / `.bat` shim。

```toml
[mcp_servers.codex_sol]
command = "node"
args = ["<Codex-SoL 目录绝对路径>/src/server.mjs"]
env = { CODEX_SOL_WORKSPACE = "<目标项目绝对路径>", CODEX_SOL_RULES = "<目标项目规则文件绝对路径>", CODEX_SOL_PATCH_EXECUTABLE = "<Codex 实际 codex.exe 绝对路径>", CODEX_SOL_GENERATED_PATHS = '["**/__pycache__", "**/*.pyc"]' }
```

`CODEX_SOL_GENERATED_PATHS` 是可选 JSON 数组，用于排除测试生成物；其他语言请替换示例 glob。把目标项目的 `.codex/sol/` 加入 `.gitignore`。

可选的 MCP 宿主取消桥接需在上面的 inline `env` 表中增加 `CODEX_SOL_HOST_EXECUTABLE = "<已安装 Codex.exe 的绝对路径>"`；非法相对路径配置报告 `CONFIG_ERROR`。未设置时沿用 MCP SDK 原有取消行为。设置后仅 `sol_apply_changes`、`sol_apply_patch` 与 `sol_read_file` 使用只读 app-server 查询和对应 rollout 日志中的明确 `turn_aborted` 事件；不会根据其他进程看到的 unfinished-turn 状态推断取消，也不会伪造 `notifications/cancelled`。宿主 metadata、RPC、路径或日志无法核实会 fail closed，返回/记录 `HOST_STATE_ERROR`，不伪报通过、不自动重放。`sol_recall` 和原生 Shell Hook 不经过此桥接。该适配按 Windows CLI 0.159.2 / Desktop core 0.159.2 做过兼容验收，不代表稳定公开 API 或其他版本保证；完整边界见 [contracts.md](contracts.md#8-optional-mcp-host-cancellation-bridge)。

项目 Hooks 还需在同一 `.codex/config.toml` 启用：

```toml
[features]
hooks = true
```

保留文件中已有的 MCP 与 feature 配置；若已有 `[features]` 表，只需合并 `hooks = true`，不要重复定义该表。

## 接入 Windows 原生操作

将 [native.example.json](native.example.json) 复制为目标项目 `.codex/native.json`，再把所有示例路径改成实际绝对 Windows 路径。`node`、`shell` 分别指向实际 Node 与 PowerShell 可执行文件；`shell` 可为项目实际使用的 `powershell.exe` 或 `pwsh.exe`。

在目标项目 `.codex/hooks.json` 中合并以下事件配置，已有 Hook 项目必须保留。命令由 `node` 启动入口，并分别引用入口和配置路径：

```json
{
  "description": "Codex-SoL project hooks",
  "hooks": {
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "node \"C:/path/to/codex-sol/src/native-hook.mjs\" --config \"C:/path/to/project/.codex/native.json\"", "timeout": 30 }] }
    ],
    "PreToolUse": [
      { "matcher": "^(Bash|apply_patch|Edit|Write)$", "hooks": [{ "type": "command", "command": "node \"C:/path/to/codex-sol/src/native-hook.mjs\" --config \"C:/path/to/project/.codex/native.json\"", "timeout": 30 }] }
    ],
    "PostToolUse": [
      { "matcher": "^Bash$", "hooks": [{ "type": "command", "command": "node \"C:/path/to/codex-sol/src/native-hook.mjs\" --config \"C:/path/to/project/.codex/native.json\"", "timeout": 30 }] }
    ]
  }
}
```

命令开头的 `node` 必须能从 Codex Hook 环境的 `PATH` 找到；`native.json` 中的 `node` 则是 runner 使用的实际绝对 exe 路径。首次使用需信任目标项目的 `.codex/`，并审阅、信任当前精确 Hook 定义；修改后按新的 hash 重新审阅。CLI/TUI 在 `/hooks` 中审阅；Desktop 使用“设置 → 钩子”（Settings → Hooks）。Desktop 聊天输入框里的 `/hooks` 可显示“无命令”，应从设置页检查项目 Hooks。配置是项目级的，不会自动安装到全局，也不要常态绕过 Hook trust。参见[Codex Hooks 文档](https://learn.chatgpt.com/docs/hooks)。Hook 不是绝对安全边界：未信任项目、Hook 未获信任，或使用未匹配/专业工具时，操作可能不经过它。

Codex 按 Git 工作区根发现项目 Hook。把 `.codex/hooks.json` 放在实际 Git 根；若要在嵌套验收目录单独启用 Hook，该目录必须成为独立 Git 根（`git init` 即可，无需提交），否则应把 Hook 配置放在 Codex 实际识别的根目录。确认 `NativeConfig.workspace` 与 Hook 所属项目根一致。

Shell 命令仍由宿主 Shell 工具发起；Hook 在该命令中启动本地 runner，保留宿主选定的工作目录及其 sandbox/token 执行边界，并由配置指定 PowerShell 版本、profile 和超时。PreToolUse 返回 `permissionDecision=allow` 与 `updatedInput`，它有自己的审批语义，不保证保留普通 Shell 的逐命令 ask 提示。当前 CLI/TUI 运行使用 `-a never` 或 `danger-full-access`，受限 sandbox 与 ask 审批尚未验证。失败反馈不会撤销已执行的副作用。Linux 原生 Hook 接入按本轮范围暂缓，未实现或验收。

## 检查与详细合同

运行 `npm run check` 可执行项目完整检查。当前原生 Hook 与 CLI/Desktop 内异常验收状态见 [acceptance.md](acceptance.md) 和 [fixtures/manifest.md](fixtures/manifest.md)；Node 定向测试不能替代真实宿主 UI 验收。

- [contracts.md](contracts.md)：接口输入输出、失败语义和边界。
- [runtime.schema.json](runtime.schema.json)：内部 JSON Schema Draft 2020-12，不是 Codex Hook API schema。
- [acceptance.md](acceptance.md)：验收门槛与当前已验证范围。
