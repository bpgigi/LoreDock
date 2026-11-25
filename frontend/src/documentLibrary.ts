import type { KnowledgeDocument } from './types'

export type DocumentSort = 'updated-desc' | 'updated-asc' | 'title' | 'order'

const titleOrder = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' })
const sequence = (document: KnowledgeDocument) => Number.isFinite(document.order) ? document.order! : Infinity

/** Returns a display order without changing the workspace's document array. */
export function sortLibraryDocuments(documents: KnowledgeDocument[], sort: DocumentSort): KnowledgeDocument[] {
  return [...documents].sort((a, b) => {
    if (sort === 'updated-desc' || sort === 'updated-asc') {
      const aTime = Date.parse(a.updatedAt)
      const bTime = Date.parse(b.updatedAt)
      // Unknown timestamps stay at the end in either direction.
      if (Number.isFinite(aTime) !== Number.isFinite(bTime)) return Number.isFinite(aTime) ? -1 : 1
      const dateOrder = aTime - bTime
      if (Number.isFinite(dateOrder) && dateOrder) return sort === 'updated-asc' ? dateOrder : -dateOrder
    }
    if (sort !== 'title') {
      const aOrder = sequence(a)
      const bOrder = sequence(b)
      if (aOrder !== bOrder) return aOrder < bOrder ? -1 : 1
    }
    return titleOrder.compare(a.title, b.title) || titleOrder.compare(a.fileName, b.fileName)
  })
}
