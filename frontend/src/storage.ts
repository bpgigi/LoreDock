import type { Conversation, KnowledgeCard, KnowledgeCardInput, KnowledgeDocument, Space, GeneratedKnowledgeCardInput } from './types'
import { ensureKnowledgeCards } from './knowledgeCards.ts'
import { validateWorkspaceBackup } from './workspaceBackup.ts'
import type { WorkspaceBackup } from './workspaceBackup.ts'
import type { AiPreference } from './reasoning'

export interface WorkspaceData {
  spaces: Space[]
  documents: KnowledgeDocument[]
  conversations: Conversation[]
  selectedSpaceId: string
  selectedConversationId: string
  aiPreference?: AiPreference
  importedBatchIds?: string[]
  knowledgeCards?: KnowledgeCard[]
  deletedDocumentIds?: string[]
  deletedSpaceIds?: string[]
}

export interface DocumentDraft {
  documentId: string
  body: string
  baseVersion: number
  updatedAt: string
}

const databaseName = 'loredock-ui-preview'
const maximumDocumentBytes = 20 * 1024 * 1024
let operationQueue: Promise<void> = Promise.resolve()
let restoringWorkspace = false

/** One queue also covers old whole-workspace saves, so they cannot overtake edits. */
function enqueue<T>(operation: () => Promise<T>): Promise<T> {
  if (restoringWorkspace) return Promise.reject(new Error('工作区正在恢复，请等待页面重新加载。'))
  const result = operationQueue.then(operation)
  operationQueue = result.then(() => undefined, () => undefined)
  return result
}

/** Export every record, including drafts and unknown legacy fields. */
export function exportWorkspaceBackup(): Promise<WorkspaceBackup> {
  return enqueue(() => transaction<WorkspaceBackup>('readonly', (store, done, fail) => {
    const records: WorkspaceBackup['records'] = []
    const cursor = store.openCursor()
    cursor.onsuccess = () => {
      if (cursor.result) {
        records.push({ key: String(cursor.result.key), value: cursor.result.value })
        cursor.result.continue()
      } else {
        try { done(validateWorkspaceBackup({ format: 'loredock-workspace', version: 1, exportedAt: new Date().toISOString(), records })) }
        catch (error) { fail(error) }
      }
    }
  }))
}

/** Replace atomically; block stale React saves until the caller reloads the page. */
export async function restoreWorkspaceBackup(input: unknown): Promise<void> {
  const backup = structuredClone(validateWorkspaceBackup(input))
  if (restoringWorkspace) throw new Error('工作区正在恢复，请等待页面重新加载。')
  restoringWorkspace = true
  try {
    await operationQueue
    await transaction<void>('readwrite', (store, done, fail) => {
      const previous: WorkspaceBackup['records'] = []
      const cursor = store.openCursor()
      cursor.onsuccess = () => {
        try {
          if (cursor.result) {
            const key = String(cursor.result.key)
            if (!key.startsWith('recovery:')) previous.push({ key, value: cursor.result.value })
            cursor.result.continue()
          } else {
            store.clear()
            for (const record of backup.records) store.put(record.value, record.key)
            const exportedAt = new Date().toISOString()
            store.put({ format: 'loredock-workspace', version: 1, exportedAt, records: previous }, `recovery:${exportedAt}`)
            done(undefined)
          }
        } catch (error) { fail(error) }
      }
    })
  } catch (error) {
    restoringWorkspace = false
    throw error
  }
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1)
    let settled = false
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains('workspace')) request.result.createObjectStore('workspace')
    }
    request.onsuccess = () => {
      if (settled) { request.result.close(); return }
      settled = true
      resolve(request.result)
    }
    request.onerror = () => {
      if (settled) return
      settled = true
      reject(request.error ?? new Error('无法打开浏览器存储。'))
    }
    request.onblocked = () => {
      if (settled) return
      settled = true
      reject(new Error('浏览器存储被其他页面占用，请关闭旧页面后重试。'))
    }
  })
}

