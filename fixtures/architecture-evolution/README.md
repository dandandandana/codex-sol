# 架构演进验收（2026-10-06）

本轮按 [已确认设计](../../architecture-evolution.md) 改造现有本地服务，保留四/六/十三工具、公开 schema_version=1、唯一活动变更、跨进程租约和不可变历史。新增 `managed-write`、`workspace-snapshot`、`records`、`runtime` 四个职责模块，复用现有依赖与检查，没有新增工作流框架。

| 改造 | 实际行为与回归 |
| --- | --- |
| 文件与输入事实 | 同内容不换 inode；异文覆盖保留普通 755/644；新文件和私有指针沿用 600；特殊权限替换拒绝。内容 SHA 与混合指纹分离，chmod 单独变化使旧证据失效。`managed-write`、`workspace-snapshot`、`linux`、`validation-reuse` 测试核验真实文件效果。 |
| 快照范围 | 窄 watch 不进入无关链接树；相关链接仍拒绝；generated、隐藏文件、删除与完整工作区越界核对保持同一策略。旧快照严格按原 hash 读取，旧完成只能保留历史资格。 |
| 执行、捕获与清理 | 不用空退出码推断未执行。启动后真实归档失败保留 marker、已提交 stdout 与执行事实；取消和 capture_error 同时保留。owner starting 持久化失败释放租约，idle/unlink 故障不覆盖已知写入和回执；后续请求恢复且不重放。`process-outcome`、`lease-failure` 和既有取消/进程树测试覆盖。 |
| 验证读取 | 返回候选字节来自完整 SHA 核验的同次数据流，篡改、索引替换、取消、collector/close 故障均不发布成功。UTF-8、BOM、CRLF、跨块 keyword、cursor 和响应预算保留。`verified-read`、`store-recall`、`pack` 测试覆盖。 |
| 状态归属与恢复 | 协调器直接依赖 ArchiveRecords 和共享配置 reader；Context/Hook 读投影。按 operation ID 归档实际 outcome 并发布引用，settled 失败可恢复已知证据，未知保持 interrupted。真实旧 completed/pending 冻结夹具验证字节不变、status 升级与零 runner 重放；仅 review policy 变化也使旧复核失效。 |
| 接入 | check-config 与真实启动入口共用规则唯一性、组合 ID 上限、职责 schema 与路径校验，诊断不创建 store 或执行命令。架构内容只标记 path_only，宿主兼容标记 not_checked；重复规则/检查、ID 碰撞与超长 ID 均拒绝。已有 STDIO 和打包检查核对注册与新增源码。 |
| CI | portable 与真实 native 分离；矩阵固定 Node 20.8.0 和 24。native job 要求手动启动、明确 runner 与真实 Codex 路径，缺配置先失败。远端 workflow 运行情况单独记录。 |

最终检查如下，命令、运行输入 SHA 和日志摘要见 [检查证据](check-evidence.json)。

| 环境与实际入口 | 计数 | 通过 | 跳过 | 失败 / 审计 |
| --- | --- | --- | --- | --- |
| Windows Node 24.11.0，npm run check，真实 Codex 0.160.0 | 327 | 308 | 19 个 POSIX/Linux 专项 | 0 / 0 漏洞 |
| WSL Ubuntu 24.04 Linux 文件系统，Node 24.11.0，native + audit，真实 Codex 0.160.0 | 327 | 326 | 1 个 Windows 专项 | 0 / 0 漏洞 |
| Windows Node 20.8.0，portable | 317 | 297 | 20 个平台/原生条件跳过 | 0 / 本命令未做审计 |

72 个运行与检查输入在各自检查前后 SHA 相同，三组运行使用相同源码字节。最低版本首次实际运行暴露旧 CLI 不支持并发参数，已由 npm 与 CI 共用的标准库调度器修复；真实通过、失败、缺失文件、四并发上限和 Linux 取消/子进程清理均有回归。WSL 默认 DNS 的首次审计失败保留；最终用调用内私有 mount namespace 临时解析 npm 域名，检查仍由普通用户执行，未改全局 hosts 或关闭 TLS 核验。

当前实际索引为 **ready，25 模块 / 67 能力 / 99 静态导入，0 阻塞诊断**；24 个有源码模块的 source fingerprint 全部相符，4 条非阻塞诊断保留，见 [索引证据](index-evidence.json)。静态导入与声明不构成模型复用或运行时调用证明。

复跑入口：

```text
npm run check
node scripts/ci-check.mjs portable
node scripts/ci-check.mjs native
```

完整/native 检查需 `CODEX_SOL_PATCH_EXECUTABLE` 指向已安装的实际 Codex 原生文件；portable 入口明确排除专用 native 文件，其他原生案例按现有条件跳过。当前项目未配置独立 lint、formatter、typecheck 或构建命令，未宣称这些检查通过。

每页仍核验完整 raw：bytes/lines 每页一遍，keyword 最多两遍。独立 Linux 探针以 64 KiB 块构造 16 MiB 原文，五页返回 27,360 字节，实际读取 80 MiB；显式 Buffer 分配合计 1,016,670 字节，单次最大 64 KiB，20 个读取 fd 最后均已关闭。进程生命周期峰值 RSS 为 88,494,080 字节，包含导入、夹具和探针开销，没有旧版对照。分配量与 RSS 是不同指标；流式候选收集解决全长 Buffer 和验证后再读的窗口，保留 O(P*N) I/O。完整测量与限制保存在检查证据。

本轮未重新验收 Desktop GUI、Linux TUI 信任/Esc、Linux 宿主取消桥接、受限 sandbox/ask 或独立普通 Linux 主机。未运行真实模型与 SoL 开关 A/B，token、费用、耗时收益保持未测。评分器校准和程序测试不能代替上述证据；历史宿主验收仍对应原版本与日期。

原始日志、一次性探针与临时工作区留在忽略的 `slop/architecture-implementation-20261006/`，不随 Git 或插件包分发，正式代码不依赖它们。本记录保存提交前验收，提交与推送状态以 Git 历史为准；本次改造未升级版本、公开发布或改全局配置。
