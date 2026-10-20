# @dsh-cline/host-services

0.8.1，适配 DSH 0.2.1-rc.2，随 DSH Cline 4.5.1 VSIX 分发 Cordis 宿主插件与浏览器客户端。DSH 提供 Agent 运行时，本插件提供 VS Code 编辑器联动；Cline 是交互参考。

宿主通过已认证的本机 HTTP bridge 调用扩展，提供写前原稿 diff、工作区 shadow Git 检查点、MCP、编辑器任务注入及同源账户/配置网关。没有 bridge 时只开放不依赖 VS Code 的能力，health 明确返回 bridge 状态、进程 instanceId 与工作区。支持的文件编辑通过 DSH 策略审批后捕获原稿；diff 是展示，不增设审批门，也不保证覆盖二进制或超大文件。

健康接口公开身份包含 `bootstrapProtocol: 1`。扩展通过绑定本机 origin 与随机 challenge 的 HMAC 请求和响应证明，取得原生浏览器认证 URL；请求不发送 bridge 密钥，普通健康响应不包含认证 URL。认证 URL 只供扩展本机代理使用，不落盘或写日志；响应禁止缓存。

客户端保留原生 DeepSeek 官方 onboarding/Models。胜算云通过`settings.models.provider-card`的`llm-pi-ai`键扩展其原生供应商卡片，仅匹配已配置的胜算云路由；登录保存到现有凭据引用，不重写模型、地址或默认选择。首次添加通过`settings.models.footer`的折叠入口，配置后隐藏，不再注册独立推荐设置页。使用新版 ctx.remote 设置与凭据服务，不直接读取用户凭据文件格式。

进入扩展时，客户端默认创建或复用与 VS Code 项目同路径的 DSH 工作区；手动选择其他 DSH 工作区或会话后，按该会话实际路径解析项目。VS Code 中查看其他目录仍由用户打开相应文件夹或窗口。嵌入式聊天输入适配 Windows Ctrl、macOS Cmd 和右键剪贴板操作。

DSH_HOME 由扩展指向独立 ~/.dsh-cline；DSH_CLINE_BRIDGE_FILE 定位本工作区桥地址。开发安装命令 pnpm --filter @dsh-cline/host-services run install:profile，先运行 build；不得安装到用户原版 ~/.dsh。

修改宿主或客户端后同步升级插件版本并重建；自动安装器按版本和必要入口完整性检查、使用锁及目录交换更新。完整项目说明见 workspace README。


公开构建只包含基础功能；RSI 仍在试验阶段，暂不公开实现。详见仓库根 PUBLIC-SOURCE.md。
