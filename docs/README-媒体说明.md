# README 展示素材

项目 README 和商店 README 复用 `packages/extension/media/readme/`，素材随 VSIX 分发。

| 文件 | 内容与来源 |
| --- | --- |
| `overview.png` | 产品概览示意；使用现有项目图标、示例代码与示例经验，并标明非运行截图 |
| `rsi-projects.png` | 当前版本 `RsiManager`、`RsiMemories` 及实际 CSS；两个虚构项目、明确偏好与候选经验 |
| `rsi-model-settings.png` | 当前版本 `RsiPanel`，展示项目开关、指定复盘模型、每日次数及移除两项长度限制后的界面 |
| `rsi-commands.png` | 对话流程示意；实际 `/rsi-remember` 命令保存条件性经验后返回的结果与项目存储状态 |
| `rsi-walkthrough.gif` | 28 秒、7 个步骤；自然语言明确要求、自动保存、斜杠命令记录和查询、提炼候选、后续会话召回与项目隔离 |

管理页静态截图通过离线 React 组件夹具生成，接口响应来自合成数据。对话流程演示则在独立临时项目运行当前源码的消息钩子、意图识别、命令处理器、项目存储与跨会话召回，再用浏览器排版实际结果；复盘调度使用模拟模型输出。示例路径缩写为 `/projects/...`，记录 ID 来自实际存储。

这些素材不启动 DSH、不调用真实模型、不使用用户会话、凭据或项目目录。GIF 明确标注为流程示意，非 VS Code 实机录屏；不能据此声称真实任务学习效果已获验证。概览中的 Diff 是产品能力示意，原生 VS Code 的实际视觉效果由用户安装验收。

## 商店图片地址

项目和商店 README 的全部图片均直接使用 `https://raw.githubusercontent.com/DM010727/dsh-cline/main/packages/extension/media/readme/` 下的完整 HTTPS URL。图片与文档需要一起同步到 GitHub；`vsce.baseImagesUrl` 保留为后续相对链接的兜底设置。

**上架带新图的商店说明前，需要将以上五个素材同步到公开仓库的对应路径。仅上传 VSIX 不会把新素材上传到 GitHub。** 重新生成文档或素材不会自动更新已有 VSIX，也不会自动 push；打包和公开上传须按用户指令执行。若仓库主分支或媒体托管位置改变，应更新 `baseImagesUrl` 后重新打包。

RSI 仍处于试验阶段，暂不公开实现源码、编译产物、源码映射及内部规范。公开仓库保留面向用户的功能说明和演示素材；从公开源码构建的基础版本不含 RSI。
