import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { IDBFactory } from 'fake-indexeddb'
import { ensureKnowledgeCards } from '../src/knowledgeCards.ts'
import {
  deleteKnowledgeCard, getDocumentDraft, loadWorkspace, saveDocumentDraft, saveKnowledgeCard, saveWorkspace,
} from '../src/storage.ts'

beforeEach(() => { globalThis.indexedDB = new IDBFactory() })

function workspace(cards = []) {
  return {
    spaces: [{ id: 'other', name: '其他', description: '', icon: 'code', color: '#666666' },
      { id: 'python', name: 'Python', description: '', icon: 'code', color: '#666666' }],
    documents: [{ id: 'note-1', spaceId: 'python', title: '原笔记', fileName: 'note.md', type: 'md', size: 10,
      updatedAt: '2026-11-06T00:00:00.000Z', version: 1, status: 'available', body: '# 原笔记', heading: '原笔记', isDemo: false }],
    conversations: [{ id: 'chat-1', spaceId: 'python', title: '已有对话', messages: [], createdAt: '2026-11-06T00:00:00.000Z' }],
    selectedSpaceId: 'python', selectedConversationId: 'chat-1', aiPreference: { providerId: 'mine', model: 'chosen-model' },
    importedBatchIds: ['batch:hash'], ...(cards === undefined ? {} : { knowledgeCards: cards }),
  }
}

const input = values => ({ spaceId: 'python', title: '我的卡片', summary: '简短摘要', body: '# 正文\n\n自己的知识记录。', tags: ['Python'], ...values })

test('one-time JSON examples target Python and preserve every other workspace field', () => {
  const initial = workspace()
  delete initial.knowledgeCards
  const snapshot = structuredClone(initial)
  const prepared = ensureKnowledgeCards(initial)
  assert.deepEqual(initial, snapshot)
  assert.equal(prepared.knowledgeCards.length, 4)
  assert.deepEqual(prepared.documents, initial.documents)
  assert.deepEqual(prepared.conversations, initial.conversations)
  assert.deepEqual(prepared.aiPreference, initial.aiPreference)
  assert.deepEqual(new Set(prepared.knowledgeCards.map(card => card.id)), new Set(['example-json-load', 'example-json-loads', 'example-json-dump', 'example-json-dumps']))
  assert.ok(prepared.knowledgeCards.every(card => card.spaceId === 'python' && card.isDemo === true && card.version === 1))
  const byId = Object.fromEntries(prepared.knowledgeCards.map(card => [card.id, card]))
  assert.match(byId['example-json-load'].body, /config = json\.load\(fp\)/)
  assert.match(byId['example-json-loads'].body, /data = json\.loads\(payload\)/)
  assert.match(byId['example-json-dump'].body, /json\.dump\(settings, fp, ensure_ascii=False, indent=2\)/)
  assert.match(byId['example-json-dumps'].body, /text = json\.dumps\(settings, ensure_ascii=False, indent=2\)/)
  assert.ok(prepared.knowledgeCards.every(card => card.body.includes('https://docs.python.org/3/library/json.html')))
  assert.equal(ensureKnowledgeCards(prepared), prepared)
})

test('explicit empty collections stay empty; absent Python uses first space and absent spaces seed nothing', async () => {
  const empty = workspace([])
  assert.equal(ensureKnowledgeCards(empty), empty)
  const fallback = workspace()
  delete fallback.knowledgeCards
  fallback.spaces = fallback.spaces.filter(space => space.id !== 'python')
  assert.ok(ensureKnowledgeCards(fallback).knowledgeCards.every(card => card.spaceId === 'other'))
  fallback.spaces = []
  assert.deepEqual(ensureKnowledgeCards(fallback).knowledgeCards, [])
  await saveWorkspace(empty)
  assert.deepEqual((await loadWorkspace()).knowledgeCards, [])
})

test('dedicated card create/update/delete preserve document drafts and unrelated workspace data', async () => {
  const initial = workspace([])
  await saveWorkspace(initial)
  const pending = { documentId: 'note-1', body: '# 还未保存的修改', baseVersion: 1, updatedAt: new Date().toISOString() }
  await saveDocumentDraft(pending)
  const created = await saveKnowledgeCard(input({ title: '  我的卡片  ', tags: [' Python ', 'JSON', 'JSON'] }))
  assert.ok(created.id)
  assert.equal(created.title, '我的卡片')
  assert.deepEqual(created.tags, ['Python', 'JSON'])
  assert.equal(created.version, 1)
  assert.equal(created.isDemo, false)
  const edited = await saveKnowledgeCard(input({ title: '新标题', body: '    保留缩进与结尾\n', tags: ['JSON'] }), created.id)
  assert.equal(edited.id, created.id)
  assert.equal(edited.createdAt, created.createdAt)
  assert.equal(edited.version, 2)
  assert.equal(edited.body, '    保留缩进与结尾\n')
  assert.deepEqual(await saveKnowledgeCard(input({ title: '新标题', body: edited.body, tags: ['JSON'] }), created.id), edited)
  const saved = await loadWorkspace()
  assert.deepEqual(saved.documents, initial.documents)
  assert.deepEqual(saved.conversations, initial.conversations)
  assert.deepEqual(saved.aiPreference, initial.aiPreference)
  assert.deepEqual(saved.importedBatchIds, initial.importedBatchIds)
  assert.deepEqual(await getDocumentDraft('note-1'), pending)
  await deleteKnowledgeCard(created.id)
  assert.deepEqual((await loadWorkspace()).knowledgeCards, [])
})

