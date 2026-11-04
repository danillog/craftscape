// The 2D game: the tile world ticking on the CPU, the peoples living on it (the same Life
// as the 3D game), the view, the input (pan, zoom, paint) and the powers.

import { Life, type LifeEvent, type LifeStats, type TownReport } from '../engine/life'
import { Renderer2D, type Overlay2d, type View, OVERLAYS_2D } from './render'
import { DEFAULT_WORLD, TICK, TileWorld, capacity, type WorldOptions } from './world'

export type Tool2d =
  | 'inspect' | 'terrain' | 'water' | 'forest' | 'rain' | 'heat' | 'sun' | 'people'
  | 'drought' | 'storm' | 'fire' | 'volcano' | 'meteor'

export interface Settings2d {
  tool: Tool2d
  mode: 'add' | 'remove'
  /** Radius in tiles. */
  brushSize: number
  speed: number
  paused: boolean
  followEvents: boolean
  clouds: boolean
  territory: boolean
  life: boolean
  /** The map mode (the data painted over the world). */
  overlay: Overlay2d
  windArrows: boolean
  world: WorldOptions
}

export interface TileInfo {
  x: number
  y: number
  height: number
  water: number
  river: number
  vegetation: number
  temperature: number
  humidity: number
  rain: number
  snow: number
  lava: number
  fire: number
  sand: number
  biome: string
  /** How much a decreed drought and a storm cover the tile, 0–1. */
  drought: number
  storm: number
  /** How much rain drains through the tile (the rivers). */
  flow: number
  town: TownReport | null
}

export interface Stats2d {
  fps: number
  simTime: number
  sun: number
  dust: number
  droughts: number
  storms: number
  volcanoes: number
  summary: TileWorld['summary']
  life: LifeStats | null
  tile: TileInfo | null
  message: string | null
}

export const DEFAULT_SETTINGS: Settings2d = {
  tool: 'inspect',
  mode: 'add',
  brushSize: 4,
  speed: 1,
  paused: false,
  followEvents: false,
  clouds: true,
  territory: true,
  life: true,
  overlay: 'none',
  windArrows: false,
  world: DEFAULT_WORLD,
}

const TICKS_PER_SECOND = 20
const MAX_TICKS_PER_FRAME = 24
const CLICK_TOOLS: Tool2d[] = ['sun', 'people', 'drought', 'storm', 'fire', 'volcano', 'meteor']

type Listener = () => void

