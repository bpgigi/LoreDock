import { useEffect, useState } from 'react'
import { Input, Popover, Select } from 'antd'
import { Check, ChevronDown, CornerDownLeft, RefreshCw, Search, Settings2, Sparkles } from 'lucide-react'
import type { ProviderProfile } from '../api'
import type { ReasoningSetting } from '../reasoning'
import ReasoningControl from './ReasoningControl'
import './ModelPicker.css'

interface Props {
  providers: ProviderProfile[]
  providerId: string
  model: string
  models: string[]
  loading: boolean
  onProviderChange: (id: string) => void
  onModelChange: (model: string) => void
  onLoadModels: () => void
  onSettings: () => void
  reasoning: ReasoningSetting
  onReasoningChange: (value: ReasoningSetting) => void
}

export default function ModelPicker({ providers, providerId, model, models, loading, onProviderChange, onModelChange, onLoadModels, onSettings, reasoning, onReasoningChange }: Props) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  useEffect(() => { setQuery('') }, [providerId])
  const profile = providers.find(item => item.id === providerId)
  const options = [...new Set([model, profile?.default_model ?? '', ...models].filter(Boolean))]
  const search = query.trim()
  const filtered = options.filter(value => value.toLowerCase().includes(search.toLowerCase()))

  function selectModel(value: string) {
    if (!value.trim()) return
    onModelChange(value.trim())
    setOpen(false)
  }

  if (!providers.length) return <button type="button" className="model-setup" onClick={onSettings}><Sparkles size={15} />选择模型<ChevronDown size={13} /></button>

  return <div className="model-controls"><Popover open={open} onOpenChange={value => { setOpen(value); if (value) setQuery('') }} trigger="click" placement="topLeft" arrow={false}
    content={<div className="model-menu" role="dialog" aria-label="切换 AI 模型" onKeyDown={event => { if (event.key === 'Escape') setOpen(false) }}>
      <div className="model-menu-heading"><strong>选择模型</strong><span>当前服务</span></div>
      <Select aria-label="AI 服务" value={providerId || undefined} placeholder="选择服务" options={providers.map(item => ({ value: item.id, label: item.name }))} onChange={onProviderChange} popupMatchSelectWidth={false} />
      <Input aria-label="搜索或输入模型 ID" placeholder="搜索或输入模型 ID" value={query} onChange={event => setQuery(event.target.value)} prefix={<Search size={14} />} onPressEnter={() => selectModel(search || model)} />
      <div className="model-menu-list" aria-label="可用模型">
        {filtered.map(value => <button type="button" className={`model-menu-option${value === model ? ' is-selected' : ''}`} key={value} aria-label={`选择模型 ${value}`} aria-pressed={value === model} onClick={() => selectModel(value)}><span title={value}>{value}</span>{value === model && <Check size={15} />}</button>)}
        {search && !options.includes(search) && <button type="button" className="model-menu-option model-menu-custom" onClick={() => selectModel(search)}><span>使用 <strong>{search}</strong></span><CornerDownLeft size={14} /></button>}
        {!options.length && !search && <p className="model-menu-empty">输入模型 ID，或刷新服务的模型列表。</p>}
      </div>
      <div className="model-menu-footer">
        <button type="button" disabled={loading || !providerId} onClick={onLoadModels}><RefreshCw size={14} className={loading ? 'chat-spin' : ''} />{loading ? '读取中…' : '刷新列表'}</button>
        <button type="button" onClick={() => { setOpen(false); onSettings() }}><Settings2 size={14} />API 设置</button>
      </div>
    </div>}>
    <button className="model-trigger" type="button" aria-label={`切换模型，当前 ${model || '未选择'}`} aria-haspopup="dialog" aria-expanded={open} title={`${profile?.name ?? ''} · ${model || '选择模型'}`}>
      <Sparkles size={15} strokeWidth={1.7} /><span>{model || '选择模型'}</span><ChevronDown size={13} className="model-trigger-chevron" />
    </button>
  </Popover><ReasoningControl model={model} providerId={providerId} value={reasoning} onChange={onReasoningChange} /></div>
}
