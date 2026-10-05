# 更新记录

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
