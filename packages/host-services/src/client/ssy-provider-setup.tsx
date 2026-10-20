/** First-time Shengsuanyun setup inside the native Models page, never a settings section. */
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { ClientApi } from './api.ts'
import { SsyModelMultiSelect } from './ssy-models.tsx'
import {
  fetchSsyAccount, fetchSsyModels, listenSsyKey, openExternal, readSsySettings,
  saveSsyConfiguration, ssyLogin, SSY_SIGNUP_URL,
  type SsyAccount, type SsyModel, type SsySettings,
} from './shared.ts'

export function SsyModelsFooter({ api }: { api: ClientApi }): ReactNode {
  const [configured, setConfigured] = useState<boolean>()
  const [open, setOpen] = useState(false)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    let disposed = false, generation = 0
    const refresh = (): void => {
      const request = ++generation
      void readSsySettings(api).then(value => {
        if (!disposed && request === generation) { setConfigured(value.providerConfigured); setError('') }
      }).catch(() => { if (!disposed && request === generation) setError('读取胜算云配置失败，请刷新重试') })
    }
    const stop = api.$on?.('settings/document-updated', refresh)
    refresh()
    return () => { disposed = true; stop?.() }
  }, [api, revision])
  if (configured === true) return null
  if (error) return <div className="dshc-card"><p className="dshc-error">{error}</p><button type="button" className="dshc-btn ghost small" onClick={() => setRevision(value => value + 1)}>刷新胜算云入口</button></div>
  if (configured === undefined) return null
  return <details className="dshc-card" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>添加胜算云<span className="dshc-badge">推荐</span></summary>
    {open && <Loaded api={api} onSaved={() => setRevision(value => value + 1)} />}
  </details>
}