/** Never await inside an IndexedDB transaction: all follow-up requests use its events. */
async function transaction<T>(mode: IDBTransactionMode, action: (
  store: IDBObjectStore,
  result: (value: T) => void,
  fail: (error: unknown) => void,
) => void): Promise<T> {
  const db = await openDatabase()
  return new Promise((resolve, reject) => {
    let tx: IDBTransaction
    let result: T
    let failure: unknown
    let finished = false
    const rejectOnce = (error: unknown) => {
      if (finished) return
      finished = true
      db.close()
      reject(error)
    }
    try { tx = db.transaction('workspace', mode) }
    catch (error) { rejectOnce(error); return }
    const fail = (error: unknown) => {
      failure = error
      try { tx.abort() }
      catch { rejectOnce(error) }
    }
    tx.oncomplete = () => {
      if (finished) return
      finished = true
      db.close()
      if (failure !== undefined) reject(failure)
      else resolve(result)
    }
    tx.onerror = () => { failure ??= tx.error ?? new Error('浏览器未能完成保存，请重试。') }
    tx.onabort = () => rejectOnce(failure ?? tx.error ?? new Error('浏览器保存已中断，草稿仍需保存。'))
    try { action(tx.objectStore('workspace'), value => { result = value }, fail) }
    catch (error) { fail(error) }
  })
}

function isWorkspace(value: unknown): value is WorkspaceData {
  if (!value || typeof value !== 'object') return false
  const data = value as WorkspaceData
  return Array.isArray(data.spaces) && Array.isArray(data.documents) && Array.isArray(data.conversations)
}

function draftKey(documentId: string) {
  if (!documentId || documentId.length > 128) throw new Error('资料标识无效，请重新打开资料。')
  return `draft:${documentId}`
}

function isDraft(value: unknown, documentId: string): value is DocumentDraft {
  if (!value || typeof value !== 'object') return false
  const draft = value as DocumentDraft
  return draft.documentId === documentId && typeof draft.body === 'string'
    && Number.isInteger(draft.baseVersion) && draft.baseVersion >= 1 && typeof draft.updatedAt === 'string'
}

export function loadWorkspace(): Promise<WorkspaceData | undefined> {
  return enqueue(() => transaction<WorkspaceData | undefined>('readonly', (store, done) => {
    const request = store.get('current')
    request.onsuccess = () => done(isWorkspace(request.result) ? ensureKnowledgeCards(request.result) : undefined)
  }))
}

function validSelection(workspace: Pick<WorkspaceData, 'spaces' | 'conversations' | 'selectedSpaceId' | 'selectedConversationId'>) {
  const selectedSpaceId = workspace.spaces.some(space => space.id === workspace.selectedSpaceId)
    ? workspace.selectedSpaceId : workspace.spaces[0]?.id ?? ''
  const selectedConversationId = workspace.conversations.find(conversation => conversation.id === workspace.selectedConversationId
    && conversation.spaceId === selectedSpaceId)?.id
    ?? workspace.conversations.find(conversation => conversation.spaceId === selectedSpaceId && !conversation.documentId)?.id
    ?? workspace.conversations.find(conversation => conversation.spaceId === selectedSpaceId)?.id ?? ''
  return { selectedSpaceId, selectedConversationId }
}

