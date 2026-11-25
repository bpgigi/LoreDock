import { useEffect, useRef, useState } from 'react'
import { App as AntApp, Button, Input, Modal, Spin } from 'antd'
import { Check, KeyRound, Plus, RefreshCw, Server, Trash2 } from 'lucide-react'
import { deleteProvider, getModels, getProviders, saveProvider } from '../api'
import type { ProviderProfile } from '../api'
import './ModelSettings.css'

export interface ModelSettingsProps {
  open: boolean
  onClose: () => void
  onChanged: (providers: ProviderProfile[]) => void
}

const errorMessage = (error: unknown) => error instanceof Error ? error.message : '操作未完成，请重试。'

export default function ModelSettings({ open, onClose, onChanged }: ModelSettingsProps) {
  const { message, modal } = AntApp.useApp()
  const [profiles, setProfiles] = useState<ProviderProfile[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [defaultModel, setDefaultModel] = useState('')
  const [models, setModels] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [readingModels, setReadingModels] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [formError, setFormError] = useState('')
  const [modelsError, setModelsError] = useState('')
  const epoch = useRef(0)
  const selected = profiles.find((profile) => profile.id === selectedId)
  const endpointChanged = Boolean(selected && baseUrl.trim().replace(/\/$/, '') !== selected.base_url.replace(/\/$/, ''))
  const connectionChanged = endpointChanged || Boolean(apiKey.trim())

  function showProfile(profile?: ProviderProfile) {
    epoch.current += 1
    setSelectedId(profile?.id ?? null)
    setName(profile?.name ?? '')
    setBaseUrl(profile?.base_url ?? '')
    setDefaultModel(profile?.default_model ?? '')
    setApiKey('')
    setModels([])
    setFormError('')
    setModelsError('')
    setReadingModels(false)
  }

  async function loadProfiles() {
    const token = ++epoch.current
    setLoading(true)
    setLoadError('')
    try {
      const result = await getProviders()
      if (token !== epoch.current) return
      setProfiles(result.providers)
      onChanged(result.providers)
      showProfile(result.providers[0])
    } catch (error) {
      if (token === epoch.current) setLoadError(errorMessage(error))
    } finally {
      // showProfile intentionally advances the epoch after a successful load.
      if (token === epoch.current || token + 1 === epoch.current) setLoading(false)
    }
  }

  useEffect(() => {
    if (open) {
      void loadProfiles()
    } else {
      epoch.current += 1
      setApiKey('')
      setModels([])
      setFormError('')
      setModelsError('')
      setReadingModels(false)
    }
    return () => { epoch.current += 1 }
    // Fetch when this dialog opens; parent callbacks need not retrigger secret-entry forms.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  async function save() {
    if (saving) return
    if (!name.trim()) { setFormError('请填写配置名称。'); return }
    if (!defaultModel.trim()) { setFormError('请填写模型 ID，可在服务商控制台查看。'); return }
    try {
      const url = new URL(baseUrl.trim())
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error()
    } catch { setFormError('请填写有效的 API Base URL，不包含密钥、查询参数或用户名。'); return }
    if (endpointChanged && selected?.has_api_key && !apiKey.trim()) {
      setFormError('接口地址已改变，请填写新服务的 API Key，再保存。')
      return
    }
    setSaving(true)
    setFormError('')
    const token = epoch.current
    try {
      const result = await saveProvider(selectedId ?? crypto.randomUUID(), {
        name: name.trim(), base_url: baseUrl.trim(), default_model: defaultModel.trim(),
        ...(apiKey.trim() ? { api_key: apiKey.trim() } : {}),
      })
      if (token !== epoch.current) return
      const next = profiles.some((item) => item.id === result.id)
        ? profiles.map((item) => item.id === result.id ? result : item)
        : [...profiles, result]
      setProfiles(next)
      onChanged(next)
      showProfile(result)
      message.success('模型配置已保存')
    } catch (error) {
      if (token === epoch.current) setFormError(errorMessage(error))
    } finally { setSaving(false) }
  }

  async function readModels() {
    if (!selected || readingModels || connectionChanged) return
    const token = epoch.current
    setReadingModels(true)
    setModelsError('')
    try {
      const result = await getModels(selected.id)
      if (token !== epoch.current) return
      setModels(result.models)
      if (!result.models.length) setModelsError('服务未返回模型列表，请手动填写模型 ID。')
    } catch (error) {
      if (token === epoch.current) setModelsError(`${errorMessage(error)} 部分服务不提供模型列表，可直接手动填写模型 ID。`)
    } finally { if (token === epoch.current) setReadingModels(false) }
  }

  function removeSelected() {
    if (!selected || saving) return
    const target = selected
    modal.confirm({
      title: `删除“${target.name}”的模型配置？`,
      content: '这会移除该服务的本地密钥和配置，资料与会话仍会保留。',
      okText: '删除配置', cancelText: '取消', okButtonProps: { danger: true },
      onOk: async () => {
        setSaving(true)
        try {
          await deleteProvider(target.id)
          const next = profiles.filter((item) => item.id !== target.id)
          setProfiles(next)
          onChanged(next)
          showProfile(next[0])
          message.success('模型配置已删除')
        } catch (error) {
          message.error(errorMessage(error))
          throw error
        } finally { setSaving(false) }
      },
    })
  }

  return <Modal title={<span className="model-settings-title"><Server size={18} />模型与 API</span>} open={open} onCancel={() => { if (!saving) onClose() }} footer={null} width={800} destroyOnHidden rootClassName="model-settings-modal" maskClosable={!saving} closable={!saving}>
    <p className="model-settings-intro">填写接口地址、密钥和模型 ID，接入自定义服务。</p>
    {loading ? <div className="model-settings-loading"><Spin size="small" /><span>正在读取本地配置…</span></div> : loadError ? <div className="model-settings-unavailable" role="alert"><Server size={25} /><strong>暂时无法读取模型配置</strong><p>{loadError}</p><p>请先启动 LoreDock 本地后端，再重试。</p><Button onClick={() => void loadProfiles()} icon={<RefreshCw size={14} />}>重试连接</Button></div> : <div className="model-settings-layout">
      <aside className="model-provider-sidebar" aria-label="已保存服务">
        <div className="model-provider-caption">已保存服务</div>
        <div className="model-provider-list">{profiles.map((profile) => <button type="button" key={profile.id} className={`model-provider-item${selectedId === profile.id ? ' selected' : ''}`} disabled={saving} onClick={() => showProfile(profile)}><span className="model-provider-name">{profile.name}</span><span className="model-provider-meta">{profile.default_model}</span>{selectedId === profile.id && <Check size={13} aria-hidden="true" />}</button>)}</div>
        {!profiles.length && <p className="model-provider-empty">还没有保存的服务</p>}
        <button type="button" className={`model-provider-new${!selectedId ? ' selected' : ''}`} disabled={saving} onClick={() => showProfile()}><Plus size={15} />添加自定义服务</button>
      </aside>
      <form className="model-settings-form" onSubmit={(event) => { event.preventDefault(); void save() }}>
        <div className="model-form-heading"><h3>{selected ? '编辑自定义服务' : '自定义服务'}</h3>{selected && <Button size="small" type="text" disabled={saving} onClick={removeSelected} icon={<Trash2 size={13} />}>删除</Button>}</div>
        <label htmlFor="model-profile-name" className="model-field-label">配置名称</label>
        <Input id="model-profile-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：我的自定义服务" maxLength={80} disabled={saving} autoComplete="off" />
        <label htmlFor="model-api-url" className="model-field-label">API Base URL</label>
        <Input id="model-api-url" value={baseUrl} onChange={(event) => { setBaseUrl(event.target.value); setModels([]) }} placeholder="https://example.com/v1" maxLength={500} disabled={saving} autoComplete="off" spellCheck={false} />
        {endpointChanged && selected?.has_api_key && <p className="model-field-help">地址已改变，请填写新服务对应的 API Key。</p>}
        <label htmlFor="model-api-key" className="model-field-label"><span>API Key</span>{selected?.has_api_key && <span className="model-key-status"><KeyRound size={11} />已保存 {selected.key_hint}</span>}</label>
        <Input.Password id="model-api-key" name="loredock-api-key" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={selected?.has_api_key ? '留空保留已保存的密钥' : '填写服务商提供的 API Key'} disabled={saving} autoComplete="new-password" spellCheck={false} />
        <p className="model-field-help">密钥加密保存在本机后端，不写入浏览器存储。</p>
        <label htmlFor="model-default-id" className="model-field-label">默认模型 ID</label>
        <Input id="model-default-id" value={defaultModel} onChange={(event) => setDefaultModel(event.target.value)} placeholder="填写当前账号可用的模型 ID" maxLength={200} disabled={saving} autoComplete="off" spellCheck={false} />
        <div className="model-fetch-row"><Button size="small" loading={readingModels} disabled={!selected || saving || connectionChanged} onClick={() => void readModels()} icon={<RefreshCw size={12} />}>读取模型列表</Button><span>{!selected || connectionChanged ? '先保存配置，也可直接填写模型 ID' : '使用已保存的接口和密钥'}</span></div>
        {modelsError && <p className="model-inline-error" role="alert">{modelsError}</p>}
        {models.length > 0 && <div className="model-id-list" aria-label="可用模型">{models.map((model) => <button type="button" key={model} disabled={saving} className={defaultModel === model ? 'selected' : ''} onClick={() => setDefaultModel(model)}>{model}{defaultModel === model && <Check size={12} />}</button>)}</div>}
        {formError && <div className="model-form-error" role="alert">{formError}</div>}
        <p className="model-data-note">提问时，所选资料和问题会发送至你配置的服务。</p>
        <div className="model-form-actions"><Button disabled={saving} onClick={onClose}>关闭</Button><Button type="primary" htmlType="submit" loading={saving}>保存配置</Button></div>
      </form>
    </div>}
  </Modal>
}
