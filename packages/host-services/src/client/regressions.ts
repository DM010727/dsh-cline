/** Quiet regressions: no DSH process, network, credentials, or disk writes. */
import type { ClientApi, Result, SettingsDescribe, SettingsPathOpView } from './api.ts'
import { isFreeModel, normalizeModels, pathOf, readSsySettings, routesForModel, saveSsyConfiguration, SSY_KEY_REF, SSY_ROUTES } from './shared.ts'
import { installClipboard } from './clipboard.ts'
import { listenOpenSession } from './shell-message.ts'
function check(condition: unknown, label: string): asserts condition { if (!condition) throw new Error('Client regression: ' + label) }
const ok = <T>(value: T): Result<T> => ({ ok: true, value })
const rejected: Result<never> = { ok: false, error: { code: 'fixture/refused', message: 'fixture refused' } }
function fixture(options: { failKey?: boolean; failSettings?: boolean; defaultProvider?: string; defaultModel?: string } = {}): {
  api: ClientApi; calls: Array<{ kind: string; ns?: string; ops?: SettingsPathOpView[]; revision?: number }>
} {
  const calls: Array<{ kind: string; ns?: string; ops?: SettingsPathOpView[]; revision?: number }> = []
  const described: SettingsDescribe = { writable: true, namespaces: [
    { ns: 'llm-pi-ai', revision: 7, value: { providers: { shengsuanyun: {
      headers: { 'X-custom': 'keep' }, models: [{ id: 'chat', reasoningEffort: 'high' }],
    } } } },
    { ns: 'agent-default-model', revision: 9, value: { provider: options.defaultProvider ?? 'deepseek-official', model: options.defaultModel ?? 'deepseek-flash' } },
  ] }
  return { calls, api: {
    settings: {
      describe: async () => ok(described),
      mutate: async (ns, ops, revision) => { calls.push({ kind: 'settings', ns, ops, revision }); return options.failSettings ? rejected : ok({}) },
    },
    credentials: {
      describe: async () => ok({ [SSY_KEY_REF]: { configured: true, writable: true } }),
      set: async () => { calls.push({ kind: 'credential' }); return options.failKey ? rejected : ok({}) },
    },
  } }
}
export async function runClientRegressions(): Promise<number> {
  let cases = 0
  const chat = { id: 'chat', support_apis: ['/v1/chat/completions'] }
  const responses = { id: 'response', support_apis: ['/v1/responses'] }
  const messages = { id: 'messages', support_apis: ['/v1/messages'] }
  check(routesForModel(responses)[0] === SSY_ROUTES.responses, 'Responses route')
  check(routesForModel(messages)[0] === SSY_ROUTES.messages, 'Messages route')
  check(routesForModel({ id: 'x', support_apis: ['/v1/images/generations'] }).length === 0, 'exclude image-only')
  cases += 3
  const normalized = normalizeModels([chat, chat, { id: null }, { id: 'image', support_apis: ['/v1/images/generations'] }, { id: 'bad', pricing: { price: null, input_price: 0, output_price: 0 } }])
  check(normalized.length === 2, 'invalid rows and duplicate ids removed')
  check(!isFreeModel(normalized[1]), 'null pricing is unknown')
  check(!isFreeModel({ id: 'image', pricing: { price: 0, input_price: 0, output_price: 0, image_price: 2 } }), 'image price counted')
  check(isFreeModel({ id: 'zero', pricing: { price: 0, input_price: 0, output_price: 0 } }), 'explicit zero pricing')
  check(pathOf({}, ['__proto__']) === undefined, 'inherited properties unavailable')
  cases += 5
  const saved = fixture()
  check(await saveSsyConfiguration(saved.api, [chat, responses, messages], 'fixture') === undefined, 'successful write')
  check(saved.calls[0]?.kind === 'credential' && saved.calls[1]?.kind === 'settings', 'credential stored before routes')
  const write = saved.calls[1]
  check(write.ns === 'llm-pi-ai' && write.revision === 7, 'revision guarded')
  const modelList = (route: string): unknown => (write.ops?.find(op => op.path[1] === route)?.value as { models?: unknown } | undefined)?.models
  check(JSON.stringify(modelList(SSY_ROUTES.chat)) === JSON.stringify([{ id: 'chat', reasoningEffort: 'high' }]), 'chat only and metadata preserved')
  check(JSON.stringify(modelList(SSY_ROUTES.responses)) === JSON.stringify([{ id: 'response' }]), 'Responses only')
  check(JSON.stringify(modelList(SSY_ROUTES.messages)) === JSON.stringify([{ id: 'messages' }]), 'Messages only')
  check((write.ops?.[0]?.value as { headers?: Record<string, string> }).headers?.['X-custom'] === 'keep', 'custom headers preserved')
  check(saved.calls.every(call => call.ns !== 'agent-default-model'), 'global default untouched')
  cases += 8
  const failedKey = fixture({ failKey: true })
  check(await saveSsyConfiguration(failedKey.api, [chat], 'fixture') !== undefined, 'key failure reported')
  check(failedKey.calls.length === 1 && failedKey.calls[0].kind === 'credential', 'failed key publishes no routes')
  cases += 2
  const failedSettings = fixture({ failSettings: true })
  check((await saveSsyConfiguration(failedSettings.api, [chat], 'fixture'))?.includes('API Key 已保存') === true, 'partial commit reported')
  cases++
  const removed = fixture({ defaultProvider: SSY_ROUTES.responses, defaultModel: 'response' })
  check(await saveSsyConfiguration(removed.api, [chat], 'fixture') !== undefined && removed.calls.length === 0, 'current default cannot disappear')
  const empty = fixture()
  check(await saveSsyConfiguration(empty.api, []) !== undefined && empty.calls.length === 0, 'empty does not select all')
  cases += 2
  const keep = fixture({ defaultProvider: SSY_ROUTES.responses, defaultModel: 'response' })
  check(await saveSsyConfiguration(keep.api, [{ ...responses, support_apis: ['/v1/chat/completions', '/v1/responses'] }]) === undefined, 'existing default route retained')
  const loaded = await readSsySettings(fixture().api)
  check(loaded.defaultModel?.provider === 'deepseek-official' && loaded.selectedIds[0] === 'chat', 'saved selection and native default reloaded')
  cases += 2
  cases += testClipboard()
  cases += testSessionNavigation()
  return cases
}