export async function saveWorkspace(data: WorkspaceData): Promise<void> {
  // Snapshot at the call boundary, not after waiting for other writes.
  const incoming = structuredClone(data)
  return enqueue(() => transaction<void>('readwrite', (store, done, fail) => {
    const request = store.get('current')
    request.onsuccess = () => {
      try {
        const stored = isWorkspace(request.result) ? request.result : undefined
        // A delayed whole-workspace save may still contain deleted rows. Deletion
        // markers are monotonic and belong to the transaction, not the React view.
        const deletedSpaceIds = new Set([...(stored?.deletedSpaceIds ?? []), ...(incoming.deletedSpaceIds ?? [])])
        const deletedDocumentIds = new Set([...(stored?.deletedDocumentIds ?? []), ...(incoming.deletedDocumentIds ?? [])])
        for (const document of [...(stored?.documents ?? []), ...incoming.documents]) {
          if (deletedSpaceIds.has(document.spaceId)) deletedDocumentIds.add(document.id)
        }
        const spaces = incoming.spaces.filter(space => !deletedSpaceIds.has(space.id))
        const latest = new Map(stored?.documents.map(document => [document.id, document]) ?? [])
        const documents = incoming.documents.filter(document => !deletedDocumentIds.has(document.id)
          && !deletedSpaceIds.has(document.spaceId)).map(document => {
          const newer = latest.get(document.id)
          return newer && newer.version > document.version ? newer : document
        })
        const conversations = incoming.conversations.filter(conversation => !deletedSpaceIds.has(conversation.spaceId))
        // Incoming omissions are explicit deletions; do not restore omitted documents.
        // Cards have dedicated mutations: background snapshots cannot undo a card
        // edit/delete, but deleting a space still removes that space's cards.
        const spaceIds = new Set(spaces.map(space => space.id))
        const knowledgeCards = (stored && Array.isArray(stored.knowledgeCards)
          ? ensureKnowledgeCards(stored).knowledgeCards ?? [] : ensureKnowledgeCards(incoming).knowledgeCards ?? [])
          .filter(card => spaceIds.has(card.spaceId))
        const next = { ...stored, ...incoming, spaces, documents, conversations, knowledgeCards,
          deletedDocumentIds: [...deletedDocumentIds], deletedSpaceIds: [...deletedSpaceIds] }
        store.put({ ...next, ...validSelection(next) }, 'current')
        for (const id of deletedDocumentIds) store.delete(draftKey(id))
        done(undefined)
      } catch (error) { fail(error) }
    }
  }))
}

/** Delete only the requested library records and their drafts in one transaction.
 * Historical conversations survive document removal; removing a whole space also
 * removes its cards and conversations. A retry is safe even after the rows are gone.
 */
export async function removeLibraryItems(documentIds: string[], spaceId?: string): Promise<void> {
  if (!Array.isArray(documentIds) || documentIds.some(id => typeof id !== 'string' || !id.trim() || id.length > 128)) {
    throw new Error('资料标识无效，请刷新后重试。')
  }
  if (spaceId !== undefined && (typeof spaceId !== 'string' || !spaceId.trim() || spaceId.length > 128)) {
    throw new Error('空间标识无效，请刷新后重试。')
  }
  const requestedIds = [...new Set(documentIds)]
  return enqueue(() => transaction<void>('readwrite', (store, done, fail) => {
    const request = store.get('current')
    request.onsuccess = () => {
      try {
        if (!isWorkspace(request.result)) throw new Error('工作区尚未就绪，请稍后重试。')
        const workspace = request.result
        const requested = new Set(requestedIds)
        if (spaceId !== undefined && workspace.documents.some(document => requested.has(document.id) && document.spaceId !== spaceId)) {
          throw new Error('资料与待删除空间不匹配，请刷新后重试。')
        }
        const deletedSpaceIds = new Set(workspace.deletedSpaceIds ?? [])
        if (spaceId !== undefined) deletedSpaceIds.add(spaceId)
        const deletedDocumentIds = new Set([...(workspace.deletedDocumentIds ?? []), ...requestedIds])
        for (const document of workspace.documents) {
          if (deletedSpaceIds.has(document.spaceId)) deletedDocumentIds.add(document.id)
        }
        const spaces = workspace.spaces.filter(space => !deletedSpaceIds.has(space.id))
        const documents = workspace.documents.filter(document => !deletedDocumentIds.has(document.id))
        const conversations = workspace.conversations.filter(conversation => !deletedSpaceIds.has(conversation.spaceId))
        const knowledgeCards = workspace.knowledgeCards?.filter(card => !deletedSpaceIds.has(card.spaceId))
        const next = { ...workspace, spaces, documents, conversations, knowledgeCards,
          deletedDocumentIds: [...deletedDocumentIds], deletedSpaceIds: [...deletedSpaceIds] }
        store.put({ ...next, ...validSelection(next) }, 'current')
        for (const id of deletedDocumentIds) store.delete(draftKey(id))
        done(undefined)
      } catch (error) { fail(error) }
    }
  }))
}

