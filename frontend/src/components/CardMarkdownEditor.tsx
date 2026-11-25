import { useState } from 'react'
import MarkdownEditor from './MarkdownEditor'
import './CardMarkdownEditor.css'

interface Props {
  value: string
  onChange: (value: string) => void
  onSave: () => void
  disabled?: boolean
  inputId?: string
}

export default function CardMarkdownEditor({ value, onChange, onSave, disabled = false, inputId = 'knowledge-card-body' }: Props) {
  const [mode, setMode] = useState<'live' | 'source'>('live')
  return <div className={`card-markdown-field${disabled ? ' card-markdown-disabled' : ''}`}>
    <div className="card-markdown-toolbar">
      <span>Markdown</span>
      <div role="group" aria-label="卡片正文视图">{([['live', '实时预览'], ['source', '源码']] as const).map(([value, label]) => <button type="button" key={value} aria-pressed={mode === value} disabled={disabled} onClick={() => setMode(value)}>{label}</button>)}</div>
    </div>
    <MarkdownEditor value={value} onChange={onChange} mode={mode} onSave={onSave} onToggleMode={() => { if (!disabled) setMode(previous => previous === 'live' ? 'source' : 'live') }} readOnly={disabled} fontSize={14} previewTables inputId={inputId} ariaLabel="卡片 Markdown 正文" required placeholder="写下用法、区别和一个最小例子…" />
  </div>
}
