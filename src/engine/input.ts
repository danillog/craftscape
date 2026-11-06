import type { MoveInput } from './camera'
import type { Tool } from './settings'

export interface InputHandlers {
  beginRotate(): void
  endRotate(): void
  rotate(dx: number, dy: number): void
  pan(dx: number, dy: number): void
  zoom(factor: number): void
  resizeBrush(steps: number): void
  undo(): void
  togglePause(): void
  toggleCamera(): void
  resetCamera(): void
  /** Centers the view on the terrain under the cursor. */
  focus(): void
  selectTool(tool: Tool): void
  /** B held: steps the world back in time, one snapshot per call; released: done. */
  rewind(): void
  rewindEnd(): void
  toggleMode(): void
  toggleHelp(): void
  /** Escape: closes the shortcut sheet, or leaves photo mode. */
  closeHelp(): void
  togglePhoto(): void
  /** Whether a left click / one-finger touch paints instead of rotating. */
  paintOnClick(): boolean
}

type DragMode = 'rotate' | 'pan' | 'paint'

interface Pointer {
  x: number
  y: number
  mode: DragMode
  touch: boolean
}

const TOOL_ORDER: Tool[] = ['rock', 'soil', 'sand', 'water', 'level', 'heat', 'humidity', 'volcano', 'pressure']
// physical keys, so the number row and the numpad both work on any layout
const TOOL_KEYS: Record<string, Tool> = Object.fromEntries(
  TOOL_ORDER.flatMap((tool, k) => [
    [`Digit${k + 1}`, tool],
    [`Numpad${k + 1}`, tool],
  ]),
)
const ARROWS = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']

const isTextField = (el: EventTarget | null) =>
  el instanceof HTMLTextAreaElement ||
  el instanceof HTMLSelectElement ||
  (el instanceof HTMLInputElement && !['checkbox', 'radio', 'range', 'button', 'file'].includes(el.type))

/** Pointer, touch and keyboard handling for the canvas. */
export class Input {
  /** Cursor position in normalized device coordinates, while over the canvas. */
  cursor: [number, number] | null = null

  private readonly canvas: HTMLCanvasElement
  private readonly handlers: InputHandlers
  private readonly pointers = new Map<number, Pointer>()
  private readonly keys = new Set<string>()
  private spaceHeld = false
  private pinchDistance = 0
  private readonly cleanup: (() => void)[] = []

  constructor(canvas: HTMLCanvasElement, handlers: InputHandlers) {
    this.canvas = canvas
    this.handlers = handlers
    const on = <K extends keyof HTMLElementEventMap>(
      target: HTMLElement | Window,
      type: K,
      fn: (e: HTMLElementEventMap[K]) => void,
      options?: AddEventListenerOptions,
    ) => {
      target.addEventListener(type, fn as EventListener, options)
      this.cleanup.push(() => target.removeEventListener(type, fn as EventListener, options))
    }

    on(canvas, 'pointerdown', (e) => this.onPointerDown(e))
    on(canvas, 'pointermove', (e) => this.onPointerMove(e))
    on(canvas, 'pointerup', (e) => this.onPointerUp(e))
    on(canvas, 'pointercancel', (e) => this.onPointerUp(e))
    on(canvas, 'pointerleave', (e) => {
      if (e.pointerType === 'mouse' && !this.pointers.size) this.cursor = null
    })
    on(canvas, 'contextmenu', (e) => e.preventDefault())
    on(canvas, 'dblclick', (e) => {
      if (this.handlers.paintOnClick()) return
      this.setCursor(e)
      this.handlers.focus()
    })
    on(canvas, 'wheel', (e) => this.onWheel(e), { passive: false })
    on(window, 'keydown', (e) => this.onKey(e, true))
    on(window, 'keyup', (e) => this.onKey(e, false))
    on(window, 'blur', () => {
      this.keys.clear()
      this.spaceHeld = false
    })
  }

  /** A paint press began since the last frame (it may be over already: a quick click at a low frame rate). */
  private pressLatched = false

  /** Whether a paint press began since the last call; cleared by the call. */
  takePress() {
    const pressed = this.pressLatched
    this.pressLatched = false
    return pressed
  }

  /** Space held over the terrain, or a pointer dragging in paint mode. */
  get painting() {
    if (this.spaceHeld && this.cursor) return true
    for (const p of this.pointers.values()) if (p.mode === 'paint') return true
    return false
  }

  get move(): MoveInput {
    const k = this.keys
    return {
      x: (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0),
      y: (k.has('KeyE') ? 1 : 0) - (k.has('KeyQ') ? 1 : 0),
      z: (k.has('KeyW') ? 1 : 0) - (k.has('KeyS') ? 1 : 0),
      turn: (k.has('ArrowRight') ? 1 : 0) - (k.has('ArrowLeft') ? 1 : 0),
      tilt: (k.has('ArrowUp') ? 1 : 0) - (k.has('ArrowDown') ? 1 : 0),
      fast: k.has('ShiftLeft') || k.has('ShiftRight'),
    }
  }

  private setCursor(e: MouseEvent) {
    const r = this.canvas.getBoundingClientRect()
    this.cursor = [((e.clientX - r.left) / r.width) * 2 - 1, 1 - ((e.clientY - r.top) / r.height) * 2]
  }

