export interface Space {
  id: string
  name: string
  description: string
  icon: 'code' | 'sparkles' | 'printer' | 'game'
  color: string
}

export interface KnowledgeDocument {
  id: string
  spaceId: string
  title: string
  fileName: string
  type: 'md' | 'txt'
  size: number
  updatedAt: string
  version: number
  /** Earlier local versions verified to have exactly the same saved content. */
  equivalentVersions?: number[]
  status: 'available' | 'processing' | 'failed'
  body: string
  heading: string
  isDemo: boolean
  failureReason?: string
  sourcePath?: string
  contentHash?: string
  originalHash?: string
  importBatchId?: string
  studyGroup?: string
  order?: number
}

export interface Citation {
  id: string
  documentId: string
  version: number
  title: string
  heading: string
  excerpt: string
  cardId?: string | null
  isAiDraft?: boolean
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  body: string
  scopeIds: string[]
  citations: Citation[]
  createdAt: string
  status: 'completed' | 'loading' | 'error'
  isDemo: boolean
  model?: string
  providerName?: string
  contextNote?: string
  documentId?: string
  contextKey?: string
  referenceDocuments?: boolean
  matchedCards?: Citation[]
  relatedCards?: RelatedCard[]
  readingSelection?: ReadingSelection
  reasoningEffort?: import('./reasoning').ReasoningSetting
}

/** The selected text and nearby source as it appeared when the user selected it. */
export interface ReadingSelection {
  documentId: string
  spaceId: string
  version: number
  title: string
  heading: string
  text: string
  context: string
  isDraft: boolean
  isHistorical: boolean
  truncated: boolean
}

/** Local links for browsing; never part of a model request or an answer citation. */
export interface RelatedCard {
  cardId: string
  title: string
  summary: string
}

export interface Conversation {
  id: string
  spaceId: string
  title: string
  messages: ChatMessage[]
  createdAt: string
  documentId?: string
  referenceDocuments?: boolean
}

export interface KnowledgeCardInput {
  spaceId: string
  title: string
  summary: string
  body: string
  tags: string[]
}

export interface KnowledgeCard extends KnowledgeCardInput {
  id: string
  createdAt: string
  updatedAt: string
  version: number
  isDemo?: boolean
  generation?: CardGeneration
}

export interface CardSource {
  id: string
  excerpt: string
  documentId?: string
  spaceId?: string
  title?: string
  heading?: string
  version?: number
  start?: number
  end?: number
  isDraft?: boolean
  isHistorical?: boolean
  sourcePath?: string
}
export interface GeneratedCardDraft {
  id: string
  title: string
  summary: string
  body: string
  tags: string[]
  sources: CardSource[]
}
export interface CardGeneration {
  batchId: string
  draftId: string
  providerName: string
  model: string
  generatedAt: string
  reasoningEffort?: import('./reasoning').ReasoningEffort
  sources: CardSource[]
}
export interface GeneratedKnowledgeCardInput extends KnowledgeCardInput {
  generation: CardGeneration
}
