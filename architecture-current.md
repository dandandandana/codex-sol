# 当前架构与测试边界

更新日期：2026-10-05。本文描述当前已存在的实现；设计与后续接口合同仍以 [architecture.md](architecture.md) 和 [contracts.md](contracts.md) 为准。

## 原始目标与当前状态

目标是让 LLM 编码时发现并复用已有组件，在修改后延续模块职责、公共契约和架构树，使下一次任务能够使用这些能力。

| 原始目标 | 当前实现 | 尚未交付 |
| --- | --- | --- |
| 编码时优先复用 | 可查询已登记能力、真实导出位置和直接使用方；登记时保存候选引用与复用理由；一个指导下普通需求已实际复用组件并通过验收 | 稳定自主发现效果与固定任务对照证据 |
| 修改后延续架构 | 前后事实比较生成维护建议；绑定写入声明后按当前版本复核；有效复核与累计检查可由明确分工的独立 reviewer 提交并发布，随后 Context/Hook 只读恢复能检出当前 completed | 模型稳定自主维护的效果证据；本轮复核明确由人分工，不代表模型独立语义闭环 |
| 后续任务沿用架构 | 程序与真实 STDIO 已接通修改、维护、复核、累计检查、完成及后续查询；变更状态已进入 Context；PreToolUse/Stop 已接入并做限定宿主验收；本地插件已打包、隔离安装并验收 Hook/MCP 加载 | Desktop GUI 本轮未验收；同 session 的 TUI 0.158 resume 两次因宿主 discovery timeout 失败，但已安装 bundled CLI 0.160 的真实 PTY resume 和 hooks 通过；稳定自主连续任务与固定 A/B token/费用效果 |
| Linux 终端适配 | Linux Bash wrapper、平台路径约束、执行权限及缓存失效已接入；在 WSL2 Linux 文件系统运行真实 patch/Bash 与 Codex app-server 插件装载 | 独立普通 Linux 主机、Linux TUI 的交互信任/Esc、Linux 宿主取消桥接及受限 sandbox／ask 尚未验收 |

IF-004 交付阶段（2026-10-04）的完整检查为 **180/180、0 跳过、审计 0 漏洞**，原生 Codex patch 实际运行，见 [闭环验收](fixtures/closure/README.md)；其 66 条静态导入是该阶段历史索引。此前既有能力检查 **126/126**，指导下的独立分类需求项目检查 **27/27**、黑盒验收 **20/20**，历史保存在 [前阶段验收](fixtures/current-stage/README.md)。

## 职责树与真实代码位置

```text
Codex-SoL：本地 Node.js 服务与宿主适配
├─ 宿主入口
│  ├─ MCP：src/server.mjs
│  ├─ 生命周期 Hook：src/context-hook.mjs
│  ├─ 本地插件 launcher/bootstrap：src/plugin-launcher.mjs、src/plugin-bootstrap.cjs
│  └─ 原生 Shell Hook：src/native-hook.mjs
├─ 工程核心
│  ├─ 架构声明与代码事实：src/architecture/index.mjs
│  │  ├─ Normify engine：vendor/normify/engine/
│  │  └─ Acorn：JavaScript ESM 静态导入/导出
│  ├─ 职责 Context：src/architecture/context.mjs
│  ├─ 会话绑定与恢复：src/architecture/session.mjs
│  └─ 变更、维护复核与完成协调：src/architecture/change.mjs
└─ SoL 基础能力
   ├─ 修改与执行：src/patch.mjs、src/managed-command.mjs、src/process.mjs
   ├─ 验证计划、执行、来源与有效性：src/validation.mjs
   ├─ 证据与召回：src/store.mjs、src/pack.mjs、src/read.mjs、src/recall.mjs
   └─ 边界：src/workspace.mjs、src/workspace-lock.mjs、src/host-cancellation.mjs、src/schema.mjs
```

这是职责分组，不是已拆出的多服务或新增目录。模块包含关系用树表示，跨模块依赖用有向图表示，能力与反向使用方是派生索引。声明中的稳定 UID 表示身份；文件名、模块名和路径不是身份。

## MCP、Hook、Skill 与 LLM 的边界

| 部分 | 当前责任与状态 |
| --- | --- |
| MCP | 本地 STDIO 调用入口。默认四工具；纯 Context 六工具；架构十三工具，两个写入工具要求变更绑定，新增 review/complete |
| Hook | SessionStart 恢复/入口、UserPromptSubmit 状态提醒、架构模式 PreToolUse 写门禁与 Stop 收尾核验均已接入。PreToolUse 只覆盖已匹配的 MCP 受管写及原生 patch/edit/write 路由；Shell/reads 不由这条门禁覆盖 |
| Skill | 尚未新增项目专用 Skill。后续可提供语义工作方法，不能作为状态、Schema、鉴权或证据的另一事实来源 |
| LLM | 理解需求、选择复用候选、维护声明，逐模块核对公共契约、兼容性、验收及未覆盖关系。程序核验引用、结构、版本、累计检查与发布条件；复核方式仅记录模型报告，不称独立审计 |

