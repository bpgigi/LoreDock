import { useEffect, useRef, useSyncExternalStore } from 'react'
import { generateCardDrafts, reviseCardDrafts } from './api'
import { CardWorkshopController } from './cardWorkshop'
import type { GeneratedKnowledgeCardInput, KnowledgeCard } from './types'

export function useCardWorkshop(activeKey: string, save: (inputs: GeneratedKnowledgeCardInput[]) => Promise<KnowledgeCard[]>) {
  const saveRef = useRef(save)
  saveRef.current = save
  const controllerRef = useRef<CardWorkshopController | null>(null)
  if (!controllerRef.current) controllerRef.current = new CardWorkshopController({ generate: generateCardDrafts, revise: reviseCardDrafts, save: inputs => saveRef.current(inputs) })
  const controller = controllerRef.current
  const sessions = useSyncExternalStore(controller.subscribe, controller.snapshot)
  useEffect(() => { controller.stop(); return () => controller.stop() }, [controller, activeKey])
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (Object.values(controller.snapshot()).some(state => state.busy || state.drafts.some(draft => !draft.savedCardId))) { event.preventDefault(); event.returnValue = '' }
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [controller])
  return { controller, state: sessions[activeKey] }
}
