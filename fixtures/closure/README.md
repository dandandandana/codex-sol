# 架构维护、复核与完成：运行证据

日期：2026-10-04。范围为 IF-004，沿用已有 Normify/Acorn 索引、ValidationEngine、ObservationStore、工作区租约和唯一变更指针。三个直接 `gpt-6.1-sol` / high 子代理负责验证器、索引维护和只读复核，没有孙代理；父代理负责协调器、MCP 与集成。没有新增依赖、模型付费调用、Hook、Skill、部署或提交。

## 检查结果

| 检查 | 实际结果 | 证据 |
| --- | --- | --- |
| 完整 `npm run check` | **180/180，0 fail、0 skipped，audit 0 vulnerabilities**；已有 Codex 原生 patch 实际执行 | [命令、日志摘要与输入 SHA](check-evidence.json) |
| 变更闭环 | 21 个计数测试通过（含 4 个子测试） | tests/closure.test.mjs，完整检查日志 |
| 前后事实与架构维护 | 14 个测试通过 | tests/architecture-maintenance.test.mjs |
| 验证来源、复用及显式再验证 | 19 个计数测试通过（含 6 个子测试） | tests/validation-reuse.test.mjs |
| 语法与 diff | 本轮 8 个运行/测试 JS 文件的 node --check，git diff --check 通过 | 检查记录 |
| 本仓库声明索引 | 20 模块 / 44 登记能力 / 66 静态导入；无阻塞 | [索引及来源 SHA](index-evidence.json) |

格式化、lint、typecheck 未配置。完整检查原文保留在项目忽略目录 slop/closure-checks/full-check.log；本目录只保存摘要和哈希，不分发本地研究 PDF 或私人运行环境值。前阶段 fixtures/current-stage/ 与其他宿主证据保留当时的输入和边界。

## 可观察结果

| 合同场景 | 本轮直接观察 |
| --- | --- |
| scope 管理调整 | 清空 latest_validation 后，来源充分的两条规则仍复用；runner 零新增、ChangeEvent 零新增；新版本复核仍必需 |
| 多次修改与累计检查 | 共享 helper 的有效规则复用，缺失的静态使用方规则补跑；watch_paths 不会掩盖未配置 globs 的源码 |
| 指纹与语义复核 | 只刷新指纹不能完成；漏模块、错验收索引、引用别的模块来源拒绝；未解决项提交可归档但不能完成 |
| 删除/移动及两侧影响 | 索引回归覆盖删除导出/模块与旧的传递使用方；真实文件移动的完整收尾保留 UID、旧/新路径及使用方，并重新查询能力 |
| 漂移、取消及发布失败 | completion 归档故障、取消、最终 change_record 归档期间外部改源码保持未完成；已完成后源码、执行文件或 stdout 归档改变使状态 dirty，status 不启动 runner |
| 新来源与排除 | 新 JS 在 source 登记前阻塞；维护声明后真实行为检查通过、能力 static_export 可发现；生成目录/配置变化沿用已有范围与来源回归 |
| 来源缺失及配置变化 | 旧记录缺初始事实给 BEFORE_IMPACT_UNAVAILABLE；旧回执不补猜 provenance；规则文件改动要求重启，PATH 查找命令实际运行但不能发布完成 |
| 有界协议与兼容 | 大量缺口的完成响应不超过 4096 字节，保留数量、代码及 recall handle；默认四工具与纯 Context 六工具保持原合同，架构十三工具 |

真实 STDIO 测试由测试客户端启动独立 Node MCP，调用 query → open → 两次受管修改（源码与声明）→ review prepare → 分页 sol_recall → review submit → complete → status，并通过 tools/list 核对十三工具。该测试使用手工构造的结构化复核，不是新增真实 LLM 回合。准备材料保留真实前/后源码与不可变引用；程序只核对依据关联、版本、实际检查和发布条件，无法证明复核的语义判断正确。

默认 reuse=never 规则会执行本次检查，其完成证据读取仍可核验且不重跑；显式 watched_inputs 才能复用历史检查。argv[0] 需能核验的实际绝对执行文件路径，否则真实 passed 回执仍留存，但 task_complete=false。

## 未覆盖事项

本轮没有验证模型稳定自主发现或维护声明、独立复核身份、成本收益、新 Desktop/TUI 模型回合、完成期间真实宿主进程崩溃或 Linux 运行。原有受管写入的 Windows 整树退出、取消、恢复和 CLI patch 回归实际运行；这不替代新的宿主门禁验收。变更状态 Context 注入、PreToolUse/Stop 新门禁与插件打包留给 M-003。

旧费用夹具的历史 dirty 变更未升级为 completed，没有用当前事实伪造其初始状态。新普通需求的真实模型持续使用效果仍需后续单独验收。
