// Starts the 2D game on the page: in a worker where the browser can hand it the canvases
// (OffscreenCanvas), so the simulation and the drawing never hold the interface up; on the
// page's own thread otherwise (or with ?sem-worker in the address).

import { bindInput, download, keepCompleted, pageHost, readCompleted, sizeOf } from './dom'
import { Game, type Settings2d, type Stats2d } from './game'
import type { FromWorker, GameApi, GameCall, GameInput, ToWorker } from './host'
import { Sound } from './sound'
import type { WorldOptions } from './world'

export interface Running {
  game: GameApi
  /** Where the game runs. */
  thread: 'worker' | 'page'
  dispose(): void
}

/** The game in a worker, as the interface sees it: its last state, and the calls passed on as messages. */
class GameClient implements GameApi {
  private settings!: Settings2d
  private stats!: Stats2d
  private readonly listeners = new Set<() => void>()
  private readonly worker: Worker
  private readonly sound = new Sound()

  constructor(worker: Worker, globe: HTMLCanvasElement, onState: () => void) {
    this.worker = worker
    worker.onmessage = (e: MessageEvent<FromWorker>) => {
      const m = e.data
      if (m.type === 'state') {
        this.settings = m.settings
        this.stats = m.stats
        this.sound.enabled = m.settings.sound
        onState()
        for (const fn of this.listeners) fn()
      } else if (m.type === 'sound') this.sound.play(m.kind)
      else if (m.type === 'download') download(m.blob, m.name)
      else if (m.type === 'globe') globe.style.display = m.on ? '' : 'none'
      else if (m.type === 'completed') keepCompleted(m.ids)
    }
  }

  send(message: ToWorker, transfer: Transferable[] = []) {
    this.worker.postMessage(message, transfer)
  }
  private call(name: GameCall, ...args: unknown[]) {
    this.send({ type: 'call', name, args })
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }
  getSettings = () => this.settings
  getStats = () => this.stats
  set(partial: Partial<Settings2d>) {
    // shown at once (a slider must not wait for the worker's answer); the game's own state follows
    this.settings = { ...this.settings, ...partial }
    for (const fn of this.listeners) fn()
    this.call('set', partial)
  }
  newWorld(opts: Partial<WorldOptions>) {
    this.call('newWorld', opts)
  }
  flyTo(pos: [number, number], zoom?: number) {
    this.call('flyTo', pos, zoom)
  }
  undo() {
    this.call('undo')
  }
  rewind() {
    this.call('rewind')
  }
  resetChange() {
    this.call('resetChange')
  }
  notice(text: string | null) {
    this.call('notice', text)
  }
  fit() {
    this.call('fit')
  }
  save() {
    this.call('save')
  }
  load(file: Blob) {
    this.call('load', file)
  }
}

const canUseWorker = () =>
  typeof Worker !== 'undefined' &&
  typeof OffscreenCanvas !== 'undefined' &&
  'transferControlToOffscreen' in HTMLCanvasElement.prototype &&
  !new URLSearchParams(window.location.search).has('sem-worker')

/** The two canvases of the game, new in the container: the map's and, over it, the globe's (hidden until asked for). */
function canvases(container: HTMLElement): [HTMLCanvasElement, HTMLCanvasElement] {
  container.replaceChildren()
  const map = document.createElement('canvas')
  map.className = 'map'
  const globe = document.createElement('canvas')
  globe.className = 'map globe'
  globe.style.display = 'none'
  container.append(map, globe)
  return [map, globe]
}

function onPage(container: HTMLElement): Running {
  const [map, globe] = canvases(container)
  const sound = new Sound()
  const game = new Game(map, pageHost(map, globe, sound))
  game.subscribe(() => (sound.enabled = game.getSettings().sound))
  const unbind = bindInput(map, game)
  game.start()
  return {
    game,
    thread: 'page',
    dispose: () => {
      unbind()
      game.dispose()
    },
  }
}

/**
 * Starts the game in `container`. `ready` is called once it has a state to show (at once on
 * the page's thread; after the worker's first message otherwise); if the worker cannot
 * start, the game starts on the page's thread instead.
 */
export function startGame(container: HTMLElement, ready: (running: Running) => void): () => void {
  let current: Running | null = null
  let stopped = false
  const adopt = (running: Running) => {
    current = running
    if (!stopped) ready(running)
  }
  if (!canUseWorker()) {
    adopt(onPage(container))
    return () => {
      stopped = true
      current?.dispose()
    }
  }
  const [map, globe] = canvases(container)
  const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
  let started = false
  const client = new GameClient(worker, globe, () => {
    if (started) return
    started = true
    adopt({ game: client, thread: 'worker', dispose: stop })
  })
  // the player's input goes over as messages
  const input = {} as GameInput
  for (const name of ['pointerDown', 'pointerMove', 'wheel', 'keyDown', 'keyUp'] as const) {
    input[name] = (arg: never) => client.send({ type: 'input', name, arg })
  }
  for (const name of ['pointerUp', 'leave', 'blur'] as const) input[name] = () => client.send({ type: 'input', name })
  const unbind = bindInput(map, input)
  const resize = new ResizeObserver(() => client.send({ type: 'size', size: sizeOf(map) }))
  resize.observe(map)
  function stop() {
    unbind()
    resize.disconnect()
    client.send({ type: 'dispose' })
    setTimeout(() => worker.terminate(), 200)
  }
  // a worker that cannot start (an old browser, a blocked script): the page's thread takes over
  worker.onerror = () => {
    if (started || stopped) return
    started = true
    stop()
    adopt(onPage(container))
  }
  const offscreen = map.transferControlToOffscreen()
  const globeOffscreen = globe.transferControlToOffscreen()
  client.send({ type: 'init', canvas: offscreen, globe: globeOffscreen, size: sizeOf(map), completed: readCompleted() }, [offscreen, globeOffscreen])
  return () => {
    stopped = true
    if (current) current.dispose()
    else stop()
  }
}
