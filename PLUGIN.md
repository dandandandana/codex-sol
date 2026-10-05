# Codex SoL 本地插件

此包将既有 SoL MCP 与四项 Hook 放在同一个入口，不会自动启用项目、信任 Hook 或宣布任务完成。需要已有 Node.js 20.8+ 和支持本地插件的 Codex。本地运行，不是公开发布包。

运行时支持 Windows 与 Linux；本轮 Linux 环境为 WSL2 Ubuntu 24.04 x64、Linux Node 24.11.0 和 Codex 0.160.0。必须在 Linux 内使用 Linux Node/npm/Codex。WSL 下建议把检查工作区放在 Linux 文件系统，避免 Windows 文件名和执行权限语义干扰验收。

## 从源码安装

在已取得仓库访问权限的环境克隆项目，进入目录后使用锁文件安装依赖，再生成一个全新的本地插件目录：

```sh
git clone --branch codex/linux-adaptation https://github.com/dandandandana/codex-sol.git
cd codex-sol
npm ci
node scripts/package-plugin.mjs --out ../codex-sol-local-new
codex plugin marketplace add ../codex-sol-local-new --json
codex plugin add codex-sol@sol-local --json
codex plugin list --marketplace sol-local --json
```

上述原生安装命令已在 Codex 0.160.0 验证；如当前 `codex` 没有 `plugin` 子命令，请检查所调用的实际客户端版本。输出目录存在时打包器拒绝覆盖，请选一个新目录。安装后重启客户端，再按下文为目标项目设置规则、入口和架构声明，并在正常界面中审阅 Hook。

上面的 `codex/linux-adaptation` 分支包含本轮 Windows 与 Linux 运行时适配；使用已有工作区时切换到该分支，再从 `npm ci` 开始即可。

源码仓库含开发用 portable manifest，本机已验收的兼容包会按版本要求整理入口；请安装生成的目录。项目回归命令为 `npm run check`，其中原生 patch 专项需要 `CODEX_SOL_PATCH_EXECUTABLE` 指向实际 Codex 可执行文件，未提供时该专项会明确跳过。

## 启用项目

在实际项目 Git 根创建 `.codex/sol-project.json`，参考包内 `sol-project.example.json`。无 Git 时配置必须位于启动目录；嵌套 Git 仓库不会继承外层项目配置。

默认 Codex 兼容包还需要 `plugin_launcher`：填入安装后实际 `src/plugin-launcher.mjs` 的绝对路径，可从已加载 Hook 的命令查看这一位置。升级或迁移安装位置后同步这个字段。它只决定启动文件位置，项目目录仍由宿主提供；不会从其他聊天、全局缓存或“最近项目”猜测。Hook 与 MCP 会核对这个字段指向各自正在运行的同一文件。

`validation_rules` 指向你的真实检查规则，`context_rules` 可选，指向职责配置。包内 Python 检查示例只能作为格式参考，请改为本项目实际命令、文件范围和超时。需要可复用完成证据时，检查命令首项必须使用真实可执行文件的绝对路径。`generated_paths` 只排除真正生成的内容，不用它隐藏源码或失败检查。

需要架构与变更闭环时，在职责配置增加 `architecture: { "path": "architecture.json" }`，提供本项目真实声明。只有这一模式启用写入门禁与 Stop 核对；仅配置检查规则时保持原四工具。可选 `patch_executable` 指向已安装 Codex 可执行文件，`host_executable` 用于既有宿主取消桥接；不要把秘密放入配置。

Linux 的 `patch_executable` 必须指向实际 ELF 程序，不能填 npm 的 JS 启动入口。`patch_executable` / `host_executable` 可通过符号链接解析到普通文件，并须具备当前用户的执行权限；入口 `plugin_launcher` 继续要求精确普通文件身份。检查缓存也核验检查程序的执行权限：撤销权限会使相关旧结果失效，保留历史回执且不自动运行。Linux 的宿主取消桥接尚未做真实 UI 验收，先省略 `host_executable`。

普通 Bash 操作的包装是可选独立配置。参考包内 `native.linux.example.json`，填入项目、规则、Linux Node 和 Bash 的绝对路径；不会随插件安装自动启用。合并项目 Hook 时只增加 `^Bash$` 的 PreToolUse/PostToolUse，让它们调用 `node '/absolute/path/to/src/native-hook.mjs' --config '/absolute/path/to/project/.codex/native.json'`，并保留插件四项定义。`load_profile=false` 使用 `--noprofile --norc -c`；`true` 使用 `--login -c`，继承的 `BASH_ENV` 仍遵循 Bash 行为。

