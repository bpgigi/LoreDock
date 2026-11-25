import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { getDocumentDraft, removeDocumentDraft, saveDocumentDraft } from './storage'
import type { KnowledgeDocument } from './types'

export type DocumentDraftStatus = 'loading' | 'saved' | 'modified' | 'saving' | 'error' | 'conflict'

export interface DocumentDraftState {
  body: string
  setBody: (body: string) => void
  ready: boolean
  dirty: boolean
  saving: boolean
  discarding: boolean
  status: DocumentDraftStatus
  error: string
  baseVersion: number
  flush: () => Promise<boolean>
  useDraftOnCurrent: () => void
  discardDraft: () => Promise<void>
}

type ErrorKind = 'load' | 'draft' | 'save' | 'conflict' | ''
type Timer = ReturnType<typeof setTimeout>

interface Session {
  id: string
  active: boolean
  ready: boolean
  body: string
  baseBody: string
  baseVersion: number
  latest: KnowledgeDocument
  conflict: boolean
  error: string
  errorKind: ErrorKind
  autoBlocked: boolean
  draftPending: boolean
  revision: number
  saving: boolean
  inFlightBody: string | null
  flushPromise: Promise<boolean> | null
  loadPromise: Promise<boolean> | null
  discardPromise: Promise<void> | null
  discarding: boolean
  draftTimer?: Timer
  commitTimer?: Timer
}

type View = Pick<DocumentDraftState, 'body' | 'ready' | 'dirty' | 'saving' | 'discarding' | 'status' | 'error' | 'baseVersion'> & { id: string }

// A pending write from a previous visit must finish before the same document is
// loaded again. Completed entries are removed from this in-memory queue.
const draftWrites = new Map<string, Promise<void>>()

function writeDraft(id: string, operation: () => Promise<void>): Promise<void> {
  const previous = draftWrites.get(id) ?? Promise.resolve()
  const next = previous.catch(() => undefined).then(operation)
  draftWrites.set(id, next)
  const clean = () => { if (draftWrites.get(id) === next) draftWrites.delete(id) }
  void next.then(clean, clean)
  return next
}

function makeSession(document: KnowledgeDocument): Session {
  return {
    id: document.id, active: true, ready: false, body: document.body,
    baseBody: document.body, baseVersion: document.version, latest: document,
    conflict: false, error: '', errorKind: '', autoBlocked: false,
    draftPending: false, revision: 0, saving: false, inFlightBody: null,
    flushPromise: null, loadPromise: null, discardPromise: null, discarding: false,
  }
}

function viewOf(session: Session): View {
  const saving = session.saving || session.discarding
  const dirty = session.body !== session.baseBody || session.draftPending
  const status: DocumentDraftStatus = session.conflict ? 'conflict'
    : session.error ? 'error' : !session.ready ? 'loading'
      : saving ? 'saving' : dirty ? 'modified' : 'saved'
  return { id: session.id, body: session.body, ready: session.ready, dirty, saving, discarding: session.discarding, status, error: session.error, baseVersion: session.baseVersion }
}

function clearTimers(session: Session) {
  clearTimeout(session.draftTimer)
  clearTimeout(session.commitTimer)
  session.draftTimer = undefined
  session.commitTimer = undefined
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? `${fallback}：${error.message}` : fallback
}

function isConflict(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const value = error as { name?: unknown; code?: unknown; status?: unknown; message?: unknown }
  return value.status === 409
    || /conflict|version_conflict/i.test(`${String(value.name ?? '')} ${String(value.code ?? '')}`)
    || /版本.*(变化|改变|更新|不匹配|冲突)|冲突|conflict|stale/i.test(String(value.message ?? ''))
}

