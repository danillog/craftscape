// The 2D game: the tile world ticking on the CPU, the peoples living on it (the same Life
// as the 3D game), the view, the input (pan, zoom, paint) and the powers.

import { Life, type LifeEvent, type LifeStats, type TownReport, type Work } from '../engine/life'
import { Renderer2D, type Overlay2d, type View, OVERLAYS_2D } from './render'
import { challengeById, type Metrics } from './goals'
import { CATEGORICAL, ERA_RAMP, PEOPLE_MAPS, type Effect } from './render'
import { fromFile, toFile } from './save'
import type { SoundKind } from './sound'
import { context2d, type Canvas, type Ctx } from './canvas'
import type { GameHost, KeyInput, PointerInput, WheelInput } from './host'
import { BOUNDARY_NAMES } from './tectonics'
import { DEFAULT_WORLD, LIVE_OPTIONS, METERS_PER_HEIGHT, PB, TICK, TileWorld, capacity, type WorldOptions, type WorldSnapshot } from './world'
import { wrap, wrapDelta } from './wrap'
import { GLOBE_TILT, Globe, globePick, globePlace, type GlobeView } from './globe'

export type Tool2d =
  | 'inspect' | 'terrain' | 'water' | 'forest' | 'rain' | 'heat' | 'pressure' | 'sun' | 'people'
  | 'drought' | 'storm' | 'fire' | 'volcano' | 'meteor' | 'plates'
  | 'bless' | 'inspire' | 'plague' | 'prophet' | 'discord' | 'peace' | 'nuke' | 'quake' | 'hurricane'

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
  /** Satellite (as seen from orbit, towns as lights, a km grid) or the illustrated map (trees, mountains, houses). */
  look: 'satellite' | 'illustrated'
  /** The planet drawn as a globe instead of the flat map (needs WebGL). */
  globe: boolean
  /** Satellite: the day and the night sweep over the map. */
  dayNight: boolean
  /** Sounds for the powers and the big moments. */
  sound: boolean
  /** The goal being played for (see goals.ts), or null. */
  challenge: string | null
  world: WorldOptions
}

/** A moment of the world kept for going back: everything to restore it. */
interface Snap {
  year: number
  world: WorldSnapshot
  life: unknown
  news: News[]
  history: YearRecord[]
  annals: News[]
  peaceYears: number
}

/** A goal being played for: where it started, how far it has come, whether it is done. */
export interface ChallengeState {
  id: string
  start: Metrics
  progress: number
  done: boolean
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
  /** The air's temperature now (°C): the daily mean (temperature) plus the day's swing. */
  airTemperature: number
  /** The pressure in effect: lows < 0 < highs. */
  pressure: number
  /** The plate under the tile: where it drifts (degrees, 0 east, 90 south) and the boundary, if near. */
  plateAngle: number
  plateSpeed: number
  boundary: string | null
  /** The peoples' marks here, 0–1. */
  farmland: number
  cleared: number
  urban: number
  /** Radioactive fallout here, 0–1. */
  fallout: number
  /** The local wind: tiles per second and the compass angle it blows towards (0 east, 90 south). */
  windSpeed: number
  windAngle: number
  town: TownReport | null
}

/** A notice for the cards: the peoples' chronicle and what the world does by itself. */
export interface News {
  id: number
  year: number
  text: string
  /** The people it is about (a CIV_COLORS index), or null for the world's own news. */
  color: number | null
  major: boolean
  /** Where it happened (world units 0–1). */
  pos?: [number, number]
}

/** The world at the end of a year, for the charts. */
export interface YearRecord {
  year: number
  /** Mean temperature (°C), CO₂ (ppm), the sea over its start (m), people. */
  temperature: number
  co2: number
  sea: number
  population: number
}

/** Years of record kept for the charts. */
const RECORD_YEARS = 600

export interface Stats2d {
  fps: number
  simTime: number
  /** The season, −1 (northern winter) … 1 (northern summer), and the tiles a side of the map. */
  season: number
  n: number
  sun: number
  dust: number
  droughts: number
  storms: number
  volcanoes: number
  summary: TileWorld['summary']
  human: ReturnType<TileWorld['humanSummary']>
  /** °C the peoples' industry has added; the sea level (height units). */
  civWarming: number
  sea: number
  life: LifeStats | null
  tile: TileInfo | null
  message: string | null
  /** Newest first. */
  news: News[]
  /** One record a year, oldest first. */
  history: YearRecord[]
  /** Every big moment so far (newest first), for the history book. */
  annals: News[]
  /** How many strokes can be undone, how many years back the rewind reaches. */
  undoDepth: number
  rewindYears: number
  challenge: ChallengeState | null
  /** Goals completed on this computer. */
  completed: string[]
  /** Per people (civ id): the eras it went through, [year, era index] from the first. */
  eraLog: Record<number, [number, number][]>
  /** Per people (civ id): technology gained over the last ten years (0–1 scale). */
  techTrend: Record<number, number>
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
  look: 'satellite',
  globe: false,
  dayNight: true,
  sound: true,
  challenge: null,
  world: DEFAULT_WORLD,
}

const TICKS_PER_SECOND = 20
const MAX_TICKS_PER_FRAME = 24
/**
 * Milliseconds of a frame the simulation may take: a big map at a high speed runs as many
 * of the ticks due as fit in this (one at least), so it goes a little slower than asked
 * instead of freezing the picture.
 */
const TICK_BUDGET_MS = 40
/** The brushes: they act every frame while held. */
const BRUSH_TOOLS: Tool2d[] = ['terrain', 'water', 'forest', 'rain', 'heat', 'pressure']
/**
 * The powers act on the press and again while held: every `every` seconds once the cursor
 * has moved `move` tiles from the last place (0: in place too), so every tool works the same
 * way, held and dragged.
 */
const REPEAT: Partial<Record<Tool2d, { every: number; move: number }>> = {
  sun: { every: 0.7, move: 0 },
  people: { every: 0.6, move: 6 },
  drought: { every: 0.3, move: 8 },
  storm: { every: 0.8, move: 8 },
  fire: { every: 0.05, move: 1 },
  volcano: { every: 1.2, move: 6 },
  meteor: { every: 1, move: 0 },
  bless: { every: 0.6, move: 4 },
  inspire: { every: 0.6, move: 4 },
  plague: { every: 0.8, move: 6 },
  prophet: { every: 1, move: 6 },
  discord: { every: 1.2, move: 8 },
  peace: { every: 1, move: 6 },
  nuke: { every: 3, move: 10 },
  quake: { every: 2.5, move: 12 },
  hurricane: { every: 3, move: 20 },
}
/** A god's quake of this magnitude or more cracks the plate; a meteor this many tiles wide too. */
const CRACK_MAGNITUDE = 8.5
/** This many god quakes of this magnitude or more within this many real seconds remake the world. */
const CATACLYSM_MAGNITUDE = 9
const CATACLYSM_QUAKES = 3
const CATACLYSM_WINDOW = 25
const CRACK_METEOR = 20
/** The powers over the peoples (they act on the town nearest the click). */
export const PEOPLE_POWERS: Tool2d[] = ['bless', 'inspire', 'plague', 'prophet', 'discord', 'peace']
/** Strokes kept to undo, moments kept to rewind (one every REWIND_YEARS). */
const MAX_UNDO = 6
const MAX_REWIND = 12
const REWIND_YEARS = 10
const MAX_ANNALS = 800
/** The next frame, on the page or in a worker (a timer where there are no animation frames). */
const nextFrame = (fn: (now: number) => void): number =>
  typeof requestAnimationFrame === 'function' ? requestAnimationFrame(fn) : (setTimeout(() => fn(performance.now()), 16) as unknown as number)
