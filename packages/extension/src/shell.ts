import type { SidecarStatus, RuntimeStatus } from '@dsh-cline/protocol'
import { DSH_VERSION } from './runtime'

/**
 * Webview shell HTML: a CSP-fenced iframe hosting the sidecar-served DSH web
 * client, plus a relay between the extension host and whatever runs inside
 * the iframe (Gate 2 adds the DSH-side client plugin that speaks the relay).
 *
 * Channel literals duplicate @dsh-cline/protocol constants because this file
 * is emitted as inline HTML, not bundled module code.
 * @param status - current sidecar snapshot.
 * @param version - extension version, shown as a build marker.
 * @returns full HTML document for `webview.html`.
 */
export function buildShellHtml(status: SidecarStatus, version = ''): string {
  const ready = status.state === 'ready' && status.url !== undefined
  const browserUrl = status.browserUrl ?? status.url
  const frameSrc = ready ? new URL(browserUrl as string).origin : ''
  const overlay = ready
    ? ''
    : [
        '<div class="overlay">',
        '  <div class="mark">' + (status.state === 'failed' ? '✕' : '◐') + '</div>',
        '  <div class="title">' + overlayTitle(status) + '</div>',
        status.detail === undefined ? '' : '  <pre class="detail">' + escapeHtml(status.detail) + '</pre>',
        status.state === 'failed' ? '  <button id="retry">重试</button>' : '',
        status.state === 'failed' ? '  <div class="ver" style="max-width:80%;text-align:center;">详细输出请查看 VS Code 终端「DSH Cline 服务」。</div>' : '',
        '  <div class="ver">DSH Cline v' + escapeHtml(version) + '</div>',
        '</div>',
      ].filter(part => part !== '').join('\n')
  return [
    '<!DOCTYPE html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; frame-src ' + (frameSrc === '' ? '\'none\'' : frameSrc) + '; script-src \'unsafe-inline\'; style-src \'unsafe-inline\';">',
    '<title>DSH Cline</title>',
    '<style>',
    'html, body { margin: 0; height: 100%; background: var(--vscode-sideBar-background, #1c1c22); color: var(--vscode-foreground, #e8e8ec); font-family: system-ui, "Segoe UI", "Microsoft YaHei", sans-serif; }',
    '#dsh-frame { border: 0; width: 100%; height: 100%; display: block; }',
    '.overlay { height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; padding: 24px; box-sizing: border-box; }',
    '.mark { font-size: 28px; color: var(--vscode-focusBorder, #7aa2f7); }',
    '.title { font-size: 14px; color: var(--vscode-foreground, #c8c8d0); }',
    '.detail { max-width: 100%; max-height: 40vh; overflow: auto; font-size: 11px; color: var(--vscode-descriptionForeground, #a0a0aa); background: var(--vscode-editorWidget-background, #23232b); border-radius: 6px; padding: 10px 12px; white-space: pre-wrap; word-break: break-all; margin: 0; }',
    '.ver { font-size: 10px; color: var(--vscode-disabledForeground, #6a6a74); }',
    '#retry { background: var(--vscode-focusBorder, #7aa2f7); color: var(--vscode-button-foreground, #16161e); border: 0; border-radius: 6px; padding: 6px 18px; font-size: 13px; cursor: pointer; }',
    '</style>',
    '</head>',
    '<body>',
    ready ? '<iframe id="dsh-frame" src="' + escapeHtml(browserUrl as string) + '" referrerpolicy="no-referrer"></iframe>' : '<iframe id="dsh-frame"></iframe>',
    overlay,
    '<script>',
    '(function () {',
    '  var vscode = acquireVsCodeApi();',
    '  var frameOrigin = ' + JSON.stringify(frameSrc).replace(/</g, '\\u003c') + ';',
    '  window.addEventListener("message", function (ev) {',
    '    var frame = document.getElementById("dsh-frame");',
    '    var data = ev.data;',
    '    if (!data || typeof data !== "object") return;',
    '    if ((ev.source === null || ev.source === window || ev.source === window.parent) && data.channel === "dsh-cline.shell" && data.type === "bridge" && data.payload !== undefined) {',
    '      if (frameOrigin && frame && frame.contentWindow) frame.contentWindow.postMessage(data.payload, frameOrigin);',
    '      return;',
    '    }',
    '    if (!frame || ev.source !== frame.contentWindow || ev.origin !== frameOrigin) return;',
    '    if (data.channel === "dsh-cline.host-service") {',
    '      vscode.postMessage(data);',
    '      return;',
    '    }',
    '  });',
    '  var retry = document.getElementById("retry");',
    '  if (retry) retry.onclick = function () { vscode.postMessage({ channel: "dsh-cline.shell", type: "retry" }); };',
    '  vscode.postMessage({ channel: "dsh-cline.shell", type: "shell-ready" });',
    '})();',
    '</script>',
    '</body>',
    '</html>',
    '',
  ].join('\n')
}

