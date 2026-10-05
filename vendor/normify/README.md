# Pinned Normify engine

固定复用 [dsh-normify](https://github.com/yan-mc/dsh-normify/tree/ed404e5b8db0010ff57ec8486ec8749421072545/lib/engine) 0.5.4 的 10 个运行时 engine 文件，MIT 许可证见 [LICENSE](LICENSE)，来源与每个文件的 SHA-256 见 [provenance.json](provenance.json)。文件保留 Git blob 原始字节；不包含 DSH 宿主、工具注册层、类型声明、source maps 或 UI。

engine 自身只需要 YAML 运行时；本项目固定 yaml 2.8.3。`src/architecture/index.mjs` 调用原有 L1 校验、编译、存储和 policy，不复制这些规则。工作区安全边界、JavaScript 静态事实和 Context 归档由本项目适配层承担。

编译只写入本次创建的系统临时目录，并在结束时清理；正式代码不依赖研究用的 slop 目录。上游升级须重新检查许可证、文件哈希、调用兼容性和既有失败路径，不自动跟随分支。
