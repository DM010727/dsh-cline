/**
 * The Shengsuanyun model picker shared by the first-run onboarding and the
 * 「模型」page default-provider card: catalog through the same-origin gateway,
 * a filter box, a grouped select, and the selected model's context/price line.
 *
 * @module @dsh-cline/host-services/client/ssy-models
 */

import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { fetchSsyModels, type SsyModel } from './shared.ts'

/** Props of {@link SsyModelSelect}. */
export interface SsyModelSelectProps {
  /** Currently selected model id (controlled). */
  value: string
  /** Selection change, handed the full catalog row (context/price info). */
  onChange: (model: SsyModel) => void
  /** Compact height for modal layouts (fewer visible rows). */
  compact?: boolean
}

/**
 * Filter + grouped catalog select + selected-model detail line.
 * @returns the picker element tree.
 */
export function SsyModelSelect(props: SsyModelSelectProps): ReactNode {
  const { value, onChange, compact = false } = props
  const [models, setModels] = useState<SsyModel[]>([])
  const [error, setError] = useState<string | undefined>(undefined)
  const [filter, setFilter] = useState('')

  useEffect(() => {
    let cancelled = false
    void fetchSsyModels().then(
      list => { if (!cancelled) setModels(list) },
      err => { if (!cancelled) setError(String(err)) },
    )
    return () => { cancelled = true }
  }, [])

  const grouped = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    const matched = models.filter(m =>
      needle === ''
      || m.id.toLowerCase().includes(needle)
      || (m.name ?? '').toLowerCase().includes(needle)
      || (m.company ?? '').toLowerCase().includes(needle))
    const groups = new Map<string, SsyModel[]>()
    for (const model of matched) {
      const key = model.company ?? '其他'
      const bucket = groups.get(key) ?? []
      bucket.push(model)
      groups.set(key, bucket)
    }
    return [...groups.entries()]
  }, [models, filter])

  const selected = models.find(m => m.id === value)

  return (
    <div className="dshc-field">
      <label className="dshc-label">
        {'模型（共 ' + String(models.length) + ' 个，输入过滤）'}
      </label>
      <input
        className="dshc-input dshc-model-filter"
        value={filter}
        placeholder="按名称/厂商过滤，如 deepseek、claude"
        onChange={e => { setFilter(e.target.value) }}
      />
      <select
        className="dshc-select"
        size={compact ? 6 : 8}
        value={value}
        onChange={e => {
          const next = models.find(m => m.id === e.target.value)
          if (next !== undefined) onChange(next)
        }}
      >
        {error !== undefined && <option value="">{error}</option>}
        {error === undefined && models.length === 0 && <option value="">模型列表加载中…</option>}
        {grouped.map(([company, list]) => (
          <optgroup key={company} label={company}>
            {list.map(m => (
              <option key={m.id} value={m.id}>
                {m.id}
                {m.context_window !== undefined ? ' · ' + String(Math.round(m.context_window / 1000)) + 'k' : ''}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      {selected !== undefined && (
        <p className="dshc-hint">
          {selected.name ?? selected.id}
          {selected.context_window !== undefined ? ' · 上下文 ' + String(selected.context_window) : ''}
          {selected.pricing?.input_price !== undefined
            ? ' · ¥' + String(selected.pricing.input_price) + '/百万输入'
            : ''}
        </p>
      )}
    </div>
  )
}
