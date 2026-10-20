/** Clipboard relay scoped to this plugin and the actual embedding webview. */
import { isShellMessage, shellOrigin } from './shell-message.ts'

type Operation = 'copy' | 'cut' | 'paste'
type TextInput = HTMLInputElement | HTMLTextAreaElement
interface Snapshot {
  element: HTMLElement | null
  text: string
  value?: string
  start?: number
  end?: number
  range?: Range
}
let disposeCurrent: (() => void) | undefined

function inputOf(element: HTMLElement | null): TextInput | undefined {
  if (element instanceof HTMLTextAreaElement) return element
  if (element instanceof HTMLInputElement && ['text', 'search', 'url', 'tel', 'password'].includes(element.type)) return element
  return undefined
}
function editable(element: HTMLElement | null): boolean {
  const input = inputOf(element)
  return input !== undefined ? !input.disabled && !input.readOnly : element?.isContentEditable === true
}
function capture(): Snapshot {
  const element = document.activeElement as HTMLElement | null
  const input = inputOf(element)
  if (input !== undefined) {
    const start = input.selectionStart ?? input.value.length
    const end = input.selectionEnd ?? start
    return { element, value: input.value, start, end, text: input.type === 'password' ? '' : input.value.slice(start, end) }
  }
  const selection = window.getSelection()
  return { element, text: selection?.toString() ?? '', range: selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : undefined }
}
function sameTarget(snapshot: Snapshot): boolean {
  if (!snapshot.element?.isConnected || document.activeElement !== snapshot.element || !editable(snapshot.element)) return false
  const input = inputOf(snapshot.element)
  if (input !== undefined) return input.value === snapshot.value && input.selectionStart === snapshot.start && input.selectionEnd === snapshot.end
  const selection = window.getSelection()
  if (snapshot.range === undefined || !selection?.rangeCount) return false
  const live = selection.getRangeAt(0)
  return live.startContainer === snapshot.range.startContainer && live.startOffset === snapshot.range.startOffset
    && live.endContainer === snapshot.range.endContainer && live.endOffset === snapshot.range.endOffset
    && live.toString() === snapshot.text
}
function setInput(input: TextInput, snapshot: Snapshot, text: string, inputType: string): void {
  if (!sameTarget(snapshot)) return
  const start = snapshot.start ?? 0
  const end = snapshot.end ?? start
  // Honor the browser input limit just as a native paste does.
  const available = input.maxLength < 0 ? text.length : Math.max(0, input.maxLength - (input.value.length - (end - start)))
  const inserted = text.slice(0, available)
  const before = new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType, data: inserted })
  if (!input.dispatchEvent(before)) return
  const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
  if (setter === undefined) return
  setter.call(input, input.value.slice(0, start) + inserted + input.value.slice(end))
  input.setSelectionRange(start + inserted.length, start + inserted.length)
  input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType, data: inserted }))
}
function applyEdit(snapshot: Snapshot, text: string, inputType: string): void {
  if (!sameTarget(snapshot)) return
  const input = inputOf(snapshot.element)
  if (input !== undefined) { setInput(input, snapshot, text, inputType); return }
  if (snapshot.range === undefined || !snapshot.element?.contains(snapshot.range.commonAncestorContainer)) return
  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(snapshot.range)
  // DSH's Lexical composer owns paste/cut through editor commands. Native
  // insertText bypasses that path and can be reverted by its next state commit.
  // Supply plain text only; an editor cancelling the event has consumed it.
  if (typeof ClipboardEvent !== 'undefined' && typeof DataTransfer !== 'undefined') {
    const data = new DataTransfer()
    data.setData('text/plain', inputType === 'deleteByCut' ? snapshot.text : text)
    const event = new ClipboardEvent(inputType === 'deleteByCut' ? 'cut' : 'paste', { bubbles: true, cancelable: true, clipboardData: data })
    if (!snapshot.element.dispatchEvent(event)) return
  }
  document.execCommand('insertText', false, text)
}
function selectAll(): void {
  const element = document.activeElement as HTMLElement | null
  const input = inputOf(element)
  if (input !== undefined) { input.select(); return }
  if (element?.isContentEditable) {
    const range = document.createRange()
    range.selectNodeContents(element)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
  }
}

