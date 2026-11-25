import { readingHeadings } from './readingSelection.ts'
import type { GeneratedCardDraft, CardSource, GeneratedKnowledgeCardInput, KnowledgeCard } from './types'
import type { CardGenerationRequest, CardGenerationResponse, CardRevisionRequest, CardRevisionResponse } from './api'
import type { ReasoningEffort } from './reasoning'

export interface CardArticleSource {
  documentId: string; spaceId: string; title: string; version: number; heading: string
  text: string; start: number; isDraft: boolean; isHistorical: boolean
  sourcePath?: string
}
export interface CardBatch {
  id: string; heading: string; start: number; end: number; text: string
  status: 'pending' | 'running' | 'done' | 'empty' | 'error'; error?: string
}
export interface WorkshopDraft extends GeneratedCardDraft {
  batchPartId: string; providerName: string; model: string; generatedAt: string
  reasoningEffort?: ReasoningEffort; savedCardId?: string
}
export interface CardWorkshopState {
  id: string; source: CardArticleSource; batches: CardBatch[]; drafts: WorkshopDraft[]
  selected: string[]; count: number; revision: number; busy: 'generating' | 'revising' | 'saving' | null
  error: string; notice: string; lastInstruction: string; log: string[]
}
export interface CardModel { provider_id: string; model: string; reasoning_effort?: ReasoningEffort }
export interface WorkshopServices {
  generate: (request: CardGenerationRequest, signal: AbortSignal) => Promise<CardGenerationResponse>
  revise: (request: CardRevisionRequest, signal: AbortSignal) => Promise<CardRevisionResponse>
  save: (inputs: GeneratedKnowledgeCardInput[]) => Promise<KnowledgeCard[]>
}

/** Partition every UTF-16 offset exactly once; the API limit counts Unicode code points. */
export function planCardBatches(source: CardArticleSource, byChapter: boolean, limit = 12000): CardBatch[] {
  if (!Number.isInteger(limit) || limit < 1 || limit > 24000) throw new Error('分批长度无效。')
  const headings = byChapter ? readingHeadings(source.text) : []
  const sections = [{ from: 0, text: source.heading || '正文' }, ...headings.filter(item => item.from > 0)]
  if (headings[0]?.from === 0) sections[0].text = headings[0].text
  const batches: CardBatch[] = []
  sections.forEach((section, index) => {
    const end = sections[index + 1]?.from ?? source.text.length
    let start = section.from
    let part = 0
    while (start < end) {
      let next = start
      let count = 0
      while (next < end && count < limit) { next += source.text.codePointAt(next)! > 0xffff ? 2 : 1; count++ }
      if (next < end) {
        const line = source.text.lastIndexOf('\n', next - 1)
        if (line > start + (next - start) / 2) next = line + 1
      }
      part++
      batches.push({ id: `part-${batches.length + 1}`, heading: `${section.text}${part > 1 ? `（续 ${part}）` : ''}`.slice(0, 500), start, end: next,
        text: source.text.slice(start, next), status: 'pending' })
      start = next
    }
  })
  return batches
}

export type CardIntent = 'generate-selection' | 'generate-article' | 'revise' | null
export function cardIntent(question: string, hasDrafts: boolean, continuingCardConversation = true): CardIntent {
  const value = question.trim()
  // Explanatory and negative questions remain ordinary chat.
  if (/^(?:请问|如何|怎么|为什么|什么是|不要|别|不用)|[?？]$/.test(value)) return null
  if (/(?:生成|整理|做成|转成|制作|提炼|创建).{0,20}(?:知识)?卡片/.test(value)
    || /卡片.{0,8}(?:生成|整理)/.test(value)) return /整篇|全文|按章节|整章/.test(value) ? 'generate-article' : 'generate-selection'
  if (hasDrafts && /(?:第[一二两三四五六七八九十百\d]+张|这[一二两三四五六七八九\d]*张|卡片|草稿|补.{0,6}(?:代码|示例|例子)|合并|简短一点|精简一点|改成|改为|加.{0,6}(?:代码|示例|例子))/.test(value)
    && /改|补|合并|简短|精简|缩短|扩写|增加|加个|添加|重写/.test(value)
    && (continuingCardConversation || /第[一二两三四五六七八九十百\d]+张|这[一二两三四五六七八九\d]*张|卡片|草稿|合并/.test(value))) return 'revise'
  return null
}

