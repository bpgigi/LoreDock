import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import type { ReactNode } from 'react'
import { Checkbox, Modal } from 'antd'
import {
  ArrowRight,
  ArrowUp,
  BookOpen,
  Check,
  ChevronDown,
  Code2,
  Copy,
  CornerDownLeft,
  FileText,
  Gamepad2,
  Layers3,
  LoaderCircle,
  MessageSquarePlus,
  Printer,
  Quote,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Square,
  StickyNote,
  Upload,
  X,
} from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Citation, Conversation, KnowledgeDocument, ReadingSelection, RelatedCard, Space } from '../types'
import './ChatWorkspace.css'

export interface ChatWorkspaceProps {
  space: Space
  spaces: Space[]
  documents: KnowledgeDocument[]
  conversation: Conversation
  scopeIds: string[]
  draft: string
  busy: boolean
  onDraftChange: (value: string) => void
  onScopeChange: (ids: string[]) => void
  onSend: (question: string) => void
  onCancel: () => void
  onOpenCitation: (citation: Citation) => void
  onOpenRelatedCard: (card: RelatedCard) => void
  onUpload: () => void
  onNewConversation: () => void
  modelControls?: ReactNode
  compact?: boolean
  documentTitle?: string
  referenceDocuments: boolean
  onReferenceDocumentsChange: (enabled: boolean) => void
  documentNeedsSave?: boolean
  onSaveDocument?: () => void
  readingSelection?: ReadingSelection
  onReadingSelectionChange?: (selection?: ReadingSelection) => void
  focusInputKey?: number
  cardPanel?: ReactNode
  cardBusy?: boolean
  isCardCommand?: (question: string) => boolean
}

const questionsBySpace: Record<string, { label: string; question: string }[]> = {
  python: [
    { label: '理解一个知识点', question: 'FastAPI 中如何统一处理异常？' },
    { label: '查找实践方法', question: '接口出错时，前后端应该如何处理？' },
    { label: '核对开发约定', question: '开发日志中应该记录什么，避免记录什么？' },
  ],
  ai: [
    { label: '理解一个知识点', question: 'RAG 的检索范围应该怎样限制？' },
    { label: '查找实践方法', question: '如何核对回答中的引用是否可靠？' },
    { label: '核对开发约定', question: '更换 Embedding 模型后需要做什么？' },
  ],
  game: [
    { label: '回看项目规则', question: '目前记录的回合结算流程是什么？' },
    { label: '寻找待办事项', question: '地图岔路规则有哪些尚未确定的部分？' },
    { label: '整理已有资料', question: '请区分回合流程草案中的已有记录与待确认事项。' },
  ],
  printing: [
    { label: '查找实践记录', question: '我的资料中有哪些打印失败记录？' },
    { label: '核对设备参数', question: '资料中记录的设备与耗材参数是什么？' },
    { label: '整理已有经验', question: '请根据已有打印记录整理需要检查的事项。' },
  ],
}

const spaceIcons = { code: Code2, sparkles: Sparkles, printer: Printer, game: Gamepad2 }

function copyTextWithSelection(text: string) {
  const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null
  const selection = document.getSelection()
  const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange()) : []
  const input = focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement ? focused : null
  const inputSelection = input && input.selectionStart !== null && input.selectionEnd !== null
    ? { start: input.selectionStart, end: input.selectionEnd, direction: input.selectionDirection ?? 'none' as const } : null
  const field = document.createElement('textarea')
  field.value = text
  field.readOnly = true
  field.tabIndex = -1
  field.setAttribute('aria-hidden', 'true')
  field.style.cssText = 'position:fixed;top:0;left:-9999px;width:1px;height:1px;opacity:0;pointer-events:none;'
  try {
    document.body.append(field)
    field.focus({ preventScroll: true })
    field.select()
    return document.execCommand('copy')
  } finally {
    field.remove()
    if (focused?.isConnected) focused.focus({ preventScroll: true })
    if (input?.isConnected && inputSelection) input.setSelectionRange(inputSelection.start, inputSelection.end, inputSelection.direction)
    else if (selection) {
      selection.removeAllRanges()
      for (const range of ranges) {
        if (range.startContainer.isConnected && range.endContainer.isConnected) selection.addRange(range)
      }
    }
  }
}