本地插件包已通过隔离 CODEX_HOME 的 marketplace read/install/restart 验收，重启后检查到四个 Hook 与十三个架构工具。它不是公开发布或自动安装；Hook 不覆盖任意原生修改工具。Hook 共享核心和存储，MCP 不为各职责分别部署服务。Context 在同一聊天中提供选定材料，不隔离或清除聊天历史。

## 已实现的运行路径

1. 通过 `sol_architecture_query` 查询已登记模块的归属、能力、反向静态导入与诊断。
2. `sol_context_prepare` 按职责配置选择文档、目标文件和可选上游产物；可选传当前 `change:{id,version}`，同一只读变更投影进入工具包；`targets` 只选读取材料，不扩写入范围。`sol_context_submit` 校验绑定与产物并归档写前交接，下游只接收指定字段。
3. `sol_change_open` 保存需求来源、任务身份、文件/模块范围、验收和复用选择；已有文件须匹配归属，新文件显式指派已有模块，但不会自动加入架构声明。
4. `sol_apply_patch` / `sol_apply_changes` 使用当前 `change:{id,version}`，在同一工作区租约中检查范围、执行修改与 SoL 验证，保存实际变化和原回执。
5. `sol_change_status` 核对非生成输入快照。旧证据失效；范围外变化阻塞写入。取消或遗留 pending 为 interrupted，需显式 resume；abandon 保留文件与历史。
6. `sol_change_review` prepare 保存当前需求/验收版本、初始与当前源码、维护建议、累计影响和逐规则计划。LLM 读取来源，维护声明后重新 prepare；submit 须覆盖全部 affected UID、验收索引和 uncovered 索引。未解决项阻止完成。
7. `sol_change_complete` 使用当前复核与绑定，先发布 checking/pending。核验允许复用的历史规则，只补跑缺失/过期部分；归档完整证据并在最终 rename 前再次核验输入，成功才 completed。补跑不创建假 ChangeEvent。
8. status 对完成引用、归档、输入和逐规则运行条件再次核验，不启动 runner。后续变化使当前完成失效但保留历史；后续任务从维护后的声明查询能力。
9. 绑定 Context 使用 `ChangeCoordinator.inspectLocked` 投影当前状态。漂移和遗留操作保持实际持久绑定并提示先 status 刷新；SessionStart 恢复可沿用 prepare 归档新 Context 并以 `expectedHandle` 更新本会话指针。UserPromptSubmit 只读提醒不新增归档或改会话/变更指针；两者都不启动 runner、不改活动变更指针。未绑定的 Context 不读取其他任务。
10. 架构模式 PreToolUse 对 MCP 受管写入核对当前会话绑定、task identity、change ID/version 与全部目标路径（patch move 包括两端）；协调器在实际运行时再次 guard。匹配到的原生 `apply_patch` / `Edit` / `Write` 被拒并指向 MCP；普通 reads 与 Shell 不由本门禁覆盖。
11. Stop 对有效 `stop_hook_active:true` 静默放行；`false` 且存在一个可执行的收尾动作时 block 一次。blocked/等待/interrupted/abandoned/宿主 flag 缺失保留 unfinished 并可结束；只有累计证据仍当前有效的 completed 能报告完成。插件 bootstrap 从项目显式 opt-in 中定位相同 launcher，包只含白名单文件。

只有有效完成证据成功发布才 `task_complete=true`。Context accepted、查询 ready、指纹刷新或单次检查 passed 均不代表任务完成。