const cancelFrame = (id: number) => (typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame(id) : clearTimeout(id))
const MAX_NEWS = 40
/** The keys that move the map, and where to. */
const PAN_KEYS: Record<string, [number, number]> = {
  KeyW: [0, -1], ArrowUp: [0, -1], KeyS: [0, 1], ArrowDown: [0, 1],
  KeyA: [-1, 0], ArrowLeft: [-1, 0], KeyD: [1, 0], ArrowRight: [1, 0],
}

type Listener = () => void

export class Game {
  readonly canvas: Canvas
  private readonly ctx: Ctx
  /** Where the game runs (the page or a worker): its size on screen, its sounds, its files. */
  private readonly host: GameHost
  world: TileWorld
  readonly life = (() => {
    // the tile world is round east to west: the peoples' distances, roads and voyages cross the map's edge
    const life = new Life()
    life.wrapWidth = 1
    return life
  })()
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
  private repeat: { x: number; y: number; t: number } | null = null
  /** The plates tool: the plate grabbed and whether it has been turned. */
  private plateDrag: { x: number; y: number; turned: boolean } | null = null
  private lastSteer = 0
  /** Smoking towns, from the last stats (for the industry's warming). */
  private industries = 0
  private worksClock = 0
  /** The keys held down (the ones that pan the map, and Shift). */
  private held = new Set<string>()
  private news: News[] = []
  private annals: News[] = []
  private undoStack: Snap[] = []
  private ring: Snap[] = []
  private effects: Effect[] = []
  /** Screen shake left (pixels), easing off. */
  private shake = 0
  private challenge: ChallengeState | null = null
  private completed: string[] = []
  private metricsClock = 0
  private peaceYears = 0
  private eraLog: Record<number, [number, number][]> = {}
  private techPast: Record<number, number[]> = {}
  private techTrend: Record<number, number> = {}
  /** When (real seconds) the god's great quakes (9+) struck: three close together break the world. */
  private greatQuakes: number[] = []
  /** Hurricanes whose striking of towns was already told. */
  private toldHurricanes = new Set<string>()
  /** Aftershocks to come: where, how strong, when (real seconds). */
  private aftershocks: { x: number; y: number; m: number; at: number }[] = []
  /** Warheads in flight: where they land and when (real seconds). */
  private blasts: { x: number; y: number; at: number; god?: boolean }[] = []
  private history: YearRecord[] = []
  private lastRecord = -1
  private newsId = 0
  /** The life time of the newest chronicle line already turned into news. */
  private lifeSeen = -1
  /** The world's own news also written into the chronicle (not to be taken twice). */
  private ownChronicle = new Set<string>()
  private message: string | null = null
  private messageTimer = 0
  private disposed = false
  /** The globe (made the first time it is asked for), where it is seen from, where it is gliding to, and the drag that turns it. */
  private globe: Globe | null = null
  private globeView: GlobeView = { lon: 0, lat: 0.35, zoom: 1 }
  private globeGoal: { lon: number; lat: number } | null = null
  private globeDrag: { x: number; y: number; lon: number; lat: number } | null = null

  constructor(canvas: Canvas, host: GameHost) {
    this.canvas = canvas
    this.host = host
    this.ctx = context2d(canvas)
    this.completed = host.completed()
    this.world = new TileWorld(this.settings.world)
    this.world.onDrift = this.carryLife
    this.renderer = new Renderer2D(this.world)
    this.view = { cx: this.world.n / 2, cy: this.world.n / 2, zoom: 5 }
    this.stats = this.makeStats(0)
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
    if (partial.globe !== undefined) {
      if (partial.globe) {
        this.globe ??= new Globe(this.host.globeCanvas())
        if (!this.globe.ok) {
          this.settings = { ...this.settings, globe: false }
          this.toast('Este navegador não oferece WebGL: o globo não pode ser desenhado aqui')
        } else {
          // it opens looking at the middle of the flat view
          const [lon] = globePlace(wrap(this.view.cx, this.world.n) / this.world.n, 0.5)
          this.globeView = { ...this.globeView, lon }
        }
      }
      this.host.showGlobe(this.settings.globe)
      this.cursor = null
    }
    if (partial.challenge !== undefined) {
      if (partial.challenge) this.startChallenge(partial.challenge)
      else this.challenge = null
    }
    // the wind, the temperature and the weather apply to the running world at once
    if (partial.world) {
      const live: Partial<WorldOptions> = {}
      for (const k of LIVE_OPTIONS) (live as Record<string, unknown>)[k] = partial.world[k]
      Object.assign(this.world.opts, live)
    }
    this.emit()
  }

  /** A new world from the options (a new seed unless given). */
  newWorld(world: Partial<WorldOptions> = {}) {
    const opts: WorldOptions = { ...this.settings.world, ...world }
    if (world.seed === undefined) opts.seed = 1 + Math.floor(Math.random() * 100000)
    this.settings = { ...this.settings, world: opts, paused: false }
    this.world = new TileWorld(opts)
    this.world.onDrift = this.carryLife
    this.renderer = new Renderer2D(this.world)
    this.life.reset()
    this.news = []
    this.annals = []
    this.undoStack = []
    this.ring = []
    this.effects = []
    this.blasts = []
    this.aftershocks = []
    this.eraLog = {}
    this.techPast = {}
    this.techTrend = {}
    this.familySlots = new Map()
    this.peaceYears = 0
    this.history = []
    this.lastRecord = -1
    this.lifeSeen = -1
    this.ownChronicle.clear()
    this.selectedTown = null
    this.lastFollowed = -1
    this.accumulator = 0
    this.fit()
    // a goal chosen with the world starts from it
    this.challenge = null
    if (this.settings.challenge) this.startChallenge(this.settings.challenge)
    this.stats = this.makeStats(this.stats.fps)
    this.emit()
  }

  /** The view framing the whole world. */
  fit() {
    this.globeView = { ...this.globeView, lat: 0.35, zoom: 1 }
    this.globeGoal = null
    const size = this.host.size()
    const w = size.width || 800
    const h = size.height || 600
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
    const [lon, lat] = globePlace(pos[0], pos[1])
    this.globeGoal = { lon, lat: Math.max(-GLOBE_TILT, Math.min(GLOBE_TILT, lat)) }
  }

  /** A sound for something that happened, when the sounds are on. */
  private play(kind: SoundKind) {
    if (this.settings.sound) this.host.sound(kind)
  }

  notice(text: string | null) {
    this.message = text
    this.stats = { ...this.stats, message: text }
    this.emit()
  }
  private toast(text: string) {
    this.notice(text)
    clearTimeout(this.messageTimer)
    this.messageTimer = setTimeout(() => {
      if (this.message === text) this.notice(null)
    }, 5000)
  }

  // ---- the loop ----------------------------------------------------------------------

  start() {
    this.lastTime = performance.now()
    const frame = (now: number) => {
      if (this.disposed) return
      this.tick(now)
      this.raf = nextFrame(frame)
    }
    this.raf = nextFrame(frame)
  }

