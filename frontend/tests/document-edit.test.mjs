import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { beforeEach, test } from 'node:test'
import { IDBDatabase, IDBFactory, IDBObjectStore } from 'fake-indexeddb'
import {
  commitDocumentEdit,
  getDocumentDraft,
  loadWorkspace,
  removeDocumentDraft,
  saveDocumentDraft,
  saveWorkspace,
} from '../src/storage.ts'

beforeEach(() => { globalThis.indexedDB = new IDBFactory() })

function fixture() {
  const document = {
    id: 'lesson-1', spaceId: 'study-space', title: '原标题', fileName: '01.md', type: 'md',
    size: 30, updatedAt: '2026-11-06T00:00:00.000Z', version: 1, status: 'available',
    body: '# 原标题\n\n原文😀', heading: '原标题', isDemo: false,
    sourcePath: 'knowledge/01.md', importBatchId: 'study-20261106', studyGroup: '基础', order: 1,
    originalHash: 'original-source-hash', contentHash: 'old-content-hash',
  }
  return {
    spaces: [{ id: 'study-space', name: '学习笔记', description: '', icon: 'code', color: '#666666' }],
    documents: [document, { ...document, id: 'lesson-2', title: '第二篇', fileName: '02.md', sourcePath: 'knowledge/02.md', order: 2 }],
    conversations: [{ id: 'chat-1', spaceId: 'study-space', title: '旧对话', createdAt: '2026-11-06T00:00:00.000Z', messages: [{
      id: 'answer-1', role: 'assistant', body: '旧回答', scopeIds: ['study-space'], createdAt: '2026-11-06T00:00:00.000Z',
      status: 'completed', isDemo: false, citations: [{ id: 'source-1', documentId: document.id, title: document.title,
        heading: document.heading, version: 1, excerpt: document.body }],
    }] }],
    selectedSpaceId: 'study-space', selectedConversationId: 'chat-1',
    aiPreference: { providerId: 'local', model: 'model-a' }, importedBatchIds: ['study-20261106:source-sha'],
  }
}

const draft = (body, baseVersion = 1, documentId = 'lesson-1') => ({ documentId, body, baseVersion, updatedAt: new Date().toISOString() })

test('commit changes derived document fields while retaining provenance, other notes and old citations', async () => {
  const initial = fixture()
  await saveWorkspace(initial)
  const body = '```md\n# 代码里的伪标题\n```\n\n# 新标题\n\n完整的新正文😀。\n'
  await saveDocumentDraft(draft(body))
  const updated = await commitDocumentEdit('lesson-1', body, 1)
  assert.equal(updated.title, '新标题')
  assert.equal(updated.heading, '新标题')
  assert.equal(updated.body, body)
  assert.equal(updated.version, 2)
  assert.equal(updated.size, Buffer.byteLength(body, 'utf8'))
  assert.equal(updated.contentHash, createHash('sha256').update(body, 'utf8').digest('hex'))
  assert.notEqual(updated.updatedAt, initial.documents[0].updatedAt)
  for (const key of ['sourcePath', 'importBatchId', 'studyGroup', 'order', 'originalHash', 'fileName', 'spaceId']) {
    assert.equal(updated[key], initial.documents[0][key])
  }
  const restored = await loadWorkspace()
  assert.deepEqual(restored.documents[0], updated)
  assert.deepEqual(restored.documents[1], initial.documents[1])
  assert.deepEqual(restored.conversations, initial.conversations)
  assert.deepEqual(restored.aiPreference, initial.aiPreference)
  assert.deepEqual(restored.importedBatchIds, initial.importedBatchIds)
  assert.equal(await getDocumentDraft('lesson-1'), undefined)
})

test('unchanged body and duplicate confirmation do not create new versions', async () => {
  const initial = fixture()
  await saveWorkspace(initial)
  assert.deepEqual(await commitDocumentEdit('lesson-1', initial.documents[0].body, 1), initial.documents[0])
  const changed = await commitDocumentEdit('lesson-1', '# 新版本\n内容', 1)
  const duplicate = await commitDocumentEdit('lesson-1', '# 新版本\n内容', 1)
  assert.deepEqual(duplicate, changed)
  assert.equal((await loadWorkspace()).documents[0].version, 2)
})

test('version conflict preserves the latest body and the losing draft', async () => {
  await saveWorkspace(fixture())
  await commitDocumentEdit('lesson-1', '# 先保存的版本', 1)
  const losing = draft('# 另一份未保存修改', 1)
  await saveDocumentDraft(losing)
  await assert.rejects(commitDocumentEdit('lesson-1', losing.body, 1), error => {
    assert.equal(error.name, 'DocumentEditConflictError')
    assert.match(error.message, /资料已有新版本/)
    return true
  })
  assert.equal((await loadWorkspace()).documents[0].body, '# 先保存的版本')
  assert.deepEqual(await getDocumentDraft('lesson-1'), losing)
})

