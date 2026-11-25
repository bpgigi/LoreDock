import { useEffect, useRef, useState } from 'react'
import { App as AntApp, Button, Drawer, Dropdown, Input, Modal, Select, Upload } from 'antd'
import { ArrowRight, BookOpen, Check, ChevronLeft, ChevronRight, Code2, Database, Ellipsis, FileText, FolderOpen, Gamepad2, HelpCircle, Layers2, Menu, MessageSquare, PanelRightClose, PanelRightOpen, Plus, Printer, Search, Settings2, Sparkles, StickyNote, UploadCloud, X } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import ChatWorkspace from './components/ChatWorkspace'
import DocumentLibrary from './components/DocumentLibrary'
import DocumentReader from './components/DocumentReader'
import type { ReaderNavigationGuard } from './components/DocumentReader'
import ModelSettings from './components/ModelSettings'
import ModelPicker from './components/ModelPicker'
import KnowledgeCards, { displayedBody } from './components/KnowledgeCards'
import CardWorkshop from './components/CardWorkshop'
import { useCardWorkshop } from './useCardWorkshop'
import { cardIntent } from './cardWorkshop'
import type { CardArticleSource, CardModel } from './cardWorkshop'
import LocalSearch from './components/LocalSearch'
import WorkspaceBackup from './WorkspaceBackupDialog'
import WorkspaceSearch from './components/WorkspaceSearch'
import type { SearchKind, WorkspaceSearchResult } from './workspaceSearch'
import { saveLocalCopies } from './localIndex'
import { ensureKnowledgeCards } from './knowledgeCards'
import { matchKnowledgeCards, planChatContext } from './chatContext'
import { readingHistoryContent, readingSelectionData } from './readingSelection'
import { reasoningRequest, selectedReasoning, withReasoning } from './reasoning'
import type { ReasoningSetting } from './reasoning'
import { askModel, getModels, getProviders, listNoteImports, getNoteImport, searchIndexedDocuments, retireIndexedDocuments } from './api'
import type { ProviderProfile, NoteImportSummary } from './api'
import { importBatchKey, mergeNoteImport } from './noteImports'
import { initialDocuments, initialSpaces, EXAMPLE_QUESTION } from './data'
import { commitDocumentEdit, deleteKnowledgeCard, loadWorkspace, removeLibraryItems, sameDocumentContent, saveGeneratedKnowledgeCards, saveKnowledgeCard, saveWorkspace } from './storage'
import type { WorkspaceData } from './storage'
import type { ChatMessage, Citation, Conversation, GeneratedKnowledgeCardInput, KnowledgeCardInput, KnowledgeDocument, ReadingSelection, RelatedCard, Space } from './types'

type Page = 'chat' | 'documents' | 'spaces' | 'reader' | 'cards'
type Source = { citation: Citation; kind: 'document' | 'citation' }
const icons = { code: Code2, sparkles: Sparkles, printer: Printer, game: Gamepad2 }
const uid = () => crypto.randomUUID()
const now = () => new Date().toISOString()
const newConversation = (spaceId: string, documentId?: string): Conversation => ({ id: uid(), spaceId, documentId, title: '新的问答', messages: [], createdAt: now() })

function makeInitialData(): WorkspaceData {
  const conversation = newConversation('python')
  return ensureKnowledgeCards({ spaces: initialSpaces, documents: initialDocuments, conversations: [conversation], selectedSpaceId: 'python', selectedConversationId: conversation.id })
}

function useNarrowLayout() {
  const [width, setWidth] = useState(window.innerWidth)
  useEffect(() => {
    const listener = () => setWidth(window.innerWidth)
    window.addEventListener('resize', listener)
    return () => window.removeEventListener('resize', listener)
  }, [])
  return { narrow: width < 1280, mobile: width < 780 }
}

function citationFor(document: KnowledgeDocument): Citation {
  return { id: document.id, documentId: document.id, version: document.version, title: document.title, heading: document.heading, excerpt: document.body }
}

export default function App() { return <AntApp><Workspace /></AntApp> }

