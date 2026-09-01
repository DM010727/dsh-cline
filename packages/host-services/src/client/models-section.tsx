/**
 * The「模型」settings section, shadowing DSH's native one (same slot id,
 * priority -1: the lower-priority registration is the cell winner). DSH Cline
 * makes Shengsuanyun the default provider, so this page is the ONE place API
 * keys and models are configured: a default-provider hero card (key + catalog
 * model + default-model write), then DeepSeek 原厂 (key + catalog model
 * select), then the hand-declared custom providers (with the DSH "custom
 * provider" declare card below). The rest of the pi-ai catalog stays
 * reachable through settings.yaml - no third-party parade on this page.
 *
 * @module @dsh-cline/host-services/client/models-section
 */

import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { IApiClient } from '@deepseek-ai/dsh-api-remotes/client'
import { SsyModelSelect } from './ssy-models.tsx'
import {
  declareCustomProvider, listenSsyKey, openExternal, probeProviders, readDefaultModel, readProviderRows,
  removeProviderRow, saveProviderKey, saveSsyModel, saveSsySetup, ssyLogin, SSY_SIGNUP_URL,
  type DefaultModel, type ProviderRowView, type SsyModel,
} from './shared.ts'

/** Face the registration injects. */
export interface DshClineModelsSectionInjected {
  api: IApiClient
}

/** Props the settings shell hands the section (inject face spread flat). */
export interface DshClineModelsSectionProps extends Partial<DshClineModelsSectionInjected> {
  close?: () => void
}

/** Wire protocols a hand-declared route may speak (llm-pi-ai schema). */
const CUSTOM_PROTOCOLS = ['openai-completions', 'openai-responses', 'anthropic-messages'] as const

/** Shengsuanyun route ids get friendlier default-model labels. */
function defaultModelLabel(def: DefaultModel | undefined): string {
  if (def === undefined) return '未设置'
  return def.provider + ' · ' + def.model
}

/**
 * Render the「模型」section: default-provider hero card, then DeepSeek 原厂,
 * then the custom providers.
 * @returns the section element tree, or null while un-injected.
 */
export function DshClineModelsSection(props: DshClineModelsSectionProps): ReactNode {
  const { api } = props
  if (api === undefined) return null
  return <Loaded api={api} />
}

