import type { Conversation, KnowledgeCard, KnowledgeDocument, Space } from './types.ts'

export type SearchKind = 'document' | 'card' | 'conversation' | 'space'
type SearchItem =
  | { kind: 'document'; item: KnowledgeDocument }
  | { kind: 'card'; item: KnowledgeCard }
  | { kind: 'conversation'; item: Conversation }
  | { kind: 'space'; item: Space }
export type WorkspaceSearchResult = SearchItem & { key: string; title: string; detail: string; spaceName: string; score: number; updatedAt: string }
interface SearchData { spaces: Space[]; documents: KnowledgeDocument[]; knowledgeCards?: KnowledgeCard[]; conversations: Conversation[] }
const normalize = (value: string) => value.normalize('NFKC').toLocaleLowerCase().trim()

/** Local discovery only. Document bodies and model requests are not involved. */
export function searchWorkspace(data: SearchData, query: string): WorkspaceSearchResult[] {
  const phrase = normalize(query)
  const terms = phrase.split(/\s+/).filter(Boolean)
  const spaces = new Map(data.spaces.map(space => [space.id, space.name]))
  const results: WorkspaceSearchResult[] = []
  function add(entry: SearchItem, title: string, detail: string, spaceId: string, updatedAt: string, extra = '') {
    const spaceName = spaces.get(spaceId)
    if (!spaceName) return
    const name = normalize(title)
    const searchable = normalize(`${title} ${detail} ${spaceName} ${extra}`)
    if (!terms.every(term => searchable.includes(term))) return
    const score = phrase && name === phrase ? 3 : phrase && name.startsWith(phrase) ? 2 : phrase && name.includes(phrase) ? 1 : 0
    results.push({ ...entry, key: `${entry.kind}:${entry.item.id}`, title, detail, spaceName, score, updatedAt })
  }
  for (const doc of data.documents) add({ kind: 'document', item: doc }, doc.title, doc.fileName, doc.spaceId, doc.updatedAt)
  for (const card of data.knowledgeCards ?? []) add({ kind: 'card', item: card }, card.title, card.summary || card.tags.join(' · '), card.spaceId, card.updatedAt, card.tags.join(' '))
  for (const conversation of data.conversations) {
    if (conversation.documentId || !conversation.messages.length) continue
    const questions = conversation.messages.filter(message => message.role === 'user').map(message => message.body)
    const matched = phrase ? questions.find(question => terms.some(term => normalize(question).includes(term))) : undefined
    add({ kind: 'conversation', item: conversation }, conversation.title, matched ?? questions.at(-1) ?? '', conversation.spaceId, conversation.messages.at(-1)?.createdAt ?? conversation.createdAt, questions.join(' '))
  }
  for (const space of data.spaces) add({ kind: 'space', item: space }, space.name, space.description, space.id, '')
  return results.sort((a, b) => b.score - a.score || b.updatedAt.localeCompare(a.updatedAt) || a.title.localeCompare(b.title, 'zh-CN', { numeric: true }))
}
