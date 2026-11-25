import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Button, Checkbox, Input, Modal, Select } from 'antd'
import { Sparkles } from 'lucide-react'
import { generateCardDrafts } from '../api'
import type { CardGenerationResponse, ProviderProfile } from '../api'
import type { GeneratedCardDraft, GeneratedKnowledgeCardInput, KnowledgeCard, Space } from '../types'
import { reasoningLabels, reasoningRequest } from '../reasoning'
import type { ReasoningSetting } from '../reasoning'
import './CardGenerator.css'

interface Props {
  spaces: Space[]
  currentSpaceId: string
  provider?: ProviderProfile
  model: string
  reasoning: ReasoningSetting
  modelControls: ReactNode
  onClose: () => void
  onSave: (cards: GeneratedKnowledgeCardInput[]) => Promise<KnowledgeCard[]>
  onSaved: (cards: KnowledgeCard[]) => void
}

const failure = (error: unknown) => error instanceof Error ? error.message : '操作未完成，请重试。'

export default function CardGenerator({ spaces, currentSpaceId, provider, model, reasoning, modelControls, onClose, onSave, onSaved }: Props) {
  const [text, setText] = useState('')
  const [count, setCount] = useState(3)
  const [instructions, setInstructions] = useState('')
  const [spaceId, setSpaceId] = useState(currentSpaceId || spaces[0]?.id || '')
  const [busy, setBusy] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [result, setResult] = useState<CardGenerationResponse | null>(null)
  const [drafts, setDrafts] = useState<GeneratedCardDraft[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [generatedAt, setGeneratedAt] = useState('')
  const sessionId = useRef(crypto.randomUUID())
  const active = useRef<{ id: string; controller: AbortController } | null>(null)
  const savingRef = useRef(false)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; active.current?.controller.abort(); active.current = null }
  }, [])

  const cancel = () => {
    active.current?.controller.abort()
    active.current = null
    setBusy(false)
    setNotice('已停止等待，粘贴内容已保留。服务商已受理的请求仍可能消耗额度。')
  }

  async function generate() {
    if (active.current || savingRef.current) return
    if (!text.trim()) { setError('请先粘贴要整理的文字或代码。'); return }
    if (Array.from(text).length > 24000) { setError('单次最多 24,000 字符，请分段粘贴。'); return }
    if (!provider || !model.trim()) { setError('请先配置 API 服务并选择模型。'); return }
    const requestId = crypto.randomUUID()
    const controller = new AbortController()
    active.current = { id: requestId, controller }
    setBusy(true); setError(''); setNotice('')
    try {
      const response = await generateCardDrafts({ session_id: sessionId.current, request_id: requestId,
        provider_id: provider.id, model: model.trim(), ...reasoningRequest(reasoning), text, count, instructions: instructions.trim() }, controller.signal)
      if (!mounted.current || active.current?.id !== requestId || controller.signal.aborted) return
      if (response.session_id !== sessionId.current || response.request_id !== requestId) throw new Error('生成结果与本次请求不匹配，请重试。')
      setResult(response); setDrafts(response.cards); setSelected(response.cards.map(card => card.id)); setGeneratedAt(new Date().toISOString())
      if (!response.cards.length) setNotice('本次没有生成卡片。请补充可整理的知识内容后再试。')
    } catch (cause) {
      if (mounted.current && active.current?.id === requestId && !controller.signal.aborted) setError(failure(cause))
    } finally {
      if (mounted.current && active.current?.id === requestId) { active.current = null; setBusy(false) }
    }
  }

  async function save() {
    if (!result || savingRef.current || !selected.length) return
    const chosen = drafts.filter(card => selected.includes(card.id))
    if (!spaces.some(space => space.id === spaceId)) { setError('请选择卡片所属空间。'); return }
    if (chosen.some(card => !card.title.trim() || !card.body.trim())) { setError('选中卡片的标题和正文不能为空。'); return }
    savingRef.current = true; setSaving(true); setError('')
    try {
      const saved = await onSave(chosen.map(card => ({ spaceId, title: card.title, summary: card.summary,
        body: card.body, tags: card.tags, generation: { batchId: result.request_id, draftId: card.id,
          providerName: result.provider_name, model: result.model, reasoningEffort: result.reasoning_effort ?? undefined, generatedAt, sources: card.sources } })))
      if (mounted.current) onSaved(saved)
    } catch (cause) { if (mounted.current) setError(failure(cause)) }
    finally { savingRef.current = false; if (mounted.current) setSaving(false) }
  }

  const edit = (id: string, change: Partial<GeneratedCardDraft>) => setDrafts(previous => previous.map(card => card.id === id ? { ...card, ...change } : card))
  const reviewing = result !== null && drafts.length > 0
  const usage = result?.usage
  return <Modal open title={<span className="card-generator-title"><Sparkles size={18} />粘贴内容生成卡片</span>}
    width={760} rootClassName="card-generator-modal" mask={{ closable: !busy && !saving }} keyboard={!busy && !saving}
    closable={!busy && !saving} onCancel={() => { if (!savingRef.current) onClose() }} footer={
      <div className="card-generator-footer">
        <span>{reviewing ? `已选 ${selected.length} / ${drafts.length} 张 · 保存不调用模型` : '生成会使用所选服务的 API 额度'}</span>
        <div>{busy ? <Button onClick={cancel}>停止生成</Button> : <Button onClick={onClose} disabled={saving}>关闭</Button>}
          {reviewing ? <Button type="primary" disabled={!selected.length} loading={saving} onClick={() => { void save() }}>保存选中卡片</Button>
            : <Button type="primary" icon={<Sparkles size={15} />} loading={busy} disabled={!text.trim() || !provider || !model.trim()} onClick={() => { void generate() }}>生成卡片</Button>}
        </div>
      </div>}>
    <div className="card-generator-content">
      {!reviewing ? <>
        <label htmlFor="card-source-text">粘贴内容</label>
        <Input.TextArea id="card-source-text" placeholder={'把想记住的笔记、概念说明或代码粘贴到这里…\n\n例如：json.loads 解析字符串，json.load 读取文件对象。'}
          value={text} onChange={event => setText(event.target.value)} autoSize={{ minRows: 7, maxRows: 13 }} disabled={busy} autoFocus />
        <div className="card-generator-source-count">{Array.from(text).length.toLocaleString()} / 24,000 字符 · 超出时请分段整理</div>
        <div className="card-generator-options"><div><label htmlFor="card-generation-count">目标数量</label>
          <Select id="card-generation-count" value={count} onChange={setCount} disabled={busy} options={Array.from({ length: 8 }, (_, i) => ({ value: i + 1, label: `${i + 1} 张` }))} /></div>
          <div><label htmlFor="card-generation-focus">整理侧重点 <span>选填</span></label>
            <Input id="card-generation-focus" placeholder="例如：区别、用法和易错点" maxLength={500} value={instructions} onChange={event => setInstructions(event.target.value)} disabled={busy} /></div></div>
        <div className="card-generator-model"><label>使用模型</label>{busy ? <p>{provider?.name} · {model} · 思考{reasoningLabels[reasoning]}</p> : modelControls}</div>
        <p className="card-generator-note">{provider ? `点击生成后，粘贴内容和整理要求会发送至「${provider.name}」，按该服务计费。` : '先配置自己的 API Key 与模型，再生成卡片。'} 内容不足时可能少于目标张数，生成结果需核对后保存。</p>
      </> : <>
        <p className="card-generator-note">已生成 {drafts.length} 张草稿。勾选要保存的卡片，可直接修改内容；“原文依据”保留本次粘贴片段，AI 内容仍需人工核对。</p>
        <div className="card-generator-destination"><label htmlFor="generated-card-space">保存到空间</label><Select id="generated-card-space" value={spaceId || undefined} onChange={setSpaceId} disabled={saving} options={spaces.map(space => ({ value: space.id, label: space.name }))} /></div>
        <div className="card-generator-drafts">{drafts.map((card, index) => <article key={card.id} className="card-generator-draft">
          <Checkbox checked={selected.includes(card.id)} disabled={saving} onChange={event => setSelected(previous => event.target.checked ? [...previous, card.id] : previous.filter(id => id !== card.id))}>保存第 {index + 1} 张</Checkbox>
          <label htmlFor={`generated-title-${card.id}`}>标题</label><Input id={`generated-title-${card.id}`} value={card.title} maxLength={100} disabled={saving} onChange={event => edit(card.id, { title: event.target.value })} />
          <label htmlFor={`generated-summary-${card.id}`}>一句记法</label><Input id={`generated-summary-${card.id}`} value={card.summary} maxLength={200} disabled={saving} onChange={event => edit(card.id, { summary: event.target.value })} />
          <details open><summary>正文与标签</summary>
            <Input.TextArea aria-label={`第 ${index + 1} 张卡片正文`} value={card.body} maxLength={20000} disabled={saving} autoSize={{ minRows: 3, maxRows: 9 }} onChange={event => edit(card.id, { body: event.target.value })} />
            <Select aria-label={`第 ${index + 1} 张卡片标签`} mode="tags" maxCount={8} tokenSeparators={[',', '，']} style={{ width: '100%' }} placeholder="标签，最多 8 个" value={card.tags} disabled={saving}
              onChange={tags => edit(card.id, { tags })} />
          </details>
          <details className="card-generator-evidence"><summary>原文依据 · {card.sources.length} 个片段</summary>{card.sources.map(source => <pre key={source.id}>{source.excerpt}</pre>)}</details>
        </article>)}</div>
        <details className="card-generator-original"><summary>查看本次粘贴内容</summary><pre>{text}</pre></details>
        <Button type="text" disabled={saving} onClick={() => { setResult(null); setDrafts([]); setSelected([]); setError(''); setNotice('粘贴内容已保留。再次点击生成会重新使用 API 额度。') }}>返回修改粘贴内容</Button>
      </>}
      {result && <p className="card-generator-usage">{result.provider_name} · {result.model}<br />{usage
        ? `服务报告用量：${usage.prompt_tokens !== undefined ? `输入 ${usage.prompt_tokens} · ` : ''}${usage.completion_tokens !== undefined ? `输出 ${usage.completion_tokens} · ` : ''}${usage.total_tokens !== undefined ? `合计 ${usage.total_tokens} ` : ''}tokens`
        : '服务未返回 token 用量。'} 实际费用与剩余额度以服务商为准。</p>}
      {busy && <p className="card-generator-note" role="status">正在生成，请稍候。停止等待不能保证服务商停止计费。</p>}
      {notice && <p className="card-generator-note" role="status">{notice}</p>}
      {error && <p className="knowledge-card-error" role="alert">{error}</p>}
    </div>
  </Modal>
}