function Loaded({ api }: { api: IApiClient }): ReactNode {
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | undefined>(undefined)
  /** Set when the running DSH has no llm-pi-ai namespace: writes cannot work. */
  const [incomplete, setIncomplete] = useState(false)
  const [ssyKeyed, setSsyKeyed] = useState<boolean | undefined>(undefined)
  const [defaultModel, setDefaultModel] = useState<DefaultModel | undefined>(undefined)
  const [rows, setRows] = useState<ProviderRowView[]>([])

  const [keyDraft, setKeyDraft] = useState('')
  const [selected, setSelected] = useState<SsyModel | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [savedNote, setSavedNote] = useState<string | undefined>(undefined)
  const [editingRow, setEditingRow] = useState<string | undefined>(undefined)
  const [rowKeyDraft, setRowKeyDraft] = useState('')
  const [rowModel, setRowModel] = useState('')
  const [rowBusy, setRowBusy] = useState(false)
  const [declaring, setDeclaring] = useState(false)
  const [declareName, setDeclareName] = useState('')
  const [declareDisplay, setDeclareDisplay] = useState('')
  const [declareProtocol, setDeclareProtocol] = useState<string>(CUSTOM_PROTOCOLS[0])
  const [declareBase, setDeclareBase] = useState('')
  const [declareKey, setDeclareKey] = useState('')
  const [declareBusy, setDeclareBusy] = useState(false)

  const reload = useCallback((): Promise<void> => {
    return (async () => {
      const described = await api.settings.describe({})
      if (!described.result.ok) {
        setLoadError(described.result.error.message)
        setLoading(false)
        return
      }
      const hasLlm = described.result.value.namespaces.some(ns => ns.ns === 'llm-pi-ai')
      setIncomplete(!hasLlm)
      const [probe, def, joined] = await Promise.all([
        probeProviders(api).catch(() => ({ anyUsable: false, ssyKeyed: undefined })),
        readDefaultModel(api).catch(() => undefined),
        readProviderRows(api),
      ])
      setSsyKeyed(probe.ssyKeyed)
      setDefaultModel(def)
      if (joined.error !== undefined) setLoadError(joined.error)
      else setRows(joined.rows ?? [])
      // Seed the picker with the live default so a key-only save keeps it.
      if (def !== undefined && def.provider.startsWith('shengsuanyun')) {
        setSelected(previous => previous?.id === def.model ? previous : { id: def.model })
      }
      setLoading(false)
    })()
  }, [api])

  useEffect(() => { void reload() }, [reload])

  // Shengsuanyun OAuth login (ported from cline-Chinese): a key exchanged after
  // the browser flow lands here through the shell relay and fills the field,
  // exactly like a manual paste - the user then picks the model and saves.
  const [loginBusy, setLoginBusy] = useState(false)
  useEffect(() => listenSsyKey(apiKey => {
    setKeyDraft(apiKey)
    setError(undefined)
    setSavedNote('胜算云登录成功：API Key 已自动填入，选择模型后点保存即可。')
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

  const save = async (): Promise<void> => {
    if (busy || incomplete) return
    setBusy(true)
    setError(undefined)
    setSavedNote(undefined)
    try {
      const key = keyDraft.trim()
      if (selected === undefined) {
        setError('请选择一个模型')
        return
      }
      let failure: string | undefined
      if (key !== '') {
        failure = await saveSsySetup(api, key, selected)
      } else if (ssyKeyed === true) {
        failure = await saveSsyModel(api, selected)
      } else {
        setError('请先填入胜算云 API Key')
        return
      }
      if (failure !== undefined) {
        setError(failure)
        return
      }
      setKeyDraft('')
      setSavedNote(key !== '' ? '已保存：胜算云已配置并设为默认供应商' : '已保存：默认模型已更新')
      await reload()
    } catch (err) {
      setError(String(err))
    } finally {
      setBusy(false)
    }
  }

  const saveRowKey = async (row: ProviderRowView): Promise<void> => {
    if (rowBusy) return
    const key = rowKeyDraft.trim()
    if (key === '') return
    setRowBusy(true)
    setError(undefined)
    try {
      const failure = await saveProviderKey(api, row, key, rowModel === '' ? undefined : rowModel)
      if (failure !== undefined) {
        setError(failure)
        return
      }
      setEditingRow(undefined)
      setRowKeyDraft('')
      setRowModel('')
      setSavedNote('已保存：' + row.displayName + ' 的 API Key')
      await reload()
    } catch (err) {
      setError(String(err))
    } finally {
      setRowBusy(false)
    }
  }

  const removeRow = async (row: ProviderRowView): Promise<void> => {
    if (rowBusy) return
    setRowBusy(true)
    setError(undefined)
    try {
      const failure = await removeProviderRow(api, row)
      if (failure !== undefined) {
        setError(failure)
        return
      }
      setSavedNote('已移除：' + row.displayName)
      await reload()
    } catch (err) {
      setError(String(err))
    } finally {
      setRowBusy(false)
    }
  }

  const declareProvider = async (): Promise<void> => {
    const route = declareName.trim()
    if (route === '' || declareBusy || incomplete) return
    if (declareBase.trim() === '' || !/^https?:\/\//.test(declareBase.trim())) {
      setError('自定义供应商需要以 http(s) 开头的 Base URL')
      return
    }
    setDeclareBusy(true)
    setError(undefined)
    try {
      const failure = await declareCustomProvider(
        api, route, declareDisplay.trim() === '' ? route : declareDisplay.trim(),
        declareProtocol, declareBase.trim(), declareKey,
      )
      if (failure !== undefined) {
        setError(failure)
        return
      }
      setDeclaring(false)
      setDeclareName('')
      setDeclareDisplay('')
      setDeclareBase('')
      setDeclareKey('')
      setSavedNote('已声明自定义供应商：' + route + '（可在上方列表配置 Key）')
      await reload()
    } catch (err) {
      setError(String(err))
    } finally {
      setDeclareBusy(false)
    }
  }

  if (loading) {
    return <div className="dshc-empty">加载中…</div>
  }

  return (
    <div>
      {loadError !== undefined && <p className="dshc-error">{'读取失败：' + loadError}</p>}
      {incomplete && (
        <div className="dshc-banner">
          当前 DSH 运行不完整（llm-pi-ai 未注册），供应商配置暂时无法保存。
          请在 VS Code 执行「DSH Cline: 重启 DSH 服务」（或关闭「DSH Cline 服务」终端让插件自动拉起）后重试。
        </div>
      )}

      <div className="dshc-card">
        <h3>
          胜算云<span className="dshc-badge">默认</span>
        </h3>
        <p className="dshc-desc">
          DSH Cline 的默认供应商：三个兼容接口共用一把 Key。模型与 API Key 都只在这里配置。
        </p>
        <p className={ssyKeyed === undefined ? 'dshc-status' : ssyKeyed ? 'dshc-status ok' : 'dshc-status bad'}>
          <span className={ssyKeyed === undefined ? 'dshc-dot unknown' : ssyKeyed ? 'dshc-dot ok' : 'dshc-dot bad'} />
          {ssyKeyed === undefined ? '状态未知' : ssyKeyed ? 'API Key 已配置' : 'API Key 未配置'}
          {'　默认模型：' + defaultModelLabel(defaultModel)}
        </p>
        <div className="dshc-row" style={{ marginTop: 8, marginBottom: 8 }}>
          <input
            className="dshc-input"
            type="password"
            value={keyDraft}
            placeholder={ssyKeyed === true ? '输入新 Key 以替换（留空则仅改模型）' : 'sk-...'}
            onChange={e => { setKeyDraft(e.target.value) }}
          />
          {ssyKeyed !== true && (
            <button
              type="button"
              className="dshc-btn"
              disabled={loginBusy}
              onClick={() => { void login() }}
              title="在系统浏览器中登录胜算云，授权后 API Key 自动填入（也可手动粘贴）"
            >
              {loginBusy ? '打开中…' : '登录胜算云'}
            </button>
          )}
          <button type="button" className="dshc-btn ghost" onClick={() => { void openExternal(SSY_SIGNUP_URL) }}>
            获取 API Key
          </button>
        </div>
        <SsyModelSelect value={selected?.id ?? ''} onChange={setSelected} />
        <div className="dshc-actions" style={{ marginTop: 12 }}>
          <button
            type="button"
            className="dshc-btn"
            disabled={busy || incomplete || selected === undefined}
            onClick={() => { void save() }}
          >
            {busy ? '保存中…' : '保存'}
          </button>
        </div>
        {savedNote !== undefined && error === undefined && <p className="dshc-status ok">{savedNote}</p>}
      </div>

      <p className="dshc-section-title">其他供应商</p>
      {rows.length === 0 && <p className="dshc-hint">没有其他供应商。</p>}
      <ul className="dshc-list">
        {rows.map(row => (
          <li key={row.provider}>
            <span
              className={
                row.keyConfigured === undefined
                  ? 'dshc-dot unknown'
                  : row.keyConfigured
                    ? 'dshc-dot ok'
                    : 'dshc-dot bad'
              }
              title={row.keyConfigured === undefined ? '状态未知' : row.keyConfigured ? 'API Key 已配置' : 'API Key 未配置'}
            />
            <span className="dshc-list-main">
              <span>
                {row.displayName}
                {row.declared && <span className="dshc-badge">自定义</span>}
              </span>
              <div className="dshc-list-sub">
                {row.configured ? row.keyRef : '未配置 — 填入 Key 即启用'}
              </div>
              {editingRow === row.provider && (
                <div style={{ marginTop: 6 }}>
                  <div className="dshc-row">
                    <input
                      className="dshc-input"
                      type="password"
                      autoFocus
                      placeholder={row.keyRef}
                      value={rowKeyDraft}
                      onChange={e => { setRowKeyDraft(e.target.value) }}
                      onKeyDown={e => { if (e.key === 'Enter') void saveRowKey(row) }}
                    />
                    <button
                      type="button"
                      className="dshc-btn small"
                      disabled={rowBusy || rowKeyDraft.trim() === ''}
                      onClick={() => { void saveRowKey(row) }}
                    >
                      保存
                    </button>
                  </div>
                  {row.catalogModels.length > 0 && (
                    <select
                      className="dshc-select"
                      style={{ marginTop: 6 }}
                      value={rowModel}
                      onChange={e => { setRowModel(e.target.value) }}
                    >
                      <option value="">模型（可选，保持目录默认）</option>
                      {row.catalogModels.map(id => <option key={id} value={id}>{id}</option>)}
                    </select>
                  )}
                </div>
              )}
            </span>
            <button
              type="button"
              className="dshc-btn small ghost"
              disabled={rowBusy || incomplete}
              onClick={() => {
                setEditingRow(editingRow === row.provider ? undefined : row.provider)
                setRowKeyDraft('')
                setRowModel('')
              }}
            >
              {editingRow === row.provider ? '收起' : '配置 Key'}
            </button>
            {row.removable && (
              <button
                type="button"
                className="dshc-btn small danger"
                disabled={rowBusy || incomplete}
                title="移除该供应商的用户配置（并删除其 API Key）"
                onClick={() => { void removeRow(row) }}
              >
                移除
              </button>
            )}
          </li>
        ))}
      </ul>

      {declaring
        ? (
          <div className="dshc-card">
            <h3>声明自定义供应商</h3>
            <p className="dshc-desc">声明一条 pi-ai 不知道的供应商 route（OpenAI/Anthropic 兼容接口均可）。</p>
            <div className="dshc-row" style={{ marginBottom: 6 }}>
              <input
                className="dshc-input"
                placeholder="route id（小写字母/数字/连字符，如 my-gateway）"
                value={declareName}
                onChange={e => { setDeclareName(e.target.value) }}
              />
              <input
                className="dshc-input"
                placeholder="显示名（可留空 = route id）"
                value={declareDisplay}
                onChange={e => { setDeclareDisplay(e.target.value) }}
              />
            </div>
            <div className="dshc-row" style={{ marginBottom: 6 }}>
              <select
                className="dshc-select"
                style={{ flex: 'none', width: 'min(190px, 55%)' }}
                value={declareProtocol}
                onChange={e => { setDeclareProtocol(e.target.value) }}
              >
                {CUSTOM_PROTOCOLS.map(p => <option key={p} value={p}>{p}</option>)}
              </select>
              <input
                className="dshc-input"
                placeholder="Base URL（https://…/v1）"
                value={declareBase}
                onChange={e => { setDeclareBase(e.target.value) }}
              />
            </div>
            <input
              className="dshc-input"
              type="password"
              placeholder="API Key（可留空稍后配置）"
              value={declareKey}
              onChange={e => { setDeclareKey(e.target.value) }}
            />
            <div className="dshc-actions" style={{ marginTop: 8 }}>
              <button type="button" className="dshc-btn ghost" disabled={declareBusy} onClick={() => { setDeclaring(false) }}>
                取消
              </button>
              <button
                type="button"
                className="dshc-btn"
                disabled={declareBusy || incomplete || declareName.trim() === ''}
                onClick={() => { void declareProvider() }}
              >
                {declareBusy ? '声明中…' : '声明'}
              </button>
            </div>
          </div>
        )
        : (
          <button type="button" className="dshc-btn ghost" disabled={incomplete} onClick={() => { setDeclaring(true) }}>
            + 声明自定义供应商
          </button>
        )}
      <p className="dshc-hint" style={{ marginTop: 10 }}>
        高级配置（模型清单细化、复杂字段）请直接编辑 ~/.dsh-cline/settings.yaml。
      </p>

      {error !== undefined && <p className="dshc-error">{error}</p>}
    </div>
  )
}