export class Game {
  readonly canvas: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D
  world: TileWorld
  readonly life = new Life()
  private renderer: Renderer2D
  view: View = { cx: 96, cy: 96, zoom: 6 }
  private goal: View | null = null
  private settings: Settings2d = { ...DEFAULT_SETTINGS }
  private stats: Stats2d
  private listeners = new Set<Listener>()
  private raf = 0
  private lastTime = 0
  private accumulator = 0
  private realTime = 0
  private frames = 0
  private statClock = 0
  private cursor: [number, number] | null = null
  private painting = false
  private dragging: { x: number; y: number; cx: number; cy: number } | null = null
  private selectedTown: number | null = null
  private lastFollowed = -1
  private message: string | null = null
  private messageTimer = 0
  private disposed = false

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    this.ctx = canvas.getContext('2d')!
    this.world = new TileWorld(this.settings.world)
    this.renderer = new Renderer2D(this.world)
    this.view = { cx: this.world.n / 2, cy: this.world.n / 2, zoom: 5 }
    this.stats = this.makeStats(0)
    this.bind()
    this.fit()
  }

  // ---- the store for the interface ---------------------------------------------------

  subscribe = (fn: Listener) => {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }
  getSettings = () => this.settings
  getStats = () => this.stats
  private emit() {
    for (const fn of this.listeners) fn()
  }

  set(partial: Partial<Settings2d>) {
    this.settings = { ...this.settings, ...partial }
    this.emit()
  }

  /** A new world from the options (a new seed unless given). */
  newWorld(world: Partial<WorldOptions> = {}) {
    const opts: WorldOptions = { ...this.settings.world, ...world }
    if (world.seed === undefined) opts.seed = 1 + Math.floor(Math.random() * 100000)
    this.settings = { ...this.settings, world: opts, paused: false }
    this.world = new TileWorld(opts)
    this.renderer = new Renderer2D(this.world)
    this.life.reset()
    this.selectedTown = null
    this.lastFollowed = -1
    this.accumulator = 0
    this.fit()
    this.stats = this.makeStats(this.stats.fps)
    this.emit()
  }

  /** The view framing the whole world. */
  fit() {
    const w = this.canvas.clientWidth || 800
    const h = this.canvas.clientHeight || 600
    this.view = { cx: this.world.n / 2, cy: this.world.n / 2, zoom: Math.max(1, Math.min(w, h) / this.world.n) }
    this.goal = null
  }

  /** Counts the change map from now. */
  resetChange() {
    this.world.resetChange()
    this.renderer.refresh()
    this.toast('Referência zerada: o mapa de mudança conta a partir de agora')
  }

  /** The next (or previous) map mode. */
  cycleOverlay(step = 1) {
    const k = OVERLAYS_2D.findIndex((o) => o.id === this.settings.overlay)
    const next = OVERLAYS_2D[(k + step + OVERLAYS_2D.length) % OVERLAYS_2D.length]
    this.set({ overlay: next.id })
    this.toast(`Mapa: ${next.label}`)
  }

  /** Glides the view over a place (world units 0–1) at a close zoom. */
  flyTo(pos: [number, number], zoom = 10) {
    this.goal = { cx: pos[0] * this.world.n, cy: pos[1] * this.world.n, zoom }
  }

  notice(text: string | null) {
    this.message = text
    this.stats = { ...this.stats, message: text }
    this.emit()
  }
  private toast(text: string) {
    this.notice(text)
    window.clearTimeout(this.messageTimer)
    this.messageTimer = window.setTimeout(() => {
      if (this.message === text) this.notice(null)
    }, 5000)
  }

  // ---- the loop ----------------------------------------------------------------------

  start() {
    this.lastTime = performance.now()
    const frame = (now: number) => {
      if (this.disposed) return
      this.tick(now)
      this.raf = requestAnimationFrame(frame)
    }
    this.raf = requestAnimationFrame(frame)
  }

  dispose() {
    this.disposed = true
    cancelAnimationFrame(this.raf)
    this.unbind()
  }

  private tick(now: number) {
    const dt = Math.min((now - this.lastTime) / 1000, 0.25)
    this.lastTime = now
    this.realTime += dt
    const s = this.settings
    // the simulation: ticks at TICKS_PER_SECOND × speed
    let ticks = 0
    if (!s.paused) {
      this.accumulator += dt * s.speed * TICKS_PER_SECOND
      ticks = Math.min(Math.floor(this.accumulator), MAX_TICKS_PER_FRAME)
      this.accumulator = Math.min(this.accumulator - ticks, 2)
      for (let k = 0; k < ticks; k++) this.world.tick()
      if (s.life && ticks) {
        this.life.update(ticks * TICK, this.world.field, 1)
        this.applyWorks()
        if (s.followEvents) this.followEvents()
      }
    }
    // painting with the held brush
    if (this.painting && this.cursor) this.paint(dt)
    // the view glides to its goal
    if (this.goal) {
      const g = this.goal
      const v = this.view
      const k = 1 - Math.exp(-dt * 6)
      v.cx += (g.cx - v.cx) * k
      v.cy += (g.cy - v.cy) * k
      v.zoom += (g.zoom - v.zoom) * k
      if (Math.abs(g.cx - v.cx) < 0.05 && Math.abs(g.zoom - v.zoom) < 0.02) this.goal = null
    }
    this.clampView()
    // drawing (the colours follow the map mode)
    if (this.renderer.overlay !== s.overlay) {
      this.renderer.overlay = s.overlay
      this.renderer.refresh()
    } else if (ticks > 0 || this.frames % 10 === 0) this.renderer.refresh()
    this.draw()
    // the stats
    this.frames++
    this.statClock += dt
    if (this.statClock >= 0.5) {
      const fps = this.frames / this.statClock
      this.frames = 0
      this.statClock = 0
      this.stats = this.makeStats(fps)
      this.emit()
    }
  }

  /** The peoples' works on the land: fields keep the land green around farming towns. */
  private applyWorks() {
    const n = this.world.n
    const e = this.world.extra
    const works = this.life.works([0, 0], n, 1)
    for (const w of works) {
      if (!(w.kind & 1)) continue
      const cx = w.uv[0] * n
      const cy = w.uv[1] * n
      const r = w.radius * n
      const x0 = Math.max(0, Math.floor(cx - r))
      const x1 = Math.min(n - 1, Math.ceil(cx + r))
      const y0 = Math.max(0, Math.floor(cy - r))
      const y1 = Math.min(n - 1, Math.ceil(cy + r))
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          if (Math.hypot(x - cx, y - cy) > r) continue
          const i = (y * n + x) * 4
          if (this.world.water[i] > 0.002 || this.world.ground[i] < 0) continue
          const crops = 0.45 + 0.3 * w.strength
          e[i] = Math.min(Math.max(e[i], Math.min(e[i] + 0.002, crops)), crops + 0.15)
        }
      }
    }
  }

  private followEvents() {
    const events = this.life.chronicleEvents
    const last = events[events.length - 1]
    if (!last || last.time <= this.lastFollowed) return
    this.lastFollowed = last.time
    if (last.pos) this.flyTo(last.pos, Math.max(this.view.zoom, 9))
  }

  private clampView() {
    const v = this.view
    const n = this.world.n
    v.zoom = Math.max(1, Math.min(40, v.zoom))
    const w = this.canvas.clientWidth / v.zoom
    const h = this.canvas.clientHeight / v.zoom
    v.cx = Math.max(Math.min(w / 2, n / 2), Math.min(n - w / 2, v.cx))
    v.cy = Math.max(Math.min(h / 2, n / 2), Math.min(n - h / 2, v.cy))
  }

  private draw() {
    const c = this.canvas
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const width = Math.round(c.clientWidth * dpr)
    const height = Math.round(c.clientHeight * dpr)
    if (!width || !height) return
    if (c.width !== width || c.height !== height) {
      c.width = width
      c.height = height
    }
    const s = this.settings
    const n = this.world.n
    const ctx = this.ctx
    ctx.save()
    ctx.scale(dpr, dpr)
    const o = this.world.opts
    const ang = (o.windDirection * Math.PI) / 180
    const brush = this.cursor && s.tool !== 'inspect' && s.tool !== 'sun' ? { x: this.cursor[0], y: this.cursor[1], r: this.brushRadius() } : null
    const selected = this.selectedTown !== null ? this.life.reportOf(this.selectedTown)?.pos ?? null : null
    this.renderer.draw(ctx, c.clientWidth, c.clientHeight, this.view, {
      markers: s.life ? this.life.markers([0, 0], n, 1) : [],
      roads: s.life ? this.life.roads([0, 0], n, 1) : [],
      territory: s.life && (s.territory || s.overlay === 'civilization') ? this.life.territory([0, 0], n, 1) : null,
      labels: s.life ? this.life.labels([0, 0], n, 1, this.selectedTown, s.overlay === 'civilization') : [],
      time: this.realTime,
      wind: [Math.cos(ang) * o.windSpeed * TICKS_PER_SECOND, Math.sin(ang) * o.windSpeed * TICKS_PER_SECOND],
      simTime: this.world.time,
      clouds: s.clouds,
      windArrows: s.windArrows,
      brush,
      selected,
    })
    ctx.restore()
  }

  private makeStats(fps: number): Stats2d {
    const w = this.world
    return {
      fps,
      simTime: w.time,
      sun: w.sun,
      dust: w.dust,
      droughts: w.droughts.length,
      storms: w.storms.length,
      volcanoes: w.vents.length,
      summary: w.summary,
      life: this.settings.life ? { ...this.life.stats(), selected: this.life.reportOf(this.selectedTown) } : null,
      tile: this.cursor ? this.tileInfo(Math.floor(this.cursor[0]), Math.floor(this.cursor[1])) : null,
      message: this.message,
    }
  }

  tileInfo(x: number, y: number): TileInfo | null {
    const w = this.world
    const n = w.n
    if (x < 0 || y < 0 || x >= n || y >= n) return null
    const i = (y * n + x) * 4
    const t = w.climate[i + 3]
    const v = w.extra[i]
    const water = w.water[i]
    const height = w.ground[i]
    const snow = w.extra[i + 2]
    const sand = w.ground[i + 3]
    let biome: string
    if (w.lava[i] > 0.0002) biome = 'lava'
    else if (height < 0) biome = height < -0.04 ? 'mar profundo' : 'mar raso'
    else if (water > 0.002) biome = w.extra[i + 3] > 0 ? 'lago gelado' : 'lago'
    else if (w.fire[(y * n + x)] > 0) biome = 'incêndio'
    else if (snow > 0.5) biome = height > 0.13 ? 'pico nevado' : 'neve'
    else if (height > 0.17) biome = 'montanha'
    else if (sand > 0.5) biome = 'deserto'
    else if (t < 6) biome = 'tundra'
    else if (v > 0.62) biome = t > 24 ? 'floresta tropical' : t < 9 ? 'taiga' : 'floresta'
    else if (v > 0.3) biome = 'campo'
    else if (v > 0.1) biome = 'estepe'
    else biome = 'terra nua'
    return {
      x,
      y,
      height,
      water,
      river: w.water[i + 3],
      vegetation: v,
      temperature: t,
      humidity: w.climate[i + 1],
      rain: w.climate[i + 2],
      snow,
      lava: w.lava[i],
      fire: w.fire[y * n + x],
      sand,
      biome,
      drought: w.droughtCover[y * n + x],
      storm: w.stormCover[y * n + x],
      flow: w.acc[y * n + x],
      town: this.settings.life ? this.life.townAt([(x + 0.5) / n, (y + 0.5) / n], 2.5 / n) : null,
    }
  }

  // ---- input -------------------------------------------------------------------------

  private onPointerDown = (e: PointerEvent) => {
    if (e.target !== this.canvas) return
    this.canvas.setPointerCapture(e.pointerId)
    const tile = this.tileAt(e)
    this.cursor = tile
    const s = this.settings
    if (e.button === 1 || e.button === 2 || s.tool === 'inspect') {
      this.dragging = { x: e.clientX, y: e.clientY, cx: this.view.cx, cy: this.view.cy }
      this.goal = null
      if (s.tool === 'inspect' && e.button === 0 && s.life) {
        const town = this.life.townAt([tile[0] / this.world.n, tile[1] / this.world.n], 2.5 / this.world.n)
        this.selectedTown = town ? town.id : null
        this.stats = this.makeStats(this.stats.fps)
        this.emit()
      }
      return
    }
    if (e.button !== 0) return
    if (CLICK_TOOLS.includes(s.tool)) this.act(tile)
    else this.painting = true
  }
  private onPointerMove = (e: PointerEvent) => {
    if (this.dragging) {
      const d = this.dragging
      this.view.cx = d.cx - (e.clientX - d.x) / this.view.zoom
      this.view.cy = d.cy - (e.clientY - d.y) / this.view.zoom
      return
    }
    this.cursor = e.target === this.canvas || this.painting ? this.tileAt(e) : null
  }
  private onPointerUp = (e: PointerEvent) => {
    this.dragging = null
    this.painting = false
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId)
  }
  private onWheel = (e: WheelEvent) => {
    if (e.target !== this.canvas) return
    e.preventDefault()
    if (e.shiftKey) {
      this.set({ brushSize: Math.max(1, Math.min(40, this.settings.brushSize * (e.deltaY < 0 ? 1.2 : 1 / 1.2))) })
      return
    }
    const v = this.view
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15
    const before = this.tileAt(e)
    v.zoom = Math.max(1, Math.min(40, v.zoom * factor))
    this.goal = null
    const after = this.tileAt(e)
    v.cx += before[0] - after[0]
    v.cy += before[1] - after[1]
  }
  private onKey = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement | null
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return
    const tools: Record<string, Tool2d> = {
      Digit0: 'inspect', Digit1: 'terrain', Digit2: 'water', Digit3: 'forest', Digit4: 'rain', Digit5: 'heat', Digit6: 'sun',
      Digit7: 'people', Digit8: 'drought', Digit9: 'storm', KeyF: 'fire', KeyV: 'volcano', KeyM: 'meteor',
    }
    if (tools[e.code]) this.set({ tool: tools[e.code] })
    else if (e.code === 'Escape') this.set({ tool: 'inspect' })
    else if (e.code === 'KeyX') this.set({ mode: this.settings.mode === 'add' ? 'remove' : 'add' })
    else if (e.code === 'KeyP' || e.code === 'Space') {
      e.preventDefault()
      this.set({ paused: !this.settings.paused })
    } else if (e.key === '[') this.set({ brushSize: Math.max(1, this.settings.brushSize / 1.25) })
    else if (e.key === ']') this.set({ brushSize: Math.min(40, this.settings.brushSize * 1.25) })
    else if (e.code === 'KeyR') this.fit()
    else if (e.code === 'KeyO') this.cycleOverlay(e.shiftKey ? -1 : 1)
    else if (e.code === 'KeyW') this.set({ windArrows: !this.settings.windArrows })
    else if (e.code.startsWith('Arrow')) {
      e.preventDefault()
      const d = 12 / Math.sqrt(this.view.zoom)
      this.goal = null
      if (e.code === 'ArrowLeft') this.view.cx -= d
      else if (e.code === 'ArrowRight') this.view.cx += d
      else if (e.code === 'ArrowUp') this.view.cy -= d
      else this.view.cy += d
    }
  }
  private onLeave = () => {
    if (!this.painting && !this.dragging) this.cursor = null
  }
  private onContext = (e: Event) => e.preventDefault()

  private bind() {
    const c = this.canvas
    c.addEventListener('pointerdown', this.onPointerDown)
    window.addEventListener('pointermove', this.onPointerMove)
    window.addEventListener('pointerup', this.onPointerUp)
    c.addEventListener('wheel', this.onWheel, { passive: false })
    c.addEventListener('pointerleave', this.onLeave)
    c.addEventListener('contextmenu', this.onContext)
    window.addEventListener('keydown', this.onKey)
  }
  private unbind() {
    const c = this.canvas
    c.removeEventListener('pointerdown', this.onPointerDown)
    window.removeEventListener('pointermove', this.onPointerMove)
    window.removeEventListener('pointerup', this.onPointerUp)
    c.removeEventListener('wheel', this.onWheel)
    c.removeEventListener('pointerleave', this.onLeave)
    c.removeEventListener('contextmenu', this.onContext)
    window.removeEventListener('keydown', this.onKey)
  }

  private tileAt(e: { clientX: number; clientY: number }): [number, number] {
    const r = this.canvas.getBoundingClientRect()
    const v = this.view
    return [v.cx + (e.clientX - r.left - r.width / 2) / v.zoom, v.cy + (e.clientY - r.top - r.height / 2) / v.zoom]
  }

  private brushRadius() {
    const s = this.settings
    if (s.tool === 'meteor') return Math.max(3, s.brushSize)
    if (s.tool === 'storm' || s.tool === 'drought') return Math.max(6, s.brushSize * 2.5)
    if (s.tool === 'volcano' || s.tool === 'people') return 2
    return s.brushSize
  }

  // ---- the powers --------------------------------------------------------------------

  /** The brushes held down: the land, the water, the forest, the rain, the heat. */
  private paint(dt: number) {
    const s = this.settings
    const [x, y] = this.cursor!
    const r = s.brushSize
    const sign = s.mode === 'add' ? 1 : -1
    const k = dt * 60
    switch (s.tool) {
      case 'terrain':
        this.world.raise(x, y, r, sign * 0.0015 * k)
        break
      case 'water':
        this.world.pour(x, y, r, sign * 0.0015 * k)
        break
      case 'forest':
        this.world.plant(x, y, r, sign * 0.03 * k)
        break
      case 'rain':
        this.world.humidify(x, y, r, sign * 0.06 * k)
        break
      case 'heat':
        this.world.heat(x, y, r, sign * 0.15 * k)
        break
      default:
        break
    }
  }

  /** The powers that act on a click. */
  act(tile: [number, number]) {
    const s = this.settings
    const w = this.world
    const [x, y] = tile
    const pos: [number, number] = [x / w.n, y / w.n]
    const remove = s.mode === 'remove'
    switch (s.tool) {
      case 'sun': {
        w.sun = Math.max(-10, Math.min(10, w.sun + (remove ? -1 : 1)))
        const shown = `${w.sun > 0 ? '+' : ''}${w.sun.toFixed(0)} °C`
        this.toast(remove ? `O sol enfraquece: o planeta esfria 1 °C (${shown})` : `O sol se fortalece: o planeta esquenta 1 °C (${shown})`)
        this.life.chronicle(remove ? 'O sol enfraquece: o mundo esfria.' : 'O sol se fortalece: o mundo esquenta.', true)
        break
      }
      case 'people': {
        if (!s.life) return
        if (this.life.seedCiv(pos, 1)) this.toast('Um povo novo desperta aqui')
        else this.toast('Ninguém vive aqui: precisa de terra firme, sem gelo nem lava, longe de outra cidade')
        break
      }
      case 'drought': {
        const lifted = w.drought(x, y, this.brushRadius(), remove)
        if (remove) {
          if (lifted) {
            this.toast('A seca acabou: a chuva volta à região')
            this.life.chronicle('A seca acaba: as chuvas voltam.', false, pos)
          }
        } else {
          this.toast('Seca decretada: não chove aqui até você apagá-la (modo −)')
          this.life.chronicle('O céu se fecha para a chuva sobre uma região: uma seca decretada.', true, pos)
        }
        break
      }
      case 'storm': {
        w.storm(x, y, this.brushRadius())
        this.toast('Tempestade: uma baixa que o vento leva, chovendo por onde passa')
        this.life.chronicle('Uma tempestade desaba sobre a terra.', false, pos)
        break
      }
      case 'fire': {
        w.ignite(x, y, Math.max(1, s.brushSize * 0.5))
        this.toast('Fogo: espalha pelo mato seco com o vento; a chuva apaga')
        this.life.chronicle('Um raio acende o mato.', false, pos)
        break
      }
      case 'volcano': {
        w.erupt(x, y, 0.6 + Math.random() * 0.4)
        this.toast('Um vulcão abre: a lava desce e vira rocha nova')
        this.life.chronicle('A terra se abre: um vulcão entra em erupção.', true, pos)
        break
      }
      case 'meteor': {
        const r = this.brushRadius()
        w.strike(x, y, r)
        this.toast(`Impacto! Cratera, fogo e poeira que esfria o planeta ${w.dust.toFixed(1).replace('.', ',')} °C até baixar`)
        this.life.chronicle('Uma estrela cai do céu: fogo, cratera e dias de poeira.', true, pos)
        break
      }
      default:
        break
    }
    this.stats = this.makeStats(this.stats.fps)
    this.emit()
  }
}

export type { LifeEvent }
export { capacity }
