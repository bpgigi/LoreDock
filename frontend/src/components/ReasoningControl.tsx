import { useEffect, useId, useState } from 'react'
import type { CSSProperties } from 'react'
import { Popover } from 'antd'
import { Brain, ChevronDown } from 'lucide-react'
import { availableReasoningEfforts, reasoningDescriptions, reasoningLabels } from '../reasoning'
import type { ReasoningSetting } from '../reasoning'
import './ReasoningControl.css'

interface Props {
  model: string
  providerId: string
  value: ReasoningSetting
  onChange: (value: ReasoningSetting) => void
}

export default function ReasoningControl({ model, providerId, value, onChange }: Props) {
  const [open, setOpen] = useState(false)
  const labelId = useId()
  const descriptionId = useId()
  const levels = availableReasoningEfforts(model)
  const isDefault = value === 'default'
  const selectedIndex = Math.max(0, levels.indexOf(isDefault ? 'medium' : value))
  const position = selectedIndex / (levels.length - 1) * 100
  useEffect(() => { setOpen(false) }, [model, providerId])

  return <Popover open={open} onOpenChange={setOpen} trigger="click" placement="topRight" arrow={false} content={
    <div className="reasoning-menu" role="dialog" aria-label="调整思考强度" onKeyDown={event => { if (event.key === 'Escape') setOpen(false) }}>
      <div className="reasoning-heading"><strong id={labelId}>思考强度</strong><button type="button" className="reasoning-default" aria-pressed={isDefault} onClick={() => onChange('default')}>模型默认</button></div>
      <div className={`reasoning-slider${isDefault ? ' is-default' : ''}`} style={{ '--reasoning-position': `${position}%`, '--reasoning-stops': levels.length } as CSSProperties}>
        <div className="reasoning-track" aria-hidden="true"><span className="reasoning-fill" />{levels.map((level, index) => <i key={level} style={{ left: `${index / (levels.length - 1) * 100}%` }} />)}<span className="reasoning-thumb" /></div>
        <input className="reasoning-range" type="range" min={0} max={levels.length - 1} step={1} value={selectedIndex}
          aria-labelledby={labelId} aria-describedby={descriptionId} aria-valuetext={isDefault ? '模型默认，使用方向键选择强度' : reasoningLabels[value]}
          onChange={event => onChange(levels[Number(event.target.value)])} onPointerUp={event => onChange(levels[Number(event.currentTarget.value)])} />
        <div className="reasoning-ticks">{levels.map(level => <button type="button" key={level} aria-pressed={value === level} onClick={() => onChange(level)}>{reasoningLabels[level]}</button>)}</div>
      </div>
      <p id={descriptionId} className="reasoning-description">{reasoningDescriptions[value]}</p>
      <p className="reasoning-note">更高强度可能增加等待时间与额度消耗。可用档位取决于模型与服务。</p>
    </div>
  }><button type="button" className="reasoning-trigger" aria-label={`调整思考强度，当前${reasoningLabels[value]}`} aria-haspopup="dialog" aria-expanded={open} disabled={!model.trim()}>
      <Brain size={15} strokeWidth={1.65} /><span>思考 · {reasoningLabels[value]}</span><ChevronDown size={12} />
    </button></Popover>
}