function testSessionNavigation(): number {
  const globals = globalThis as unknown as Record<string, unknown>
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document')
  const ready: Array<{ channel?: string; type?: string }> = []
  const parent = { postMessage: (value: { channel?: string; type?: string }): void => { ready.push(value) } }
  const windowMock = Object.assign(new EventTarget(), { parent })
  const opened: string[] = []
  let dispose: (() => void) | undefined
  const message = (data: unknown, source: unknown = parent, origin = 'https://carrier.example'): void => {
    windowMock.dispatchEvent(Object.assign(new Event('message'), { source, origin, data }))
  }
  try {
    Object.assign(globals, { window: windowMock, document: { referrer: 'https://carrier.example/frame' } })
    dispose = listenOpenSession(id => { opened.push(id) })
    check(ready[0]?.channel === 'dsh-cline.host-service' && ready[0]?.type === 'client-ready', 'installed navigation listener announces client readiness')
    message({ channel: 'dsh-cline.open-session', sessionId: 'task-session-123' })
    check(opened[0] === 'task-session-123', 'trusted navigation message selects created session')
    message({ channel: 'dsh-cline.open-session', sessionId: 'forged-source' }, {})
    check(opened.length === 1, 'unrelated window cannot navigate session')
    message({ channel: 'dsh-cline.open-session', sessionId: 'forged-origin' }, parent, 'https://attacker.example')
    check(opened.length === 1, 'wrong parent origin cannot navigate session')
    message({ channel: 'other', sessionId: 'other-channel' })
    check(opened.length === 1, 'other channels do not navigate')
    for (const sessionId of ['', '../outside', 'a\nb', 123, null, 'x'.repeat(257)]) {
      message({ channel: 'dsh-cline.open-session', sessionId })
    }
    check(opened.length === 1, 'invalid navigation ids ignored')
    dispose()
    message({ channel: 'dsh-cline.open-session', sessionId: 'after-dispose' })
    check(opened.length === 1, 'navigation listener disposed with plugin')
    return 7
  } finally {
    dispose?.()
    if (windowDescriptor === undefined) delete globals.window
    else Object.defineProperty(globalThis, 'window', windowDescriptor)
    if (documentDescriptor === undefined) delete globals.document
    else Object.defineProperty(globalThis, 'document', documentDescriptor)
  }
}

