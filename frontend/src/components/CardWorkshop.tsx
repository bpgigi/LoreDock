import { App, Button, Checkbox, Input, InputNumber, Progress } from 'antd'
import { useState } from 'react'
import { Sparkles, Square } from 'lucide-react'
import CardMarkdownEditor from './CardMarkdownEditor'
import type { CardWorkshopController, CardWorkshopState } from '../cardWorkshop'
import './CardWorkshop.css'

interface Props {
  state: CardWorkshopState
  controller: CardWorkshopController
  sessionId: string
  spaceName: string
  onRun: (retryEmpty?: boolean) => void
  onRetryRevision: () => void
}
const batchLabels = { pending: '未处理', running: '生成中', done: '已完成', empty: '无卡片 · 待核对', error: '失败' }

export default function CardWorkshop({ state, controller, sessionId, spaceName, onRun, onRetryRevision }: Props) {
  const { modal } = App.useApp()
  const [openIds, setOpenIds] = useState<string[]>([])
  const completed = state.batches.filter(batch => ['done', 'empty'].includes(batch.status)).length
  const empty = state.batches.filter(batch => batch.status === 'empty').length
  const remaining = state.batches.length - completed
  const pending = state.drafts.filter(draft => !draft.savedCardId)
  const selected = pending.filter(draft => state.selected.includes(draft.id))
  const clear = () => {
    if (pending.length) modal.confirm({ title: '清空未保存草稿？', content: '这会清空本次生成计划和未保存草稿，已保存的卡片保留。', okText: '清空草稿', cancelText: '保留', onOk: () => controller.clear(sessionId) })
    else controller.clear(sessionId)
  }
  return <section className="card-workshop" aria-label="AI 卡片草稿">
    <header><h3><Sparkles size={16} />卡片草稿</h3><button type="button" disabled={Boolean(state.busy)} onClick={clear}>清空</button></header>
    <p className="card-workshop-source">{state.source.title} · V{state.source.version}{state.source.isHistorical ? ' 历史摘录' : state.source.isDraft ? ' 编辑中快照' : ''}<br />保存到：{spaceName}</p>
    <div className="card-workshop-progress" role="status" aria-live="polite">
      <span>已处理 {completed} / {state.batches.length} 批 · 全部 {Array.from(state.source.text).length.toLocaleString()} 字符</span>
      <Progress percent={state.batches.length ? Math.round(completed / state.batches.length * 100) : 0} showInfo={false} size="small" />
      {empty > 0 && <small>{empty} 批未生成卡片，请核对原文；已处理不代表知识点已全部覆盖。</small>}
    </div>
    <details className="card-workshop-batches"><summary>查看章节与处理情况</summary>{state.batches.map((batch, index) => <details key={batch.id}>
      <summary>{index + 1}. {batch.heading} · {batchLabels[batch.status]}</summary>
      {batch.error && <p>{batch.error}</p>}<small>快照字符 {state.source.start + batch.start + 1}–{state.source.start + batch.end}</small><pre>{batch.text}</pre>
    </details>)}</details>
    <div className="card-workshop-actions">
      {!state.busy && remaining > 0 && <><label>每批最多 <InputNumber aria-label="每批卡片数" min={1} max={8} value={state.count} onChange={value => controller.count(sessionId, value ?? 3)} size="small" /> 张</label>
        <Button size="small" onClick={() => onRun()}>{state.batches.some(batch => batch.status !== 'pending') || state.drafts.length ? '继续 / 重试未完成批次' : '开始生成草稿'}</Button></>}
      {!state.busy && empty > 0 && <Button size="small" onClick={() => onRun(true)}>重试无卡片批次</Button>}
      {state.busy && state.busy !== 'saving' && <Button size="small" onClick={controller.stop} icon={<Square size={12} />}>停止{state.busy === 'revising' ? '修改' : '生成'}</Button>}
    </div>
    <details className="card-workshop-help"><summary>对话修改与保存说明</summary>
      <p className="card-workshop-note">生成与修改会使用所选服务额度。草稿不会自动保存；关闭应用或刷新会丢失未保存草稿。</p>
      <p className="card-workshop-note">可在下方对话中说“第二张简短一点”“补个代码示例”。合并前只勾选目标，再说“合并这两张”。</p>
    </details>
    {state.notice && <p className="card-workshop-notice" role="status">{state.notice}</p>}
    {state.error && <div className="card-workshop-error" role="alert">{state.error}</div>}
    {!state.busy && state.lastInstruction && <Button size="small" onClick={onRetryRevision}>重试草稿修改</Button>}
    {state.log.length > 0 && <details className="card-workshop-log"><summary>草稿修改记录（{state.log.length}）</summary>{state.log.map((entry, index) => <p key={index}>{entry}</p>)}</details>}
    {state.drafts.length > 0 && <>
      <div className="card-workshop-selection"><Checkbox disabled={Boolean(state.busy) || !pending.length} checked={Boolean(pending.length) && selected.length === pending.length} indeterminate={selected.length > 0 && selected.length < pending.length} onChange={event => controller.select(sessionId, event.target.checked ? pending.map(draft => draft.id) : [])}>选择未保存草稿</Checkbox><span>{selected.length} 张</span></div>
      <div className="card-workshop-drafts">{state.drafts.map((draft, index) => <details className="card-workshop-draft" key={draft.id} onToggle={event => { const open = event.currentTarget.open; setOpenIds(previous => open ? [...new Set([...previous, draft.id])] : previous.filter(id => id !== draft.id)) }}>
        <summary><span>第 {index + 1} 张 · {draft.title}</span>{draft.savedCardId && <small>已保存</small>}</summary>
        {openIds.includes(draft.id) && <>
        <Checkbox aria-label={`选择第 ${index + 1} 张草稿`} checked={state.selected.includes(draft.id)} disabled={Boolean(state.busy) || Boolean(draft.savedCardId)} onChange={event => controller.select(sessionId, event.target.checked ? [...state.selected, draft.id] : state.selected.filter(id => id !== draft.id))}>{draft.savedCardId ? '已保存，可在知识卡片中编辑' : '保存 / 对话修改此草稿'}</Checkbox>
        <fieldset disabled={Boolean(state.busy) || Boolean(draft.savedCardId)}>
          <label>标题<Input aria-label={`第 ${index + 1} 张标题`} value={draft.title} maxLength={100} onChange={event => controller.edit(sessionId, draft.id, { title: event.target.value })} /></label>
          <label>一句记法<Input.TextArea aria-label={`第 ${index + 1} 张记法`} value={draft.summary} maxLength={200} autoSize={{ minRows: 1, maxRows: 4 }} onChange={event => controller.edit(sessionId, draft.id, { summary: event.target.value })} /></label>
          <CardMarkdownEditor value={draft.body} disabled={Boolean(state.busy) || Boolean(draft.savedCardId)} inputId={`card-draft-${draft.id}`} onChange={body => controller.edit(sessionId, draft.id, { body })} onSave={() => { /* Explicit review uses the save-selection button below. */ }} />
          <label>标签（逗号分隔）<Input aria-label={`第 ${index + 1} 张标签`} value={draft.tags.join(', ')} onChange={event => controller.edit(sessionId, draft.id, { tags: event.target.value.split(/[,，]/).map(tag => tag.trim()) })} /></label>
        </fieldset>
        <details className="card-workshop-sources"><summary>原文依据（{draft.sources.length}）</summary>{draft.sources.map((source, number) => <div key={number}><small>{source.title} · V{source.version} · {source.heading}{source.sourcePath && <><br />{source.sourcePath}</>}</small><pre>{source.excerpt}</pre></div>)}</details>
        </>}
      </details>)}</div>
      <Button block type="primary" disabled={Boolean(state.busy) || !selected.length} loading={state.busy === 'saving'} onClick={() => { void controller.save(sessionId) }}>确认保存选中 {selected.length} 张到「{spaceName}」</Button>
    </>}
  </section>
}
