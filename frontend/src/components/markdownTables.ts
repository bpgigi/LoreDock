import { syntaxTree } from '@codemirror/language'
import { StateEffect, StateField } from '@codemirror/state'
import type { EditorState, Range } from '@codemirror/state'
import type { SyntaxNode } from '@lezer/common'
import { Decoration, EditorView, WidgetType } from '@codemirror/view'
import type { DecorationSet } from '@codemirror/view'

export const tablePreviewFocus = StateEffect.define<boolean>()

type Inline = { text: string } | { tag: 'code' | 'strong' | 'em' | 's'; children: Inline[] }
type Cell = { position: number; content: Inline[] }
const inlineTags: Partial<Record<string, 'code' | 'strong' | 'em' | 's'>> = { InlineCode: 'code', StrongEmphasis: 'strong', Emphasis: 'em', Strikethrough: 's' }

function inlineContent(state: EditorState, node: SyntaxNode): Inline[] {
  const result: Inline[] = []
  let cursor = node.from
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.from > cursor) result.push({ text: state.sliceDoc(cursor, child.from).replace(/\\([\\|*`_])/g, '$1') })
    const tag = inlineTags[child.name]
    if (tag) result.push({ tag, children: inlineContent(state, child) })
    else if (!['CodeMark', 'EmphasisMark', 'StrikethroughMark'].includes(child.name)) result.push({ text: state.sliceDoc(child.from, child.to) })
    cursor = child.to
  }
  if (cursor < node.to) result.push({ text: state.sliceDoc(cursor, node.to).replace(/\\([\\|*`_])/g, '$1') })
  return result
}

function appendContent(element: HTMLElement, content: Inline[]) {
  for (const item of content) {
    if ('text' in item) element.append(document.createTextNode(item.text))
    else { const child = document.createElement(item.tag); appendContent(child, item.children); element.append(child) }
  }
}

class TableWidget extends WidgetType {
  readonly from: number
  readonly to: number
  readonly source: string
  readonly rows: Cell[][]
  readonly align: ('left' | 'right' | 'center')[]
  readonly readOnly: boolean
  constructor(from: number, to: number, source: string, rows: Cell[][], align: ('left' | 'right' | 'center')[], readOnly: boolean) {
    super()
    this.from = from; this.to = to; this.source = source
    this.rows = rows; this.align = align; this.readOnly = readOnly
  }
  eq(other: TableWidget) { return this.from === other.from && this.source === other.source && this.readOnly === other.readOnly }
  get estimatedHeight() { return this.rows.length * 42 + 24 }
  toDOM(view: EditorView) {
    const wrapper = document.createElement('div')
    wrapper.className = 'cm-md-table-preview'
    const table = document.createElement('table')
    table.setAttribute('aria-label', 'Markdown 表格预览')
    const edit = (position: number) => {
      if (view.state.readOnly || view.state.sliceDoc(this.from, this.to) !== this.source) return
      view.dispatch({ selection: { anchor: position }, effects: tablePreviewFocus.of(true) })
      view.focus()
    }
    if (!this.readOnly) {
      table.tabIndex = 0
      table.title = '点击表格编辑 Markdown'
      table.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); edit(this.from) } })
    }
    const head = document.createElement('thead'), body = document.createElement('tbody')
    this.rows.forEach((cells, rowIndex) => {
      const row = document.createElement('tr')
      for (let index = 0; index < this.rows[0].length; index++) {
        const cell = cells[index]
        const element = document.createElement(rowIndex ? 'td' : 'th')
        if (!rowIndex) element.setAttribute('scope', 'col')
        element.style.textAlign = this.align[index] ?? 'left'
        if (cell) appendContent(element, cell.content)
        if (!this.readOnly) {
          element.addEventListener('mousedown', event => event.preventDefault())
          element.addEventListener('click', () => edit(cell?.position ?? cells[0]?.position ?? this.from))
        }
        row.append(element)
      }
      ;(rowIndex ? body : head).append(row)
    })
    table.append(head, body)
    wrapper.append(table)
    return wrapper
  }
  ignoreEvent() { return true }
}

function tables(state: EditorState, focused: boolean): DecorationSet {
  const decorations: Range<Decoration>[] = []
  syntaxTree(state).iterate({ enter(node) {
    if (node.name !== 'Table') return
    if (focused && state.selection.ranges.some(range => range.from <= node.to && range.to >= node.from)) return false
    const rows: Cell[][] = []
    let align: ('left' | 'right' | 'center')[] = []
    for (let child = node.node.firstChild; child; child = child.nextSibling) {
      if (child.name === 'TableHeader' || child.name === 'TableRow') rows.push(child.getChildren('TableCell').map(cell => ({ position: cell.from, content: inlineContent(state, cell) })))
      if (child.name === 'TableDelimiter') align = state.sliceDoc(child.from, child.to).trim().replace(/^\||\|$/g, '').split('|').map(value => value.trim().endsWith(':') ? value.trim().startsWith(':') ? 'center' : 'right' : 'left')
    }
    if (rows[0]?.length) decorations.push(Decoration.replace({ block: true, widget: new TableWidget(node.from, node.to, state.sliceDoc(node.from, node.to), rows, align, state.readOnly) }).range(node.from, node.to))
    return false
  } })
  return Decoration.set(decorations, true)
}

// Block replacements must come from a StateField (not a viewport ViewPlugin).
export const tablePreviewState = StateField.define<{ focused: boolean; decorations: DecorationSet }>({
  create: state => ({ focused: false, decorations: tables(state, false) }),
  update(value, transaction) {
    let focused = value.focused
    for (const effect of transaction.effects) if (effect.is(tablePreviewFocus)) focused = effect.value
    if (transaction.docChanged || transaction.selection || focused !== value.focused || transaction.startState.readOnly !== transaction.state.readOnly || syntaxTree(transaction.startState) !== syntaxTree(transaction.state)) {
      return { focused, decorations: tables(transaction.state, focused) }
    }
    return value
  },
  provide: field => EditorView.decorations.from(field, value => value.decorations),
})

export const tablePreview = [tablePreviewState, EditorView.domEventHandlers({
  focus: (_event, view) => { view.dispatch({ effects: tablePreviewFocus.of(true) }); return false },
  blur: (_event, view) => { view.dispatch({ effects: tablePreviewFocus.of(false) }); return false },
})]
