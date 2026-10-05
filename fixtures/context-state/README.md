# Context 变更状态验收（2026-10-04）

本片实现 [合同 §14](../../contracts.md#14-变更状态进入-context) 与 [设计 §4.13](../../architecture.md#413-变更状态的职责注入合同已实现)：把当前变更事实接入显式绑定的职责材料和已有生命周期 Hook。完整检查及运行输入 SHA 见 [check-evidence.json](check-evidence.json)，当前架构编译结果见 [index-evidence.json](index-evidence.json)。[前片闭环记录](../closure/README.md) 保留原来的 180/180 与历史索引，不覆盖旧证据。

## 已完成

- `sol_context_prepare` 可选传当前持久 `change:{id,version}`，要求同一任务身份和目标。`targets` 选择读取材料，写入权限仍取自登记的 scope。无绑定时不读取工作区中的其他变更，旧 Context 归档和产物保留原语义。
- ChangeCoordinator 提供共用只读核验。投影保留真实持久绑定、当前有效状态、所选文件范围、阻塞摘要、历史验证摘要、复核/完成引用与有效性，以及下一步。原始需求、完整范围、源码和检查内容继续通过 `sol_recall` 读取。
- 已绑定 Context 的新鲜度包含状态投影；scope/验收调整、review 提交、外部输入或证据变化都使旧材料失效。旧绑定 plan 不会仅因更换版本而成为新方案；未绑定 plan 继续遵循原有交接合同。
- `SessionStart` 恢复核验当前事实。通常沿用原有 prepare 归档和会话指针发布；上游材料过期时返回 stale 与旧引用，不更新会话绑定。当前仍有效的完成证据独立呈现，不要求重做已完成的 implementation。
- `UserPromptSubmit` 只在旧材料、阻塞或核验错误需要处理时提醒。无绑定或当前有效且无阻塞时输出 `{}`。不新建归档、不改会话或变更指针、不启动检查、不保存用户 prompt，不自动把此前任务转移给新请求。
- 绑定 Hook 使用与 MCP 相同的验证规则和 generated 排除项；缺失或 SHA 不匹配明确失败。未绑定旧会话恢复不增加验证配置依赖。取消、宿主状态故障和锁等待沿用原错误码和释放规则。

所有状态核验都不启动 runner、不发布变更状态、不重放中断操作。prepare 的 Context 归档和恢复的会话指针更新，是既有的明确副作用；它们不构成第二套可变任务记录。

## 典型结果

| 实际情况 | 返回内容与下一步 |
| --- | --- |
| 当前绑定、材料有效且无阻塞 | Context 可用；prompt Hook 静默 |
| scope/验收或 review 已变化，源码未变 | 旧 Context 过期；明确准备新材料，不沿用旧绑定成果 |
| 外部源码或完成证据变化 | 投影反映失效；保留真实持久版本并提示 `needs_status_refresh`，先调用 `sol_change_status` |
| 遗留 checking/pending | 投影为 interrupted；刷新状态、检查实际效果并显式 resume，不自动重放 |
| 旧上游材料过期，但完成证据仍有效 | 恢复为 stale 材料，同时保留当前 `task_complete=true`，不重新实施 |
| Hook 配置缺失或与变更记录不符 | `context_unavailable`，不声称旧 completed 仍有效 |
| 新会话、其他任务、另一条变更或目标已改变 | 不继承或改绑此前任务；由用户请求与模型明确准备新任务 |

`latest_validation.interpretation='historical_only'` 始终表示历史摘要，不能当作当前累计检查全部通过。工具包及 Hook 文本限制为 4096 UTF-8 字节；必需身份和状态超出预算时返回明确错误，不以裁剪制造成功。

## 可运行回归

| 文件 | 覆盖 |
| --- | --- |
| `tests/context-change.test.mjs` | 可选绑定、身份/目标/版本、scope 不扩张、旧归档兼容、上游失效、状态变化、历史回执、预算与实际 STDIO/召回 |
| `tests/context-change-hook.test.mjs` | 会话隔离、元数据变化、遗留 pending、已完成但上游过期、配置匹配、独立 CLI、只读副作用与锁等待取消 |
| `tests/closure.test.mjs` | 真实完成后的源码、输出归档、复核材料、外部检查执行文件失效；提醒不改指针或执行 runner |
| `tests/validation-reuse.test.mjs` | 文件树快照读取中的取消与宿主故障码保留，及原验证来源/复用回归 |
| 原 Context、Hook 和其余项目回归 | 四/六/十三工具、原写前输出合同、受管修改、取消、恢复及证据存储兼容 |

完整 `npm run check` 结果为 **199/199、0 跳过、依赖审计 0 漏洞**。该命令包含全部程序测试与项目已有依赖审计。原生 patch 案例使用本机已安装的实际 Codex 执行文件，仅对检查进程设置既有配置变量，不调用模型。机器记录保留版本、执行文件 SHA、退出码、测试统计及 59 个运行输入检查前后的 SHA 对照；原始日志只在忽略的 `slop/context-state-checks/` 中保留。

10 个本片修改的源码/测试文件通过 `node --check`，`git diff --check` 通过。项目未配置独立 format、lint、typecheck 或 build 命令。当前声明编译为 **20 模块 / 44 登记能力 / 70 静态导入关系**，无阻塞；两个容器布局/纯文档根提示保持非阻塞。

## 尚未完成及后续

本片没有新增 PreToolUse 范围门禁或 Stop 收尾门禁，也没有插件打包/安装。新的 Desktop/TUI 模型回合、实际 compact、连续任务中的自主架构维护，以及 token/费用收益仍未验证；本地 Hook 命令和真实 STDIO 程序回归不替代这些证据。

后续先在实际宿主验收显式绑定后的恢复与提醒，再按既有合同接入新门禁和插件交付，并用连续普通需求检验模型行为。旧阶段的宿主证据保持其原日期和版本范围。
