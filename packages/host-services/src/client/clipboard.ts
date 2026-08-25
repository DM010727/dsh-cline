/**
 * Clipboard bridge + right-click menu for the DSH web client, which runs inside
 * the VS Code webview's <iframe>.
 *
 * Two cross-platform problems this solves:
 *  - VS Code webviews swallow Cmd/Ctrl+C/V/X/A for an embedded <iframe>, so the
 *    native shortcuts never reach DSH inputs (macOS especially).
 *  - The iframe's native right-click context menu (with paste) is unavailable
 *    inside the webview.
 *
 * Keydown/contextmenu are handled HERE — inside the document that actually
 * receives them (a focused iframe never bubbles events to the parent webview,
 * so a handler in the shell cannot work). Clipboard ops are routed to the
 * extension host's `vscode.env.clipboard` (reliable on every OS) through the
 * shell relay: `window.parent` carries `dsh-cline.host-service` up, and the
 * shell relays a `dsh-cline.shell/bridge` payload back down for paste text.
 *
 * @module @dsh-cline/host-services/clipboard
 */

/** Route one clipboard op to the extension host via the parent shell relay. */
function post(op: 'copy' | 'cut' | 'paste', text = ''): void {
  try {
    window.parent.postMessage({ channel: 'dsh-cline.host-service', type: 'clipboard', op, text }, '*')
  } catch { /* parent unavailable: nothing to bridge to */ }
}

function isEditable(el: Element | null): boolean {
  if (!el) return false
  return el.tagName === 'INPUT'
    || el.tagName === 'TEXTAREA'
    || (el as HTMLElement).isContentEditable === true
}

function selectionText(): string {
  return window.getSelection()?.toString() ?? ''
}

/** Set a controlled input's value via the NATIVE setter so React's value
 * tracker sees it (assigning `.value` directly bypasses React, so a re-render
 * reverts the field to the old — blank — state until the user types). */
function setNativeValue(input: HTMLInputElement | HTMLTextAreaElement, value: string, caret: number): void {
  const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
  if (setter) setter.call(input, value)
  input.setSelectionRange(caret, caret)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

/** Paste `text` into the focused editable (or fall back to execCommand). */
function insertText(text: string): void {
  const el = document.activeElement as HTMLElement | null
  if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {
    const input = el as HTMLInputElement
    const s = input.selectionStart ?? input.value.length
    const e = input.selectionEnd ?? input.value.length
    setNativeValue(input, input.value.slice(0, s) + text + input.value.slice(e), s + text.length)
  } else if (el && el.isContentEditable) {
    el.focus()
    document.execCommand('insertText', false, text)
  } else {
    document.execCommand('insertText', false, text)
  }
}

/** Remove the current selection (cut from a controlled input / element). */
function clearSelection(): void {
  const el = document.activeElement as HTMLInputElement | null
  if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {
    const s = el.selectionStart ?? el.value.length
    const e = el.selectionEnd ?? el.value.length
    setNativeValue(el, el.value.slice(0, s) + el.value.slice(e), s)
  } else {
    const sel = window.getSelection()
    if (sel && sel.rangeCount) sel.deleteFromDocument()
  }
}

/** Install the clipboard bridge listeners. Idempotent per document load. */
export function installClipboard(): void {
  // ---- Keyboard shortcuts (Cmd/Ctrl+C/V/X/A) --------------------------------
  document.addEventListener('keydown', (ev: KeyboardEvent) => {
    if (!(ev.metaKey || ev.ctrlKey)) return
    const k = ev.key.toLowerCase()
    if (k !== 'c' && k !== 'v' && k !== 'x' && k !== 'a') return
    ev.preventDefault()
    ev.stopPropagation()
    if (k === 'a') { document.execCommand('selectAll'); return }
    if (k === 'c') { post('copy', selectionText()); return }
    if (k === 'x') { post('cut', selectionText()); clearSelection(); return }
    post('paste')
  }, true)

  // ---- Right-click menu (paste / copy / cut / select-all) -------------------
  let menu: HTMLElement | null = null
  const removeMenu = (): void => { if (menu) { menu.remove(); menu = null } }
  const showMenu = (x: number, y: number): void => {
    removeMenu()
    menu = document.createElement('div')
    menu.style.cssText = 'position:fixed;z-index:2147483647;background:#252530;border:1px solid #3a3a46;border-radius:8px;padding:4px;box-shadow:0 8px 24px rgba(0,0,0,.45);font:13px system-ui,"Segoe UI","Microsoft YaHei",sans-serif;color:#e8e8ec;min-width:120px;'
    const addItem = (label: string, fn: () => void): void => {
      const b = document.createElement('div')
      b.textContent = label
      b.style.cssText = 'padding:6px 14px;border-radius:5px;cursor:pointer;white-space:nowrap;'
      b.addEventListener('mouseenter', () => { b.style.background = '#33323f' })
      b.addEventListener('mouseleave', () => { b.style.background = 'transparent' })
      b.addEventListener('click', () => { removeMenu(); fn() })
      menu!.appendChild(b)
    }
    addItem('粘贴', () => post('paste'))
    addItem('复制', () => post('copy', selectionText()))
    addItem('剪切', () => { post('cut', selectionText()); clearSelection() })
    addItem('全选', () => document.execCommand('selectAll'))
    document.body.appendChild(menu)
    const rect = menu.getBoundingClientRect()
    menu.style.left = Math.max(0, Math.min(x, window.innerWidth - rect.width - 8)) + 'px'
    menu.style.top = Math.max(0, Math.min(y, window.innerHeight - rect.height - 8)) + 'px'
  }
  document.addEventListener('contextmenu', (ev: MouseEvent) => {
    ev.preventDefault()
    ev.stopPropagation()
    showMenu(ev.clientX, ev.clientY)
  })
  document.addEventListener('mousedown', (ev: MouseEvent) => {
    if (menu && !menu.contains(ev.target as Node)) removeMenu()
  })
  document.addEventListener('scroll', removeMenu, true)
  window.addEventListener('blur', removeMenu)

  // ---- Paste result coming back from the extension host ---------------------
  window.addEventListener('message', (ev: MessageEvent) => {
    const d = ev.data as { channel?: string; op?: string; text?: string } | null
    if (d && d.channel === 'clipboard-result' && d.op === 'paste') {
      insertText(String(d.text ?? ''))
    }
  })
}