function ordinalNumber(text: string): number {
  if (/^\d+$/.test(text)) return Number(text)
  const digits: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
  if (text.includes('十')) { const [a, b] = text.split('十'); return (a ? digits[a] : 1) * 10 + (b ? digits[b] : 0) }
  return digits[text] ?? 0
}

export function revisionTargets(state: CardWorkshopState, question: string): WorkshopDraft[] {
  const ordinals = [...question.matchAll(/第([一二两三四五六七八九十\d]+)张/g)].map(match => ordinalNumber(match[1]))
  let drafts: WorkshopDraft[]
  if (ordinals.length) {
    drafts = [...new Set(ordinals)].map(number => {
      const draft = state.drafts[number - 1]
      if (!draft) throw new Error(`第 ${number} 张草稿不存在。`)
      return draft
    })
  } else drafts = state.drafts.filter(draft => !draft.savedCardId && state.selected.includes(draft.id))
  if (!drafts.length) throw new Error('请先勾选要修改的草稿，或说明“第几张”。')
  if (drafts.some(draft => draft.savedCardId)) throw new Error('已保存的卡片不会被草稿对话修改，请在知识卡片中编辑。')
  if (/这两张/.test(question) && drafts.length !== 2) throw new Error('请只勾选要合并的两张草稿。')
  if (drafts.length > 8) throw new Error('每次最多修改 8 张，请减少勾选；不会截断草稿。')
  if (drafts.reduce((n, draft) => n + Array.from(draft.body).length, 0) > 64000
    || drafts.reduce((n, draft) => n + draft.sources.reduce((sum, source) => sum + Array.from(source.excerpt).length, 0), 0) > 48000)
    throw new Error('选中的草稿或来源过长，请减少勾选后重试；不会截断内容。')
  return drafts
}

export function sourcedCards(cards: GeneratedCardDraft[], source: CardArticleSource, batch: CardBatch): GeneratedCardDraft[] {
  return cards.map(card => ({ ...card, sources: card.sources.map(item => {
    const index = Number(item.id.slice(1)) - 1
    const points = Array.from(batch.text)
    const start = source.start + batch.start + points.slice(0, index * 1600).join('').length
    const excerpt = points.slice(index * 1600, (index + 1) * 1600).join('')
    if (!/^P\d+$/.test(item.id) || index < 0 || !excerpt || excerpt !== item.excerpt) throw new Error('返回的来源与文章快照不一致，未添加草稿。')
    return { ...item, documentId: source.documentId, spaceId: source.spaceId, title: source.title.slice(0, 240), heading: batch.heading,
      version: source.version, start, end: start + excerpt.length, isDraft: source.isDraft, isHistorical: source.isHistorical,
      ...(source.sourcePath ? { sourcePath: source.sourcePath } : {}) }
  }) }))
}

export function applyRevision(state: CardWorkshopState, response: CardRevisionResponse, allowed: string[]): CardWorkshopState {
  if (response.revision !== state.revision) throw new Error('草稿已变化，本次修改未覆盖新内容。请重试。')
  const touched = new Set<string>()
  const replacement = new Map<string, WorkshopDraft>()
  for (const operation of response.operations) {
    if (!operation.target_ids.length || operation.card.id !== operation.target_ids[0]) throw new Error('修改目标无效，原草稿保留。')
    const sources: CardSource[] = []
    for (const id of operation.target_ids) {
      const original = state.drafts.find(draft => draft.id === id)
      if (!allowed.includes(id) || touched.has(id) || !original || original.savedCardId) throw new Error('修改目标无效，原草稿保留。')
      touched.add(id)
      original.sources.forEach(source => { if (!sources.some(value => JSON.stringify(value) === JSON.stringify(source))) sources.push(source) })
    }
    const original = state.drafts.find(draft => draft.id === operation.card.id)!
    // Keep authoritative provenance locally, including both sides of a merge.
    replacement.set(original.id, { ...original, ...operation.card, sources,
      providerName: response.provider_name, model: response.model, reasoningEffort: response.reasoning_effort ?? undefined })
  }
  const drafts = state.drafts.flatMap(draft => replacement.has(draft.id) ? [replacement.get(draft.id)!] : touched.has(draft.id) ? [] : [draft])
  return { ...state, drafts, selected: state.selected.filter(id => drafts.some(draft => draft.id === id)), revision: state.revision + 1 }
}