function CopyAnswer({ body }: { body: string }) {
  const [status, setStatus] = useState<'idle' | 'copying' | 'copied' | 'failed'>('idle')
  const resetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const active = useRef(true)

  useEffect(() => {
    active.current = true
    return () => { active.current = false; clearTimeout(resetTimer.current) }
  }, [])

  async function copy() {
    clearTimeout(resetTimer.current)
    setStatus('copying')
    try {
      try {
        if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable')
        await navigator.clipboard.writeText(body)
      } catch {
        // Electron may deny the asynchronous clipboard permission. This fallback
        // stays in the user's copy action and never changes desktop permissions.
        if (!active.current || !copyTextWithSelection(body)) throw new Error('Clipboard copy failed')
      }
      if (!active.current) return
      setStatus('copied')
      resetTimer.current = setTimeout(() => setStatus('idle'), 2000)
    } catch {
      if (active.current) setStatus('failed')
    }
  }

  return <div className="chat-answer-actions">
    <button className="chat-copy-answer" type="button" aria-label="复制回答" title="复制 Markdown 原文" disabled={status === 'copying'} onClick={() => { void copy() }}>
      {status === 'copied' ? <Check size={14} /> : <Copy size={14} />}<span aria-live="polite">{status === 'copied' ? '已复制' : status === 'copying' ? '复制中…' : '复制'}</span>
    </button>
    {status === 'failed' && <span className="chat-copy-error" role="status">复制失败，请选中正文手动复制。</span>}
  </div>
}

function SelectionQuote({ selection, onRemove }: { selection: ReadingSelection; onRemove?: () => void }) {
  return <div className={`chat-selection${onRemove ? ' chat-selection-attached' : ' chat-selection-sent'}`}>
    <details>
      <summary><Quote size={15} /><span><small>{onRemove ? '已选文字 · 附带附近原文' : '本轮选文'}</small><span className="chat-selection-text">{selection.text}</span></span><ChevronDown size={14} /></summary>
      <div className="chat-selection-detail">
        <span>{selection.title} · V{selection.version}{selection.isHistorical ? ' 历史摘录' : selection.isDraft ? ' 编辑中快照' : ''}</span>
        <strong>{selection.heading}</strong>
        <blockquote>{selection.text}</blockquote>
        {selection.truncated && <span>选文较长，已截取前 2000 字。</span>}
        <small>随问题附带的附近原文</small><pre>{selection.context}</pre>
      </div>
    </details>
    {onRemove && <button type="button" className="chat-selection-remove" aria-label="移除选文" title="移除本轮选文" onClick={onRemove}><X size={14} /></button>}
  </div>
}

