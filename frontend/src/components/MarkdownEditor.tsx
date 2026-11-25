import { useEffect, useRef } from 'react'
import { basicSetup } from 'codemirror'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { HighlightStyle, syntaxHighlighting, syntaxTree } from '@codemirror/language'
import { Compartment, EditorState, Prec, StateEffect, Transaction } from '@codemirror/state'
import type { Range } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, WidgetType, keymap, placeholder } from '@codemirror/view'
import type { DecorationSet, ViewUpdate } from '@codemirror/view'
import { indentWithTab } from '@codemirror/commands'
import { tags } from '@lezer/highlight'
import { tablePreview, tablePreviewFocus } from './markdownTables'
import type { SourceSelection } from '../readingSelection'
import './MarkdownEditor.css'

export interface MarkdownEditorProps {
  value: string
  onChange: (value: string) => void
  mode: 'live' | 'source'
  onSave: () => void
  onToggleMode: () => void
  onSelectionChange?: (text: string, source: SourceSelection) => void
  onCursorChange?: (line: number, column: number) => void
  readOnly?: boolean
  fontSize?: number
  focusToken?: number
  focusLine?: number
  inputId?: string
  ariaLabel?: string
  required?: boolean
  placeholder?: string
  previewTables?: boolean
  clearSelectionKey?: number
}

const refreshPreview = StateEffect.define<null>()
const externalValue = Transaction.addToHistory.of(false)
const hiddenMarkup = Decoration.replace({ inclusive: false })

const monochromeHighlighting = HighlightStyle.define([
  { tag: tags.heading, class: 'cm-md-heading-text' },
  { tag: tags.processingInstruction, class: 'cm-md-syntax' },
  { tag: tags.strong, class: 'cm-md-strong' },
  { tag: tags.emphasis, class: 'cm-md-emphasis' },
  { tag: tags.strikethrough, class: 'cm-md-strikethrough' },
  { tag: tags.monospace, class: 'cm-md-code-text' },
  { tag: tags.link, class: 'cm-md-link' },
  { tag: tags.url, class: 'cm-md-url' },
  { tag: tags.quote, class: 'cm-md-quote-text' },
  { tag: tags.contentSeparator, class: 'cm-md-syntax' },
  { tag: tags.labelName, class: 'cm-md-code-info' },
])

class BulletWidget extends WidgetType {
  toDOM() {
    const bullet = document.createElement('span')
    bullet.className = 'cm-md-bullet'
    bullet.textContent = '•'
    bullet.setAttribute('aria-hidden', 'true')
    return bullet
  }
  ignoreEvent() { return false }
}

class TaskWidget extends WidgetType {
  constructor(readonly position: number, readonly checked: boolean) { super() }
  eq(other: TaskWidget) { return other.position === this.position && other.checked === this.checked }
  toDOM(view: EditorView) {
    const checkbox = document.createElement('input')
    checkbox.type = 'checkbox'
    checkbox.checked = this.checked
    checkbox.className = 'cm-md-task-checkbox'
    checkbox.disabled = view.state.readOnly
    checkbox.setAttribute('aria-label', this.checked ? '标记任务为未完成' : '标记任务为完成')
    checkbox.addEventListener('mousedown', event => event.preventDefault())
    checkbox.addEventListener('click', event => {
      event.preventDefault()
      if (view.state.readOnly) return
      const original = view.state.doc.sliceString(this.position, this.position + 3)
      // A stale widget must never edit text that has moved or changed type.
      if (!/^\[[ xX]\]$/.test(original)) return
      view.dispatch({
        changes: { from: this.position, to: this.position + 3, insert: /[xX]/.test(original) ? '[ ]' : '[x]' },
        annotations: Transaction.userEvent.of('input'),
      })
    })
    return checkbox
  }
}