test('old background workspace saves cannot roll back card edits or resurrect deletions', async () => {
  await saveWorkspace(workspace([]))
  const card = await saveKnowledgeCard(input())
  const stale = await loadWorkspace()
  const edited = await saveKnowledgeCard(input({ title: '已保存的新卡片标题' }), card.id)
  stale.aiPreference = { providerId: 'new-service', model: 'model-b' }
  await saveWorkspace(stale)
  let current = await loadWorkspace()
  assert.deepEqual(current.knowledgeCards, [edited])
  assert.deepEqual(current.aiPreference, stale.aiPreference)
  await deleteKnowledgeCard(card.id)
  await saveWorkspace(stale)
  current = await loadWorkspace()
  assert.deepEqual(current.knowledgeCards, [])
})

test('space deletion removes its cards and later snapshots cannot regenerate demo seeds', async () => {
  const initial = workspace()
  delete initial.knowledgeCards
  await saveWorkspace(initial)
  assert.equal((await loadWorkspace()).knowledgeCards.length, 4)
  await saveWorkspace({ ...initial, spaces: initial.spaces.filter(space => space.id !== 'python') })
  assert.deepEqual((await loadWorkspace()).knowledgeCards, [])
  await saveWorkspace(initial)
  assert.deepEqual((await loadWorkspace()).knowledgeCards, [])
  await assert.rejects(saveKnowledgeCard(input({ spaceId: 'missing' })), /空间已不存在/)
})

test('invalid card inputs do not alter persisted cards or poison the shared queue', async () => {
  await saveWorkspace(workspace([]))
  const invalid = [
    { title: ' ' }, { title: 'a'.repeat(101) }, { summary: 'a'.repeat(201) },
    { body: ' ' }, { body: 'a'.repeat(20001) }, { body: 'bad\0text' },
    { tags: Array.from({ length: 9 }, (_, number) => `tag${number}`) },
    { tags: ['a'.repeat(21)] }, { tags: [' '] }, { spaceId: 'unknown' },
  ]
  for (const values of invalid) await assert.rejects(saveKnowledgeCard(input(values)))
  await assert.rejects(saveKnowledgeCard(input(), 'does-not-exist'), /卡片已不存在/)
  await assert.rejects(deleteKnowledgeCard('does-not-exist'), /卡片已不存在/)
  assert.deepEqual((await loadWorkspace()).knowledgeCards, [])
  const valid = await saveKnowledgeCard(input({ title: 'a'.repeat(100), summary: 'b'.repeat(200), body: 'c'.repeat(20000), tags: ['d'.repeat(20)] }))
  assert.equal(valid.version, 1)
})

test('concurrent card creates read the latest persisted collection instead of replacing each other', async () => {
  await saveWorkspace(workspace([]))
  const [a, b] = await Promise.all([saveKnowledgeCard(input({ title: 'A' })), saveKnowledgeCard(input({ title: 'B' }))])
  const saved = await loadWorkspace()
  assert.deepEqual(new Set(saved.knowledgeCards.map(card => card.id)), new Set([a.id, b.id]))
})

test('ordinary card saves preserve legacy extra metadata without enabling or migrating it', async () => {
  const legacy = { ...input(), id: 'example-json-load', createdAt: '2026-11-06T00:00:00.000Z',
    updatedAt: '2026-11-06T00:00:00.000Z', version: 3, isDemo: true,
    question: '  原来的问题保持原样  ',
    review: { status: 'forgotten', count: 7, contentVersion: 3, reviewedAt: '2026-11-06T03:00:00.000Z' },
    unknownMetadata: { originalLabel: '  用户保留字段  ' },
  }
  const initial = workspace([legacy]);
  assert.equal(ensureKnowledgeCards(initial), initial);
  await saveWorkspace(initial);
  assert.deepEqual((await loadWorkspace()).knowledgeCards[0], legacy);
  const edited = await saveKnowledgeCard(input({ title: '普通知识卡片', body: '# 新正文\n\n保留的代码与文字。' }), legacy.id);
  assert.equal(edited.version, 4);
  assert.equal(edited.question, legacy.question);
  assert.deepEqual(edited.review, legacy.review);
  assert.deepEqual(edited.unknownMetadata, legacy.unknownMetadata);
  await saveWorkspace(initial);
  const persisted = (await loadWorkspace()).knowledgeCards[0];
  assert.deepEqual(persisted, edited);
  assert.equal(persisted.review.contentVersion, 3);
  assert.equal(persisted.body, '# 新正文\n\n保留的代码与文字。');
});
