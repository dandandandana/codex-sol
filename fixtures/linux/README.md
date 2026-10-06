# Linux CLI 使用与验收

2026-10-05 首轮目标为普通 Linux 终端的 Codex CLI/TUI。当前完成 Linux 运行时适配、真实 Bash/原生 patch 回归，以及 Codex app-server 的插件安装和重启装载。交互 TUI 的 Hook 审阅和 Esc、Linux 宿主取消桥接、受限 sandbox／ask、Desktop GUI 与模型自主任务仍需独立验收。

## 本机环境

| 项目 | 本轮实际环境 |
| --- | --- |
| Linux | WSL2 Ubuntu 24.04 x64，Linux 6.18.33.2 |
| 工作区 | Linux 用户目录内独立 checkout，分支 `codex/linux-adaptation` |
| Node / npm | Linux Node v24.11.0 / npm 11.6.1 |
| Shell | GNU Bash 5.2.21 |
| 原生 Codex | Linux x64 ELF，codex-cli 0.160.0 |

验收用 Linux Node/Codex 工具链安装在用户目录，未修改 shell profile，也未覆盖已有命令。Node 24 官方归档 SHA-256 核验通过。源码和安装依赖均在 Linux 文件系统中运行；WSL 的 Windows PATH 不能替代 Linux Node。无需另装虚拟机即可完成本轮基础验证；独立普通 Linux 主机或 CI 仍可作为后续环境验证。

默认 Bash 登录终端另识别到 Linux Node v22.23.1、npm 12.0.2、Codex 0.160.0；未用验收 PATH 覆盖时，Bash/路径/权限/检查复用等 **34/34 专项通过**，最终真实插件装载也在该默认终端执行。完整回归使用上表固定 Node 24 工具链，两者不混记为同一环境。

## 接入项目

先在 Linux 终端确认 `node --version`、`npm --version`、`codex --version`，以及 `node -p "process.platform"` 输出 `linux`。项目要求 Node 20.8+。从 `codex/linux-adaptation` 分支取得源码后运行 `npm ci`，再按 [插件说明](../../PLUGIN.md) 生成新包并接入目标项目；已有该分支工作区无需重新克隆。

`patch_executable` / `CODEX_SOL_PATCH_EXECUTABLE` 要填真实 Codex ELF 文件的绝对路径。npm 的 `codex` 命令通常是 JS 启动入口，适合普通启动，不能作为 native patch 引擎。0.160.0 npm 包的本轮实际程序位于 `@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex`；其他架构或版本以实际安装文件为准。可用 `file <实际路径>` 和 `test -x <实际路径>` 确认类型及执行权限。Linux 可执行文件的符号链接会解析到实际文件；项目 launcher 仍核验精确入口身份。

检查规则使用本项目实际命令、输入范围、超时和生成目录。可复用完成证据要求 `argv[0]` 为能核验的绝对执行路径；撤销检查程序的执行权限会让相应缓存失效，不改写旧回执，不自动重跑。

## Linux 工作区锁

受限 Linux 运行环境可能禁止 Unix socket，却允许普通文件和本地进程。Linux 锁现使用 util-linux 的 `flock` 描述符形式，明确调用 `/usr/bin/flock` 或 `/bin/flock`，不依赖项目的 `execution_path`，不启动 shell、不监听 socket，也不改变沙箱权限。缺少工具、工具失败、不支持锁的文件系统或异常锁路径都会在修改前返回 `LOCK_ERROR`；不会切换到另一种可能不互斥的后端。

Node 持有 `.codex/sol/managed-modification.flock` 的文件描述符，短暂的 `flock` 子进程与它共享 open-file description。子进程退出后锁继续有效，Node 关闭描述符或崩溃后由内核释放；文件本身永久保留。任何实例都不得删除、轮换或替换该文件，否则已有等待者可能锁住旧 inode 而新实例锁住另一个 inode。符号链接、硬链接、目录和特殊文件会被拒绝，获取期间的路径替换也会被检测。

所有实例必须使用相同的新锁协议及同一个本地工作区；升级前先停掉全部旧版 SoL MCP、Hook runner 和检查子进程。旧 socket 版不认识新文件锁，不支持新旧混跑。旧 `managed-modification.lock` 目录仍会触发 `RECOVERY_REQUIRED`，不自动删除。不要把停止一个进程等同于停止它的所有检查子进程。

独立 owner JSON 继续记录进程和检查状态：存活 owner 或 validator 会阻止新写入；死亡 owner 的 idle 状态可在拿到内核锁后恢复；未知的 `starting` 状态和损坏元数据必须人工检查。取消等待不会杀死持有者或重放旧检查，失败回执和观察记录仍保留。

