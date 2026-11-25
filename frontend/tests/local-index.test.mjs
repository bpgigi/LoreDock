import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'
import { saveLocalCopies } from '../src/localIndex.ts'
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb'
import { commitDocumentEdit, exportWorkspaceBackup, getDocumentDraft, loadWorkspace, removeLibraryItems, saveDocumentDraft, saveWorkspace } from '../src/storage.ts'

const nativeFetch = globalThis.fetch
let calls
beforeEach(() => { calls = []; globalThis.indexedDB = new IDBFactory() })
afterEach(() => { globalThis.fetch = nativeFetch })

const spaces = [{ id: 'study', name: '学习笔记', description: '', icon: 'code', color: '#666666' }]
const document = (id, body, extra = {}) => ({ id, spaceId: 'study', title: id, fileName: `${id}.md`, type: 'md',
  size: Buffer.byteLength(body), updatedAt: '2026-11-06T00:00:00.000Z', version: 5, status: 'available',
  body, heading: id, isDemo: false, sourcePath: `knowledge/${id}.md`, importBatchId: 'study-batch', ...extra })

function saved(payload) {
  return Response.json({ id: payload.id, space_id: payload.space_id, title: payload.title,
    version: payload.version, content_hash: 'server-hash', chunk_count: 1 })
}

test('blank and unavailable browser documents do not upload or authorize old server versions', async () => {
  const documents = [document('blank', ' \n\t'), document('normal', '# Python\n字典'),
    document('failed', '未准备好的正文', { status: 'failed' })]
  const original = structuredClone(documents)
  globalThis.fetch = async (url, options) => {
    const payload = JSON.parse(options.body)
    calls.push({ url, method: options.method, payload })
    return saved(payload)
  }
  const result = await saveLocalCopies(documents, spaces, new AbortController().signal)
  assert.deepEqual(result, { saved: 1, versions: { normal: 5 }, documents: [documents[1]] })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, '/api/library/documents/normal')
  assert.equal(calls[0].method, 'PUT')
  assert.equal(calls[0].payload.body, documents[1].body)
  assert.equal(calls[0].payload.space_name, '学习笔记')
  assert.deepEqual(documents, original)
})

test('a partial sync failure reports saved progress, stops later uploads and preserves browser inputs', async () => {
  const documents = [document('first', '# 第一篇'), document('second', '# 第二篇'), document('third', '# 第三篇')]
  const original = structuredClone(documents)
  globalThis.fetch = async (_url, options) => {
    const payload = JSON.parse(options.body)
    calls.push(payload.id)
    if (payload.id === 'second') return Response.json({ detail: '磁盘空间不足' }, { status: 503 })
    return saved(payload)
  }
  await assert.rejects(saveLocalCopies(documents, spaces, new AbortController().signal), error => {
    assert.match(error.message, /second.*磁盘空间不足/)
    assert.match(error.message, /此前 1 份已保存/)
    return true
  })
  assert.deepEqual(calls, ['first', 'second'])
  assert.deepEqual(documents, original)
})

test('cancellation after a completed upload never sends the next document or returns a usable allowlist', async () => {
  const controller = new AbortController()
  const documents = [document('first', '# 第一篇'), document('second', '# 第二篇')]
  globalThis.fetch = async (_url, options) => {
    const payload = JSON.parse(options.body)
    calls.push(payload.id)
    // The first write may already have completed when cancellation arrives.
    controller.abort()
    return saved(payload)
  }
  await assert.rejects(saveLocalCopies(documents, spaces, controller.signal), { name: 'AbortError' })
  assert.deepEqual(calls, ['first'])
})

test('an already cancelled or wholly empty scope makes no network request', async () => {
  globalThis.fetch = async () => { assert.fail('empty or cancelled scopes must not upload') }
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(saveLocalCopies([document('normal', '# 正文')], spaces, controller.signal), { name: 'AbortError' })
  assert.deepEqual(await saveLocalCopies([document('blank', '\n ')], spaces, new AbortController().signal),
    { saved: 0, versions: {}, documents: [] })
})

