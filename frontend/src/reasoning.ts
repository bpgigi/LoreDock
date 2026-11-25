export const reasoningEfforts = ['low', 'medium', 'high', 'xhigh'] as const
export type ReasoningEffort = typeof reasoningEfforts[number]
export type ReasoningSetting = ReasoningEffort | 'default'
export interface AiPreference {
  providerId: string
  model: string
  reasoningByModel?: Record<string, ReasoningEffort>
}

export const reasoningLabels: Record<ReasoningSetting, string> = { default: '默认', low: '低', medium: '中', high: '高', xhigh: '极高' }
export const reasoningDescriptions: Record<ReasoningSetting, string> = {
  default: '跟随模型默认设置', low: '快速回应，适合简单问题', medium: '兼顾速度与思考，适合日常问答',
  high: '更深入思考，适合复杂分析与代码', xhigh: '充分思考，适合较难的推理任务',
}
export const isReasoningEffort = (value: unknown): value is ReasoningEffort => reasoningEfforts.includes(value as ReasoningEffort)
const preferenceKey = (providerId: string, model: string) => JSON.stringify([providerId, model.trim()])

// Confirmed restriction for the original model and its dated snapshots. Other
// custom IDs may be aliases; the service remains authoritative about support.
export function availableReasoningEfforts(model: string): readonly ReasoningEffort[] {
  return /^gpt-5(?:-2025-08-07)?$/i.test(model.trim()) ? reasoningEfforts.slice(0, 3) : reasoningEfforts
}

export function selectedReasoning(preference: AiPreference | undefined, providerId: string, model: string): ReasoningSetting {
  const value = preference?.reasoningByModel?.[preferenceKey(providerId, model)]
  return isReasoningEffort(value) && availableReasoningEfforts(model).includes(value) ? value : 'default'
}

export function withReasoning(preference: AiPreference | undefined, providerId: string, model: string, value: ReasoningSetting): AiPreference {
  const key = preferenceKey(providerId, model)
  const reasoningByModel = { ...preference?.reasoningByModel }
  if (value === 'default' || !availableReasoningEfforts(model).includes(value)) delete reasoningByModel[key]
  else reasoningByModel[key] = value
  return { ...preference, providerId, model, reasoningByModel }
}

/** Explicit fields only: "default" means omit the parameter, not zero reasoning. */
export function reasoningRequest(value: ReasoningSetting): { reasoning_effort?: ReasoningEffort } {
  return value === 'default' ? {} : { reasoning_effort: value }
}