设计选择性参考原始论文与课程/指南，见 [调研](closure-research.md) 和 [已实现合同 §5.1–5.4](architecture.md#51-架构维护与语义复核)。复用现有索引、验证器、存储和工作区租约，没有新状态服务或依赖。

## 数据、覆盖与限制

- 架构声明与 policy 来自工作区配置指定的文件；`architecture.example.json` 是本项目示例，不应复制成别的项目的实际架构。当前 Linux 适配阶段索引为 **ready：21 模块 / 48 能力 / 77 静态导入**，见 [当前索引](fixtures/linux/index-evidence.json)；新增能力仅为现有工作区模块的公共路径校验，未新增职责模块。2026-10-04 Host 的 **21/47/77** 与 Context 的 **20/44/70** 分别保留在 [Host 索引](fixtures/host/index-evidence.json) 和 [Context 索引](fixtures/context-state/index-evidence.json)。3 条非阻塞诊断仍为 layout/missing、root-no-source 与 launcher leaf-too-coarse；CommonJS bootstrap 记录为 `non_javascript_source`，不伪造静态导出。IF-004 的 **20/44/66** 仍是历史数据，见 [闭环索引](fixtures/closure/index-evidence.json)。
- Host 插件只接受显式项目 `.codex/sol-project.json`；Git 项目用最近的真实根，无 Git 时只看精确 cwd。Hook/MCP launcher realpath 必须匹配。运行入口用相同的最小 OS 环境重启；`execution_path` 可固定 runtime/检查 PATH，未配置时继承路径变化会反映在 freshness。完整配置和打包边界见 [合同 §15](contracts.md#15-宿主写门禁与本地插件接入)。
- 查询按已声明 source 收集事实；收尾额外核对累计未登记 JS 源码，不是扫描全部仓库的发现平台，也不是完整调用图。动态导入、间接调用、外部依赖及其他语言列未覆盖。Normify revision 仅作声明元数据。
- Context 职责契约由配置指定；来源与产物使用现有不可变 ObservationStore。完整包上限 4096 UTF-8 字节，省略内容通过 recall 获取。
- 变更历史沿用不可变归档，当前指针在 `.codex/sol/architecture/active-change.json`。归档先成功，再原子发布指针；恢复不自动重放写入。
- 当前一个工作区一条可写变更，范围按完整文件。输入快照沿用 generated 排除配置；元数据上限 128 KiB，超限明确失败。首片不支持多个模块分段共享文件的写入范围。
- Rule.reuse 默认 never；只有项目确认重要输入覆盖充分且无未跟踪外部条件时才允许 watched_inputs。完成的 freshness 核验与缓存复用许可分开。PATH/相对命令可执行但不能核验完成，检查 argv[0] 需实际绝对执行路径；规则文件改动需重启服务、显式调整及重新复核。
- 旧变更缺初始事实时不能补造历史完成。既有费用夹具的历史 dirty 记录保持原样，本轮未迁移或伪造完成。
- 变更状态职责 Context 注入已按 [设计 §4.13](architecture.md#413-变更状态的职责注入合同已实现) 与 [合同 §14](contracts.md#14-变更状态进入-context) 接入；程序场景和该阶段边界见 [Context 状态验收](fixtures/context-state/README.md)。后续宿主门禁和本地插件装配见 [设计 §4.14](architecture.md#414-宿主写门禁与本地插件装配)、[合同 §15](contracts.md#15-宿主写门禁与本地插件接入) 与 [Host 验收](fixtures/host/README.md)。
- 宿主门禁和插件装配现由 [设计 §4.14](architecture.md#414-宿主写门禁与本地插件装配)、[合同 §15](contracts.md#15-宿主写门禁与本地插件接入) 与 [Host 验收](fixtures/host/README.md)记录。实际 0.160 app-server 恢复/提醒/compact、MCP 越界拒绝与合法写+检查、Stop flag 路径和隔离插件读取/安装均有证据；同 session 的 0.158 TUI resume 两次以 `code=-32603` account/read workspace discovery timeout 失败并保留；随后已安装的 bundled CLI 0.160 通过真实 PTY resume 与四条精确 Hook hash 检查。Desktop GUI 与模型自主效果仍未验证。

## 验证记录与下一步

此前按用户要求先保存架构文档、检查现有实现，再用独立普通需求验证组件复用；记录保存在 fixtures/current-stage/。本轮延续三个直接 `gpt-6.1-sol` / high 子代理的分工，禁止孙代理，分别负责验证器、索引维护和只读复核；父代理负责协调器、MCP 接入及集成。

变更状态 Context 阶段 `npm run check` **199/199、0 跳过、依赖审计 0 漏洞**；59 个运行/检查输入前后 SHA 一致，见 [该阶段检查记录](fixtures/context-state/check-evidence.json)。当时索引为 **20/44/70**，见 [Context 索引证据](fixtures/context-state/index-evidence.json)。后续 Host/package 阶段索引 **21/47/77** 见 [Host 验收](fixtures/host/README.md) 及其检查/索引证据；各阶段结果保持独立。

本轮标准 `npm run check` 使用 Node test concurrency 上限 4，并已在 Node **v24.11.0** / npm 元数据 **11.6.1** 下通过 **229/229、0 失败、0 跳过，npm audit 0 漏洞**；75 个运行/检查输入前后 SHA 一致，见 [Host 检查证据](fixtures/host/check-evidence.json)。此前一次完整运行因新夹具长 argv 失败，修正夹具参数后，另一次运行在默认 24 并行时出现 native timeout timing 失败；该单测独立复跑通过，未修改 `core.killTree`，也未削弱原断言。并发上限 4 保留跨进程、取消与后代终止覆盖，只调整检查调度；这不是 Windows 高负载下硬实时 deadline 的保证。

最新 Host 实测在 0.160 private app-server 中通过：原生 apply_patch 被门禁拒绝，MCP 越界写返回 `CHANGE_OUTSIDE_SCOPE`，合法受管写与真实 marker check 通过；Stop false 对 actionable closeout block 一次，true 返回 `{}`。模型只 prepare review 并报告 unfinished；独立 reviewer 提交合法 refs 并 complete 后，新的 thread/resume SessionStart 返回 `task_complete=true`、`completion.current` 与确切 handle，随后 Stop false 返回 `{}`，文件源未再变化。此证据显示程序与明确分工能完成受控闭环，不表示模型自主选择了所有步骤。

TUI 0.158 初始 `/hooks` 审阅、`sol_context_prepare`、Stop `{}` 和源码 SHA 不变已通过；同 session 的两次 0.158 resume 均因 account/read workspace discovery timeout（`code=-32603`）失败并保留。随后使用已安装、未升级或另行安装的 bundled CLI 0.160，在同 session 的真实 PTY resume 通过：SessionStart `source=resume` 返回 `context_restore=ready`，`tui-readonly` / `plan` 的 `context_handle` 与 session pointer 精确一致；UserPromptSubmit 和 Stop 均实际执行并返回 `{}`，源码 SHA 未变，四条 `hooks/list` 定义均与正常审阅 hash 匹配且没有 bypass。隔离 package 加载最终通过，包含 1772 个文件、四个 Hook 与十三个架构工具，见 [package evidence](fixtures/host/package-evidence.json)。后续需补齐 Desktop GUI 操作，再按固定任务评估稳定自主连续任务及 token/费用 A/B。0.160 app-server/CLI 的生命周期与 compact 验收不等于 Desktop GUI 端到端通过；旧模型错误选择/无效 review 和继承 PATH 范围失败按原证据保留。SoL-Pi 整体尚未完成。

2026-10-04 补充了独立的[本地自评 benchmark](benchmarks/self-eval/README.md)：八个合成 JS 任务、34 个行为检查、88 个合规检查和 12 个适用复用机会，可准备工作区、评分并比较 A/B 报告。正确参考、空白基线及五类错误变体的[评分器校准](benchmarks/self-eval/calibration-evidence.json)已完成；新增回归验证默认/星号导出登记、未实际复用、缺失工作区与超时等路径，最新项目检查见[检查证据](benchmarks/self-eval/check-evidence.json)。这些是 M-004 的评分准备，真实模型与 SoL 开关 A/B、模型 token/费用和任务耗时仍未采集。

## Linux CLI 适配（2026-10-05）

在 `codex/linux-adaptation` 中补齐 Linux Bash wrapper、符号链接执行路径和执行权限，patch 预检共用现有工作区模块的纯路径校验。保留 Windows PowerShell 配置、schema_version=1、锁、验证、归档和恢复流程；未新增依赖或职责模块。撤销检查程序执行权限会使相关历史检查失去当前有效性，历史回执不改写、不自动重跑。

WSL2 Ubuntu 24.04 x64 的 Linux 文件系统完整 `npm run check` **248 通过 / 1 项 Windows 专项跳过 / 0 失败**；Windows 为 **240 通过 / 9 项 Linux 专项跳过 / 0 失败**，均含 249 个计数测试、审计 0 漏洞。77 个运行/检查输入两平台字节相同且各自运行前后不变。两次 Linux 旧夹具失败及修正、WSL DNS 的临时审计方式均保留于 [Linux 检查记录](fixtures/linux/check-evidence.json)。

默认 Linux 登录终端的 Node 22 另有 34/34 专项通过；实际 Codex 0.160.0 的隔离安装/重启装载验证了 1773 文件包、四个 Hook 和十三工具，见 [Linux Host 记录](fixtures/linux/host-evidence.json)。当前索引 **21/48/77、ready**，3 条既有非阻塞诊断，见 [索引](fixtures/linux/index-evidence.json)。Linux TUI 的交互信任/Esc、Linux 宿主取消桥接、受限 sandbox／ask 和独立普通 Linux 主机仍未验收；未增加模型回合、公开发布或版本号。
