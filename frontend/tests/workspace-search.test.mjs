import test from 'node:test'
import assert from 'node:assert/strict'
import { searchWorkspace } from '../src/workspaceSearch.ts'

const spaces = [{ id: 'python', name: 'Python 实践', description: '接口开发' }, { id: 'ai', name: 'AI 学习', description: '模型与检索' }]
const message = (body, date = '2026-11-14T00:00:00Z') => ({ role: 'user', body, createdAt: date })
const data = {
  spaces,
  documents: [
    { id: 'doc-1', spaceId: 'python', title: 'JSON 入门', fileName: 'json.md', body: '不检索这段正文', updatedAt: '2026-11-13' },
    { id: 'doc-2', spaceId: 'ai', title: '检索实践', fileName: 'rag.md', updatedAt: '2026-11-14' },
  ],
  knowledgeCards: [{ id: 'card-1', spaceId: 'python', title: 'json.loads', summary: '字符串转换为对象', tags: ['JSON', '反序列化'], updatedAt: '2026-11-12' }],
  conversations: Array.from({ length: 9 }, (_, index) => ({ id: `chat-${index}`, spaceId: 'python', title: `对话 ${index}`, createdAt: '2026-11-10', messages: [message(index === 8 ? '如何处理异常？' : '学习 Python')] })),
}

test('normalizes case, surrounding whitespace and full-width input across types', () => {
  const results = searchWorkspace(data, '  ＪＳＯＮ  ')
  assert.deepEqual(new Set(results.map(result => result.kind)), new Set(['document', 'card']))
  assert.equal(searchWorkspace(data, 'python').filter(result => result.kind === 'space').length, 1)
})
test('matches card summaries and tags and requires all search words', () => {
  assert.equal(searchWorkspace(data, '字符串 Python')[0].key, 'card:card-1')
  assert.equal(searchWorkspace(data, '反序列化')[0].kind, 'card')
  assert.equal(searchWorkspace(data, 'JSON 未知').length, 0)
  assert.equal(searchWorkspace(data, '不检索这段正文').length, 0)
})
test('finds old ordinary conversation by its question, excluding reading chats and removed spaces', () => {
  const extended = { ...data, conversations: [...data.conversations,
    { id: 'reader', spaceId: 'python', documentId: 'doc-1', title: '异常', messages: [message('异常')] },
    { id: 'deleted', spaceId: 'removed', title: '异常', messages: [message('异常')] },
  ] }
  const results = searchWorkspace(extended, '异常')
  assert.equal(results.length, 1)
  assert.equal(results[0].item.id, 'chat-8')
  assert.equal(results[0].detail, '如何处理异常？')
})
test('ranks exact titles ahead of fresh partial matches and preserves input order', () => {
  const before = structuredClone(data)
  const extended = { ...data, documents: [...data.documents, { ...data.documents[0], id: 'exact', title: 'JSON', updatedAt: '2026-01-01' }] }
  assert.equal(searchWorkspace(extended, 'json')[0].item.id, 'exact')
  searchWorkspace(data, '')
  assert.deepEqual(data, before)
  assert.equal(searchWorkspace(data, '').filter(result => result.kind === 'conversation').length, 9)
})
