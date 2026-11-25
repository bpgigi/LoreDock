import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode, RefObject } from 'react'
import { Drawer, Popover } from 'antd'
import { ArrowLeft, BookOpen, Download, List, MessageSquare, MessageSquarePlus, Quote, Save, Sparkles, StickyNote, X } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import type { Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Citation, KnowledgeDocument, ReadingSelection } from '../types'
import { createReadingSelection, readingHeadings, resolveReadingRange } from '../readingSelection'
import type { SourceSelection } from '../readingSelection'
import type { CardArticleSource } from '../cardWorkshop'
import MarkdownEditor from './MarkdownEditor'
import { useDocumentDraft } from '../useDocumentDraft'
import './DocumentReader.css'

export interface ReaderNavigationGuard {
  documentId: string
  beforeLeave: () => Promise<boolean>
}

export interface DocumentReaderProps {
  document: KnowledgeDocument
  documents: KnowledgeDocument[]
  spaceName: string
  onSelectDocument: (id: string) => void
  onBack: () => void
  aiPanel: (documentNeedsSave: boolean, onSaveDocument: () => void, selection: ReadingSelection | undefined, onSelectionChange: (selection?: ReadingSelection) => void, focusInputKey: number, cardSelection: CardArticleSource | undefined, article: CardArticleSource) => ReactNode
  onAskSelection: () => void
  conversationKey: string
  citation?: Citation | null
  onSnapshotChange?: (snapshot: boolean) => void
  onNewConversation?: () => void
  citationNavigationKey?: number
  onOpenLink?: (href: string) => void
  onSave: (documentId: string, body: string, expectedVersion: number) => Promise<KnowledgeDocument>
  onCreateCard?: (text: string) => void
  onGenerateCards?: (source: CardArticleSource, whole: boolean) => void
  navigationGuardRef?: RefObject<ReaderNavigationGuard | null>
}

function readerUrlTransform(url: string) {
  const value = url.trim()
  if (!value || /[\u0000-\u001f\u007f\\]/.test(value) || value.startsWith('//')) return ''
  if (/^(?:https?:|mailto:)/i.test(value)) return value
  // Relative Markdown paths and fragments stay in the local notes reader.
  return /^[a-z][a-z\d+.-]*:/i.test(value) ? '' : value
}

