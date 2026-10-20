# 公开源码范围

本仓库同步 DSH Cline 4.5.1 的基础功能：VS Code 原生交互、Diff、检查点、剪贴板、工作区导航、独立运行时、模型配置与 MCP。公开文件采用仓库 MIT 许可。

RSI 为试验功能，当前不公开实现，待研究完成并稳定后开放。仓库不包含其源码、内部规范、测试实现、编译代码或源码映射。README 中的 RSI 演示与用户指南用于介绍扩展试验功能；从本仓库构建的版本不包含 RSI。

使用 Node ^22.19.0 或 >=24、pnpm 10.28.2，执行 `pnpm install --frozen-lockfile`、`pnpm typecheck`、`pnpm build`。构建先生成宿主，再内嵌到扩展；不依赖私有 RSI 文件。产物在本地生成，不提交 lib、dist、map 或 VSIX。

发布前运行 `node scripts/check-public-source.mjs`，检查将提交的文件、README 图片 URL 和 RSI 边界。不得将含私有实现的本地开发仓库历史合并或推送到这里。
