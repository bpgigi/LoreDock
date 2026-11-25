import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb'
import {
  commitDocumentEdit, getDocumentDraft, loadWorkspace, removeLibraryItems,
  saveDocumentDraft, saveKnowledgeCard, saveWorkspace,
} from '../src/storage.ts'

beforeEach(() => { globalThis.indexedDB = new IDBFactory() })

function fixture() {
  const document = (id, spaceId) => ({ id, spaceId, title: id, fileName: `${id}.md`, type: 'md', size: 16,
    updatedAt: '2026-11-06T00:00:00.000Z', version: 5, status: 'available', body: `# ${id}\n原文`, heading: id,
    isDemo: false, sourcePath: `knowledge/${id}.md`, importBatchId: 'study', originalHash: 'original-hash' })
  const documents = [document('note-a', 'study'), document('note-b', 'study'), document('note-c', 'other')]
  const conversation = (id, spaceId, documentId) => ({ id, spaceId, documentId, title: id,
    createdAt: '2026-11-06T00:00:00.000Z', messages: [{ id: `${id}-answer`, role: 'assistant', body: '历史回答',
      scopeIds: [spaceId], createdAt: '2026-11-06T00:00:00.000Z', status: 'completed', isDemo: false,
      citations: [{ id: 'citation-a', documentId: 'note-a', version: 5, title: 'note-a', heading: 'note-a', excerpt: '# note-a\n原文' }] }] })
  return {
    spaces: ['study', 'other'].map(id => ({ id, name: id, description: '', icon: 'code', color: '#666666' })),
    documents, conversations: [conversation('chat-a', 'study'), conversation('reader-a', 'study', 'note-a'), conversation('chat-c', 'other')],
    selectedSpaceId: 'study', selectedConversationId: 'chat-a', knowledgeCards: [],
    aiPreference: { providerId: 'custom', model: 'my-model' }, importedBatchIds: ['study:original-sha'],
    futureMetadata: { value: '保留未知字段' },
  }
}

const draft = id => ({ documentId: id, body: `# ${id}\n未保存输入`, baseVersion: 5, updatedAt: '2026-11-06T01:00:00.000Z' })
const card = (spaceId, title) => ({ spaceId, title, summary: '一句记法', body: '卡片正文', tags: ['学习'] })

test('document removal keeps newer notes, cards, history and provenance while clearing only its draft', async () => {
  const initial = fixture()
  await saveWorkspace(initial)
  await saveDocumentDraft(draft('note-a'))
  await saveDocumentDraft(draft('note-b'))
  const created = await saveKnowledgeCard(card('study', '原卡片'))
  const edited = await saveKnowledgeCard(card('study', '新卡片'), created.id)
  const note = await commitDocumentEdit('note-c', '# 更新后的其他笔记', 5)
  await removeLibraryItems(['note-a'])
  const saved = await loadWorkspace()
  assert.deepEqual(saved.documents, [initial.documents[1], note])
  assert.deepEqual(saved.knowledgeCards, [edited])
  assert.deepEqual(saved.conversations, initial.conversations)
  assert.deepEqual(saved.aiPreference, initial.aiPreference)
  assert.deepEqual(saved.importedBatchIds, initial.importedBatchIds)
  assert.deepEqual(saved.futureMetadata, initial.futureMetadata)
  assert.equal(saved.selectedSpaceId, 'study')
  assert.equal(saved.selectedConversationId, 'chat-a')
  assert.deepEqual(saved.deletedDocumentIds, ['note-a'])
  assert.equal(await getDocumentDraft('note-a'), undefined)
  assert.deepEqual(await getDocumentDraft('note-b'), draft('note-b'))
})

test('a delayed workspace save cannot resurrect a deleted document or a late draft', async () => {
  const stale = fixture()
  await saveWorkspace(stale)
  const currentNote = await commitDocumentEdit('note-b', '# 已确认的新正文', 5)
  await removeLibraryItems(['note-a'])
  stale.aiPreference = { providerId: 'next', model: 'model-b' }
  await saveWorkspace(stale)
  const saved = await loadWorkspace()
  assert.deepEqual(saved.documents.map(item => item.id), ['note-b', 'note-c'])
  assert.deepEqual(saved.documents[0], currentNote)
  assert.deepEqual(saved.aiPreference, stale.aiPreference)
  assert.deepEqual(saved.conversations, stale.conversations)
  await assert.rejects(saveDocumentDraft(draft('note-a')), /资料已删除/)
  await assert.rejects(commitDocumentEdit('note-a', '# 不得复活', 5), /资料已不存在/)
  assert.equal(await getDocumentDraft('note-a'), undefined)
})