export function useDocumentDraft(
  document: KnowledgeDocument,
  onSave: (id: string, body: string, expectedVersion: number) => Promise<KnowledgeDocument>,
  enabled: boolean,
): DocumentDraftState {
  const documentRef = useRef(document)
  const saveRef = useRef(onSave)
  const enabledRef = useRef(enabled)
  const sessionRef = useRef<Session | null>(null)
  const [view, setView] = useState<View>(() => viewOf(makeSession(document)))
  documentRef.current = document
  saveRef.current = onSave
  enabledRef.current = enabled

  function current(session: Session) { return session.active && sessionRef.current === session }

  function publish(session: Session) {
    if (current(session)) setView(viewOf(session))
  }

  function fail(session: Session, error: unknown, kind: ErrorKind, fallback: string) {
    if (!current(session)) return
    session.error = messageOf(error, fallback)
    session.errorKind = kind
    session.autoBlocked = true
    clearTimeout(session.commitTimer)
    session.commitTimer = undefined
    publish(session)
  }

  function conflict(session: Session, text = '资料已有新版本，草稿已保留。请选择使用草稿覆盖当前版，或放弃草稿。') {
    session.conflict = true
    session.error = text
    session.errorKind = 'conflict'
    session.autoBlocked = true
    clearTimeout(session.commitTimer)
    session.commitTimer = undefined
    publish(session)
  }

  async function persist(session: Session): Promise<boolean> {
    if (!current(session) || !session.ready) return false
    const body = session.body
    const baseVersion = session.baseVersion
    const revision = session.revision
    const shouldRemove = body === session.baseBody && !session.conflict
    try {
      await writeDraft(session.id, () => shouldRemove
        ? removeDocumentDraft(session.id)
        : saveDocumentDraft({ documentId: session.id, body, baseVersion, updatedAt: new Date().toISOString() }))
      if (!current(session)) return false
      if (session.revision === revision && session.body === body && session.baseVersion === baseVersion) {
        session.draftPending = false
      }
      publish(session)
      return true
    } catch (error) {
      if (current(session)) {
        session.draftPending = true
        fail(session, error, session.conflict ? 'conflict' : 'draft', '草稿未能保存，输入仍保留在当前页面')
      }
      return false
    }
  }

  function schedule(session: Session) {
    clearTimers(session)
    if (!current(session) || !enabledRef.current || !session.ready || session.discarding) return
    if (session.body !== session.baseBody || session.draftPending || session.conflict) {
      session.draftTimer = setTimeout(() => { session.draftTimer = undefined; void persist(session) }, 150)
      if (!session.conflict && !session.autoBlocked) {
        session.commitTimer = setTimeout(() => { session.commitTimer = undefined; void flushSession(session, false) }, 1000)
      }
    }
  }

  async function initialize(session: Session): Promise<boolean> {
    if (session.loadPromise) return session.loadPromise
    session.error = ''; session.errorKind = ''
    publish(session)
    const task = (async () => {
      try {
        await (draftWrites.get(session.id) ?? Promise.resolve()).catch(() => undefined)
        const draft = await getDocumentDraft(session.id)
        if (!current(session)) return false
        const latest = documentRef.current.id === session.id ? documentRef.current : session.latest
        session.latest = latest
        session.baseBody = latest.body
        session.baseVersion = latest.version
        session.body = draft?.body ?? latest.body
        session.ready = true
        session.error = ''; session.errorKind = ''; session.autoBlocked = false
        if (draft && draft.body !== latest.body && draft.baseVersion !== latest.version) {
          session.baseVersion = draft.baseVersion
          conflict(session)
        } else if (draft && draft.body === latest.body) {
          session.draftPending = true
          await persist(session)
        }
        if (!current(session)) return false
        publish(session)
        schedule(session)
        return true
      } catch (error) {
        fail(session, error, 'load', '无法读取本地草稿，请重试后再编辑')
        return false
      } finally { session.loadPromise = null }
    })()
    session.loadPromise = task
    return task
  }

  async function flushSession(session: Session, explicit: boolean): Promise<boolean> {
    if (!current(session) || session.discarding) return false
    if (session.flushPromise) return session.flushPromise
    if (!session.ready && !await initialize(session)) return false
    if (session.flushPromise) return session.flushPromise
    if (!current(session) || !enabledRef.current) return current(session) && !viewOf(session).dirty && !session.saving
    if (session.conflict || (!explicit && session.autoBlocked)) return false
    if (explicit) {
      session.autoBlocked = false
      session.error = ''; session.errorKind = ''
    }
    clearTimers(session)
    if (session.body === session.baseBody && !session.draftPending && !session.error) { publish(session); return true }
    session.saving = true
    publish(session)
    const task = (async () => {
      try {
        while (current(session) && enabledRef.current && !session.discarding) {
          if (session.conflict) return false
          // First make this text recoverable. A quota failure must not look saved.
          const persistenceRevision = session.revision
          if (!await persist(session)) return false
          if (!current(session) || session.discarding || session.conflict) return false
          if (session.revision !== persistenceRevision) continue
          if (session.body === session.baseBody) return true
          const submitted = session.body
          const expectedVersion = session.baseVersion
          session.inFlightBody = submitted
          let saved: KnowledgeDocument
          try { saved = await saveRef.current(session.id, submitted, expectedVersion) }
          finally { session.inFlightBody = null }
          if (!current(session)) return false
          if (saved.id !== session.id || saved.version < expectedVersion) throw new Error('保存结果与当前资料不匹配，请重试。')
          if (session.latest.version > saved.version || (session.latest.version === saved.version && session.latest.body !== saved.body && session.latest.version > expectedVersion)) {
            conflict(session)
            return false
          }
          // A completing save advances the baseline, never the user's live text.
          session.latest = saved
          session.baseBody = saved.body
          session.baseVersion = saved.version
          session.revision += 1
          session.draftPending = true
          session.error = ''; session.errorKind = ''; session.autoBlocked = false
          publish(session)
          if (saved.body !== submitted && session.body === submitted) {
            fail(session, undefined, 'save', '保存返回的正文发生变化，当前输入已保留，请核对后重试')
            return false
          }
          if (!await persist(session)) return false
          // Any B typed while A was saving is committed next against A's version.
          if (session.body === session.baseBody) return true
        }
        return false
      } catch (error) {
        if (current(session)) {
          if (isConflict(error)) conflict(session, messageOf(error, '版本冲突，草稿已保留，请明确选择如何处理'))
          else fail(session, error, 'save', '保存失败，输入和草稿已保留，可编辑后或手动重试')
        }
        return false
      } finally {
        session.saving = false
        session.flushPromise = null
        publish(session)
      }
    })()
    session.flushPromise = task
    return task
  }

  useLayoutEffect(() => {
    const session = makeSession(documentRef.current)
    sessionRef.current = session
    publish(session)
    void initialize(session)
    return () => { session.active = false; clearTimers(session) }
    // A callback or version update must not reinitialize an active text buffer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [document.id])

  useLayoutEffect(() => {
    const session = sessionRef.current
    if (!session || session.id !== document.id || !session.active) return
    if (document.version >= session.latest.version) session.latest = document
    if (!session.ready || document.version < session.baseVersion) return
    if (document.version === session.baseVersion && document.body === session.baseBody) return
    if (document.body === session.baseBody && document.equivalentVersions?.includes(session.baseVersion)) {
      // Only the baseline number changed; keep all text typed during synchronization.
      session.baseVersion = document.version
      session.revision += 1
      session.draftPending = viewOf(session).dirty
      publish(session)
      schedule(session)
      return
    }
    // onSave may update the parent before its promise resolves; recognize A even
    // when the editor already contains B, rather than treating our A as conflict.
    if (session.inFlightBody !== null && document.body === session.inFlightBody) return
    if ((!viewOf(session).dirty && !session.saving) || (document.body === session.body && !session.saving)) {
      const removeStaleDraft = session.body !== session.baseBody || session.draftPending || session.conflict
      session.body = document.body
      session.baseBody = document.body
      session.baseVersion = document.version
      session.conflict = false
      session.error = ''; session.errorKind = ''; session.autoBlocked = false
      session.revision += 1
      session.draftPending = removeStaleDraft
      clearTimers(session)
      publish(session)
      if (removeStaleDraft) void persist(session)
    } else conflict(session)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [document.id, document.version, document.body])

  useEffect(() => {
    const session = sessionRef.current
    if (!session) return
    if (!enabled) clearTimers(session)
    else schedule(session)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, document.id])

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      const session = sessionRef.current
      if (!session || (!viewOf(session).dirty && !session.saving && !session.discarding)) return
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [])

  const setBody = useCallback((body: string) => {
    const session = sessionRef.current
    if (!session || !current(session) || !enabledRef.current || !session.ready || session.discarding || body === session.body) return
    session.body = body
    session.revision += 1
    session.draftPending = true
    if (!session.conflict) { session.error = ''; session.errorKind = ''; session.autoBlocked = false }
    publish(session)
    schedule(session)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const flush = useCallback(async () => {
    const session = sessionRef.current
    return session ? flushSession(session, true) : false
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const useDraftOnCurrent = useCallback(() => {
    const session = sessionRef.current
    if (!session || !current(session) || !enabledRef.current || !session.ready || session.saving || session.discarding) return
    const latest = documentRef.current.id === session.id && documentRef.current.version >= session.latest.version ? documentRef.current : session.latest
    session.latest = latest
    session.baseBody = latest.body
    session.baseVersion = latest.version
    session.revision += 1
    session.draftPending = true
    session.conflict = false
    session.error = ''; session.errorKind = ''; session.autoBlocked = false
    publish(session)
    schedule(session)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const discardDraft = useCallback(async () => {
    const session = sessionRef.current
    if (!session || !current(session) || !enabledRef.current) return
    if (session.discardPromise) return session.discardPromise
    clearTimers(session)
    session.discarding = true
    publish(session)
    const task = (async () => {
      try {
        if (session.loadPromise) await session.loadPromise
        if (session.flushPromise) await session.flushPromise
        await writeDraft(session.id, () => removeDocumentDraft(session.id))
        if (!current(session)) return
        const latest = documentRef.current.id === session.id && documentRef.current.version >= session.latest.version ? documentRef.current : session.latest
        session.latest = latest
        session.body = latest.body
        session.baseBody = latest.body
        session.baseVersion = latest.version
        session.revision += 1
        session.draftPending = false
        session.conflict = false
        session.error = ''; session.errorKind = ''; session.autoBlocked = false
        session.ready = true
      } catch (error) {
        fail(session, error, session.conflict ? 'conflict' : 'draft', '未能移除草稿，当前输入保持不变')
      } finally {
        session.discarding = false
        session.discardPromise = null
        publish(session)
      }
    })()
    session.discardPromise = task
    return task
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const visible = view.id === document.id ? view : viewOf(makeSession(document))
  return { ...visible, setBody, flush, useDraftOnCurrent, discardDraft }
}

export default useDocumentDraft
