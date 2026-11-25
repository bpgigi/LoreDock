import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CardWorkshopController, applyRevision, cardIntent, planCardBatches, revisionTargets } from '../src/cardWorkshop.ts'

const source = (text = '# 标题\n序言\n## 第一章\nPython 内容。\n## 第二章\n代码内容。\n') => ({ text, documentId: 'doc', spaceId: 'learn', title: '教学文章', version: 4, heading: '片段', start: 20, isDraft: true, isHistorical: false })
const model = { provider_id: 'test', model: 'simulated' }
const draft = (id, text) => ({ id, title: id, summary: '记法', body: '正文', tags: [], sources: [{ id: 'P1', excerpt: Array.from(text).slice(0, 1600).join('') }] })
const result = (request, cards = [draft(crypto.randomUUID(), request.text)]) => ({ session_id: request.session_id, request_id: request.request_id, cards, provider_name: '模拟', model: 'simulated', usage: null })
const make = (changes = {}) => new CardWorkshopController({ generate: async request => result(request), revise: async () => { throw new Error('未设置模拟修改') }, save: async inputs => inputs.map(input => ({ ...input, id: crypto.randomUUID() })), ...changes })
const state = controller => controller.snapshot().reading

test('chapter plan covers every character, preamble, Setext headings, long code and Unicode without truncation', () => {
  const text = '前言\n# 总标题\n\n第一节\n======\n```python\n# 代码不是章节\n' + '😀print(x)'.repeat(4000) + '\n```\n## 末尾\n结束\n'
  const plan = planCardBatches(source(text), true)
  assert.equal(plan.map(batch => batch.text).join(''), text)
  assert.equal(plan.at(-1).end, text.length)
  assert.ok(plan.every(batch => Array.from(batch.text).length <= 12000))
  assert.ok(plan.every(batch => !batch.heading.includes('代码不是章节')))
  plan.forEach((batch, index) => { assert.equal(batch.start, index ? plan[index - 1].end : 0); assert.ok(!/^[\uDC00-\uDFFF]/.test(batch.text)) })
})

test('only explicit card requests route away from ordinary questions', () => {
  for (const text of ['把这段整理成卡片', '请生成知识卡片']) assert.equal(cardIntent(text, false), 'generate-selection')
  assert.equal(cardIntent('整篇文章按章节生成卡片', false), 'generate-article')
  for (const text of ['第二张简短一点', '补个代码示例', '合并这两张']) assert.equal(cardIntent(text, true), 'revise')
  assert.equal(cardIntent('补个代码示例', true, false), null)
  assert.equal(cardIntent('简短一点', true, false), null)
  assert.equal(cardIntent('给第二张补个代码示例', true, false), 'revise')
  assert.equal(cardIntent('合并这两张', true, false), 'revise')
  for (const text of ['如何生成卡片', '不要生成卡片', '卡片是什么？', '解释一下 JSON', '补个代码示例']) assert.equal(cardIntent(text, false), null)
})

test('failure keeps completed cards, retry sends only failed and pending batches; no auto save', async () => {
  const requests = []; let fail = true; let writes = 0
  const controller = make({ generate: async request => { requests.push(request); if (requests.length === 2 && fail) throw new Error('模拟失败'); return result(request) }, save: async () => { writes++; return [] } })
  controller.prepare('reading', source(), true)
  await controller.run('reading', model)
  const firstId = state(controller).drafts[0].id
  assert.equal(state(controller).drafts.length, 1)
  assert.equal(state(controller).batches[1].status, 'error')
  fail = false; await controller.run('reading', model)
  assert.equal(state(controller).drafts.length, 3)
  assert.equal(state(controller).drafts[0].id, firstId)
  assert.equal(requests.length, 4)
  assert.equal(writes, 0)
  assert.equal(requests.map(request => request.text).slice(2).join(''), source().text.slice(state(controller).batches[1].start))
  const provenance = state(controller).drafts[1].sources[0]
  assert.equal(provenance.documentId, 'doc'); assert.equal(provenance.version, 4); assert.equal(provenance.isDraft, true)
  assert.equal(provenance.start, 20 + state(controller).batches[1].start)
})

test('stopping isolates late responses from resumed work and another document', async () => {
  let resolve; let calls = 0
  const controller = make({ generate: request => { calls++; return calls === 1 ? new Promise(done => { resolve = () => done(result(request)) }) : Promise.resolve(result(request)) } })
  controller.prepare('reading', source('片段'), false)
  const running = controller.run('reading', model)
  controller.stop()
  assert.equal(state(controller).batches[0].status, 'pending')
  controller.prepare('another', source('另一文章'), false)
  await controller.run('another', model)
  resolve(); await running
  assert.equal(state(controller).drafts.length, 0)
  assert.equal(controller.snapshot().another.drafts.length, 1)
  await controller.run('reading', model)
  assert.equal(state(controller).drafts.length, 1)
})

