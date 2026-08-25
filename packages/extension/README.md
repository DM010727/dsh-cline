# DSH Cline

> 把 DeepSeek Harness 的智能体能力，和 Cline 的 VS Code 原生体验，融为一体。

DSH Cline 由 [SSYCloud 胜算云](https://www.shengsuanyun.com/?from=CH_L5K542DT)开源项目团队开发并持续维护。它不是一个套壳的聊天面板，而是**「DSH 的 Agent 内核 + Cline 的编辑器生态」的真实融合**：让 DeepSeek Harness（DSH）以你正在用的 VS Code 为第一现场——选中代码、查看 diff、执行命令、落地修改，全程在编辑器里发生。

---

## 为什么选择 DSH Cline（相比原版 web 端 DSH）

原版 DSH 主要跑在浏览器里，是一个独立的 Web 对话应用。DSH Cline 保留了 DSH 完整的 Agent 能力（工具调用、MCP、Checkpoint、任务执行），同时把它真正嵌入 VS Code：

| | 原版 Web 端 DSH | DSH Cline |
| --- | --- | --- |
| 编辑体验 | 浏览器里看文本 | 直接在 VS Code 读写文件 |
| diff | 文字描述 | **Cline 式实时 diff**：一边写一边弹，改动逐行揭示 |
| 选中代码 | 手动复制粘贴 | **右键/小灯泡**一键添加、解释、优化 |
| 终端 | 独立窗口 | 「DSH Cline 服务」终端常驻，命令全程可见 |
| 上下文 | 手打 | **`@文件` 引用**，选中即带上下文 |
| MCP | ✓ | ✓ |
| Checkpoint | ✓ | ✓ |

一句话：**DSH 负责"想"，Cline 负责"落"，DSH Cline 让两者在同一个编辑器里闭环。**

## VS Code 生态深度融合（参考 Cline）

项目在实现上参考了 [Cline](https://github.com/cline/cline) 的 VS Code 生态支持，把 Cline 已验证的编辑器交互移植到 DSH 上：

- **Cline 式实时编辑 diff**：`tools/pre-execute` 写前拦截，左右虚拟文档 + 右侧滚动揭示动画，改一处看一处。
- **选中代码动作**：编辑器右键 / 小灯泡 → 添加、解释、优化三选一，自动带文件上下文。
- **`@` 上下文引用**：`@path` 自动展开为 `<file_content>` 注入 prompt，模型拿到真实文件内容。
- **编辑器直接赋能 Agent**：DSH 的 `vscode` 工具可打开文件/行、开 diff、读选中、写回生成文本。
- **终端常驻**：DSH 跑在可见的「DSH Cline 服务」终端，探活、绑定、看门狗自动拉起。

## 快速开始

1. 在 VS Code 中安装 **DSH Cline** 扩展。
2. 首次打开按引导完成 DSH 运行时安装（全程在可见终端执行）。
3. 在扩展里填入[胜算云](https://www.shengsuanyun.com/?from=CH_L5K542DT) API Key 并选择默认模型。
4. 用自然语言描述任务；选中代码后可右键「用 DSH Cline 解释/优化」。

> 🎁 **新用户福利**：通过此链接 <https://www.shengsuanyun.com/?from=CH_L5K542DT> 注册，即可领取 **6.66 元 Token 体验额度**。

## 安全与隐私

- **本地优先**：DSH Cline 使用**独立配置目录 `~/.dsh-cline`**，不触碰你已有的 DSH（`~/.dsh`）。密钥、会话记录、设置、配置树全部留在本机。
- **最小化数据**：只有在执行你交给它的任务时，DSH 才会把**为完成任务所必需的上下文（提示词、相关代码片段）**发送给你所配置的模型服务；扩展不采集、不上传你的代码、对话或任何遥测数据到第三方。
- **人工确认**：文件修改前可查看变更（实时 diff 预览）；终端命令在执行前由你确认。AI 在可控前提下工作。
- **自包含进程**：DSH 作为本地进程运行，不依赖外部常驻服务；插件随扩展自动安装，无需手工配置。
- **合规 API**：接入的模型服务坚持合规 API，杜绝逆向工程和资源稀释；企业级网关提供安全防护与 **BYOK 密钥托管**，你的密钥由你掌控。

## 关于胜算云

[胜算云（SSYCloud）](https://www.shengsuanyun.com/?from=CH_L5K542DT)是面向 AI 原生团队的**模型 API 聚合平台**，汇集 Claude、ChatGPT、Gemini 等海内外大语言模型及多媒体模型，支持统一接入与按量调用。平台坚持合规 API 服务，杜绝逆向工程和资源稀释。此外，平台提供**企业级定制网关**，包括团队成本与权限管理、智能路由、安全防护及 **BYOK 密钥托管**，并提供**发票服务**。

- 统一接入：一个 Key 调多家模型
- 按量计费：用多少算多少
- 企业网关：成本 / 权限 / 路由 / 安全 / BYOK / 发票

> 🎁 新用户通过 <https://www.shengsuanyun.com/?from=CH_L5K542DT> 注册，即可领取 **6.66 元 Token 体验额度**。

## 开源与反馈

本项目由 SSYCloud 胜算云开源项目团队维护，参考了 Cline 的 VS Code 生态实现，基于 DeepSeek Harness（DSH）构建。欢迎反馈问题与建议。

---

*DSH Cline · SSYCloud 胜算云开源项目团队*
