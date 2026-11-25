import type { NoteImportBundle } from './api'
import type { WorkspaceData } from './storage'

export function importBatchKey(bundle: Pick<NoteImportBundle, 'id' | 'source_sha256'>) {
  return `${bundle.id}:${bundle.source_sha256}`
}

/** Add a batch once, preserving existing edits, conversations, and preferences. */
export function mergeNoteImport(current: WorkspaceData, bundle: NoteImportBundle) {
  const key = importBatchKey(bundle)
  if (current.importedBatchIds?.includes(key)) return { workspace: current, added: 0, skipped: bundle.documents.length }
  const ids = new Set(current.documents.map(item => item.id))
  const sources = new Set(current.documents.filter(item => item.importBatchId === bundle.id).map(item => item.sourcePath))
  const incoming = bundle.documents.filter(item => !ids.has(item.id) && !sources.has(item.sourcePath))
  return {
    workspace: {
      ...current,
      spaces: current.spaces.some(item => item.id === bundle.space.id) ? current.spaces : [...current.spaces, bundle.space],
      documents: [...incoming, ...current.documents],
      importedBatchIds: [...(current.importedBatchIds ?? []), key],
    },
    added: incoming.length,
    skipped: bundle.documents.length - incoming.length,
  }
}