function normalizedHeading(value: string) {
  return value.trim().replace(/[*_`~]/g, '').replace(/\s+/g, ' ').toLocaleLowerCase()
}

function headingFragment(value: string) {
  return normalizedHeading(value).replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s+/g, '-')
}

function sourcePosition(node?: { position?: { start: { offset?: number }; end: { offset?: number } } }) {
  return { 'data-reader-start': node?.position?.start.offset, 'data-reader-end': node?.position?.end.offset }
}

export default function DocumentReader({ document: currentDocument, spaceName, onBack, aiPanel, onAskSelection, conversationKey, citation, onSnapshotChange, onNewConversation, citationNavigationKey = 0, onOpenLink, onSave, onCreateCard, onGenerateCards, navigationGuardRef }: DocumentReaderProps) {
  const [outlineOpen, setOutlineOpen] = useState(false)
  const [aiOpen, setAiOpen] = useState(false)
  const [smallScreen, setSmallScreen] = useState(() => window.innerWidth < 1100)
  const [textSize, setTextSize] = useState<'small' | 'medium' | 'large'>('medium')
  const [selectedText, setSelectedText] = useState('')
  const [readingSelection, setReadingSelection] = useState<ReadingSelection>()
  const [cardSelection, setCardSelection] = useState<CardArticleSource>()
  const [clearSelectionKey, setClearSelectionKey] = useState(0)
  const [focusInputKey, setFocusInputKey] = useState(0)
  const [snapshotMode, setSnapshotMode] = useState(() => Boolean(citation && citation.version !== currentDocument.version))
  const [viewMode, setViewMode] = useState<'live' | 'source' | 'read'>(() => currentDocument.type === 'md' && (!citation || citation.version === currentDocument.version) ? 'live' : 'read')
  const lastEditMode = useRef<'live' | 'source'>('live')
  const [focusLine, setFocusLine] = useState(1)
  const [focusToken, setFocusToken] = useState(0)
  const [cursor, setCursor] = useState({ line: 1, column: 1 })
  const contentRef = useRef<HTMLElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const matchingCitation = citation?.documentId === currentDocument.id ? citation : null
  const versionChanged = Boolean(matchingCitation && matchingCitation.version !== currentDocument.version)
  const showSnapshot = snapshotMode && versionChanged && matchingCitation
  const isSnapshot = Boolean(showSnapshot)
  const editable = currentDocument.type === 'md' && !isSnapshot
  const draft = useDocumentDraft(currentDocument, onSave, editable)
  const snapshotRef = useRef(isSnapshot)
  snapshotRef.current = isSnapshot
  useLayoutEffect(() => {
    if (!navigationGuardRef) return
    let active = true
    const guard: ReaderNavigationGuard = {
      documentId: currentDocument.id,
      beforeLeave: async () => {
        if (!active || navigationGuardRef.current !== guard) return false
        const saved = snapshotRef.current || await draft.flush()
        // A save for an old reader must never navigate away from a newer article.
        return Boolean(saved && active && navigationGuardRef.current === guard)
      },
    }
    navigationGuardRef.current = guard
    return () => {
      active = false
      if (navigationGuardRef.current === guard) navigationGuardRef.current = null
    }
  }, [currentDocument.id, navigationGuardRef, draft.flush])
  const editing = editable && viewMode !== 'read'
  const readingBody = showSnapshot ? showSnapshot.excerpt : draft.ready ? draft.body : currentDocument.body
  const readingTitle = showSnapshot ? showSnapshot.title : currentDocument.title
  const readingVersion = showSnapshot ? showSnapshot.version : currentDocument.version
  const headings = useMemo(() => currentDocument.type === 'md' ? readingHeadings(readingBody) : [], [readingBody, currentDocument.type])
  const bodyHasTitle = headings[0]?.depth === 1 && normalizedHeading(headings[0].text) === normalizedHeading(readingTitle)
  const article: CardArticleSource = { documentId: currentDocument.id, spaceId: currentDocument.spaceId, title: readingTitle, version: readingVersion,
    text: readingBody, start: 0, heading: '全文', isDraft: !isSnapshot && readingBody !== currentDocument.body, isHistorical: isSnapshot, sourcePath: isSnapshot ? undefined : currentDocument.sourcePath }

  useEffect(() => { onSnapshotChange?.(isSnapshot) }, [isSnapshot, onSnapshotChange])

  function updateReadingSelection(selection?: ReadingSelection) {
    setReadingSelection(selection)
    // A restored ordinary quote is bounded. Never pass it off as the full card source.
    setCardSelection(undefined)
    setSelectedText('')
    setClearSelectionKey(key => key + 1)
    const active = window.getSelection()
    if (active?.anchorNode && scrollRef.current?.contains(active.anchorNode)) active.removeAllRanges()
  }
  useEffect(() => { updateReadingSelection() }, [currentDocument.id, conversationKey, isSnapshot, citationNavigationKey])

  function captureSelection(text: string, source: SourceSelection) {
    setSelectedText(text.trim().slice(0, 2000))
    const selection = createReadingSelection({ ...source, text, documentId: currentDocument.id, spaceId: currentDocument.spaceId,
      version: readingVersion, title: readingTitle, headings: source.body === readingBody ? headings : undefined,
      fallbackHeading: showSnapshot ? showSnapshot.heading : undefined,
      isDraft: !isSnapshot && source.body !== currentDocument.body, isHistorical: isSnapshot })
    // Keep the attachment when focus moves to the composer or the DOM selection collapses.
    if (selection) {
      setReadingSelection(selection)
      // Card generation keeps the complete raw range, including Markdown/code.
      const text = source.body.slice(source.from, source.to)
      setCardSelection({ ...selection, text, start: source.from, sourcePath: isSnapshot ? undefined : currentDocument.sourcePath })
    }
  }
  const captureRef = useRef(captureSelection)
  captureRef.current = captureSelection

  useEffect(() => {
    if (citationNavigationKey && matchingCitation && window.innerWidth < 1100) setAiOpen(false)
    // The parent increments this even when the same source is clicked again.
  }, [citationNavigationKey])

  useEffect(() => {
    const resize = () => setSmallScreen(window.innerWidth < 1100)
    window.addEventListener('resize', resize)
    return () => window.removeEventListener('resize', resize)
  }, [])

  useEffect(() => {
    setSelectedText('')
    const oldVersion = Boolean(matchingCitation && matchingCitation.version !== currentDocument.version)
    setSnapshotMode(oldVersion)
    if (oldVersion) setViewMode('read')
    setOutlineOpen(false)
    if (scrollRef.current) scrollRef.current.scrollTop = 0
  }, [currentDocument.id, matchingCitation?.id, matchingCitation?.version, citationNavigationKey])

  useEffect(() => {
    const selectionChanged = () => {
      if (editing) return
      const selection = window.getSelection()
      const content = contentRef.current
      if (!selection || !content || selection.isCollapsed || !selection.anchorNode || !selection.focusNode || !content.contains(selection.anchorNode) || !content.contains(selection.focusNode)) {
        setSelectedText('')
        return
      }
      const range = selection.getRangeAt(0)
      const element = (node: Node) => node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement
      const startBlock = element(range.startContainer)?.closest<HTMLElement>('[data-reader-start]')
      const endBlock = element(range.endContainer)?.closest<HTMLElement>('[data-reader-end]')
      const text = selection.toString().trim()
      let start = Number(startBlock?.dataset.readerStart ?? 0)
      let end = Number(endBlock?.dataset.readerEnd ?? readingBody.length)
      if (currentDocument.type === 'txt') {
        const prefix = range.cloneRange()
        prefix.selectNodeContents(content)
        prefix.setEnd(range.startContainer, range.startOffset)
        start = prefix.toString().length
        end = start + range.toString().length
      }
      captureRef.current(text, { body: readingBody, ...resolveReadingRange(readingBody, text, start, end) })
    }
    window.document.addEventListener('selectionchange', selectionChanged)
    return () => window.document.removeEventListener('selectionchange', selectionChanged)
  }, [editing, readingBody, currentDocument.type])

  useEffect(() => {
    if (!editing || !draft.ready || !matchingCitation || versionChanged) return
    const offset = currentDocument.body.indexOf(matchingCitation.excerpt)
    const targetName = matchingCitation.heading.replace(/（第[^）]*字符）$/, '').split('/').at(-1)?.trim()
    const heading = headings.find(item => item.text === targetName || (targetName && item.text.includes(targetName)))
    const line = offset >= 0 ? currentDocument.body.slice(0, offset).split('\n').length
      : heading ? Number(heading.id.replace('reader-heading-', '')) : 1
    setFocusLine(line)
    setFocusToken(previous => previous + 1)
    // Only source navigation moves the cursor; saving or typing must not reset it.
  }, [currentDocument.id, matchingCitation?.id, matchingCitation?.version, citationNavigationKey, draft.ready])

  useEffect(() => {
    if (editing) return
    if (!matchingCitation || versionChanged || !matchingCitation.heading) return
    const offset = currentDocument.body.indexOf(matchingCitation.excerpt)
    if (offset >= 0) {
      const line = currentDocument.body.slice(0, offset).split('\n').length
      const paragraphs = [...(contentRef.current?.querySelectorAll<HTMLElement>('[data-reader-line]') ?? [])]
      const target = paragraphs.filter(item => Number(item.dataset.readerLine) <= line).at(-1) ?? paragraphs[0]
      if (offset === 0) { if (scrollRef.current) scrollRef.current.scrollTop = 0 }
      else target?.scrollIntoView({ block: 'start' })
      if (target) {
        target.classList.add('reader-citation-highlight')
        return () => target.classList.remove('reader-citation-highlight')
      }
      return
    }
    const targetName = matchingCitation.heading.replace(/（第[^）]*字符）$/, '').split('/').at(-1)?.trim()
    const target = headings.find((heading) => heading.text === targetName || (targetName && heading.text.includes(targetName)))
    if (target) contentRef.current?.querySelector(`#${target.id}`)?.scrollIntoView({ block: 'start' })
  }, [matchingCitation, versionChanged, headings, citationNavigationKey, currentDocument.body, editing])

  function jumpToHeading(id: string) {
    if (editing) { setFocusLine(Number(id.replace('reader-heading-', '')) || 1); setFocusToken(previous => previous + 1) }
    else contentRef.current?.querySelector(`#${id}`)?.scrollIntoView({ block: 'start' })
    setOutlineOpen(false)
  }

  async function afterSave(action: () => void) {
    if (isSnapshot || await draft.flush()) action()
  }

  function toggleSnapshot() {
    void afterSave(() => {
      setSnapshotMode(value => !value)
      setSelectedText('')
      if (scrollRef.current) scrollRef.current.scrollTop = 0
    })
  }

  async function changeView(next: 'live' | 'source' | 'read') {
    if (next === 'read' && !isSnapshot && !await draft.flush()) return
    if (next !== 'read') { lastEditMode.current = next; setSnapshotMode(false) }
    setViewMode(next)
  }

  function toggleReading() {
    void changeView(viewMode === 'read' ? lastEditMode.current : 'read')
  }

  function exportMarkdown() {
    const url = URL.createObjectURL(new Blob([readingBody], { type: 'text/markdown;charset=utf-8' }))
    const link = window.document.createElement('a')
    link.href = url
    link.download = isSnapshot ? `引用摘录_V${readingVersion}_${currentDocument.fileName}` : currentDocument.fileName
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  useEffect(() => {
    if (viewMode !== 'read') return
    const listener = (event: KeyboardEvent) => {
      const element = event.target as HTMLElement | null
      if (element?.closest('input,textarea,[contenteditable="true"]')) return
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'e' && editable) { event.preventDefault(); toggleReading() }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's' && editable) { event.preventDefault(); void draft.flush() }
    }
    window.addEventListener('keydown', listener)
    return () => window.removeEventListener('keydown', listener)
  }, [viewMode, editable, draft.flush])

  function openLocalLink(href: string) {
    if (href.startsWith('#')) {
      let fragment = href.slice(1)
      try { fragment = decodeURIComponent(fragment) } catch { /* Match the literal fragment if it is not encoded correctly. */ }
      const target = headings.find((heading) => heading.id === fragment || headingFragment(heading.text) === fragment || heading.text === fragment)
      if (target) { jumpToHeading(target.id); return }
    }
    void afterSave(() => onOpenLink?.(href))
  }

  function askAboutSelection() {
    if (!selectedText) return
    onAskSelection(); setAiOpen(true); setSelectedText(''); setFocusInputKey(key => key + 1)
    window.getSelection()?.removeAllRanges()
  }

  function createSelectionCard() {
    const selection = selectedText
    if (selection && onCreateCard) void afterSave(() => onCreateCard(selection))
  }

  function generateCards(whole: boolean) {
    const source = whole ? article : cardSelection
    if (!source || !onGenerateCards) return
    setAiOpen(true); setSelectedText(''); setFocusInputKey(key => key + 1)
    window.getSelection()?.removeAllRanges()
    onGenerateCards(source, whole)
  }

  const markdownComponents = useMemo<Components>(() => ({
    p: ({ node, children, ...props }) => {
      const raw = readingBody.slice(node?.position?.start.offset ?? 0, node?.position?.end.offset ?? 0)
      const keywords = /^关键词[：:]/.test(raw)
      return <p {...props} {...sourcePosition(node)} className={keywords ? 'reader-keywords' : undefined} data-reader-line={node?.position?.start.line}>{keywords ? raw : children}</p>
    },
    pre: ({ node, children, ...props }) => <pre {...props} {...sourcePosition(node)} data-reader-line={node?.position?.start.line}>{children}</pre>,
    li: ({ node, children, ...props }) => <li {...props} {...sourcePosition(node)} data-reader-line={node?.position?.start.line}>{children}</li>,
    td: ({ node, children, ...props }) => <td {...props} {...sourcePosition(node)}>{children}</td>,
    th: ({ node, children, ...props }) => <th {...props} {...sourcePosition(node)}>{children}</th>,
    h1: ({ node, children, ...props }) => <h1 {...props} {...sourcePosition(node)} id={`reader-heading-${node?.position?.start.line}`}>{children}</h1>,
    h2: ({ node, children, ...props }) => <h2 {...props} {...sourcePosition(node)} id={`reader-heading-${node?.position?.start.line}`}>{children}</h2>,
    h3: ({ node, children, ...props }) => <h3 {...props} {...sourcePosition(node)} id={`reader-heading-${node?.position?.start.line}`}>{children}</h3>,
    h4: ({ node, children, ...props }) => <h4 {...props} {...sourcePosition(node)} id={`reader-heading-${node?.position?.start.line}`}>{children}</h4>,
    h5: ({ node, children, ...props }) => <h5 {...props} {...sourcePosition(node)} id={`reader-heading-${node?.position?.start.line}`}>{children}</h5>,
    h6: ({ node, children, ...props }) => <h6 {...props} {...sourcePosition(node)} id={`reader-heading-${node?.position?.start.line}`}>{children}</h6>,
    a: ({ children, href }) => {
      if (!href) return <span>{children}</span>
      const external = /^(?:https?:|mailto:)/i.test(href)
      return external ? <a href={href} target="_blank" rel="noreferrer noopener">{children}</a> : <a href={href} onClick={(event) => { event.preventDefault(); openLocalLink(href) }}>{children}</a>
    },
    img: ({ alt }) => <span className="reader-image-placeholder">[图片{alt ? `：${alt}` : ''}]</span>,
  }), [headings, onOpenLink, readingBody])

  const outline = <nav className="reader-outline-popover" aria-label="文档目录">{headings.map((heading) => <button type="button" key={heading.id} style={{ paddingLeft: `${10 + Math.min(heading.depth - 1, 3) * 11}px` }} onClick={() => jumpToHeading(heading.id)}>{heading.text}</button>)}</nav>
  const aiNeedsSave = !isSnapshot && (!draft.ready || draft.dirty || draft.saving || draft.body !== currentDocument.body)
  const aiContent = <div className="reader-ai-content"><header className="reader-ai-heading"><div><MessageSquare size={16} /><strong>AI 助手</strong></div><div>{onNewConversation && <button className="reader-icon-button" type="button" aria-label="新建阅读对话" title="新对话" onClick={onNewConversation}><MessageSquarePlus size={16} /></button>}<button className="reader-icon-button" type="button" aria-label="关闭 AI 问答" onClick={() => setAiOpen(false)}><X size={17} /></button></div></header>{aiPanel(aiNeedsSave, () => { void draft.flush() }, readingSelection?.documentId === currentDocument.id ? readingSelection : undefined, updateReadingSelection, focusInputKey, cardSelection?.documentId === currentDocument.id ? cardSelection : undefined, article)}</div>
  const statusText = { loading: '正在恢复文档…', saved: '已保存到此浏览器', modified: '有未保存修改', saving: '正在保存…', error: '保存失败', conflict: '存在版本冲突' }[draft.status]

  return <section className={`document-reader${aiOpen && !smallScreen ? ' document-reader-ai-open' : ''}`} aria-label="资料阅读器">
    <header className="reader-toolbar"><div className="reader-toolbar-inner">
      <div className="reader-toolbar-leading"><button className="reader-back" type="button" onClick={() => { void afterSave(onBack) }} aria-label="返回资料库" title="返回资料库"><ArrowLeft size={17} /></button><span className="reader-toolbar-title" title={`${spaceName} · ${currentDocument.fileName} · V${readingVersion}`}>{readingTitle}</span></div>
      <div className="reader-toolbar-actions">
        {currentDocument.type === 'md' && <div className="reader-view-modes" role="group" aria-label="Markdown 视图">
          {([['live', '实时预览'], ['source', '源码'], ['read', '阅读']] as const).map(([mode, label]) => <button type="button" key={mode} aria-pressed={(isSnapshot ? 'read' : viewMode) === mode} disabled={isSnapshot && mode !== 'read'} onClick={() => { void changeView(mode) }}>{label}</button>)}
        </div>}
        <Popover content={outline} trigger="click" placement="bottomRight" open={outlineOpen && headings.length > 0} onOpenChange={setOutlineOpen}><button className="reader-icon-button reader-outline-trigger" type="button" aria-label="文档目录" aria-haspopup="dialog" aria-expanded={outlineOpen} disabled={!headings.length} title={headings.length ? '目录' : '此文档没有章节目录'}><List size={17} /></button></Popover>
        <div className="reader-font-controls" role="group" aria-label="阅读字号">{([['small', '小'], ['medium', '中'], ['large', '大']] as const).map(([value, label]) => <button key={value} type="button" aria-label={`${label}字号`} aria-pressed={textSize === value} onClick={() => setTextSize(value)}>{label}</button>)}</div>
        {editable && <button type="button" className="reader-icon-button" aria-label="保存文档" title="保存（Ctrl / Cmd + S）" disabled={!draft.ready || draft.saving} onClick={() => { void draft.flush() }}><Save size={16} /></button>}
        <button type="button" className="reader-icon-button reader-export" aria-label="导出 Markdown" title="导出 Markdown 文件" onClick={exportMarkdown}><Download size={16} /></button>
        {onGenerateCards && <button type="button" className="reader-icon-button" aria-label="整篇按章节生成卡片" title={isSnapshot ? '历史摘录不包含整篇文章' : '整篇按章节生成卡片'} disabled={isSnapshot || !draft.ready || !readingBody.trim()} onClick={() => generateCards(true)}><Sparkles size={16} /></button>}
        <button type="button" className={`reader-ai-trigger${aiOpen ? ' reader-ai-trigger-active' : ''}`} aria-label={aiOpen ? '收起 AI 问答' : '唤出 AI 问答'} aria-expanded={aiOpen} title="AI 问答" onClick={() => setAiOpen(open => !open)}><MessageSquare size={16} /><span>AI</span></button>
      </div>
    </div></header>
    <div className="reader-body">
      <div className="reader-main">
        <div className="reader-scroll" ref={scrollRef}>
          <div className={`reader-paper reader-font-${textSize}`}>
            <div className="reader-file-hint" title={spaceName}>{currentDocument.fileName}<span>·</span>V{readingVersion}</div>
            {!editing && !bodyHasTitle && <h1 className="reader-document-title">{readingTitle}</h1>}
            {!isSnapshot && draft.error && <div className="reader-edit-notice" role="alert"><p>{draft.error}</p><div>{draft.status === 'conflict' ? <><button type="button" onClick={draft.useDraftOnCurrent}>使用我的草稿</button><button type="button" onClick={() => { void draft.discardDraft() }}>加载已保存版本</button></> : <button type="button" onClick={() => { void draft.flush() }}>重试保存</button>}<button type="button" onClick={exportMarkdown}>导出草稿</button></div></div>}
            {versionChanged && matchingCitation && <div className="reader-version-notice" role="status"><Quote size={16} /><div><strong>{showSnapshot ? '正在查看引用时的摘录' : '正在阅读当前版本'}</strong><p>引用来自 V{matchingCitation.version}，当前资料为 V{currentDocument.version}。{showSnapshot ? '下方保留原引用内容。' : '当前正文可能与原引用不同。'}</p><button type="button" onClick={toggleSnapshot}>{showSnapshot ? '切换到当前版本' : '返回引用摘录'}</button></div></div>}
            {currentDocument.type === 'md' && draft.ready && <div hidden={!editing}>
              <MarkdownEditor key={currentDocument.id} value={draft.body} onChange={draft.setBody} mode={viewMode === 'source' ? 'source' : 'live'} onSave={() => { void draft.flush() }} onToggleMode={toggleReading} onSelectionChange={captureSelection} clearSelectionKey={clearSelectionKey} onCursorChange={(line, column) => setCursor({ line, column })} readOnly={!editing || draft.discarding} fontSize={textSize === 'small' ? 13 : textSize === 'large' ? 17 : smallScreen ? 14 : 15} focusLine={focusLine} focusToken={focusToken} />
            </div>}
            {editing && !draft.ready && <div className="reader-editor-loading">正在打开编辑器…</div>}
            {!editing && (readingBody.trim() ? <article ref={contentRef} className={`reader-prose${currentDocument.type === 'txt' ? ' reader-prose-text' : ''}`} aria-label="资料正文">{currentDocument.type === 'md' ? <ReactMarkdown skipHtml remarkPlugins={[remarkGfm]} urlTransform={readerUrlTransform} components={markdownComponents}>{readingBody}</ReactMarkdown> : readingBody}</article> : <div className="reader-empty"><BookOpen size={29} /><h2>这份资料还没有正文</h2><p>可以切到实时预览或源码模式开始编辑。</p><button type="button" onClick={() => { void afterSave(onBack) }}>返回资料库</button></div>)}
          </div>
        </div>
        {selectedText && <div className="reader-selection-bar" role="region" aria-label="选中文本操作"><span>已选 {cardSelection?.text.length ?? selectedText.length} 字符</span><button type="button" onPointerDown={(event) => event.preventDefault()} onClick={askAboutSelection}><Quote size={14} />询问 AI</button>{onGenerateCards && <button type="button" onPointerDown={(event) => event.preventDefault()} onClick={() => generateCards(false)}><Sparkles size={14} />AI 生成卡片</button>}{onCreateCard && <button type="button" onPointerDown={(event) => event.preventDefault()} onClick={createSelectionCard}><StickyNote size={14} />存为卡片</button>}<button type="button" className="reader-icon-button" aria-label="取消选中文本" onPointerDown={(event) => event.preventDefault()} onClick={() => updateReadingSelection()}><X size={14} /></button></div>}
      </div>
      {aiOpen && !smallScreen && <aside className="reader-ai-panel" aria-label="AI 阅读问答">{aiContent}</aside>}
    </div>
    <footer className="reader-statusbar"><span title={draft.error || '自动保存到当前浏览器；可导出 Markdown 文件。'} role="status">{isSnapshot ? '历史引用 · 只读' : statusText}</span><span>{readingBody.length.toLocaleString()} 字符{editing ? ` · 第 ${cursor.line} 行，第 ${cursor.column} 列` : ''}</span></footer>
    {smallScreen && <Drawer placement="right" open={aiOpen} onClose={() => setAiOpen(false)} destroyOnHidden size={window.innerWidth < 600 ? '100%' : 410} styles={{ body: { padding: 0 }, header: { display: 'none' } }} rootClassName="reader-ai-drawer">{aiContent}</Drawer>}
  </section>
}