test('empty model output is visible and retryable rather than silently declaring coverage', async () => {
  let calls = 0
  const controller = make({ generate: async request => ++calls === 1 ? result(request, []) : result(request) })
  controller.prepare('reading', source('有内容'), false)
  await controller.run('reading', model)
  assert.equal(state(controller).batches[0].status, 'empty')
  assert.match(state(controller).batches[0].error, /未生成卡片/)
  await controller.run('reading', model)
  assert.equal(calls, 1)
  await controller.run('reading', model, true)
  assert.equal(state(controller).drafts.length, 1)
})

test('revision edits original id, merge retains both sources, other cards survive, save only once', async () => {
  let writes = 0; let lastRequest
  const controller = make({ revise: async request => { lastRequest = request; const [a, b] = request.drafts
    return { ...result(request, []), revision: request.revision, operations: [{ target_ids: b ? [a.id, b.id] : [a.id], card: { ...a, body: '精简后\n```python\nprint(1)\n```', sources: [] } }] }
  }, save: async inputs => { writes++; return inputs.map(input => ({ ...input, id: crypto.randomUUID() })) } })
  controller.prepare('reading', source(), true); await controller.run('reading', model)
  const ids = state(controller).drafts.map(card => card.id)
  await controller.revise('reading', '第二张简短一点', model)
  assert.equal(lastRequest.drafts.length, 1); assert.equal(lastRequest.drafts[0].ordinal, 2)
  assert.deepEqual(state(controller).drafts.map(card => card.id), ids)
  controller.select('reading', ids.slice(0, 2))
  await controller.revise('reading', '合并这两张', model)
  assert.deepEqual(state(controller).drafts.map(card => card.id), [ids[0], ids[2]])
  assert.equal(state(controller).drafts[0].sources.length, 2)
  await controller.save('reading'); await controller.save('reading')
  assert.equal(writes, 1)
  assert.ok(state(controller).drafts[0].savedCardId)
  assert.equal(state(controller).drafts[1].savedCardId, undefined)
  await controller.revise('reading', '第一张简短一点', model)
  assert.match(state(controller).error, /已保存/)
})

test('revision failures and stopped late modifications keep original drafts editable', async () => {
  let resolve
  const controller = make({ revise: request => new Promise(done => { resolve = () => done({ ...result(request, []), revision: request.revision, operations: [{ target_ids: [request.drafts[0].id], card: { ...request.drafts[0], body: '迟到内容' } }] }) }) })
  controller.prepare('reading', source('原文'), false); await controller.run('reading', model)
  const original = state(controller).drafts[0]
  const pending = controller.revise('reading', '补个代码示例', model)
  controller.stop(); controller.edit('reading', original.id, { body: '新的手动编辑' }); resolve(); await pending
  assert.equal(state(controller).drafts[0].body, '新的手动编辑')
  assert.throws(() => applyRevision(state(controller), { revision: 0, operations: [] }, [original.id]), /已变化/)
  assert.throws(() => applyRevision(state(controller), { revision: state(controller).revision, operations: [{ target_ids: ['invented'], card: { ...original, id: 'invented' } }] }, [original.id]), /目标无效/)
})

test('large revision selection is rejected explicitly and replacing unsaved drafts requires clear', async () => {
  const controller = make()
  controller.prepare('reading', source(Array.from({ length: 10 }, (_, i) => `## 章节${i}\n内容\n`).join('')), true)
  await controller.run('reading', model)
  assert.throws(() => revisionTargets(state(controller), '补个代码示例'), /最多修改 8 张/)
  assert.equal(controller.prepare('reading', source('覆盖'), false), false)
  assert.equal(state(controller).drafts.length, 10)
})

test('failed save retains edited drafts and the same receipt identity on retry', async () => {
  const saves = []
  const controller = make({ save: async inputs => { saves.push(inputs); if (saves.length === 1) throw new Error('配额不足'); return inputs.map(input => ({ ...input, id: 'saved' })) } })
  controller.prepare('reading', source('依据'), false); await controller.run('reading', model)
  const id = state(controller).drafts[0].id
  controller.edit('reading', id, { body: '手工核对的内容' })
  await controller.save('reading')
  assert.equal(state(controller).drafts[0].savedCardId, undefined)
  await controller.save('reading')
  assert.deepEqual(saves[0], saves[1])
  assert.equal(state(controller).drafts[0].body, '手工核对的内容')
})
