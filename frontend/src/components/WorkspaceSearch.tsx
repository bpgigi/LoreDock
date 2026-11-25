import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { Input, Modal } from 'antd'
import type { InputRef } from 'antd'
import { ArrowUpRight, FileText, Layers2, MessageSquare, Search, StickyNote } from 'lucide-react'
import { searchWorkspace } from '../workspaceSearch'
import type { SearchKind, WorkspaceSearchResult } from '../workspaceSearch'
import type { WorkspaceData } from '../storage'
import './WorkspaceSearch.css'

const categories = [
  { kind: 'document', label: '资料', Icon: FileText },
  { kind: 'card', label: '卡片', Icon: StickyNote },
  { kind: 'conversation', label: '对话', Icon: MessageSquare },
  { kind: 'space', label: '空间', Icon: Layers2 },
] as const

export default function WorkspaceSearch({ open, data, initialKind = 'all', onClose, onSelect }: {
  open: boolean; data: WorkspaceData; initialKind?: SearchKind | 'all'; onClose: () => void; onSelect: (result: WorkspaceSearchResult) => void
}) {
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState<SearchKind | 'all'>(initialKind)
  const [active, setActive] = useState(0)
  const [limit, setLimit] = useState(30)
  const input = useRef<InputRef>(null)
  const list = useRef<HTMLDivElement>(null)
  const id = useId()
  const results = useMemo(() => searchWorkspace(data, query), [data, query])
  const groups = categories.filter(category => kind === 'all' || kind === category.kind).map(category => {
    const matches = results.filter(result => result.kind === category.kind)
    return { ...category, total: matches.length, items: matches.slice(0, kind === 'all' ? 5 : limit) }
  })
  const visible = groups.flatMap(group => group.items)
  const current = visible[Math.min(active, visible.length - 1)]

  useEffect(() => {
    if (open) { setQuery(''); setKind(initialKind); setActive(0); setLimit(30) }
  }, [open, initialKind])
  useEffect(() => { setActive(0); setLimit(30); list.current?.scrollTo(0, 0) }, [query, kind])
  useEffect(() => {
    if (current) document.getElementById(`${id}-${current.key}`)?.scrollIntoView({ block: 'nearest' })
  }, [active, current?.key, id])

  return <Modal title="快速查找" open={open} footer={null} onCancel={onClose} width={640} className="workspace-search" afterOpenChange={shown => { if (shown) input.current?.focus() }}>
    <Input ref={input} prefix={<Search size={18} />} allowClear placeholder="搜索资料、卡片、对话或空间…" value={query}
      onChange={event => setQuery(event.target.value)} role="combobox" aria-label="搜索工作区" aria-autocomplete="list" aria-expanded="true" aria-controls={`${id}-results`} aria-activedescendant={current ? `${id}-${current.key}` : undefined}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing || event.keyCode === 229) return
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault()
          if (visible.length) setActive(previous => (previous + (event.key === 'ArrowDown' ? 1 : -1) + visible.length) % visible.length)
        } else if (event.key === 'Enter' && current) { event.preventDefault(); onSelect(current) }
      }} />
    <div className="workspace-search-types" role="group" aria-label="查找类型">
      <button type="button" aria-pressed={kind === 'all'} onClick={() => setKind('all')}>全部</button>
      {categories.map(category => <button type="button" key={category.kind} aria-pressed={kind === category.kind} onClick={() => setKind(category.kind)}>{category.label}</button>)}
    </div>
    <div ref={list} id={`${id}-results`} className="workspace-search-results" role="listbox" aria-label="查找结果">
      {groups.map(group => group.total > 0 && <div key={group.kind} role="group" aria-label={group.label}>
        <div className="workspace-search-group"><span>{!query.trim() && group.kind === 'document' ? '最近更新的资料' : !query.trim() && group.kind === 'conversation' ? '历史对话' : group.label}</span><small>{group.total}</small></div>
        {group.items.map(result => <button type="button" id={`${id}-${result.key}`} key={result.key} role="option" aria-selected={current?.key === result.key} className={`workspace-search-result${current?.key === result.key ? ' is-active' : ''}`} onFocus={() => setActive(visible.findIndex(item => item.key === result.key))} onClick={() => onSelect(result)}>
          <span className={`workspace-search-icon is-${result.kind}`}><group.Icon size={18} /></span>
          <span className="workspace-search-copy"><strong>{result.title}</strong><span>{result.kind !== 'space' && <small>{result.spaceName}</small>}{result.detail && <span>{result.detail}</span>}</span></span>
          <ArrowUpRight size={15} className="workspace-search-arrow" />
        </button>)}
        {group.total > group.items.length && <button type="button" className="workspace-search-more" onClick={() => { if (kind === 'all') setKind(group.kind); else setLimit(previous => previous + 30); input.current?.focus() }}>查看更多{group.label}（还有 {group.total - group.items.length} 项）</button>}
      </div>)}
      {!visible.length && <div className="workspace-search-empty"><Search size={25} /><strong>没有找到匹配内容</strong><p>换个关键词，或试试其他类型。</p><button type="button" onClick={() => { setQuery(''); setKind('all'); input.current?.focus() }}>清空并查看全部</button></div>}
    </div>
    <div className="workspace-search-footer"><span>{query.trim() ? '在本机工作区查找' : '输入关键词，快速回到已有内容'}</span><span className="workspace-search-keys">↑ ↓ 选择 · Enter 打开 · Esc 关闭</span></div>
  </Modal>
}
