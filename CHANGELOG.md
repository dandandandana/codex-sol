# 更新记录

## 2026年10月6日 架构与可靠性更新

本轮改进 Linux 文件权限保护、失败恢复和大日志读取。项目仍处早期开发阶段。

主要变化：

- Linux 覆盖已有文件时保留普通 `755` / `644` 权限；内容相同就不重写。只改普通权限也会使旧检查和完成证据失效，历史记录字节仍保留。
- 命令启动后的归档或清理失败，会保留已知的执行结果和实际改动；后续恢复使用已有事实，不自动重跑命令。
- 大日志打包和召回不再先把完整原文装入 Buffer；每页结果来自同次完整 SHA 核验。一次 16 MiB 五页探针测得单次显式 Buffer 最大 64 KiB（不是所有 API 或 RSS 上限）；仍扫描完整原文，token 与费用收益未测。
- 只读 `check-config` 复用真实配置校验，不建项目记录、不运行命令、不改任务状态；见[本地插件说明](PLUGIN.md#检查项目配置)。
- CI 配置 Windows / Linux、Node.js 20.8.0 / 24 矩阵；最低版发现旧并发参数不兼容后改用 Node 自带调度接口。

本地检查：Windows Node 24 为 308 通过 / 19 跳过；WSL Ubuntu 24.04 为 326 / 1；Windows Node 20.8.0 portable 为 297 / 20，均零失败。两平台审计零漏洞，远端 CI 未核实。

真实 GUI、Linux TUI 信任与取消、宿主取消桥接及模型 A/B 未验收。范围与限制见 [架构演进验收](fixtures/architecture-evolution/README.md)；安装见 [本地插件说明](PLUGIN.md)。

## 2026年10月5日 Linux 初步适配

这次为 SOL-Pi 的 Codex 本地适配项目 Codex-SoL 补上了第一轮 Linux 支持，代码已推送到 `codex/linux-adaptation` 分支。

本次主要更新：

- 接入 Linux Bash 命令执行，保留执行结果、错误反馈和检查记录。
- 适配 Linux 文件路径、大小写和执行权限，支持原生 Codex 文件修改流程。
- 补充 Linux 配置示例、安装说明和回归测试，同时保留 Windows 支持。

目前已在 WSL2 Ubuntu 24.04 上完成回归测试，并通过真实 Codex 插件的安装、重启和装载验证。Linux 与 Windows 的本轮检查均无失败。

**项目还处于很前期的开发阶段。** 我们正在验证如何让 Codex 找到并复用项目中已有的组件，以及如何在修改后维护架构、检查和恢复记录。完整 Linux CLI/TUI 交互、更多 Linux 环境和稳定的连续任务表现仍需要继续验证，配置与使用方式也可能随开发调整。

现阶段欢迎愿意参与测试的朋友尝试。遇到问题时，请附上系统、Node.js 和 Codex 版本，以及报错或复现步骤，方便我们定位。

代码与接入说明：[Linux 适配分支](https://github.com/dandandandana/codex-sol/tree/codex/linux-adaptation)。实际验证范围与记录见 [Linux 使用与验收](fixtures/linux/README.md)。
