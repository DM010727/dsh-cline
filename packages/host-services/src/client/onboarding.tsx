/**
 * The Shengsuanyun first-run onboarding step. Registered into the
 * `settings.onboarding` slot under the SAME id as the official DeepSeek step
 * with a lower priority, it shadows that dialog: a fresh DSH Cline user is
 * asked for a Shengsuanyun key (the default provider) instead of a DeepSeek
 * one. The coordinator contract is unchanged - any usable provider completes
 * onboarding, so once the key is saved the whole flow ends by itself.
 */

import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { IApiClient } from '@deepseek-ai/dsh-api-remotes/client'
import { SsyModelSelect } from './ssy-models.tsx'
import {
  listenSsyKey, openExternal, probeProviders, saveSsySetup, ssyLogin, SSY_SIGNUP_URL, type SsyModel,
} from './shared.ts'

/** Face the registration injects (mirrors the DSH slot InjectFace pattern). */
export interface SsyOnboardingInjected {
  api: IApiClient
}

/** Owner props the onboarding coordinator hands each step. */
export interface SsyOnboardingProps extends SsyOnboardingInjected {
  /** Mark this step done and advance the coordinator. */
  complete: () => void
}

type Phase = 'loading' | 'ask' | 'saving' | 'done'

/**
 * Ask a first-run user for the Shengsuanyun credential and model choice.
 * @returns the modal, or null while deciding/skipped.
 */
export function SsyOnboarding(props: SsyOnboardingProps): ReactNode {
  const { complete, api } = props
  const [phase, setPhase] = useState<Phase>('loading')
  const [apiKey, setApiKey] = useState('')
  const [selected, setSelected] = useState<SsyModel | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [loginBusy, setLoginBusy] = useState(false)

  // Shengsuanyun OAuth login (ported from cline-Chinese): the exchanged key
  // arrives through the shell relay and fills the field like a manual paste.
  useEffect(() => listenSsyKey(key => {
    setApiKey(key)
    setError(undefined)
  }), [])
  const login = async (): Promise<void> => {
    if (loginBusy) return
    setLoginBusy(true)
    try {
      await ssyLogin()
    } catch (err: unknown) {
      setError(String(err instanceof Error ? err.message : err))
    } finally {
      setLoginBusy(false)
    }
  }

  // Readiness: any usable provider ends this step without asking anything.
  useEffect(() => {
    let cancelled = false
    void probeProviders(api).then(
      ({ anyUsable }) => {
        if (cancelled) return
        if (anyUsable) {
          setPhase('done')
          complete()
        } else {
          setPhase('ask')
        }
      },
      err => {
        if (cancelled) return
        // Without the join we cannot decide; never block the user behind it.
        setPhase('ask')
        setError(String(err))
      },
    )
    return () => { cancelled = true }
  }, [api, complete])

  const save = async (): Promise<void> => {
    const key = apiKey.trim()
    if (key === '') { setError('请先填入胜算云 API Key'); return }
    if (selected === undefined) { setError('请选择一个模型'); return }
    setPhase('saving')
    setError(undefined)
    try {
      const failure = await saveSsySetup(api, key, selected)
      if (failure !== undefined) {
        setError(failure)
        setPhase('ask')
        return
      }
      setPhase('done')
      complete()
    } catch (err) {
      setError(String(err))
      setPhase('ask')
    }
  }

  if (phase !== 'ask' && phase !== 'saving') return null

  return (
    <div className="dshc-modal">
      <div className="dshc-modal-card">
        <h2>欢迎使用 DSH Cline</h2>
        <p className="dshc-sub">配置默认供应商「胜算云」后即可开始。填入 API Key 并选择一个模型。</p>
        <div className="dshc-field">
          <label htmlFor="dshc-key">胜算云 API Key</label>
          <div className="dshc-row">
            <input
              id="dshc-key"
              className="dshc-input"
              type="password"
              value={apiKey}
              placeholder="sk-..."
              autoFocus
              onChange={e => { setApiKey(e.target.value) }}
              onKeyDown={e => { if (e.key === 'Enter' && phase === 'ask') void save() }}
            />
            <button
              type="button"
              className="dshc-btn"
              disabled={loginBusy}
              onClick={() => { void login() }}
              title="在系统浏览器中登录胜算云，授权后 API Key 自动填入（也可手动粘贴）"
            >
              {loginBusy ? '打开中…' : '登录胜算云'}
            </button>
            <button type="button" className="dshc-btn ghost" onClick={() => { void openExternal(SSY_SIGNUP_URL) }}>
              获取 API Key
            </button>
          </div>
          <p className="dshc-hint">「登录胜算云」在浏览器中授权后自动填入 Key；也可前往官网注册领取后手动粘贴。</p>
        </div>
        <SsyModelSelect value={selected?.id ?? ''} onChange={setSelected} compact />
        {error !== undefined && <p className="dshc-error">{error}</p>}
        <div className="dshc-actions">
          <button type="button" className="dshc-btn ghost" disabled={phase === 'saving'} onClick={complete}>
            稍后配置
          </button>
          <button type="button" className="dshc-btn" disabled={phase === 'saving'} onClick={() => { void save() }}>
            {phase === 'saving' ? '保存中…' : '保存并开始'}
          </button>
        </div>
      </div>
    </div>
  )
}
