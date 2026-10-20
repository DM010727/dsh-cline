/**
 * The「DSH Cline」settings section: the fusion-feature configuration after the
 * feature configuration. Cards: the edit-diff mirror, checkpoint policy, MCP server
 * management (file-backed, applies on next boot), the DSH service card
 * (bridge health + in-GUI restart), and about. Reads/writes travel through the
 * plugin's same-origin gateway to the VS Code configuration, the DSH
 * settings/credential wire APIs, and the mcp.json file.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { ClientApi } from './api.ts'
import {
  fetchMcpServers, readVscodeConfig, restartDshService, writeMcpServers,
  writeVscodeConfig, type McpServerEntry, type McpServerRow,
} from './shared.ts'

/** Face the registration injects. */
export interface DshClineSectionInjected {
  api: ClientApi
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

function waitForRestart(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = (): void => {
      clearTimeout(timer)
      reject(new DOMException('Restart cancelled', 'AbortError'))
    }
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, 3_000)
    if (signal.aborted) { abort(); return }
    signal.addEventListener('abort', abort, { once: true })
  })
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
  const [checkpointBusy, setCheckpointBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [health, setHealth] = useState<string | undefined>(undefined)

  const [mcpRows, setMcpRows] = useState<McpRow[] | undefined>(undefined)
  const [mcpBusy, setMcpBusy] = useState(false)
  const [mcpRevision, setMcpRevision] = useState<string | undefined>(undefined)
  const active = useRef(true)
  const mcpGeneration = useRef(0)
  const restartController = useRef<AbortController | undefined>(undefined)
  useEffect(() => {
    active.current = true
    return () => { active.current = false; restartController.current?.abort() }
  }, [])
  const [mcpAdding, setMcpAdding] = useState(false)
  const [mcpName, setMcpName] = useState('')
  const [mcpTransport, setMcpTransport] = useState<'stdio' | 'streamable-http'>('stdio')
  const [mcpCommand, setMcpCommand] = useState('')
  const [mcpUrl, setMcpUrl] = useState('')

  const [restartBusy, setRestartBusy] = useState(false)
  const [restartNote, setRestartNote] = useState<string | undefined>(undefined)

  const reloadMcp = useCallback((): Promise<void> => {
    const generation = ++mcpGeneration.current
    return fetchMcpServers().then(
      value => {
        if (!active.current || generation !== mcpGeneration.current) return
        setMcpRows(value.rows)
        setMcpRevision(value.revision)
      },
      err => { if (active.current && generation === mcpGeneration.current) setError(String(err)) },
    )
  }, [])

  useEffect(() => {
    let cancelled = false
    void readVscodeConfig('diffOnEdit').then(
      v => { if (!cancelled) setDiffOnEdit(v !== false) },
      err => { if (!cancelled) setError(String(err)) },
    )
    void api.settings.describe().then(
      response => {
        if (cancelled || !response.ok) return
        const ns = response.value.namespaces.find(n => n.ns === 'dsh-cline-host-services')
        const value = ns?.value
        const mode = (typeof value === 'object' && value !== null
          ? (value as { checkpointAuto?: unknown }).checkpointAuto
          : undefined)
        if (mode === 'off' || mode === 'edit-only' || mode === 'all') setCheckpointAuto(mode)
      },
      () => { /* namespace absent: plugin config stays at its base default */ },
    )
    void fetch('dsh-cline/health').then(
      async response => {
        if (cancelled) return
        try {
          const body = await response.json() as { bridge?: string; extensionVersion?: string; error?: string }
          if (cancelled) return
          if (body.bridge === 'up') setHealth('桥已连接 · 扩展 v' + String(body.extensionVersion ?? '?'))
          else setHealth('桥未连接（' + String(body.error ?? 'bridge down') + '）')
        } catch { if (!cancelled) setHealth('桥未连接') }
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
    if (checkpointBusy) return
    setCheckpointBusy(true)
    setError(undefined)
    try {
      const described = await api.settings.describe()
      if (!described.ok) throw new Error(described.error.message)
      const ns = described.value.namespaces.find(n => n.ns === 'dsh-cline-host-services')
      if (!described.value.writable || ns === undefined) throw new Error('检查点配置不可写')
      const response = await api.settings.mutate('dsh-cline-host-services',
        [{ op: 'set', path: ['checkpointAuto'], value: next }], ns.revision)
      if (!response.ok) throw new Error(response.error.message)
      setCheckpointAuto(next)
    } catch (err) {
      setError(String(err))
    } finally {
      setCheckpointBusy(false)
    }
  }

  /** Write the whole mcp.json back with one row changed. */
  const writeMcp = async (mutate: (servers: Record<string, McpServerEntry>) => void): Promise<boolean> => {
    if (mcpRows === undefined || mcpRevision === undefined || mcpBusy) return false
    setMcpBusy(true)
    setError(undefined)
    try {
      const servers: Record<string, McpServerEntry> = Object.create(null) as Record<string, McpServerEntry>
      for (const row of mcpRows) {
        const { name, ...entry } = row
        servers[name] = entry
      }
      mutate(servers)
      await writeMcpServers(servers, mcpRevision)
      await reloadMcp()
      return true
    } catch (err) {
      setError(String(err))
      await reloadMcp()
      return false
    } finally {
      setMcpBusy(false)
    }
  }

  const addMcp = async (): Promise<void> => {
    const name = mcpName.trim()
    if (name === '' || mcpBusy) return
    if (['__proto__', 'constructor', 'prototype'].includes(name)) {
      setError('请使用其他 MCP 服务器名称')
      return
    }
    if (mcpRows?.some(row => row.name === name)) {
      setError('该 MCP 服务器名称已存在，请使用其他名称')
      return
    }
    if (mcpTransport === 'stdio' && mcpCommand.trim() === '') {
      setError('stdio 服务器需要 command')
      return
    }
    if (mcpTransport === 'streamable-http' && !/^https?:\/\//.test(mcpUrl.trim())) {
      setError('http 服务器需要以 http(s) 开头的 url')
      return
    }
    const saved = await writeMcp(servers => {
      servers[name] = mcpTransport === 'stdio'
        ? { transport: 'stdio', command: mcpCommand.trim() }
        : { transport: 'streamable-http', url: mcpUrl.trim() }
    })
    if (!saved) return
    setMcpAdding(false)
    setMcpName('')
    setMcpCommand('')
    setMcpUrl('')
  }

  /** Ask the VS Code host to restart the DSH service, then reload the GUI. */
  const restart = async (): Promise<void> => {
    if (restartBusy) return
    setRestartBusy(true)
    setRestartNote('正在请求重启…')
    setError(undefined)
    const controller = new AbortController()
    restartController.current = controller
    const fetchHealth = async (): Promise<{ bridge?: string; instanceId?: string }> => {
      const response = await fetch('dsh-cline/health', {
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5_000)]),
      })
      if (!response.ok) throw new Error('服务健康检查失败')
      return await response.json() as { bridge?: string; instanceId?: string }
    }
    try {
      const before = await fetchHealth()
      if (typeof before.instanceId !== 'string') throw new Error('服务健康检查缺少实例标识，请在 VS Code 重启 DSH 服务')
      await restartDshService()
      setRestartNote('重启请求已发送，等待服务恢复…')
      const deadline = Date.now() + 180_000
      while (Date.now() < deadline) {
        await waitForRestart(controller.signal)
        try {
          const health = await fetchHealth()
          if (health.bridge === 'up' && typeof health.instanceId === 'string' && health.instanceId !== before.instanceId) {
            if (!active.current || controller.signal.aborted) return
            window.location.reload()
            return
          }
        } catch { /* still down */ }
        if (controller.signal.aborted) return
      }
      throw new Error('等待 DSH 重启超时，请检查「DSH Cline 服务」终端或在 VS Code 重试')
    } catch (err) {
      if (active.current && !controller.signal.aborted) {
        setError(String(err))
        setRestartNote(undefined)
      }
    } finally {
      if (active.current) setRestartBusy(false)
      if (restartController.current === controller) restartController.current = undefined
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
              disabled={checkpointAuto === undefined || checkpointBusy}
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
            <button type="button" className="dshc-btn ghost" disabled={mcpBusy || mcpRows === undefined} onClick={() => { setMcpAdding(true) }}>
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
          模型与供应商在「模型」页统一管理。胜算云登录入口位于其供应商卡片中。
        </p>
        <p className="dshc-hint">DSH Cline：DSH 终端常驻运行 + VS Code 深度集成（方案 F）。</p>
      </div>

      {error !== undefined && <p className="dshc-error">{error}</p>}
    </div>
  )
}
