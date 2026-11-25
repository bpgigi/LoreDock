import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb'
import { exportWorkspaceBackup, restoreWorkspaceBackup, saveWorkspace, saveDocumentDraft } from '../src/storage.ts'
import { validateWorkspaceBackup } from '../src/workspaceBackup.ts'
import { withReasoning, selectedReasoning } from '../src/reasoning.ts'

beforeEach(() => { globalThis.indexedDB = new IDBFactory() })
function fixture() {
  return {
    spaces: [{ id: 'space', name: '空间', description: '', icon: 'code', color: '#888' }],
    documents: [{ id: 'doc', spaceId: 'space', title: '正文', fileName: '01.md', body: '# 原文\n😀', heading: '原文', version: 5, size: 10, status: 'available', type: 'md', isDemo: false, updatedAt: '2026-11-10', contentHash: 'preserved' }],
    conversations: [{ id: 'chat', spaceId: 'space', title: '旧对话', createdAt: '2026-11-10', messages: [] }],
    knowledgeCards: [{ id: 'card', spaceId: 'space', title: '卡片', summary: '记法', body: 'code', tags: [], version: 2, createdAt: 'date', updatedAt: 'date', review: { legacy: true } }],
    selectedSpaceId: 'space', selectedConversationId: 'chat', deletedDocumentIds: ['removed'], futureField: { retained: true },
  }
}
async function readRecords() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('loredock-ui-preview', 1)
    request.onsuccess = () => {
      const db = request.result, tx = db.transaction('workspace'), store = tx.objectStore('workspace'), rows = []
      const cursor = store.openCursor()
      cursor.onsuccess = () => { if (cursor.result) { rows.push({ key: cursor.result.key, value: cursor.result.value }); cursor.result.continue() } }
      tx.oncomplete = () => { db.close(); resolve(rows) }
      tx.onabort = () => { db.close(); reject(tx.error) }
    }
    request.onerror = () => reject(request.error)
  })
}
test('export keeps provenance, legacy card fields, deletion markers and unsaved drafts', async () => {
  await saveWorkspace(fixture())
  const draft = { documentId: 'doc', body: '尚未提交的草稿', baseVersion: 5, updatedAt: 'date' }
  await saveDocumentDraft(draft)
  const backup = await exportWorkspaceBackup()
  assert.deepEqual(backup.records, await readRecords())
  assert.deepEqual(backup.records.find(row => row.key === 'draft:doc').value, draft)
  assert.deepEqual(backup.records.find(row => row.key === 'current').value.knowledgeCards[0].review, { legacy: true })
})

test('backup preserves card source snapshots and optional document reference after card deletion', async () => {
  const data = fixture()
  const citation = { id: 'snapshot', documentId: '', cardId: 'deleted-card', version: 1, title: '原卡片', heading: 'AI 生成草稿', excerpt: '保存时的内容', isAiDraft: true }
  data.conversations[0].referenceDocuments = true
  data.conversations[0].messages = [{ id: 'answer', role: 'assistant', body: '回答', scopeIds: ['space'], createdAt: 'date', status: 'completed', isDemo: false, citations: [citation], matchedCards: [citation], referenceDocuments: true }]
  await saveWorkspace(data)
  const backup = await exportWorkspaceBackup()
  assert.deepEqual(validateWorkspaceBackup(backup), backup)
  assert.deepEqual(backup.records.find(row => row.key === 'current').value.conversations, data.conversations)
  const invalid = structuredClone(backup)
  invalid.records.find(row => row.key === 'current').value.conversations[0].messages[0].matchedCards[0].cardId = ''
  assert.throws(() => validateWorkspaceBackup(invalid), /备份格式/)
})
test('malformed or dangling data is rejected before existing data changes', async () => {
  await saveWorkspace(fixture())
  const original = await readRecords()
  const backup = await exportWorkspaceBackup()
  backup.records.find(row => row.key === 'current').value.documents[0].spaceId = 'missing'
  await assert.rejects(restoreWorkspaceBackup(backup), /备份格式/)
  assert.deepEqual(await readRecords(), original)
  const duplicate = await exportWorkspaceBackup()
  duplicate.records.push(duplicate.records[0])
  assert.throws(() => validateWorkspaceBackup(duplicate), /备份格式/)
})