  dispose() {
    this.disposed = true
    cancelFrame(this.raf)
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
      const due = Math.min(Math.floor(this.accumulator), MAX_TICKS_PER_FRAME)
      const until = performance.now() + TICK_BUDGET_MS
      while (ticks < due && (ticks === 0 || performance.now() < until)) {
        this.world.tick()
        ticks++
      }
      this.accumulator = Math.min(this.accumulator - ticks, 2)
      if (s.life && ticks) {
        this.life.update(ticks * TICK, this.world.field, 1)
        this.worksClock += ticks
        if (this.worksClock >= 10) {
          this.worksClock = 0
          this.world.applyWorks(this.works())
        }
      } else if (ticks) {
        // without the peoples their marks fade away
        this.worksClock += ticks
        if (this.worksClock >= 10) {
          this.worksClock = 0
          this.world.applyWorks([])
        }
      }
      if (ticks) {
        this.climateDrift(ticks * TICK)
        this.record()
        this.keepMoment()
      }
      if (ticks) this.gatherNews()
    }
    this.launch()
    // the aftershocks come
    if (this.aftershocks.length) {
      const now = this.realTime
      for (const a of this.aftershocks.filter((a) => a.at <= now)) this.shock(a.x, a.y, a.m)
      this.aftershocks = this.aftershocks.filter((a) => a.at > now)
      this.gatherNews()
    }
    // the warheads land
    if (this.blasts.length) {
      const now = this.realTime
      for (const b of this.blasts.filter((b) => b.at <= now)) {
        this.world.nuke(b.x, b.y)
        // a bomb from the gods hits the towns when it lands (a people's warheads already did)
        if (b.god && this.settings.life) this.life.blast([b.x / this.world.n, b.y / this.world.n])
        else if (b.god) this.chronicle('☢ Uma bomba atômica explode.', true, [b.x / this.world.n, b.y / this.world.n])
        this.shake = Math.max(this.shake, 22)
        this.play('boom')
      }
      this.blasts = this.blasts.filter((b) => b.at > now)
    }
    // painting with the held brush
    if (this.painting && this.cursor) this.paint(dt)
    if (this.repeat && this.cursor) this.repeatPower()
    this.pan(dt)
    // the effects run out; the shake eases off
    if (this.effects.length) this.effects = this.effects.filter((e) => this.realTime - e.t0 < e.dur)
    this.shake = Math.max(0, this.shake - dt * 30)
    this.metricsClock += dt
    if (this.metricsClock > 2 && this.challenge && !this.challenge.done) {
      this.metricsClock = 0
      this.checkChallenge()
    }
    // the view glides to its goal
    if (this.goal) {
      const g = this.goal
      const v = this.view
      const k = 1 - Math.exp(-dt * 6)
      // (east–west the short way round the world)
      const dx = wrapDelta(g.cx, v.cx, this.world.n)
      v.cx += dx * k
      v.cy += (g.cy - v.cy) * k
      v.zoom += (g.zoom - v.zoom) * k
      if (Math.abs(dx) < 0.05 && Math.abs(g.zoom - v.zoom) < 0.02) this.goal = null
    }
    // the globe turns to its goal the short way round
    if (this.globeGoal) {
      const g = this.globeGoal
      const v = this.globeView
      const k = 1 - Math.exp(-dt * 6)
      const turn = Math.atan2(Math.sin(g.lon - v.lon), Math.cos(g.lon - v.lon))
      v.lon += turn * k
      v.lat += (g.lat - v.lat) * k
      if (Math.abs(turn) < 0.002 && Math.abs(g.lat - v.lat) < 0.002) this.globeGoal = null
    }
    this.clampView()
    // drawing (the colours follow the map mode)
    if (this.renderer.overlay !== s.overlay || this.renderer.mapLook !== s.look) {
      this.renderer.overlay = s.overlay
      this.renderer.mapLook = s.look
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

  /** The plates moved: the towns, herds and ruins on them ride along (world units = uv in the 2D game). */
  private carryLife = (moved: (x: number, y: number) => [number, number] | null) => {
    const n = this.world.n
    this.life.drift((pos) => {
      const d = moved(pos[0] * n, pos[1] * n)
      return d ? [d[0] / n, d[1] / n] : null
    })
  }

  /** Each language family's colour slot, in the order the families were first seen (stable). */
  private familySlots = new Map<number, number>()

  /**
   * On the maps of the peoples: each people's colour index → the colour of its category
   * (its era, faith, tongue's family, how much plague or hunger, war or peace).
   */
  private categories(): Map<number, [number, number, number]> | null {
    const o = this.settings.overlay
    const civs = this.stats.life?.civs
    if (!civs || !PEOPLE_MAPS.includes(o) || o === 'civilization') return null
    const out = new Map<number, [number, number, number]>()
    const mix = (a: number[], b: number[], t: number): [number, number, number] => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
    for (const c of civs) {
      let col: [number, number, number]
      if (o === 'eras') col = ERA_RAMP[c.eraIndex]
      else if (o === 'faith') col = CATEGORICAL[c.faithIndex % CATEGORICAL.length]
      else if (o === 'language') {
        if (!this.familySlots.has(c.family)) this.familySlots.set(c.family, this.familySlots.size)
        col = CATEGORICAL[this.familySlots.get(c.family)! % CATEGORICAL.length]
      } else if (o === 'plague') col = mix([214, 210, 196], [110, 160, 30], Math.min(1, c.plague * 1.5))
      else if (o === 'famine') col = mix([214, 210, 196], [175, 85, 20], Math.min(1, c.famine * 1.5))
      else col = c.atWar ? [230, 103, 103] : [150, 172, 196]
      out.set(c.color, col)
    }
    return out
  }

  /**
   * The peoples' works for the land (fields, towns, industry, dams), and before farming
   * every village cuts some wood around it (kind 0: only the clearing).
   */
  private works(): Work[] {
    const n = this.world.n
    const out = this.life.works([0, 0], n, 1)
    for (const m of this.life.markers([0, 0], n, 1)) {
      if (m.kind !== 'village') continue
      out.push({ uv: m.uv, radius: 0.008 + 0.014 * m.size, kind: 0, strength: m.tech, size: m.size })
    }
    return out
  }

  /**
   * A record a year for the charts: the mean temperature, the CO₂ the industry put in the
   * air (280 ppm before it, doubling for every 3 °C of its warming: a climate sensitivity of
   * 3 °C), the sea level over its start in metres, and the people.
   */
  private record() {
    const year = Math.floor(this.world.time / 10)
    if (year <= this.lastRecord) return
    this.lastRecord = year
    if (this.settings.life) {
      const st = this.life.stats()
      this.peaceYears = st.wars.length === 0 && st.civs.length > 0 ? this.peaceYears + 1 : 0
      // each people's era over the years, and how fast it is learning (the last ten years)
      const eraLog = { ...this.eraLog }
      const trend: Record<number, number> = {}
      for (const c of st.civs) {
        const log = eraLog[c.id] ?? []
        if (!log.length || log[log.length - 1][1] !== c.eraIndex) eraLog[c.id] = [...log, [year, c.eraIndex]]
        const past = [...(this.techPast[c.id] ?? []), c.tech].slice(-11)
        this.techPast[c.id] = past
        trend[c.id] = c.tech - past[0]
      }
      this.eraLog = eraLog
      this.techTrend = trend
    }
    const w = this.world
    const rec: YearRecord = {
      year,
      temperature: w.summary.meanTemp,
      co2: 280 * 2 ** (w.civWarming / 3),
      sea: w.sea * METERS_PER_HEIGHT,
      population: this.settings.life ? this.life.stats().people : 0,
    }
    this.history = [...this.history.slice(-(RECORD_YEARS - 1)), rec]
  }

  /**
   * The slow climate: industry warms the planet (as in the 3D game: a degree per ten smoking
   * towns per five simulated minutes, up to 4 °C) and the warmth fades once the smoke stops;
   * the continuous warming raises the temperature slider by itself.
   */
  private climateDrift(simSeconds: number) {
    const w = this.world
    const before = w.civWarming
    if (this.settings.life && this.industries > 0) w.civWarming = Math.min(4, w.civWarming + simSeconds * (this.industries / 3000))
    else {
      w.civWarming *= Math.exp(-simSeconds / 300)
      if (w.civWarming < 0.02) w.civWarming = 0
    }
    for (const level of [0.5, 1, 2, 3]) {
      if (before < level && w.civWarming >= level) {
        w.events.push({ text: `A fumaça das indústrias já aquece o planeta ${String(level).replace('.', ',')} °C.`, major: level >= 1 })
      }
    }
    const o = this.settings.world
    if (o.warming) {
      const temperature = Math.min(15, o.temperature + (o.warmingRate * simSeconds) / 60)
      if (temperature !== o.temperature) {
        // the slider moves with it (rounded so the interface does not churn every frame)
        w.opts.temperature = temperature
        this.settings = { ...this.settings, world: { ...o, temperature } }
      }
    }
  }

  /** Turns the world's events and the new chronicle lines into news for the cards. */
  private gatherNews() {
    const w = this.world
    const fresh: News[] = []
    const year = this.year()
    for (const e of w.events) {
      const pos: [number, number] | undefined = e.x !== undefined && e.y !== undefined ? [e.x / w.n, e.y / w.n] : undefined
      // a hurricane over towns (silent: it is drawn all along)
      if (e.fx === 'hurricane') {
        if (this.settings.life && pos) {
          const tell = !this.toldHurricanes.has(e.name ?? '')
          const hit = this.life.windstorm(pos, (e.size ?? 10) / w.n, e.strength ?? 0.5, e.name ?? '', tell)
          if (hit && tell) this.toldHurricanes.add(e.name ?? '')
        }
        continue
      }
      if (e.fx && e.x !== undefined && e.y !== undefined) {
        this.effect(e.fx, e.x, e.y, e.size ?? 6, e.fx === 'eruption' ? 6 : e.fx === 'tsunami' ? 7 : 2.5)
        if (e.fx === 'quake' && this.settings.life) {
          this.life.shake([e.x / w.n, e.y / w.n], ((e.size ?? 6) * 1.6) / w.n, Math.min(1, (e.size ?? 6) / 30))
        }
        if (e.fx === 'tsunami' && this.settings.life) {
          this.life.flood([e.x / w.n, e.y / w.n], (e.size ?? 20) / w.n, (p) => w.coastTown(p[0] * w.n, p[1] * w.n))
        }
        if (e.fx === 'eruption' && this.settings.life && this.life.airRoutes().length) {
          fresh.push({ id: ++this.newsId, year, text: 'As cinzas do vulcão fecham o céu: voos cancelados por onde a nuvem passa.', color: null, major: false, pos })
        }
        if (e.fx === 'quake') {
          this.shake = Math.max(this.shake, Math.min(14, (e.size ?? 6) * 0.6))
          this.play('rumble')
        } else if (e.fx === 'eruption') this.play('rumble')
        else this.play('rumble')
      }
      fresh.push({ id: ++this.newsId, year, text: e.text, color: null, major: !!e.major, pos })
      // with the peoples on, the world's news goes into their chronicle too
      if (this.settings.life) {
        this.ownChronicle.add(e.text)
        this.life.chronicle(e.text, !!e.major, pos)
      }
    }
    w.events = []
    if (this.settings.life) {
      for (const e of this.life.chronicleEvents) {
        if (e.time <= this.lifeSeen) continue
        if (this.ownChronicle.delete(e.text)) continue
        fresh.push({ id: ++this.newsId, year: e.year, text: e.text, color: e.color, major: e.major, pos: e.pos })
      }
      this.lifeSeen = this.life.now
    }
    if (!fresh.length) return
    fresh.reverse()
    this.news = [...fresh, ...this.news].slice(0, MAX_NEWS)
    const big = fresh.filter((e) => e.major)
    if (big.length) this.annals = [...big, ...this.annals].slice(0, MAX_ANNALS)
    if (this.settings.followEvents) {
      const last = this.news.find((e) => e.pos)
      if (last && last.id > this.lastFollowed) {
        this.lastFollowed = last.id
        this.flyTo(last.pos!, Math.max(this.view.zoom, 9))
      }
    }
  }

  private year() {
    return this.settings.life ? this.life.year : Math.floor(this.world.time / 10)
  }

  private clampView() {
    const v = this.view
    const n = this.world.n
    v.zoom = Math.max(1, Math.min(40, v.zoom))
    const h = this.host.size().height / v.zoom
    // east and west the world goes round: the view may go on for ever that way. Between
    // gestures it is brought back onto the map (the same place, a whole world over), and
    // the pointer's place with it
    if (!this.dragging && !this.painting && !this.repeat && !this.plateDrag && !this.goal) {
      const cx = wrap(v.cx, n)
      if (cx !== v.cx) {
        if (this.cursor) this.cursor = [this.cursor[0] + cx - v.cx, this.cursor[1]]
        v.cx = cx
      }
    }
    v.cy = Math.max(Math.min(h / 2, n / 2), Math.min(n - h / 2, v.cy))
  }

  private draw() {
    const c = this.canvas
    const size = this.host.size()
    const dpr = Math.min(size.dpr || 1, 2)
    const width = Math.round(size.width * dpr)
    const height = Math.round(size.height * dpr)
    if (!width || !height) return
    if (c.width !== width || c.height !== height) {
      c.width = width
      c.height = height
    }
    const s = this.settings
    const n = this.world.n
    const brush = this.cursor && s.tool !== 'inspect' && s.tool !== 'sun' && s.tool !== 'plates' ? { x: this.cursor[0], y: this.cursor[1], r: this.brushRadius() } : null
    const selected = this.selectedTown !== null ? this.life.reportOf(this.selectedTown)?.pos ?? null : null
    // the globe: the whole map drawn flat off screen, then wrapped on the sphere
    const globe = s.globe && this.globe?.ok ? this.globe : null
    const side = Globe.mapSize(n)
    if (globe && (globe.map.width !== side || globe.map.height !== side)) {
      globe.map.width = side
      globe.map.height = side
    }
    const ctx = globe ? context2d(globe.map) : this.ctx
    ctx.save()
    if (!globe) {
      ctx.scale(dpr, dpr)
      if (this.shake > 0) ctx.translate((Math.random() - 0.5) * this.shake, (Math.random() - 0.5) * this.shake)
    }
    const view = globe ? { cx: n / 2, cy: n / 2, zoom: side / n } : this.view
    this.renderer.draw(ctx, globe ? side : size.width, globe ? side : size.height, view, {
      globe: !!globe,
      // no planes fly through volcanic ash
      markers: s.life ? this.life.markers([0, 0], n, 1).filter((m) => m.kind !== 'plane' || !this.world.inAsh(m.uv[0] * n, m.uv[1] * n)) : [],
      roads: s.life ? this.life.roads([0, 0], n, 1) : [],
      territory: s.life && (s.territory || PEOPLE_MAPS.includes(s.overlay)) ? this.life.territory([0, 0], n, 1) : null,
      categories: this.categories(),
      labels: s.life ? this.life.labels([0, 0], n, 1, this.selectedTown, s.overlay === 'civilization') : [],
      time: this.realTime,
      effects: this.effects,
      clouds: s.clouds,
      look: s.look,
      dayNight: s.dayNight,
      plateArrows: s.overlay === 'plates' || s.tool === 'plates',
      plateDrag: this.plateDrag && this.cursor ? [this.plateDrag.x, this.plateDrag.y, this.cursor[0], this.cursor[1]] : null,
      windArrows: s.windArrows,
      brush,
      selected,
    })
    ctx.restore()
    if (globe) globe.render(this.globeView, size.width, size.height, dpr)
  }

  private makeStats(fps: number): Stats2d {
    const w = this.world
    return {
      fps,
      simTime: w.time,
      season: w.season,
      n: w.n,
      sun: w.sun,
      dust: w.dust,
      droughts: w.droughts.length,
      storms: w.storms.length,
      volcanoes: w.vents.length,
      summary: w.summary,
      human: w.humanSummary(),
      civWarming: w.civWarming,
      sea: w.sea,
      life: this.lifeStats(),
      tile: this.cursor ? this.tileInfo(Math.floor(this.cursor[0]), Math.floor(this.cursor[1])) : null,
      message: this.message,
      news: this.news,
      history: this.history,
      annals: this.annals,
      undoDepth: this.undoStack.length,
      rewindYears: this.ring.length ? Math.max(0, Math.floor(this.world.time / 10) - this.ring[0].year) : 0,
      challenge: this.challenge,
      completed: this.completed,
      eraLog: this.eraLog,
      techTrend: this.techTrend,
    }
  }

  private lifeStats() {
    if (!this.settings.life) {
      this.industries = 0
      return null
    }
    const stats = this.life.stats()
    this.industries = stats.industries
    return { ...stats, selected: this.life.reportOf(this.selectedTown) }
  }

  tileInfo(tx: number, y: number): TileInfo | null {
    const w = this.world
    const n = w.n
    // (east–west the column is the one round the world)
    const x = wrap(tx, n)
    if (y < 0 || y >= n) return null
    const i = (y * n + x) * 4
    const t = w.climate[i + 3]
    const v = w.extra[i]
    const water = w.water[i]
    const height = w.ground[i]
    const snow = w.extra[i + 2]
    const sand = w.ground[i + 3]
    let biome: string
    if (w.lava[i] > 0.0002) biome = 'lava'
    else if (height < w.sea) biome = height < w.sea - 0.04 ? 'mar profundo' : 'mar raso'
    else if (w.urban[y * n + x] > 0.4) biome = 'cidade'
    else if (water > 0.002) biome = w.extra[i + 3] > 0 ? 'lago gelado' : 'lago'
    else if (w.fire[(y * n + x)] > 0) biome = 'incêndio'
    else if (snow > 0.5) biome = height > 0.13 ? 'pico nevado' : 'neve'
    else if (height > 0.17) biome = 'montanha'
    else if (sand > 0.5) biome = 'deserto'
    else if (t < 6) biome = 'tundra'
    else if (w.farmland[y * n + x] > 0.4) biome = 'lavoura'
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
      pressure: w.pressureAt(x + 0.5, y + 0.5),
      airTemperature: w.airT[y * n + x],
      ...this.plateInfo(x, y),
      farmland: w.farmland[y * n + x],
      cleared: w.cleared[y * n + x],
      urban: w.urban[y * n + x],
      fallout: w.fallout[y * n + x],
      windSpeed: Math.hypot(w.tileU[y * n + x], w.tileV[y * n + x]) * TICKS_PER_SECOND,
      windAngle: ((Math.atan2(w.tileV[y * n + x], w.tileU[y * n + x]) * 180) / Math.PI + 360) % 360,
      town: this.settings.life ? this.life.townAt([(x + 0.5) / n, (y + 0.5) / n], 2.5 / n) : null,
    }
  }