export async function getDocumentDraft(documentId: string): Promise<DocumentDraft | undefined> {
  const key = draftKey(documentId)
  return enqueue(() => transaction<DocumentDraft | undefined>('readonly', (store, done) => {
    const request = store.get(key)
    request.onsuccess = () => done(isDraft(request.result, documentId) ? request.result : undefined)
  }))
}

export function sameDocumentContent(left: KnowledgeDocument, right: KnowledgeDocument): boolean {
  return left.id === right.id && left.spaceId === right.spaceId && left.body === right.body
    && left.title === right.title && left.fileName === right.fileName && left.type === right.type
}

/** Advance only version metadata after the caller verified the server's exact content. */
export async function alignDocumentVersion(document: KnowledgeDocument, version: number, signal?: AbortSignal): Promise<KnowledgeDocument> {
  const snapshot = structuredClone(document)
  if (!Number.isSafeInteger(version) || version <= snapshot.version) throw new Error('对齐版本无效。')
  return enqueue(() => transaction<KnowledgeDocument>('readwrite', (store, done, fail) => {
    const request = store.get('current')
    request.onsuccess = () => {
      try {
        signal?.throwIfAborted()
        if (!isWorkspace(request.result)) throw new Error('工作区尚未就绪，请稍后重试。')
        const workspace = request.result
        const current = workspace.documents.find(item => item.id === snapshot.id)
        if (!current || workspace.deletedDocumentIds?.includes(snapshot.id) || workspace.deletedSpaceIds?.includes(snapshot.spaceId)) {
          throw new Error('资料已删除，无法再同步该资料。')
        }
        if (current.status !== 'available' || !sameDocumentContent(current, snapshot)
          || (current.version !== snapshot.version && current.version !== version)) {
          throw new Error('同步期间资料已修改，当前内容已保留，请重试。')
        }
        const updated: KnowledgeDocument = { ...current, version,
          equivalentVersions: [...new Set([...(current.equivalentVersions ?? []), snapshot.version])] }
        const draftRequest = store.get(draftKey(snapshot.id))
        draftRequest.onsuccess = () => {
          try {
            signal?.throwIfAborted()
            store.put({ ...workspace, documents: workspace.documents.map(item => item.id === snapshot.id ? updated : item) }, 'current')
            const draft = draftRequest.result
            if (isDraft(draft, snapshot.id) && updated.equivalentVersions?.includes(draft.baseVersion)) {
              store.put({ ...draft, baseVersion: version }, draftKey(snapshot.id))
            }
            done(updated)
          } catch (error) { fail(error) }
        }
      } catch (error) { fail(error) }
    }
  }))
}

export async function saveDocumentDraft(draft: DocumentDraft): Promise<void> {
  const key = draftKey(draft.documentId)
  const snapshot = structuredClone(draft)
  if (!isDraft(snapshot, draft.documentId)) throw new Error('草稿格式无效，尚未保存。')
  return enqueue(() => transaction<void>('readwrite', (store, done, fail) => {
    const request = store.get('current')
    request.onsuccess = () => {
      try {
        if (isWorkspace(request.result) && request.result.deletedDocumentIds?.includes(snapshot.documentId)) {
          throw new Error('资料已删除，无法再保存该资料的草稿。')
        }
        const current = isWorkspace(request.result) ? request.result.documents.find(item => item.id === snapshot.documentId) : undefined
        // A draft queued before alignment still belongs to the identical baseline.
        const baseVersion = current?.equivalentVersions?.includes(snapshot.baseVersion) ? current.version : snapshot.baseVersion
        store.put({ ...snapshot, baseVersion }, key)
        done(undefined)
      } catch (error) { fail(error) }
    }
  }))
}