async function alignmentFixture() {
  const note = document('lesson', '# lesson\n完整正文😀', { version: 1, customSource: { original: true } })
  const workspace = { spaces, documents: [note, document('other', '# other')], conversations: [],
    selectedSpaceId: 'study', selectedConversationId: '', knowledgeCards: [], customWorkspace: { keep: true } }
  await saveWorkspace(workspace)
  return note
}

function conflictingServer(note, remoteOverrides = {}, onRead) {
  const remote = { id: note.id, space_id: note.spaceId, title: note.title, body: note.body,
    file_name: note.fileName, type: note.type, status: 'indexed', version: 5, ...remoteOverrides }
  globalThis.fetch = async (url, options) => {
    calls.push({ url, method: options.method ?? 'GET' })
    if (!options.method) { await onRead?.(); return Response.json(remote) }
    const payload = JSON.parse(options.body)
    if (payload.version === note.version || payload.version !== remote.version) return Response.json({ detail: '版本不一致' }, { status: 409 })
    assert.equal(payload.body, remote.body)
    return saved(payload)
  }
}

test('identical V1/V5 content aligns atomically, preserves the workspace and resumes with V5', async () => {
  const note = await alignmentFixture()
  const draft = { documentId: note.id, body: '# 尚未完成的编辑', baseVersion: 1, updatedAt: 'unchanged', extraDraft: true }
  await saveDocumentDraft(draft)
  const before = await exportWorkspaceBackup()
  conflictingServer(note)
  const aligned = []
  const result = await saveLocalCopies([note], spaces, new AbortController().signal, (old, current) => aligned.push({ old, current }))
  assert.equal(result.saved, 1)
  assert.deepEqual(result.versions, { lesson: 5 })
  assert.equal(result.documents[0].version, 5)
  assert.equal(result.documents[0].body, note.body)
  assert.equal(note.version, 1, 'the frozen caller snapshot is never mutated')
  assert.deepEqual(calls.map(call => call.method), ['PUT', 'GET', 'PUT'])
  assert.deepEqual(aligned, [{ old: note, current: result.documents[0] }])
  const after = await exportWorkspaceBackup()
  const expected = structuredClone(before.records)
  const record = expected.find(record => record.key === 'current')
  record.value.documents[0] = { ...note, version: 5, equivalentVersions: [1] }
  expected.find(record => record.key === `draft:${note.id}`).value.baseVersion = 5
  assert.deepEqual(after.records, expected)
  assert.deepEqual(await getDocumentDraft(note.id), { ...draft, baseVersion: 5 })
  const next = await commitDocumentEdit(note.id, draft.body, 5)
  assert.equal(next.version, 6)
  assert.equal(next.equivalentVersions, undefined)
})

test('late draft writes and an in-flight edit use the identical baseline only once', async () => {
  const note = await alignmentFixture()
  conflictingServer(note)
  await saveLocalCopies([note], spaces, new AbortController().signal)
  const draft = { documentId: note.id, body: '# 编辑 A', baseVersion: 1, updatedAt: 'late' }
  await saveDocumentDraft(draft)
  assert.equal((await getDocumentDraft(note.id)).baseVersion, 5)
  assert.equal((await commitDocumentEdit(note.id, draft.body, 1)).version, 6)
  assert.equal(await getDocumentDraft(note.id), undefined)
  const losing = { ...draft, body: '# 编辑 B' }
  await saveDocumentDraft(losing)
  await assert.rejects(commitDocumentEdit(note.id, losing.body, 1), { name: 'DocumentEditConflictError' })
  assert.equal((await loadWorkspace()).documents[0].body, draft.body)
  assert.deepEqual(await getDocumentDraft(note.id), losing)
})