  private plateInfo(x: number, y: number) {
    const t = this.world.tectonics
    const i = y * this.world.n + x
    const site = t.sites[t.plate[i]]
    const near = t.dist[i] < 0.08
    return {
      plateAngle: site ? ((Math.atan2(site.vy, site.vx) * 180) / Math.PI + 360) % 360 : 0,
      plateSpeed: site ? Math.hypot(site.vx, site.vy) : 0,
      boundary: near ? BOUNDARY_NAMES[t.boundaryAt(x + 0.5, y + 0.5).kind] : null,
    }
  }

  // ---- input -------------------------------------------------------------------------

  // (the player's input comes in plain values, from the page: see dom.ts)

  pointerDown = (e: PointerInput) => {
    if (!e.onMap) return
    const tile = this.pointerTile(e)
    this.cursor = tile
    const s = this.settings
    // on the globe a drag with the Look power (or the other buttons, or from the space round it) turns it
    if (s.globe && (e.button === 1 || e.button === 2 || s.tool === 'inspect' || !tile)) {
      this.globeDrag = { x: e.clientX, y: e.clientY, lon: this.globeView.lon, lat: this.globeView.lat }
      this.globeGoal = null
      if (tile && s.tool === 'inspect' && e.button === 0 && s.life) {
        const town = this.life.townAt([tile[0] / this.world.n, tile[1] / this.world.n], 2.5 / this.world.n)
        this.selectedTown = town ? town.id : null
        this.stats = this.makeStats(this.stats.fps)
        this.emit()
      }
      return
    }
    if (!tile) return
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
    this.pushUndo()
    if (s.tool === 'plates') {
      this.plateDrag = { x: tile[0], y: tile[1], turned: false }
      return
    }
    if (BRUSH_TOOLS.includes(s.tool)) this.painting = true
    else {
      this.act(tile)
      this.repeat = { x: tile[0], y: tile[1], t: performance.now() / 1000 }
    }
  }
  pointerMove = (e: PointerInput) => {
    if (this.globeDrag) {
      const d = this.globeDrag
      const size = this.host.size()
      const r = Globe.radius(this.globeView, size.width, size.height)
      this.globeView.lon = d.lon - (e.clientX - d.x) / r
      this.globeView.lat = Math.max(-GLOBE_TILT, Math.min(GLOBE_TILT, d.lat + (e.clientY - d.y) / r))
      return
    }
    if (this.dragging) {
      const d = this.dragging
      this.view.cx = d.cx - (e.clientX - d.x) / this.view.zoom
      this.view.cy = d.cy - (e.clientY - d.y) / this.view.zoom
      return
    }
    this.cursor = e.onMap || this.painting || this.repeat || this.plateDrag ? this.pointerTile(e) : null
    if (this.repeat && this.cursor) this.repeatPower()
    if (this.plateDrag && this.cursor) this.steerPlate()
  }
  pointerUp = () => {
    this.globeDrag = null
    this.dragging = null
    this.painting = false
    this.repeat = null
    if (this.plateDrag) {
      // letting go of a turned plate shakes its boundary
      const d = this.plateDrag
      this.plateDrag = null
      if (d.turned) {
        const b = this.world.tectonics.boundaryAt(d.x, d.y)
        this.world.quake(b.x, b.y, b.nx, b.ny, b.kind, 5.5 + Math.random())
        this.gatherNews()
      }
    }
  }
  wheel = (e: WheelInput) => {
    if (!e.onMap) return
    if (e.shiftKey) {
      this.set({ brushSize: Math.max(1, Math.min(40, this.settings.brushSize * (e.deltaY < 0 ? 1.2 : 1 / 1.2))) })
      return
    }
    const v = this.view
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15
    if (this.settings.globe) {
      this.globeView.zoom = Math.max(0.5, Math.min(8, this.globeView.zoom * factor))
      return
    }
    const before = this.tileAt(e)
    v.zoom = Math.max(1, Math.min(40, v.zoom * factor))
    this.goal = null
    const after = this.tileAt(e)
    v.cx += before[0] - after[0]
    v.cy += before[1] - after[1]
  }
  keyDown = (e: KeyInput) => {
    const tools: Record<string, Tool2d> = {
      Digit0: 'inspect', Digit1: 'terrain', Digit2: 'water', Digit3: 'forest', Digit4: 'rain', Digit5: 'heat', Digit6: 'sun',
      Digit7: 'people', Digit8: 'drought', Digit9: 'storm', KeyF: 'fire', KeyV: 'volcano', KeyM: 'meteor', KeyB: 'pressure', KeyG: 'plates',
      KeyJ: 'bless', KeyK: 'inspire', KeyL: 'plague', KeyN: 'prophet', KeyQ: 'discord', KeyE: 'peace', KeyU: 'nuke', KeyH: 'quake', KeyY: 'hurricane',
    }
    if ((e.ctrlKey || e.metaKey) && e.code === 'KeyZ') {
      this.undo()
      return
    }
    if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') this.held.add(e.code)
    if (tools[e.code]) this.set({ tool: tools[e.code] })
    else if (e.code === 'Escape') this.set({ tool: 'inspect' })
    else if (e.code === 'KeyX') this.set({ mode: this.settings.mode === 'add' ? 'remove' : 'add' })
    else if (e.code === 'KeyP' || e.code === 'Space') {
      this.set({ paused: !this.settings.paused })
    } else if (e.key === '[') this.set({ brushSize: Math.max(1, this.settings.brushSize / 1.25) })
    else if (e.key === ']') this.set({ brushSize: Math.min(40, this.settings.brushSize * 1.25) })
    else if (e.code === 'KeyR') this.fit()
    else if (e.code === 'KeyO') this.cycleOverlay(e.shiftKey ? -1 : 1)
    else if (e.code === 'KeyT') this.set({ windArrows: !this.settings.windArrows })
    else if (e.code === 'KeyI') this.set({ look: this.settings.look === 'satellite' ? 'illustrated' : 'satellite' })
    else if (PAN_KEYS[e.code]) {
      this.held.add(e.code)
      this.goal = null
    }
  }
  keyUp = (e: KeyInput) => {
    this.held.delete(e.code)
  }
  blur = () => this.held.clear()

