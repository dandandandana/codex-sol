# 架构维护、复核与收尾：软件工程依据

日期：2026-10-04。本文是 M-002 维护、复核与收尾的研究依据；实施合同在 [architecture.md §5](architecture.md#5-状态收尾和恢复)，当前实现见 [architecture-current.md](architecture-current.md)。相关入口现已实现，程序与实际 STDIO 验收见 [闭环证据](fixtures/closure/README.md)。原论文不构成 LLM 自主效果或所有行为正确的证明。

研究问题是：代码变化之后，怎样维护架构而不把当前实现直接当成正确设计；怎样复核职责和公共契约；怎样依据当前需求与检查证据结束任务。读取原始论文和课程/指南的相关章节，采用能补足现有缺口的原则，不移植整套方法或工具。

## 1. 已读原始论文

| 来源与实际阅读范围 | 原文支持 | 对 SoL 的采用与限制 |
| --- | --- | --- |
| D. L. Parnas，1972，*On the Criteria To Be Used in Decomposing Systems into Modules*；印刷页 1054–1057，模块化定义、两种划分比较、划分准则及效率讨论。[大学保存的原文](https://cse.sc.edu/~mgv/csce330f13/ParnasCriteria.pdf) | 模块划分围绕职责和需要隐藏的设计决策；处理步骤不是唯一划分依据。论文以 KWIC 示例论证，也讨论实现代价。 | 复核共享模块的职责、变化边界和公共契约；不按文件数量自动拆模块，不据此实现自动聚类或架构生成。 |
| Gail C. Murphy、David Notkin、Kevin Sullivan，1995，*Software Reflexion Models: Bridging the Gap between Source and High-Level Models*；§1–3、§6–8，PDF 页 1–6、8–10。[作者原文](https://www.cs.ubc.ca/~murphy/papers/rm/reflexion_model_fse95.pdf) | 高层模型、源码模型及显式映射共同用于比较一致、额外与缺失关系；计算不了解预期语义，关系类型必须可比，未映射实体需要查询。 | 保留声明意图与源码事实，提出可回查的维护建议。ESM 导入只能说明文件依赖；不能证明业务调用、职责正确或行为兼容。不引入原系统的形式规格和图形工具。 |
| Olly C. Z. Gotel、Anthony C. W. Finkelstein，1994，*An Analysis of the Requirements Traceability Problem*；PDF 页 1–7，§1–9，重点 §5–8。[UCL 原文](https://discovery.ucl.ac.uk/id/eprint/749/1/2.2_rtprob.pdf) | 区分需求形成前的来源/演化与形成后的实现追溯；来源和修订背景影响可追溯性，存文档或链接不足以保持信息有效。 | 沿用需求来源、理由及验收引用，连接累计变化、复核和完成证据。版本绑定是本项目的设计推论；不建立企业角色体系或全生命周期矩阵。 |
| Gregg Rothermel、Mary Jean Harrold，1997，*A Safe, Efficient Regression Test Selection Technique*；印刷页 173–180、184–189、195、205–207，重点 §2、§3.1.2、§4.2.4、§5。[大学保存的原文](https://www.cs.purdue.edu/homes/xyzhang/spring07/Papers/p173-rothermel.pdf) | 安全选测结论有前提，包括旧测试适用、旧执行满足规定输出及其他行为条件等价；算法依赖新旧控制流图和逐测试执行历史，不保证旧测试覆盖新需求。 | SoL 的静态导入图不具备这些材料。首轮采用累计影响、显式检查规则及必要的保守完整检查；不声称安全选测，不实现该论文的控制流算法。 |

## 2. 已读课程与指南

- **MIT 6.031 Software Construction，Reading 6: Specifications，Spring 2021**：读取 Behavioral equivalence、Why specifications、Specification structure、Testing and specifications、Specifications for mutating methods。行为是否等价取决于调用方依赖的契约；契约包含前置条件、返回/异常及可见副作用；测试应核对契约。[课程正文](https://web.mit.edu/6.031/www/sp21/classes/06-specifications/)
- **MIT 6.031，Reading 7: Designing Specifications，Fall 2021**：读取 Declarative vs. operational specifications、Stronger vs. weaker specifications。兼容替换需考虑前置条件是否加强、后置保证是否减弱，而非只看导出名称；这里使用它作为复核问题，不宣称 AST 能自动证明契约。[课程正文](https://web.mit.edu/6.031/www/fa21/classes/07-designing-specs/)
- **IEEE Computer Society，SWEBOK Guide v4.0a**：读取第 8 章 §2.2–2.6、§3.1–3.2、§4.1–4.2、§5.1–5.3、§6.1（印刷页 8-7–8-13），及第 5 章测试导论（5-2）。配置管理连接版本、变化、影响和验证证据；功能一致性与设计文档/实际产物一致性分别核对；测试结果受状态与环境影响，有限测试不能证明所有行为正确。[出版方页面](https://www.computer.org/education/bodies-of-knowledge/software-engineering)、[官方 PDF](https://ieeecs-media.computer.org/media/education/swebok/swebok-v4.pdf)

SWEBOK 已读取官方 411 页 PDF 的上述部分，不表示通读全书；本地研究副本不进入交付。所读文件 SHA-256：`0c9db4da0b2425c58cf778b99131eb31bb6c188e98b67163a549a1366d96e511`。不采用变更委员会、合同审计组织、发布管理平台；也不把未经认可的初始快照称为“已批准基线”。

## 3. 收敛成项目设计

下面是对材料与现有代码的综合判断，属于 SoL 的应用设计，不是原论文已经验证的 LLM 效果。

| 闭环环节 | 程序负责 | 模型负责 |
| --- | --- | --- |
| 架构维护 | 比较来源指纹、导出、归属及同类依赖关系；列出新增、删除、未登记与未覆盖项，保留位置和版本 | 判断职责、变化边界及公共契约；选择复用/扩展/新增；决定修改代码还是声明，并给出依据 |
| 语义复核 | 固定当前需求、验收、源码、声明和规则计划；核验提交结构、引用及新鲜度 | 针对真实契约解释保留/修改/移除、兼容性、实际使用方和未解决问题；逐项回应验收 |
| 完成收尾 | 汇总累计必需检查，核验或补跑有效证据；检查输入稳定后归档并原子发布完成记录 | 阅读检查及覆盖缺口，补充行为依据或修复问题；不能用“已通过”的自述覆盖真实检查 |

### 架构维护产生建议，语义改变需要复核

复用当前 Normify/Acorn 索引。机械变化可以确定性提议；模块职责和契约仍引用已有类型、注释、测试及必要正文。维护后的声明必须再次接受现有结构、来源与 policy 校验。刷新指纹只解决来源漂移，不能证明契约保持成立。累计新增正式源码即使查询 `ready`，也要核对登记及归属。

### 检查有效性与复核有效性分别判断

原首片调整 scope 会增加 generation 并清空 `latest_validation`；费用汇总夹具当时出现此情形。管理信息变化需要新的复核，但不一定改变检查所针对的代码。

原回执没有可重算的逐规则来源。本切片在保持回执格式兼容的同时另存真实执行来源，按规则核验历史回执。仅显式声明 watched_inputs 的规则允许复用，默认 never；命令、判定标准、相关输入、排除或可核验运行条件改变时失效，未跟踪外部条件不能推定等价。缺依据的旧回执不补猜，使用现有 ValidationEngine 的显式再验证路径。

### 检查计划覆盖累计变化

用累计实际路径与前后已识别使用方选择配置中的必需规则；删除保留旧路径，移动保留旧侧与新侧。静态关系用于定位，不充当完整测试覆盖证明。新变更保留初始架构事实；旧记录缺可信前侧材料时明确报告缺口，补查或采用项目认可的保守检查与复核，不能把当前图当成完整历史影响。

项目规则需要明确重要输入的覆盖责任。需求变化还需核对旧检查是否仍对应验收；无规则、无行为依据或未解释的覆盖缺口，均不能因 `no_rule`、最后一次 `passed` 或索引 `ready` 自动结束。

### 完成是一份可回查的当前证据

保持一条关系：**需求来源及验收 → 累计变化与受影响契约 → 当前复核 → 必需检查及有效回执 → 完成归档**。继续使用现有不可变存储、工作区租约和唯一发布指针。归档和最终核验成功后发布 completed；取消、漂移或半发布保留未完成及实际结果。以后变化使当前完成证据失效，历史记录保留。

同一个模型可以承担实现和复核，记录必须如实表达这种复核方式；它不等同于独立审计。这里的完成只表示对捕获版本满足项目约定的复核与检查，不保证全部行为正确。

## 4. 实施与验收落点

复用 `src/architecture/index.mjs` 的事实分析，`change.mjs` 的状态协调，`validation.mjs` 的快照/执行/回执，以及 store/recall。已按事实与检查来源 → 复核 → 收尾接入，无新增状态服务、数据库、执行器或工作流框架。详细行为和六个持续验收场景在 [既有合同 §5.1–5.4](architecture.md#51-架构维护与语义复核)，运行证据独立保存在 fixtures/closure/，历史阶段不改写。

本切片未新增 Hook 或 Skill，未改变写前 Context 交接；宿主注入继续按 M-003 验收。未做成本收益实验，未验证模型稳定自主维护架构；研究依据与程序验收分别报告。
