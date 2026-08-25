/**
 * The「DSH Cline」settings section: the fusion-feature configuration after the
 * model/provider unification (v0.9.0 - keys and models live ONLY in the
 * 「模型」section). Cards: the edit-diff mirror, checkpoint policy, MCP server
 * management (file-backed, applies on next boot), the DSH service card
 * (bridge health + in-GUI restart), and about. Reads/writes travel through the
 * plugin's same-origin gateway to the VS Code configuration, the DSH
 * settings/credential wire APIs, and the mcp.json file.
 */

import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { IApiClient } from '@deepseek-ai/dsh-api-remotes/client'
import {
  fetchMcpServers, probeProviders, readVscodeConfig, restartDshService, writeMcpServers,
  writeVscodeConfig, type McpServerEntry, type McpServerRow,
} from './shared.ts'

/** Face the registration injects. */
export interface DshClineSectionInjected {
  api: IApiClient
}

/** Owner props the settings shell hands each section. */
export interface DshClineSectionProps extends DshClineSectionInjected {
  close?: () => void
}

type CheckpointAuto = 'off' | 'edit-only' | 'all'

const CHECKPOINT_LABELS: Record<CheckpointAuto, string> = {
  'off': '关闭',
  'edit-only': '每次编辑前',
  'all': '所有工具调用前',
}

/** One MCP row merged with its name (the file maps name -> entry). */
type McpRow = McpServerRow

/**
 * The section body: cards for every DSH Cline fusion feature.
 * @returns the section element tree.
 */