export default function ChatWorkspace({
  space,
  spaces,
  documents,
  conversation,
  scopeIds,
  draft,
  busy,
  onDraftChange,
  onScopeChange,
  onSend,
  onCancel,
  onOpenCitation,
  onOpenRelatedCard,
  onUpload,
  onNewConversation,
  modelControls,
  compact = false,
  documentTitle,
  referenceDocuments,
  onReferenceDocumentsChange,
  documentNeedsSave = false,
  onSaveDocument,
  readingSelection,
  onReadingSelectionChange,
  focusInputKey,
  cardPanel,
  cardBusy = false,
  isCardCommand,
}: ChatWorkspaceProps) {
  const [scopeOpen, setScopeOpen] = useState(false)
  const [pendingScope, setPendingScope] = useState<string[]>(scopeIds)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const availableDocuments = documents.filter((document) => document.status === 'available')
  const selectedSpaces = spaces.filter((item) => scopeIds.includes(item.id))
  const hasMessages = conversation.messages.length > 0 || Boolean(cardPanel)
  const examples = questionsBySpace[space.id] ?? [
    { label: '快速了解资料', question: '这个空间的资料主要涉及哪些内容？' },
    { label: '查找相关依据', question: '请根据已有资料整理最重要的知识点，并提供来源。' },
    { label: '回看待确认事项', question: '资料中有哪些尚未确定的问题？' },
  ]
  const hasLoadingMessage = conversation.messages.some((message) => message.status === 'loading')
  const lastMessage = conversation.messages.at(-1)
  const saveBlocked = referenceDocuments && documentNeedsSave && !isCardCommand?.(draft)

  useEffect(() => { if (focusInputKey) textareaRef.current?.focus() }, [focusInputKey])

  useLayoutEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.style.height = 'auto'
    textarea.style.height = `${Math.min(textarea.scrollHeight, 154)}px`
  }, [draft, conversation.id])

  useEffect(() => {
    const scroll = scrollRef.current
    if (!scroll) return
    const answer = scroll.querySelector('.chat-message:last-child')
    if (cardPanel && answer) scroll.scrollTop += answer.getBoundingClientRect().top - scroll.getBoundingClientRect().top
    else scroll.scrollTop = conversation.messages.length ? scroll.scrollHeight : 0
    // Card work has separate progress; it must not scroll an ordinary answer away.
  }, [conversation.id, conversation.messages.length, lastMessage?.body])

  const hasCardPanel = Boolean(cardPanel)
  useEffect(() => {
    const scroll = scrollRef.current
    const panel = scroll?.querySelector('.card-workshop')
    if (hasCardPanel && scroll && panel) scroll.scrollTop += panel.getBoundingClientRect().top - scroll.getBoundingClientRect().top
  }, [hasCardPanel, conversation.id])

  function sendQuestion(question: string) {
    const value = question.trim()
    if (value && !busy && (!referenceDocuments || !documentNeedsSave || isCardCommand?.(value))) onSend(value)
  }

  function handleInputKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing || event.keyCode === 229) return
    event.preventDefault()
    sendQuestion(draft)
  }

  function openScope() {
    setPendingScope([...scopeIds])
    setScopeOpen(true)
  }

  function toggleSpace(id: string, checked: boolean) {
    setPendingScope((previous) => checked ? [...new Set([...previous, id])] : previous.filter((value) => value !== id))
  }

  function confirmScope() {
    if (!pendingScope.length) return
    onScopeChange(pendingScope)
    setScopeOpen(false)
  }

  function restoreQuestionBefore(messageIndex: number) {
    const question = conversation.messages.slice(0, messageIndex).reverse().find((message) => message.role === 'user')
    if (!question) return
    const restoredScope = question.scopeIds.filter((id) => spaces.some((item) => item.id === id))
    onDraftChange(question.body)
    onScopeChange(restoredScope.length ? restoredScope : [space.id])
    onReferenceDocumentsChange(question.referenceDocuments ?? true)
    onReadingSelectionChange?.(question.readingSelection)
    textareaRef.current?.focus()
  }

  return (
    <section className={`chat-workspace${compact ? ' chat-workspace-compact' : ''}${!hasMessages ? ' chat-workspace-empty' : ''}`} aria-label={compact ? '阅读问答' : '智能问答'}>
      <header className="chat-workspace-header">
        <div className="chat-header-context">
          <span className="chat-header-title">智能问答</span>
          <span className="chat-header-divider" />
          <span className="chat-header-count">AI 助手</span>
        </div>
        <button className="chat-new-conversation" type="button" onClick={onNewConversation}>
          <MessageSquarePlus size={16} strokeWidth={1.7} />
          <span>新对话</span>
        </button>
      </header>

      <div className={`chat-scroll${hasMessages ? ' chat-scroll-with-messages' : ''}`} ref={scrollRef}>
        {!hasMessages ? (
          <div className="chat-welcome">
            <h1>{compact ? '有什么想聊的？' : '想了解什么？'}</h1>
            {compact && <p className="chat-selection-hint">选中正文文字，直接问「这里是什么意思？」</p>}
            <details className="chat-suggestions"><summary><span>试试这些问题</span><ChevronDown size={14} aria-hidden="true" /></summary>
            <div className="chat-example-grid">
              {(compact ? [{ question: 'Python 的 json.load 和 json.loads 有什么区别？' }, { question: '如何把一个知识点整理成容易理解的笔记？' }] : referenceDocuments ? examples : [{ question: 'Python 的 json.load 和 json.loads 有什么区别？' }, { question: '帮我解释一个概念，并给出简单例子。' }]).map((example) => (
                  <button key={example.question} className="chat-example-card" type="button" disabled={busy || saveBlocked} onClick={() => sendQuestion(example.question)}>
                    <span className="chat-example-question">{example.question}</span>
                    <ArrowRight className="chat-example-arrow" size={16} strokeWidth={1.8} />
                  </button>
              ))}
            </div></details>

            {referenceDocuments && availableDocuments.length === 0 && (
              <button className="chat-empty-upload" type="button" onClick={onUpload}>
                <span className="chat-empty-upload-icon"><Upload size={18} strokeWidth={1.6} /></span>
                <span><strong>可添加一份参考资料</strong><span>当前没有文档，仍可直接与 AI 聊天。</span></span>
                <ArrowRight size={17} strokeWidth={1.6} />
              </button>
            )}
          </div>
        ) : (
          <div className="chat-message-list" role="log" aria-label="对话消息" aria-live="polite" aria-relevant="additions text">
            {conversation.messages.map((message, messageIndex) => (
              <article key={message.id} aria-label={message.role === 'user' ? '你的消息' : 'AI 回复'} className={`chat-message chat-message-${message.role}${message.status === 'error' ? ' chat-message-error' : ''}`}>
                {message.role === 'user' ? (
                  <div className="chat-user-message">
                    {message.readingSelection && <SelectionQuote selection={message.readingSelection} />}
                    <p>{message.body}</p>
                  </div>
                ) : (
                  <>
                    {message.isDemo && <p className="chat-context-note">演示内容</p>}
                    {message.status === 'loading' ? (
                      <div className="chat-thinking"><LoaderCircle size={16} className="chat-spin" /><span>正在整理回答<span className="chat-thinking-dots">…</span></span></div>
                    ) : (
                      <>
                        <div className="chat-markdown"><ReactMarkdown skipHtml remarkPlugins={[remarkGfm]} components={{
                          a: ({ children, href }) => <a href={href} target="_blank" rel="noreferrer noopener">{children}</a>,
                          img: ({ alt }) => <span>[图片{alt ? `：${alt}` : ''}]</span>,
                          table: ({ children }) => <div className="chat-table-scroll" tabIndex={0} role="region" aria-label="回答表格，可横向滚动"><table>{children}</table></div>,
                        }}>{message.body}</ReactMarkdown></div>
                        {message.contextNote && <p className="chat-context-note">{message.contextNote}</p>}
                        {message.citations.length > 0 && (
                          <div className="chat-citations">
                            <div className="chat-citations-label"><BookOpen size={13} strokeWidth={1.7} />本轮参考 <span>{message.citations.length}</span></div>
                            <div className="chat-citation-list">
                              {message.citations.map((citation, index) => (
                                <button className="chat-citation" type="button" key={citation.id} onClick={() => onOpenCitation(citation)} title={`查看原文：${citation.title} · ${citation.heading}`}>
                                  {index < message.citations.length && <span className="chat-citation-number">{String(index + 1).padStart(2, '0')}</span>}
                                  {citation.cardId ? <StickyNote size={14} strokeWidth={1.7} /> : <FileText size={14} strokeWidth={1.7} />}
                                  <span className="chat-citation-title">{citation.title}{citation.isAiDraft ? ' · AI 草稿' : ''}</span>
                                  <ArrowRight size={13} className="chat-citation-arrow" />
                                </button>
                              ))}
                            </div>
                            <span className="chat-citation-hint">点击来源，查看本轮参考内容。</span>
                          </div>
                        )}
                        {Boolean(message.relatedCards?.length) && <div className="chat-related-cards" aria-label="相关知识卡片">
                          <div className="chat-related-heading"><StickyNote size={13} />相关知识卡片<span>{message.relatedCards!.length}</span></div>
                          <div className="chat-related-list">{message.relatedCards!.map(card => <button type="button" className="chat-related-card" key={card.cardId} onClick={() => onOpenRelatedCard(card)} aria-label={`查看知识卡片：${card.title}`}>
                            <span className="chat-related-icon"><StickyNote size={16} strokeWidth={1.7} /></span>
                            <span className="chat-related-copy"><strong>{card.title}</strong>{card.summary && <span>{card.summary}</span>}</span>
                            <ArrowRight size={14} className="chat-related-arrow" />
                          </button>)}</div>
                        </div>}
                        {message.status === 'error' && conversation.messages.slice(0, messageIndex).some((item) => item.role === 'user') && (
                          <button className="chat-retry" type="button" disabled={busy} onClick={() => restoreQuestionBefore(messageIndex)}><RotateCcw size={14} />恢复此问题</button>
                        )}
                        {message.status === 'completed' && Boolean(message.body.trim()) && <CopyAnswer body={message.body} />}
                      </>
                    )}
                  </>
                )}
              </article>
            ))}
            {busy && !cardBusy && !hasLoadingMessage && (
              <div className="chat-message chat-message-assistant"><div className="chat-thinking"><LoaderCircle className="chat-spin" size={16} />正在请求模型…</div></div>
            )}
          </div>
        )}
        {cardPanel}
      </div>

      <div className="chat-composer-area">
        {modelControls && <div className="chat-model-controls">{modelControls}</div>}
        {readingSelection && <SelectionQuote selection={readingSelection} onRemove={() => onReadingSelectionChange?.(undefined)} />}
        <div className="chat-composer">
          <div className="chat-composer-toolbar">
            {documentTitle ? <span className="chat-card-scope"><Layers3 size={13} />{space.name}</span> : <button className="chat-scope-trigger" type="button" onClick={openScope} aria-haspopup="dialog" aria-expanded={scopeOpen} title="选择相关卡片与资料的范围">
              <Layers3 size={14} strokeWidth={1.65} />
              <span>{selectedSpaces.length === 1 ? selectedSpaces[0].name : `${selectedSpaces.length} 个知识空间`}</span>
              <ChevronDown size={13} strokeWidth={1.8} />
            </button>}
            <Checkbox checked={referenceDocuments} disabled={busy} onChange={event => onReferenceDocumentsChange(event.target.checked)}>{documentTitle && readingSelection ? '同时参考本文' : documentTitle ? '参考本文' : '参考资料'}</Checkbox>
          </div>
          {documentTitle && referenceDocuments && <div className="chat-document-scope"><FileText size={13} /><span title={documentTitle}>{documentTitle}</span></div>}
          {saveBlocked && <div className="chat-save-needed"><span>参考本文前请先保存修改。</span><button type="button" onClick={onSaveDocument}>保存正文</button></div>}
          <textarea
            ref={textareaRef}
            className="chat-input"
            aria-label="输入问题"
            placeholder={readingSelection ? '针对选文提问，或继续追问…' : '问点什么，或继续聊聊…'}
            value={draft}
            onChange={(event) => onDraftChange(event.target.value)}
            onKeyDown={handleInputKeyDown}
            rows={1}
          />
          <div className="chat-composer-bottom">
            <button className="chat-upload-button" type="button" onClick={onUpload}><Upload size={16} strokeWidth={1.7} /><span>添加资料</span></button>
            <div className="chat-send-controls"><span className="chat-keyboard-hint"><CornerDownLeft size={12} />发送<span>Shift + Enter 换行</span></span>{busy ? (
              <button className="chat-stop-button" type="button" onClick={onCancel} aria-label="停止本次回答"><Square size={13} fill="currentColor" strokeWidth={1.5} /><span>停止</span></button>
            ) : (
              <button className="chat-send-button" type="button" disabled={!draft.trim() || !scopeIds.length || saveBlocked} onClick={() => sendQuestion(draft)} aria-label="发送问题"><ArrowUp size={20} strokeWidth={2} /></button>
            )}</div>
          </div>
        </div>
      </div>

      <Modal
        title={<span className="chat-scope-modal-title"><Layers3 size={20} strokeWidth={1.65} />选择知识范围</span>}
        open={scopeOpen}
        onCancel={() => setScopeOpen(false)}
        width={448}
        centered
        rootClassName="chat-scope-modal"
        footer={<div className="chat-scope-footer"><span>{pendingScope.length ? `已选 ${pendingScope.length} 个空间` : '请至少选择一个空间'}</span><button type="button" className="chat-scope-cancel" onClick={() => setScopeOpen(false)}>取消</button><button type="button" className="chat-scope-confirm" disabled={!pendingScope.length} onClick={confirmScope}><Check size={14} />确认范围</button></div>}
      >
        <p className="chat-scope-description">回答下方会显示这些空间中的相关知识卡片，方便你点击查看。开启“参考资料”后，AI 也可参考其中的文档。</p>
        <div className="chat-scope-options">
          {spaces.map((item) => {
            const Icon = spaceIcons[item.icon]
            const checked = pendingScope.includes(item.id)
            return <Checkbox key={item.id} className={`chat-scope-option${checked ? ' chat-scope-option-selected' : ''}`} checked={checked} onChange={(event) => toggleSpace(item.id, event.target.checked)}><span className="chat-scope-option-content"><span className="chat-scope-option-icon"><Icon size={19} strokeWidth={1.6} /></span><span className="chat-scope-option-copy"><strong>{item.name}</strong><span>{item.description}</span></span></span></Checkbox>
          })}
        </div>
        <p className="chat-scope-explanation"><ShieldCheck size={14} />调整范围仅用于之后提交的问题，历史消息保留原有范围。</p>
      </Modal>
    </section>
  )
}
