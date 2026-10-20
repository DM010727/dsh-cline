/** OAuth belongs to the owning provider card on DSH's native Models page. */
import { useEffect, useRef, useState } from 'react'
import type { ClientApi } from './api.ts'
import { listenSsyKey, openExternal, saveSsyLogin, ssyLogin, SSY_ROUTES, SSY_SIGNUP_URL } from './shared.ts'

interface ProviderCardProps {
  api: ClientApi
  provider: { provider: string; settingsNs: string }
  configured: boolean
  keyConfigured: boolean
}
let loginOwner: symbol | undefined
export function SsyProviderCard(props: ProviderCardProps) {
  // The native keyed slot addresses the adapter namespace, including unrelated providers.
  if (!props.configured || props.provider.settingsNs !== 'llm-pi-ai'
    || !Object.values(SSY_ROUTES).some(route => route === props.provider.provider)) return null
  return <ProviderLogin api={props.api} route={props.provider.provider} keyConfigured={props.keyConfigured} />
}
function ProviderLogin({ api, route, keyConfigured }: { api: ClientApi; route: string; keyConfigured: boolean }) {
  const [waiting, setWaiting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [note, setNote] = useState('')
  const [error, setError] = useState('')
  const pending = useRef(false)
  const owner = useRef(Symbol('ssy-provider-login'))
  const mounted = useRef(false)
  useEffect(() => {
    let disposed = false
    mounted.current = true
    const stop = listenSsyKey(key => {
      if (!pending.current || disposed || loginOwner !== owner.current) return
      loginOwner = undefined
      pending.current = false; setWaiting(false); setSaving(true)
      void saveSsyLogin(api, route, key).then(failure => {
        if (disposed) return
        if (failure) setError(failure)
        else setNote('胜算云登录已更新。模型列表和默认模型保持原配置。')
      }).catch(() => { if (!disposed) setError('保存登录失败，请刷新状态后重试') })
        .finally(() => { if (!disposed) setSaving(false) })
    })
    return () => {
      disposed = true; mounted.current = false; pending.current = false
      if (loginOwner === owner.current) loginOwner = undefined
      stop()
    }
  }, [api, route])
  const login = async (): Promise<void> => {
    if (pending.current || saving) return
    if (loginOwner !== undefined) { setError('已有胜算云登录正在等待，请先完成或取消'); return }
    loginOwner = owner.current
    pending.current = true; setWaiting(true); setNote(''); setError('')
    try { await ssyLogin() }
    catch {
      if (loginOwner === owner.current) loginOwner = undefined
      pending.current = false
      if (mounted.current) { setWaiting(false); setError('无法打开胜算云登录，请重试或使用本卡片的 API Key 配置') }
    }
  }
  return <div className="dshc-provider-login">
    <div className="dshc-row">
      <button type="button" className="dshc-btn small" disabled={waiting || saving} onClick={() => { void login() }}>
        {saving ? '保存登录中…' : waiting ? '等待浏览器登录…' : keyConfigured ? '重新登录胜算云' : '登录胜算云'}
      </button>
      {waiting && <button type="button" className="dshc-btn ghost small" onClick={() => { pending.current = false; if (loginOwner === owner.current) loginOwner = undefined; setWaiting(false) }}>取消等待</button>}
      <button type="button" className="dshc-btn ghost small" onClick={() => { void openExternal(SSY_SIGNUP_URL).catch(() => setError('无法打开胜算云控制台')) }}>胜算云控制台</button>
    </div>
    <p className="dshc-hint">登录更新本供应商的凭据。API Key、模型列表与其他参数在本卡片中管理。</p>
    {note && <p className="dshc-status ok" role="status">{note}</p>}
    {error && <p className="dshc-error" role="alert">{error}</p>}
  </div>
}