  /** WASD and the arrows glide the map while held (Shift: faster), the same speed on screen at any zoom. */
  private pan(dt: number) {
    let dx = 0
    let dy = 0
    for (const code of this.held) {
      const d = PAN_KEYS[code]
      if (!d) continue
      dx += d[0]
      dy += d[1]
    }
    if (!dx && !dy) return
    const len = Math.hypot(dx, dy)
    if (this.settings.globe) {
      // the keys turn the globe: the same pace on screen at any zoom
      const turn = ((this.held.has('ShiftLeft') || this.held.has('ShiftRight') ? 2.4 : 1) / this.globeView.zoom) * dt
      this.globeGoal = null
      this.globeView.lon += (dx / len) * turn
      this.globeView.lat = Math.max(-GLOBE_TILT, Math.min(GLOBE_TILT, this.globeView.lat - (dy / len) * turn))
      return
    }
    const speed = (this.held.has('ShiftLeft') || this.held.has('ShiftRight') ? 1400 : 600) / this.view.zoom
    this.view.cx += (dx / len) * speed * dt
    this.view.cy += (dy / len) * speed * dt
  }
  leave = () => {
    if (!this.painting && !this.dragging && !this.repeat && !this.plateDrag) this.cursor = null
  }

  /** The tile under the pointer (its place from the map's top left corner): on the flat map always one; on the globe none when the pointer is off it. */
  private pointerTile(e: { clientX: number; clientY: number }): [number, number] | null {
    if (!this.settings.globe) return this.tileAt(e)
    const r = this.host.size()
    const place = globePick(e.clientX - r.width / 2, e.clientY - r.height / 2, Globe.radius(this.globeView, r.width, r.height), this.globeView)
    return place ? [place[0] * this.world.n, place[1] * this.world.n] : null
  }