export async function removeDocumentDraft(documentId: string): Promise<void> {
  const key = draftKey(documentId)
  return enqueue(() => transaction<void>('readwrite', (store, done) => {
    store.delete(key)
    done(undefined)
  }))
}

function firstMarkdownHeading(body: string): string | undefined {
  let fence: { char: string; size: number } | undefined
  for (const line of body.split(/\r?\n/)) {
    const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/)
    if (fenceMatch) {
      const marker = fenceMatch[1]
      if (!fence) fence = { char: marker[0], size: marker.length }
      else if (marker[0] === fence.char && marker.length >= fence.size && !fenceMatch[2].trim()) fence = undefined
      continue
    }
    if (fence) continue
    const heading = line.match(/^ {0,3}#{1,6}[ \t]+(.+?)\s*$/)
    const title = heading?.[1].replace(/\s+#+\s*$/, '').trim()
    if (title) return title.slice(0, 240)
  }
  return undefined
}

export async function commitDocumentEdit(documentId: string, body: string, expectedVersion: number): Promise<KnowledgeDocument> {
  const key = draftKey(documentId)
  if (typeof body !== 'string' || body.includes('\0') || /[\uD800-\uDFFF]/u.test(body)) throw new Error('正文含有无法保存的字符，请检查后重试。')
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) throw new Error('保存版本无效，请重新打开资料。')
  const encoded = new TextEncoder().encode(body)
  if (encoded.byteLength > maximumDocumentBytes) throw new Error('正文不能超过 20 MiB，草稿已保留。')
  const digest = await crypto.subtle.digest('SHA-256', encoded)
  const contentHash = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('')
  const firstHeading = firstMarkdownHeading(body)
  return enqueue(() => transaction<KnowledgeDocument>('readwrite', (store, done, fail) => {
    const request = store.get('current')
    request.onsuccess = () => {
      try {
        if (!isWorkspace(request.result)) throw new Error('资料已不存在，草稿已保留。')
        const workspace = request.result
        const current = workspace.documents.find(document => document.id === documentId)
        if (!current) throw new Error('资料已不存在，草稿已保留。')
        const unchanged = current.body === body
        if (!unchanged && current.version !== expectedVersion && !current.equivalentVersions?.includes(expectedVersion)) {
          const error = new Error('资料已有新版本，草稿已保留。')
          error.name = 'DocumentEditConflictError'
          throw error
        }
        const updated: KnowledgeDocument = unchanged ? current : {
          ...current,
          body,
          title: current.type === 'md' ? firstHeading ?? current.title : current.title,
          heading: current.type === 'md' ? firstHeading ?? '文档正文' : '文档正文',
          size: encoded.byteLength,
          updatedAt: new Date().toISOString(),
          contentHash,
          version: current.version + 1,
          equivalentVersions: undefined,
          status: 'available',
          isDemo: false,
          failureReason: undefined,
        }
        const draftRequest = store.get(key)
        draftRequest.onsuccess = () => {
          try {
            if (!unchanged) store.put({ ...workspace, documents: workspace.documents.map(document => document.id === documentId ? updated : document) }, 'current')
            const draft = draftRequest.result
            if (isDraft(draft, documentId) && draft.body === body && (draft.baseVersion === expectedVersion
              || (current.equivalentVersions?.includes(expectedVersion) && draft.baseVersion === current.version))) store.delete(key)
            done(updated)
          } catch (error) { fail(error) }
        }
      } catch (error) { fail(error) }
    }
  }))
}