test('space removal includes current space documents, cards and conversations and selects a valid fallback', async () => {
  const initial = fixture()
  await saveWorkspace(initial)
  await saveDocumentDraft(draft('note-a'))
  await saveDocumentDraft(draft('note-b'))
  await saveDocumentDraft(draft('note-c'))
  await saveKnowledgeCard(card('study', '空间卡片'))
  const retained = await saveKnowledgeCard(card('other', '保留卡片'))
  const stale = await loadWorkspace()
  // Even if the caller's captured IDs omit note-b, the transaction reads the
  // persisted space membership and removes it together with its pending draft.
  await removeLibraryItems(['note-a'], 'study')
  await saveWorkspace(stale)
  const saved = await loadWorkspace()
  assert.deepEqual(saved.spaces.map(item => item.id), ['other'])
  assert.deepEqual(saved.documents, [initial.documents[2]])
  assert.deepEqual(saved.knowledgeCards, [retained])
  assert.deepEqual(saved.conversations, [initial.conversations[2]])
  assert.deepEqual(saved.deletedSpaceIds, ['study'])
  assert.deepEqual(new Set(saved.deletedDocumentIds), new Set(['note-a', 'note-b']))
  assert.equal(saved.selectedSpaceId, 'other')
  assert.equal(saved.selectedConversationId, 'chat-c')
  assert.equal(await getDocumentDraft('note-a'), undefined)
  assert.equal(await getDocumentDraft('note-b'), undefined)
  assert.deepEqual(await getDocumentDraft('note-c'), draft('note-c'))
  await assert.rejects(saveKnowledgeCard(card('study', '不能复活')), /空间已不存在/)
  await removeLibraryItems(['note-c'], 'other')
  const empty = await loadWorkspace()
  assert.equal(empty.selectedSpaceId, '')
  assert.equal(empty.selectedConversationId, '')
  assert.deepEqual(empty.spaces, [])
  assert.deepEqual(empty.knowledgeCards, [])
})

test('repeated removal is idempotent and merges tombstones from independent calls', async () => {
  await saveWorkspace(fixture())
  await removeLibraryItems(['note-a', 'note-a'])
  await removeLibraryItems(['note-a'])
  await removeLibraryItems([], 'study')
  const first = await loadWorkspace()
  await removeLibraryItems(['note-a', 'note-b'], 'study')
  assert.deepEqual(await loadWorkspace(), first)
  await removeLibraryItems(['note-c'])
  const saved = await loadWorkspace()
  assert.deepEqual(new Set(saved.deletedDocumentIds), new Set(['note-a', 'note-b', 'note-c']))
  assert.deepEqual(saved.documents, [])
  assert.equal(saved.conversations.length, 1)
})

test('an interrupted deletion rolls back documents, drafts and tombstones before retrying', async () => {
  await saveWorkspace(fixture())
  await saveDocumentDraft(draft('note-a'))
  const original = await loadWorkspace()
  const originalDelete = IDBObjectStore.prototype.delete
  let interruptOnce = true
  IDBObjectStore.prototype.delete = function (...args) {
    if (interruptOnce && args[0] === 'draft:note-a') {
      interruptOnce = false
      this.transaction.abort()
    }
    return originalDelete.apply(this, args)
  }
  try { await assert.rejects(removeLibraryItems(['note-a'])) }
  finally { IDBObjectStore.prototype.delete = originalDelete }
  assert.deepEqual(await loadWorkspace(), original)
  assert.deepEqual(await getDocumentDraft('note-a'), draft('note-a'))
  await removeLibraryItems(['note-a'])
  assert.equal((await loadWorkspace()).documents.some(item => item.id === 'note-a'), false)
  assert.equal(await getDocumentDraft('note-a'), undefined)
})

test('invalid IDs and mismatched space membership leave all records unchanged', async () => {
  await saveWorkspace(fixture())
  const original = await loadWorkspace()
  await assert.rejects(removeLibraryItems(['']), /资料标识/)
  await assert.rejects(removeLibraryItems(['a'.repeat(129)]), /资料标识/)
  await assert.rejects(removeLibraryItems([], ' '), /空间标识/)
  await assert.rejects(removeLibraryItems(['note-c'], 'study'), /不匹配/)
  assert.deepEqual(await loadWorkspace(), original)
})
