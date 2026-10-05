# 本地 JS 自评基准

这个基准在一个小型合成 JavaScript 仓库中评估产出代码的行为、有限范围代码规则，以及对既有组件的实际复用。它只准备任务、在本地评分和比较报告；不会调用模型或 API，也不增加依赖。模型及其配置由使用者自行记录，`--label` 只是标签声明，不是模型身份验证。

## 任务

固定任务集在 [`tasks.json`](tasks.json)，基线仓库和组件登记在 [`base/`](base/) 与 `base/components.json`。任务提示说明行为需求，不点名必须调用的辅助函数；候选实现需要自行检查现有组件。预设复用机会只用于评分，不随 `prepare` 输出给候选。评测使用独立行为断言、静态分析和运行覆盖证据。

| 编号 | 主要考察 |
| --- | --- |
| T01 | 按规范化分类汇总；组合记录校验和汇总组件，保留负数并排序。 |
| T02 | 按输入顺序渲染列表；复用记录校验与 HTML 转义，精确控制输出。 |
| T03 | 异步读取、解析、规范化并汇总；保持各阶段的错误语义。 |
| T04 | 有限重试读取操作；将重试限制在读取边界，保留取消和耗尽语义。 |
| T05 | 扩展既有网关筛选；保持规范化行为并更新组件登记。 |
| T06 | 验证分页参数、边界和切片结果；此任务没有预设组件复用机会。 |
| T07 | 顺序处理异步批次；检查中断、提交时点、恢复索引和错误传播。 |
| T08 | 增加网关条目并改接消费者；保持旧 API 行为并复用既有校验组件。 |

## 指标

报告分别给出五项指标，不计算加权总分：

- **任务成功率** = 行为断言全部通过且该任务全部 11 项合规检查通过的任务数 ÷ 指定任务总数。
- **行为通过率** = 通过的固定行为检查数 ÷ 固定行为检查总数。每项检查可包含多个输入及断言，全部通过才计该项通过。
- **代码合规率** = 通过的固定合规检查数 ÷ 固定合规检查总数。证据不足标为 `unverified`，不计入通过数，但仍保留在分母中；报告也单列其数量。
- **有效组件复用率** = 成功任务中实际调用且组件来源/身份检查通过的复用机会数 ÷ 任务预先固定的适用复用机会总数。失败任务的机会仍在分母中；无复用机会时报告 `null`（T06）。
- **原始执行复用率** = 达到最低调用次数的机会数 ÷ 固定复用机会总数。它只表示观察到调用，不要求任务成功或组件来源检查通过；作为诊断指标单独报告。无机会时也为 `null`。

每个任务固定检查 11 项：`scope`、`protected_files`、`dependencies`、`syntax`、`safe_imports`、`no_dynamic_execution`、`no_debug_output`、`no_embedded_secrets_or_addresses`、`component_registry`、`no_copied_component`、`source_stability`。本基准是纯函数 JS 任务集，规则要求不新增依赖、不从夹具外导入，且不使用进程或网络 API；这是针对本语料的约束，不代表所有项目都应禁止合理依赖或日志。

全部八项任务共有 34 个行为检查、88 个合规检查和 12 个复用机会，每个机会最多计一次。源文件快照忽略正规目录 `.git/` 和 `.codex/sol/` 中的生成记录；符号链接及其他新增文件仍检查。复制检查只比较较长函数体的有限 AST 模式，不能识别所有重复实现。

仅导入组件不算调用；只有观察到实际函数执行、对应任务成功且组件来源与身份检查通过，才算有效复用。V8 函数覆盖只能证明代码在本次运行中执行过，不能证明实现语义最优，也不能证明实现无法作弊。

## 运行流程

所有输出目录都必须是尚不存在的新目录。示例使用仓库忽略的 `slop/self-eval/`，请勿复用已有输出目录。

```powershell
node benchmarks/self-eval/cli.mjs prepare --out slop/self-eval/a-run
node benchmarks/self-eval/cli.mjs prepare --out slop/self-eval/b-run
```

默认准备全部任务；需要单项时可用 `--case T01`。先分别准备 A、B 两组，再把每组任务的 `TASK.md` 和对应 `workspace` 提供给候选实现者，只提供完成任务所需材料；不要提供 `reference`、grader 或评分证据。A、B 应使用同一批任务、基线、规则和宿主 Node 版本。

```powershell
node benchmarks/self-eval/cli.mjs grade --run slop/self-eval/a-run --out slop/self-eval/a-report --label "模型或配置 A"
node benchmarks/self-eval/cli.mjs grade --run slop/self-eval/b-run --out slop/self-eval/b-report --label "模型或配置 B"
node benchmarks/self-eval/cli.mjs compare --a slop/self-eval/a-report/report.json --b slop/self-eval/b-report/report.json --out slop/self-eval/ab-comparison
```

`prepare` 在输出目录中生成 `run.json`，以及每项任务的 `TASK.md` 和 `workspace/`。候选 agent 只获得任务说明与对应工作区，不提供 `reference/` 或评分器文件。`grade` 在本地用黑盒断言、Acorn 静态分析和 Node V8 函数覆盖评分；输出 `report.json`、`report.md`，并为每个任务保存 `result.json`、`coverage/` 原始证据。实际启动行为验证器时还会保存 `stdout.txt` 与 `stderr.txt`。`report.json` 的五项指标键为 `task_success`、`behavior_pass`、`code_compliance`、`effective_reuse`、`observed_reuse`；缺证据状态写作 `unverified`。

`compare --a` 与 `--b` 接收两份 `report.json` 文件路径；比较要求任务集顺序、评分器版本和 Node 运行时一致，输出 `comparison.json` 与 `comparison.md`。不同 A/B 组应使用相同任务、基线、评分规则和宿主 Node；标签只记录使用者声明的信息。失败任务及重试记录都应保留，不能只挑最好一次或删除失败样本来缩小分母。

可先运行自校准，检查评分器对仓库参考实现、未解题基线及五种错误变体的预期：

```powershell
node benchmarks/self-eval/cli.mjs calibrate --out slop/self-eval/calibration
```

校准覆盖只导入不调用、复制已有组件、修改受保护源码、添加范围外文件和执行超时。输出 `calibration.json`，包含评分器与参考输入哈希、运行环境及各类样例的结果；仓库保存的校准记录见 [`calibration-evidence.json`](calibration-evidence.json)。校准通过只说明评分器在这些固定样例上符合预期；它不是模型评测，不能据此推断 SoL 或任何模型的真实效果。

## 解释结果时的边界

这是针对可信本地候选代码的自评工具，不是恶意代码沙箱。静态克隆与危险 API 规则只覆盖有限模式；代码合规率不代表所有代码质量、安全性或可维护性。V8 覆盖也不代替行为断言。这个小型 JS 合成仓库不能替代真实 Codex Desktop 验收，也不能代表多语言项目或复杂架构任务。

当前 `model_usage` 中 token、费用和模型任务耗时为 `null`，状态是 `not_measured`；评分本身的 `grade_duration_ms` 只代表评分耗时。缺失值不得填成 `0`，也不能据此宣称节省了 token、费用或时间。