## 加载和信任

打包目录包含 `codex-sol/` 与 `.agents/plugins/marketplace.json`。将它作为本地 marketplace 交给支持该入口的客户端。插件标识为 `codex-sol@sol-local`，项目配置可用 `[plugins."codex-sol@sol-local"] enabled = true`。避免同时启用旧手工 MCP/Hook 和本插件，否则会产生重复调用。

CLI/TUI 用 `/hooks`、桌面用钩子设置审阅当前四项定义后再信任。安装或启用不等于信任。正常信任流程需要当前定义哈希，不长期绕过信任。

打包器默认生成 Codex 兼容格式：`.codex-plugin/plugin.json` 与 `.mcp.json`。本机 0.160.0 的 portable loader 会跳过 Hook，已通过实际装载和对应版本源码确认；因此默认包省略根 portable manifest。开发仓库保留 portable 源清单，可用 `--format portable` 输出，当前不把这一格式的 Hook 当作已验证。不要直接把开发仓库根目录当作本机已验收插件。

同一版本的 legacy MCP 也不会展开参数中的 `${PLUGIN_ROOT}`，所以兼容包嵌入固定的标准库启动程序，从上述显式项目配置读取入口，保留宿主项目 cwd。未配置时启动会明确失败；不改全局设置，不自动写入项目配置。portable MCP 的工作目录行为也尚未按此项目入口验收。

格式与兼容行为分别见 [官方插件文档](https://developers.openai.com/plugins/build/plugins)、[0.160.0 的 Hook 加载源码](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/core-plugins/src/loader.rs)及 [legacy MCP 参数处理源码](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/codex-mcp/src/plugin_config.rs)。

## 运行边界

SessionStart 恢复显式绑定的职责；UserPromptSubmit 只在材料过期或阻塞时提醒。架构模式的 PreToolUse 检查 `sol_apply_changes` / `sol_apply_patch` 的当前聊天绑定、版本和完整范围；原生 patch 指引改用 MCP。其他写入工具及 Shell 不在这项门禁覆盖内，后端 MCP 仍重复执行自己的真实校验。

Stop 只检查本聊天已登记变更。可执行的缺项最多要求续跑一次；已有阻塞、等待输入、中断或缺失续跑标志时允许结束并保留未完成状态。只有当前完成证据有效才算完成，单次检查 passed 或产物 accepted 不够。

两种插件入口在执行核心前使用相同的最小 OS 环境重新启动 Node，以便独立 Hook 能核验 MCP 的实际检查条件。Windows 保留标准用户目录、系统目录、PATH、Shell 与临时目录变量；其他平台保留 HOME、LOGNAME、PATH、SHELL、USER。不会继承任意密钥、代理变量、插件目录变量或聊天标识。依赖额外环境变量的检查尚不支持此插件入口，应先明确配置方案；旧手工入口保持原行为。完整执行环境的指纹校验仍保留。

可在项目配置设置 `execution_path`，明确检查所用的稳定 PATH。Codex 会给继承的 PATH 添加随启动变化的临时工具目录；未设置此项时保留继承 PATH，重启后旧完成证据可能因此过期。设置后，两个入口和实际检查子进程都使用该值，环境指纹仍覆盖完整实际环境；修改它也会使旧证据失效。只填写真实检查需要的可执行目录，不填写密钥。

插件的运行记录保存在项目 `.codex/sol/`，源码通过显式受管写入修改。打包器只复制运行时、已有依赖和说明，不复制项目记录、`.env`、聊天日志或 Git 历史。取消沿用现有执行层，不自动重放。桌面界面、TUI 按键和不同平台验收需要单独记录，不能用核心测试替代。

Linux 已实测隔离 CODEX_HOME 的本地包安装、重启后四项 Hook 和十三工具装载；未复制登录凭据或请求模型。真实 Bash runner 已验证非零退出反馈、超时/SIGTERM、后代终止、重复事件和后续恢复。Linux TUI 的正常交互审阅、Esc 和受限 sandbox／ask 尚未验收。

构建包：在开发仓库运行 `node scripts/package-plugin.mjs --out <全新目录>`。目标已存在时会拒绝覆盖；目录中的 `package-inventory.json` 提供实际文件 SHA-256 清单。