function overlayTitle(status: SidecarStatus): string {
  if (status.state === 'failed') return 'DSH Sidecar 启动失败'
  if (status.state === 'stopped') return 'DSH Sidecar 已停止'
  return 'DSH Sidecar'
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

/**
 * "DSH 启动中" page shown while the terminal-resident service boots (or is
 * auto-revived after it died). Guide-style rather than a bare overlay: the
 * first boot can take a minute or two, so the user needs to know the startup
 * happens in a visible terminal and that closing that terminal is the one way
 * to break it.
 * @param status - current sidecar snapshot (its detail becomes the status line).
 * @param version - extension version, shown as a build marker.
 * @returns full HTML document for `webview.html`.
 */
export function buildStartingHtml(status: SidecarStatus, version = ''): string {
  return [
    '<!DOCTYPE html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\'; style-src \'unsafe-inline\';">',
    '<title>DSH Cline - 启动中</title>',
    '<style>',
    'html, body { margin: 0; height: 100%; background: var(--vscode-sideBar-background, #1c1c22); color: var(--vscode-foreground, #e8e8ec); font-family: system-ui, "Segoe UI", "Microsoft YaHei", sans-serif; }',
    '.wrap { height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px; padding: 24px; box-sizing: border-box; }',
    '.spin { width: 36px; height: 36px; border: 3px solid var(--vscode-panel-border, #2e2e3a); border-top-color: var(--vscode-focusBorder, #7aa2f7); border-radius: 50%; animation: rot 1s linear infinite; }',
    '@keyframes rot { to { transform: rotate(360deg); } }',
    '.title { font-size: 15px; }',
    '.detail { font-size: 12px; color: var(--vscode-descriptionForeground, #a0a0aa); text-align: center; }',
    '.tips { font-size: 12px; color: var(--vscode-descriptionForeground, #a0a0aa); background: var(--vscode-editorWidget-background, #23232b); border-radius: 8px; padding: 10px 14px; max-width: 460px; }',
    '.tips li { margin: 4px 0; }',
    'button { background: var(--vscode-focusBorder, #7aa2f7); color: var(--vscode-button-foreground, #16161e); border: 0; border-radius: 6px; padding: 6px 18px; font-size: 13px; cursor: pointer; }',
    '.ver { font-size: 10px; color: var(--vscode-disabledForeground, #6a6a74); }',
    '</style>',
    '</head>',
    '<body>',
    '<div class="wrap">',
    '  <div class="spin"></div>',
    '  <div class="title">DSH 启动中…</div>',
    status.detail === undefined ? '' : '  <div class="detail">' + escapeHtml(status.detail) + '</div>',
    '  <ul class="tips">',
    '    <li>DSH 正在 VS Code 终端（「DSH Cline 服务」）中启动，输出全程可见。</li>',
    '    <li>首次启动可能需要 1-2 分钟（要初始化独立配置目录），请耐心等待。</li>',
    '    <li>DSH Cline 使用独立配置目录 ~/.dsh-cline，不影响你自己的 DSH（~/.dsh）。</li>',
    '    <li>请勿关闭该终端；关闭后插件会自动重新拉起。</li>',
    '  </ul>',
    '  <button id="show-term">打开 DSH 终端</button>',
    version === '' ? '' : '  <div class="ver">DSH Cline v' + escapeHtml(version) + '</div>',
    '</div>',
    '<script>',
    '(function () {',
    '  var vscode = acquireVsCodeApi();',
    '  var btn = document.getElementById("show-term");',
    '  if (btn) btn.onclick = function () { vscode.postMessage({ channel: "dsh-cline.guide", type: "show-terminal" }); };',
    '})();',
    '</script>',
    '</body>',
    '</html>',
    '',
  ].filter(part => part !== '').join('\n')
}

/**
 * Onboarding guide shown instead of the shell when no usable dsh runtime is
 * detected or dependency verification fails. Install actions run in a
 * visible VS Code terminal so the user watches progress and npm failures.
 * @param rt - latest runtime detection snapshot.
 * @returns full HTML document for `webview.html`.
 */
export function buildGuideHtml(rt: RuntimeStatus, version = ''): string {
  const steps: string[] = []
  if (!rt.node) {
    steps.push(step('1', '安装 Node.js / Install Node.js', '需要 Node.js 22.19+（22 系列）或 24 及以上版本。请选择：', [
      '<button data-act="install-node">在终端中安装（winget）</button>',
      '<button class="ghost" data-act="open-node-page">打开官网下载页</button>',
      '<span class="hint">终端安装命令：winget install OpenJS.NodeJS.LTS。装好后请完整退出所有 VS Code 窗口并重新打开，让扩展读取新的 Node/npm PATH。</span>',
    ]))
    steps.push(step('2', '安装 DSH / Install DSH', '安装 Node 后完整重启 VS Code，再按本页引导安装专用 DSH。', []))
  } else {
    steps.push(step('1', '安装／修复 DSH / Install or repair DSH', '扩展会在独立目录安装经过依赖校验的 DSH。安装过程在终端可见；无法访问 npmjs.org 时可选择国内镜像：', [
      '<button data-act="install">安装／修复专用 DSH</button>',
      '<button class="ghost" data-act="install-mirror">国内镜像安装（未翻墙）</button>',
      '<span class="hint">DSH ' + DSH_VERSION + ' · ~/.dsh-cline/runtime · 保留原版 DSH 配置</span>',
    ]))
  }
  steps.push(step(rt.node ? '2' : '3', '重新检测并启动 / Verify & start', '安装完成后（终端出现新的提示符即完成），点击检测：', [
    '<button data-act="recheck">重新检测并启动</button>',
  ]))

  const banner = rt.compatible === false
    ? '<div class="banner warn">' + escapeHtml(rt.issue ?? ('请安装本版适配的 DSH ' + DSH_VERSION + '（next 频道）专用运行时，再重新检测。')) + '</div>'
    : ''

  const troubleshoot = [
    '<details class="ts"><summary>安装失败/未生效？常见排查</summary>',
    '<ul>',
    '<li><b>终端报错 network / ECONNREFUSED</b>：代理或镜像问题，可点击上方国内镜像安装按钮，安装本版适配的 DSH ' + DSH_VERSION + '。</li>',
    '<li><b>权限报错 EPERM / EACCES</b>：先停止本工作区的旧 DSH 服务，检查独立配置目录的写入权限后重试。</li>',
    '<li><b>安装成功但校验失败</b>：查看安装终端错误，点击安装／修复后重新检测。修改或缺失的安全补丁依赖不会被放行。</li>',
    '<li>扩展使用独立运行时，不调用全局或 npx 缓存里的 DSH；原来的 DSH 安装保持可单独使用。</li>',
    '</ul></details>',
  ].join('')

  return [
    '<!DOCTYPE html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\'; style-src \'unsafe-inline\';">',
    '<title>DSH Cline - 安装引导</title>',
    '<style>',
    'html, body { margin: 0; height: 100%; background: var(--vscode-sideBar-background, #1c1c22); color: var(--vscode-foreground, #e8e8ec); font-family: system-ui, "Segoe UI", "Microsoft YaHei", sans-serif; }',
    '.wrap { height: 100%; overflow: auto; padding: 24px; box-sizing: border-box; display: flex; flex-direction: column; gap: 16px; }',
    'h1 { font-size: 17px; margin: 0; }',
    '.sub { font-size: 12px; color: var(--vscode-descriptionForeground, #a0a0aa); margin: 0; }',
    '.banner { font-size: 12px; border-radius: 8px; padding: 10px 12px; }',
    '.banner.warn { background: var(--vscode-inputValidation-warningBackground, #3a2f16); color: var(--vscode-inputValidation-warningForeground, #e8d9a0); border: 1px solid var(--vscode-inputValidation-warningBorder, #6b5a1e); }',
    '.step { background: var(--vscode-editorWidget-background, #23232b); border-radius: 10px; padding: 14px 16px; }',
    '.step h2 { font-size: 13px; margin: 0 0 8px; display: flex; align-items: center; gap: 8px; }',
    '.step .num { width: 20px; height: 20px; border-radius: 50%; background: var(--vscode-focusBorder, #7aa2f7); color: var(--vscode-button-foreground, #16161e); display: inline-flex; align-items: center; justify-content: center; font-size: 12px; flex: none; }',
    '.step p { font-size: 12px; color: var(--vscode-foreground, #c8c8d0); margin: 0 0 10px; }',
    '.step .row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }',
    'button { background: var(--vscode-focusBorder, #7aa2f7); color: var(--vscode-button-foreground, #16161e); border: 0; border-radius: 6px; padding: 7px 16px; font-size: 13px; cursor: pointer; }',
    'button:hover { background: var(--vscode-focusBorder, #8fb1f9); }',
    'button.ghost { background: transparent; color: var(--vscode-focusBorder, #7aa2f7); border: 1px solid var(--vscode-focusBorder, #7aa2f7); }',
    '.hint { font-size: 11px; color: var(--vscode-descriptionForeground, #a0a0aa); font-family: Consolas, monospace; word-break: break-all; }',
    '.ts { font-size: 12px; color: var(--vscode-descriptionForeground, #a0a0aa); }',
    '.ts summary { cursor: pointer; color: var(--vscode-foreground, #c8c8d0); }',
    '.ts code { background: var(--vscode-editorWidget-background, #23232b); border-radius: 4px; padding: 1px 5px; font-size: 11px; word-break: break-all; }',
    '.ver { font-size: 10px; color: var(--vscode-disabledForeground, #6a6a74); }',
    '</style>',
    '</head>',
    '<body>',
    '<div class="wrap">',
    '  <div>',
    '    <h1>欢迎使用 DSH Cline</h1>',
    '    <p class="sub">开始前需要安装 DSH 运行时。按下面步骤操作，全程在本机完成。</p>',
    '  </div>',
    banner,    ...steps,
    troubleshoot,
    version === '' ? '' : '  <div class="ver">DSH Cline v' + escapeHtml(version) + '</div>',
    '</div>',
    '<script>',
    '(function () {',
    '  var vscode = acquireVsCodeApi();',
    '  document.addEventListener("click", function (ev) {',
    '    var btn = ev.target.closest("button[data-act]");',
    '    if (!btn) return;',
    '    vscode.postMessage({ channel: "dsh-cline.guide", type: btn.getAttribute("data-act") });',
    '    if (btn.getAttribute("data-act") === "recheck") btn.textContent = "检测中…";',
    '  });',
    '})();',
    '</script>',
    '</body>',
    '</html>',
    '',
  ].filter(part => part !== '').join('\n')
}

function step(num: string, title: string, desc: string, controls: string[]): string {
  const rows = controls.length === 0
    ? ''
    : '  <div class="row">' + controls.map(c => '  ' + c).join('\n') + '\n  </div>'
  return [
    '  <div class="step">',
    '    <h2><span class="num">' + num + '</span>' + escapeHtml(title) + '</h2>',
    '    <p>' + escapeHtml(desc) + '</p>',
    rows,
    '  </div>',
  ].filter(part => part !== '').join('\n')
}
