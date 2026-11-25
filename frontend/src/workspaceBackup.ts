import type { WorkspaceData } from './storage.ts'
import { isReasoningEffort } from './reasoning.ts'

export type WorkspaceBackup = { format: 'loredock-workspace'; version: 1; exportedAt: string; records: { key: string; value: unknown }[] }
export const maximumBackupBytes = 128 * 1024 * 1024
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const string = (value: unknown): value is string => typeof value === 'string'
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(string)
const id = (value: unknown) => string(value) && value.length > 0 && value.length <= 128
const items = (value: unknown): value is Record<string, unknown>[] => Array.isArray(value) && value.every(object)
const validVersion = (value: unknown) => Number.isInteger(value) && Number(value) >= 1
const validCitation = (citation: Record<string, unknown>) => id(citation.id) && validVersion(citation.version)
  && ['title', 'heading', 'excerpt'].every(field => string(citation[field]))
  && (citation.cardId == null ? id(citation.documentId) : id(citation.cardId) && citation.documentId === '')
const validReadingSelection = (value: unknown, message: Record<string, unknown>) => value === undefined || object(value)
  && id(value.documentId) && value.documentId === message.documentId && id(value.spaceId) && strings(message.scopeIds) && message.scopeIds.includes(value.spaceId as string)
  && validVersion(value.version) && string(value.title) && value.title.length > 0 && value.title.length <= 240
  && string(value.heading) && value.heading.length <= 500 && string(value.text) && !!value.text.trim() && value.text.length <= 2000
  && string(value.context) && !!value.context.trim() && value.context.length <= 5000
  && ['isDraft', 'isHistorical', 'truncated'].every(field => typeof value[field] === 'boolean')

export function validateWorkspaceBackup(value: unknown): WorkspaceBackup {
  const invalid = () => { throw new Error('备份格式或数据关系不完整，未更改现有工作区。') }
  if (!object(value) || value.format !== 'loredock-workspace' || value.version !== 1 || !string(value.exportedAt) || !items(value.records)) return invalid()
  const records = value.records
  const keys = new Set<string>()
  for (const record of records) {
    if (!string(record.key) || record.key.length > 256 || keys.has(record.key) || !('value' in record)) return invalid()
    keys.add(record.key)
  }
  const data = records.find(record => record.key === 'current')?.value
  if (!object(data) || !items(data.spaces) || !items(data.documents) || !items(data.conversations) || !string(data.selectedSpaceId) || !string(data.selectedConversationId)) return invalid()
  const uniqueIds = (rows: Record<string, unknown>[]) => rows.every(row => id(row.id)) && new Set(rows.map(row => row.id)).size === rows.length
  if (![data.spaces, data.documents, data.conversations].every(uniqueIds)) return invalid()
  const spaces = new Set(data.spaces.map(space => space.id))
  if (!data.spaces.every(space => string(space.name) && string(space.description) && string(space.color) && ['code', 'sparkles', 'printer', 'game'].includes(String(space.icon)))) return invalid()
  if (!data.documents.every(doc => spaces.has(doc.spaceId) && ['title', 'fileName', 'body', 'heading', 'updatedAt'].every(field => string(doc[field])) && ['md', 'txt'].includes(String(doc.type)) && ['available', 'processing', 'failed'].includes(String(doc.status)) && validVersion(doc.version) && typeof doc.size === 'number' && typeof doc.isDemo === 'boolean')) return invalid()
  if (!data.conversations.every(conversation => spaces.has(conversation.spaceId) && string(conversation.title) && string(conversation.createdAt) && items(conversation.messages) && conversation.messages.every(message => id(message.id) && ['user', 'assistant'].includes(String(message.role)) && string(message.body) && strings(message.scopeIds) && ['completed', 'loading', 'error'].includes(String(message.status)) && string(message.createdAt) && items(message.citations) && message.citations.every(validCitation) && (message.matchedCards === undefined || items(message.matchedCards) && message.matchedCards.every(validCitation)) && (message.relatedCards === undefined || items(message.relatedCards) && message.relatedCards.every(card => id(card.cardId) && string(card.title) && string(card.summary))) && validReadingSelection(message.readingSelection, message)))) return invalid()
  if (data.knowledgeCards !== undefined && (!items(data.knowledgeCards) || !uniqueIds(data.knowledgeCards) || !data.knowledgeCards.every(card => spaces.has(card.spaceId) && ['title', 'summary', 'body', 'createdAt', 'updatedAt'].every(field => string(card[field])) && strings(card.tags) && validVersion(card.version)))) return invalid()
  for (const field of ['deletedDocumentIds', 'deletedSpaceIds', 'importedBatchIds']) if (data[field] !== undefined && !strings(data[field])) return invalid()
  if (data.aiPreference !== undefined && (!object(data.aiPreference) || !string(data.aiPreference.providerId) || !string(data.aiPreference.model))) return invalid()
  if (object(data.aiPreference) && data.aiPreference.reasoningByModel !== undefined) {
    const preferences = data.aiPreference.reasoningByModel
    if (!object(preferences) || Object.keys(preferences).length > 2000 || !Object.entries(preferences).every(([key, value]) => key.length > 0 && key.length <= 1024 && isReasoningEffort(value))) return invalid()
  }
  for (const record of records.filter(record => String(record.key).startsWith('draft:'))) {
    const draft = record.value
    if (!object(draft) || !id(draft.documentId) || record.key !== `draft:${draft.documentId}` || !string(draft.body) || !string(draft.updatedAt) || !validVersion(draft.baseVersion)) return invalid()
  }
  return value as unknown as WorkspaceBackup
}

export function backupSummary(backup: WorkspaceBackup) {
  const data = backup.records.find(record => record.key === 'current')!.value as WorkspaceData
  return { documents: data.documents.length, cards: data.knowledgeCards?.length ?? 0, conversations: data.conversations.length, drafts: backup.records.filter(record => record.key.startsWith('draft:')).length }
}
