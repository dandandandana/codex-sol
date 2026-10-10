# 只读组件发现 Provider

独立发行用于已有工程控制器查询真实组件来源，避免同时加载完整 SoL 写入/流程控制。入口为 `src/provider-server.mjs`，只注册 `sol_architecture_query`、`sol_read_file` 和 `sol_recall`。来源捕获和观察缓存有显式副作用；它不修改产品源码、不授予写权限、不声明语义复用或任务完成。

## 分发与输入

在安装锁定依赖后执行：

```sh
npm ci --ignore-scripts
node scripts/package-provider.mjs --out <new-provider-directory>
```

打包器解析真实静态 import 闭包和锁文件，仅复制 allowlist 中的 runtime/vendor/依赖；输出 `provider-manifest.json` 的完整路径、字节数与 SHA-256。清单声明 `sol-component-discovery/1`、`sol-component-discovery/2` 及 registered/repository 模式。消费者应核验完整包与原生执行程序，而非只信入口或版本字符串；目标目录必须是新目录，失败不删除未知目录。

进程入口接受 `--workspace <root> --config <bounded-json-file> --cache-root <root>`。这些由控制器固定，不是模型工具参数。v1 配置沿用 `architecture_path` 与独立 `discovery_scope:{roots,files}`。v2 配置固定 `protocol`、`mode:"repository"`、实际 `workspace_root/workspace_id`、独立读域及其 `scope_digest`、收集 `budgets`，可附精确 `excluded_paths` 和实现判词的 `excluded_sha256`。显式观察缓存必须位于工作区外，或使用已校验的工程循环单操作缓存位置；旧 Store 默认位置保持原行为。

## 来源与覆盖

v1 仍读取真实登记和对应源码，Normify 编译/校验后查询 UID、导出与静态影响。纯 `validateArchitectureDeclaration` 只复用声明层结构与 policy 校验，不读源码、不编译、不证明图 ready。

v2 不要求登记：返回文件级 candidate_id、路径、源 SHA、实际行数和 parsed/partial/unknown 状态。支持的 JavaScript 使用既有 Acorn；未知语言保留真实文本候选与未决关系，不伪造 symbol 或“零调用方”。关键词只调整顺序，不抹掉全量候选。

库存包分别报告 enumeration/candidates/relations 的覆盖、跳过和 unresolved；达到预算、不稳定收集或必要关系未知不能当空完整库存。两遍收集比较来源身份及路径摘要，资源与秘密文件只按安全规则处理。`path_inventory` 记录实际 regular-file 名称及未展开目录，凭据文件名可能出现在元数据中，字节不会交付；`.git` 为普通 worktree 控制文件时也不读其内容。

完整 query/read 通过既有 observation/raw/recall 保存，消费者仍须取回完整字节并核验 SHA，不能把有界显示或 capture 成功当语义可复用。产品写门、D 决定、当前性、检查与独立 QA 由上层工程控制器结算。

## 验证边界

本机 Windows/Node 24 的 `npm run check`：325 项通过、20 项按原平台条件跳过，依赖审计 0 漏洞。新 Provider、包闭包、声明校验、范围/秘密/链接、空库存、JS/TSX、预算、不稳定收集与真实 v1 回归均有可运行检查。远端 CI、真实 Desktop、其他平台新 Provider 宿主和模型收益未由该本机结果证明；版本保持 0.1.0。
