import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb'
import { deleteKnowledgeCard, loadWorkspace, saveGeneratedKnowledgeCards, saveKnowledgeCard, saveWorkspace } from '../src/storage.ts'

beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory()
  await saveWorkspace({ spaces: [{ id: 'learn', name: '学习', description: '', icon: 'code', color: '#666' }],
    documents: [], conversations: [], selectedSpaceId: 'learn', selectedConversationId: '', knowledgeCards: [],
    aiPreference: { providerId: 'custom', model: 'my-model' } })
})

const draft = (id, changes = {}) => ({ spaceId: 'learn', title: `知识点 ${id}`, summary: '记法', body: '正文', tags: ['Python'],
  generation: { batchId: 'batch-1', draftId: id, providerName: '自定义服务', model: 'my-model', generatedAt: '2026-11-10T00:00:00Z',
    sources: [{ id: 'P1', excerpt: '用户手动粘贴的原文' }] }, ...changes })

test('batch saves only reviewed cards atomically and retains source metadata through edits and stale saves', async () => {
  const initial = await loadWorkspace()
  const saved = await saveGeneratedKnowledgeCards([draft('one'), draft('three')])
  assert.equal(saved.length, 2)
  const edited = await saveKnowledgeCard({ spaceId: 'learn', title: '人工修改', summary: '', body: '核对后的正文', tags: [] }, saved[0].id)
  assert.deepEqual(edited.generation, saved[0].generation)
  await saveWorkspace(initial)
  const stored = await loadWorkspace()
  assert.equal(stored.knowledgeCards.length, 2)
  assert.equal(stored.knowledgeCards.find(card => card.id === edited.id).title, '人工修改')
  assert.deepEqual(stored.aiPreference, initial.aiPreference)
  assert.deepEqual(stored.documents, initial.documents)
})

test('simultaneous save retries do not duplicate cards or resurrect deleted generated drafts', async () => {
  const [a, b] = await Promise.all([saveGeneratedKnowledgeCards([draft('one')]), saveGeneratedKnowledgeCards([draft('one')])])
  assert.equal(a[0].id, b[0].id)
  assert.equal((await loadWorkspace()).knowledgeCards.length, 1)
  await deleteKnowledgeCard(a[0].id)
  await assert.rejects(saveGeneratedKnowledgeCards([draft('one')]), /已删除/)
  assert.equal((await loadWorkspace()).knowledgeCards.length, 0)
})

test('invalid card or deleted destination rejects the entire selection', async () => {
  await assert.rejects(saveGeneratedKnowledgeCards([draft('one'), draft('two', { title: '' })]), /标题/)
  await assert.rejects(saveGeneratedKnowledgeCards([draft('one'), draft('two', { spaceId: 'missing' })]), /空间/)
  await assert.rejects(saveGeneratedKnowledgeCards([draft('one', { generation: undefined })]), /来源/)
  assert.equal((await loadWorkspace()).knowledgeCards.length, 0)
})

test('interrupted batch rolls back both cards and receipt so a retry can succeed', async () => {
  const put = IDBObjectStore.prototype.put
  IDBObjectStore.prototype.put = function (value, key) {
    if (key === 'generated-cards:batch-1') { this.transaction.abort(); throw new Error('模拟配额不足') }
    return put.call(this, value, key)
  }
  try { await assert.rejects(saveGeneratedKnowledgeCards([draft('one'), draft('two')]), /模拟配额不足/) }
  finally { IDBObjectStore.prototype.put = put }
  assert.equal((await loadWorkspace()).knowledgeCards.length, 0)
  assert.equal((await saveGeneratedKnowledgeCards([draft('one'), draft('two')])).length, 2)
})

test('chapter batches save more than eight cards with merged source snapshots and deduplicate subsets', async () => {
  const inputs = Array.from({ length: 12 }, (_, i) => draft(`part-${i}`))
  inputs[0].generation.sources = Array.from({ length: 6 }, (_, i) => ({ id: 'P1', excerpt: `来源${i}`, documentId: 'doc', spaceId: 'learn', title: '文章', heading: `章节${i}`, version: 3, start: i * 20, end: i * 20 + 10, isDraft: true }))
  const first = await saveGeneratedKnowledgeCards(inputs)
  const again = await saveGeneratedKnowledgeCards([inputs[0], inputs[8]])
  assert.equal(first[0].id, again[0].id)
  assert.equal((await loadWorkspace()).knowledgeCards.length, 12)
  assert.deepEqual(first[0].generation.sources, inputs[0].generation.sources)
  const invalid = draft('bad')
  invalid.generation.sources[0].start = -1
  await assert.rejects(saveGeneratedKnowledgeCards([invalid]), /来源/)
})