test('differences in text, whitespace, identity, title, file, type or space never auto-align', async () => {
  const note = await alignmentFixture()
  const before = await exportWorkspaceBackup()
  for (const change of [{ body: `${note.body} ` }, { id: 'other' }, { title: 'different' },
    { file_name: 'different.md' }, { type: 'txt' }, { space_id: 'different' },
    { status: 'deleted' }, { version: 1 }, { version: 4.5 }]) {
    conflictingServer(note, change)
    await assert.rejects(saveLocalCopies([note], spaces, new AbortController().signal), /内容或所属空间不同/)
    assert.deepEqual((await exportWorkspaceBackup()).records, before.records)
  }
})

test('a concurrent local edit stops alignment and keeps the latest body', async () => {
  const note = await alignmentFixture()
  conflictingServer(note, {}, () => commitDocumentEdit(note.id, '# 真正的新内容', 1))
  await assert.rejects(saveLocalCopies([note], spaces, new AbortController().signal), /同步期间资料已修改/)
  const current = (await loadWorkspace()).documents[0]
  assert.equal(current.version, 2)
  assert.equal(current.body, '# 真正的新内容')
})

test('deletion while checking the server cannot recreate the local document', async () => {
  const note = await alignmentFixture()
  conflictingServer(note, {}, () => removeLibraryItems([note.id]))
  await assert.rejects(saveLocalCopies([note], spaces, new AbortController().signal), /资料已删除/)
  const current = await loadWorkspace()
  assert.equal(current.documents.some(item => item.id === note.id), false)
  assert.ok(current.deletedDocumentIds.includes(note.id))
})

test('cancellation during verification leaves document and draft versions unchanged', async () => {
  const note = await alignmentFixture()
  const before = await exportWorkspaceBackup()
  const controller = new AbortController()
  conflictingServer(note, {}, () => controller.abort())
  await assert.rejects(saveLocalCopies([note], spaces, controller.signal), { name: 'AbortError' })
  assert.deepEqual((await exportWorkspaceBackup()).records, before.records)
})

test('an aborted alignment transaction rolls back document and draft together, then retry succeeds', async () => {
  const note = await alignmentFixture()
  await saveDocumentDraft({ documentId: note.id, body: 'draft', baseVersion: 1, updatedAt: 'pending' })
  const before = await exportWorkspaceBackup()
  conflictingServer(note)
  const originalPut = IDBObjectStore.prototype.put
  let failOnce = true
  IDBObjectStore.prototype.put = function (...args) {
    if (failOnce && args[1] === `draft:${note.id}`) { failOnce = false; this.transaction.abort() }
    return originalPut.apply(this, args)
  }
  try { await assert.rejects(saveLocalCopies([note], spaces, new AbortController().signal)) }
  finally { IDBObjectStore.prototype.put = originalPut }
  assert.deepEqual((await exportWorkspaceBackup()).records, before.records)
  assert.equal((await saveLocalCopies([note], spaces, new AbortController().signal)).versions.lesson, 5)
})

test('a server deletion or another server update during verification still blocks the request', async () => {
  const note = await alignmentFixture()
  for (const status of [404, 409]) {
    conflictingServer(note)
    const server = globalThis.fetch
    globalThis.fetch = async (url, options) => {
      if (status === 404 && !options.method) return Response.json({ detail: '资料已删除' }, { status })
      if (status === 409 && options.method === 'PUT' && JSON.parse(options.body).version === 5) {
        return Response.json({ detail: '服务器再次更新了版本' }, { status })
      }
      return server(url, options)
    }
    await assert.rejects(saveLocalCopies([note], spaces, new AbortController().signal), /资料已删除|服务器再次更新了版本/)
  }
})

test('old whole-workspace saves cannot roll back alignment or revive old content', async () => {
  const note = await alignmentFixture()
  const stale = await loadWorkspace()
  conflictingServer(note)
  await saveLocalCopies([note], spaces, new AbortController().signal)
  await saveWorkspace(stale)
  assert.equal((await loadWorkspace()).documents[0].version, 5)
  await commitDocumentEdit(note.id, '# V6', 5)
  await saveWorkspace(stale)
  const current = (await loadWorkspace()).documents[0]
  assert.equal(current.version, 6)
  assert.equal(current.body, '# V6')
})