function liveDecorations(view: EditorView): DecorationSet {
  const { state } = view
  const decorations: Range<Decoration>[] = []
  const lineClasses = new Map<number, Set<string>>()
  const focusedLines = view.hasFocus ? state.selection.ranges.map(range => ({
    from: state.doc.lineAt(range.from).from,
    to: state.doc.lineAt(range.to).to,
  })) : []
  const touchesSelection = (from: number, to: number) => focusedLines.some(range => from <= range.to && to >= range.from)
  const addLine = (position: number, name: string) => {
    const line = state.doc.lineAt(position)
    if (line.to < view.viewport.from || line.from > view.viewport.to) return
    const classes = lineClasses.get(line.from) ?? new Set<string>()
    classes.add(name)
    lineClasses.set(line.from, classes)
  }
  const hide = (from: number, to: number) => {
    // All replacements are inline. Never replace newlines or source data.
    if (to > from && state.doc.lineAt(from).number === state.doc.lineAt(to - 1).number) decorations.push(hiddenMarkup.range(from, to))
  }
  const hidePrefix = (from: number, to: number) => {
    const following = state.doc.sliceString(to, to + 1)
    hide(from, following === ' ' ? to + 1 : to)
  }

  syntaxTree(state).iterate({
    from: view.viewport.from,
    to: view.viewport.to,
    enter(node) {
      const { name, from, to } = node
      const parent = node.node.parent
      // Images and raw HTML stay literal text. This editor never creates remote resources.
      if (name === 'Image' || name === 'HTMLBlock' || name === 'HTMLTag') return false
      const heading = /^(?:ATX|Setext)Heading([1-6])$/.exec(name)
      if (heading) addLine(from, `cm-md-heading-${heading[1]}`)
      if (name === 'FencedCode' || name === 'CodeBlock') {
        const first = state.doc.lineAt(Math.max(from, view.viewport.from)).number
        const last = state.doc.lineAt(Math.min(Math.max(from, to - 1), view.viewport.to)).number
        for (let number = first; number <= last; number += 1) addLine(state.doc.line(number).from, 'cm-md-code-line')
        if (name === 'FencedCode') {
          addLine(from, 'cm-md-code-start')
          addLine(Math.max(from, to - 1), 'cm-md-code-end')
        }
      }
      if (name === 'QuoteMark') {
        addLine(from, 'cm-md-quote-line')
        if (!touchesSelection(from, to)) hidePrefix(from, to)
      }
      if (name === 'HeaderMark' && !touchesSelection(from, to)) hidePrefix(from, to)
      if (name === 'StrongEmphasis') decorations.push(Decoration.mark({ class: 'cm-md-strong' }).range(from, to))
      if (name === 'Emphasis') decorations.push(Decoration.mark({ class: 'cm-md-emphasis' }).range(from, to))
      if (name === 'Strikethrough') decorations.push(Decoration.mark({ class: 'cm-md-strikethrough' }).range(from, to))
      if (name === 'InlineCode') decorations.push(Decoration.mark({ class: 'cm-md-inline-code' }).range(from, to))
      if ((name === 'EmphasisMark' || name === 'StrikethroughMark') && parent && !touchesSelection(parent.from, parent.to)) hide(from, to)
      if (name === 'CodeMark' && parent && !touchesSelection(parent.from, parent.to)) hide(from, to)
      if (name === 'ListMark' && parent?.parent?.name === 'BulletList' && !touchesSelection(from, to)) {
        decorations.push(Decoration.replace({ widget: new BulletWidget(), inclusive: false }).range(from, to))
      }
      if (name === 'TaskMarker' && !touchesSelection(from, to)) {
        decorations.push(Decoration.replace({ widget: new TaskWidget(from, /[xX]/.test(state.doc.sliceString(from, to))), inclusive: false }).range(from, to))
      }
      if (name === 'Link' && !touchesSelection(from, to) && state.doc.lineAt(from).number === state.doc.lineAt(to - 1).number) {
        const children = []
        for (let child = node.node.firstChild; child; child = child.nextSibling) children.push(child)
        const opening = children.find(child => child.name === 'LinkMark' && state.doc.sliceString(child.from, child.to) === '[')
        const closing = children.find(child => child.name === 'LinkMark' && state.doc.sliceString(child.from, child.to) === ']')
        if (opening && closing) {
          hide(opening.from, opening.to)
          hide(closing.from, to)
          if (opening.to < closing.from) decorations.push(Decoration.mark({ class: 'cm-md-link' }).range(opening.to, closing.from))
        }
      }
    },
  })
  for (const [from, classes] of lineClasses) decorations.push(Decoration.line({ class: [...classes].join(' ') }).range(from))
  return Decoration.set(decorations, true)
}

const livePreview = ViewPlugin.fromClass(class {
  decorations: DecorationSet
  constructor(view: EditorView) { this.decorations = liveDecorations(view) }
  update(update: ViewUpdate) {
    if (update.view.composing) {
      this.decorations = this.decorations.map(update.changes)
      return
    }
    if (update.docChanged || update.selectionSet || update.viewportChanged || update.focusChanged ||
        syntaxTree(update.startState) !== syntaxTree(update.state) ||
        update.transactions.some(transaction => transaction.effects.some(effect => effect.is(refreshPreview)))) {
      this.decorations = liveDecorations(update.view)
    }
  }
}, { decorations: value => value.decorations })

