/** Explicit Shengsuanyun model selection for the optional recommendation. */
import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { isFreeModel, type SsyModel } from './shared.ts'
function optionLabel(model: SsyModel): string {
  return model.id + (isFreeModel(model) ? ' · 目录标价 0 元' : '')
    + (model.context_window === undefined ? '' : ' · ' + String(Math.round(model.context_window / 1000)) + 'k')
}
function groupModels(models: SsyModel[], filter: string): Array<[string, SsyModel[]]> {
  const needle = filter.trim().toLowerCase()
  const groups = new Map<string, SsyModel[]>()
  const free: SsyModel[] = []
  for (const model of models) {
    if (needle !== '' && !model.id.toLowerCase().includes(needle)
      && !(model.name ?? '').toLowerCase().includes(needle)
      && !(model.company ?? '').toLowerCase().includes(needle)) continue
    if (isFreeModel(model)) { free.push(model); continue }
    const label = model.company ?? '其他'
    const group = groups.get(label) ?? []
    group.push(model)
    groups.set(label, group)
  }
  return [...(free.length === 0 ? [] : [['目录标价 0 元', free] as [string, SsyModel[]]]), ...groups]
}
export interface SsyModelMultiSelectProps {
  models: SsyModel[]
  selectedIds: readonly string[]
  onChange: (ids: string[]) => void
  disabled?: boolean
}
export function SsyModelMultiSelect({ models, selectedIds, onChange, disabled = false }: SsyModelMultiSelectProps): ReactNode {
  const [filter, setFilter] = useState('')
  const grouped = useMemo(() => groupModels(models, filter), [models, filter])
  const selected = useMemo(() => new Set(selectedIds), [selectedIds])
  const freeCount = useMemo(() => models.filter(isFreeModel).length, [models])
  const setGroup = (list: readonly SsyModel[], on: boolean): void => {
    const ids = new Set(list.map(model => model.id))
    onChange(on ? [...new Set([...selectedIds, ...ids])] : selectedIds.filter(id => !ids.has(id)))
  }
  const count = models.reduce((total, model) => total + Number(selected.has(model.id)), 0)
  const allSelected = models.length > 0 && count === models.length
  return (
    <div className="dshc-field">
      <label className="dshc-label">{'模型（共 ' + String(models.length) + ' 个 · 目录标价 0 元 ' + String(freeCount) + ' 个）'}</label>
      <input className="dshc-input dshc-model-filter" value={filter} placeholder="按名称或厂商过滤" onChange={event => { setFilter(event.target.value) }} />
      <div className="dshc-mchk-toolbar">
        <label className="dshc-mchk-head" style={{ padding: '0 4px' }}>
          <input type="checkbox" checked={allSelected} disabled={disabled || models.length === 0}
            ref={element => { if (element !== null) element.indeterminate = !allSelected && count > 0 }}
            onChange={() => { setGroup(models, !allSelected) }} />
          {'全选（' + String(count) + '/' + String(models.length) + '）'}
        </label>
        <button type="button" className="dshc-btn small ghost" disabled={disabled} onClick={() => { onChange([]) }}>清空</button>
      </div>
      <div className="dshc-mchk-list">
        {models.length === 0 && <div className="dshc-empty">暂无可用模型</div>}
        {grouped.map(([company, list]) => {
          const picked = list.filter(model => selected.has(model.id)).length
          const groupAll = picked === list.length
          return (
            <div key={company}>
              <label className="dshc-mchk-head">
                <input type="checkbox" checked={groupAll} disabled={disabled}
                  ref={element => { if (element !== null) element.indeterminate = picked > 0 && !groupAll }}
                  onChange={() => { setGroup(list, !groupAll) }} />
                {company + '（' + String(picked) + '/' + String(list.length) + '）'}
              </label>
              {list.map(model => (
                <label key={model.id} className="dshc-mchk-item">
                  <input type="checkbox" checked={selected.has(model.id)} disabled={disabled}
                    onChange={() => { onChange(selected.has(model.id) ? selectedIds.filter(id => id !== model.id) : [...selectedIds, model.id]) }} />
                  {optionLabel(model)}
                </label>
              ))}
            </div>
          )
        })}
      </div>
      <p className="dshc-hint">{count === 0 ? '请至少勾选一个模型，或点击全选。' : '仅保存勾选的 ' + String(count) + ' 个模型。'}</p>
      <p className="dshc-hint">模型标价以目录为准，实际费用以供应商结算为准。</p>
    </div>
  )
}
