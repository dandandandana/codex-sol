# 既有阶段验收：2026-10-04

当前架构先保存于 [architecture-current.md](../../architecture-current.md)，再执行本轮测试。后续设计沿用已有合同。本轮使用三个直接子代理，均为 `gpt-6.1-sol` / high，没有孙代理；博客保留为历史 Hook 夹具，没有继续开发。

## 结果

| 检查 | 实际结果 | 证据 |
| --- | --- | --- |
| 修改前既有检查 | 124/124、0 跳过、审计 0 漏洞 | [完整检查记录](check-evidence.json) 保留首次基线 |
| 两个新增回归与最终完整检查 | 126/126、0 跳过、审计 0 漏洞；本机已有 Codex patch 实际执行 | [检查记录](check-evidence.json)、[回归记录](scope-regression-evidence.json) |
| 独立项目基线 | 19/19；分类命令尚未实现 | `D:/codex-sol-expense-test-20261004/fixture-manifest.json` |
| 实际模型完成普通功能 | 27/27；两次受管写入回执均 passed | [功能证据](feature-evidence.json) |
| 父代理独立黑盒验收 | 20/20，退出 0 | [独立验收](independent-acceptance.json) |

主项目没有配置独立的格式化、lint、typecheck；测试夹具另未配置构建。最终完整检查后的修改仅涉及文档和测试证据，没有改动已通过检查的运行源码、测试、依赖或架构声明。原始失败和成功日志均保留，后续文档更新不改写当时的输入指纹。

## 本轮修复

`generated=["cache*"]` 会使快照跳过 `cache-data` 的整个目录；原登记仅检查完整目标，因而错误接受 `cache-data/new.mjs`。回归先得到 Missing expected rejection，再修复为登记与快照共用 `isGeneratedPath`，逐级核对祖先目录。Windows 的 generated 匹配统一为不区分大小写。

另一个真实 STDIO 回归证明：给新文件显式指派已有模块后，可以创建、自动检查并在重启后恢复累计路径与回执；原架构声明仍未自动增加该文件的 source。主项目共享能力与指纹同步维护，当前索引 **20 模块 / 42 能力 / 66 静态导入**，无阻塞，见 [索引证据](index-evidence.json)。

## 普通功能：按分类汇总支出

测试目录 `D:/codex-sol-expense-test-20261004` 是本地合成数据夹具，没有网络服务、新增依赖、Git 提交或发布。TASK 只描述普通需求，没有指定具体 helper 或 MCP 操作。执行模型获得测试桥与真实初始化工作说明，属于指导下的工具链测试。

最终代码在 `src/categories.mjs` 实际调用已有 `groupBy` 和 `sumAmountsCents`；渲染调用已有 `formatMoney`；CLI 沿用 `readLedger`。这些共享实现和原总览/流水源码 SHA 未变。新增代码只承担分类报告，未复制分组、整数金额或输入校验实现。父代理核对了七个最终文件与真实受管写入请求的内容一致。

模型调用 **37 次**：查询 3、召回 25、Context prepare 2、submit 2、变更登记/调整 2、受管写入 2、状态读取 1。父代理仅预检初始化，没有代做模型的 MCP 工具调用。调用者、请求、响应、归档 SHA 与文件 SHA 见 [功能证据](feature-evidence.json)，完整 RPC 日志在夹具 `.codex/sol/ordinary-feature-rpc.jsonl`。

独立黑盒检查从封存需求与旧输出准备，没有读取新增实现来设计断言。它启动真实 CLI，覆盖金额降序、同额名称排序、退款、负净额、零金额、空记录、默认样例、原总览/流水逐字兼容，以及坏数据、坏 JSON、缺失文件、未知命令和多余参数。

源码改动后架构查询返回 blocked，新文件尚无声明归属；模型通过第二次受管写入**手工**增加分类模块、能力并更新受影响指纹。最终索引 ready，分类能力有真实导出位置与 CLI/测试使用方。该结果证明漂移诊断与手工维护后的发现，不证明自动延续架构树。

## 当前边界与下一步

最终变更为 dirty、累计七条路径、无 blocker、`task_complete=false`。最后一次归属调整按当前合同清空 latest_validation；两份历史 passed 回执保留，最终 27 项项目测试与独立 20 场景针对当前文件通过。不能把历史回执、accepted 产物或 ready 索引解释为系统完成发布。

测试桥每次调用重启 STDIO 服务，一次跨调用 cursor 续页被拒绝，失败原样保留；改用有界 bytes 范围后完成召回。此连接桥证明真实协议与模型使用，未新增 Desktop/CLI 原生插件安装或自动 Hook 注入验收。

既有阶段测试已完成。后续应补修改后的架构声明维护与复核、累计检查和完成发布，再接变更状态 Context 与对应 Hook 门禁。本轮没有提前实现这些能力。单个指导下案例不能推导稳定自主发现、token/费用节省或完整 M-002 已完成。

复查夹具的普通功能：在该目录运行 `npm test` 或 `node src/cli.mjs categories`。完整主项目检查仍为 `npm run check`；原生 patch 用例需要配置本机已有 `CODEX_SOL_PATCH_EXECUTABLE`，本轮实际配置与命令保存在检查记录中。