/** Minimal event harness exercises selection and acknowledgements, without a DOM dependency. */
function testClipboard(): number {
  const globals = globalThis as unknown as Record<string, unknown>
  const names = ['window', 'document', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'InputEvent']
  const previous = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]))
  class FakeElement extends EventTarget { isConnected = true }
  class FakeInput extends FakeElement {
    type = 'text'
    disabled = false
    readOnly = false
    maxLength = -1
    selectionStart = 1
    selectionEnd = 3
    private stored = 'abcdef'
    get value(): string { return this.stored }
    set value(next: string) { this.stored = next }
    setSelectionRange(start: number, end: number): void { this.selectionStart = start; this.selectionEnd = end }
  }
  class FakeTextarea extends FakeInput {}
  class FakeInputEvent extends Event {
    constructor(type: string, options: InputEventInit) { super(type, options) }
  }
  const requests: Record<string, unknown>[] = []
  const parent = { postMessage: (data: Record<string, unknown>): void => { requests.push(data) } }
  const windowMock = Object.assign(new EventTarget(), { parent, getSelection: () => undefined })
  const input = new FakeInput()
  const documentMock = Object.assign(new EventTarget(), { activeElement: input, referrer: 'https://carrier.example/frame' })
  let dispose: (() => void) | undefined
  const key = (key: string): void => {
    documentMock.dispatchEvent(Object.assign(new Event('keydown', { cancelable: true }), { key, ctrlKey: true }))
  }
  const reply = (request: Record<string, unknown>, ok: boolean, source: unknown = parent): void => {
    windowMock.dispatchEvent(Object.assign(new Event('message'), {
      source, origin: 'https://carrier.example', data: { channel: 'clipboard-result', op: request.op, requestId: request.requestId, ok, text: 'paste' },
    }))
  }
  try {
    Object.assign(globals, { window: windowMock, document: documentMock, HTMLElement: FakeElement,
      HTMLInputElement: FakeInput, HTMLTextAreaElement: FakeTextarea, InputEvent: FakeInputEvent })
    dispose = installClipboard()
    key('c')
    check(requests[0]?.text === 'bc', 'input selection copied even when window selection is empty')
    key('x')
    check(input.value === 'abcdef', 'cut awaits clipboard success')
    reply(requests[1], false)
    check(input.value === 'abcdef', 'failed cut preserves original')
    key('x')
    reply(requests[2], true, {})
    check(input.value === 'abcdef', 'forged message ignored')
    reply(requests[2], true)
    check(String(input.value) === 'adef', 'acknowledged cut deletes exact selected range')
    input.readOnly = true
    key('v')
    check(requests.length === 3, 'readonly input never sends paste')
    input.readOnly = false
    input.value = 'abcdef'
    input.setSelectionRange(1, 3)
    key('v')
    input.setSelectionRange(3, 3)
    reply(requests[3], true)
    check(String(input.value) === 'abcdef', 'late paste does not modify a changed selection')
    input.setSelectionRange(1, 3)
    key('v')
    reply(requests[4], true)
    check(String(input.value) === 'apastedef', 'native input setter applies a valid paste')
    input.value = 'abcdef'
    input.maxLength = 6
    input.setSelectionRange(1, 3)
    key('v')
    reply(requests[5], true)
    check(String(input.value) === 'apadef', 'paste respects input maxLength')
    input.value = 'abcdef'
    input.maxLength = -1
    input.setSelectionRange(1, 3)
    input.addEventListener('beforeinput', event => { event.preventDefault() }, { once: true })
    key('v')
    reply(requests[6], true)
    check(String(input.value) === 'abcdef', 'cancelled beforeinput leaves input unchanged')
    dispose()
    key('c')
    check(Number(requests.length) === 7, 'dispose removes document listeners')
    return 11
  } finally {
    dispose?.()
    for (const name of names) {
      const descriptor = previous.get(name)
      if (descriptor === undefined) delete globals[name]
      else Object.defineProperty(globalThis, name, descriptor)
    }
  }
}
