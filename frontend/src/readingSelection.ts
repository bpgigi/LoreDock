import type { ReadingSelection } from './types'

export interface ReadingHeading { id: string; text: string; depth: number; from: number }
export interface SourceSelection { from: number; to: number; body: string }
const quoteLimit = 2000
const contextLimit = 5000

function sliceText(text: string, from: number, to: number) {
  if (from > 0 && /[\uDC00-\uDFFF]/.test(text[from] ?? '') && /[\uD800-\uDBFF]/.test(text[from - 1])) from++
  if (to < text.length && /[\uD800-\uDBFF]/.test(text[to - 1] ?? '') && /[\uDC00-\uDFFF]/.test(text[to])) to--
  return text.slice(from, to)
}

export function readingHeadings(body: string): ReadingHeading[] {
  const entries: ReadingHeading[] = []
  let fence: { char: string; size: number } | undefined
  let offset = 0
  const lines = body.split('\n')
  const plain = (text: string) => text.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_`~]/g, '')
  lines.forEach((line, index) => {
    const from = offset
    offset += line.length + 1
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/)
    if (marker) {
      if (!fence) fence = { char: marker[1][0], size: marker[1].length }
      else if (marker[1][0] === fence.char && marker[1].length >= fence.size && !marker[2].trim()) fence = undefined
      return
    }
    if (fence) return
    const match = line.match(/^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/)
    if (match) entries.push({ id: `reader-heading-${index + 1}`, from, depth: match[1].length, text: plain(match[2]) })
    else if (index > 0 && /^ {0,3}(?:=+|-+)\s*$/.test(line) && lines[index - 1].trim() && !/^(?:\s|>|[-*+]|\d+[.)])/.test(lines[index - 1])) {
      entries.push({ id: `reader-heading-${index}`, from: from - lines[index - 1].length - 1, depth: line.trim().startsWith('=') ? 1 : 2, text: plain(lines[index - 1].trim()) })
    }
  })
  return entries
}

/** Use the selected block's offsets, not the first matching phrase in the document. */
export function resolveReadingRange(body: string, text: string, start: number, end: number) {
  const from = Math.max(0, Math.min(start, body.length))
  const to = Math.max(from, Math.min(end, body.length))
  const match = body.indexOf(text, from)
  return match >= from && match + text.length <= to ? { from: match, to: match + text.length } : { from, to }
}

export function createReadingSelection(input: Omit<ReadingSelection, 'context' | 'heading' | 'truncated'> & SourceSelection & { headings?: ReadingHeading[]; fallbackHeading?: string }): ReadingSelection | undefined {
  const text = sliceText(input.text.trim(), 0, quoteLimit)
  if (!text) return undefined
  const from = Math.max(0, Math.min(input.from, input.body.length))
  const to = Math.max(from, Math.min(input.to, from + quoteLimit, input.body.length))
  const headings = input.headings ?? readingHeadings(input.body)
  const stack: ReadingHeading[] = []
  for (const heading of headings) {
    if (heading.from > from) break
    while (stack.length && stack.at(-1)!.depth >= heading.depth) stack.pop()
    stack.push(heading)
  }
  // Keep nearby paragraphs, bounded to the current section and a small budget.
  const sectionStart = stack.at(-1)?.from ?? 0
  const sectionEnd = headings.find(heading => heading.from >= to && heading.from > from)?.from ?? input.body.length
  const start = Math.max(sectionStart, from - 1200)
  const end = Math.min(input.body.length, Math.max(to, Math.min(sectionEnd, to + 1800)), start + contextLimit)
  return {
    documentId: input.documentId, spaceId: input.spaceId, version: input.version,
    title: input.title.slice(0, 240), heading: (stack.map(item => item.text).join(' / ') || input.fallbackHeading || '文档正文').slice(0, 500),
    text, context: sliceText(input.body, start, end), isDraft: input.isDraft, isHistorical: input.isHistorical,
    truncated: input.text.trim().length > quoteLimit || input.to - input.from > quoteLimit,
  }
}

export function readingSelectionData(selection: ReadingSelection): ReadingSelection {
  const { documentId, spaceId, version, title, heading, text, context, isDraft, isHistorical, truncated } = selection
  return { documentId, spaceId, version, title, heading, text, context, isDraft, isHistorical, truncated }
}

/** Follow-up questions keep the original quote, without sending local card suggestions. */
export function readingHistoryContent(question: string, selection?: ReadingSelection): string {
  if (!selection) return question.slice(0, 8000)
  const encode = (context: string) => JSON.stringify({ question: sliceText(question, 0, 4000), reading_selection: { ...readingSelectionData(selection), context } })
  let low = 0
  let high = selection.context.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (encode(sliceText(selection.context, 0, middle)).length <= 8000) low = middle
    else high = middle - 1
  }
  const result = encode(sliceText(selection.context, 0, low))
  // Highly escaped user text can itself exceed the history budget. Keep a safe
  // plain-text historical quote instead of truncating a JSON object mid-string.
  return result.length <= 8000 ? result : `问题：${question}\n选文（${selection.title}）：${selection.text}`.slice(0, 8000)
}
