import { useSyncExternalStore } from 'react'
import type { Engine } from '../engine/engine'

export const useSettings = (engine: Engine) => useSyncExternalStore(engine.subscribe, engine.getSettings)
export const useStats = (engine: Engine) => useSyncExternalStore(engine.subscribe, engine.getStats)
export const useMessage = (engine: Engine) => useSyncExternalStore(engine.subscribe, engine.getMessage)
export const useProbe = (engine: Engine) => useSyncExternalStore(engine.subscribe, engine.getProbe)
