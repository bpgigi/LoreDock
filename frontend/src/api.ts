export interface ProviderProfile {
  id: string
  name: string
  base_url: string
  default_model: string
  has_api_key: boolean
  key_hint: string
}

export interface ProviderInput {
  name: string
  base_url: string
  default_model: string
  api_key?: string
  clear_api_key?: boolean
}

export interface ChatRequest {
  session_id: string
  request_id: string
  provider_id: string
  model: string
  question: string
  scope_ids: string[]
  document_id?: string
  documents: { id: string; space_id: string; title: string; body: string; version: number; heading: string }[]
  history: { role: 'user' | 'assistant'; content: string }[]
  answer_mode?: 'assistant' | 'grounded'
  retrieval_mode?: 'none' | 'snapshot' | 'indexed'
  document_versions?: Record<string, number>
  reading_selection?: import('./types').ReadingSelection
  reasoning_effort?: import('./reasoning').ReasoningEffort
}

export interface ChatResponse {
  session_id: string
  request_id: string
  body: string
  citations: import('./types').Citation[]
  model: string
  provider_name: string
  context_note: string
}

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  let response: Response
  try { response = await fetch(`/api${path}`, { ...options, headers: { 'Content-Type': 'application/json', ...options?.headers } }) }
  catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    throw new Error('无法连接本地服务，请先启动后端。')
  }
  if (!response.ok) {
    let detail = '请求没有完成，请重试。'
    try { const body = await response.json(); if (typeof body.detail === 'string') detail = body.detail } catch { /* Proxy errors are not API responses. */ }
    throw new ApiError(response.status, response.status === 502 && detail === '请求没有完成，请重试。' ? '后端尚未启动，请先启动本地服务。' : detail)
  }
  return response.json() as Promise<T>
}

export const getProviders = () => request<{ providers: ProviderProfile[] }>('/providers')
export const saveProvider = (id: string, input: ProviderInput) => request<ProviderProfile>(`/providers/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(input) })
export const deleteProvider = (id: string) => request<{ ok: boolean }>(`/providers/${encodeURIComponent(id)}`, { method: 'DELETE' })
export const getModels = (id: string) => request<{ models: string[] }>(`/providers/${encodeURIComponent(id)}/models`, { method: 'POST', body: '{}' })
export const askModel = (payload: ChatRequest, signal: AbortSignal) => request<ChatResponse>('/chat', { method: 'POST', body: JSON.stringify(payload), signal })

export interface CardGenerationRequest {
  session_id: string
  request_id: string
  provider_id: string
  model: string
  text: string
  count: number
  instructions: string
  reasoning_effort?: import('./reasoning').ReasoningEffort
}
export interface CardGenerationResponse {
  session_id: string
  request_id: string
  model: string
  provider_name: string
  reasoning_effort?: import('./reasoning').ReasoningEffort | null
  cards: import('./types').GeneratedCardDraft[]
  usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null
}
export const generateCardDrafts = (payload: CardGenerationRequest, signal: AbortSignal) =>
  request<CardGenerationResponse>('/cards/generate', { method: 'POST', body: JSON.stringify(payload), signal })

export interface CardRevisionRequest extends Pick<CardGenerationRequest, 'session_id' | 'request_id' | 'provider_id' | 'model' | 'reasoning_effort'> {
  revision: number
  instructions: string
  drafts: (import('./types').GeneratedCardDraft & { ordinal: number })[]
}
export interface CardRevisionResponse extends Omit<CardGenerationResponse, 'cards'> {
  revision: number
  operations: { target_ids: string[]; card: import('./types').GeneratedCardDraft }[]
}
export const reviseCardDrafts = (payload: CardRevisionRequest, signal: AbortSignal) =>
  request<CardRevisionResponse>('/cards/revise', { method: 'POST', body: JSON.stringify(payload), signal })

export interface NoteImportSummary {
  id: string
  title: string
  count: number
  source_sha256: string
}

export interface NoteImportBundle extends NoteImportSummary {
  space: import('./types').Space
  documents: import('./types').KnowledgeDocument[]
  excluded: string[]
}

export const listNoteImports = () => request<{ imports: NoteImportSummary[] }>('/note-imports')
export const getNoteImport = (id: string) => request<NoteImportBundle>(`/note-imports/${encodeURIComponent(id)}`)

export interface IndexedDocumentSummary {
  id: string
  space_id: string
  title: string
  version: number
  content_hash: string
  chunk_count: number
}

export interface IndexedDocument extends IndexedDocumentSummary {
  body: string
  file_name: string
  type: 'md' | 'txt'
  status: 'indexed'
}

export const getIndexedDocument = (id: string, signal: AbortSignal) =>
  request<IndexedDocument>(`/library/documents/${encodeURIComponent(id)}`, { signal })

export const saveIndexedDocument = (document: import('./types').KnowledgeDocument, spaceName: string, signal: AbortSignal) =>
  request<IndexedDocumentSummary>(`/library/documents/${encodeURIComponent(document.id)}`, {
    method: 'PUT', signal, body: JSON.stringify({ id: document.id, space_id: document.spaceId,
      title: document.title, body: document.body, version: document.version,
      file_name: document.fileName, type: document.type, space_name: spaceName }),
  })

export const searchIndexedDocuments = (question: string, scopeIds: string[], versions: Record<string, number>, signal: AbortSignal) =>
  request<{ citations: import('./types').Citation[]; context_note: string }>('/library/search', {
    method: 'POST', signal, body: JSON.stringify({ question, scope_ids: scopeIds, document_versions: versions }),
  })

export const retireIndexedDocuments = (ids: string[]) => request<{ retired: number }>('/library/retire', {
  method: 'POST', body: JSON.stringify({ document_ids: ids }),
})
