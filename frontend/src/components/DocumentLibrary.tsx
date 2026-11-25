import { useEffect, useMemo, useState } from 'react'
import { Dropdown, Modal } from 'antd'
import {
  ArrowDownUp, CircleAlert, ChevronDown, FileText, FolderOpen,
  Grid2X2, List, LoaderCircle, MoreHorizontal, PanelRightOpen, Plus, RefreshCw,
  Search, Upload, X,
} from 'lucide-react'
import type { KnowledgeDocument, Space } from '../types'
import { sortLibraryDocuments } from '../documentLibrary'
import type { DocumentSort } from '../documentLibrary'
import './DocumentLibrary.css'

interface DocumentLibraryProps {
  space: Space
  documents: KnowledgeDocument[]
  onUpload: () => void
  onPreview: (document: KnowledgeDocument) => void
  onDelete: (id: string) => Promise<void>
  onRetry: (id: string) => void
  onUpdate: (document: KnowledgeDocument) => void
  onToggleSources?: () => void
  onSearchContent?: () => void
}

type FileFilter = 'all' | KnowledgeDocument['type']
type StatusFilter = 'all' | KnowledgeDocument['status']

const statusLabels: Record<KnowledgeDocument['status'], string> = {
  available: '本地可读',
  processing: '读取中',
  failed: '读取失败',
}

const sortLabels: Record<DocumentSort, string> = {
  'updated-desc': '最近更新',
  'updated-asc': '最早更新',
  title: '名称排序',
  order: '篇目顺序',
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatDate(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '时间未知'
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date).replaceAll('/', '.')
}