/** One owner for async work. Hiding the sidebar does not discard its drafts. */
export class CardWorkshopController {
  private sessions: Record<string, CardWorkshopState> = {}
  private listeners = new Set<() => void>()
  private job?: { key: string; id: string; controller: AbortController }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  snapshot = () => this.sessions
  private services: WorkshopServices
  constructor(services: WorkshopServices) { this.services = services }
  private put(key: string, state: CardWorkshopState) { this.sessions = { ...this.sessions, [key]: state }; this.listeners.forEach(listener => listener()) }
  private update(key: string, transform: (state: CardWorkshopState) => CardWorkshopState) { if (this.sessions[key]) this.put(key, transform(this.sessions[key])) }
  private fail(key: string, error: unknown) { this.update(key, state => ({ ...state, error: error instanceof Error ? error.message : '操作失败，草稿已保留。' })) }
  private live(job: NonNullable<CardWorkshopController['job']>) { return this.job === job && !job.controller.signal.aborted && this.sessions[job.key]?.id === job.id }
  stop = () => {
    const job = this.job
    if (!job) return
    this.job = undefined; job.controller.abort()
    this.update(job.key, state => ({ ...state, busy: null, notice: '已停止，已完成草稿保留。可继续剩余批次或重试修改。',
      batches: state.batches.map(batch => batch.status === 'running' ? { ...batch, status: 'pending' } : batch) }))
  }
  prepare(key: string, source: CardArticleSource, whole: boolean): boolean {
    const existing = this.sessions[key]
    if (existing?.busy || existing?.drafts.some(draft => !draft.savedCardId)) { this.fail(key, new Error('请先保存或清空当前草稿，再生成新的内容。')); return false }
    if (!source.text.trim()) return false
    this.stop()
    this.put(key, { id: crypto.randomUUID(), source: structuredClone(source), batches: planCardBatches(source, whole), drafts: [], selected: [], count: 3, revision: 0,
      busy: null, error: '', notice: '将使用当前模型额度。草稿仅在本次打开期间保留，请核对后保存。', lastInstruction: '', log: [] })
    return true
  }
  clear(key: string) { if (this.sessions[key]?.busy) return; const next = { ...this.sessions }; delete next[key]; this.sessions = next; this.listeners.forEach(listener => listener()) }
  count(key: string, count: number) { this.update(key, state => state.busy ? state : { ...state, count: Math.max(1, Math.min(8, Math.round(count) || 1)) }) }
  select(key: string, ids: string[]) { this.update(key, state => state.busy ? state : { ...state, selected: ids.filter(id => state.drafts.some(draft => draft.id === id && !draft.savedCardId)) }) }
  edit(key: string, id: string, patch: Partial<Pick<GeneratedCardDraft, 'title' | 'summary' | 'body' | 'tags'>>) {
    this.update(key, state => state.busy ? state : { ...state, revision: state.revision + 1,
      drafts: state.drafts.map(draft => draft.id === id && !draft.savedCardId ? { ...draft, ...patch } : draft) })
  }
  async run(key: string, model: CardModel, retryEmpty = false) {
    const initial = this.sessions[key]
    if (!initial || initial.busy || this.job) return
    const job = { key, id: initial.id, controller: new AbortController() }; this.job = job
    this.update(key, state => ({ ...state, busy: 'generating', error: '', notice: '', batches: state.batches.map(batch => batch.status === 'error' || (retryEmpty && batch.status === 'empty') ? { ...batch, status: 'pending', error: undefined } : batch) }))
    try {
      for (const planned of this.sessions[key].batches) {
        if (!this.live(job)) break
        if (planned.status !== 'pending') continue
        this.update(key, state => ({ ...state, batches: state.batches.map(batch => batch.id === planned.id ? { ...batch, status: 'running' } : batch) }))
        try {
          if (!planned.text.trim()) {
            this.update(key, state => ({ ...state, batches: state.batches.map(batch => batch.id === planned.id ? { ...batch, status: 'empty', error: '本批只有空白，无可生成的文字。' } : batch) })); continue
          }
          const requestId = crypto.randomUUID()
          const result = await this.services.generate({ ...model, session_id: key, request_id: requestId, text: planned.text, count: initial.count, instructions: `章节：${planned.heading.slice(0, 400)}。保留重要限定与代码语义。` }, job.controller.signal)
          if (!this.live(job)) return
          if (result.request_id !== requestId || result.session_id !== key) throw new Error('生成响应标识不匹配，未添加草稿。')
          const additions: WorkshopDraft[] = sourcedCards(result.cards, initial.source, planned).map(card => ({ ...card, batchPartId: planned.id,
            providerName: result.provider_name, model: result.model, reasoningEffort: result.reasoning_effort ?? undefined, generatedAt: new Date().toISOString() }))
          this.update(key, state => ({ ...state, revision: state.revision + 1, drafts: [...state.drafts, ...additions], selected: [...state.selected, ...additions.map(card => card.id)],
            batches: state.batches.map(batch => batch.id === planned.id ? { ...batch, status: additions.length ? 'done' : 'empty', error: additions.length ? undefined : '模型未生成卡片，请核对本批原文，可重试。' } : batch) }))
        } catch (error) {
          if (!this.live(job)) return
          const detail = error instanceof Error ? error.message : '生成失败。'
          this.update(key, state => ({ ...state, error: detail, batches: state.batches.map(batch => batch.id === planned.id ? { ...batch, status: 'error', error: detail } : batch) }))
          break
        }
      }
    } finally {
      if (this.live(job)) { this.job = undefined; this.update(key, state => ({ ...state, busy: null, notice: '草稿尚未保存，请核对来源与内容后保存选中项。' })) }
    }
  }
  async revise(key: string, instruction: string, model: CardModel) {
    const initial = this.sessions[key]
    if (!initial || initial.busy || this.job) return
    this.update(key, state => ({ ...state, lastInstruction: instruction, error: '' }))
    let targets: WorkshopDraft[]
    try { targets = revisionTargets(initial, instruction) } catch (error) { this.fail(key, error); return }
    const job = { key, id: initial.id, controller: new AbortController() }; this.job = job
    this.update(key, state => ({ ...state, busy: 'revising', notice: '正在修改现有草稿…' }))
    try {
      const requestId = crypto.randomUUID()
      const result = await this.services.revise({ ...model, session_id: key, request_id: requestId, revision: initial.revision, instructions: instruction,
        drafts: targets.map(({ id, title, summary, body, tags, sources }) => ({ id, title, summary, body, tags: tags.filter(tag => tag.trim()), sources, ordinal: initial.drafts.findIndex(draft => draft.id === id) + 1 })) }, job.controller.signal)
      if (!this.live(job)) return
      if (result.request_id !== requestId || result.session_id !== key) throw new Error('修改响应标识不匹配，原草稿保留。')
      const updated = applyRevision(this.sessions[key], result, targets.map(draft => draft.id))
      this.put(key, { ...updated, error: '', lastInstruction: '', log: [...updated.log, `${instruction} → ${result.operations.length ? '已更新原草稿' : '模型未提出修改，草稿保持原样'}`], notice: '已更新草稿，仍需确认保存。' })
    } catch (error) { if (this.live(job)) this.fail(key, error) }
    finally { if (this.live(job)) { this.job = undefined; this.update(key, state => ({ ...state, busy: null })) } }
  }
  async save(key: string) {
    const initial = this.sessions[key]
    if (!initial || initial.busy) return
    const selected = initial.drafts.filter(draft => !draft.savedCardId && initial.selected.includes(draft.id))
    if (!selected.length) return
    this.update(key, state => ({ ...state, busy: 'saving', error: '' }))
    try {
      const saved = await this.services.save(selected.map(draft => ({ spaceId: initial.source.spaceId, title: draft.title, summary: draft.summary, body: draft.body, tags: draft.tags.filter(tag => tag.trim()),
        generation: { batchId: initial.id, draftId: draft.id, providerName: draft.providerName, model: draft.model, generatedAt: draft.generatedAt, reasoningEffort: draft.reasoningEffort, sources: draft.sources } })))
      this.update(key, state => ({ ...state, drafts: state.drafts.map(draft => ({ ...draft, savedCardId: saved.find(card => card.generation?.draftId === draft.id)?.id ?? draft.savedCardId })),
        selected: state.selected.filter(id => !saved.some(card => card.generation?.draftId === id)), notice: `已保存 ${saved.length} 张到文章所属空间。已保存项不会重复保存。` }))
    } catch (error) { this.fail(key, error) }
    finally { this.update(key, state => ({ ...state, busy: null })) }
  }
}
