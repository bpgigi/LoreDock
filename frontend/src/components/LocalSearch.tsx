import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { Modal } from 'antd'
import { ArrowUpRight, Check, LoaderCircle, Search } from 'lucide-react'
import type { Citation } from '../types'
import './LocalSearch.css'

export interface LocalSearchResult {
  citations: Citation[]
  context_note: string
}

export interface LocalSearchProps {
  open: boolean
  onClose: () => void
  spaceName: string
  documentCount: number
  onSearch: (question: string, signal: AbortSignal) => Promise<LocalSearchResult>
  onSave: (signal: AbortSignal) => Promise<{ saved: number }>
  onOpenCitation: (citation: Citation) => void
}

interface SearchResult extends LocalSearchResult {
  question: string
}

export default function LocalSearch({
  open, onClose, spaceName, documentCount, onSearch, onSave, onOpenCitation,
}: LocalSearchProps) {
  const [query, setQuery] = useState('')
  const [pending, setPending] = useState<'search' | 'save' | null>(null)
  const [result, setResult] = useState<SearchResult | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const request = useRef<AbortController | null>(null)
  const epoch = useRef(0)
  // Also guard the render-to-effect interval when a parent switches the scope.
  const currentScope = useRef({ open, spaceName })
  currentScope.current = { open, spaceName }

  useEffect(() => {
    epoch.current += 1
    request.current?.abort()
    request.current = null
    setPending(null)
    setQuery('')
    setResult(null)
    setError('')
    setNotice('')
    return () => {
      epoch.current += 1
      request.current?.abort()
      request.current = null
    }
  }, [open, spaceName])

  function stopRequest() {
    epoch.current += 1
    request.current?.abort()
    request.current = null
    setPending(null)
  }

  function close() {
    stopRequest()
    onClose()
  }

  function cancel() {
    stopRequest()
    setNotice('已取消等待；已完成的本机保存会保留。')
  }

  async function run(kind: 'search' | 'save') {
    const question = query.trim()
    // The ref prevents a second click before React commits the busy state.
    if (!open || request.current || !documentCount || (kind === 'search' && !question)) return
    const controller = new AbortController()
    const token = ++epoch.current
    const scope = spaceName
    request.current = controller
    setPending(kind)
    setError('')
    setNotice('')
    if (kind === 'search') setResult(null)
    const isCurrent = () => token === epoch.current && !controller.signal.aborted
      && currentScope.current.open && currentScope.current.spaceName === scope

    try {
      if (kind === 'search') {
        const found = await onSearch(question, controller.signal)
        if (isCurrent()) setResult({ ...found, question })
      } else {
        const saved = await onSave(controller.signal)
        if (isCurrent()) setNotice(`已保存 ${saved.saved} 份本机副本。`)
      }
    } catch (cause) {
      if (isCurrent()) setError(cause instanceof Error ? cause.message : '操作没有完成，请重试。')
    } finally {
      if (token === epoch.current) {
        request.current = null
        setPending(null)
      }
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    void run('search')
  }

  function openSource(citation: Citation) {
    close()
    onOpenCitation(citation)
  }

  return (
    <Modal title="资料检索" open={open} onCancel={close} footer={null} width={680}
      className="local-search-modal" destroyOnHidden>
      <div className="local-search">
        <p className="local-search-intro">先在本机查找资料，再决定是否提问。</p>
        <div className="local-search-scope"><span title={spaceName}>{spaceName}</span><span>{documentCount} 份可读资料 · 关键词检索</span></div>
        <form className="local-search-form" onSubmit={submit}>
          <label className="local-search-input">
            <Search size={17} aria-hidden="true" />
            <input aria-label="检索资料正文" placeholder="输入关键词，如 Python 字典…" value={query}
              onChange={(event) => setQuery(event.target.value)} maxLength={4000}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.nativeEvent.isComposing || event.keyCode === 229)) event.preventDefault()
              }} />
          </label>
          <button type="submit" className="local-search-submit" disabled={Boolean(pending) || !documentCount || !query.trim()}>检索</button>
        </form>
        <div className="local-search-actions">
          <button type="button" className="local-search-secondary" disabled={Boolean(pending) || !documentCount} onClick={() => { void run('save') }}>保存本机副本</button>
          {pending && <button type="button" className="local-search-secondary" onClick={cancel}>取消</button>}
        </div>

        {pending && <p className="local-search-feedback" role="status"><LoaderCircle size={15} className="local-search-spinner" aria-hidden="true" />{pending === 'search' ? '正在保存最新资料并检索…' : '正在保存本机副本…'}</p>}
        {error && <div className="local-search-error" role="alert">{error}</div>}
        {notice && <p className="local-search-feedback" role="status"><Check size={15} aria-hidden="true" />{notice}</p>}

        {!documentCount && <div className="local-search-empty"><p>这个空间还没有可读资料。</p><span>先添加 Markdown 或 TXT 文件。</span></div>}

        {result && <section className="local-search-results" aria-label="检索结果">
          <p className="local-search-result-count" role="status">“{result.question}” · {result.citations.length} 个相关片段</p>
          {result.citations.length ? <ol className="local-search-result-list">
            {result.citations.map((citation) => <li className="local-search-result" key={citation.id}>
              <div className="local-search-result-heading">
                <h3>{citation.title}</h3><span>V{citation.version}</span>
              </div>
              <p className="local-search-heading-path">{citation.heading}</p>
              <p className="local-search-excerpt">{citation.excerpt}</p>
              <button type="button" className="local-search-source" onClick={() => openSource(citation)}>打开原文<ArrowUpRight size={14} aria-hidden="true" /></button>
            </li>)}
          </ol> : <div className="local-search-empty"><p>没有找到相关片段。</p><span>试试更具体的关键词，或使用笔记中的术语。</span></div>}
          {result.context_note && <p className="local-search-context-note">{result.context_note}</p>}
        </section>}
      </div>
    </Modal>
  )
}