function excerpt(document: KnowledgeDocument): string {
  return document.body
    .replaceAll('\\n', ' ')
    .replace(/[#>*`_]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 110) || '打开资料，查看原文内容。'
}

function DocumentStatus({ status }: { status: KnowledgeDocument['status'] }) {
  if (status === 'available') return null
  return (
    <span className={`library-status library-status--${status}`}>
      {status === 'processing'
        ? <LoaderCircle size={13} className="library-spin" aria-hidden="true" />
        : <CircleAlert size={13} aria-hidden="true" />}
      {statusLabels[status]}
    </span>
  )
}

export default function DocumentLibrary({
  space, documents, onUpload, onPreview, onDelete, onRetry, onUpdate, onToggleSources, onSearchContent,
}: DocumentLibraryProps) {
  const [search, setSearch] = useState('')
  const [typeFilter, setTypeFilter] = useState<FileFilter>('all')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [groupFilter, setGroupFilter] = useState('')
  const [view, setView] = useState<'list' | 'grid'>('list')
  const [sort, setSort] = useState<DocumentSort>('updated-desc')
  const [filtersOpen, setFiltersOpen] = useState(false)

  useEffect(() => {
    setSearch('')
    setTypeFilter('all')
    setStatusFilter('all')
    setGroupFilter('')
    setFiltersOpen(false)
  }, [space.id])

  const studyGroups = useMemo(() => {
    const counts = new Map<string, number>()
    for (const document of documents) {
      const group = document.studyGroup?.trim()
      if (group) counts.set(group, (counts.get(group) ?? 0) + 1)
    }
    return [...counts].map(([name, count]) => ({ name, count }))
  }, [documents])

  useEffect(() => {
    if (groupFilter && !studyGroups.some((group) => group.name === groupFilter)) setGroupFilter('')
  }, [groupFilter, studyGroups])

  const filtered = useMemo(() => {
    const query = search.trim().toLocaleLowerCase()
    const matches = documents.filter((document) => {
      const matchesQuery = !query || `${document.title} ${document.fileName}`.toLocaleLowerCase().includes(query)
      return matchesQuery
        && (typeFilter === 'all' || document.type === typeFilter)
        && (statusFilter === 'all' || document.status === statusFilter)
        && (!groupFilter || document.studyGroup?.trim() === groupFilter)
    })
    return sortLibraryDocuments(matches, sort)
  }, [documents, search, typeFilter, statusFilter, groupFilter, sort])

  const hasFilters = Boolean(search.trim()) || typeFilter !== 'all' || statusFilter !== 'all' || Boolean(groupFilter)
  const filterCount = Number(typeFilter !== 'all') + Number(statusFilter !== 'all') + Number(Boolean(groupFilter))

  function resetFilters() {
    setSearch('')
    setTypeFilter('all')
    setStatusFilter('all')
    setGroupFilter('')
  }

  function confirmDelete(document: KnowledgeDocument) {
    Modal.confirm({
      title: '删除这份资料？',
      content: `“${document.title}”将从资料库移除，并撤下本机检索索引。历史来源仍保留版本摘录，本机历史副本暂不清理。`,
      okText: '删除资料',
      cancelText: '保留资料',
      okButtonProps: { danger: true },
      centered: true,
      onOk: () => onDelete(document.id),
    })
  }

  function MoreActions({ document }: { document: KnowledgeDocument }) {
    return (
      <span className="library-more-wrap" onClick={(event) => event.stopPropagation()}>
        <Dropdown
          trigger={['click']}
          placement="bottomRight"
          menu={{
            items: [
              { key: 'preview', label: '查看原文', icon: <FileText size={15} /> },
              { key: 'update', label: '替换文件', icon: <RefreshCw size={15} /> },
              ...(document.status === 'failed'
                ? [{ key: 'retry', label: '重新读取', icon: <RefreshCw size={15} /> }]
                : []),
              { type: 'divider' as const },
              { key: 'delete', label: '删除资料', danger: true },
            ],
            onClick: ({ key }) => {
              if (key === 'preview') onPreview(document)
              if (key === 'update') onUpdate(document)
              if (key === 'retry') onRetry(document.id)
              if (key === 'delete') confirmDelete(document)
            },
          }}
        >
          <button type="button" className="library-icon-button library-more" aria-label={`管理${document.title}`} title="更多操作">
            <MoreHorizontal size={19} />
          </button>
        </Dropdown>
      </span>
    )
  }

  return (
    <section className="library-shell" aria-label={`${space.name}资料库`}>
      <header className="library-page-header">
        <div className="library-title-row">
          <div className="library-heading">
            <h1>资料库</h1>
            <span className="library-result-count" aria-live="polite" aria-label={hasFilters ? `找到 ${filtered.length} 份资料，共 ${documents.length} 份` : `共 ${documents.length} 份资料`}>{hasFilters ? `${filtered.length} / ${documents.length}` : documents.length} 份</span>
          </div>
          <button type="button" className="library-upload-button" onClick={onUpload}>
            <Plus size={16} strokeWidth={1.8} /><span>添加资料</span>
          </button>
        </div>
      </header>

      <div className="library-toolbar">
        <div className="library-search-control">
          <Search size={16} aria-hidden="true" />
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索名称或文件名" aria-label="搜索资料名称或文件名" />
          {search && <button type="button" onClick={() => setSearch('')} aria-label="清空搜索" title="清空搜索"><X size={14} /></button>}
        </div>
        <button type="button" className={`library-filter-toggle${filterCount ? ' library-filter-toggle--active' : ''}`} onClick={() => setFiltersOpen((open) => !open)} aria-expanded={filtersOpen} aria-controls="library-filters">
          <span>筛选{filterCount ? ` · ${filterCount}` : ''}</span><ChevronDown size={14} className={filtersOpen ? 'library-chevron-open' : undefined} aria-hidden="true" />
        </button>
        <Dropdown trigger={['click']} placement="bottomRight" menu={{
          selectable: true,
          selectedKeys: [sort],
          items: Object.entries(sortLabels).map(([key, label]) => ({ key, label })),
          onClick: ({ key }) => setSort(key as DocumentSort),
        }}>
          <button type="button" className="library-sort-button" aria-label={`资料排序：${sortLabels[sort]}`} title={`资料排序：${sortLabels[sort]}`}>
            <ArrowDownUp size={15} aria-hidden="true" /><span>{sortLabels[sort]}</span>
          </button>
        </Dropdown>
      </div>

      {hasFilters && <div className="library-active-filters" aria-label="已应用的筛选">
        {search.trim() && <button type="button" className="library-filter-chip" onClick={() => setSearch('')} aria-label={`移除搜索：${search.trim()}`}><span>搜索：{search.trim()}</span><X size={12} aria-hidden="true" /></button>}
        {typeFilter !== 'all' && <button type="button" className="library-filter-chip" onClick={() => setTypeFilter('all')} aria-label="移除文件格式筛选"><span>{typeFilter === 'md' ? 'Markdown' : '纯文本'}</span><X size={12} aria-hidden="true" /></button>}
        {statusFilter !== 'all' && <button type="button" className="library-filter-chip" onClick={() => setStatusFilter('all')} aria-label="移除资料状态筛选"><span>{statusLabels[statusFilter]}</span><X size={12} aria-hidden="true" /></button>}
        {groupFilter && <button type="button" className="library-filter-chip" onClick={() => setGroupFilter('')} aria-label={`移除分组筛选：${groupFilter}`}><span>{groupFilter}</span><X size={12} aria-hidden="true" /></button>}
        <button type="button" className="library-clear-filters" onClick={resetFilters}>清除全部</button>
      </div>}

      {filtersOpen && <div className="library-filters" id="library-filters">
        <div className="library-filter-fields">
          <label className="library-filter-field">
            <span>文件格式</span>
            <select value={typeFilter} onChange={(event) => setTypeFilter(event.target.value as FileFilter)} aria-label="筛选文件格式">
              <option value="all">全部格式</option>
              <option value="md">Markdown</option>
              <option value="txt">纯文本</option>
            </select>
          </label>
          <label className="library-filter-field">
            <span>资料状态</span>
            <select value={statusFilter} aria-label="筛选资料状态" onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}>
              <option value="all">全部状态</option>
              <option value="available">本地可读</option>
              <option value="processing">读取中</option>
              <option value="failed">读取失败</option>
            </select>
          </label>
          {studyGroups.length > 0 && <label className="library-filter-field library-filter-field--group">
            <span>学习分组</span>
            <select aria-label="学习分组" value={groupFilter} onChange={(event) => setGroupFilter(event.target.value)}>
              <option value="">全部分组（{documents.length}）</option>
              {studyGroups.map((group) => <option key={group.name} value={group.name}>{group.name}（{group.count}）</option>)}
            </select>
          </label>}
        </div>
        <div className="library-filter-options">
          <div className="library-view-switch" role="group" aria-label="资料展示方式">
            <button type="button" className={view === 'list' ? 'library-option-button library-option-button--active' : 'library-option-button'} onClick={() => setView('list')} aria-label="列表视图" aria-pressed={view === 'list'}><List size={15} /><span>列表</span></button>
            <button type="button" className={view === 'grid' ? 'library-option-button library-option-button--active' : 'library-option-button'} onClick={() => setView('grid')} aria-label="网格视图" aria-pressed={view === 'grid'}><Grid2X2 size={14} /><span>网格</span></button>
          </div>
          {onToggleSources && <button type="button" className="library-option-button" onClick={onToggleSources}><PanelRightOpen size={14} /><span>查看空间资料</span></button>}
          {onSearchContent && <button type="button" className="library-option-button" onClick={onSearchContent}><Search size={14} /><span>检索正文</span></button>}
        </div>
        <p className="library-local-note" role="note">编辑保存在当前浏览器。检索正文时会保存本机副本。</p>
      </div>}

      <div className={`library-content library-content--${view}`}>
        {filtered.length > 0 ? (
          <ul className={view === 'list' ? 'library-list' : 'library-grid'}>
            {filtered.map((document) => (
              <li className={view === 'list' ? 'library-list-row' : 'library-document-card'} key={document.id} onClick={() => onPreview(document)}>
                <span className="library-file-icon" aria-hidden="true"><FileText size={19} strokeWidth={1.6} /></span>
                <div className="library-document-body">
                  <div className="library-document-heading">
                    <button type="button" className="library-document-title" title={document.title} onClick={(event) => { event.stopPropagation(); onPreview(document) }}>{document.title}</button>
                    <MoreActions document={document} />
                  </div>
                  <div className="library-document-meta" title={[document.fileName, document.studyGroup].filter(Boolean).join(' · ')}>
                    <span>{document.type.toUpperCase()}</span>
                    <span>{formatSize(document.size)}</span>
                    <time dateTime={document.updatedAt}>{formatDate(document.updatedAt)}</time>
                    {document.isDemo && <span>示例</span>}
                  </div>
                  {view === 'grid' && document.status === 'available' && <p className="library-card-excerpt">{excerpt(document)}</p>}
                  {document.status !== 'available' && <div className="library-row-status" role="status">
                    <DocumentStatus status={document.status} />
                    {document.status === 'failed' && <>
                      {document.failureReason && <span className="library-failure-reason">{document.failureReason}</span>}
                      <button type="button" className="library-retry" onClick={(event) => { event.stopPropagation(); onRetry(document.id) }}><RefreshCw size={12} />重试</button>
                    </>}
                  </div>}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <div className="library-empty-state">
            <FolderOpen className="library-empty-icon" size={28} strokeWidth={1.4} aria-hidden="true" />
            <h2>{documents.length === 0 ? '还没有资料' : '没有找到匹配的资料'}</h2>
            <p>{documents.length === 0 ? '添加 Markdown 或 TXT 文件。' : '试试其他关键词，或清除筛选。'}</p>
            {documents.length === 0 ? <button type="button" className="library-upload-button" onClick={onUpload}><Upload size={15} />上传资料</button> : <button type="button" className="library-reset-button" onClick={resetFilters}>清除筛选</button>}
          </div>
        )}
      </div>
    </section>
  )
}
