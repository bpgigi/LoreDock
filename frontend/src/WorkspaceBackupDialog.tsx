import { useRef, useState } from 'react'
import { App as AntApp, Button, Modal } from 'antd'
import { Download, Upload } from 'lucide-react'
import { exportWorkspaceBackup, restoreWorkspaceBackup } from './storage'
import { backupSummary, maximumBackupBytes, validateWorkspaceBackup } from './workspaceBackup'
import type { WorkspaceBackup as Backup } from './workspaceBackup'

function download(backup: Backup, prefix = 'LoreDock-workspace') {
  const url = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' }))
  const link = document.createElement('a')
  link.href = url
  link.download = `${prefix}-${new Date().toISOString().replaceAll(':', '-')}.json`
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
}

export default function WorkspaceBackupDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { message } = AntApp.useApp()
  const [busy, setBusy] = useState(false)
  const [incoming, setIncoming] = useState<Backup>()
  const fileInput = useRef<HTMLInputElement>(null)
  const summary = incoming ? backupSummary(incoming) : undefined
  const report = (error: unknown) => message.error(error instanceof Error ? error.message : '备份操作失败，请重试。')

  async function exportBackup() {
    setBusy(true)
    try { download(await exportWorkspaceBackup()); message.success('备份文件已生成，请确认下载完成。') }
    catch (error) { report(error) }
    finally { setBusy(false) }
  }
  async function readFile(file?: File) {
    if (!file) return
    setBusy(true)
    try {
      if (file.size > maximumBackupBytes) throw new Error('备份文件不能超过 128 MiB。')
      setIncoming(validateWorkspaceBackup(JSON.parse(await file.text())))
    } catch (error) { report(error) }
    finally { setBusy(false); if (fileInput.current) fileInput.current.value = '' }
  }
  async function restore() {
    if (!incoming) return
    setBusy(true)
    try {
      download(await exportWorkspaceBackup(), 'LoreDock-before-import')
      await restoreWorkspaceBackup(incoming)
      window.location.reload()
    } catch (error) { report(error); setBusy(false) }
  }
  return <>
    <Modal title="工作区备份与迁移" open={open} onCancel={() => { if (!busy) onClose() }} footer={null} width={510}>
      <p>备份保存的资料、空间、会话、卡片和编辑草稿，可在网页版与桌面版之间迁移。</p>
      <div style={{ display: 'flex', gap: 12, margin: '20px 0' }}>
        <Button icon={<Download size={16} />} loading={busy} onClick={() => { void exportBackup() }}>导出工作区</Button>
        <Button icon={<Upload size={16} />} disabled={busy} onClick={() => fileInput.current?.click()}>导入工作区</Button>
      </div>
      <p style={{ color: '#72767e', fontSize: 13 }}>此文件不包含 API 密钥、后端检索索引和磁盘原文。桌面软件的数据目录需另行备份。</p>
      <input ref={fileInput} type="file" accept=".json,application/json" aria-label="选择工作区备份" hidden onChange={event => { void readFile(event.target.files?.[0]) }} />
    </Modal>
    <Modal title="导入这个工作区？" open={!!incoming} confirmLoading={busy} onOk={() => { void restore() }} onCancel={() => { if (!busy) setIncoming(undefined) }} okText="备份当前数据并导入" cancelText="取消">
      <p>{summary?.documents} 份资料 · {summary?.cards} 张卡片 · {summary?.conversations} 个会话 · {summary?.drafts} 份草稿</p>
      <p>导入会替换当前工作区并重新加载。当前数据会先生成备份，并在本地保留一份恢复快照；原浏览器中的数据不受影响。</p>
    </Modal>
  </>
}