test('an older workspace snapshot cannot roll back a committed note but keeps its new AI state', async () => {
  const stale = fixture()
  await saveWorkspace(stale)
  const edited = await commitDocumentEdit('lesson-1', '# 已保存的新正文', 1)
  stale.aiPreference = { providerId: 'second-service', model: 'model-b' }
  stale.conversations[0].messages.push({ id: 'new-user-message', role: 'user', body: '新的问题', scopeIds: ['study-space'],
    citations: [], createdAt: new Date().toISOString(), status: 'completed', isDemo: false })
  await saveWorkspace(stale)
  const restored = await loadWorkspace()
  assert.deepEqual(restored.documents[0], edited)
  assert.deepEqual(restored.aiPreference, stale.aiPreference)
  assert.deepEqual(restored.conversations, stale.conversations)
  await saveWorkspace({ ...restored, documents: restored.documents.filter(item => item.id !== 'lesson-1') })
  assert.equal((await loadWorkspace()).documents.some(item => item.id === 'lesson-1'), false)
  await assert.rejects(commitDocumentEdit('lesson-1', '# 不得复活删除资料', 2), /资料已不存在/)
})

test('confirmation deletes only a draft matching both submitted body and baseline version', async () => {
  await saveWorkspace(fixture())
  await saveDocumentDraft(draft('# A'))
  const newer = draft('# B：保存A期间继续输入', 1)
  await saveDocumentDraft(newer)
  await commitDocumentEdit('lesson-1', '# A', 1)
  assert.deepEqual(await getDocumentDraft('lesson-1'), newer)
  const newBaseline = draft('# A', 2)
  await saveDocumentDraft(newBaseline)
  await commitDocumentEdit('lesson-1', '# A', 1)
  assert.deepEqual(await getDocumentDraft('lesson-1'), newBaseline)
  await commitDocumentEdit('lesson-1', '# A', 2)
  assert.equal(await getDocumentDraft('lesson-1'), undefined)
})

test('draft operations are isolated by document and preserve request ordering', async () => {
  const a = draft('A')
  const b = draft('B', 1, 'lesson-2')
  await Promise.all([saveDocumentDraft(a), saveDocumentDraft(b)])
  assert.deepEqual(await getDocumentDraft('lesson-1'), a)
  assert.deepEqual(await getDocumentDraft('lesson-2'), b)
  await removeDocumentDraft('lesson-1')
  assert.equal(await getDocumentDraft('lesson-1'), undefined)
  assert.deepEqual(await getDocumentDraft('lesson-2'), b)
})

test('transaction abort rejects without losing persisted content and the write queue recovers', async () => {
  await saveWorkspace(fixture())
  const pending = draft('# 正文不能丢')
  await saveDocumentDraft(pending)
  const originalPut = IDBObjectStore.prototype.put
  let failOnce = true
  IDBObjectStore.prototype.put = function (...args) {
    if (failOnce && args[1] === 'current') {
      failOnce = false
      this.transaction.abort()
    }
    return originalPut.apply(this, args)
  }
  try {
    await assert.rejects(commitDocumentEdit('lesson-1', pending.body, 1))
  } finally { IDBObjectStore.prototype.put = originalPut }
  assert.equal((await loadWorkspace()).documents[0].version, 1)
  assert.deepEqual(await getDocumentDraft('lesson-1'), pending)
  const recovered = await commitDocumentEdit('lesson-1', pending.body, 1)
  assert.equal(recovered.version, 2)
  assert.equal(await getDocumentDraft('lesson-1'), undefined)
})

test('plain transaction abort, without a request error, also rejects and releases the queue', async () => {
  await saveWorkspace(fixture())
  const originalTransaction = IDBDatabase.prototype.transaction
  let abortNext = true
  IDBDatabase.prototype.transaction = function (...args) {
    const tx = originalTransaction.apply(this, args)
    if (args[1] === 'readwrite' && abortNext) {
      abortNext = false
      queueMicrotask(() => tx.abort())
    }
    return tx
  }
  try { await assert.rejects(saveDocumentDraft(draft('abort case'))) }
  finally { IDBDatabase.prototype.transaction = originalTransaction }
  assert.equal(await getDocumentDraft('lesson-1'), undefined)
  await saveDocumentDraft(draft('retry case'))
  assert.equal((await getDocumentDraft('lesson-1')).body, 'retry case')
})

test('TXT retains its title, empty edits are allowed, and invalid/oversize UTF-8 content is rejected', async () => {
  const initial = fixture()
  initial.documents[0].type = 'txt'
  await saveWorkspace(initial)
  const text = await commitDocumentEdit('lesson-1', '# 仍然是普通文本', 1)
  assert.equal(text.title, '原标题')
  assert.equal(text.heading, '文档正文')
  const empty = await commitDocumentEdit('lesson-1', '', 2)
  assert.equal(empty.body, '')
  assert.equal(empty.size, 0)
  await assert.rejects(commitDocumentEdit('lesson-1', 'bad\0text', 3), /无法保存/)
  await assert.rejects(commitDocumentEdit('lesson-1', '\ud800', 3), /无法保存/)
  await assert.rejects(commitDocumentEdit('lesson-1', '中'.repeat(7 * 1024 * 1024), 3), /20 MiB/)
  assert.equal((await loadWorkspace()).documents[0].version, 3)
})