  private tileAt(e: { clientX: number; clientY: number }): [number, number] {
    const r = this.host.size()
    const v = this.view
    return [v.cx + (e.clientX - r.width / 2) / v.zoom, v.cy + (e.clientY - r.height / 2) / v.zoom]
  }

  private brushRadius() {
    const s = this.settings
    if (s.tool === 'meteor') return Math.max(3, s.brushSize)
    if (s.tool === 'quake') {
      // the shaken area (see TileWorld.quake and the towns' shaking)
      const m = 5 + (Math.min(s.brushSize, 40) / 40) * 4.5
      return Math.min(Math.max(10 * 10 ** ((m - 6) / 2), 4), 40) * 1.6
    }
    if (s.tool === 'storm' || s.tool === 'drought' || s.tool === 'pressure') return Math.max(6, s.brushSize * 2.5)
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
      case 'pressure':
        this.world.pushPressure(x, y, Math.max(this.brushRadius(), PB * 2), sign * 0.04 * k)
        break
      default:
        break
    }
  }

  /** The plates tool: the drag points the plate grabbed the way it goes (longer: faster), as in the 3D game. */
  private steerPlate() {
    const d = this.plateDrag!
    const [x, y] = this.cursor!
    const dx = x - d.x
    const dy = y - d.y
    const len = Math.hypot(dx, dy)
    if (len < 2) return
    // at most every 150 ms: each turn redraws the whole plate map (also while paused)
    const now = performance.now()
    if (now - this.lastSteer < 150) return
    this.lastSteer = now
    const t = this.world.tectonics
    const speed = Math.min(Math.max(len / (0.3 * t.scale), 0.2), 1)
    t.steer(d.x, d.y, (dx / len) * speed, (dy / len) * speed)
    t.recompute(this.world.ground, this.world.sea)
    if (!d.turned) this.toast('Placa virada: solte para a borda tremer. A deriva segue no slider do painel Mundo')
    d.turned = true
  }

  /** A power held down: it acts again once its time has come and the cursor has moved enough. */
  private repeatPower() {
    const rule = REPEAT[this.settings.tool]
    const r = this.repeat!
    const [x, y] = this.cursor!
    const now = performance.now() / 1000
    const dist = Math.hypot(x - r.x, y - r.y)
    if (!rule || now - r.t < rule.every || dist < rule.move) return
    this.repeat = { x, y, t: now }
    // the fire follows the whole stroke, however fast the drag
    if (this.settings.tool === 'fire') {
      const steps = Math.ceil(dist)
      for (let k = 1; k < steps; k++) this.world.ignite(r.x + ((x - r.x) * k) / steps, r.y + ((y - r.y) * k) / steps, Math.max(1, this.settings.brushSize * 0.5))
    }
    this.act([x, y], true)
  }

  /** The powers that act on a click (and again while held: `again`, which keeps the chronicle quiet). */
  act(tile: [number, number], again = false) {
    const s = this.settings
    const w = this.world
    const [x, y] = tile
    const pos: [number, number] = [x / w.n, y / w.n]
    const remove = s.mode === 'remove'
    switch (s.tool) {
      case 'bless':
      case 'inspire':
      case 'plague':
      case 'prophet':
      case 'discord':
      case 'peace': {
        if (!s.life) {
          if (!again) this.toast('Ligue a vida (aba Vida) para usar os poderes sobre os povos')
          return
        }
        const text = this.life.godPower(s.tool, [x / w.n, y / w.n], 0.045)
        if (!text) {
          if (!again) this.toast('Nenhuma cidade aqui: clique perto de uma cidade')
          return
        }
        this.toast(text)
        const fx = { bless: 'sparkle', inspire: 'inspire', plague: 'plague', prophet: 'prophet', discord: 'war', peace: 'peace' } as const
        this.effect(fx[s.tool], x, y, 4, 2.2)
        const snd: Record<string, SoundKind> = { bless: 'chime', inspire: 'chime', plague: 'plague', prophet: 'whoosh', discord: 'war', peace: 'chime' }
        this.play(snd[s.tool])
        break
      }
      case 'hurricane': {
        w.hurricane(x, y)
        this.play('thunder')
        this.toast('Um furacão nasce: cresce sobre mar quente, morre em terra ou mar frio')
        break
      }
      case 'quake': {
        // the brush gives the magnitude: 5 to 9.5
        const m = 5 + (Math.min(s.brushSize, 40) / 40) * 4.5
        this.shock(x, y, m)
        // aftershocks: more and stronger after a bigger one, over the next seconds
        const count = Math.round((m - 5) * 1.6)
        for (let k = 0; k < count; k++) {
          const a = Math.random() * Math.PI * 2
          const d = Math.random() * (6 + (m - 5) * 4)
          this.aftershocks.push({ x: x + Math.cos(a) * d, y: y + Math.sin(a) * d, m: m - 1 - Math.random() * 1.5, at: this.realTime + 0.8 + k * (0.6 + Math.random() * 0.8) })
        }
        // only a god's great quake breaks a plate
        if (m >= CRACK_MAGNITUDE && w.tectonics.crack(x, y)) {
          w.events.push(...w.tectonics.news)
          w.tectonics.news = []
        }
        // great quakes one after another: the crust gives way and the world is remade
        if (m >= CATACLYSM_MAGNITUDE) {
          this.greatQuakes = [...this.greatQuakes.filter((t) => this.realTime - t < CATACLYSM_WINDOW), this.realTime]
          if (this.greatQuakes.length >= CATACLYSM_QUAKES) {
            this.greatQuakes = []
            this.cataclysm()
            break
          }
        }
        const mm = m.toFixed(1).replace('.', ',')
        this.toast(count ? `Terremoto de magnitude ${mm}, e ${count} réplicas a caminho` : `Terremoto de magnitude ${mm}`)
        break
      }
      case 'nuke': {
        // on a town: its people launch at their enemy; anywhere else: a bomb falls right there
        const text = s.life ? this.life.godNuke([x / w.n, y / w.n]) : null
        if (text) {
          this.toast(text)
          break
        }
        this.godBomb(x, y)
        this.toast('☢ Uma bomba atômica cai do céu')
        break
      }
      case 'sun': {
        this.effect('flare', x, y, remove ? -1 : 1, 1.2)
        this.play('whoosh')
        w.sun = Math.max(-10, Math.min(10, w.sun + (remove ? -1 : 1)))
        const shown = `${w.sun > 0 ? '+' : ''}${w.sun.toFixed(0)} °C`
        this.toast(remove ? `O sol enfraquece: o planeta esfria 1 °C (${shown})` : `O sol se fortalece: o planeta esquenta 1 °C (${shown})`)
        if (!again) this.chronicle(remove ? 'O sol enfraquece: o mundo esfria.' : 'O sol se fortalece: o mundo esquenta.', true)
        break
      }
      case 'people': {
        if (!s.life) return
        if (this.life.seedCiv(pos, 1)) {
          this.toast('Um povo novo desperta aqui')
          this.effect('sparkle', x, y, 3, 2)
          this.play('chime')
        }
        else if (!again) this.toast('Ninguém vive aqui: precisa de terra firme, sem gelo nem lava, longe de outra cidade')
        break
      }
      case 'drought': {
        const lifted = w.drought(x, y, this.brushRadius(), remove)
        if (remove) {
          if (lifted) {
            this.toast('A seca acabou: a chuva volta à região')
            this.chronicle('A seca acaba: as chuvas voltam.', false, pos)
          }
        } else {
          this.effect('heat', x, y, this.brushRadius(), 2)
          this.toast('Seca decretada: não chove aqui até você apagá-la (modo −)')
          if (!again) this.chronicle('O céu se fecha para a chuva sobre uma região: uma seca decretada.', true, pos)
        }
        break
      }
      case 'storm': {
        w.storm(x, y, this.brushRadius())
        this.effect('lightning', x, y, this.brushRadius(), 6)
        this.play('thunder')
        this.toast('Tempestade: uma baixa que o vento leva, chovendo por onde passa')
        if (!again) this.chronicle('Uma tempestade desaba sobre a terra.', false, pos)
        break
      }
      case 'fire': {
        w.ignite(x, y, Math.max(1, s.brushSize * 0.5))
        if (!again) this.toast('Fogo: espalha pelo mato seco com o vento; a chuva apaga')
        if (!again) this.chronicle('Um raio acende o mato.', false, pos)
        break
      }
      case 'volcano': {
        w.erupt(x, y, 0.6 + Math.random() * 0.4)
        this.effect('eruption', x, y, 5, 6)
        this.shake = Math.max(this.shake, 6)
        this.play('rumble')
        if (s.life && this.life.airRoutes().length) this.chronicle('As cinzas do vulcão fecham o céu: voos cancelados por onde a nuvem passa.', false, pos)
        this.toast('Um vulcão abre: a lava desce e vira rocha nova')
        this.chronicle('A terra se abre: um vulcão entra em erupção.', true, pos)
        break
      }
      case 'meteor': {
        const r = this.brushRadius()
        w.strike(x, y, r)
        // a giant impact breaks the plate it hits
        if (r >= CRACK_METEOR && w.tectonics.crack(x, y)) {
          w.events.push(...w.tectonics.news)
          w.tectonics.news = []
        }
        this.effect('impact', x, y, r, 2.5)
        this.shake = Math.max(this.shake, 16)
        this.play('boom')
        this.toast(`Impacto! Cratera, fogo e poeira que esfria o planeta ${w.dust.toFixed(1).replace('.', ',')} °C até baixar`)
        this.chronicle('Uma estrela cai do céu: fogo, cratera e dias de poeira.', true, pos)
        break
      }
      default:
        break
    }
    this.gatherNews()
    this.stats = this.makeStats(this.stats.fps)
    this.emit()
  }

  /**
   * The warheads the peoples launched: each flies its arc (longer flights take longer) and
   * lands with the blast, which then burns the land and spreads the fallout (see tick).
   */
  private launch() {
    const strikes = this.life.takeStrikes()
    if (!strikes.length) return
    const n = this.world.n
    this.play('siren')
    strikes.forEach((s, k) => {
      const x0 = s.from[0] * n
      const y0 = s.from[1] * n
      const x1 = s.to[0] * n
      const y1 = s.to[1] * n
      const flight = 1.6 + (Math.hypot(x1 - x0, y1 - y0) / n) * 2.5
      const start = this.realTime + k * 0.35
      const missile: Effect = { kind: 'missile', x: x0, y: y0, tx: x1, ty: y1, r: 1, t0: start, dur: flight }
      const blast: Effect = { kind: 'nuke', x: x1, y: y1, r: 5, t0: start + flight, dur: 5 }
      this.effects = [...this.effects, missile, blast].slice(-40)
      this.blasts.push({ x: x1, y: y1, at: start + flight })
    })
  }

  /** The world breaks and is remade (see TileWorld.cataclysm); almost all life is lost. */
  private cataclysm() {
    this.aftershocks = []
    this.world.cataclysm()
    if (this.settings.life) this.life.cataclysm()
    this.renderer.refresh()
    this.shake = 40
    this.effect('impact', this.world.n / 2, this.world.n / 2, this.world.n * 0.4, 4)
    this.play('boom')
    this.play('rumble')
    this.toast('CATACLISMO: o planeta se refaz')
  }

  /** An earthquake of magnitude m at a place (tiles), along the plate boundary nearby (or the rock at the place). */
  private shock(x: number, y: number, m: number) {
    const b = this.world.tectonics.boundaryAt(x, y)
    this.world.quake(x, y, b.nx, b.ny, b.kind, m)
    this.shake = Math.max(this.shake, Math.min(26, (m - 4) * 4))
  }

  /** A bomb from the gods at a place (tiles): it comes in from the nearest edge of the map. */
  private godBomb(x: number, y: number) {
    const n = this.world.n
    const edges: [number, number][] = [[x, -10], [x, n + 10], [-10, y], [n + 10, y]]
    const [x0, y0] = edges.sort((a, b) => Math.hypot(a[0] - x, a[1] - y) - Math.hypot(b[0] - x, b[1] - y))[0]
    const flight = 1.8
    const start = this.realTime
    this.play('siren')
    this.effects = [
      ...this.effects,
      { kind: 'missile' as const, x: x0, y: y0, tx: x, ty: y, r: 1, t0: start, dur: flight },
      { kind: 'nuke' as const, x, y, r: 5, t0: start + flight, dur: 5 },
    ].slice(-40)
    this.blasts.push({ x, y, at: start + flight, god: true })
  }

  /** An animation at a place (tiles), `r` tiles wide, `dur` real seconds long. */
  private effect(kind: Effect['kind'], x: number, y: number, r: number, dur: number) {
    this.effects = [...this.effects, { kind, x, y, r, t0: this.realTime, dur }].slice(-24)
  }

  // ---- going back: undo, rewind, saved worlds --------------------------------------------

  private snap(): Snap {
    return {
      year: Math.floor(this.world.time / 10),
      world: this.world.snapshot(),
      life: this.life.snapshot(),
      news: this.news,
      history: this.history,
      annals: this.annals,
      peaceYears: this.peaceYears,
    }
  }

  private restoreSnap(s: Snap) {
    if (s.world.opts.size !== this.world.n) {
      this.world = new TileWorld(s.world.opts)
      this.world.onDrift = this.carryLife
      this.renderer = new Renderer2D(this.world)
      this.fit()
    }
    this.world.restore(s.world)
    this.life.restore(s.life)
    this.news = s.news
    this.history = s.history
    this.annals = s.annals
    this.peaceYears = s.peaceYears
    this.lastRecord = s.year
    this.lifeSeen = this.life.now
    this.lastFollowed = this.news[0]?.id ?? -1
    this.settings = { ...this.settings, world: { ...s.world.opts } }
    this.renderer.refresh()
    this.stats = this.makeStats(this.stats.fps)
    this.emit()
  }

  /** Keeps the world as it is now, to undo the stroke about to be made. */
  private pushUndo() {
    if (this.settings.tool === 'inspect') return
    this.undoStack = [...this.undoStack, this.snap()].slice(-MAX_UNDO)
  }

  /** Back to before the last stroke. */
  undo() {
    const s = this.undoStack.pop()
    if (!s) {
      this.toast('Nada para desfazer')
      return
    }
    this.restoreSnap(s)
    this.toast('Desfeito')
  }

  /** Keeps a moment every REWIND_YEARS for going back in time. */
  private keepMoment() {
    const year = Math.floor(this.world.time / 10)
    const last = this.ring[this.ring.length - 1]
    if (last && year - last.year < REWIND_YEARS) return
    this.ring = [...this.ring, this.snap()].slice(-MAX_REWIND)
  }

  /** Back to the last moment kept (a step of REWIND_YEARS each time). */
  rewind() {
    const year = Math.floor(this.world.time / 10)
    // the newest moment at least a couple of years old (the one just kept is "now")
    let k = this.ring.length - 1
    while (k >= 0 && year - this.ring[k].year < 2) k--
    if (k < 0) {
      this.toast('Não há como voltar mais')
      return
    }
    const s = this.ring[k]
    this.ring = this.ring.slice(0, k + 1)
    this.restoreSnap(s)
    this.toast(`De volta ao ano ${s.year}`)
    this.play('whoosh')
  }

  /** The world as a file to keep (downloaded by the browser). */
  async save() {
    try {
      const blob = await toFile({ format: 'craftscape-2d', version: 1, snap: this.snap() })
      this.host.download(blob, `craftscape-2d-ano-${Math.floor(this.world.time / 10)}.json${blob.type === 'application/json' ? '' : '.gz'}`)
      this.toast('Mundo salvo no seu computador')
    } catch (err) {
      this.toast(`Não foi possível salvar: ${(err as Error).message}`)
    }
  }

  /** A world saved before, back from its file. */
  async load(file: Blob) {
    try {
      const data = (await fromFile(file)) as { format?: string; snap?: Snap }
      if (data.format !== 'craftscape-2d' || !data.snap) throw new Error('não é um mundo do Craftscape 2D')
      this.undoStack = []
      this.ring = []
      this.effects = []
      this.restoreSnap(data.snap)
      this.toast(`Mundo carregado: ano ${data.snap.year}`)
    } catch (err) {
      this.toast(`Não foi possível carregar: ${(err as Error).message}`)
    }
  }

  // ---- goals --------------------------------------------------------------------------

  /** The world's measures the goals read (see goals.ts). */
  metrics(): Metrics {
    const w = this.world
    const n = w.n
    // the land masses
    const comp = new Int32Array(n * n).fill(-1)
    let continents = 0
    let biggest = 0
    let land = 0
    const stack: number[] = []
    for (let s = 0; s < n * n; s++) {
      if (comp[s] >= 0 || w.ground[s * 4] < w.sea) continue
      let size = 0
      comp[s] = s
      stack.push(s)
      while (stack.length) {
        const i = stack.pop()!
        size++
        const x = i % n
        for (const j of [x > 0 ? i - 1 : -1, x < n - 1 ? i + 1 : -1, i - n, i + n]) {
          if (j >= 0 && j < n * n && comp[j] < 0 && w.ground[j * 4] >= w.sea) {
            comp[j] = s
            stack.push(j)
          }
        }
      }
      land += size
      if (size >= 300) continents++
      biggest = Math.max(biggest, size)
    }
    const life = this.settings.life ? this.life.stats() : null
    return {
      year: Math.floor(w.time / 10),
      continents,
      biggestShare: land ? biggest / land : 0,
      forest: w.summary.forest,
      desert: w.summary.desert,
      snow: w.summary.snow,
      meanTemp: w.summary.meanTemp,
      civs: life?.civs.length ?? 0,
      people: life?.people ?? 0,
      maxTech: life ? Math.max(0, ...life.civs.map((c) => c.tech)) : 0,
      wars: life?.wars.length ?? 0,
      peaceYears: this.peaceYears,
      voyages: this.life.voyagesTotal,
      nuclearWars: this.life.nuclearCount,
      modernCivs: life ? life.civs.filter((c) => c.tech >= 0.92).length : 0,
      civWarming: w.civWarming,
      seaRise: w.sea * METERS_PER_HEIGHT,
      towns: life?.villages ?? 0,
    }
  }

  private startChallenge(id: string) {
    if (!challengeById(id)) return
    this.challenge = { id, start: this.metrics(), progress: 0, done: false }
  }

  private checkChallenge() {
    const st = this.challenge!
    const c = challengeById(st.id)
    if (!c) return
    const now = this.metrics()
    st.progress = c.progress(now, st.start)
    if (st.progress >= 1) {
      st.done = true
      if (!this.completed.includes(c.id)) {
        this.completed = [...this.completed, c.id]
        this.host.keepCompleted(this.completed)
      }
      this.effect('fireworks', 0, 0, 1, 4)
      this.play('fanfare')
      this.chronicle(`Desafio cumprido: ${c.name}! ${c.goal}.`, true)
      this.toast(`Desafio cumprido: ${c.name}!`)
    }
    this.challenge = { ...st }
    this.stats = { ...this.stats, challenge: this.challenge }
    this.emit()
  }

  /** A line about the powers: into the peoples' chronicle, or straight to the news without them. */
  private chronicle(text: string, major = false, pos?: [number, number]) {
    if (this.settings.life) this.life.chronicle(text, major, pos)
    else this.world.events.push({ text, major, x: pos ? pos[0] * this.world.n : undefined, y: pos ? pos[1] * this.world.n : undefined })
  }
}

export type { LifeEvent }
export { capacity }
