import type { ChatRequest } from './api'
import type { Citation, KnowledgeCard, KnowledgeDocument, RelatedCard } from './types'

const normalize = (text: string) => text.normalize('NFKC').toLowerCase()
const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function termsFromQuestion(question: string) {
  const text = normalize(question).replace(/请问|请帮我|帮我|请|解释一下|解释|介绍一下|介绍|什么是|是什么|为什么|怎么样|怎么|如何|哪些|这个|那个|一下|知识卡片|卡片|资料|文档|可以|有关|关于|区别|的|与|和|了|呢|吗/g, ' ')
  const latin = [...text.matchAll(/[a-z0-9_]+(?:\.[a-z0-9_]+)*/g)].map(match => match[0]).filter(term => term.length > 1 && !['what', 'how', 'the', 'is', 'are', 'to', 'a', 'an', 'of', 'and', 'please'].includes(term))
  const chinese = [...text.matchAll(/[\u4e00-\u9fff]{2,}/g)].flatMap(match => Array.from({ length: match[0].length - 1 }, (_, i) => match[0].slice(i, i + 2)))
  return [...new Set([...latin, ...chinese])]
}

function containsTerm(text: string, term: string) {
  return /[a-z0-9_]/.test(term) ? new RegExp(`(^|[^a-z0-9_])${escapeRegex(term)}(?![a-z0-9_])`).test(text) : text.includes(term)
}

/** Local suggestions only. Return links, never card bodies or model context. */
export function matchKnowledgeCards(cards: KnowledgeCard[], scopeIds: string[], question: string): RelatedCard[] {
  const terms = termsFromQuestion(question)
  if (!terms.length) return []
  const latinTerms = terms.filter(term => /[a-z0-9_]/.test(term))
  const technicalTerms = latinTerms.filter(term => !['python', 'javascript', 'typescript', 'java', 'json', 'sql', 'ai'].includes(term))
  const chineseTerms = terms.filter(term => !/[a-z0-9_]/.test(term))
  const ranked = cards.filter(card => scopeIds.includes(card.spaceId)).map(card => {
    const title = normalize(`${card.title} ${card.tags.join(' ')}`)
    const summary = normalize(card.summary)
    const body = normalize(card.body)
    const hits = terms.filter(term => containsTerm(`${title}\n${summary}\n${body}`, term))
    const chineseHits = hits.filter(term => chineseTerms.includes(term))
    const prominent = chineseHits.some(term => containsTerm(`${title}\n${summary}`, term))
    // A named API/framework must actually match: generic words such as
    // "异常处理" must not make a JSON card win a question about FastAPI.
    const relevant = technicalTerms.length ? technicalTerms.some(term => hits.includes(term))
      : chineseTerms.length ? prominent || (chineseHits.length >= 2 && chineseHits.length / chineseTerms.length >= 0.5)
        : latinTerms.some(term => hits.includes(term))
    const score = hits.reduce((total, term) => total + (containsTerm(title, term) ? 5 : 0) + (containsTerm(summary, term) ? 3 : 0) + (containsTerm(body, term) ? 1 : 0), 0)
    return { card, score: relevant ? score : 0, hits }
  }).filter(item => item.score > 0).sort((a, b) => b.score - a.score)
  return ranked.slice(0, 4).map(({ card }) => ({ cardId: card.id, title: card.title, summary: card.summary.slice(0, 160) }))
}

export function planChatContext(input: {
  scopeIds: string[]; documents: KnowledgeDocument[]
  referenceDocuments: boolean; documentId?: string; historical?: Citation | null
}) {
  const { scopeIds, documentId, historical, referenceDocuments } = input
  const documents = referenceDocuments ? input.documents.filter(item => item.status === 'available' && scopeIds.includes(item.spaceId) && (!documentId || item.id === documentId)).map(item => historical?.documentId === item.id ? { ...item, body: historical.excerpt, version: historical.version, title: historical.title, heading: historical.heading } : item) : []
  // New generation isolates old conversations that used cards as answer evidence.
  // Card edits and changing suggestion hits cannot change the AI's conversation.
  const contextKey = JSON.stringify(['assistant-local-links-v2', referenceDocuments, documents.map(item => `${item.id}:${item.version}`).sort(), referenceDocuments ? historical?.id ?? '' : ''])
  const retrievalMode: NonNullable<ChatRequest['retrieval_mode']> = !referenceDocuments ? 'none' : documentId ? 'snapshot' : 'indexed'
  return { documents, retrievalMode, contextKey }
}