export function DshClineSection(props: DshClineSectionProps): ReactNode {
  const { api } = props
  const [diffOnEdit, setDiffOnEdit] = useState<boolean | undefined>(undefined)
  const [diffBusy, setDiffBusy] = useState(false)
  const [checkpointAuto, setCheckpointAuto] = useState<CheckpointAuto | undefined>(undefined)
  const [ssyKeyed, setSsyKeyed] = useState<boolean | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [health, setHealth] = useState<string | undefined>(undefined)

  const [mcpRows, setMcpRows] = useState<McpRow[] | undefined>(undefined)
  const [mcpBusy, setMcpBusy] = useState(false)
  const [mcpAdding, setMcpAdding] = useState(false)
  const [mcpName, setMcpName] = useState('')
  const [mcpTransport, setMcpTransport] = useState<'stdio' | 'streamable-http'>('stdio')
  const [mcpCommand, setMcpCommand] = useState('')
  const [mcpUrl, setMcpUrl] = useState('')

  const [restartBusy, setRestartBusy] = useState(false)
  const [restartNote, setRestartNote] = useState<string | undefined>(undefined)

  const reloadMcp = useCallback((): Promise<void> => {
    return fetchMcpServers().then(
      rows => { setMcpRows(rows) },
      err => { setError(String(err)) },
    )
  }, [])

  useEffect(() => {
    let cancelled = false
    void readVscodeConfig('diffOnEdit').then(
      v => { if (!cancelled) setDiffOnEdit(v !== false) },
      err => { if (!cancelled) setError(String(err)) },
    )
    void api.settings.describe({}).then(
      response => {
        if (cancelled || !response.result.ok) return
        const ns = response.result.value.namespaces.find(n => n.ns === 'dsh-cline-host-services')
        const value = ns?.value
        const mode = (typeof value === 'object' && value !== null
          ? (value as { checkpointAuto?: unknown }).checkpointAuto
          : undefined)
        if (mode === 'off' || mode === 'edit-only' || mode === 'all') setCheckpointAuto(mode)
      },
      () => { /* namespace absent: plugin config stays at its base default */ },
    )
    void probeProviders(api).then(
      ({ ssyKeyed }) => { if (!cancelled) setSsyKeyed(ssyKeyed) },
      () => { /* status stays unknown */ },
    )
    void fetch('/dsh-cline/health').then(
      async response => {
        if (cancelled) return
        try {
          const body = await response.json() as { bridge?: string; extensionVersion?: string; error?: string }
          if (body.bridge === 'up') setHealth('桥已连接 · 扩展 v' + String(body.extensionVersion ?? '?'))
          else setHealth('桥未连接（' + String(body.error ?? 'bridge down') + '）')
        } catch { setHealth('桥未连接') }
      },
      () => { if (!cancelled) setHealth('桥未连接') },
    )
    void reloadMcp()
    return () => { cancelled = true }
  }, [api, reloadMcp])

  const toggleDiff = async (): Promise<void> => {
    if (diffOnEdit === undefined || diffBusy) return
    setDiffBusy(true)
    setError(undefined)
    try {
      const next = !diffOnEdit
      await writeVscodeConfig('diffOnEdit', next)
      setDiffOnEdit(next)
    } catch (err) {
      setError(String(err))
    } finally {
      setDiffBusy(false)
    }
  }

  const setCheckpoint = async (next: CheckpointAuto): Promise<void> => {
    setCheckpointAuto(next)
    setError(undefined)
    try {
      const described = await api.settings.describe({})
      if (!described.result.ok) throw new Error(described.result.error.message)
      const ns = described.result.value.namespaces.find(n => n.ns === 'dsh-cline-host-services')
      const response = await api.settings.mutate({
        ns: 'dsh-cline-host-services',
        ops: [{ op: 'set', path: ['checkpointAuto'], value: next }],
        ...(ns?.revision === undefined ? {} : { expectedRevision: ns.revision }),
      })
      if (!response.result.ok) throw new Error(response.result.error.message)
    } catch (err) {
      setError(String(err))
    }
  }

  /** Write the whole mcp.json back with one row changed. */
  const writeMcp = async (mutate: (servers: Record<string, McpServerEntry>) => void): Promise<void> => {
    if (mcpRows === undefined || mcpBusy) return
    setMcpBusy(true)
    setError(undefined)
    try {
      const servers: Record<string, McpServerEntry> = {}
      for (const row of mcpRows) {
        const { name, ...entry } = row
        servers[name] = entry
      }
      mutate(servers)
      await writeMcpServers(servers)
      await reloadMcp()
    } catch (err) {
      setError(String(err))
    } finally {
      setMcpBusy(false)
    }
  }

  const addMcp = async (): Promise<void> => {
    const name = mcpName.trim()
    if (name === '' || mcpBusy) return
    if (mcpTransport === 'stdio' && mcpCommand.trim() === '') {
      setError('stdio 服务器需要 command')
      return
    }
    if (mcpTransport === 'streamable-http' && !/^https?:\/\//.test(mcpUrl.trim())) {
      setError('http 服务器需要以 http(s) 开头的 url')
      return
    }
    await writeMcp(servers => {
      servers[name] = mcpTransport === 'stdio'
        ? { transport: 'stdio', command: mcpCommand.trim() }
        : { transport: 'streamable-http', url: mcpUrl.trim() }
    })
    setMcpAdding(false)
    setMcpName('')
    setMcpCommand('')
    setMcpUrl('')
  }

  /** Ask the VS Code host to restart the DSH service, then reload the GUI. */
  const restart = async (): Promise<void> => {
    if (restartBusy) return
    setRestartBusy(true)
    setRestartNote('重启请求已发送，等待服务恢复…')
    setError(undefined)
    try {
      await restartDshService()
      // The old process dies and a fresh one boots (cold boot can take a
      // minute); poll the health route until the carrier answers again.
      const deadline = Date.now() + 180_000
      for (;;) {
        await new Promise(resolve => { setTimeout(resolve, 3_000) })
        if (Date.now() > deadline) break
        try {
          const response = await fetch('/dsh-cline/health')
          if (response.ok) break
        } catch { /* still down */ }
      }
      setRestartNote('服务已恢复，正在刷新页面…')
      setTimeout(() => { window.location.reload() }, 800)
    } catch (err) {
      setError(String(err))
      setRestartNote(undefined)
    } finally {
      setRestartBusy(false)
    }
  }

  return (
    <div>
      <div className="dshc-card">
        <h3>编辑 Diff 镜像</h3>
        <p className="dshc-desc">DSH 修改文件后，自动在 VS Code 原生 diff 编辑器中呈现变更。</p>
        <div className="dshc-toggle">
          <span className="dshc-status">{diffOnEdit === undefined ? '读取中…' : diffOnEdit ? '已开启' : '已关闭'}</span>
          <button
            type="button"
            className="dshc-switch"
            role="switch"
            aria-checked={diffOnEdit === true}
            disabled={diffOnEdit === undefined || diffBusy}
            onClick={() => { void toggleDiff() }}
          />
        </div>
      </div>

      <div className="dshc-card">
        <h3>检查点自动快照</h3>
        <p className="dshc-desc">在 DSH 工具调用前自动落检查点（影子 git 仓库，可在命令面板恢复）。</p>
        <div className="dshc-seg">
          {(Object.keys(CHECKPOINT_LABELS) as CheckpointAuto[]).map(mode => (
            <button
              key={mode}
              type="button"
              className={checkpointAuto === mode ? 'on' : ''}
              disabled={checkpointAuto === undefined}
              onClick={() => { void setCheckpoint(mode) }}
            >
              {CHECKPOINT_LABELS[mode]}
            </button>
          ))}
        </div>
        {checkpointAuto === undefined && <p className="dshc-hint">保持默认（每次编辑前）。</p>}
      </div>

      <div className="dshc-card">
        <h3>MCP 服务器</h3>
        <p className="dshc-desc">声明在 ~/.dsh-cline/dsh-cline/mcp.json；变更在下次 DSH 启动时生效。</p>
        {mcpRows === undefined && <p className="dshc-status">读取中…</p>}
        {mcpRows !== undefined && mcpRows.length === 0 && <p className="dshc-hint">尚未配置任何 MCP 服务器。</p>}
        <ul className="dshc-list">
          {(mcpRows ?? []).map(row => (
            <li key={row.name}>
              <span className={row.disabled === true ? 'dshc-dot unknown' : 'dshc-dot ok'}
                title={row.disabled === true ? '已停用' : '已启用'} />
              <span className="dshc-list-main">
                <span>{row.name}</span>
                <div className="dshc-list-sub">
                  {row.transport === 'stdio' ? String(row.command ?? '') : String(row.url ?? '')}
                </div>
              </span>
              <button
                type="button"
                className="dshc-btn small ghost"
                disabled={mcpBusy}
                onClick={() => {
                  void writeMcp(servers => {
                    servers[row.name] = { ...servers[row.name], disabled: row.disabled !== true }
                  })
                }}
              >
                {row.disabled === true ? '启用' : '停用'}
              </button>
              <button
                type="button"
                className="dshc-btn small danger"
                disabled={mcpBusy}
                onClick={() => {
                  void writeMcp(servers => { delete servers[row.name] })
                }}
              >
                移除
              </button>
            </li>
          ))}
        </ul>
        {mcpAdding
          ? (
            <div>
              <div className="dshc-row" style={{ marginBottom: 6 }}>
                <input
                  className="dshc-input"
                  placeholder="名称（如 everything）"
                  value={mcpName}
                  onChange={e => { setMcpName(e.target.value) }}
                />
                <select
                  className="dshc-select"
                  style={{ flex: 'none', width: 'min(130px, 45%)' }}
                  value={mcpTransport}
                  onChange={e => { setMcpTransport(e.target.value === 'streamable-http' ? 'streamable-http' : 'stdio') }}
                >
                  <option value="stdio">stdio</option>
                  <option value="streamable-http">HTTP</option>
                </select>
              </div>
              {mcpTransport === 'stdio'
                ? (
                  <input
                    className="dshc-input"
                    placeholder="command（如 npx -y @modelcontextprotocol/server-everything，参数用空格分隔）"
                    value={mcpCommand}
                    onChange={e => { setMcpCommand(e.target.value) }}
                  />
                )
                : (
                  <input
                    className="dshc-input"
                    placeholder="url（http(s)://…）"
                    value={mcpUrl}
                    onChange={e => { setMcpUrl(e.target.value) }}
                  />
                )}
              <div className="dshc-actions" style={{ marginTop: 8 }}>
                <button type="button" className="dshc-btn ghost" disabled={mcpBusy} onClick={() => { setMcpAdding(false) }}>
                  取消
                </button>
                <button type="button" className="dshc-btn" disabled={mcpBusy} onClick={() => { void addMcp() }}>
                  添加
                </button>
              </div>
            </div>
          )
          : (
            <button type="button" className="dshc-btn ghost" disabled={mcpBusy} onClick={() => { setMcpAdding(true) }}>
              + 添加 MCP 服务器
            </button>
          )}
      </div>

      <div className="dshc-card">
        <h3>DSH 服务</h3>
        <p className="dshc-desc">终端常驻的 dsh web 进程：健康检查、卡死/配置异常时原地重启。</p>
        <p className="dshc-status">{health ?? '检测中…'}</p>
        {restartNote !== undefined && <p className="dshc-status ok">{restartNote}</p>}
        <div className="dshc-actions" style={{ marginTop: 8 }}>
          <button type="button" className="dshc-btn" disabled={restartBusy} onClick={() => { void restart() }}>
            {restartBusy ? '重启中…' : '重启 DSH 服务'}
          </button>
        </div>
        <p className="dshc-hint">重启会中断当前会话连接，服务恢复后本页自动刷新。</p>
      </div>

      <div className="dshc-card">
        <h3>关于</h3>
        <p className="dshc-status">
          {'默认供应商：胜算云 · '}
          <span className={ssyKeyed === undefined ? '' : ssyKeyed ? 'dshc-status ok' : 'dshc-status bad'}>
            {ssyKeyed === undefined ? '状态未知' : ssyKeyed ? 'API Key 已配置' : 'API Key 未配置'}
          </span>
          {'（在「模型」页配置）'}
        </p>
        <p className="dshc-hint">DSH Cline：DSH 终端常驻运行 + VS Code 深度集成（方案 F）。</p>
      </div>

      {error !== undefined && <p className="dshc-error">{error}</p>}
    </div>
  )
}