test('backup retains model-specific effort and rejects malformed preference maps', async () => {
  const data = fixture()
  data.aiPreference = withReasoning(undefined, 'custom', 'gpt-6.1-sol', 'xhigh')
  await saveWorkspace(data)
  const backup = await exportWorkspaceBackup()
  const validated = validateWorkspaceBackup(backup)
  const preference = validated.records.find(row => row.key === 'current').value.aiPreference
  assert.equal(selectedReasoning(preference, 'custom', 'gpt-6.1-sol'), 'xhigh')
  const invalid = structuredClone(backup)
  invalid.records.find(row => row.key === 'current').value.aiPreference.reasoningByModel = { bad: 'ultra' }
  assert.throws(() => validateWorkspaceBackup(invalid), /备份格式/)
})

test('reading quotes survive backup and document updates without accepting cross-document attachments', async () => {
  const data = fixture()
  const selection = { documentId: 'doc', spaceId: 'space', version: 1, title: '选择时标题', heading: '章节', text: '旧选文', context: '旧选文及前后文', isDraft: true, isHistorical: false, truncated: false }
  data.conversations[0].messages = [{ id: 'question', role: 'user', body: '什么意思', documentId: 'doc', scopeIds: ['space'], createdAt: 'date', status: 'completed', isDemo: false, citations: [], readingSelection: selection }]
  await saveWorkspace(data)
  const backup = await exportWorkspaceBackup()
  assert.deepEqual(validateWorkspaceBackup(backup), backup)
  assert.deepEqual(backup.records.find(row => row.key === 'current').value.conversations[0].messages[0].readingSelection, selection)
  const invalid = structuredClone(backup)
  invalid.records.find(row => row.key === 'current').value.conversations[0].messages[0].readingSelection.documentId = 'other'
  assert.throws(() => validateWorkspaceBackup(invalid), /备份格式/)
})
test('backup retains local related-card links even after deletion, without requiring a source snapshot', async () => {
  const data = fixture()
  const relatedCards = [{ cardId: 'deleted-card', title: 'json.loads', summary: '字符串解析' }]
  data.conversations[0].messages = [{ id: 'answer', role: 'assistant', body: '普通回答', scopeIds: ['space'], createdAt: 'date', status: 'completed', isDemo: false, citations: [], relatedCards }]
  await saveWorkspace(data)
  const backup = await exportWorkspaceBackup()
  assert.deepEqual(validateWorkspaceBackup(backup), backup)
  assert.deepEqual(backup.records.find(row => row.key === 'current').value.conversations[0].messages[0].relatedCards, relatedCards)
  const invalid = structuredClone(backup)
  invalid.records.find(row => row.key === 'current').value.conversations[0].messages[0].relatedCards[0].cardId = ''
  assert.throws(() => validateWorkspaceBackup(invalid), /备份格式/)
})
test('a write failure rolls back the entire import and releases the save barrier', async () => {
  await saveWorkspace(fixture())
  const before = await readRecords(), backup = await exportWorkspaceBackup()
  const put = IDBObjectStore.prototype.put
  IDBObjectStore.prototype.put = function () { throw new DOMException('Simulated quota failure', 'QuotaExceededError') }
  try { await assert.rejects(restoreWorkspaceBackup(backup), /quota/) }
  finally { IDBObjectStore.prototype.put = put }
  assert.deepEqual(await readRecords(), before)
  await saveWorkspace(fixture())
})
test('restore replaces demo data, retains a recovery copy and blocks stale saves until reload', async () => {
  await saveWorkspace(fixture())
  await saveDocumentDraft({ documentId: 'doc', body: 'draft', baseVersion: 5, updatedAt: 'date' })
  const backup = await exportWorkspaceBackup()
  const changed = fixture(); changed.documents[0].version = 6; changed.documents[0].body = 'old target'
  await saveWorkspace(changed)
  const restore = restoreWorkspaceBackup(backup)
  await assert.rejects(saveWorkspace(changed), /正在恢复/)
  await restore
  const records = await readRecords()
  assert.deepEqual(records.filter(row => !row.key.startsWith('recovery:')), backup.records)
  assert.equal(records.find(row => row.key.startsWith('recovery:')).value.records.find(row => row.key === 'current').value.documents[0].version, 6)
  await assert.rejects(saveWorkspace(changed), /正在恢复/)
})
