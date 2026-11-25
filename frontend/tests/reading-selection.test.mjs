import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createReadingSelection, readingHeadings, readingHistoryContent, resolveReadingRange } from '../src/readingSelection.ts'

const identity = { documentId: 'doc', spaceId: 'python', version: 2, title: '学习笔记', isDraft: false, isHistorical: false }
const select = (body, text, from = body.indexOf(text), extra = {}) => createReadingSelection({ ...identity, body, text, from, to: from + text.length, ...extra })

test('short phrase carries its own paragraph and chapter, not an earlier duplicate', () => {
  const body = '# 字典\n\n## 概览\n\n槽位用于定位。\n\n## 查询\n\n先计算哈希，然后找到槽位。\n\n最后比较 key。\n\n## 无关章节\n\nDO-NOT-INCLUDE'
  const range = resolveReadingRange(body, '槽位', body.indexOf('先计算'), body.indexOf('最后'))
  const value = createReadingSelection({ ...identity, body, text: '槽位', ...range })
  assert.equal(value.heading, '字典 / 查询')
  assert.match(value.context, /先计算哈希/)
  assert.match(value.context, /最后比较 key/)
  assert.doesNotMatch(value.context, /DO-NOT-INCLUDE|槽位用于定位/)
  assert.equal(value.text, '槽位')
})

test('source, rendered formatting, code and setext headings keep bounded snapshots', () => {
  const body = '# Python\n\n字典查询\n--------\n\n这里的 **索引** 与 `key` 有关。\n\n```python\n# 这不是章节\nx = table[key]\n```'
  const range = resolveReadingRange(body, '索引 与 key', body.indexOf('这里'), body.indexOf('```'))
  const rendered = createReadingSelection({ ...identity, body, text: '索引 与 key', ...range })
  assert.equal(rendered.heading, 'Python / 字典查询')
  assert.match(rendered.context, /\*\*索引\*\*/)
  assert.deepEqual(readingHeadings(body).map(item => item.text), ['Python', '字典查询'])
  const code = select(body, 'table[key]')
  assert.equal(code.heading, 'Python / 字典查询')
  assert.match(code.context, /x = table\[key\]/)
})

test('huge selections and paragraphs are bounded, while draft/history identity stays explicit', () => {
  const body = `# 长文\n${'a'.repeat(10000)}selected${'b'.repeat(10000)}`
  const value = select(body, body.slice(9500), 9500, { isDraft: true, isHistorical: true })
  assert.equal(value.text.length, 2000)
  assert.ok(value.context.length <= 5000)
  assert.match(value.context, /selected/)
  assert.equal(value.truncated, true)
  assert.equal(value.version, 2)
  assert.equal(value.isDraft, true)
  assert.equal(value.isHistorical, true)
  assert.equal(select(body, '  '), undefined)
})

test('follow-up history includes the quoted snapshot, stays valid JSON and excludes local card fields', () => {
  const selection = select('## 第一段\n\n被选文字\n\n附近上下文', '被选文字')
  const message = { ...selection, relatedCards: [{ title: 'LOCAL-ONLY' }] }
  // Unknown fields retained by old/new backup versions must not enter model history.
  const history = readingHistoryContent('这是什么意思', message)
  assert.deepEqual(JSON.parse(history).reading_selection, selection)
  assert.doesNotMatch(history, /LOCAL-ONLY/)
  const large = readingHistoryContent('q'.repeat(4000), { ...selection, text: 't'.repeat(2000), context: '\n"'.repeat(2500) })
  assert.ok(large.length <= 8000)
  assert.equal(JSON.parse(large).question.length, 4000)
  assert.equal(readingHistoryContent('继续解释'), '继续解释')
})

test('clipping selection and context never splits an emoji surrogate pair', () => {
  const value = select('a' + '😀'.repeat(6000), 'a' + '😀'.repeat(6000))
  assert.ok(value.text.isWellFormed())
  assert.ok(value.context.isWellFormed())
  assert.ok(value.text.length <= 2000)
})
