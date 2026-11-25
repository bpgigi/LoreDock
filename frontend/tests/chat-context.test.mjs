import assert from 'node:assert/strict'
import { test } from 'node:test'
import { matchKnowledgeCards, planChatContext } from '../src/chatContext.ts'

const card = (id, overrides = {}) => ({ id, spaceId: 'python', title: 'json.loads', summary: '解析 JSON 字符串', tags: [], body: 'json.loads(text) 返回 Python 对象。', version: 1, createdAt: 'date', updatedAt: 'date', ...overrides })
const document = { id: 'doc', spaceId: 'python', title: '资料', body: 'DOC-BODY', status: 'available', version: 2 }
const plan = (overrides = {}) => planChatContext({ scopeIds: ['python'], documents: [document], referenceDocuments: false, ...overrides })

test('ordinary AI needs no documents and never schedules document sync', () => {
  const value = plan()
  assert.equal(value.retrievalMode, 'none')
  assert.deepEqual(value.documents, [])
  assert.equal('cards' in value, false)
  assert.ok(!value.contextKey.includes('doc:2'))
})

test('local card links exclude other spaces and do not replace optional document lookup', () => {
  const links = matchKnowledgeCards([card('other', { spaceId: 'private', title: 'private json.loads', body: 'DO-NOT-SEND' }), card('a', { body: 'LOCAL-CARD-BODY' })], ['python'], 'json.loads')
  assert.deepEqual(links.map(item => item.cardId), ['a'])
  assert.ok(!JSON.stringify(links).includes('DO-NOT-SEND'))
  assert.ok(!JSON.stringify(links).includes('LOCAL-CARD-BODY'))
  const value = plan({ referenceDocuments: true })
  assert.equal(value.retrievalMode, 'indexed')
  assert.deepEqual(value.documents, [document])
  assert.equal('cards' in value, false)
  assert.equal('relatedCards' in value, false)
})

test('explicit reference mode alone controls indexed or reader context', () => {
  assert.equal(plan({ referenceDocuments: true }).retrievalMode, 'indexed')
  const reading = plan({ referenceDocuments: true, documentId: 'doc', historical: { documentId: 'doc', id: 'old', excerpt: 'OLD-EXCERPT', version: 1, title: '历史', heading: '节选' } })
  assert.equal(reading.retrievalMode, 'snapshot')
  assert.equal(reading.documents[0].body, 'OLD-EXCERPT')
  assert.equal(reading.documents[0].version, 1)
})

test('matching handles Chinese topics, distinct technical names and ordinary nonmatches', () => {
  const cards = [card('load', { title: 'json.load', summary: '', body: 'json.load(fp) 读取文件' }), card('loads'), card('txn', { title: '数据库事务', body: '提交与回滚', summary: '' })]
  assert.deepEqual(matchKnowledgeCards(cards, ['python'], 'json.load 是什么').map(item => item.cardId), ['load'])
  assert.deepEqual(matchKnowledgeCards(cards, ['python'], '数据库事务如何回滚').map(item => item.cardId), ['txn'])
  assert.deepEqual(matchKnowledgeCards(cards, ['python'], '你好，请帮我解释一下'), [])
  assert.deepEqual(matchKnowledgeCards(cards, ['python'], '介绍光合作用'), [])
  const generic = [card('json', { tags: ['Python', 'JSON'], body: 'JSON 格式错误时会抛出异常，应根据实际业务处理。' })]
  assert.deepEqual(matchKnowledgeCards(generic, ['python'], 'FastAPI 异常处理'), [])
  assert.deepEqual(matchKnowledgeCards(generic, ['python'], 'Python 数据库事务'), [])
})

test('body matching returns at most four small local links, never copies source bodies', () => {
  const cards = Array.from({ length: 10 }, (_, i) => card(`c${i}`, { title: '长卡片', summary: '记法'.repeat(200), body: `${'x'.repeat(10000)}\nneedle_token 有关说明\n${'y'.repeat(10000)}`, generation: {} }))
  const results = matchKnowledgeCards(cards, ['python'], 'needle_token')
  assert.ok(results.length > 0 && results.length <= 4)
  assert.ok(results.every(item => !('body' in item) && item.summary.length <= 160))
  assert.ok(!JSON.stringify(results).includes('needle_token'))
})

test('history is isolated from the old card-grounded mode and follows only selected documents', () => {
  assert.notEqual(JSON.parse(plan().contextKey)[0], 'assistant')
  assert.notEqual(plan().contextKey, plan({ referenceDocuments: true }).contextKey)
  assert.equal(plan().contextKey, plan({ documents: [{ ...document, version: 3 }] }).contextKey)
  assert.notEqual(plan({ referenceDocuments: true }).contextKey, plan({ referenceDocuments: true, documents: [{ ...document, version: 3 }] }).contextKey)
})
