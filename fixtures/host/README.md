# 宿主门禁与本地插件：当前进度

截至 2026-10-04，本轮接续 M-003，完成有限宿主门禁、本地插件装配和下面列出的真实验收。**SoL-Pi 整体仍未完成**：Desktop GUI、稳定自主连续任务以及固定 A/B token／费用对比仍待验收。本记录来自当前工作区、实际检查和宿主运行；引用聊天未能读取，不把它当作已核对的事实来源。

## 做到了什么

| 项目 | 当前结果 | 证据与边界 |
| --- | --- | --- |
| 既有架构与变更核心 | 已接通查询、职责材料、变更登记、显式绑定写入、真实检查、维护复核和完成证据 | [旧闭环阶段](../closure/README.md)与 [Context 状态阶段](../context-state/README.md)保留原始记录；不等于模型稳定自主完成任务 |
| Context 生命周期 | 0.160.0 真实宿主核心完成 prepare、过期提醒、同会话恢复及实际 compact 后恢复 | [host-evidence.json](host-evidence.json)；恢复不重放修改，提醒不写归档或指针 |
| 写入前门禁 | 真实原生 `apply_patch` 被拒绝并指引 MCP；受管越界写被拒绝；合法范围内写入及检查通过 | 项目显式开启架构模式后生效；只覆盖注册的匹配工具，不能代表全部 Shell／写入工具 |
| Stop 核对 | 可执行收尾缺项要求续跑一次；续跑标志阻止循环；有效完成后允许结束 | 模型只准备复核并报告未完成；父 agent 另行审阅实际合成材料、提交有效复核后才完成，不把这一分工写成模型自主语义复核 |
| 命令行交互恢复 | 已安装桌面捆绑 CLI 0.160.0 的真实 TUI 同会话 resume 通过，恢复引用与指针匹配，源码哈希不变 | 0.158.0 初始会话通过，但两次 resume 以 `code=-32603` account/read discovery timeout 失败；失败记录未覆盖 |
| 本地插件装配 | 新隔离 `CODEX_HOME` 中读取、安装、重启、启用后，4 项 Hook 与 13 个 MCP 工具连接通过 | [package-evidence.json](package-evidence.json)；按精确定义哈希审阅，无信任绕过；未修改用户全局配置 |
| 工程检查 | `npm run check` **229/229，0 失败、0 跳过，依赖审计 0 漏洞**；75 个运行／检查输入前后 SHA 一致；64 个源码／测试／夹具文件语法检查通过 | [check-evidence.json](check-evidence.json)；实际运行已有原生 patch 引擎；format／lint／typecheck／build 未配置 |
| 当前架构索引 | ready，21 模块、47 登记能力、77 静态导入；3 条非阻塞诊断 | [index-evidence.json](index-evidence.json)；CommonJS bootstrap 按 `non_javascript_source` 记录，不伪造导出 |

运行时使用现有变更、Context、执行器和归档；新插件入口统一 Hook／MCP 的实际执行环境，并可由项目 `execution_path` 明确稳定 PATH。环境指纹仍完整校验；更改真实条件后，旧完成证据会失效。需要额外环境变量的检查与其他平台尚未验收。

## 哪些还没做，接下来做什么

1. **完成 M-003 的 Desktop GUI 验收**：实际界面中的本地插件发现／启用、Hook 审阅、任务绑定、受管修改、停止／取消和重启恢复。现有 private app-server 与 TUI 记录不能代替这一项。
2. **验证稳定自主连续任务**：真实模型按职责完成复用已有能力、共享接口变更、中断继续等任务；记录复核者分工、失败与恢复。当前受控合成用例只证明列出的核心路径。
3. **执行 M-004 与原 T5 固定 A/B**：保存完整任务结果、全部模型回合、维护开销、耗时及可靠 token／费用数据；没有可靠 token 字段时仅报告可见字节，不宣称节省比例。

因此，本轮实现与已列验收可以交付，M-003 全宿主验收和整体效果验证仍未结束。未 commit、push、升级版本或公开发布。

## 本地交付

- [插件 ZIP](../../slop/host-m003/delivery/codex-sol-local.zip)：解压后包含 `codex-sol/`、`.agents/plugins/marketplace.json` 和逐文件 SHA 清单。ZIP 另行逐项校验，详见 [package-evidence.json](package-evidence.json)。
- [项目配置与加载说明](../../PLUGIN.md)：需要显式项目配置、安装后的真实 `plugin_launcher` 和正常 Hook 信任流程；本包不会自动安装到你的全局 Codex。
- 默认交付采用本机已验收的 Codex 兼容 manifest。仓库保留 portable manifest 源文件，但 portable 项目安装路径尚未验收。

## 保留的失败与限制

两次较早全套检查分别出现新夹具 argv 过长与旧 native 超时用例时序失败，原日志和哈希保存在检查证据中。前者改用短 SHA 校验并保留 runner 实际 PATH 的逐字断言；后者在独立单测通过后，将标准检查文件并发固定为 4，全部断言、跨进程、取消与后代终止覆盖保留，执行层 `killTree` 未改。**并发上限只是检查调度，不证明 Windows 高负载下的硬实时 deadline 保证。**

早期宿主尝试中的 compact 等待竞态、未触发原生门禁、无效 review、PATH／范围失败，以及 portable／legacy 装载失败均保留；通过记录属于随后独立的新用例。0.158.0 的两次 TUI 恢复失败和 0.160.0 的恢复通过分开记录。

一次 worker 定向测试误用 `npm exec -- node`，使 npm 将 `node@22.23.3` 下载到缓存；项目依赖与 Codex 安装未改变。最终完整检查使用已有 Node **v24.11.0** 与实测 npm **11.6.1**，没有使用该临时 Node。

这些证据在 Windows x64、当前已安装宿主版本下取得；本轮没有验证受限 sandbox／ask 审批、Desktop GUI 安装、其他平台或公开 marketplace 发布。

## 如何复跑

已有工程检查使用项目原有命令。让 `CODEX_SOL_PATCH_EXECUTABLE` 指向本机真正的 Codex `.exe` 后，在开发仓库运行 `npm run check`；本轮记录该变量只影响检查进程与子进程。历史 180/180 和 199/199 的证据不回写成当前 229/229。

下面的夹具在本仓库忽略的 `slop/host-m003/` 下新建合成项目，不用于迁移真实项目。生命周期／门禁会请求真实模型并产生相应使用量；插件装载夹具不请求模型、不复制凭据。

```powershell
node fixtures/host/run-host-hooks.mjs --codex "<已安装的 Codex.exe>"
node fixtures/host/run-host-hooks.mjs --gates --codex "<已安装的 Codex.exe>"
node fixtures/host/run-plugin-load.mjs --codex "<已安装的 Codex.exe>"
node scripts/package-plugin.mjs --out "<全新输出目录>"
```

门禁夹具把模型能完成的写入／检查与独立复核分开：先用 `resume-host-gates.mjs --run "<该次夹具目录>" --inspect` 审阅实际当前／修改前材料，确认后才在该合成用例中执行 `--review-approved --codex "<已安装的 Codex.exe>"`。审批参数不是自动语义验证。

TUI 使用 [run-tui-hooks.mjs](run-tui-hooks.mjs) 的 `--setup`、`--launch`、`--resume`，按其返回的目录在真实 PTY 中交互；本轮 `TERM=xterm-256color` 只作用于验收调用。具体版本、失败、事件、恢复引用及原始本地证据的哈希均列于 [host-evidence.json](host-evidence.json)。
