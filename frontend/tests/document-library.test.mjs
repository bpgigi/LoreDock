import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sortLibraryDocuments } from '../src/documentLibrary.ts'

const doc = (id, overrides = {}) => ({ id, title: id, fileName: `${id}.md`, updatedAt: '2026-11-01T10:00:00Z', ...overrides })
const ids = values => values.map(value => value.id)

test('chapter order survives later edits and leaves the workspace array untouched', () => {
  const documents = [doc('later', { order: 10, updatedAt: '2026-11-14T10:00:00Z' }), doc('first', { order: 1 }), doc('second', { order: 2 }), doc('loose')]
  const snapshot = structuredClone(documents)
  assert.deepEqual(ids(sortLibraryDocuments(documents, 'order')), ['first', 'second', 'later', 'loose'])
  assert.deepEqual(ids(sortLibraryDocuments(documents, 'updated-desc')), ['later', 'first', 'second', 'loose'])
  assert.deepEqual(documents, snapshot)
})

test('name order handles numbered notes naturally and ignores unrelated chapter metadata', () => {
  const documents = [doc('第10篇', { order: 1 }), doc('第2篇', { order: 99 }), doc('第1篇')]
  assert.deepEqual(ids(sortLibraryDocuments(documents, 'title')), ['第1篇', '第2篇', '第10篇'])
})

test('both time directions leave unknown dates last with a deterministic fallback', () => {
  const documents = [doc('unknown', { updatedAt: 'invalid' }), doc('old'), doc('new', { updatedAt: '2026-11-14T10:00:00Z' })]
  assert.deepEqual(ids(sortLibraryDocuments(documents, 'updated-desc')), ['new', 'old', 'unknown'])
  assert.deepEqual(ids(sortLibraryDocuments(documents, 'updated-asc')), ['old', 'new', 'unknown'])
})
