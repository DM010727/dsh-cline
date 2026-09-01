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
 * Catalog rows whose zero pricing does NOT mean free (e.g. a promo or
 * mispriced listing the platform does not treat as free).
 */
const NOT_FREE_IDS = new Set(['deepseek/deepseek-v3.1-think'])

/**
 * Whether a catalog row is free: every price component is zero. The catalog's
 * own pricing is authoritative (e.g. qwen3.5-4b, 书生 intern 系列, agnes flash,
 * 快手 kat-coder 系列 — and anything Shengsuanyun marks free later).
 */
function isFreeModel(model: SsyModel): boolean {
  if (NOT_FREE_IDS.has(model.id)) return false
  const p = model.pricing
  if (p === undefined) return false
  return Number(p.price) === 0
    && Number(p.input_price) === 0
    && Number(p.output_price) === 0
    && Number(p.cached_price ?? p.price) === 0
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
    // Free models get their own head group (they are also excluded from the
    // per-company groups so nothing is listed twice).
    const free = matched.filter(isFreeModel)
    const paid = matched.filter(m => !isFreeModel(m))
    const groups = new Map<string, SsyModel[]>()
    if (free.length > 0) groups.set('免费模型（0 元）', free)
    for (const model of paid) {
      const key = model.company ?? '其他'
      const bucket = groups.get(key) ?? []
      bucket.push(model)
      groups.set(key, bucket)
    }
    return [...groups.entries()]
  }, [models, filter])

  const selected = models.find(m => m.id === value)
  const freeCount = models.filter(isFreeModel).length

  return (
    <div className="dshc-field">
      <label className="dshc-label">
        {'模型（共 ' + String(models.length) + ' 个 · 免费 ' + String(freeCount) + ' 个，输入过滤）'}
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
                {isFreeModel(m) ? ' · 免费' : ''}
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
          {isFreeModel(selected)
            ? ' · 免费（0 元）'
            : selected.pricing?.input_price !== undefined
              ? ' · ¥' + String(selected.pricing.input_price) + '/百万输入'
              : ''}
        </p>
      )}
    </div>
  )
}
