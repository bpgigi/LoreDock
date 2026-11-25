import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Compartment, EditorState } from '@codemirror/state'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { tablePreviewFocus, tablePreviewState } from '../src/components/markdownTables.ts'

const source = '## 排序\n\n| 写法 | 作用 |\n| :--- | ---: |\n| `a.sort()` | **修改**原列表 |\n| `sorted(a)` | 返回新列表 |\n\n后面的说明\n'
const create = (doc = source, extras = []) => EditorState.create({ doc, extensions: [markdown({ base: markdownLanguage }), tablePreviewState, ...extras] })
const blocks = state => {
  const result = []
  state.field(tablePreviewState).decorations.between(0, state.doc.length, (from, to) => result.push([from, to]))
  return result
}

test('real GFM table is a single preview block and keeps its exact Markdown source', () => {
  const state = create()
  assert.deepEqual(blocks(state), [[source.indexOf('| 写法'), source.indexOf('\n\n后面')]])
  assert.equal(state.doc.toString(), source)
})

test('editing or selecting a table reveals source, leaving it restores preview without rewriting content', () => {
  let state = create()
  state = state.update({ selection: { anchor: source.indexOf('a.sort') }, effects: tablePreviewFocus.of(true) }).state
  assert.deepEqual(blocks(state), [])
  state = state.update({ selection: { anchor: source.length } }).state
  assert.equal(blocks(state).length, 1)
  state = state.update({ selection: { anchor: 0, head: source.length } }).state
  assert.deepEqual(blocks(state), [])
  state = state.update({ effects: tablePreviewFocus.of(false) }).state
  assert.equal(blocks(state).length, 1)
  assert.equal(state.doc.toString(), source)
})

test('edits rebuild preview positions; source mode removes the preview without losing Markdown', () => {
  const mode = new Compartment()
  let state = EditorState.create({ doc: source, extensions: [markdown({ base: markdownLanguage }), mode.of(tablePreviewState)] })
  const position = source.indexOf('修改')
  state = state.update({ changes: { from: position, to: position + 2, insert: '直接修改' } }).state
  assert.equal(blocks(state)[0][1], source.indexOf('\n\n后面') + 2)
  const edited = state.doc.toString()
  state = state.update({ effects: mode.reconfigure([]) }).state
  assert.equal(state.field(tablePreviewState, false), undefined)
  assert.equal(state.doc.toString(), edited)
  state = state.update({ effects: mode.reconfigure(tablePreviewState) }).state
  assert.equal(blocks(state).length, 1)
  assert.equal(state.doc.toString(), edited)
})

test('pipe text inside code and HTML is not mistaken for an editable Markdown table', () => {
  const doc = '```text\n' + source + '```\n\n<div>\n| a | b |\n|---|---|\n</div>\n'
  const state = create(doc)
  assert.deepEqual(blocks(state), [])
  assert.equal(state.doc.toString(), doc)
})

test('switching to live preview with the cursor still in a table keeps that table editable', () => {
  const mode = new Compartment()
  let state = EditorState.create({ doc: source, selection: { anchor: source.indexOf('sorted') }, extensions: [markdown({ base: markdownLanguage }), mode.of([])] })
  state = state.update({ effects: [mode.reconfigure(tablePreviewState), tablePreviewFocus.of(true)] }).state
  assert.deepEqual(blocks(state), [])
  state = state.update({ effects: tablePreviewFocus.of(false) }).state
  assert.equal(blocks(state).length, 1)
  assert.equal(state.doc.toString(), source)
})
