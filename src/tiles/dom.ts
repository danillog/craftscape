// The page's side of the 2D game: the player's input read off the page and handed over
// in plain values, and what the game asks of the page (its size, a sound, a download).

import type { GameHost, GameInput } from './host'
import { Sound } from './sound'

const COMPLETED_KEY = 'craftscape2d.completed'
export const readCompleted = (): string[] => {
  try {
    return JSON.parse(localStorage.getItem(COMPLETED_KEY) ?? '[]') as string[]
  } catch {
    return []
  }
}
export const keepCompleted = (ids: string[]) => {
  try {
    localStorage.setItem(COMPLETED_KEY, JSON.stringify(ids))
  } catch {
    // storage unavailable: the trophies last only until the page closes
  }
}

/** Hands the player a file to keep. */
export function download(blob: Blob, name: string) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 10000)
}

/** The map's size on screen and the screen's pixel ratio. */
export const sizeOf = (canvas: HTMLCanvasElement) => ({ width: canvas.clientWidth, height: canvas.clientHeight, dpr: window.devicePixelRatio || 1 })

/** The host of a game that runs on the page's own thread. */
export function pageHost(canvas: HTMLCanvasElement, globe: HTMLCanvasElement, sound: Sound): GameHost {
  return {
    size: () => sizeOf(canvas),
    globeCanvas: () => globe,
    showGlobe: (on) => (globe.style.display = on ? '' : 'none'),
    sound: (kind) => sound.play(kind),
    download,
    completed: readCompleted,
    keepCompleted,
  }
}

/** The keys the game takes that the page would otherwise act on (scrolling, undo of a text field). */
const TAKEN = new Set(['Space', 'KeyP', 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'])

/**
 * Listens to the player on the page (the pointer and the wheel over the map, the keys
 * anywhere but in a text field) and hands it to the game. Returns how to stop listening.
 */
export function bindInput(canvas: HTMLCanvasElement, game: GameInput): () => void {
  const at = (e: { clientX: number; clientY: number }) => {
    const r = canvas.getBoundingClientRect()
    return { clientX: e.clientX - r.left, clientY: e.clientY - r.top }
  }
  const typing = (e: Event) => {
    const t = e.target as HTMLElement | null
    return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')
  }
  const down = (e: PointerEvent) => {
    canvas.setPointerCapture(e.pointerId)
    game.pointerDown({ ...at(e), button: e.button, onMap: true })
  }
  const move = (e: PointerEvent) => game.pointerMove({ ...at(e), button: e.button, onMap: e.target === canvas })
  const up = (e: PointerEvent) => {
    game.pointerUp()
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId)
  }
  const wheel = (e: WheelEvent) => {
    e.preventDefault()
    game.wheel({ ...at(e), deltaY: e.deltaY, shiftKey: e.shiftKey, onMap: true })
  }
  const leave = () => game.leave()
  const context = (e: Event) => e.preventDefault()
  const key = (e: KeyboardEvent) => ({ code: e.code, key: e.key, ctrlKey: e.ctrlKey, metaKey: e.metaKey, shiftKey: e.shiftKey })
  const keyDown = (e: KeyboardEvent) => {
    if (typing(e)) return
    if (((e.ctrlKey || e.metaKey) && e.code === 'KeyZ') || TAKEN.has(e.code)) e.preventDefault()
    game.keyDown(key(e))
  }
  const keyUp = (e: KeyboardEvent) => game.keyUp(key(e))
  const blur = () => game.blur()
  canvas.addEventListener('pointerdown', down)
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
  canvas.addEventListener('wheel', wheel, { passive: false })
  canvas.addEventListener('pointerleave', leave)
  canvas.addEventListener('contextmenu', context)
  window.addEventListener('keydown', keyDown)
  window.addEventListener('keyup', keyUp)
  window.addEventListener('blur', blur)
  return () => {
    canvas.removeEventListener('pointerdown', down)
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    canvas.removeEventListener('wheel', wheel)
    canvas.removeEventListener('pointerleave', leave)
    canvas.removeEventListener('contextmenu', context)
    window.removeEventListener('keydown', keyDown)
    window.removeEventListener('keyup', keyUp)
    window.removeEventListener('blur', blur)
  }
}