function normalizeCardInput(input: KnowledgeCardInput): KnowledgeCardInput {
  if (!input || typeof input !== 'object' || typeof input.spaceId !== 'string' || !input.spaceId.trim()) throw new Error('请选择卡片所属空间。')
  if (typeof input.title !== 'string' || !input.title.trim()) throw new Error('请填写卡片标题。')
  if (input.title.trim().length > 100) throw new Error('卡片标题不能超过 100 字。')
  if (typeof input.summary !== 'string' || input.summary.trim().length > 200) throw new Error('卡片摘要不能超过 200 字。')
  if (typeof input.body !== 'string' || !input.body.trim()) throw new Error('请填写卡片正文。')
  if (input.body.length > 20000 || input.body.includes('\0')) throw new Error('卡片正文需为不超过 20000 字的有效文本。')
  if (!Array.isArray(input.tags) || input.tags.length > 8 || input.tags.some(tag => typeof tag !== 'string' || !tag.trim() || tag.trim().length > 20)) throw new Error('最多填写 8 个标签，每个标签为 1–20 字。')
  return { spaceId: input.spaceId.trim(), title: input.title.trim(), summary: input.summary.trim(), body: input.body, tags: [...new Set(input.tags.map(tag => tag.trim()))] }
}

export async function saveKnowledgeCard(input: KnowledgeCardInput, id?: string): Promise<KnowledgeCard> {
  const value = normalizeCardInput(structuredClone(input))
  if (id !== undefined && (!id || id.length > 128)) throw new Error('卡片标识无效。')
  return enqueue(() => transaction<KnowledgeCard>('readwrite', (store, done, fail) => {
    const request = store.get('current')
    request.onsuccess = () => {
      try {
        if (!isWorkspace(request.result)) throw new Error('工作区尚未就绪，请稍后重试。')
        const workspace = ensureKnowledgeCards(request.result)
        if (!workspace.spaces.some(space => space.id === value.spaceId)) throw new Error('所选空间已不存在，请重新选择。')
        const cards = workspace.knowledgeCards ?? []
        const existing = id === undefined ? undefined : cards.find(card => card.id === id)
        if (id !== undefined && !existing) throw new Error('卡片已不存在，请刷新列表。')
        const unchanged = existing && existing.spaceId === value.spaceId && existing.title === value.title
          && existing.summary === value.summary && existing.body === value.body && JSON.stringify(existing.tags) === JSON.stringify(value.tags)
        if (unchanged) { done(existing); return }
        const timestamp = new Date().toISOString()
        const version = (existing?.version ?? 0) + 1
        // Retain unknown fields from older local records without enabling their
        // old behavior or changing them when ordinary content is edited.
        const updated: KnowledgeCard = { ...existing, ...value, id: existing?.id ?? crypto.randomUUID(), createdAt: existing?.createdAt ?? timestamp,
          updatedAt: timestamp, version, isDemo: false }
        store.put({ ...workspace, knowledgeCards: existing ? cards.map(card => card.id === id ? updated : card) : [updated, ...cards] }, 'current')
        done(updated)
      } catch (error) { fail(error) }
    }
  }))
}

/** Save a reviewed selection atomically; receipts prevent retries from duplicating
 * cards or resurrecting a generated card that was subsequently deleted. */