实现依据：[flock(1) 描述符形式](https://man7.org/linux/man-pages/man1/flock.1.html)和 [flock(2) 生命周期](https://man7.org/linux/man-pages/man2/flock.2.html)。本方案面向单机本地文件系统，未验收 NFS/CIFS、不同 PID 命名空间共享目录或分布式工作区。Windows named pipe 路径未改变；其他 Unix 保留既有保守目录锁，崩溃后仍需人工恢复，不能据此声称已新增平台支持。

专项回归：`node --test tests/workspace-lock.test.mjs tests/linux-workspace-lock.test.mjs`，涵盖真实多进程竞争、SIGKILL、存活检查保护、未知启动、取消、异常文件与工具故障。真实宿主 Hook 信任、TUI Stop/Esc 和 Windows 新版本运行仍需各自验收；下方原始 WSL/Windows 验收表是历史结果，不是对本次修订的跨平台运行声明。

## 可选 Bash 包装

插件默认四个 Hook 覆盖 Context、写入门禁和 Stop；包装普通 Bash 是额外可选能力。将 [native.linux.example.json](../../native.linux.example.json) 复制为目标项目 `.codex/native.json`，把路径替换为本机真实项目、规则、Linux Node 和 Bash 路径。原 schema_version=1 保持兼容。

在实际 Git 根的 `.codex/hooks.json` 合并以下两项，保留已有事件数组和插件定义。若已经配置旧 native Hook，应更新已有定义，避免重复包装。

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "^Bash$", "hooks": [{ "type": "command", "command": "node '/absolute/path/to/codex-sol/src/native-hook.mjs' --config '/absolute/path/to/project/.codex/native.json'", "timeout": 30 }] }
    ],
    "PostToolUse": [
      { "matcher": "^Bash$", "hooks": [{ "type": "command", "command": "node '/absolute/path/to/codex-sol/src/native-hook.mjs' --config '/absolute/path/to/project/.codex/native.json'", "timeout": 30 }] }
    ]
  }
}
```

项目 `.codex/config.toml` 的已有 `[features]` 表需合并 `hooks = true`。从 CLI/TUI `/hooks` 审阅当前精确定义，再信任；修改定义后重新审阅。包装不会自动安装、信任或改全局配置。Hook 命令开头的 `node` 必须在宿主 Linux PATH 中，native.json 内的 Node 则使用绝对路径。

Linux `load_profile=false` 使用 `bash --noprofile --norc -c`，`true` 使用 `bash --login -c`。非交互 Bash 仍遵循继承的 `BASH_ENV`。执行保留宿主选定的工作目录，要求它位于配置 workspace 内；原命令保存在私有请求文件，启动路径使用 POSIX 引号转义。重复请求不重放；错误、超时或取消保留实际副作用和已收到的部分输出。

## 复跑与证据

在源码根的 Linux 终端中，将下面路径替换为实际 ELF 文件：

```sh
export CODEX_SOL_PATCH_EXECUTABLE=/absolute/path/to/native/codex
npm run check
node fixtures/host/run-plugin-load.mjs --codex "$CODEX_SOL_PATCH_EXECUTABLE"
```

第一条检查运行全部既有测试和 npm 依赖审计；缺少原生 Codex 时相关专项会明确跳过。本轮提供了实际程序，Linux 仅跳过 Windows 大小写别名专项。新增测试覆盖路径、Bash 登录 profile、执行权限、工作目录、后代终止和取消恢复；原生 Hook 的既有失败反馈/去重测试也在 Linux 实际执行。

第二条复用既有宿主夹具，在新的隔离 CODEX_HOME 中生成包、安装、重启，以本次调用审阅的精确 Hook hash 检查四项 Hook 和十三工具。它不复制登录凭据，不调用模型，不改用户插件设置；不能代替正常交互界面的信任、模型 Shell 调用或 Esc 验收。

最终两平台结果、输入 SHA 和日志 SHA 见 [check-evidence.json](check-evidence.json)，Linux 真实加载记录见 [host-evidence.json](host-evidence.json)，当前架构索引见 [index-evidence.json](index-evidence.json)。历史 Windows Host、取消和 benchmark 证据保留原记录。

| 检查 | 本轮最终结果 |
| --- | --- |
| Linux `npm run check` | 249 项：248 通过、0 失败、1 项 Windows 专项跳过；审计 0 漏洞 |
| Windows `npm run check` | 249 项：240 通过、0 失败、9 项 Linux 专项跳过；审计 0 漏洞 |
| 运行与检查输入 | 77 个输入在各平台检查前后不变，两个平台使用相同字节 |
| 语法与 diff | 14 个变更 JS 文件语法通过；`git diff --check` 通过；lint/format/typecheck 未配置 |
| 真实 Linux 插件包 | 1773 个文件；安装/重启后四个 Hook、十三工具连接成功；未调用模型 |
| 当前架构 | ready，21 模块 / 48 能力 / 77 静态导入，3 条既有非阻塞诊断 |

两次 Linux 全量失败日志保留在检查证据中：字节改变夹具意外移除了执行权限；取消夹具的固定计时在检查启动前触发。前者保留执行权限来隔离内容改变，后者等待真实输出后再取消；原断言均保留，权限撤销仍由独立测试覆盖。未调整执行层超时或终止实现来规避失败。

本机 WSL 默认 DNS 请求曾失败，Linux 基线测试已通过，但审计报 EAI_AGAIN。最终审计使用私有挂载命名空间内、由 Windows 当次 DNS 查询得到的临时 registry 域名映射；检查仍以普通 Linux 用户执行，TLS 和审计要求未关闭，系统网络配置未改变。普通 Linux 环境仍需能访问官方 npm registry。