/** Returns a disposer; remounting never accumulates document listeners. */
export function installClipboard(): () => void {
  disposeCurrent?.()
  if (window.parent === window) return () => {}
  const controller = new AbortController()
  const { signal } = controller
  const pending = new Map<string, { op: Operation; snapshot: Snapshot; timeout: ReturnType<typeof setTimeout> }>()
  const request = (op: Operation): void => {
    const snapshot = capture()
    if (op === 'paste' && !editable(snapshot.element)) return
    if ((op === 'copy' || op === 'cut') && snapshot.text === '') return
    if (op === 'cut' && !editable(snapshot.element)) return
    // Some VS Code carriers deliver both the shortcut and an empty native
    // paste event. They must share one OS read and one insertion.
    if (op === 'paste' && [...pending.values()].some(item => item.op === op && item.snapshot.element === snapshot.element && sameTarget(item.snapshot))) return
    const requestId = crypto.randomUUID()
    const timeout = setTimeout(() => { pending.delete(requestId) }, 15_000)
    pending.set(requestId, { op, snapshot, timeout })
    try {
      window.parent.postMessage({
        channel: 'dsh-cline.host-service', type: 'clipboard', op, text: snapshot.text, requestId,
      }, shellOrigin())
    } catch { clearTimeout(timeout); pending.delete(requestId) }
  }

  document.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.altKey || event.isComposing) return
    const key = event.key.toLowerCase()
    const shiftInsert = key === 'insert' && event.shiftKey && !event.metaKey && !event.ctrlKey
    if (!shiftInsert && (!(event.metaKey || event.ctrlKey) || !['c', 'v', 'x', 'a'].includes(key) || event.shiftKey && key !== 'v')) return
    const snapshot = capture()
    if (key === 'a') {
      if (inputOf(snapshot.element) === undefined && !editable(snapshot.element)) return
    } else if (key === 'v' || shiftInsert) {
      if (!editable(snapshot.element)) return
    } else {
      if (snapshot.text === '' || (key === 'x' && !editable(snapshot.element))) return
    }
    event.preventDefault()
    event.stopPropagation()
    if (key === 'a') selectAll()
    else request(key === 'c' ? 'copy' : key === 'x' ? 'cut' : 'paste')
  }, { capture: true, signal })

  document.addEventListener('paste', (event: ClipboardEvent) => {
    // Preserve genuine browser text/file/image paste. VS Code may consume
    // Ctrl/Cmd+V itself and instead send a paste event with no readable data.
    // Our synthetic editor event must never recursively request the clipboard.
    if (!event.isTrusted || !editable(document.activeElement as HTMLElement | null)) return
    if (event.clipboardData && (event.clipboardData.types.length || event.clipboardData.files.length)) return
    event.preventDefault()
    event.stopPropagation()
    request('paste')
  }, { capture: true, signal })

  let menu: HTMLElement | undefined
  const removeMenu = (): void => { menu?.remove(); menu = undefined }
  document.addEventListener('contextmenu', (event: MouseEvent) => {
    const target = event.target instanceof HTMLElement ? event.target : null
    const editor = target?.closest('input, textarea, [contenteditable="true"], [contenteditable=""]') as HTMLElement | null
    if (editor && document.activeElement !== editor) editor.focus({ preventScroll: true })
    const snapshot = capture()
    if (!editable(snapshot.element) && snapshot.text === '') return
    event.preventDefault()
    event.stopPropagation()
    removeMenu()
    menu = document.createElement('div')
    menu.style.cssText = 'position:fixed;z-index:2147483647;background:#252530;border:1px solid #3a3a46;border-radius:8px;padding:4px;box-shadow:0 8px 24px #0007;font:13px system-ui;color:#e8e8ec;min-width:120px'
    // Keep the input focused and its selection intact while choosing a menu item.
    menu.addEventListener('mousedown', event => { event.preventDefault() })
    const add = (label: string, action: () => void, disabled = false): void => {
      const button = document.createElement('button')
      button.type = 'button'
      button.textContent = label
      button.disabled = disabled
      button.style.cssText = 'display:block;width:100%;text-align:left;padding:6px 14px;border:0;border-radius:5px;background:transparent;color:inherit;cursor:pointer'
      button.addEventListener('click', () => { removeMenu(); action() })
      menu!.appendChild(button)
    }
    add('粘贴', () => { request('paste') }, !editable(snapshot.element))
    add('复制', () => { request('copy') }, snapshot.text === '')
    add('剪切', () => { request('cut') }, !editable(snapshot.element) || snapshot.text === '')
    add('全选', selectAll, inputOf(snapshot.element) === undefined && !editable(snapshot.element))
    document.body.appendChild(menu)
    const bounds = menu.getBoundingClientRect()
    menu.style.left = Math.max(0, Math.min(event.clientX, window.innerWidth - bounds.width - 8)) + 'px'
    menu.style.top = Math.max(0, Math.min(event.clientY, window.innerHeight - bounds.height - 8)) + 'px'
  }, { signal })
  document.addEventListener('mousedown', event => {
    if (menu !== undefined && !menu.contains(event.target as Node)) removeMenu()
  }, { signal })
  document.addEventListener('scroll', removeMenu, { capture: true, signal })
  window.addEventListener('blur', removeMenu, { signal })
  window.addEventListener('message', event => {
    if (!isShellMessage(event) || typeof event.data !== 'object' || event.data === null) return
    const data = event.data as { channel?: unknown; op?: unknown; requestId?: unknown; ok?: unknown; text?: unknown }
    if (data.channel !== 'clipboard-result' || typeof data.requestId !== 'string') return
    const operation = pending.get(data.requestId)
    if (operation === undefined || data.op !== operation.op) return
    clearTimeout(operation.timeout)
    pending.delete(data.requestId)
    if (data.ok !== true) return
    if (operation.op === 'paste' && typeof data.text === 'string' && data.text.length > 0) applyEdit(operation.snapshot, data.text, 'insertFromPaste')
    if (operation.op === 'cut') applyEdit(operation.snapshot, '', 'deleteByCut')
  }, { signal })
  const dispose = (): void => {
    controller.abort()
    removeMenu()
    for (const operation of pending.values()) clearTimeout(operation.timeout)
    pending.clear()
    if (disposeCurrent === dispose) disposeCurrent = undefined
  }
  disposeCurrent = dispose
  return dispose
}