export async function saveGeneratedKnowledgeCards(inputs: GeneratedKnowledgeCardInput[]): Promise<KnowledgeCard[]> {
  if (!Array.isArray(inputs) || !inputs.length || inputs.length > 1000) throw new Error('每次请选择 1–1000 张卡片保存。')
  const values = structuredClone(inputs).map(input => {
    const normalized = normalizeCardInput(input)
    const meta = input.generation
    const validId = (id: unknown) => typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id)
    if (!meta || !validId(meta.batchId) || !validId(meta.draftId)
      || typeof meta.providerName !== 'string' || !meta.providerName || meta.providerName.length > 80
      || typeof meta.model !== 'string' || !meta.model || meta.model.length > 200
      || typeof meta.generatedAt !== 'string' || !Number.isFinite(Date.parse(meta.generatedAt))
      || !Array.isArray(meta.sources) || !meta.sources.length || meta.sources.length > 64
      || meta.sources.some(source => !source || !/^P\d+$/.test(source.id) || typeof source.excerpt !== 'string' || !source.excerpt || source.excerpt.length > 3200
        || (['documentId', 'spaceId', 'title', 'heading'] as const).some(key => source[key] !== undefined && (typeof source[key] !== 'string' || source[key]!.length > ({ documentId: 128, spaceId: 128, title: 240, heading: 500 }[key])))
        || (['version', 'start', 'end'] as const).some(key => source[key] !== undefined && (!Number.isSafeInteger(source[key]) || source[key]! < (key === 'version' ? 1 : 0)))
        || (source.start !== undefined && source.end !== undefined && source.end < source.start)
        || (source.sourcePath !== undefined && (typeof source.sourcePath !== 'string' || source.sourcePath.length > 4096))
        || (['isDraft', 'isHistorical'] as const).some(key => source[key] !== undefined && typeof source[key] !== 'boolean'))) {
      throw new Error('生成来源信息不完整，尚未保存任何卡片。')
    }
    return { ...normalized, generation: meta }
  })
  const batchId = values[0].generation.batchId
  if (values.some(value => value.generation.batchId !== batchId)
    || new Set(values.map(value => value.generation.draftId)).size !== values.length) throw new Error('生成批次或草稿标识无效。')
  return enqueue(() => transaction<KnowledgeCard[]>('readwrite', (store, done, fail) => {
    const request = store.get('current')
    request.onsuccess = () => {
      try {
        if (!isWorkspace(request.result)) throw new Error('工作区尚未就绪，请稍后重试。')
        const workspace = ensureKnowledgeCards(request.result)
        if (values.some(value => !workspace.spaces.some(space => space.id === value.spaceId))) throw new Error('所选空间已不存在，请重新选择。')
        const receiptKey = `generated-cards:${batchId}`
        const receiptRequest = store.get(receiptKey)
        receiptRequest.onsuccess = () => {
          try {
            const receipt: Record<string, string> = receiptRequest.result ?? {}
            const cards = workspace.knowledgeCards ?? []
            const additions: KnowledgeCard[] = []
            const saved = values.map(value => {
              const draftId = value.generation.draftId
              if (Object.hasOwn(receipt, draftId)) {
                const existing = cards.find(card => card.id === receipt[draftId])
                if (!existing) throw new Error('该批次的卡片已删除，不能通过重试恢复。请关闭生成窗口。')
                return existing
              }
              const timestamp = new Date().toISOString()
              const card: KnowledgeCard = { ...value, id: crypto.randomUUID(), createdAt: timestamp, updatedAt: timestamp, version: 1, isDemo: false }
              receipt[draftId] = card.id
              additions.push(card)
              return card
            })
            if (additions.length) {
              store.put({ ...workspace, knowledgeCards: [...additions, ...cards] }, 'current')
              store.put(receipt, receiptKey)
            }
            done(saved)
          } catch (error) { fail(error) }
        }
      } catch (error) { fail(error) }
    }
  }))
}

export async function deleteKnowledgeCard(id: string): Promise<void> {
  if (!id || id.length > 128) throw new Error('卡片标识无效。')
  return enqueue(() => transaction<void>('readwrite', (store, done, fail) => {
    const request = store.get('current')
    request.onsuccess = () => {
      try {
        if (!isWorkspace(request.result)) throw new Error('工作区尚未就绪，请稍后重试。')
        const workspace = ensureKnowledgeCards(request.result)
        if (!workspace.knowledgeCards?.some(card => card.id === id)) throw new Error('卡片已不存在，请刷新列表。')
        store.put({ ...workspace, knowledgeCards: workspace.knowledgeCards.filter(card => card.id !== id) }, 'current')
        done(undefined)
      } catch (error) { fail(error) }
    }
  }))
}
