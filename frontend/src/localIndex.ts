import { ApiError, getIndexedDocument, saveIndexedDocument } from './api.ts'
import { alignDocumentVersion, sameDocumentContent } from './storage.ts'
import type { KnowledgeDocument, Space } from './types'

/** Freeze the caller's scope; identical content may adopt the server's newer version. */
export async function saveLocalCopies(documents: KnowledgeDocument[], spaces: Space[], signal: AbortSignal,
  onAligned?: (before: KnowledgeDocument, after: KnowledgeDocument) => void) {
  // Empty edits are valid browser documents, but cannot contribute evidence.
  // Exclude them from both uploads and the version allowlist so a previous
  // nonempty server version cannot silently answer for a now-empty document.
  const snapshot = structuredClone(documents.filter(document => document.status === 'available' && document.body.trim()))
  if (snapshot.length > 500) throw new Error('单次最多保存 500 份资料，请缩小范围。')
  const names = new Map(spaces.map(space => [space.id, space.name]))
  let saved = 0
  const synced: KnowledgeDocument[] = []
  for (const document of snapshot) {
    signal.throwIfAborted()
    const name = names.get(document.spaceId)
    if (!name) throw new Error('资料所属空间已不存在，请重新选择。')
    try {
      let current = document
      try { await saveIndexedDocument(document, name, signal) }
      catch (error) {
        if (!(error instanceof ApiError) || error.status !== 409 || signal.aborted) throw error
        // Read only after a conflict, and compare the full text instead of trusting
        // titles, hashes or version numbers alone. Deleted/cross-space rows stay blocked.
        const remote = await getIndexedDocument(document.id, signal)
        const candidate = { ...document, id: remote.id, spaceId: remote.space_id, title: remote.title,
          body: remote.body, fileName: remote.file_name, type: remote.type }
        if (remote.status !== 'indexed' || !Number.isSafeInteger(remote.version) || remote.version <= document.version
          || !sameDocumentContent(document, candidate)) {
          throw new Error('页面与本机保存的内容或所属空间不同，已保留两边内容；请核对资料后重试。')
        }
        current = await alignDocumentVersion(document, remote.version, signal)
        onAligned?.(document, current)
        // Recheck the accepted version. A concurrent server update/delete must
        // still stop this request before it can use an obsolete snapshot.
        signal.throwIfAborted()
        await saveIndexedDocument(current, name, signal)
      }
      synced.push(current)
    }
    catch (error) {
      if (signal.aborted) throw error
      throw new Error(`“${document.title}”未保存到本机：${error instanceof Error ? error.message : '请重试'}${saved ? `（此前 ${saved} 份已保存，重试不会重复创建。）` : ''}`)
    }
    saved += 1
  }
  signal.throwIfAborted()
  return { saved, versions: Object.fromEntries(synced.map(document => [document.id, document.version])), documents: synced }
}