  private onPointerDown(e: PointerEvent) {
    this.canvas.setPointerCapture(e.pointerId)
    // keep keyboard shortcuts working after clicking the canvas
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    const touch = e.pointerType === 'touch'
    let mode: DragMode = 'rotate'
    if (e.button === 1 || e.button === 2 || (e.button === 0 && e.shiftKey && !this.handlers.paintOnClick()))
      mode = 'pan'
    else if (this.handlers.paintOnClick()) mode = 'paint'
    if (mode === 'paint') this.pressLatched = true
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, mode, touch })
    if (this.pointers.size === 2) {
      // second finger: switch both to a camera gesture
      for (const p of this.pointers.values()) p.mode = 'pan'
      this.pinchDistance = this.gestureDistance()
      this.handlers.endRotate()
    } else if (mode === 'rotate') {
      this.handlers.beginRotate()
    }
    this.setCursor(e)
  }

  private onPointerMove(e: PointerEvent) {
    const p = this.pointers.get(e.pointerId)
    if (e.pointerType === 'mouse' || p) this.setCursor(e)
    if (!p) return
    const dx = e.clientX - p.x
    const dy = e.clientY - p.y
    p.x = e.clientX
    p.y = e.clientY
    if (this.pointers.size >= 2) {
      // two fingers: pinch to zoom, move together to pan (each finger contributes half)
      const d = this.gestureDistance()
      if (this.pinchDistance > 0 && d > 0) this.handlers.zoom(this.pinchDistance / d)
      this.pinchDistance = d
      this.handlers.pan(dx / 2, dy / 2)
      return
    }
    if (p.mode === 'rotate') this.handlers.rotate(dx, dy)
    else if (p.mode === 'pan') this.handlers.pan(dx, dy)
  }

  private onPointerUp(e: PointerEvent) {
    const p = this.pointers.get(e.pointerId)
    this.pointers.delete(e.pointerId)
    if (p?.mode === 'rotate') this.handlers.endRotate()
    if (this.pointers.size < 2) this.pinchDistance = 0
    if (p?.touch && !this.pointers.size) this.cursor = null
  }

  private gestureDistance() {
    const [a, b] = [...this.pointers.values()]
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0
  }

  private onWheel(e: WheelEvent) {
    e.preventDefault()
    const delta = (e.deltaY || e.deltaX) * (e.deltaMode === 1 ? 33 : 1)
    if (e.shiftKey || e.altKey) this.handlers.resizeBrush(-Math.sign(delta))
    else this.handlers.zoom(Math.exp(delta * 0.0012))
  }

  private onKey(e: KeyboardEvent, down: boolean) {
    if (isTextField(e.target)) return
    if (e.code === 'Space') {
      // stops Space from toggling a focused checkbox/button or scrolling
      e.preventDefault()
      this.spaceHeld = down
      return
    }
    if (ARROWS.includes(e.code)) e.preventDefault() // don't scroll the panel or move sliders
    if (down) this.keys.add(e.code)
    else this.keys.delete(e.code)
    if (e.code === 'KeyB' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      if (down) this.handlers.rewind()
      else this.handlers.rewindEnd()
      return
    }
    if (!down || e.repeat) return
    if (e.code === 'Escape') {
      this.handlers.closeHelp()
      return
    }
    if ((e.ctrlKey || e.metaKey) && e.code === 'KeyZ') {
      e.preventDefault()
      this.handlers.undo()
      return
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return
    // characters (not physical keys) for symbols: [ ] sit elsewhere on ABNT2 keyboards
    if (e.key === '[' || e.key === '-') this.handlers.resizeBrush(-1)
    else if (e.key === ']' || e.key === '=' || e.key === '+') this.handlers.resizeBrush(1)
    else if (e.key === '?' || e.code === 'KeyH') this.handlers.toggleHelp()
    else if (e.code === 'KeyP') this.handlers.togglePause()
    else if (e.code === 'KeyC') this.handlers.toggleCamera()
    else if (e.code === 'KeyR') this.handlers.resetCamera()
    else if (e.code === 'KeyF') this.handlers.focus()
    else if (e.code === 'KeyX') this.handlers.toggleMode()
    else if (e.code === 'KeyK') this.handlers.togglePhoto()
    else if (e.code === 'KeyU') this.handlers.selectTool('plates')
    else if (e.code === 'KeyM') this.handlers.selectTool('airmass')
    else if (e.code === 'KeyO') this.handlers.selectTool('current')
    else if (e.code === 'KeyT') this.handlers.selectTool('storm')
    else if (e.code === 'KeyI') this.handlers.selectTool('meteor')
    else if (e.code === 'KeyJ') this.handlers.selectTool('sun')
    else if (e.code === 'KeyN') this.handlers.selectTool('drought')
    else if (e.code === 'KeyG') this.handlers.selectTool('quake')
    else if (e.code === 'KeyY') this.handlers.selectTool('hurricane')
    else if (e.code === 'KeyV') this.handlers.selectTool('fire')
    else if (e.code === 'KeyL') this.handlers.selectTool('people')
    else if (e.code === 'Digit0' || e.code === 'Numpad0') this.handlers.selectTool('inspect')
    else if (TOOL_KEYS[e.code]) this.handlers.selectTool(TOOL_KEYS[e.code])
  }

  dispose() {
    for (const fn of this.cleanup) fn()
  }
}
