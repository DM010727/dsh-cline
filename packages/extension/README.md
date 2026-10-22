<div align="center">

# DSH Cline

**基于 DeepSeek Harness 的 VS Code AI Agent，集成 Cline 式交互与项目级 RSI。**

[在 VS Code 安装](https://marketplace.visualstudio.com/items?itemName=shengsuan-cloud.cline-shengsuan) · [加入交流群](#交流群) · [快速开始](#快速开始) · [RSI 使用指南](https://github.com/DM010727/dsh-cline/blob/main/docs/RSI-%E4%BD%BF%E7%94%A8%E6%8C%87%E5%8D%97.md) · [自定义 RSI](#按项目配置开关模型与学习流程)

</div>

> **开源范围：** GitHub 提供 DSH Cline 的 VS Code 集成、运行时管理、模型配置、Diff、剪贴板、工作区与 MCP 等基础功能源码，采用 MIT 许可。**RSI 仍处于试验阶段，暂不开源，待研究完成并稳定后开放。** 下方 RSI 介绍和演示对应扩展试验功能；从公开仓库构建的版本不包含 RSI。

![DSH Cline：DSH 任务执行、Cline 式编辑器交互与项目级 RSI；产品能力示意](https://raw.githubusercontent.com/DM010727/dsh-cline/main/packages/extension/media/readme/overview.png)

DSH Cline 使用 **DeepSeek Harness** 运行 Agent 任务，管理模型、会话和工具执行；通过 **VS Code 原生能力与 Cline 式交互**，连接代码选区、诊断、文件操作和修改预览。

**项目级 RSI** 将用户明确要求、项目知识和任务复盘接入后续任务：保存经验、按任务召回，再利用真实适用性反馈评测召回策略。它还支持比较不同学习器配置产生的后继策略，通过验证后更新版本，保留来源与回滚能力。产品目标是让 Agent 在持续协作中适应具体项目和用户的工作要求。

DSH Cline 由 [SSYCloud 胜算云](https://www.shengsuanyun.com/?from=CH_L5K542DT)开源项目团队(Daming负责人)开发。**Windows / macOS · 无需另装 Cline 扩展。**

| DSH 任务执行 | VS Code × Cline 交互 | 项目级 RSI |
| :--- | :--- | :--- |
| 模型调用、会话、工具执行与 MCP 扩展 | 选区和诊断进入任务；文件操作与原生 Diff 连接编辑器 | 明确记录、任务复盘、经验召回与真实反馈评测 |
| 沿用 DSH 审批策略，检查点保存工作区文件 | 左侧插件栏默认约半屏，复用同路径工作区 | 项目隔离、独立复盘模型、自定义规范、策略验证与回滚 |

## RSI 操作演示

**自然语言要求 → 自动识别与保存 → 斜杠命令记录、查询和提炼 → 后续会话召回。**

![RSI 对话流程：自动识别明确要求，使用 rsi-remember、rsi-list、rsi-learn，再在后续会话召回本项目经验](https://raw.githubusercontent.com/DM010727/dsh-cline/main/packages/extension/media/readme/rsi-walkthrough.gif)

*28 秒流程演示：识别、存储、命令和召回运行当前源码；会话为示例，复盘模型输出为模拟数据。这是流程演示，非 VS Code 实机录屏。下方管理页截图来自真实组件，首图中的 Diff 为能力示意。*

## VS Code 集成与 Cline 式交互

**将编辑器上下文交给 DSH，让 Agent 的文件操作通过原生界面呈现。**

1. **选中代码。** 右键或小灯泡选择「添加到 DSH Cline」「用 DSH Cline 解释」「用 DSH Cline 优化」，同时带上选区、文件路径和相交的诊断信息。
2. **并排处理任务。** 打开 DSH Cline 时，原左侧插件栏默认调整到窗口约一半宽度，代码继续在编辑器中显示；插件内部的项目与会话侧栏保持展开。进入插件时，默认创建或复用与 VS Code 项目**路径一致**的 DSH 工作区。
3. **原生 Diff 预览。** 支持的文件编辑工具获准执行后、写入前捕获真实原稿，通过 VS Code 原生 Diff 逐步展示拟议修改；命令面板可「重新打开最近一次变更 diff」。

Agent 还可以打开文件并定位到行、读取选区及通过有效选区凭据写回内容。服务输出在「DSH Cline 服务」终端查看，任务中的工具执行与结果在会话中查看。输入框支持 Windows Ctrl、macOS Cmd 剪贴板快捷键与右键操作。

<details>
<summary>工具、审批与检查点的范围</summary>

工具审批沿用 DSH 当前策略，Diff 用于查看变更；二进制、超大或无法读取的文件可能跳过预览。MCP 可接入更多工具。检查点使用独立 shadow Git 留档工作区文件，恢复前再次留档，不改动用户仓库的 index；外部服务状态不在文件检查点内。

</details>

## 项目级 RSI：经验学习与策略改进

RSI 围绕任务执行形成持续反馈流程：

1. **采集经验。** 用户明确要求可以直接记录；项目文件提供可核对的事实；任务复盘生成待采纳候选。
2. **应用经验。** 在同项目的后续任务中，按适用条件选择已生效经验，作为有来源的上下文供 Agent 使用。
3. **验证策略。** 收集真实的「适用 / 不适用」反馈，比较不同匹配方式、阈值和召回条数；训练、候选选择与最终审计使用分开的证据。
4. **更新与回滚。** 通过验证的策略按配置自动或手动发布。学习器配置要更新，还需证明其生成的后继策略优于旧学习器的后继策略；证据不足则保留当前版本。

当前验证范围是经验适用性与召回策略。项目偏好、事实和操作经验用于适应具体工作要求；模型复盘生成候选、用户采纳经验、独立评测通过，分别记录为不同事件。

### 在对话中记录与提炼经验

开启项目 RSI 后，在对话中提出明确要求，例如「这个项目以后请用中文说明改动，先说结果，再说验证方法」。RSI 自动识别、保存，并返回项目与经验 ID；自然纠正会自动记录为待确认候选，由你采纳后生效。普通闲聊不会一律存为偏好。

也可以随时用斜杠命令：

```text
/rsi-remember 解释修改时先说结果，再说如何验证
/rsi-remember --type=procedure --when=发布,打包 发布前运行现有类型检查和构建
/rsi-learn 只总结这次构建失败与修复中可复用的经验
```

`/rsi-remember` 直接保存明确经验并返回所属项目、内容和 ID。`/rsi-learn` 从当前真实对话与已保存任务证据中提炼候选，**由你采纳后才参与召回**。明确的自然语言记录要求也会在保存后给出回执。

![rsi-remember 示例：按发布与打包条件保存操作经验，并返回所属项目和记录 ID；流程示意](https://raw.githubusercontent.com/DM010727/dsh-cline/main/packages/extension/media/readme/rsi-commands.png)

| 想做什么 | 输入什么 |
| :--- | :--- |
| 找经验、看详情 | `/rsi-list [关键词]` · `/rsi-show <ID>` |
| 改内容、忘记经验 | `/rsi-edit` · `/rsi-forget <ID>` |
| 看项目状态、打开管理中心 | `/rsi-status` · `/rsi-manage` |

### 统一管理，按项目隔离

![RSI 管理中心：项目列表、经验来源、适用条件和采纳操作](https://raw.githubusercontent.com/DM010727/dsh-cline/main/packages/extension/media/readme/rsi-projects.png)

- **同项目共用。** 该项目的所有会话共用开关、配置与经验，任务按实际 DSH 会话所属项目学习和召回。
- **跨项目隔离。** 管理中心可查看本机全部已登记项目。切换查看只改变管理对象，不会把另一个项目的经验应用到当前任务。
- **经验由你管理。** 搜索、编辑、采纳、暂停、忘记，或按项目导入与导出；学习记录可追溯触发方式、模型、候选数量及实际用量。

### 按项目配置开关、模型与学习流程

![RSI 项目配置：独立开关、指定复盘模型、每日额外调用次数](https://raw.githubusercontent.com/DM010727/dsh-cline/main/packages/extension/media/readme/rsi-model-settings.png)

| 设置 | 实际含义 |
| :--- | :--- |
| **项目 RSI 开关** | 默认关闭；可以直接按默认 **0 次**开启，本地记录、查询与经验召回照常可用 |
| **复盘模型** | 跟随任务发生时的模型，或单独指定已配置的模型；API Key 统一在原生「模型」页管理 |
| **每日额外复盘次数** | 统计额外模型请求的**次数，不是 token**。0 次表示不额外请求模型提炼；失败、取消的预留也计入，按 UTC 日重置 |
| **输入与输出** | RSI 不再单独配置输入字符、输出 token 上限；复盘使用已保存的任务证据，模型能力按原生配置处理 |
| **自定义 RSI** | 配置模块、改进目标、生成指令、触发时机与部署方式；在扩展内导入、导出 RSI Spec v1 YAML |

“0 次”只关闭额外复盘请求，正常任务模型调用仍按供应商计费，召回经验也会占用任务上下文。前台任务优先，暂停 RSI 会取消在途复盘。

RSI 用真实的「适用 / 不适用」反馈评测经验召回策略，证据不足时保留现有版本，并支持已验证版本的发布与回滚。当前改进范围是**项目经验的组织、选择与应用**，不训练底层模型权重。完整操作见 [RSI 使用指南](https://github.com/DM010727/dsh-cline/blob/main/docs/RSI-%E4%BD%BF%E7%94%A8%E6%8C%87%E5%8D%97.md)。

## 快速开始

1. **安装扩展，打开项目。** 安装 DSH Cline，在 VS Code 打开可信任的项目文件夹。需要 Node.js **22.19 及以上的 22.x，或 24 及以上版本**。
2. **安装独立运行时。** 按首次引导操作，或执行「DSH Cline: 安装／升级 DSH 运行时」。当前锁定 **DSH 0.2.1-rc.2（next）**，无需先全局安装。
3. **配置模型。** 新用户默认走 **DeepSeek 官方**引导；其他供应商在原生「模型」页配置。**胜算云为可选推荐供应商**，添加、登录与重新登录均在模型页，保留已有默认选择。
4. **开始一个任务。** 描述需求，或选中代码右键解释、优化。开启该项目 RSI 后，可在对话中提出明确的长期要求，也可用 `/rsi-remember` 直接记录、`/rsi-learn` 提炼本次任务经验。

<details>
<summary>本地数据、模型上下文与工作区范围</summary>

配置、会话和 RSI 数据使用独立 `~/.dsh-cline`，可由 `DSH_CLINE_HOME` 指定其他独立目录。不向原版 `~/.dsh` 安装插件或迁移凭据。RSI 保存到 `rsi/<workspace-hash>/state.json`；项目文件事实绑定内容指纹，源文件变化后旧事实失效。

在 DSH 切换工作区或会话时，RSI 跟随该会话实际项目。管理中心切换项目只改变管理对象；要在编辑器中操作另一项目，请在 VS Code 打开对应目录或窗口。

任务上下文、召回经验和模型复盘所需的有界证据会发送给所选模型。本地保存不等于内容从不外发。暂停或忘记停止后续新应用，不能撤回已发送的请求。RSI 反馈与原生赞踩分别处理；本扩展在用户未显式配置时默认关闭整会话日志贡献，保留已有选择。原生反馈可能附带会话记录，请按其界面说明决定。

</details>

## 4.5.5 更新

- RSI 自动保存明确要求与纠正候选；修复多句要求截断，以及 `/rsi-learn` 误报没有可学习对话。
- 加强项目与开关隔离；经验修改、暂停或忘记后，后续步骤会收到失效通知。
- 修复复盘模型选择、任务状态与管理中心切换问题；保存失败会明确提示。
- 保留原左侧插件栏约半屏布局，内部项目与会话侧栏保持展开。
- 打包强制重新构建，并检查最终安装包的文字、图片、快捷键及右键复制粘贴链路。

## 交流群

微信扫码加入 **DSH · 项目级 RSI 心得交流群**，交流使用经验、反馈问题。

<a href="https://raw.githubusercontent.com/DM010727/dsh-cline/main/packages/extension/media/readme/community-qr.jpg"><img src="https://raw.githubusercontent.com/DM010727/dsh-cline/main/packages/extension/media/readme/community-qr-cropped.png" alt="DSH 项目级 RSI 心得交流群微信二维码" width="220" height="220"></a>

二维码有效至 10 月 29 日前，点击可查看原图。

## 开源与致谢

[公开基础功能源码](https://github.com/DM010727/dsh-cline) · [问题反馈](https://github.com/DM010727/dsh-cline/issues) · **公开源码采用 MIT License；RSI 试验实现暂未公开。**

感谢 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 提供 Agent 内核、模型调用、会话与工具运行，感谢 [Cline](https://github.com/cline/cline) 的编辑器交互实践与开源参考。本扩展使用 DSH 运行时，无需另装 Cline。

DSH Cline 由 [SSYCloud 胜算云](https://www.shengsuanyun.com/?from=CH_L5K542DT)开源项目团队(Daming负责人)开发。
