import { useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { Button, Dropdown, Input, Modal, Select } from 'antd'
import { ArrowDownWideNarrow, ChevronDown, Layers2, Pencil, Plus, Search, Sparkles, Trash2, X } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import type { Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { GeneratedKnowledgeCardInput, KnowledgeCard, KnowledgeCardInput, Space } from '../types'
import type { ProviderProfile } from '../api'
import type { ReasoningSetting } from '../reasoning'
import CardGenerator from './CardGenerator'
import CardMarkdownEditor from './CardMarkdownEditor'
import './KnowledgeCards.css'

export interface KnowledgeCardsProps {
  cards: KnowledgeCard[]
  spaces: Space[]
  currentSpaceId: string
  onSave: (input: KnowledgeCardInput, id?: string) => Promise<KnowledgeCard>
  onDelete: (id: string) => Promise<void>
  onSaveGenerated: (cards: GeneratedKnowledgeCardInput[]) => Promise<KnowledgeCard[]>
  provider?: ProviderProfile
  model: string
  reasoning: ReasoningSetting
  modelControls: ReactNode
  initialDraft?: { id: string; title: string; body: string; spaceId: string }
  onDraftConsumed?: () => void
}

interface CardForm {
  title: string
  summary: string
  body: string
  tags: string
  spaceId: string
}

const blankForm = (spaceId: string): CardForm => ({ title: '', summary: '', body: '', tags: '', spaceId })
const failureMessage = (error: unknown) => error instanceof Error ? error.message : '操作未完成，请重试。'

function safeCardUrl(url: string) {
  const value = url.trim()
  if (/[\u0000-\u0020\u007f\\]/.test(value) || !/^https?:\/\//i.test(value)) return ''
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : ''
  } catch {
    return ''
  }
}

const markdownComponents: Components = {
  a: ({ children, href }) => {
    const safeHref = href ? safeCardUrl(href) : ''
    return safeHref ? <a href={safeHref} target="_blank" rel="noopener noreferrer">{children}</a> : <span>{children}</span>
  },
  img: ({ alt }) => <span className="knowledge-card-image-note">[图片{alt ? `：${alt}` : ''}]</span>,
}

function updatedLabel(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
}

export function displayedBody(card: KnowledgeCard) {
  const firstHeading = card.body.match(/^\uFEFF?(?:[ \t]*\r?\n)* {0,3}#[ \t]+([^\r\n]*)(?:\r?\n|$)/)
  const headingText = firstHeading?.[1].replace(/[ \t]+#+[ \t]*$/, '').trim()
  // Hide a duplicated first heading only in the detail view; editing keeps every byte.
  return firstHeading && headingText === card.title.trim() ? card.body.slice(firstHeading[0].length).replace(/^(?:[ \t]*\r?\n)+/, '') : card.body
}

export default function KnowledgeCards({ cards, spaces, currentSpaceId, onSave, onDelete, onSaveGenerated, provider, model, reasoning, modelControls, initialDraft, onDraftConsumed }: KnowledgeCardsProps) {
  const [query, setQuery] = useState('')
  const [generatorOpen, setGeneratorOpen] = useState(false)
  const [spaceFilter, setSpaceFilter] = useState('all')
  const [tagFilter, setTagFilter] = useState('')
  const [sortOrder, setSortOrder] = useState<'updated' | 'title'>('updated')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [formOpen, setFormOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | undefined>()
  const [form, setForm] = useState<CardForm>(() => blankForm(currentSpaceId))
  const [formError, setFormError] = useState('')
  const [saving, setSaving] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<KnowledgeCard | null>(null)
  const [deleteError, setDeleteError] = useState('')
  const [deleting, setDeleting] = useState(false)
  const savingRef = useRef(false)
  const formRef = useRef<HTMLFormElement>(null)
  const deletingRef = useRef(false)
  const consumedDrafts = useRef(new Set<string>())
  const selectedCard = cards.find((card) => card.id === selectedId)
  const spaceNames = useMemo(() => new Map(spaces.map((space) => [space.id, space.name])), [spaces])
  const activeFilter = spaceFilter === 'all' || spaceNames.has(spaceFilter) ? spaceFilter : 'all'
  const hasFilters = Boolean(query.trim() || activeFilter !== 'all' || tagFilter)
  const filteredCards = useMemo(() => {
    const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
    return cards.filter((card) => {
      if (activeFilter !== 'all' && card.spaceId !== activeFilter) return false
      if (tagFilter && !card.tags.includes(tagFilter)) return false
      const text = [card.title, card.summary, card.body, ...card.tags].join(' ').toLocaleLowerCase()
      return terms.every((term) => text.includes(term))
    }).sort((a, b) => sortOrder === 'title'
      ? a.title.localeCompare(b.title, 'zh-CN', { numeric: true, sensitivity: 'base' }) || b.updatedAt.localeCompare(a.updatedAt)
      : b.updatedAt.localeCompare(a.updatedAt))
  }, [cards, query, activeFilter, tagFilter, sortOrder])

  function resetFilters() {
    setQuery('')
    setSpaceFilter('all')
    setTagFilter('')
  }

  useEffect(() => {
    // Reader selections open a draft once; an unfinished form is never overwritten.
    if (!initialDraft || consumedDrafts.current.has(initialDraft.id) || formOpen || saving) return
    const spaceId = spaces.some((space) => space.id === initialDraft.spaceId) ? initialDraft.spaceId : spaces.some((space) => space.id === currentSpaceId) ? currentSpaceId : spaces[0]?.id ?? ''
    consumedDrafts.current.add(initialDraft.id)
    setForm({ ...blankForm(spaceId), title: initialDraft.title, body: initialDraft.body })
    setEditingId(undefined)
    setFormError('')
    setSelectedId(null)
    setFormOpen(true)
    onDraftConsumed?.()
  }, [initialDraft, formOpen, saving, spaces, currentSpaceId, onDraftConsumed])

  function startNew() {
    const spaceId = activeFilter !== 'all' ? activeFilter : spaces.some((space) => space.id === currentSpaceId) ? currentSpaceId : spaces[0]?.id ?? ''
    setForm(blankForm(spaceId))
    setEditingId(undefined)
    setFormError('')
    setSelectedId(null)
    setFormOpen(true)
  }

  function startEdit(card: KnowledgeCard) {
    setForm({ title: card.title, summary: card.summary, body: card.body, tags: card.tags.join(', '), spaceId: card.spaceId })
    setEditingId(card.id)
    setFormError('')
    setSelectedId(null)
    setFormOpen(true)
  }

  function cancelForm() {
    if (savingRef.current) return
    setFormOpen(false)
    if (editingId) setSelectedId(editingId)
  }

  async function saveCard(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (savingRef.current) return
    if (!form.title.trim()) { setFormError('请填写卡片标题。'); return }
    if (!form.body.trim()) { setFormError('请填写卡片正文，可以放一段代码或一个例子。'); return }
    if (!spaces.some((space) => space.id === form.spaceId)) { setFormError('请选择一个有效的知识空间。'); return }
    const tags = Array.from(new Set(form.tags.split(/[,，\n]/).map((tag) => tag.trim().replace(/^#+/, '')).filter(Boolean)))
    savingRef.current = true
    setSaving(true)
    setFormError('')
    try {
      const savedCard = await onSave({ title: form.title.trim(), summary: form.summary.trim(), body: form.body, tags, spaceId: form.spaceId }, editingId)
      setFormOpen(false)
      setSelectedId(savedCard.id)
    } catch (error) {
      setFormError(failureMessage(error))
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  async function confirmDelete() {
    if (!deleteTarget || deletingRef.current) return
    deletingRef.current = true
    setDeleting(true)
    setDeleteError('')
    try {
      await onDelete(deleteTarget.id)
      setSelectedId(null)
      setDeleteTarget(null)
    } catch (error) {
      setDeleteError(failureMessage(error))
    } finally {
      deletingRef.current = false
      setDeleting(false)
    }
  }

  return <section className="knowledge-cards-page" aria-label="知识卡片">
    <header className="knowledge-cards-heading">
      <div className="knowledge-cards-title"><h1>知识卡片</h1><span className="knowledge-cards-count" aria-live="polite" aria-label={hasFilters ? `找到 ${filteredCards.length} 张，共 ${cards.length} 张卡片` : `共 ${cards.length} 张卡片`}>{hasFilters ? `${filteredCards.length} / ${cards.length}` : cards.length} 张</span></div>
      <div className="knowledge-cards-actions"><Button icon={<Sparkles size={15} />} onClick={() => setGeneratorOpen(true)} disabled={!spaces.length}>AI 生成</Button><Button type="primary" icon={<Plus size={16} />} onClick={startNew} disabled={!spaces.length} aria-label="新建卡片">新建卡片</Button></div>
    </header>

    {generatorOpen && <CardGenerator spaces={spaces} currentSpaceId={activeFilter !== 'all' ? activeFilter : currentSpaceId} provider={provider} model={model} reasoning={reasoning} modelControls={modelControls}
      onClose={() => setGeneratorOpen(false)} onSave={onSaveGenerated} onSaved={saved => { setGeneratorOpen(false); resetFilters(); setSelectedId(saved[0]?.id ?? null) }} />}

    <div className="knowledge-cards-toolbar">
      <Input aria-label="搜索知识卡片" className="knowledge-cards-search" prefix={<Search size={15} />} placeholder="搜索标题、正文或标签" value={query} onChange={(event) => setQuery(event.target.value)} allowClear />
      <Select aria-label="按知识空间筛选卡片" className="knowledge-cards-filter" value={activeFilter} onChange={setSpaceFilter} options={[{ value: 'all', label: '全部空间' }, ...spaces.map((space) => ({ value: space.id, label: space.name }))]} />
      <Dropdown trigger={['click']} menu={{ selectedKeys: [sortOrder], selectable: true, items: [{ key: 'updated', label: '最近更新' }, { key: 'title', label: '标题排序' }], onClick: ({ key }) => setSortOrder(key as 'updated' | 'title') }}>
        <Button className="knowledge-cards-sort" icon={<ArrowDownWideNarrow size={15} />} aria-label={`卡片排序：${sortOrder === 'updated' ? '最近更新' : '标题排序'}`}>{sortOrder === 'updated' ? '最近更新' : '标题排序'}<ChevronDown size={12} /></Button>
      </Dropdown>
    </div>

    {hasFilters && <div className="knowledge-cards-filter-summary">
      <div>{tagFilter && <button type="button" className="knowledge-cards-tag-filter" onClick={() => setTagFilter('')} aria-label={`取消标签筛选：${tagFilter}`}><span>#{tagFilter}</span><X size={12} /></button>}<span>找到 {filteredCards.length} 张卡片</span></div>
      <button type="button" onClick={resetFilters}>清除筛选</button>
    </div>}

    {filteredCards.length > 0 ? <div className="knowledge-cards-grid">
      {filteredCards.map((card) => <button type="button" className="knowledge-card-tile" key={card.id} onClick={() => setSelectedId(card.id)} aria-label={`查看卡片：${card.title}`} aria-haspopup="dialog" title={card.title}>
          <h2>{card.title}</h2>
          {card.summary && <p className="knowledge-card-summary">{card.summary}</p>}
        </button>)}
    </div> : <div className="knowledge-cards-empty">
      <Layers2 size={31} strokeWidth={1.3} /><h2>{cards.length ? (query.trim() || tagFilter ? '没有找到匹配的卡片' : '这个空间还没有卡片') : '把下次还会忘的知识记下来'}</h2>
      <p>{cards.length ? (query.trim() || tagFilter ? '换个关键词，或清除筛选后查看全部卡片。' : '新建一张卡片，或查看其他空间。') : '记录一句记法和一个例子，方便下次查阅。'}</p>
      {cards.length ? <div className="knowledge-cards-empty-actions">{!query.trim() && !tagFilter && activeFilter !== 'all' && <Button type="primary" onClick={startNew}>新建卡片</Button>}<Button onClick={resetFilters}>查看全部卡片</Button></div> : <Button type="primary" onClick={startNew} disabled={!spaces.length}>创建第一张卡片</Button>}
      {!spaces.length && <span className="knowledge-cards-space-hint">请先创建一个知识空间。</span>}
    </div>}

    <Modal open={Boolean(selectedCard) && !formOpen} onCancel={() => { if (!deletingRef.current) setSelectedId(null) }} title={<span className="knowledge-card-dialog-label"><Layers2 size={16} />知识卡片</span>} width={740} destroyOnHidden rootClassName="knowledge-card-detail-modal" mask={{ closable: !deleting }} keyboard={!deleting} closable={!deleting} footer={selectedCard && <div className="knowledge-card-detail-footer"><Button className="knowledge-card-delete-button" type="text" icon={<Trash2 size={15} />} onClick={() => { setDeleteError(''); setDeleteTarget(selectedCard) }}>删除</Button><Button icon={<Pencil size={15} />} onClick={() => startEdit(selectedCard)}>编辑卡片</Button></div>}>
      {selectedCard && <article className="knowledge-card-detail">
        <div className="knowledge-card-detail-meta"><span>{spaceNames.get(selectedCard.spaceId) ?? '未分组'}</span>{selectedCard.isDemo && <span className="knowledge-card-demo-badge">示例</span>}{selectedCard.generation && <span className="knowledge-card-demo-badge">AI 生成草稿</span>}<span>更新于 {updatedLabel(selectedCard.updatedAt)}</span></div>
        <h1>{selectedCard.title}</h1>
        {selectedCard.summary && <p className="knowledge-card-memory">{selectedCard.summary}</p>}
        <div className="knowledge-card-prose"><ReactMarkdown skipHtml remarkPlugins={[remarkGfm]} urlTransform={safeCardUrl} components={markdownComponents}>{displayedBody(selectedCard)}</ReactMarkdown></div>
        {selectedCard.tags.length > 0 && <div className="knowledge-card-detail-tags">{selectedCard.tags.map((tag) => <button type="button" key={tag} title={`查找带有“${tag}”标签的卡片`} onClick={() => { setQuery(''); setSpaceFilter('all'); setTagFilter(tag); setSelectedId(null) }}>#{tag}</button>)}</div>}
        {selectedCard.generation && <details className="knowledge-card-generation"><summary>原文依据 · 核对 AI 内容</summary><p>{selectedCard.generation.providerName} · {selectedCard.generation.model} · {new Date(selectedCard.generation.generatedAt).toLocaleString('zh-CN')}</p>{selectedCard.generation.sources.map((source, index) => <div key={index}>{source.documentId && <p>{source.title} · V{source.version} · {source.heading}{source.isHistorical ? '（历史摘录）' : source.isDraft ? '（编辑中快照）' : ''}{source.sourcePath && <><br />{source.sourcePath}</>}</p>}<pre>{source.excerpt}</pre></div>)}</details>}
      </article>}
    </Modal>

    <Modal open={formOpen} onCancel={cancelForm} title={editingId ? '编辑卡片' : '新建知识卡片'} width={760} destroyOnHidden rootClassName="knowledge-card-form-modal" mask={{ closable: !saving }} keyboard={!saving} closable={!saving} footer={<div className="knowledge-card-form-footer"><span>Ctrl / ⌘ + S 保存 · 取消不保存修改</span><div><Button onClick={cancelForm} disabled={saving}>取消</Button><Button type="primary" htmlType="submit" form="knowledge-card-form" loading={saving}>保存卡片</Button></div></div>}>
      <form ref={formRef} id="knowledge-card-form" className="knowledge-card-form" onSubmit={(event) => { void saveCard(event) }} noValidate>
        <label htmlFor="knowledge-card-title">标题 <span className="knowledge-card-required">必填</span></label>
        <Input id="knowledge-card-title" placeholder="例如：json.load 和 json.loads 的区别" value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} disabled={saving} autoFocus aria-required />
        <label htmlFor="knowledge-card-summary">一句记法 <span>选填</span></label>
        <Input id="knowledge-card-summary" placeholder="例如：带 s 读字符串，不带 s 读文件" value={form.summary} onChange={(event) => setForm({ ...form, summary: event.target.value })} disabled={saving} />
        <label htmlFor="knowledge-card-body">正文 <span className="knowledge-card-required">必填</span></label>
        <CardMarkdownEditor value={form.body} onChange={body => setForm(previous => ({ ...previous, body }))} onSave={() => formRef.current?.requestSubmit()} disabled={saving} />
        <div className="knowledge-card-form-row"><div><label htmlFor="knowledge-card-tags">标签 <span>用逗号分隔</span></label><Input id="knowledge-card-tags" placeholder="Python, JSON, 易混淆" value={form.tags} onChange={(event) => setForm({ ...form, tags: event.target.value })} disabled={saving} /></div><div><label htmlFor="knowledge-card-space">所属空间</label><Select id="knowledge-card-space" value={form.spaceId || undefined} placeholder="选择知识空间" options={spaces.map((space) => ({ value: space.id, label: space.name }))} onChange={(spaceId) => setForm({ ...form, spaceId })} disabled={saving} /></div></div>
        {formError && <p className="knowledge-card-error" role="alert">{formError}</p>}
      </form>
    </Modal>

    <Modal open={Boolean(deleteTarget)} title="删除这张卡片？" width={420} zIndex={1100} onCancel={() => { if (!deletingRef.current) setDeleteTarget(null) }} onOk={() => { void confirmDelete() }} okText="确认删除" cancelText="取消" confirmLoading={deleting} cancelButtonProps={{ disabled: deleting }} mask={{ closable: !deleting }} keyboard={!deleting} closable={!deleting} rootClassName="knowledge-card-delete-modal">
      <p className="knowledge-card-delete-description">“{deleteTarget?.title}”将从知识卡片中删除。</p>
      {deleteError && <p className="knowledge-card-error" role="alert">{deleteError}</p>}
    </Modal>
  </section>
}
