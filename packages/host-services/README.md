# @dsh-cline/host-services

DSH Cordis 插件（方案 F 的 DSH 侧半）：当环境带 DSH_CLINE_BRIDGE（DSH Cline 扩展启动 sidecar 时注入）时，提供 vscodeHost 服务并把调用经 loopback HTTP 桥转发到 VS Code 扩展宿主；同时挂载诊断路由 GET /dsh-cline/health。

不带该环境变量时插件保持休眠，普通 dsh web 组合不受影响。