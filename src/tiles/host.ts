// What stands between the 2D game and the page. The game itself (the simulation and the
// drawing) touches nothing of the page: it asks a host for what it needs and is told of
// the player's input in plain values. So it runs the same on the page's own thread or in
// a worker (see start.ts), where it leaves the page free to stay smooth while the world
// is simulated as fast as the machine allows.

import type { Canvas } from './canvas'
import type { Settings2d, Stats2d } from './game'
import type { SoundKind } from './sound'
import type { WorldOptions } from './world'

/** What the game asks of where it runs. */
export interface GameHost {
  /** The map's size on screen (CSS pixels) and the screen's pixel ratio. */
  size(): { width: number; height: number; dpr: number }
  /** The canvas the globe is drawn on with WebGL (laid over the map's), or null where there is none. */
  globeCanvas(): Canvas | null
  /** Shows or hides the globe's canvas. */
  showGlobe(on: boolean): void
  sound(kind: SoundKind): void
  /** Hands the player a file to keep. */
  download(blob: Blob, name: string): void
  /** The goals completed before in this browser, and keeping them. */
  completed(): string[]
  keepCompleted(ids: string[]): void
}

/** The pointer: where it is on the map (CSS pixels from the map's top left corner), its button, whether it is over the map. */
export interface PointerInput {
  clientX: number
  clientY: number
  button: number
  onMap: boolean
}

export interface WheelInput {
  clientX: number
  clientY: number
  deltaY: number
  shiftKey: boolean
  onMap: boolean
}

export interface KeyInput {
  code: string
  key: string
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
}

/** The player's input, as the game takes it. */
export interface GameInput {
  pointerDown(e: PointerInput): void
  pointerMove(e: PointerInput): void
  pointerUp(): void
  wheel(e: WheelInput): void
  leave(): void
  keyDown(e: KeyInput): void
  keyUp(e: KeyInput): void
  blur(): void
}

/** The game as the interface sees it: its state to show, and what the player may ask of it. */
export interface GameApi {
  subscribe(fn: () => void): () => void
  getSettings(): Settings2d
  getStats(): Stats2d
  set(partial: Partial<Settings2d>): void
  newWorld(opts: Partial<WorldOptions>): void
  flyTo(pos: [number, number], zoom?: number): void
  undo(): void
  rewind(): void
  resetChange(): void
  notice(text: string | null): void
  fit(): void
  save(): void | Promise<void>
  load(file: Blob): void | Promise<void>
}

/** The calls of GameApi that go to a game in a worker as messages. */
export type GameCall = 'set' | 'newWorld' | 'flyTo' | 'undo' | 'rewind' | 'resetChange' | 'notice' | 'fit' | 'save' | 'load'

/** From the page to the game in its worker. */
export type ToWorker =
  | { type: 'init'; canvas: OffscreenCanvas; globe: OffscreenCanvas | null; size: { width: number; height: number; dpr: number }; completed: string[] }
  | { type: 'size'; size: { width: number; height: number; dpr: number } }
  | { type: 'input'; name: keyof GameInput; arg?: PointerInput | WheelInput | KeyInput }
  | { type: 'call'; name: GameCall; args: unknown[] }
  | { type: 'dispose' }

/** From the game in its worker to the page. */
export type FromWorker =
  | { type: 'state'; settings: Settings2d; stats: Stats2d }
  | { type: 'sound'; kind: SoundKind }
  | { type: 'download'; blob: Blob; name: string }
  | { type: 'globe'; on: boolean }
  | { type: 'completed'; ids: string[] }