function Loaded({ api, onSaved }: { api: ClientApi; onSaved: () => void }): ReactNode {
  const [settings, setSettings] = useState<SsySettings | undefined>(undefined)
  const [catalog, setCatalog] = useState<SsyModel[]>([])
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [keyDraft, setKeyDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [note, setNote] = useState<string | undefined>(undefined)
  const [loginBusy, setLoginBusy] = useState(false)
  const [account, setAccount] = useState<SsyAccount | undefined>(undefined)
  const [accountBusy, setAccountBusy] = useState(false)
  const [refresh, setRefresh] = useState(0)

  useEffect(() => {
    let disposed = false
    void readSsySettings(api).then(value => {
      if (disposed) return
      setSettings(value)
      setSelectedIds(value.selectedIds)
    }).catch(err => { if (!disposed) setError(String(err)) })
    return () => { disposed = true }
  }, [api])
  useEffect(() => {
    const controller = new AbortController()
    void fetchSsyModels(controller.signal).then(setCatalog).catch(err => {
      if (!controller.signal.aborted) setError(String(err))
    })
    return () => { controller.abort() }
  }, [])

  const models = useMemo(() => {
    const ids = new Set(catalog.map(model => model.id))
    return [...catalog, ...(settings?.configuredModels ?? []).filter(model => !ids.has(model.id))]
  }, [catalog, settings])

  useEffect(() => {
    if (settings?.keyConfigured !== true) { setAccount(undefined); return }
    const controller = new AbortController()
    setAccountBusy(true)
    void fetchSsyAccount(controller.signal).then(value => {
      if (!controller.signal.aborted) setAccount(value)
    }).catch(err => {
      if (!controller.signal.aborted) setAccount({ ok: false, reason: 'api', error: String(err) })
    }).finally(() => { if (!controller.signal.aborted) setAccountBusy(false) })
    return () => { controller.abort() }
  }, [settings?.keyConfigured, refresh])

  useEffect(() => listenSsyKey(key => {
    setKeyDraft(key)
    setError(undefined)
    setNote('胜算云登录成功，勾选模型后保存即可。')
  }), [])
  const login = useCallback(async (): Promise<void> => {
    if (loginBusy) return
    setLoginBusy(true)
    setError(undefined)
    try { await ssyLogin() } catch (err) { setError(String(err)) } finally { setLoginBusy(false) }
  }, [loginBusy])

  const save = async (): Promise<void> => {
    if (busy || settings?.writable !== true) return
    setBusy(true)
    setError(undefined)
    setNote(undefined)
    try {
      const selected = new Set(selectedIds)
      const injected = models.filter(model => selected.has(model.id))
      const failure = await saveSsyConfiguration(api, injected, keyDraft)
      if (failure !== undefined) { setError(failure); return }
      setKeyDraft('')
      setNote('已保存 ' + String(injected.length) + ' 个模型。可在原生「模型」页或会话模型选择器中选用胜算云。')
      const current = await readSsySettings(api)
      setSettings(current)
      setSelectedIds(current.selectedIds)
      setRefresh(value => value + 1)
      onSaved()
    } catch (err) { setError(String(err)) } finally { setBusy(false) }
  }

  return (
    <div>
      <div>
        <p className="dshc-desc">登录或填入 API Key，选择模型后添加。随后在本页供应商卡片中管理，不改变你当前的默认模型。</p>
        <p className={settings?.keyConfigured ? 'dshc-status ok' : 'dshc-status'}>
          {settings === undefined ? '配置读取中…' : settings.keyConfigured ? 'API Key 已配置' : 'API Key 未配置'}
        </p>
        {settings !== undefined && !settings.writable && <p className="dshc-error">当前配置只读或 DSH 未注册 llm-pi-ai，请检查运行时。</p>}
        {account?.ok && (
          <p className="dshc-status">
            {account.displayName === undefined ? '' : account.displayName + '　'}
            {account.balance === undefined ? '' : '余额 ¥' + account.balance.toFixed(2)}
            {account.usageTotal === undefined ? '' : '　近 ' + String(account.usageDays ?? 7) + ' 日消耗 ¥' + account.usageTotal.toFixed(2)}
          </p>
        )}
        {account !== undefined && !account.ok && account.reason === 'api' && <p className="dshc-error">{account.error}</p>}
        {settings?.keyConfigured && <button className="dshc-btn small ghost" type="button" disabled={accountBusy} onClick={() => { setRefresh(value => value + 1) }}>{accountBusy ? '刷新中…' : '刷新账户'}</button>}
        {account?.usage !== undefined && account.usage.length > 0 && (
          <details style={{ margin: '8px 0' }}>
            <summary className="dshc-hint">近期消耗明细</summary>
            <ul className="dshc-list">{account.usage.map((entry, i) => (
              <li key={i}>
                <span className="dshc-list-main">{entry.at}<span className="dshc-list-sub">{entry.model}</span></span>
                <span>¥{entry.credits.toFixed(4)}<span className="dshc-list-sub">{entry.promptTokens}/{entry.completionTokens} tokens</span></span>
              </li>
            ))}</ul>
          </details>
        )}
        <div className="dshc-row" style={{ marginTop: 10, marginBottom: 10 }}>
          <input
            className="dshc-input" type="password" value={keyDraft} disabled={busy || settings?.keyWritable === false}
            placeholder={settings?.keyConfigured ? '输入新 Key 以替换，留空保留原 Key' : '胜算云 API Key'}
            onChange={event => { setKeyDraft(event.target.value) }}
          />
          <button className="dshc-btn" type="button" disabled={loginBusy || busy || settings?.keyWritable === false} onClick={() => { void login() }}>
            {loginBusy ? '打开中…' : settings?.keyConfigured ? '重新登录' : '登录胜算云'}
          </button>
          <button className="dshc-btn ghost" type="button" onClick={() => { void openExternal(SSY_SIGNUP_URL).catch(err => { setError(String(err)) }) }}>获取 API Key</button>
        </div>
        <SsyModelMultiSelect models={models} selectedIds={selectedIds} onChange={setSelectedIds} disabled={busy || settings?.writable !== true} />
        <div className="dshc-actions">
          <button className="dshc-btn" type="button" disabled={busy || settings?.writable !== true || selectedIds.length === 0} onClick={() => { void save() }}>
            {busy ? '添加中…' : '添加胜算云供应商'}
          </button>
        </div>
        {note !== undefined && <p className="dshc-status ok">{note}</p>}
      </div>
      {error !== undefined && <p className="dshc-error">{error}</p>}
    </div>
  )
}