export default function MarkdownEditor(props: MarkdownEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const callbacksRef = useRef(props)
  const modeCompartment = useRef(new Compartment())
  const readOnlyCompartment = useRef(new Compartment())
  callbacksRef.current = props

  useEffect(() => {
    if (!hostRef.current) return
    let destroyed = false
    const current = callbacksRef.current
    const view = new EditorView({
      parent: hostRef.current,
      state: EditorState.create({
        doc: current.value,
        extensions: [
          basicSetup,
          markdown({ base: markdownLanguage, completeHTMLTags: false, pasteURLAsLink: false }),
          syntaxHighlighting(monochromeHighlighting),
          EditorView.lineWrapping,
          EditorState.tabSize.of(2),
          EditorView.contentAttributes.of({ 'aria-label': current.ariaLabel ?? 'Markdown 文本编辑器', ...(current.inputId ? { id: current.inputId } : {}), ...(current.required ? { 'aria-required': 'true' } : {}), spellcheck: 'false', autocapitalize: 'off', autocomplete: 'off', autocorrect: 'off' }),
          ...(current.placeholder ? [placeholder(current.placeholder)] : []),
          Prec.highest(keymap.of([
            { key: 'Mod-s', preventDefault: true, run: editor => { if (!editor.composing) callbacksRef.current.onSave(); return true } },
            { key: 'Mod-e', preventDefault: true, run: editor => { if (!editor.composing) callbacksRef.current.onToggleMode(); return true } },
            indentWithTab,
          ])),
          modeCompartment.current.of(current.mode === 'live' ? [livePreview, ...(current.previewTables ? tablePreview : [])] : []),
          readOnlyCompartment.current.of([EditorState.readOnly.of(Boolean(current.readOnly)), EditorView.editable.of(!current.readOnly)]),
          EditorView.updateListener.of(update => {
            if (update.docChanged && !update.transactions.every(transaction => transaction.annotation(Transaction.addToHistory) === false)) {
              callbacksRef.current.onChange(update.state.doc.toString())
            }
            if (update.selectionSet || update.docChanged || update.focusChanged) {
              const selection = update.state.selection.main
              const line = update.state.doc.lineAt(selection.head)
              // Blur must not reattach a quote the user just removed in the chat.
              if ((update.selectionSet || update.docChanged) && update.view.hasFocus && !callbacksRef.current.readOnly) {
                callbacksRef.current.onSelectionChange?.(update.state.sliceDoc(selection.from, selection.to).slice(0, 2001), { from: selection.from, to: selection.to, body: update.state.doc.toString() })
              }
              callbacksRef.current.onCursorChange?.(line.number, selection.head - line.from + 1)
            }
          }),
          EditorView.domEventHandlers({
            compositionend: (_event, editor) => {
              requestAnimationFrame(() => { if (!destroyed) editor.dispatch({ effects: refreshPreview.of(null) }) })
              return false
            },
          }),
        ],
      }),
    })
    viewRef.current = view
    callbacksRef.current.onCursorChange?.(1, 1)
    return () => { destroyed = true; viewRef.current = null; view.destroy() }
  }, [])

  useEffect(() => {
    const view = viewRef.current
    if (!view || view.state.doc.toString() === props.value || view.composing) return
    const selection = view.state.selection.main
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: props.value },
      selection: { anchor: Math.min(selection.anchor, props.value.length), head: Math.min(selection.head, props.value.length) },
      annotations: externalValue,
    })
  }, [props.value])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({ effects: [modeCompartment.current.reconfigure(props.mode === 'live' ? [livePreview, ...(props.previewTables ? tablePreview : [])] : []), tablePreviewFocus.of(view.hasFocus)] })
  }, [props.mode, props.previewTables])

  useEffect(() => {
    viewRef.current?.dispatch({ effects: readOnlyCompartment.current.reconfigure([
      EditorState.readOnly.of(Boolean(props.readOnly)), EditorView.editable.of(!props.readOnly),
    ]) })
  }, [props.readOnly])

  useEffect(() => {
    const view = viewRef.current
    if (!view || props.readOnly || (props.focusToken === undefined && props.focusLine === undefined)) return
    if (props.focusLine !== undefined) {
      const line = view.state.doc.line(Math.max(1, Math.min(view.state.doc.lines, props.focusLine)))
      view.dispatch({ selection: { anchor: line.from }, effects: EditorView.scrollIntoView(line.from, { y: 'start', yMargin: 28 }) })
    }
    view.focus()
  }, [props.focusToken, props.focusLine])

  useEffect(() => {
    const view = viewRef.current
    if (view && props.clearSelectionKey) view.dispatch({ selection: { anchor: view.state.selection.main.head } })
  }, [props.clearSelectionKey])

  return <div
    ref={hostRef}
    className={`markdown-editor markdown-editor-${props.mode}${props.readOnly ? ' markdown-editor-readonly' : ''}`}
    style={{ '--markdown-font-size': `${props.fontSize ?? 15}px` } as React.CSSProperties}
  />
}