function Workspace() {
  const { message, modal } = AntApp.useApp()
  const [data, setData] = useState<WorkspaceData>(makeInitialData)
  const [loaded, setLoaded] = useState(false)
  const [page, setPage] = useState<Page>('chat')
  const [scopeIds, setScopeIds] = useState<string[]>(['python'])
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [source, setSource] = useState<Source | null>(null)
  const [cardSource, setCardSource] = useState<Citation | null>(null)
  const [relatedCard, setRelatedCard] = useState<RelatedCard | null>(null)
  const displayedRelatedCard = data.knowledgeCards?.find(card => card.id === relatedCard?.cardId)
  const [sourceOpen, setSourceOpen] = useState(false)
  const [desktopInspectorOpen, setDesktopInspectorOpen] = useState(false)
  const [sourceTab, setSourceTab] = useState<'text' | 'info'>('text')
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchKind, setSearchKind] = useState<SearchKind | 'all'>('all')
  const [localSearchOpen, setLocalSearchOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const [backupOpen, setBackupOpen] = useState(false)
  const [uploadOpen, setUploadOpen] = useState(false)
  const [uploadSpaceId, setUploadSpaceId] = useState('python')
  const [updatingDocument, setUpdatingDocument] = useState<KnowledgeDocument | null>(null)
  const [uploadBusy, setUploadBusy] = useState(false)
  const [uploadError, setUploadError] = useState('')
  const [spaceModalOpen, setSpaceModalOpen] = useState(false)
  const [editingSpace, setEditingSpace] = useState<Space | null>(null)
  const [spaceName, setSpaceName] = useState('')
  const [spaceDescription, setSpaceDescription] = useState('')
  const [spaceIcon, setSpaceIcon] = useState<Space['icon']>('code')
  const [pending, setPending] = useState<string[]>([])
  const [readerDocumentId, setReaderDocumentId] = useState<string | null>(null)
  const [readerConversationId, setReaderConversationId] = useState('')
  const [readerCitation, setReaderCitation] = useState<Citation | null>(null)
  const [readerSnapshot, setReaderSnapshot] = useState(false)
  const [readerCitationNavigation, setReaderCitationNavigation] = useState(0)
  const [modelSettingsOpen, setModelSettingsOpen] = useState(false)
  const [providers, setProviders] = useState<ProviderProfile[]>([])
  const [backendReady, setBackendReady] = useState(false)
  const [modelsByProvider, setModelsByProvider] = useState<Record<string, string[]>>({})
  const [modelsLoading, setModelsLoading] = useState(false)
  const [noteImports, setNoteImports] = useState<NoteImportSummary[]>([])
  const [notesImporting, setNotesImporting] = useState(false)
  const [cardDraft, setCardDraft] = useState<{ id: string; title: string; body: string; spaceId: string }>()
  const workspaceRef = useRef(data)
  const readerNavigationGuard = useRef<ReaderNavigationGuard | null>(null)
  const searchNavigationPending = useRef(false)
  const searchResultAction = useRef<(result: WorkspaceSearchResult) => void>(() => undefined)
  const requests = useRef(new Map<string, { controller: AbortController; question: string; requestId: string }>())
  const cardConversationFocus = useRef(new Set<string>())
  const storageWarning = useRef(false)
  const { narrow, mobile } = useNarrowLayout()

  useEffect(() => { workspaceRef.current = data }, [data])

  useEffect(() => {
    let active = true
    loadWorkspace().then(value => {
      const stored = value ? ensureKnowledgeCards(value) : undefined
      if (active && stored) {
        const selectedSpace = stored.spaces.find(item => item.id === stored.selectedSpaceId) ?? stored.spaces[0]
        const conversations = stored.conversations.filter(item => stored.spaces.some(space => space.id === item.spaceId)).map(item => ({ ...item, messages: item.messages.map((message): ChatMessage => message.status === 'loading' ? { ...message, status: 'error', isDemo: false, body: '上次请求已中断，你的问题已保留，可以恢复后重试。' } : message) }))
        const selectedConversation = conversations.find(item => item.id === stored.selectedConversationId && item.spaceId === selectedSpace?.id) ?? conversations.find(item => item.spaceId === selectedSpace?.id) ?? (selectedSpace ? newConversation(selectedSpace.id) : undefined)
        if (selectedConversation && !conversations.some(item => item.id === selectedConversation.id)) conversations.unshift(selectedConversation)
        setData({ ...stored, conversations, selectedSpaceId: selectedSpace?.id ?? '', selectedConversationId: selectedConversation?.id ?? '' })
        setScopeIds(selectedSpace ? [selectedSpace.id] : [])
      }
    }).catch(() => { if (active) message.warning('浏览器存储暂不可用，本次内容会保留在当前页面。') })
      .finally(() => { if (active) setLoaded(true) })
    return () => { active = false }
  }, [message])

  useEffect(() => {
    if (!loaded) return
    const timer = setTimeout(() => { saveWorkspace(data).catch(() => {
      if (!storageWarning.current) { storageWarning.current = true; message.warning('浏览器未能保存这次修改，请先保留原文件，避免关闭页面后丢失。') }
    }) }, 180)
    return () => clearTimeout(timer)
  }, [data, loaded, message])

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k' && !event.isComposing) {
        event.preventDefault()
        // Keep an unfinished card/settings form in place; do not stack navigation over it.
        if (Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]')).some(dialog => dialog.getClientRects().length > 0)) return
        setSearchKind('all'); setSearchOpen(true); setSidebarOpen(false)
      }
    }
    window.addEventListener('keydown', listener)
    return () => window.removeEventListener('keydown', listener)
  }, [])

  useEffect(() => () => { requests.current.forEach(value => value.controller.abort()) }, [])

  useEffect(() => {
    if (!loaded) return
    let active = true
    getProviders().then(result => { if (active) { setProviders(result.providers); setBackendReady(true) } }).catch(() => { if (active) setBackendReady(false) })
    return () => { active = false }
  }, [loaded])

  useEffect(() => {
    if (!loaded) return
    let active = true
    listNoteImports().then(result => { if (active) setNoteImports(result.imports) }).catch(() => { /* Existing library remains usable offline. */ })
    return () => { active = false }
  }, [loaded])

  const space = data.spaces.find(value => value.id === data.selectedSpaceId) ?? data.spaces[0]
  const conversation = data.conversations.find(value => value.id === data.selectedConversationId)
  const documents = data.documents.filter(document => document.spaceId === space?.id)
  const scopedDocuments = data.documents.filter(document => scopeIds.includes(document.spaceId))
  const busy = pending.includes(conversation?.id ?? '')
  const readerDocument = data.documents.find(item => item.id === readerDocumentId)
  const readerConversation = data.conversations.find(item => item.id === readerConversationId)
  const selectedProvider = providers.find(item => item.id === data.aiPreference?.providerId) ?? providers[0]
  const selectedModel = data.aiPreference?.providerId === selectedProvider?.id ? data.aiPreference?.model ?? selectedProvider?.default_model ?? '' : selectedProvider?.default_model ?? ''
  const reasoning = selectedReasoning(data.aiPreference, selectedProvider?.id ?? '', selectedModel)
  const workshop = useCardWorkshop(page === 'reader' ? readerConversationId : '', saveGeneratedCards)

  function selectSpace(id: string, nextPage?: Page) {
    if (!data.spaces.some(item => item.id === id)) return undefined
    const existing = data.conversations.find(item => item.spaceId === id && !item.documentId)
    const next = existing ?? newConversation(id)
    setData(previous => {
      return { ...previous, selectedSpaceId: id, selectedConversationId: next.id, conversations: existing ? previous.conversations : [next, ...previous.conversations] }
    })
    setScopeIds([id]); setSource(null); setSidebarOpen(false)
    if (nextPage) setPage(nextPage)
    else if (page === 'reader') setPage('documents')
    return next.id
  }

  function validScope(ids: string[], fallbackId: string) {
    const valid = ids.filter(id => data.spaces.some(item => item.id === id))
    return valid.length ? valid : [fallbackId]
  }

  async function importStudyNotes(summary: NoteImportSummary) {
    if (notesImporting) return
    setNotesImporting(true)
    try {
      const bundle = await getNoteImport(summary.id)
      const result = mergeNoteImport(workspaceRef.current, bundle)
      const existing = result.workspace.conversations.find(item => item.spaceId === bundle.space.id && !item.documentId)
      const nextConversation = existing ?? newConversation(bundle.space.id)
      const next = { ...result.workspace, selectedSpaceId: bundle.space.id, selectedConversationId: nextConversation.id, conversations: existing ? result.workspace.conversations : [nextConversation, ...result.workspace.conversations] }
      await saveWorkspace(next)
      setData(previous => ({ ...next, knowledgeCards: previous.knowledgeCards })); setScopeIds([bundle.space.id]); setPage('documents'); setSidebarOpen(false)
      message.success(`已导入 ${result.added} 篇学习笔记${result.skipped ? `，跳过 ${result.skipped} 篇已有资料` : ''}。`)
    } catch (error) { message.error(error instanceof Error ? error.message : '笔记导入失败，原有资料已保留。') }
    finally { setNotesImporting(false) }
  }

  function openNoteLink(href: string) {
    if (!readerDocument?.sourcePath) { message.info('当前资料没有可用的本地链接。'); return }
    try {
      const url = new URL(href, `https://loredock.local/${readerDocument.sourcePath}`)
      if (url.origin !== 'https://loredock.local') return
      const path = decodeURIComponent(url.pathname).replace(/^\//, '')
      const target = data.documents.find(item => item.importBatchId === readerDocument.importBatchId && item.sourcePath === path)
      if (target) openReader(target)
      else message.info('链接对应的笔记尚未导入，或已从资料库移除。')
    } catch { message.warning('这个笔记链接无法打开。') }
  }

  function createConversation() {
    if (!space) return
    const next = newConversation(space.id)
    setData(previous => ({ ...previous, conversations: [next, ...previous.conversations], selectedConversationId: next.id }))
    setScopeIds([space.id]); setSource(null); setPage('chat'); setSidebarOpen(false)
  }

  function openCitation(citation: Citation, kind: Source['kind'] = 'citation') {
    if (citation.cardId) { setCardSource(citation); return }
    const document = data.documents.find(item => item.id === citation.documentId)
    if (document) { openReader(document, kind === 'citation' ? citation : null); return }
    setSource({ citation, kind }); setSourceTab('text'); setSourceOpen(true); setDesktopInspectorOpen(true)
  }

  function closeSourcePanel() {
    setSourceOpen(false); setDesktopInspectorOpen(false)
  }

  function toggleSourcePanel() {
    const open = !(narrow ? sourceOpen : desktopInspectorOpen)
    setSourceOpen(open); setDesktopInspectorOpen(open)
  }

  function changeProvider(id: string) {
    const profile = providers.find(item => item.id === id)
    if (profile) setData(previous => ({ ...previous, aiPreference: { ...previous.aiPreference, providerId: id, model: profile.default_model } }))
  }

  function changeModel(model: string) {
    if (selectedProvider) setData(previous => ({ ...previous, aiPreference: { ...previous.aiPreference, providerId: selectedProvider.id, model } }))
  }

  function changeReasoning(value: ReasoningSetting) {
    if (selectedProvider) setData(previous => ({ ...previous, aiPreference: withReasoning(previous.aiPreference, selectedProvider.id, selectedModel, value) }))
  }

  function providersChanged(next: ProviderProfile[]) {
    setProviders(next); setBackendReady(true); setModelsByProvider({})
    setData(previous => {
      const profile = next.find(item => item.id === previous.aiPreference?.providerId) ?? next[0]
      return { ...previous, aiPreference: profile ? { ...previous.aiPreference, providerId: profile.id, model: profile.id === previous.aiPreference?.providerId ? previous.aiPreference.model : profile.default_model } : undefined }
    })
  }

  async function loadModels() {
    if (!selectedProvider || modelsLoading) return
    const id = selectedProvider.id
    setModelsLoading(true)
    try {
      const result = await getModels(id)
      setModelsByProvider(previous => ({ ...previous, [id]: result.models }))
      message.success(`已读取 ${result.models.length} 个模型，也可以手填模型 ID。`)
    } catch (error) { message.error(error instanceof Error ? error.message : '无法读取模型列表，可手填模型 ID。') }
    finally { setModelsLoading(false) }
  }

  function modelPicker() {
    return <ModelPicker providers={providers} providerId={selectedProvider?.id ?? ''} model={selectedModel} models={modelsByProvider[selectedProvider?.id ?? ''] ?? []} loading={modelsLoading} onProviderChange={changeProvider} onModelChange={changeModel} onLoadModels={() => { void loadModels() }} onSettings={() => setModelSettingsOpen(true)} reasoning={reasoning} onReasoningChange={changeReasoning} />
  }

  function openReader(document: KnowledgeDocument, citation: Citation | null = null) {
    const existing = data.conversations.find(item => item.documentId === document.id && item.spaceId === document.spaceId)
    const next = existing ?? newConversation(document.spaceId, document.id)
    const general = data.conversations.find(item => !item.documentId && item.spaceId === document.spaceId)
    const nextGeneral = general ?? newConversation(document.spaceId)
    setData(previous => ({ ...previous, selectedSpaceId: document.spaceId, selectedConversationId: nextGeneral.id, conversations: [...(existing ? [] : [next]), ...(general ? [] : [nextGeneral]), ...previous.conversations] }))
    setReaderDocumentId(document.id); setReaderConversationId(next.id); setReaderCitation(citation)
    setReaderSnapshot(Boolean(citation && citation.version !== document.version))
    if (citation) setReaderCitationNavigation(previous => previous + 1)
    setPage('reader'); setSidebarOpen(false); closeSourcePanel()
  }

  async function saveReaderDocument(documentId: string, body: string, expectedVersion: number) {
    try {
      const updated = await commitDocumentEdit(documentId, body, expectedVersion)
      // Patch only the confirmed document, keeping concurrent answers and preferences.
      setData(previous => ({ ...previous, documents: previous.documents.map(item => item.id === documentId && item.version <= updated.version ? updated : item) }))
      return updated
    } catch (error) {
      if (error instanceof Error && error.name === 'DocumentEditConflictError') {
        try {
          const persisted = await loadWorkspace()
          const latest = persisted?.documents.find(item => item.id === documentId)
          if (latest) setData(previous => ({ ...previous, documents: previous.documents.map(item => item.id === documentId && item.version <= latest.version ? latest : item) }))
        } catch { /* Preserve the original conflict and unsaved draft if refresh also fails. */ }
      }
      throw error
    }
  }

  function newReaderConversation() {
    if (!readerDocument) return
    const create = () => {
      workshop.controller.stop()
      workshop.controller.clear(readerConversationId)
      const next = newConversation(readerDocument.spaceId, readerDocument.id)
      setData(previous => ({ ...previous, conversations: [next, ...previous.conversations] }))
      setReaderConversationId(next.id)
    }
    if (workshop.state?.busy === 'saving') { message.info('正在保存卡片，请稍后新建对话。'); return }
    if (workshop.state?.busy || workshop.state?.drafts.some(draft => !draft.savedCardId)) {
      modal.confirm({ title: '新建阅读对话？', content: '本次未保存的卡片草稿将清空，正在生成的任务会停止。已保存的卡片保留。', okText: '清空草稿并新建', cancelText: '保留当前对话', onOk: create })
    } else create()
  }

  async function saveCard(input: KnowledgeCardInput, id?: string) {
    const saved = await saveKnowledgeCard(input, id)
    setData(previous => ({ ...previous, knowledgeCards: [saved, ...(previous.knowledgeCards ?? []).filter(item => item.id !== saved.id)] }))
    return saved
  }

  async function removeCard(id: string) {
    await deleteKnowledgeCard(id)
    setData(previous => ({ ...previous, knowledgeCards: (previous.knowledgeCards ?? []).filter(item => item.id !== id) }))
  }

  async function saveGeneratedCards(inputs: GeneratedKnowledgeCardInput[]) {
    const saved = await saveGeneratedKnowledgeCards(inputs)
    const ids = new Set(saved.map(card => card.id))
    setData(previous => ({ ...previous, knowledgeCards: [...saved, ...(previous.knowledgeCards ?? []).filter(card => !ids.has(card.id))] }))
    message.success(`已保存 ${saved.length} 张卡片草稿。`)
    return saved
  }

  function cardModel(): CardModel | undefined {
    if (pending.includes(readerConversationId)) { message.info('请先等待或停止当前问答。'); return }
    if (!selectedProvider || !selectedModel.trim()) { setModelSettingsOpen(true); message.info('先配置服务和模型，再生成或修改卡片。'); return }
    if (!selectedProvider.has_api_key && !['localhost', '127.0.0.1', '[::1]'].includes(new URL(selectedProvider.base_url).hostname)) { setModelSettingsOpen(true); message.warning('请先为所选服务填写 API Key。'); return }
    return { provider_id: selectedProvider.id, model: selectedModel.trim(), ...reasoningRequest(reasoning) }
  }

  function generateReadingCards(source: CardArticleSource, whole: boolean) {
    if (whole && source.isHistorical) { message.info('当前只有历史摘录，请切换到当前文章后生成整篇卡片。'); return false }
    const model = whole ? undefined : cardModel()
    if (!whole && !model) return false
    const accepted = workshop.controller.prepare(readerConversationId, source, whole)
    if (accepted) {
      cardConversationFocus.current.add(readerConversationId)
      if (model) void workshop.controller.run(readerConversationId, model)
    }
    return accepted
  }

  function runCardBatches(retryEmpty = false) {
    const model = cardModel()
    if (model) { cardConversationFocus.current.add(readerConversationId); void workshop.controller.run(readerConversationId, model, retryEmpty) }
  }

  function reviseReadingCards(instruction: string) {
    const model = cardModel()
    if (model) { cardConversationFocus.current.add(readerConversationId); void workshop.controller.revise(readerConversationId, instruction, model) }
    return Boolean(model)
  }

  function readingCardIntent(question: string) {
    return cardIntent(question, Boolean(workshop.state?.drafts.length), cardConversationFocus.current.has(readerConversationId))
  }

  function routeReaderQuestion(question: string, selection: ReadingSelection | undefined, fullSelection: CardArticleSource | undefined, article: CardArticleSource) {
    if (!readerConversation || !readerDocument) return
    const intent = readingCardIntent(question)
    if (!intent) {
      cardConversationFocus.current.delete(readerConversationId)
      void sendQuestion(question, readerConversation, readerDocument.id, readerSnapshot ? readerCitation : null, selection)
      return
    }
    if (question.length > 4000) { message.warning('卡片指令请控制在 4000 字以内。'); return }
    if (intent === 'generate-selection' && !fullSelection) { message.info('请先在正文中选中要整理的片段；卡片生成会使用完整选文。'); return }
    const accepted = intent === 'revise' ? reviseReadingCards(question)
      : generateReadingCards(intent === 'generate-article' ? article : fullSelection!, intent === 'generate-article')
    if (accepted) setDrafts(previous => ({ ...previous, [readerConversation.id]: '' }))
  }

  function createCardFromSelection(text: string) {
    if (!readerDocument) return
    setCardDraft({ id: uid(), title: `${readerDocument.title} · 摘录`.slice(0, 100), body: text, spaceId: readerDocument.spaceId })
    closeSourcePanel()
    setPage('cards')
  }

  function explainSelection() {
    if (!readerConversation) return
    setDrafts(previous => previous[readerConversation.id]?.trim() ? previous : { ...previous, [readerConversation.id]: '这里是什么意思？' })
  }

  function setReferenceDocuments(target: Conversation, enabled: boolean) {
    setData(previous => ({ ...previous, conversations: previous.conversations.map(item => item.id === target.id ? { ...item, referenceDocuments: enabled } : item) }))
  }

  async function sendQuestion(question: string, target = conversation, documentId?: string, historical?: Citation | null, readingSelection?: ReadingSelection) {
    if (!target || requests.current.has(target.id)) return
    const value = question.trim()
    if (!value) return
    if (value.length > 4000) { message.warning('请将问题控制在 4000 字以内。'); return }
    if (!selectedProvider || !selectedModel.trim()) { setModelSettingsOpen(true); message.info('先配置 API 服务和模型，再开始问答。'); return }
    if (!selectedProvider.has_api_key && !['localhost', '127.0.0.1', '[::1]'].includes(new URL(selectedProvider.base_url).hostname)) { setModelSettingsOpen(true); message.warning('请先为所选服务填写 API Key。'); return }
    const reading = documentId ? data.documents.find(item => item.id === documentId) : undefined
    const conversationId = target.id
    const requestId = uid()
    const snapshot = reading ? [reading.spaceId] : scopeIds.filter(id => data.spaces.some(item => item.id === id))
    if (!snapshot.length || (documentId && !reading)) { message.warning('提问范围已失效，请重新选择资料。'); return }
    if (readingSelection && (readingSelection.documentId !== documentId || !snapshot.includes(readingSelection.spaceId))) { message.warning('选文来自另一份资料，请重新选择。'); return }
    const controller = new AbortController()
    const provider = selectedProvider
    const model = selectedModel.trim()
    const referenceDocuments = target.referenceDocuments === true
    const plan = planChatContext({ scopeIds: snapshot, documents: data.documents, referenceDocuments, documentId, historical })
    const relatedCards = matchKnowledgeCards(data.knowledgeCards ?? [], snapshot, `${value}\n${readingSelection?.text ?? ''}`)
    const contextKey = plan.contextKey
    let historyChars = 0
    const history = target.messages.filter(item => item.status === 'completed' && !item.isDemo && item.documentId === documentId && item.contextKey === contextKey && (item.role === 'user' || item.model) && item.scopeIds.length === snapshot.length && item.scopeIds.every(id => snapshot.includes(id))).slice(-10).reverse().map(item => ({ role: item.role, content: readingHistoryContent(item.body, item.role === 'user' ? item.readingSelection : undefined) })).filter(item => { historyChars += item.content.length; return historyChars <= 24000 }).reverse()
    const questionMessage: ChatMessage = { id: uid(), role: 'user', body: value, scopeIds: snapshot, documentId, contextKey, referenceDocuments, readingSelection, reasoningEffort: reasoning, citations: [], createdAt: now(), status: 'completed', isDemo: false }
    const loadingMessage: ChatMessage = { id: requestId, role: 'assistant', body: '', scopeIds: snapshot, documentId, contextKey, referenceDocuments, reasoningEffort: reasoning, citations: [], relatedCards, createdAt: now(), status: 'loading', isDemo: false, model, providerName: provider.name }
    requests.current.set(conversationId, { controller, question: value, requestId })
    setData(previous => ({ ...previous, conversations: previous.conversations.map(item => item.id === conversationId ? { ...item, title: item.messages.length ? item.title : value.slice(0, 26), messages: [...item.messages, questionMessage, loadingMessage] } : item) }))
    setDrafts(previous => ({ ...previous, [conversationId]: '' })); setPending(previous => [...previous, conversationId])
    try {
      // Historical excerpts stay read-only and never replace the current server version.
      const indexed = plan.retrievalMode === 'none' || historical ? undefined : await saveLocalCopies(plan.documents, data.spaces, controller.signal, reflectAlignedDocument)
      const useSnapshot = plan.retrievalMode === 'snapshot'
      const result = await askModel({
        session_id: conversationId, request_id: requestId, provider_id: provider.id, model, question: value, scope_ids: snapshot, document_id: documentId,
        answer_mode: 'assistant',
        ...reasoningRequest(reasoning),
        reading_selection: readingSelection ? readingSelectionData(readingSelection) : undefined,
        documents: useSnapshot ? (indexed?.documents ?? plan.documents).map(item => ({ id: item.id, space_id: item.spaceId, title: item.title, body: item.body, version: item.version, heading: item.heading })) : [],
        retrieval_mode: plan.retrievalMode, document_versions: plan.retrievalMode === 'indexed' ? indexed?.versions : undefined,
        history,
      }, controller.signal)
      if (requests.current.get(conversationId)?.requestId !== requestId) return
      if (result.session_id !== conversationId || result.request_id !== requestId) throw new Error('回答与当前请求不匹配，请重试。')
      setData(previous => ({ ...previous, conversations: previous.conversations.map(item => item.id === conversationId ? { ...item, messages: item.messages.map(message => message.id === requestId ? { ...message, body: result.body, citations: result.citations, model: result.model, providerName: result.provider_name, contextNote: result.context_note, status: 'completed' } : message) } : item) }))
    } catch (error) {
      if (requests.current.get(conversationId)?.requestId !== requestId) return
      setData(previous => ({ ...previous, conversations: previous.conversations.map(item => item.id === conversationId ? { ...item, messages: item.messages.map(message => message.id === requestId ? { ...message, status: 'error', body: error instanceof Error ? error.message : '请求失败，请恢复问题后重试。', model: undefined } : message) } : item) }))
      setDrafts(previous => previous[conversationId] ? previous : { ...previous, [conversationId]: value })
    } finally {
      if (requests.current.get(conversationId)?.requestId === requestId) {
        requests.current.delete(conversationId)
        setPending(previous => previous.filter(id => id !== conversationId))
      }
    }
  }

  function cancelQuestion(target = conversation) {
    if (!target) return
    const current = requests.current.get(target.id)
    if (!current) return
    requests.current.delete(target.id); current.controller.abort()
    setPending(previous => previous.filter(id => id !== target.id))
    setDrafts(previous => ({ ...previous, [target.id]: current.question }))
    setData(previous => ({ ...previous, conversations: previous.conversations.map(item => item.id === target.id ? { ...item, messages: item.messages.filter(message => message.id !== current.requestId) } : item) }))
    message.info('已停止，问题已保留在输入框。')
  }

  function openUpload(document?: KnowledgeDocument) {
    if (!space) return
    setUploadSpaceId(document?.spaceId ?? space.id); setUpdatingDocument(document ?? null)
    setUploadError(''); setUploadOpen(true)
  }

  async function importFile(file: File) {
    if (uploadBusy) return false
    setUploadError('')
    const extension = file.name.split('.').at(-1)?.toLowerCase()
    if (extension !== 'md' && extension !== 'txt') { setUploadError('目前支持 Markdown（.md）和 UTF-8 文本（.txt），PDF 将在后续按需增加。'); return false }
    if (file.size > 20 * 1024 * 1024) { setUploadError('单个文件不能超过 20 MiB，请拆分后重试。'); return false }
    if (!file.size) { setUploadError('这个文件是空的，请选择有正文的资料。'); return false }
    if (!data.spaces.some(item => item.id === uploadSpaceId)) { setUploadError('目标空间已不存在，请重新选择。'); return false }
    setUploadBusy(true)
    try {
      const body = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer())
      if (!body.trim() || body.includes('\0')) throw new Error('没有找到可读正文，请使用有效的 UTF-8 文本文件。')
      const headingLines = [...body.matchAll(/^#{1,3}\s+(.+)$/gm)].slice(0, 2).map(item => item[1])
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body))
      const contentHash = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('')
      const document: KnowledgeDocument = { ...updatingDocument, id: updatingDocument?.id ?? uid(), spaceId: uploadSpaceId, title: headingLines[0] ?? file.name.replace(/\.(md|txt)$/i, ''), fileName: file.name, type: extension, size: file.size, updatedAt: now(), version: (updatingDocument?.version ?? 0) + 1, equivalentVersions: undefined, status: 'available', body, contentHash, failureReason: undefined, heading: headingLines.slice(1).join(' / ') || '文档正文', isDemo: false }
      setData(previous => ({ ...previous, documents: updatingDocument ? previous.documents.map(item => item.id === updatingDocument.id ? document : item) : [document, ...previous.documents] }))
      setUploadOpen(false); openReader(document)
      message.success(updatingDocument ? '资料已替换，原有引用会保留旧版本提示。' : '资料已保存，可以查看原文。')
    } catch (error) { setUploadError(error instanceof TypeError ? '文件编码无法读取，请转换为 UTF-8 后重试。' : error instanceof Error ? error.message : '文件读取失败，请重新选择。') }
    finally { setUploadBusy(false) }
    return false
  }

  function openSpaceEditor(target?: Space) {
    setEditingSpace(target ?? null); setSpaceName(target?.name ?? ''); setSpaceDescription(target?.description ?? '')
    setSpaceIcon(target?.icon ?? 'code'); setSpaceModalOpen(true)
  }

  async function deleteDocument(id: string) {
    let retired = false
    try {
      await retireIndexedDocuments([id])
      retired = true
      await removeLibraryItems([id])
      setData(previous => ({ ...previous, documents: previous.documents.filter(document => document.id !== id) }))
      message.success('资料已移除，本机索引已撤下。')
    } catch (error) {
      message.error(retired ? '本机索引已撤下，浏览器移除未完成，请重试删除。' : error instanceof Error ? error.message : '删除没有完成，请重试。')
      throw error
    }
  }

  function reflectAlignedDocument(before: KnowledgeDocument, after: KnowledgeDocument) {
    setData(previous => ({ ...previous, documents: previous.documents.map(item =>
      item.version === before.version && sameDocumentContent(item, before)
        ? { ...item, version: after.version, equivalentVersions: after.equivalentVersions } : item) }))
  }

  async function searchLocal(question: string, signal: AbortSignal) {
    const current = workspaceRef.current
    const scope = space.id
    const snapshot = current.documents.filter(document => document.spaceId === scope && document.status === 'available' && document.body.trim())
    const saved = await saveLocalCopies(snapshot, current.spaces, signal, reflectAlignedDocument)
    return searchIndexedDocuments(question, [scope], saved.versions, signal)
  }

  async function saveCurrentSpace(signal: AbortSignal) {
    const current = workspaceRef.current
    return saveLocalCopies(current.documents.filter(document => document.spaceId === space.id), current.spaces, signal, reflectAlignedDocument)
  }

  function saveSpace() {
    const name = spaceName.trim()
    if (!name) { message.warning('请给空间起一个名字。'); return }
    if (name.length > 24) { message.warning('空间名称请控制在 24 字以内。'); return }
    const next: Space = { id: editingSpace?.id ?? uid(), name, description: spaceDescription.trim(), icon: spaceIcon, color: editingSpace?.color ?? '#555555' }
    if (editingSpace) setData(previous => ({ ...previous, spaces: previous.spaces.map(item => item.id === next.id ? next : item) }))
    else {
      const nextConversation = newConversation(next.id)
      setData(previous => ({ ...previous, spaces: [...previous.spaces, next], conversations: [nextConversation, ...previous.conversations], selectedSpaceId: next.id, selectedConversationId: nextConversation.id }))
      setScopeIds([next.id]); setSource(null)
    }
    setSpaceModalOpen(false); message.success(editingSpace ? '空间已更新' : '新的知识空间已创建')
  }

  function deleteSpace(target: Space) {
    const count = data.documents.filter(document => document.spaceId === target.id).length
    const cardCount = data.knowledgeCards?.filter(card => card.spaceId === target.id).length ?? 0
    modal.confirm({ title: `删除“${target.name}”？`, content: `将移除 ${count} 份资料、${cardCount} 张卡片和关联会话，并撤下本机索引；本机历史文件暂不清理。`, okText: '删除空间', okButtonProps: { danger: true }, cancelText: '取消', onOk: async () => {
      const ids = workspaceRef.current.documents.filter(document => document.spaceId === target.id).map(document => document.id)
      let retired = false
      try {
        if (ids.length) { await retireIndexedDocuments(ids); retired = true }
        await removeLibraryItems(ids, target.id)
      } catch (error) {
        message.error(retired ? '本机索引已撤下，浏览器空间移除未完成，请重试删除。' : error instanceof Error ? error.message : '删除没有完成，请重试。')
        throw error
      }
      setData(previous => {
        const spaces = previous.spaces.filter(item => item.id !== target.id)
        const conversations = previous.conversations.filter(item => item.spaceId !== target.id)
        const fallbackSpace = spaces[0]
        const fallbackConversation = conversations.find(item => item.spaceId === fallbackSpace?.id)
        const selected = previous.selectedSpaceId === target.id
        return { ...previous, spaces, conversations, knowledgeCards: previous.knowledgeCards?.filter(item => item.spaceId !== target.id), documents: previous.documents.filter(item => item.spaceId !== target.id), selectedSpaceId: selected ? fallbackSpace?.id ?? '' : previous.selectedSpaceId, selectedConversationId: selected ? fallbackConversation?.id ?? '' : previous.selectedConversationId }
      })
      setScopeIds(previous => { const remaining = previous.filter(id => id !== target.id); return remaining.length ? remaining : data.spaces.filter(item => item.id !== target.id).slice(0, 1).map(item => item.id) }); setSource(null)
    } })
  }

  function openSearch(kind: SearchKind | 'all' = 'all') {
    setSearchKind(kind); setSearchOpen(true); setSidebarOpen(false)
  }

  function navigateSearchResult(result: WorkspaceSearchResult) {
    if (result.kind === 'document') {
      const item = data.documents.find(document => document.id === result.item.id && data.spaces.some(space => space.id === document.spaceId))
      if (item) openReader(item)
      else message.info('这份资料已删除或不在当前工作区。')
    } else if (result.kind === 'card') setRelatedCard({ cardId: result.item.id, title: result.item.title, summary: result.item.summary })
    else if (result.kind === 'space') selectSpace(result.item.id, 'documents')
    else {
      const item = data.conversations.find(conversation => conversation.id === result.item.id && !conversation.documentId && data.spaces.some(space => space.id === conversation.spaceId))
      if (!item) { message.info('这段对话已不在当前工作区。'); return }
      setData(previous => ({ ...previous, selectedSpaceId: item.spaceId, selectedConversationId: item.id }))
      setScopeIds(validScope(item.messages.at(-1)?.scopeIds ?? [item.spaceId], item.spaceId))
      setPage('chat'); setSidebarOpen(false); setSource(null); closeSourcePanel()
    }
  }
  searchResultAction.current = navigateSearchResult

  async function openSearchResult(result: WorkspaceSearchResult) {
    if (searchNavigationPending.current) return
    const guard = page === 'reader' && result.kind !== 'card' ? readerNavigationGuard.current : null
    if (page === 'reader' && result.kind !== 'card' && (!guard || guard.documentId !== readerDocumentId)) return
    searchNavigationPending.current = true
    setSearchOpen(false)
    try {
      if (guard && (!await guard.beforeLeave() || readerNavigationGuard.current !== guard)) return
      // Saving can update the workspace: resolve the target using the newest render.
      searchResultAction.current(result)
    } catch {
      message.error('当前资料未能保存，请保留页面中的内容后重试。')
    } finally {
      searchNavigationPending.current = false
    }
  }

  const sidebar = <div className="sidebar-content">
    <div className="sidebar-brand-row">
      <a className="brand" href="#" onClick={event => { event.preventDefault(); setPage('chat'); setSidebarOpen(false) }} aria-label="LoreDock 工作台"><strong>LoreDock</strong></a>
    </div>
    <button className="sidebar-quick-search" onClick={() => openSearch()} aria-label="快速查找" aria-keyshortcuts="Control+k Meta+k"><Search size={16} /><span>快速查找</span><kbd>Ctrl K</kbd></button>
    <nav className="primary-nav" aria-label="主导航">
      {([{ id: 'chat', label: '智能问答', Icon: MessageSquare }, { id: 'documents', label: '资料库', Icon: FolderOpen }, { id: 'cards', label: '知识卡片', Icon: StickyNote }, { id: 'spaces', label: '知识空间', Icon: Layers2 }] as const).map(item => <button key={item.id} className={`nav-item ${page === item.id ? 'active' : ''}`} aria-current={page === item.id ? 'page' : undefined} onClick={() => { setPage(item.id); setSidebarOpen(false); if (item.id === 'cards') closeSourcePanel() }}><item.Icon size={18} /><span>{item.label}</span></button>)}
    </nav>
    {(page === 'chat' || page === 'documents') && <div className="sidebar-space-picker">
      <label htmlFor="sidebar-space">当前空间</label>
      <Select id="sidebar-space" aria-label="切换当前空间" variant="borderless" value={space?.id} placeholder="选择空间" options={data.spaces.map(item => ({value:item.id,label:item.name}))} onChange={id => selectSpace(id)} />
    </div>}
    {page === 'chat' && <details className="sidebar-history"><summary>最近对话</summary>
    <div className="conversation-list">{data.conversations.filter(item => item.spaceId === space?.id && !item.documentId && item.messages.length).slice(0, 5).map(item => <button className={`conversation-link ${item.id === conversation?.id && page === 'chat' ? 'selected' : ''}`} key={item.id} onClick={() => { setData(previous => ({ ...previous, selectedConversationId: item.id })); setScopeIds(validScope(item.messages.at(-1)?.scopeIds ?? [item.spaceId], item.spaceId)); setPage('chat'); setSidebarOpen(false); setSource(null) }}><MessageSquare size={14} /><span>{item.title}</span></button>)}{!data.conversations.some(item => item.spaceId === space?.id && !item.documentId && item.messages.length) && <p className="conversation-empty">暂无对话</p>}</div>
    <button type="button" className="sidebar-history-all" onClick={() => openSearch('conversation')}>查看全部对话<ChevronRight size={13} /></button>
    </details>}
    <div className="sidebar-bottom sidebar-utilities">
      <button className="sidebar-settings" onClick={() => { setModelSettingsOpen(true); setSidebarOpen(false) }}><Settings2 size={17} />设置{!backendReady && <span className="sidebar-offline">离线</span>}</button>
      <button className="icon-button" aria-label="工作区备份与迁移" title="工作区备份与迁移" onClick={() => { setBackupOpen(true); setSidebarOpen(false) }}><Database size={17} /></button>
      <button className="icon-button" aria-label="使用说明" onClick={() => { setHelpOpen(true); setSidebarOpen(false) }}><HelpCircle size={17} /></button>
    </div>
  </div>

  const sourceDocument = source ? data.documents.find(document => document.id === source.citation.documentId) : null
  const stale = source && (!sourceDocument ? 'deleted' : sourceDocument.version !== source.citation.version ? 'updated' : null)
  const readerView = readerDocument && readerConversation && <DocumentReader
    key={readerDocument.id}
    document={readerDocument}
    navigationGuardRef={readerNavigationGuard}
    documents={data.documents.filter(item => item.spaceId === readerDocument.spaceId)}
    spaceName={data.spaces.find(item => item.id === readerDocument.spaceId)?.name ?? '知识空间'}
    onSelectDocument={id => { const next = data.documents.find(item => item.id === id); if (next) openReader(next) }}
    onOpenLink={openNoteLink}
    onSave={saveReaderDocument}
    onCreateCard={createCardFromSelection}
    onGenerateCards={generateReadingCards}
    onBack={() => setPage('documents')}
    citation={readerCitation}
    onSnapshotChange={setReaderSnapshot}
    citationNavigationKey={readerCitationNavigation}
    onNewConversation={newReaderConversation}
    onAskSelection={explainSelection}
    conversationKey={readerConversation.id}
    aiPanel={(needsSave, saveDocument, selection, setSelection, focusInputKey, fullSelection, article) => <ChatWorkspace compact
      space={data.spaces.find(item => item.id === readerDocument.spaceId) ?? space!}
      spaces={data.spaces} documents={[readerDocument]}
      conversation={readerConversation} scopeIds={[readerDocument.spaceId]}
      draft={drafts[readerConversation.id] ?? ''} busy={pending.includes(readerConversation.id) || Boolean(workshop.state?.busy)}
      cardBusy={Boolean(workshop.state?.busy)}
      isCardCommand={value => Boolean(readingCardIntent(value))}
      cardPanel={workshop.state && <CardWorkshop state={workshop.state} controller={workshop.controller} sessionId={readerConversation.id}
        spaceName={data.spaces.find(item => item.id === workshop.state!.source.spaceId)?.name ?? '已删除空间'} onRun={runCardBatches}
        onRetryRevision={() => reviseReadingCards(workshop.state!.lastInstruction)} />}
      documentTitle={`${readerDocument.title} · V${readerSnapshot && readerCitation ? readerCitation.version + ' 摘录' : readerDocument.version}`}
      onDraftChange={value => setDrafts(previous => ({ ...previous, [readerConversation.id]: value }))}
      onScopeChange={() => {}}
      referenceDocuments={readerConversation.referenceDocuments === true}
      onReferenceDocumentsChange={enabled => setReferenceDocuments(readerConversation, enabled)}
      documentNeedsSave={needsSave} onSaveDocument={saveDocument}
      readingSelection={selection} onReadingSelectionChange={setSelection}
      focusInputKey={focusInputKey}
      onSend={value => routeReaderQuestion(value, selection, fullSelection, article)}
      onCancel={() => { if (workshop.state?.busy) workshop.controller.stop(); else cancelQuestion(readerConversation) }}
      onOpenCitation={citation => openCitation(citation)}
      onOpenRelatedCard={setRelatedCard}
      onUpload={() => openUpload()} onNewConversation={newReaderConversation}
      modelControls={modelPicker()}
    />}
  />
  const cardsView = <KnowledgeCards cards={data.knowledgeCards ?? []} spaces={data.spaces} currentSpaceId={space?.id ?? ''} onSave={saveCard} onDelete={removeCard} onSaveGenerated={saveGeneratedCards} provider={selectedProvider} model={selectedModel} reasoning={reasoning} modelControls={modelPicker()} initialDraft={cardDraft} onDraftConsumed={() => setCardDraft(undefined)} />
  const inspector = <div className="inspector-content">
    <div className="inspector-heading"><div><BookOpen size={16} /><span>{source ? '核对原文' : '空间资料'}</span></div>{narrow ? <button className="icon-button" onClick={closeSourcePanel} aria-label="关闭原文面板"><X size={17} /></button> : <button className="icon-button" aria-label="关闭原文面板" onClick={closeSourcePanel}><X size={17} /></button>}</div>
    {source ? <><div className="source-document-title"><span className="file-symbol"><FileText size={21} /></span><span className="tiny-label">{source.kind === 'citation' ? '本次引用资料' : '文档预览'}</span><h2>{source.citation.title}</h2><div className="source-version"><span>V{source.citation.version}</span><span>·</span><span>{sourceDocument?.type.toUpperCase() ?? '原资料'}</span><span className="source-status"><span className="status-dot" />{stale ? '历史来源' : '可查看原文'}</span></div></div><div className="source-tabs"><button className={sourceTab === 'text' ? 'active' : ''} onClick={() => setSourceTab('text')}>原文内容</button><button className={sourceTab === 'info' ? 'active' : ''} onClick={() => setSourceTab('info')}>资料信息</button></div><div className="source-scroll">{stale && <div className="source-warning">{stale === 'deleted' ? '原资料已删除，以下保留当时的引用摘录。' : '资料已更新，以下为引用时的旧版本摘录。'}</div>}{sourceTab === 'text' ? <><div className="source-location"><span>章节定位</span><p>{source.citation.heading}</p></div><article className="source-markdown"><ReactMarkdown skipHtml components={{ img: ({ alt }) => <span>[图片{alt ? `：${alt}` : ""}]</span> }}>{source.citation.excerpt}</ReactMarkdown></article><div className="source-note"><Check size={14} />{source.kind === 'citation' ? '你可以对照原文，核对回答的依据。' : '这是浏览器内保存的文本原文。'}</div></> : <dl className="source-metadata"><dt>文件名称</dt><dd>{sourceDocument?.fileName ?? '原资料已删除'}</dd><dt>所属空间</dt><dd>{data.spaces.find(item => item.id === sourceDocument?.spaceId)?.name ?? '—'}</dd><dt>内容版本</dt><dd>V{source.citation.version}{stale === 'updated' ? `（当前 V${sourceDocument?.version}）` : ''}</dd><dt>资料来源</dt><dd>{sourceDocument?.isDemo ? '教学示例资料' : '本地上传'}</dd><dt>最近更新</dt><dd>{sourceDocument ? new Date(sourceDocument.updatedAt).toLocaleString('zh-CN', { hour12: false }) : '—'}</dd></dl>}</div><div className="inspector-footer"><button onClick={() => { setSource(null); setSourceTab('text') }}><ChevronLeft size={15} />返回空间资料</button></div></> : <><div className="inspector-intro"><p>选择资料查看原文</p></div><div className="inspector-files">{documents.map(document => <button className="inspector-file" key={document.id} onClick={() => openCitation(citationFor(document), 'document')}><span className="mini-file-icon"><FileText size={18} /></span><span><strong>{document.title}</strong><small>{document.type.toUpperCase()}<span>·</span>V{document.version}</small></span><ChevronRight size={14} /></button>)}{!documents.length && <div className="inspector-empty"><FolderOpen size={29} /><p>这个空间还没有资料</p><button onClick={() => openUpload()}>上传第一份资料 <ArrowRight size={13} /></button></div>}</div><div className="inspector-footer"><span><Database size={13} />{documents.length} 份资料 · 当前空间</span></div></>}
  </div>

  if (!loaded) return <div className="workspace-loading"><Layers2 size={29} /><span>正在打开你的知识空间…</span></div>

  return <div className={`app-shell${page === 'reader' ? ' app-reading' : ''}`}>
    {!mobile && page !== 'reader' && <aside className="sidebar">{sidebar}</aside>}
    <div className="workspace-shell">{mobile && page !== 'reader' && <header className="topbar mobile-topbar">
      <button className="icon-button" aria-label="打开导航" onClick={() => setSidebarOpen(true)}><Menu size={20} /></button>
      <span>{page === 'cards' || page === 'spaces' ? 'LoreDock' : space?.name ?? 'LoreDock'}</span>
      <button className="icon-button mobile-search" aria-label="快速查找" onClick={() => openSearch()}><Search size={18} /></button>
    </header>}

      <div className="workspace-body"><main className={`main-content page-${page}`}>{page !== 'reader' && noteImports.filter(item => !data.importedBatchIds?.includes(importBatchKey(item))).map(item => <div className="notes-import-banner" key={item.id}><span><strong>{item.title}</strong><small>{item.count} 篇已整理 · 代码保留 · 评估题单独留档</small></span><Button size="small" loading={notesImporting} onClick={() => { void importStudyNotes(item) }}>导入学习笔记</Button></div>)}{page === 'chat' && <div className="workspace-titlebar"><span>{space?.name ?? '智能问答'}</span><div><button className="subtle-button" onClick={createConversation} disabled={!space}><Plus size={15} />新对话</button><button className="icon-button" aria-label={(narrow ? sourceOpen : desktopInspectorOpen) ? '关闭来源侧栏' : '打开来源侧栏'} onClick={toggleSourcePanel}>{(narrow ? sourceOpen : desktopInspectorOpen) ? <PanelRightClose size={17} /> : <PanelRightOpen size={17} />}</button></div></div>}

      {page === 'cards' ? cardsView : page === 'reader' && readerView ? readerView : !space || page === 'spaces' ? <div className="spaces-page">
        <header className="spaces-heading"><div className="spaces-heading-title"><h1>知识空间</h1><span className="spaces-count" aria-label={`${data.spaces.length} 个空间`}>{data.spaces.length}</span></div><Button type="primary" icon={<Plus size={16} />} onClick={() => openSpaceEditor()}>新建空间</Button></header>
        <div className="space-cards">{data.spaces.map(item => {
          const Icon = icons[item.icon]
          const count = data.documents.filter(document => document.spaceId === item.id).length
          return <article className="space-card" key={item.id}>
            <button className="space-card-open" onClick={() => selectSpace(item.id, 'chat')} aria-label={`打开${item.name}`}>
              <span className="space-card-icon" data-icon={item.icon}><Icon size={20} /></span>
              <span className="space-card-copy"><span className="space-card-name">{item.name}</span>{item.description && <span className="space-card-description">{item.description}</span>}</span>
              <span className="space-card-count">{count} 份资料</span>
              <ChevronRight className="space-card-arrow" size={16} aria-hidden="true" />
            </button>
            <Dropdown trigger={['click']} menu={{items:[{key:'edit',label:'编辑空间',onClick:()=>openSpaceEditor(item)},{key:'delete',label:'删除空间',danger:true,onClick:()=>deleteSpace(item)}]}}>
              <button className="icon-button" aria-label={`管理${item.name}`}><Ellipsis size={18} /></button>
            </Dropdown>
          </article>
        })}</div>
      </div> : page === 'documents' ? <DocumentLibrary onToggleSources={toggleSourcePanel} space={space} documents={documents} onUpload={() => openUpload()} onPreview={document => openReader(document)} onDelete={deleteDocument} onSearchContent={() => setLocalSearchOpen(true)} onRetry={id => { setData(previous => ({ ...previous, documents: previous.documents.map(document => document.id === id ? { ...document, status: 'available', failureReason: undefined } : document) })); message.info('已重新读取文本，可展开筛选检索正文。') }} onUpdate={document => openUpload(document)} /> : conversation ? <ChatWorkspace space={space} spaces={data.spaces} documents={scopedDocuments} conversation={conversation} scopeIds={scopeIds} draft={drafts[conversation.id] ?? ''} busy={busy} onDraftChange={value => setDrafts(previous => ({ ...previous, [conversation.id]: value }))} onScopeChange={setScopeIds} referenceDocuments={conversation.referenceDocuments === true} onReferenceDocumentsChange={enabled => setReferenceDocuments(conversation, enabled)} onSend={value => { void sendQuestion(value) }} onCancel={() => cancelQuestion()} onOpenCitation={citation => openCitation(citation)} onOpenRelatedCard={setRelatedCard} onUpload={() => openUpload()} onNewConversation={createConversation} modelControls={modelPicker()} /> : <div className="conversation-start"><button className="upload-primary" onClick={createConversation}><Plus size={16} />开始一段新对话</button></div>}
      </main>{!narrow && desktopInspectorOpen && page !== 'spaces' && page !== 'reader' && page !== 'cards' && <aside className="source-inspector">{inspector}</aside>}</div>
    </div>
    <WorkspaceBackup open={backupOpen} onClose={() => setBackupOpen(false)} />
    <Modal title={cardSource?.title ?? '参考卡片'} open={Boolean(cardSource)} onCancel={() => setCardSource(null)} footer={null} width={640}>
      {cardSource && <div className="chat-card-source"><p>本轮卡片快照 · V{cardSource.version}{cardSource.isAiDraft ? ' · AI 生成草稿' : ''}</p>{!data.knowledgeCards?.some(card => card.id === cardSource.cardId && card.version === cardSource.version) && <p>卡片已更新或删除，以下保留回答时的内容。</p>}<article className="chat-markdown"><ReactMarkdown skipHtml remarkPlugins={[remarkGfm]} components={{ table: ({ children }) => <div className="chat-table-scroll" tabIndex={0} role="region" aria-label="卡片表格，可横向滚动"><table>{children}</table></div>, a: ({ children, href }) => <a href={href} target="_blank" rel="noreferrer noopener">{children}</a>, img: ({ alt }) => <span>[图片{alt ? `：${alt}` : ''}]</span> }}>{cardSource.excerpt}</ReactMarkdown></article></div>}
    </Modal>
    <Modal title={displayedRelatedCard?.title ?? relatedCard?.title ?? '知识卡片'} open={Boolean(relatedCard)} onCancel={() => setRelatedCard(null)} footer={null} width={640}>
      {displayedRelatedCard ? <div className="chat-card-source">
        <p>{data.spaces.find(item => item.id === displayedRelatedCard.spaceId)?.name ?? '知识卡片'} · V{displayedRelatedCard.version}{displayedRelatedCard.generation ? ' · AI 生成草稿' : ''}</p>
        {displayedRelatedCard.summary && <div className="chat-related-card-summary">{displayedRelatedCard.summary}</div>}
        <article className="chat-markdown"><ReactMarkdown skipHtml remarkPlugins={[remarkGfm]} components={{ table: ({ children }) => <div className="chat-table-scroll" tabIndex={0} role="region" aria-label="卡片表格，可横向滚动"><table>{children}</table></div>, a: ({ children, href }) => <a href={href} target="_blank" rel="noreferrer noopener">{children}</a>, img: ({ alt }) => <span>[图片{alt ? `：${alt}` : ''}]</span> }}>{displayedBody(displayedRelatedCard)}</ReactMarkdown></article>
      </div> : <p>这张卡片已删除或不在当前工作区。</p>}
    </Modal>
    <Drawer placement="left" open={sidebarOpen} onClose={() => setSidebarOpen(false)} size={252} styles={{ body: { padding: 0 }, header: { display: 'none' } }} rootClassName="navigation-drawer">{sidebar}</Drawer>
    <Drawer title={null} placement="right" open={narrow && sourceOpen} onClose={closeSourcePanel} size={mobile ? '100%' : 390} styles={{ body: { padding: 0 }, header: { display: 'none' } }} rootClassName="source-drawer">{inspector}</Drawer>
    <Modal title={updatingDocument ? '替换资料文件' : '上传资料'} open={uploadOpen} footer={null} onCancel={() => { if (!uploadBusy) setUploadOpen(false) }} destroyOnHidden width={510}><div className="upload-dialog-content"><label className="field-label">所属空间</label><Select value={uploadSpaceId} onChange={setUploadSpaceId} disabled={uploadBusy || Boolean(updatingDocument)} options={data.spaces.map(item => ({ value: item.id, label: item.name }))} style={{ width: '100%' }} /><Upload.Dragger accept=".md,.txt" multiple={false} showUploadList={false} disabled={uploadBusy} beforeUpload={importFile}><div className="upload-drop-icon"><UploadCloud size={29} /></div><strong>{uploadBusy ? '正在读取文件…' : '拖动文件到这里，或点击选择'}</strong><p>Markdown、UTF-8 TXT · 单文件最大 20 MiB</p></Upload.Dragger>{uploadError && <div className="upload-error" role="alert">{uploadError}</div>}<div className="upload-boundary"><Database size={16} /><p>文件先保存到当前浏览器。检索正文或提问时，会保存本机副本并建立关键词索引；请保留原文件。</p></div>{updatingDocument && <div className="upload-update-note">新文件将成为 V{updatingDocument.version + 1}。已有对话保留原版本引用，并显示“资料已更新”。</div>}</div></Modal>
    <Modal title={editingSpace ? '编辑知识空间' : '创建知识空间'} open={spaceModalOpen} onCancel={() => setSpaceModalOpen(false)} onOk={saveSpace} okText="保存空间" cancelText="取消" width={470}><div className="space-form"><label className="field-label" htmlFor="space-name">空间名称</label><Input id="space-name" placeholder="例如：我的毕业设计" maxLength={24} showCount value={spaceName} onChange={event => setSpaceName(event.target.value)} /><label className="field-label" htmlFor="space-description">一句话介绍</label><Input.TextArea id="space-description" placeholder="这个空间会存放什么？" maxLength={120} rows={3} value={spaceDescription} onChange={event => setSpaceDescription(event.target.value)} /><label className="field-label">空间图标</label><div className="space-icon-options">{(Object.keys(icons) as Space['icon'][]).map(name => { const Icon = icons[name]; return <button className={name === spaceIcon ? 'selected' : ''} key={name} aria-label={`选择${name}图标`} onClick={() => setSpaceIcon(name)}><Icon size={20} /></button> })}</div></div></Modal>
    <WorkspaceSearch open={searchOpen} data={data} initialKind={searchKind} onClose={() => setSearchOpen(false)} onSelect={openSearchResult} />
    <LocalSearch key={space?.id ?? 'none'} open={localSearchOpen} onClose={() => setLocalSearchOpen(false)} spaceName={space?.name ?? ''} documentCount={documents.filter(document => document.status === 'available' && document.body.trim()).length} onSearch={searchLocal} onSave={saveCurrentSpace} onOpenCitation={citation => openCitation(citation)} />
    <ModelSettings open={modelSettingsOpen} onClose={() => setModelSettingsOpen(false)} onChanged={providersChanged} /><Modal title="关于 LoreDock" open={helpOpen} footer={<Button type="primary" onClick={() => setHelpOpen(false)}>开始探索</Button>} onCancel={() => setHelpOpen(false)} width={480}><div className="help-content"><span className="help-logo"><Layers2 size={25} /></span><h2>LoreDock，个人知识工作台。</h2><p>主界面与阅读侧栏都可以直接问 AI。回答下方会展示本地匹配的相关知识卡片，点击即可查看。需要结合文档时，勾选“参考资料”或“参考本文”。</p><p>选中正文后点“AI 生成卡片”，或在侧栏说“把这段整理成卡片”。草稿可展开编辑，也可说“第二张简短一点”；勾选两张后说“合并这两张”。顶部星光按钮可按章节处理整篇，支持停止与重试。核对后点击“确认保存选中”才保存到文章所属空间；刷新会丢失未保存草稿。</p><p>在模型设置中填写 API 地址、密钥与模型 ID。问题、对话历史与本轮参考内容会发送至所选服务并使用 API 额度。相关卡片仅在本地展示，不会作为回答依据发送给模型；显式修改草稿时会发送选中的草稿和原文依据，AI 内容仍需核对。编辑和会话保存在当前浏览器。</p><button className="try-example" onClick={() => { const target = data.spaces.find(item => item.id === 'python') ?? space; if (!target) return; const id = selectSpace(target.id, 'chat'); setHelpOpen(false); if (id) setDrafts(previous => ({ ...previous, [id]: target.id === 'python' ? EXAMPLE_QUESTION : '请解释一个知识点，并给出简单例子。' })) }}><Sparkles size={16} />试试示例问题<ArrowRight size={15} /></button></div></Modal>
  </div>
}
