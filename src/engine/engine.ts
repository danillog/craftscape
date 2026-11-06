import { Camera } from './camera'
import { Input } from './input'
import {
  decodeTerrain,
  downloadBlob,
  encodeHeightmapPNG,
  encodeMeshOBJ,
  encodeTerrain,
  heightmapToState,
  resampleState,
  type SavedRegion,
} from './io'
import { clamp } from './math'
import { Renderer } from './renderer'
import {
  BASE_TEMPERATURE,
  brushMax,
  BRUSH_MIN,
  DAYS_PER_YEAR,
  seasonOf,
  type ClimateReport,
  LAPSE_RATE,
  METERS_PER_HEIGHT,
  QUALITY,
  type QualityLevel,
  TEMPERATURE_MAX,
  climateOf,
  defaultSettings,
  emptyStats,
  PEOPLE_MAPS,
  PEOPLE_POWERS,
  quakeMagnitude,
  type AreaSetting,
  type Overlay,
  type PeoplePower,
  type Probe,
  type Settings,
  type Stats,
  type Timeline,
  type Tool,
  type YearRecord,
} from './settings'
import { scenarioById, type ScenarioId } from './scenarios'
import { challengeById, loadTrophies, saveTrophies, type ChallengeId, type ChallengeState, type WorldMetrics } from './challenges'
import { CIV_COLORS, Life, TERRITORY_N, YEAR, placeName, type LifeEvent, type LifeLabel } from './life'
import { FAR_GRID, FAR_TEXELS_PER_WINDOW, MAX_DUSTS, MAX_HIGHS, MAX_PLATE_MOVES, MAX_STORMS } from './shaders/sim'
import {
  boundaryAt,
  plateDrift,
  platePair,
  platesIn,
  plateVelocity,
  sameCell,
  type Boundary,
  type BoundaryKind,
  type PlateField,
} from './plates'
import type { PlateArrow } from './renderer'
import {
  STATE_KEYS,
  Simulation,
  type Brush,
  type Climate,
  type Impact,
  type PlateMove,
  type PlateOverride,
  type Quake,
  type SimState,
  type Vent,
} from './simulation'
import { dayHours, declinationAt, latitudeOfWorld, skyAt } from './sky'
import { Powers, type PowerCell } from './powers'
import { CALM, CATEGORICAL, ERA_RAMP, FAMINE_COLOR, HUMAN_MARKS, PEACE_COLOR, PLAGUE_COLOR, WAR_COLOR, mixRgb, type Rgb } from './palettes'
import { Sound, type SoundKind } from '../tiles/sound'
import { TILES, WorldStore } from './world'

const STEP = 1 / 60 // the original simulated one step per frame at 60 fps
/** Frames per second while the window is not focused: the world keeps going, the GPU rests. */
const BACKGROUND_FPS = 10
/** Frame time the adaptive quality was tuned for (ms); a lower frame limit is not slowness. */
const BASE_FRAME_MS = 1000 / 60
/** Steps between earthquakes on average (half a minute at 1×), faster in geological time. */
const QUAKE_STEPS = 1800
/** Steps between eruptions on average (five minutes at 1×), faster in geological time. */
const VOLCANO_STEPS = 18000
const MAX_VOLCANOES = 6
/** How high the tide rises over the mean sea level (height units: about a cell of beach). */
const TIDE_AMPLITUDE = 0.0012
/** Sea-level rise per °C of the peoples' warming (height units). */
const SEA_RISE_PER_DEGREE = 0.004

/** A volcano on a plate boundary: it erupts for a while (its vent open), then lies dormant and may wake again. */
interface Volcano {
  name: string
  uv: [number, number]
  /** Vent radius in window uv. */
  radius: number
  /** Vent strength while erupting (0–1). */
  strength: number
  /** Simulated seconds of eruption left. */
  left: number
  erupting: boolean
  eruptions: number
}
/** Plate drift per step at unit speed and drift setting 1 (world units): 0.1 of the world in ~20 s at 30×. */
const PLATE_DRIFT = 3e-6
const BOUNDARY_NAMES: Record<BoundaryKind, string> = {
  convergent: 'placas colidindo',
  divergent: 'placas se afastando',
  transform: 'placas deslizando lado a lado',
}
const UNDO_BUDGET_BYTES = 256 * 1024 * 1024
/** GPU memory for the rewind snapshots, and the simulated seconds they try to cover. */
const REWIND_BUDGET_BYTES = 128 * 1024 * 1024
const REWIND_SPAN = 120
const MAX_REWIND = 24
/** Years of record kept for the charts, and great moments kept for the history book. */
const RECORD_YEARS = 600
const MAX_ANNALS = 300
/** A storm lives this many simulated seconds: it deepens, holds, then fills in. */
const STORM_LIFE = 100
/** How deep a storm's low is held at this age (0–1). */
const stormStrength = (age: number) => (age < 5 ? age / 5 : age < 70 ? 1 : Math.max((STORM_LIFE - age) / 30, 0))
const MAX_UNDO = 30

/** software: only the browser's CPU emulation of WebGPU, which is too slow to run the game. */
export type WebGPUFailure = 'no-api' | 'no-adapter' | 'timeout' | 'software'

export class WebGPUUnavailableError extends Error {
  readonly reason: WebGPUFailure
  constructor(reason: WebGPUFailure) {
    super(
      reason === 'no-api'
        ? 'Este navegador não expõe WebGPU.'
        : reason === 'no-adapter'
          ? 'Nenhum adaptador WebGPU disponível.'
          : reason === 'software'
            ? 'Só há WebGPU por software (sem GPU de verdade).'
            : 'O navegador não respondeu ao pedido de GPU.',
    )
    this.reason = reason
  }
}

/** Some broken GPU setups never settle requestAdapter/requestDevice; don't wait forever. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new WebGPUUnavailableError('timeout')), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      },
    )
  })
}

/** Phones and tablets: weak GPUs behind high-density screens. */
function isMobileDevice() {
  const uaData = (navigator as Navigator & { userAgentData?: { mobile?: boolean } }).userAgentData
  if (uaData?.mobile) return true
  if (/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)) return true
  // iPadOS reports itself as a Mac
  return navigator.maxTouchPoints > 1 && matchMedia('(pointer: coarse)').matches
}

const QUALITY_ORDER: QualityLevel[] = ['high', 'medium', 'low']

/** For file names: 2026-10-22-14-05-09. */
const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')

type Listener = () => void

export class Engine {
  private settings: Settings = { ...defaultSettings }
  private stats: Stats = { ...emptyStats }
  private message: string | null = null
  private readonly listeners = new Set<Listener>()

  private readonly device: GPUDevice
  private readonly context: GPUCanvasContext
  private readonly canvas: HTMLCanvasElement
  private readonly renderer: Renderer
  private readonly camera = new Camera()
  private readonly input: Input
  private sim: Simulation
  /** Quality level in effect: the chosen one, or where automatic settled. */
  private level: QualityLevel
  /** Where automatic quality starts (and returns to when chosen again). */
  private readonly deviceLevel: QualityLevel
  /** The GPU is emulated on the CPU (no usable hardware): use the CPU-friendly water flow. */
  private readonly softwareGPU: boolean

  private raf = 0
  private lastTime = 0
  private accumulator = 0
  private frame = 0
  private time = 0
  /** Simulated seconds: wind variation, eruptions, drifting weather and clouds. */
  private simTime = 0
  /** How far the cloud pattern has drifted with the prevailing wind. */
  private cloudDrift: [number, number] = [0, 0]
  private hit: [number, number, number] | null = null
  /** The inspect tool's reading of the cell under the cursor, refreshed a few times a second. */
  private probe: Probe | null = null
  private probing = false
  private lastProbe = 0
  private wasPainting = false
  /** Frames left for a quick click to find the terrain under it (see tick). */
  private pressFrames = 0
  /** Height the leveling tool flattens towards, taken where the stroke started. */
  private levelHeight = 0
  private needsGenerate = true
  private lastGenerate = -Infinity
  private busy = false
  private disposed = false
  private readonly undoStack: GPUBuffer[] = []
  /** Volcanic vents to open on the highest peaks once the next terrain is generated (scenarios). */
  private pendingVents = 0
  /** A picture requested at this multiple of the screen resolution, taken right after the next frame. */
  private shot: { scale: number; done: (blob: Blob | null) => void } | null = null

  // infinite world: the window's place in it (cells) and the regions it has left behind
  private origin: [number, number] = [0, 0]
  private world: WorldStore
  private needsFar = true
  private lastAnalysis = 0
  private analysing = false
  /** Mean weather pressure over the window, from the last climate analysis. */
  private pressureMean = 0

  // plate tectonics
  /** Plates whose drift was changed with the plates tool (cleared with a new terrain). */
  private plateOverrides: PlateOverride[] = []
  /** Plate time: how far a plate of unit speed has drifted since the terrain was made (world units). */
  private plateTime = 0
  /**
   * Continental drift: how many whole cells each plate (by its grid cell) has carried its
   * land so far, and the resolution and area that count is for.
   */
  private readonly carried = new Map<string, [number, number]>()
  private carriedFor = ''
  /** The plate being dragged: its cell, where the drag started (world units), whether it turned. */
  private plateDrag: {
    cell: [number, number]
    from: [number, number]
    turned: boolean
  } | null = null
  /** The earthquake to run in the next frame, and the steps left until another may strike. */
  private pendingQuake: Quake | null = null
  /** The next frame clears every fixed air-mass source (see clearAirSources). */
  private pendingClear = false
  /** Storms the storm tool set off: centre (window uv), age in simulated seconds, radius (uv). */
  private storms: { uv: [number, number]; age: number; radius: number }[] = []
  /** Dust clouds from strikes: centre (window uv), °C of shade at the centre, radius (uv). */
  private dusts: { uv: [number, number]; cooling: number; radius: number }[] = []
  /** The meteor strike to run in the next frame. */
  private pendingImpact: Impact | null = null
  private readonly labelCanvas: HTMLCanvasElement
  /** The town picked with the inspect tool (its id in the life), shown in the Life tab. */
  private selectedTown: number | null = null
  /** Life time of the last chronicle event the camera flew to (see followEvents). */
  private lastFollowed = -1
  /** Warming from the peoples' industry, in °C; it builds while chimneys smoke and fades slowly after. */
  private civWarming = 0
  /** °C the player added to (or took from) the whole planet with the sun power. */
  private godWarming = 0
  /** Fixed highs the drought power set: centre (window uv) and radius (uv). */
  private highs: { uv: [number, number]; radius: number }[] = []
  /** Dust from meteor strikes, in °C of cooling; it settles over a couple of simulated days. */
  private dust = 0
  /** The challenge being played (see challenges.ts). */
  private challenge: ChallengeState | null = null
  private trophies = loadTrophies()
  /** The world year by year (the charts), each people's eras and the great moments (the history book). */
  private record: YearRecord[] = []
  private eraLog: Record<number, [number, number][]> = {}
  private annals: LifeEvent[] = []
  private lastAnnal = -Infinity
  /** The life's year when the peace in course began (peoples alive and no war), or null. */
  private peaceSince: number | null = null
  /** The state as last read back for the analysis: climate, water, extra and lava per cell. */
  private field: Field | null = null
  private readonly life = new Life()
  /** Wildfire, hurricanes, the earthquake power, nuclear blasts and the cataclysm (see powers.ts). */
  private readonly powers = new Powers({
    cell: (pos) => this.powerCell(pos),
    wind: () => ({ angle: this.windAngle, speed: ((this.settings.autoClimate ? 0.8 : this.settings.windSpeed) / 512) * 60 }),
    fault: (pos) => {
      const b = boundaryAt(pos, this.plates())
      return b.pair.dist < 0.15 ? { normal: Math.atan2(b.normal[1], b.normal[0]), kind: b.kind } : null
    },
    toast: (text) => this.toast(text),
    chronicle: (text, major, pos) => this.life.chronicle(text, major, pos),
    dust: (pos, cooling, radius, planet) => {
      if (cooling > 0) this.dusts = [...this.dusts, { uv: this.uvAt(pos), cooling, radius: radius / this.extent }].slice(-MAX_DUSTS)
      this.dust = Math.min(this.dust + planet, 8)
    },
    sound: (kind) => this.playSound(kind),
    life: () => (this.settings.life ? this.life : null),
  })
  private readonly audio = new Sound()
  /** The territories as a map of the peoples paints them (see territoryFor), and when it was last painted. */
  private readonly paintedMap = new Uint32Array(TERRITORY_N * TERRITORY_N)
  private paintedAt = -Infinity
  private paintedFor: Overlay = 'none'
  /** Snapshots taken every few simulated seconds, oldest first, for rewinding (see rewind). */
  private rewindRing: { snap: GPUBuffer; simTime: number; timeOfDay: number }[] = []
  private lastRewindSnap = -Infinity
  /** While the rewind button is held: the simulation stands still, each call steps one snapshot back. */
  private rewinding = false
  private lastRewind = 0
  private quakeClock = QUAKE_STEPS
  private toastTimer = 0
  /** The volcanoes of this terrain, the steps until another may wake, and the vent to open or plug next frame. */
  private volcanoes: Volcano[] = []
  private volcanoClock = VOLCANO_STEPS * 0.5
  private pendingVent: Vent | null = null

  // stats accumulation
  private statFrames = 0
  private statSteps = 0
  private statStart = 0
  /** Frame limiter: when the next frame is due and when the screen last refreshed (ms). */
  private nextFrame = 0
  private lastRaf = 0
  /** The window has the focus; without it the loop idles at BACKGROUND_FPS. */
  private focused = true
  private onFocus: (() => void) | null = null
  private onBlur: (() => void) | null = null
  private slowWindows = 0
  /** Engine time of the last quality change; automatic quality waits for frames to settle. */
  private qualitySince = 0
  /** Dynamic resolution: the render scale in effect, between the profile's minimum and its scale. */
  private renderScale = 1

  /**
   * Starts the engine on the GPU. Without a real GPU it fails with WebGPUUnavailableError
   * (the page then opens the 2D game) unless `allowSoftware`, which runs on the browser's
   * software adapter: it works, but slowly enough to freeze a weak computer.
   */
  static async create(canvas: HTMLCanvasElement, signal: AbortSignal, allowSoftware = false): Promise<Engine> {
    if (!navigator.gpu) throw new WebGPUUnavailableError('no-api')
    let adapter: GPUAdapter | null = null
    let hardwareFailure: WebGPUFailure = 'no-adapter'
    try {
      adapter = await withTimeout(navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }), 6000)
    } catch (err) {
      if (!(err instanceof WebGPUUnavailableError)) throw err
      hardwareFailure = err.reason
    }
    if (adapter?.info.isFallbackAdapter && !allowSoftware) throw new WebGPUUnavailableError('software')
    if (!adapter && allowSoftware) {
      adapter = await withTimeout(navigator.gpu.requestAdapter({ forceFallbackAdapter: true }), 6000).catch(() => null)
    }
    if (!adapter) throw new WebGPUUnavailableError(hardwareFailure)
    // 2048² needs bigger buffers than the defaults (undo snapshots and read-backs hold all
    // the state in one buffer, ~470 MB); ask for what the adapter allows, up to 1 GiB
    const device = await withTimeout(
      adapter.requestDevice({
        requiredLimits: {
          maxBufferSize: Math.min(adapter.limits.maxBufferSize, 2 ** 30),
          maxStorageBufferBindingSize: Math.min(adapter.limits.maxStorageBufferBindingSize, 2 ** 28),
        },
      }),
      10000,
    )
    if (signal.aborted) {
      device.destroy()
      throw new DOMException('aborted', 'AbortError')
    }
    const info = adapter.info
    const adapterName = [info.vendor, info.architecture, info.description].filter(Boolean).join(' ') || 'WebGPU'
    // software rendering and phones start at low quality; automatic quality lowers it further if needed
    const level = info.isFallbackAdapter || isMobileDevice() ? 'low' : 'high'
    const engine = new Engine(canvas, device, adapterName, level, info.isFallbackAdapter)
    try {
      await engine.init()
    } catch (err) {
      engine.dispose()
      throw err
    }
    if (signal.aborted) {
      engine.dispose()
      throw new DOMException('aborted', 'AbortError')
    }
    engine.start()
    if (info.isFallbackAdapter) {
      engine.notice('Sem GPU utilizável: rodando WebGPU por software, que é bem mais lento. Veja chrome://gpu.')
    }
    return engine
  }

  private constructor(
    canvas: HTMLCanvasElement,
    device: GPUDevice,
    adapterName: string,
    level: QualityLevel,
    softwareGPU: boolean,
  ) {
    this.canvas = canvas
    this.device = device
    // names over the map are drawn on a 2D canvas laid over the WebGPU one
    this.labelCanvas = document.createElement('canvas')
    this.labelCanvas.className = 'labels'
    canvas.parentElement?.insertBefore(this.labelCanvas, canvas.nextSibling)
    const context = canvas.getContext('webgpu')
    if (!context) throw new Error('Não foi possível criar o contexto WebGPU do canvas.')
    this.context = context
    const format = navigator.gpu.getPreferredCanvasFormat()
    context.configure({ device, format, alphaMode: 'opaque' })

    device.addEventListener('uncapturederror', (e) => {
      console.error('WebGPU error:', (e as GPUUncapturedErrorEvent).error.message)
    })
    device.lost.then((info) => {
      if (!this.disposed) this.notice(`A GPU foi perdida (${info.reason}): ${info.message}. Recarregue a página.`)
    })

    this.level = this.deviceLevel = level
    this.softwareGPU = softwareGPU
    this.stats = { ...this.stats, adapter: adapterName, resolution: this.resolution }
    this.renderer = new Renderer(device, context, format)
    this.sim = new Simulation(device, this.resolution)
    this.sim.splitFlow = softwareGPU
    this.world = new WorldStore(this.resolution / TILES)
    this.renderer.setSimulation(this.sim)
    this.applyQuality(level)
    this.input = new Input(canvas, {
      beginRotate: () => this.camera.beginRotate(this.hitWorld()),
      endRotate: () => this.camera.endRotate(),
      rotate: (dx, dy) => this.camera.rotate(dx, dy),
      pan: (dx, dy) => this.camera.pan(dx, dy, canvas.clientHeight || 1),
      zoom: (f) => this.camera.zoom(f, this.hitWorld()),
      resizeBrush: (steps) =>
        this.set({ brushSize: clamp(this.settings.brushSize * 1.15 ** steps, BRUSH_MIN, brushMax(this.settings.area)) }),
      undo: () => this.undo(),
      togglePause: () => this.set({ paused: !this.settings.paused }),
      toggleCamera: () => this.set({ cameraMode: this.settings.cameraMode === 'orbit' ? 'fly' : 'orbit' }),
      resetCamera: () => this.camera.reset(),
      focus: () => {
        const point = this.hitWorld()
        if (point) this.camera.focus(point)
      },
      selectTool: (tool: Tool) => this.set({ tool }),
      rewind: () => this.rewind(),
      rewindEnd: () => this.rewindEnd(),
      toggleMode: () => this.set({ mode: this.settings.mode === 'add' ? 'remove' : 'add' }),
      toggleHelp: () => this.set({ showHelp: !this.settings.showHelp }),
      closeHelp: () => {
        if (this.settings.showHelp) this.set({ showHelp: false })
        else if (this.settings.photoMode) this.set({ photoMode: false })
        // otherwise Escape puts the tool down: back to inspecting
        else if (this.settings.tool !== 'inspect') this.set({ tool: 'inspect' })
      },
      togglePhoto: () => this.set({ photoMode: !this.settings.photoMode }),
      // the plates tool always grabs with a click: dragging is how it is used
      paintOnClick: () => this.settings.paintOnClick || this.settings.tool === 'plates',
    })
  }

  /** The terrain point under the cursor, in world space (the pick gives u, v, height). */
  private hitWorld(): [number, number, number] | null {
    if (!this.hit) return null
    const [ou, ov] = this.originUnits
    const e = this.extent
    return [(this.hit[0] - 0.5 + ou) * e, this.hit[2], (0.5 - this.hit[1] - ov) * e]
  }

  /** Simulated area: the window's width in world units. */
  private get extent(): number {
    return this.settings.area
  }

  /** Window origin in window widths (world units). */
  private get originUnits(): [number, number] {
    return [this.origin[0] / this.sim.size, this.origin[1] / this.sim.size]
  }

  /**
   * Whether this GPU can run 2048²: real hardware whose buffers hold the whole state at
   * once (undo snapshots, read-backs).
   */
  get supportsHugeWorld() {
    return !this.softwareGPU && this.device.limits.maxBufferSize >= 2048 * 2048 * 16 * STATE_KEYS.length
  }

  private get resolution(): number {
    const most = this.supportsHugeWorld ? 2048 : 1024
    if (this.settings.resolution !== 'auto') return Math.min(this.settings.resolution, most)
    // a bigger area gets more cells, keeping the detail per world unit (2048² only at high quality)
    const cap = this.level === 'high' ? most : 1024
    return Math.min(cap, Math.round((QUALITY[this.level].autoResolution * this.settings.area) / 64) * 64)
  }

  private get profile() {
    return QUALITY[this.level]
  }

  /**
   * Switches the quality level: render resolution, terrain detail, shadow refresh and,
   * with automatic resolution, the simulation size. Low quality also turns the clouds off
   * (they can be turned back on).
   */
  private applyQuality(level: QualityLevel) {
    const entering = level !== this.level || this.frame === 0
    this.level = level
    const p = QUALITY[level]
    this.renderer.pixelsPerVertex = p.pixelsPerVertex
    this.renderer.coarseHorizon = p.coarseHorizon
    this.sim.derivedSlices = p.derivedSlices
    this.sim.climateEvery = p.climateEvery
    this.renderScale = p.renderScale
    if (level === 'low' && entering) this.settings = { ...this.settings, clouds: false }
    this.stats = { ...this.stats, quality: level }
    this.slowWindows = 0
    this.qualitySince = this.time
    if (this.sim.size !== this.resolution) void this.changeResolution(this.resolution)
  }

  private async init() {
    this.device.pushErrorScope('validation')
    await this.renderer.loadTextures()
    const error = await this.device.popErrorScope()
    if (error) throw new Error(`Falha ao inicializar a GPU: ${error.message}`)
  }

  private start() {
    this.stats = { ...this.stats, trophies: this.trophies }
    this.lastTime = performance.now()
    this.statStart = this.lastTime
    this.nextFrame = this.lastTime
    this.lastRaf = this.lastTime
    // focused until told otherwise: hasFocus() is false in headless and test windows
    this.focused = true
    const loop = (now: number) => {
      if (this.disposed) return
      this.raf = requestAnimationFrame(loop)
      const period = now - this.lastRaf
      this.lastRaf = now
      const interval = this.frameInterval()
      if (interval > 0) {
        // the screen refresh nearest the deadline wins (half a refresh of tolerance), so a
        // 60 fps limit on a 60 Hz screen draws every frame and on 144 Hz averages 60
        if (now + Math.min(period, interval) * 0.5 < this.nextFrame) return
        // the schedule only restarts when the loop fell a whole frame behind (hidden tab, slow GPU)
        this.nextFrame = (now - this.nextFrame > interval ? now : this.nextFrame) + interval
      }
      this.tick(now)
    }
    this.raf = requestAnimationFrame(loop)
    this.onFocus = () => (this.focused = true)
    this.onBlur = () => (this.focused = false)
    window.addEventListener('focus', this.onFocus)
    window.addEventListener('blur', this.onBlur)
  }

  /** Milliseconds between frames: the chosen limit, or a slow idle rate while the window is not focused. */
  private frameInterval() {
    const limit = this.settings.fpsLimit
    const target = this.focused ? limit : limit > 0 ? Math.min(limit, BACKGROUND_FPS) : BACKGROUND_FPS
    return target > 0 ? 1000 / target : 0
  }

  // ---- public API for the UI ---------------------------------------------------

  subscribe = (fn: Listener) => {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  getSettings = () => this.settings
  getStats = () => this.stats
  getMessage = () => this.message
  getProbe = () => this.probe

  private emit() {
    for (const fn of this.listeners) fn()
  }

  private notice(message: string | null) {
    this.message = message
    this.emit()
  }

  dismissMessage() {
    this.notice(null)
  }

  set(partial: Partial<Settings>) {
    const previous = this.settings
    const auto = partial.autoClimate ?? previous.autoClimate
    // in automatic climate the simulation decides temperature and humidity
    if (auto && (partial.tool === 'heat' || partial.tool === 'humidity')) delete partial.tool
    if (auto && partial.warming) delete partial.warming
    this.settings = { ...previous, ...partial }
    if (auto && (this.settings.tool === 'heat' || this.settings.tool === 'humidity')) this.settings.tool = 'rock'
    if (auto) this.settings.warming = false
    if (partial.cameraMode && partial.cameraMode !== previous.cameraMode) this.camera.setMode(partial.cameraMode)
    if (partial.seed !== undefined && partial.seed !== previous.seed) this.needsGenerate = true
    if (partial.terrainShape && partial.terrainShape !== previous.terrainShape) this.needsGenerate = true
    // the cinematic camera circles a target, which only the orbit camera has
    if (partial.cinematic && this.settings.cameraMode !== 'orbit') {
      this.settings.cameraMode = 'orbit'
      this.camera.setMode('orbit')
    }
    if (partial.infiniteWorld === false && previous.infiniteWorld) this.camera.reset()
    if (partial.quality !== undefined && partial.quality !== previous.quality) {
      this.applyQuality(partial.quality === 'auto' ? this.deviceLevel : partial.quality)
    }
    if (partial.resolution !== undefined && partial.resolution !== previous.resolution) {
      void this.changeResolution(this.resolution)
    }
    if (partial.area !== undefined && partial.area !== previous.area) this.changeArea()
    this.emit()
  }

  resetCamera() {
    this.camera.reset()
  }

  /** Flies the camera over a place in the world (world units, as the life keeps them). */
  flyTo(pos: [number, number], distance = 0.16) {
    if (this.settings.cameraMode !== 'orbit') this.set({ cameraMode: 'orbit' })
    const e = this.extent
    const h = this.life.surfaceAt(pos, e)
    this.camera.flyTo([pos[0] - e * 0.5, h, e * 0.5 - pos[1]], distance)
  }

  /** The watching god: the camera flies to the newest event that happened somewhere. */
  private followEvents() {
    const events = this.life.chronicleEvents
    const last = events[events.length - 1]
    if (!last || last.time <= this.lastFollowed) return
    this.lastFollowed = last.time
    if (last.pos) this.flyTo(last.pos)
  }

  /** The Change map starts counting again from the terrain as it is now. */
  resetChange() {
    const enc = this.device.createCommandEncoder({ label: 'reset change' })
    this.sim.encodeResetBaseline(enc)
    this.device.queue.submit([enc.finish()])
  }

  /**
   * Starts a new world from a scenario: its terrain shape and climate on top of the
   * defaults (keeping the brush, view and quality choices), a fresh seed, the camera
   * back home and, for volcanic scenarios, vents already erupting.
   */
  startScenario(id: ScenarioId, seed = 1 + Math.floor(Math.random() * 1000)) {
    const scenario = scenarioById(id)
    const s = this.settings
    const keep: Partial<Settings> = {
      tool: s.tool,
      mode: s.mode,
      brushSize: s.brushSize,
      brushStrength: s.brushStrength,
      paintOnClick: s.paintOnClick,
      resolution: s.resolution,
      quality: s.quality,
      windArrows: s.windArrows,
      clouds: s.clouds,
      cameraMode: s.cameraMode,
      // the area the player chose stays; one a scenario set (Pangaea) goes back to the default
      area: scenarioById(s.scenario).settings.area ? defaultSettings.area : s.area,
      sound: s.sound,
    }
    this.settings = { ...defaultSettings, ...keep, timeOfDay: s.timeOfDay }
    this.set({ ...scenario.settings, scenario: id, terrainShape: scenario.shape, seed })
    this.needsGenerate = true
    this.pendingVents = scenario.vents ?? 0
    this.moveOrigin([0, 0])
    this.camera.reset()
  }

  /** Saves a PNG of the view, rendered at `scale` times the screen resolution, without the brush. */
  async screenshot(scale = 1) {
    if (this.shot) return
    const blob = await new Promise<Blob | null>((done) => (this.shot = { scale, done }))
    if (!blob) {
      this.notice('Não foi possível capturar a imagem.')
      return
    }
    downloadBlob(blob, `craftscape-${stamp()}.png`)
  }

  regenerate() {
    this.needsGenerate = true
  }

  undo() {
    const snap = this.undoStack.pop()
    if (!snap) return
    const enc = this.device.createCommandEncoder()
    this.sim.encodeRestore(enc, snap)
    this.device.queue.submit([enc.finish()])
    void this.device.queue.onSubmittedWorkDone().then(() => snap.destroy())
    this.updateUndoStat()
  }

  async save() {
    if (this.busy) return
    this.busy = true
    try {
      const state = await this.sim.readState()
      const regions = this.world.entries().map(([tx, ty, region]): SavedRegion => [tx, ty, region.data])
      const blob = await encodeTerrain({
        state,
        seed: this.settings.seed,
        origin: this.origin,
        regions,
        area: this.extent,
        shape: this.settings.terrainShape,
        plateTime: this.plateTime,
      })
      downloadBlob(blob, `terreno-${stamp()}.craftscape`)
    } catch (err) {
      this.notice(`Não foi possível salvar: ${(err as Error).message}`)
    } finally {
      this.busy = false
    }
  }

  async load(file: File) {
    if (this.busy) return
    this.busy = true
    try {
      const { state, seed, origin, regions, area, shape, plateTime } = await decodeTerrain(file)
      if (area !== this.extent) this.clearUndo()
      this.plateTime = plateTime
      this.plateOverrides = []
      this.sim.platesDirty = true
      // the area and shape the file was made with, without regenerating
      this.settings = {
        ...this.settings,
        area: [1, 1.5, 2, 3, 4].includes(area) ? (area as AreaSetting) : 1,
        terrainShape: shape,
      }
      await this.replaceState(state)
      this.world = new WorldStore(state.size / TILES)
      for (const [tx, ty, data] of regions) this.world.set(tx, ty, data)
      this.moveOrigin(origin)
      this.settings = { ...this.settings, seed: Math.round(seed) || this.settings.seed }
      if (state.size !== this.resolution)
        this.settings = { ...this.settings, resolution: state.size as 256 | 512 | 1024 | 2048 }
      this.emit()
    } catch (err) {
      this.notice(`Não foi possível carregar: ${(err as Error).message}`)
    } finally {
      this.busy = false
    }
  }

  async importHeightmap(file: File) {
    if (this.busy) return
    this.busy = true
    try {
      await this.replaceState(await heightmapToState(file, this.sim.size))
      this.world.clear()
      this.needsFar = true
    } catch (err) {
      this.notice(`Não foi possível importar a imagem: ${(err as Error).message}`)
    } finally {
      this.busy = false
    }
  }

  /** Downloads the surface heights as a 16-bit PNG heightmap. */
  async exportHeightmap() {
    try {
      const state = await this.sim.readState()
      const heights = new Float32Array(state.size * state.size)
      for (let i = 0; i < heights.length; i++) heights[i] = state.ground[i * 4]
      const { blob, min, max } = await encodeHeightmapPNG(heights, state.size)
      downloadBlob(blob, `craftscape-heightmap-${stamp()}.png`)
      const m = (h: number) => Math.round(h * METERS_PER_HEIGHT)
      this.notice(`Heightmap ${state.size}² salvo: preto = ${m(min)} m, branco = ${m(max)} m.`)
    } catch (err) {
      this.notice(`Não foi possível exportar: ${(err as Error).message}`)
    }
  }

  /** Downloads the surface as an OBJ mesh. */
  async exportMesh() {
    try {
      const state = await this.sim.readState()
      const heights = new Float32Array(state.size * state.size)
      for (let i = 0; i < heights.length; i++) heights[i] = state.ground[i * 4]
      downloadBlob(encodeMeshOBJ(heights, state.size, this.extent), `craftscape-terreno-${stamp()}.obj`)
    } catch (err) {
      this.notice(`Não foi possível exportar: ${(err as Error).message}`)
    }
  }

  /**
   * One row of the window, west to east, for the cross-section: the row under the
   * cursor while inspecting, else the middle one.
   */
  async readSection() {
    const sim = this.sim
    const n = sim.size
    const row = clamp(Math.floor((this.hit?.[1] ?? 0.5) * n), 0, n - 1)
    const staging = this.device.createBuffer({ size: n * 32, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST })
    try {
      const enc = this.device.createCommandEncoder({ label: 'section' })
      enc.copyBufferToBuffer(sim.ground, row * n * 16, staging, 0, n * 16)
      enc.copyBufferToBuffer(sim.water, row * n * 16, staging, n * 16, n * 16)
      this.device.queue.submit([enc.finish()])
      await staging.mapAsync(GPUMapMode.READ)
      const data = new Float32Array(staging.getMappedRange().slice(0))
      staging.unmap()
      return {
        size: n,
        row,
        ground: data.subarray(0, n * 4),
        water: data.subarray(n * 4),
        origin: this.origin,
        extent: this.extent,
        seed: this.settings.seed,
      }
    } finally {
      staging.destroy()
    }
  }

  dispose() {
    this.labelCanvas.remove()
    this.disposed = true
    cancelAnimationFrame(this.raf)
    if (this.onFocus) window.removeEventListener('focus', this.onFocus)
    if (this.onBlur) window.removeEventListener('blur', this.onBlur)
    this.input?.dispose()
    this.clearUndo()
    this.clearRewind()
    this.context.unconfigure()
    this.device.destroy()
    this.listeners.clear()
  }

  // ---- state management ------------------------------------------------------------

  private pushUndo(enc: GPUCommandEncoder) {
    const max = clamp(Math.floor(UNDO_BUDGET_BYTES / this.sim.snapshotBytes), 1, MAX_UNDO)
    while (this.undoStack.length >= max) this.undoStack.shift()?.destroy()
    this.undoStack.push(this.sim.encodeSnapshot(enc))
    this.updateUndoStat()
  }

  private clearUndo() {
    for (const snap of this.undoStack) snap.destroy()
    this.undoStack.length = 0
    this.updateUndoStat()
  }

  // ---- rewinding ------------------------------------------------------------------

  private clearRewind() {
    for (const entry of this.rewindRing) entry.snap.destroy()
    this.rewindRing.length = 0
    this.lastRewindSnap = -Infinity
  }

  /** Every few simulated seconds a snapshot joins the ring; the ring covers about REWIND_SPAN seconds. */
  private recordRewind(enc: GPUCommandEncoder) {
    if (this.busy || this.needsGenerate || this.rewinding) return
    const max = clamp(Math.floor(REWIND_BUDGET_BYTES / this.sim.snapshotBytes), 1, MAX_REWIND)
    if (this.simTime - this.lastRewindSnap < Math.max(5, REWIND_SPAN / max)) return
    this.lastRewindSnap = this.simTime
    while (this.rewindRing.length >= max) this.rewindRing.shift()?.snap.destroy()
    this.rewindRing.push({ snap: this.sim.encodeSnapshot(enc), simTime: this.simTime, timeOfDay: this.settings.timeOfDay })
  }

  /** Steps the world one snapshot back in time; hold the button (or B) to keep going. The first step is undoable. */
  rewind() {
    const now = performance.now()
    if (now - this.lastRewind < 250 || this.busy) return
    const entry = this.rewindRing.pop()
    if (!entry) return
    this.lastRewind = now
    const enc = this.device.createCommandEncoder({ label: 'rewind' })
    if (!this.rewinding) {
      this.pushUndo(enc)
      this.rewinding = true
    }
    this.sim.encodeRestore(enc, entry.snap)
    this.device.queue.submit([enc.finish()])
    void this.device.queue.onSubmittedWorkDone().then(() => entry.snap.destroy())
    this.simTime = entry.simTime
    this.lastRewindSnap = entry.simTime
    this.storms = []
    this.settings = { ...this.settings, timeOfDay: entry.timeOfDay }
    this.stats = { ...this.stats, rewindSeconds: this.rewindReach() }
    this.emit()
  }

  rewindEnd() {
    this.rewinding = false
  }

  /** Goes back to the snapshot nearest to this many simulated seconds ago (the timeline strip). */
  rewindTo(secondsAgo: number) {
    if (this.busy || !this.rewindRing.length) return
    const target = this.simTime - secondsAgo
    // the last snapshot at or before the target (the oldest if none is)
    let k = 0
    for (let j = 0; j < this.rewindRing.length; j++) if (this.rewindRing[j].simTime <= target) k = j
    // the later snapshots are dropped: time goes back past them
    while (this.rewindRing.length > k + 1) this.rewindRing.pop()?.snap.destroy()
    this.lastRewind = 0
    this.rewind()
    this.rewinding = false
  }

  /** The rewind strip: the snapshots and the chronicle's events, in seconds before now. */
  private timeline(): Timeline {
    const reach = this.rewindReach()
    const snapshots = this.rewindRing.map((r) => this.simTime - r.simTime)
    const marks: Timeline['marks'] = []
    if (this.settings.life && reach > 0) {
      const now = this.life.now
      for (const ev of this.life.chronicleEvents) {
        const ago = now - ev.time
        if (ago >= 0 && ago <= reach) marks.push({ ago, text: ev.text, color: ev.color, major: ev.major })
      }
    }
    return { reach, snapshots, marks }
  }

  // ---- exports ---------------------------------------------------------------------

  /**
   * Saves the political map as a PNG: the window's terrain (water, ice, land shaded by
   * height and plants), each people's land over it, the towns and the peoples' names, with
   * a legend and the year.
   */
  exportPoliticalMap(): Promise<Blob | null> {
    const f = this.field
    if (!f) {
      this.notice('A análise ainda não leu o mundo; tente de novo em alguns segundos.')
      return Promise.resolve(null)
    }
    const N = 1024
    const legendH = 60 + 28 * Math.max(1, this.lifeStats()?.civs.length ?? 0)
    const canvas = document.createElement('canvas')
    canvas.width = N
    canvas.height = N + legendH
    const ctx = canvas.getContext('2d')
    if (!ctx) return Promise.resolve(null)
    // the terrain, cell by cell
    const img = ctx.createImageData(N, N)
    const n = f.size
    const seaLevel = this.settings.ocean ? this.seaLevel : -Infinity
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const cx = Math.floor((x / N) * n)
        const cy = Math.floor((y / N) * n)
        const i = cy * n + cx
        const h = f.ground[i * 4]
        const w = f.water[i * 4]
        const veg = f.extra[i * 4]
        const ice = f.extra[i * 4 + 3]
        const lava = f.lava[i * 4]
        const hx = f.ground[(cy * n + Math.min(cx + 1, n - 1)) * 4] - h
        const hy = f.ground[(Math.min(cy + 1, n - 1) * n + cx) * 4] - h
        const shade = clamp(1 - (hx + hy) * n * 0.5, 0.65, 1.3)
        let r: number
        let g: number
        let b: number
        if (w > 0.002) {
          const deep = clamp((w - 0.002) / 0.05, 0, 1) * (h + w < seaLevel + 0.01 ? 1 : 0.5)
          r = 70 - 30 * deep
          g = 130 - 50 * deep
          b = 190 - 40 * deep
        } else if (ice > 0.0005 || f.extra[i * 4 + 2] > 0.0004) {
          r = g = 235 * shade
          b = 245 * shade
        } else if (lava > 0.0002) {
          r = 200
          g = 60
          b = 20
        } else {
          const t = clamp(h * 1.6, 0, 1)
          const bare = [150 + 60 * t, 125 + 45 * t, 90 + 40 * t]
          const green = [90, 140 - 30 * t, 60]
          r = (bare[0] * (1 - veg) + green[0] * veg) * shade
          g = (bare[1] * (1 - veg) + green[1] * veg) * shade
          b = (bare[2] * (1 - veg) + green[2] * veg) * shade
        }
        const k = (y * N + x) * 4
        img.data[k] = r
        img.data[k + 1] = g
        img.data[k + 2] = b
        img.data[k + 3] = 255
      }
    }
    ctx.putImageData(img, 0, 0)
    const e = this.extent
    const size = this.sim.size
    const stats = this.lifeStats()
    if (this.settings.life && stats) {
      // the peoples' land
      const map = this.life.territory(this.origin, size, e)
      if (map) {
        const T = TERRITORY_N
        const cell = N / T
        for (let y = 0; y < T; y++) {
          for (let x = 0; x < T; x++) {
            const v = map[y * T + x]
            const owner = v & 15
            if (!owner) continue
            const c = CIV_COLORS[owner - 1]
            ctx.fillStyle = `rgba(${Math.round(c[0] * 255)}, ${Math.round(c[1] * 255)}, ${Math.round(c[2] * 255)}, 0.42)`
            ctx.fillRect(x * cell, y * cell, cell + 0.5, cell + 0.5)
            // the border where the neighbour belongs to someone else
            const left = x > 0 ? map[y * T + x - 1] & 15 : 0
            const up = y > 0 ? map[(y - 1) * T + x] & 15 : 0
            ctx.fillStyle = 'rgba(20, 20, 20, 0.55)'
            if (left !== owner) ctx.fillRect(x * cell, y * cell, 1.5, cell)
            if (up !== owner) ctx.fillRect(x * cell, y * cell, cell, 1.5)
          }
        }
      }
      // towns and names
      const towns = this.life.townsIn(this.origin, size, e)
      ctx.textAlign = 'center'
      ctx.lineJoin = 'round'
      for (const t of towns) {
        const c = CIV_COLORS[t.color]
        const px = t.uv[0] * N
        const py = t.uv[1] * N
        ctx.beginPath()
        ctx.arc(px, py, t.capital ? 7 : 3.5 + 3 * t.pop, 0, Math.PI * 2)
        ctx.fillStyle = `rgb(${Math.round(c[0] * 255)}, ${Math.round(c[1] * 255)}, ${Math.round(c[2] * 255)})`
        ctx.fill()
        ctx.lineWidth = t.capital ? 2.5 : 1.2
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.7)'
        ctx.stroke()
        if (t.monument) {
          ctx.fillStyle = '#fff'
          ctx.font = 'bold 11px sans-serif'
          ctx.fillText('▲', px, py - 9)
        }
      }
      ctx.font = 'bold 20px sans-serif'
      for (const t of towns) {
        if (!t.capital) continue
        ctx.lineWidth = 4
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.8)'
        ctx.strokeText(t.civ, t.uv[0] * N, t.uv[1] * N - 12)
        ctx.fillStyle = '#fff'
        ctx.fillText(t.civ, t.uv[0] * N, t.uv[1] * N - 12)
      }
      // the legend
      ctx.fillStyle = '#1b1b1f'
      ctx.fillRect(0, N, N, legendH)
      ctx.textAlign = 'left'
      ctx.fillStyle = '#f2f2f2'
      ctx.font = 'bold 22px sans-serif'
      ctx.fillText(`Mapa político · ano ${stats.year} · ${stats.people} pessoas em ${stats.villages} cidades`, 20, N + 34)
      ctx.font = '16px sans-serif'
      stats.civs.forEach((civ, k) => {
        const c = CIV_COLORS[civ.color]
        const y = N + 60 + k * 28
        ctx.fillStyle = `rgb(${Math.round(c[0] * 255)}, ${Math.round(c[1] * 255)}, ${Math.round(c[2] * 255)})`
        ctx.fillRect(20, y - 2, 18, 18)
        ctx.fillStyle = '#f2f2f2'
        ctx.fillText(
          `${civ.name} · ${civ.era} · ${civ.towns} ${civ.towns === 1 ? 'cidade' : 'cidades'} · ${civ.people} pessoas · ${civ.faith}${civ.atWar ? ' · em guerra' : ''}`,
          48,
          y + 13,
        )
      })
    } else {
      ctx.fillStyle = '#1b1b1f'
      ctx.fillRect(0, N, N, legendH)
      ctx.fillStyle = '#f2f2f2'
      ctx.font = 'bold 22px sans-serif'
      ctx.fillText('Mapa do mundo', 20, N + 34)
    }
    return this.saveCanvas(canvas, `craftscape-mapa-${stamp()}.png`)
  }

  /** Downloads a canvas as a PNG; the blob comes back for whoever wants it (tests). */
  private saveCanvas(canvas: HTMLCanvasElement, name: string): Promise<Blob | null> {
    return new Promise((resolve) =>
      canvas.toBlob((blob) => {
        if (blob) downloadBlob(blob, name)
        resolve(blob)
      }, 'image/png'),
    )
  }

  /** Saves the chronicle (the peoples' history as the Life tab tells it) as a PNG page. */
  exportChronicle(): Promise<Blob | null> {
    const events = this.life.chronicleEvents
    const stats = this.lifeStats()
    if (!this.settings.life || !stats) {
      this.notice('A crônica só existe com a vida ligada.')
      return Promise.resolve(null)
    }
    const W = 960
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')
    if (!ctx) return Promise.resolve(null)
    // measure first: lines wrap
    const wrap = (text: string, font: string, width: number) => {
      ctx.font = font
      const words = text.split(' ')
      const lines: string[] = []
      let line = ''
      for (const w of words) {
        const next = line ? `${line} ${w}` : w
        if (ctx.measureText(next).width > width && line) {
          lines.push(line)
          line = w
        } else line = next
      }
      if (line) lines.push(line)
      return lines
    }
    const entries = events.map((ev) => ({ ev, lines: wrap(ev.text, `${ev.major ? 'bold ' : ''}17px Georgia, serif`, W - 160) }))
    const civLines = stats.civs.map(
      (c) => `${c.name}: ${c.era}, ${c.towns} ${c.towns === 1 ? 'cidade' : 'cidades'}, ${c.people} pessoas, ${c.faith}`,
    )
    const H = 150 + entries.reduce((s, x) => s + 10 + x.lines.length * 22, 0) + 40 + civLines.length * 22 + 40
    canvas.width = W
    canvas.height = H
    // parchment
    ctx.fillStyle = '#efe6cf'
    ctx.fillRect(0, 0, W, H)
    ctx.fillStyle = 'rgba(120, 90, 40, 0.08)'
    for (let k = 0; k < 400; k++) ctx.fillRect(Math.random() * W, Math.random() * H, 2 + Math.random() * 40, 1)
    ctx.fillStyle = '#3a2a16'
    ctx.font = 'bold 30px Georgia, serif'
    ctx.fillText(`Crônica do mundo`, 60, 60)
    ctx.font = '18px Georgia, serif'
    ctx.fillText(
      `Ano ${stats.year} · ${stats.people} pessoas em ${stats.villages} cidades · ${stats.civs.length} ${stats.civs.length === 1 ? 'povo' : 'povos'}${stats.ending ? ` · ${stats.ending}` : ''}`,
      60,
      92,
    )
    ctx.strokeStyle = 'rgba(58, 42, 22, 0.5)'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(60, 108)
    ctx.lineTo(W - 60, 108)
    ctx.stroke()
    let y = 140
    for (const { ev, lines } of entries) {
      const c = CIV_COLORS[ev.color] ?? [0.3, 0.3, 0.3]
      ctx.fillStyle = ev.color ? `rgb(${Math.round(c[0] * 255)}, ${Math.round(c[1] * 255)}, ${Math.round(c[2] * 255)})` : '#6a5a3a'
      ctx.fillRect(60, y - 12, 10, 10)
      ctx.fillStyle = '#5a4a2a'
      ctx.font = '15px Georgia, serif'
      ctx.textAlign = 'right'
      ctx.fillText(`ano ${ev.year}`, 140, y)
      ctx.textAlign = 'left'
      ctx.fillStyle = '#2e2212'
      ctx.font = `${ev.major ? 'bold ' : ''}17px Georgia, serif`
      for (const line of lines) {
        ctx.fillText(line, 156, y)
        y += 22
      }
      y += 10
    }
    y += 20
    ctx.font = 'bold 20px Georgia, serif'
    ctx.fillText('Os povos de hoje', 60, y)
    y += 30
    ctx.font = '16px Georgia, serif'
    for (const line of civLines) {
      ctx.fillText(line, 60, y)
      y += 22
    }
    return this.saveCanvas(canvas, `craftscape-cronica-${stamp()}.png`)
  }

  private rewindReach() {
    return this.rewindRing.length ? this.simTime - this.rewindRing[0].simTime : 0
  }

  private updateUndoStat() {
    this.stats = { ...this.stats, undoDepth: this.undoStack.length }
    this.emit()
  }

  /** Loads a full state, switching resolution if needed; the previous terrain becomes undoable. */
  private async replaceState(state: SimState) {
    if (state.size !== this.sim.size) {
      this.swapSimulation(state.size)
    } else {
      const enc = this.device.createCommandEncoder()
      this.pushUndo(enc)
      this.device.queue.submit([enc.finish()])
    }
    this.sim.writeState(state)
    this.needsGenerate = false
  }

  private swapSimulation(size: number) {
    const old = this.sim
    this.clearUndo()
    this.clearRewind()
    this.sim = new Simulation(this.device, size)
    this.sim.derivedSlices = this.profile.derivedSlices
    this.sim.climateEvery = this.profile.climateEvery
    this.sim.splitFlow = this.softwareGPU
    this.renderer.setSimulation(this.sim)
    this.hit = null
    this.stats = { ...this.stats, resolution: size }
    void this.device.queue.onSubmittedWorkDone().then(() => old.destroy())
  }

  private async changeResolution(size: number) {
    if (size === this.sim.size || this.busy) return
    this.busy = true
    try {
      const old = this.sim.size
      const state = resampleState(await this.sim.readState(), size)
      this.swapSimulation(size)
      this.sim.writeState(state)
      this.world.resample(size / TILES)
      this.moveOrigin([(this.origin[0] * size) / old, (this.origin[1] * size) / old])
    } finally {
      this.busy = false
    }
  }

  /**
   * Opens volcanic vents on the n highest peaks of the window (kept apart from each
   * other), reading the terrain back and writing it with the vents painted in.
   */
  private async placeVents(n: number) {
    this.busy = true
    try {
      const state = await this.sim.readState()
      const size = state.size
      const margin = Math.round(size * 0.12)
      const apart = size * 0.18
      const peaks: [number, number][] = []
      const order: number[] = []
      for (let y = margin; y < size - margin; y += 2) {
        for (let x = margin; x < size - margin; x += 2) order.push(y * size + x)
      }
      order.sort((a, b) => state.ground[b * 4] - state.ground[a * 4])
      for (const i of order) {
        const x = i % size
        const y = Math.floor(i / size)
        if (peaks.every(([px, py]) => Math.hypot(px - x, py - y) > apart)) peaks.push([x, y])
        if (peaks.length >= n) break
      }
      const r = Math.max(2, Math.round(size / 160))
      for (const [px, py] of peaks) {
        for (let y = py - r; y <= py + r; y++) {
          for (let x = px - r; x <= px + r; x++) {
            const d = Math.hypot(x - px, y - py) / r
            if (d <= 1) state.lava[(y * size + x) * 4 + 2] = Math.max(state.lava[(y * size + x) * 4 + 2], 1 - d * 0.5)
          }
        }
      }
      if (state.size === this.sim.size) this.sim.writeState(state)
    } catch {
      // device lost or resolution changed meanwhile: the world just starts without vents
    } finally {
      this.busy = false
    }
  }

  /**
   * A new simulated area: the terrain is generated again around the world origin (the
   * old one does not map onto a window of a different size), with the resolution
   * following the area when it is automatic.
   */
  private changeArea() {
    this.clearUndo()
    this.settings = {
      ...this.settings,
      brushSize: Math.min(this.settings.brushSize, brushMax(this.extent)),
    }
    this.needsGenerate = true
    this.moveOrigin([0, 0])
    this.camera.setWorld([0, 0, 0], this.settings.infiniteWorld, this.extent)
    this.camera.reset()
    if (this.sim.size !== this.resolution) void this.changeResolution(this.resolution)
  }

  /** Reads the cell under the cursor (and its wind cell) back for the inspect card. */
  private async probeAt(hit: [number, number, number], ndc: [number, number]) {
    this.probing = true
    this.lastProbe = performance.now()
    const sim = this.sim
    const staging = this.device.createBuffer({ size: 128, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST })
    try {
      const n = sim.size
      const x = clamp(Math.floor(hit[0] * n), 0, n - 1)
      const y = clamp(Math.floor(hit[1] * n), 0, n - 1)
      const cell = (y * n + x) * 16
      const windCell = (Math.floor(y / 4) * sim.flowSize + Math.floor(x / 4)) * 16
      const enc = this.device.createCommandEncoder({ label: 'probe' })
      ;[sim.ground, sim.water, sim.extra, sim.climate, sim.air, sim.lava].forEach((buffer, k) =>
        enc.copyBufferToBuffer(buffer, cell, staging, k * 16, 16),
      )
      enc.copyBufferToBuffer(sim.wind, windCell, staging, 96, 16)
      enc.copyBufferToBuffer(sim.fine, cell / 4, staging, 112, 4)
      this.device.queue.submit([enc.finish()])
      await staging.mapAsync(GPUMapMode.READ)
      const d = new Float32Array(staging.getMappedRange().slice(0))
      staging.unmap()
      if (sim !== this.sim || this.settings.tool !== 'inspect' || !this.input.cursor) return
      const [vx, vy] = [d[24], d[25]]
      this.probe = {
        ndc,
        height: d[0],
        rock: d[1],
        soil: d[2],
        sand: d[3],
        water: d[4],
        flow: Math.hypot(d[5], d[6]) / (d[4] + 0.0005),
        sediment: d[7] + d[28],
        plants: d[8],
        moisture: d[9],
        snow: d[10],
        ice: d[11],
        humidity: d[13],
        rain: d[14],
        temperature: d[15],
        lava: d[20],
        vent: d[22],
        airSource: Math.round(d[19] / 4) * 0.002,
        tectonic: d[23],
        plate: this.plateAt(hit),
        windDirection: ((Math.atan2(vy, vx) * 180) / Math.PI + 360) % 360,
        windSpeed: (Math.hypot(vx, vy) / sim.flowSize) * 512 * this.extent,
        pressure: d[27],
        biome: biomeIndex(d[15], d[14]),
        town: this.settings.life ? this.life.townAt(this.worldAt(hit)) : null,
      }
      this.emit()
    } catch {
      // device lost or the simulation replaced mid-read: the next probe will do
    } finally {
      staging.destroy()
      this.probing = false
    }
  }

  // ---- plate tectonics ------------------------------------------------------------------

  /** Window uv → world units (where the plates live). */
  private worldAt(uv: [number, number] | [number, number, number]): [number, number] {
    const n = this.sim.size
    return [(uv[0] + this.origin[0] / n) * this.extent, (uv[1] + this.origin[1] / n) * this.extent]
  }

  private uvAt(p: [number, number]): [number, number] {
    const n = this.sim.size
    return [p[0] / this.extent - this.origin[0] / n, p[1] / this.extent - this.origin[1] / n]
  }

  /** What the plates depend on right now (see plates.ts). */
  private plates(): PlateField {
    return { seed: this.settings.seed, time: this.plateTime, overrides: this.plateOverrides }
  }

  private plateAt(hit: [number, number, number]): Probe['plate'] {
    const b = boundaryAt(this.worldAt(hit), this.plates())
    const [vx, vy] = plateVelocity(b.pair.own, this.plates())
    return {
      direction: ((Math.atan2(vy, vx) * 180) / Math.PI + 360) % 360,
      speed: Math.hypot(vx, vy),
      boundary: b.pair.dist < 0.12 ? b.kind : null,
      closing: b.closing,
    }
  }

  /**
   * Plates tool: pressing grabs the plate under the cursor, dragging points it the way the
   * drag goes (longer drags move it faster), letting go shakes its boundary with an
   * earthquake. The uplift follows on the next frame.
   */
  private dragPlate(active: boolean) {
    if (!active || !this.hit) {
      const drag = this.plateDrag
      this.plateDrag = null
      if (drag?.turned) this.strike(boundaryAt(drag.from, this.plates()), 5.5 + Math.random())
      return
    }
    const p = this.worldAt(this.hit)
    if (!this.plateDrag) {
      this.plateDrag = { cell: platePair(p, this.plates()).own, from: p, turned: false }
      return
    }
    const { cell, from } = this.plateDrag
    const dx = p[0] - from[0]
    const dy = p[1] - from[1]
    const len = Math.hypot(dx, dy)
    if (len < 0.02) return
    const speed = clamp(len / 0.3, 0.2, 1)
    const velocity: [number, number] = [(dx / len) * speed, (dy / len) * speed]
    // the plate goes on from where it is now, in the new direction
    const override: PlateOverride = { cell, velocity, from: plateDrift(cell, this.plates()), at: this.plateTime }
    this.plateOverrides = [...this.plateOverrides.filter((o) => !sameCell(o.cell, cell)), override].slice(-16)
    this.plateDrag.turned = true
    this.sim.platesDirty = true
  }

  /**
   * Continental drift (experimental): every plate due another whole cell of drift carries
   * its land a cell that way, with the water, the plants and the peoples' towns on it.
   */
  private driftLand(enc: GPUCommandEncoder) {
    const cell = this.extent / this.sim.size
    const key = `${this.sim.size}:${this.extent}`
    if (key !== this.carriedFor) {
      this.carried.clear()
      this.carriedFor = key
    }
    const f = this.plates()
    const [x0, y0] = this.worldAt([0, 0])
    const [x1, y1] = this.worldAt([1, 1])
    const moves: PlateMove[] = []
    // the plates over the window: a plate's site may lie well outside the land it covers
    for (const { cell: c } of platesIn(x0 - 1.2, y0 - 1.2, x1 + 1.2, y1 + 1.2, f)) {
      const d = plateDrift(c, f)
      const target: [number, number] = [Math.round(d[0] / cell), Math.round(d[1] / cell)]
      const k = `${c[0]},${c[1]}`
      const done = this.carried.get(k)
      // a plate first seen starts from where it is: its land is not caught up
      if (!done) {
        this.carried.set(k, target)
        continue
      }
      const shift: [number, number] = [clamp(target[0] - done[0], -1, 1), clamp(target[1] - done[1], -1, 1)]
      if ((!shift[0] && !shift[1]) || moves.length >= MAX_PLATE_MOVES) continue
      this.carried.set(k, [done[0] + shift[0], done[1] + shift[1]])
      moves.push({ cell: c, shift })
    }
    if (!moves.length) return
    this.sim.encodeDrift(enc, moves)
    if (this.settings.life) {
      const shifts = new Map(moves.map((m) => [`${m.cell[0]},${m.cell[1]}`, m.shift]))
      this.life.drift((pos) => {
        const own = platePair(pos, f).own
        const s = shifts.get(`${own[0]},${own[1]}`)
        return s ? [s[0] * cell, s[1] * cell] : null
      })
    }
  }

  /** Every so often (more often in geological time) a fault slips somewhere along a boundary in view. */
  private scheduleQuake(steps: number) {
    const s = this.settings
    if (!s.earthquakes || steps <= 0) return
    this.quakeClock -= steps * Math.min(s.geologicTime, 5)
    if (this.quakeClock > 0) return
    this.quakeClock = QUAKE_STEPS * (0.5 + Math.random())
    // a few random spots; the busiest boundary close to one of them
    let best: Boundary | null = null
    let bestScore = 0
    for (let k = 0; k < 16; k++) {
      const b = boundaryAt(this.worldAt([0.1 + 0.8 * Math.random(), 0.1 + 0.8 * Math.random()]), this.plates())
      const score = (Math.abs(b.closing) + Math.abs(b.shear)) * Math.random()
      if (b.pair.dist < 0.15 && score > bestScore) [best, bestScore] = [b, score]
    }
    // magnitude 5 – 7.5, the big ones rare
    if (best) this.strike(best, 5 + 2.5 * Math.random() ** 2)
  }

  /** Queues an earthquake of this magnitude on a boundary, for the next frame. */
  private strike(b: Boundary, magnitude: number) {
    const uv = this.uvAt(b.point)
    if (uv[0] < 0 || uv[1] < 0 || uv[0] > 1 || uv[1] > 1) return
    // each step of magnitude: about 3× the slip and the size of the shaken area
    const scale = 10 ** ((magnitude - 6) / 2)
    const slip = b.kind === 'convergent' ? 0.0006 : b.kind === 'divergent' ? -0.0006 : 0
    this.pendingQuake = {
      uv,
      normal: Math.atan2(b.normal[1], b.normal[0]),
      radius: 0.06 * scale,
      slip: slip * scale,
      rubble: 0.0008 * scale,
    }
    this.toast(`Terremoto de magnitude ${magnitude.toFixed(1).replace('.', ',')}: ${BOUNDARY_NAMES[b.kind]}`)
    this.playSound('rumble')
    if (magnitude >= 6.5) this.life.chronicle(`Um terremoto de magnitude ${magnitude.toFixed(1).replace('.', ',')} sacode a terra.`, magnitude >= 7, b.point)
    // the big ones bring houses down, and under the sea raise a tsunami
    if (magnitude >= 6.5) {
      if (this.settings.life) this.life.shake(b.point, Math.min(0.06 * scale, 0.9) * 0.8, clamp((magnitude - 5) / 4, 0, 1))
      this.powers.tsunami(b.point, magnitude, true)
    }
  }

  /**
   * Volcanoes: now and then one wakes up on a plate boundary (where plates collide most of
   * all, or pull apart), its vent opens and erupts for a few simulated minutes, building a
   * cone of lava, while its ash shades and cools the region and a little the whole planet;
   * then it goes quiet. A dormant volcano wakes again half the time, so the cone keeps growing.
   */
  private scheduleVolcanoes(steps: number) {
    const s = this.settings
    if (steps <= 0) return
    const simSeconds = steps * STEP
    for (const v of this.volcanoes) {
      if (!v.erupting) continue
      v.left -= simSeconds
      if (v.left <= 0) this.quietVolcano(v)
    }
    if (!s.volcanoes) return
    this.volcanoClock -= steps * Math.min(s.geologicTime, 5)
    if (this.volcanoClock > 0) return
    this.volcanoClock = VOLCANO_STEPS * (0.5 + Math.random())
    const dormant = this.volcanoes.filter((v) => !v.erupting)
    if (dormant.length && Math.random() < 0.5) {
      this.erupt(dormant[Math.floor(Math.random() * dormant.length)])
      return
    }
    // a few random spots; the boundary nearest one of them, colliding plates preferred
    let best: Boundary | null = null
    let bestScore = 0
    for (let k = 0; k < 16; k++) {
      const b = boundaryAt(this.worldAt([0.1 + 0.8 * Math.random(), 0.1 + 0.8 * Math.random()]), this.plates())
      const score = (b.kind === 'convergent' ? b.closing * 2 : b.kind === 'divergent' ? -b.closing : 0) * Math.random()
      if (b.pair.dist < 0.12 && score > bestScore) [best, bestScore] = [b, score]
    }
    if (!best) return
    const uv = this.uvAt(best.point)
    if (uv[0] < 0.05 || uv[1] < 0.05 || uv[0] > 0.95 || uv[1] > 0.95) return
    // not under the deep sea (the field is a few seconds old, which is fine here)
    const f = this.field
    if (f) {
      const i = Math.floor(uv[1] * f.size) * f.size + Math.floor(uv[0] * f.size)
      if (f.water[i * 4] > 0.01) return
    }
    if (this.volcanoes.some((v) => Math.hypot(v.uv[0] - uv[0], v.uv[1] - uv[1]) < 0.04)) return
    while (this.volcanoes.length >= MAX_VOLCANOES) {
      const k = this.volcanoes.findIndex((v) => !v.erupting)
      if (k < 0) return
      this.volcanoes.splice(k, 1)
    }
    const volcano: Volcano = {
      name: `Monte ${placeName()}`,
      uv,
      radius: 0.01 / this.extent,
      strength: 0,
      left: 0,
      erupting: false,
      eruptions: 0,
    }
    this.volcanoes.push(volcano)
    this.erupt(volcano)
  }

  private erupt(v: Volcano) {
    v.erupting = true
    v.eruptions++
    v.strength = 0.4 + 0.6 * Math.random()
    v.left = 60 + 180 * Math.random()
    this.pendingVent = { uv: v.uv, radius: v.radius, delta: v.strength }
    // the ash: a cloud that shades and cools the region for days, and a little the whole planet
    const cooling = 2 + 6 * v.strength
    this.dusts = [...this.dusts, { uv: v.uv, cooling, radius: (0.15 + 0.2 * v.strength) / this.extent }].slice(-MAX_DUSTS)
    this.dust = Math.min(this.dust + 0.3 + v.strength, 6)
    const again = v.eruptions > 1 ? ' de novo' : ''
    this.toast(`O ${v.name} entrou em erupção${again}: lava por uns minutos, e cinzas que esfriam a região ${cooling.toFixed(0)} °C`)
    this.playSound('rumble')
    this.life.chronicle(`O ${v.name} entra em erupção${again}; a cinza escurece o céu.`, true, this.worldAt(v.uv))
    this.stats = { ...this.stats, volcanoes: this.volcanoReports() }
  }

  private quietVolcano(v: Volcano) {
    v.erupting = false
    v.left = 0
    this.pendingVent = { uv: v.uv, radius: v.radius, delta: -v.strength }
    this.life.chronicle(`O ${v.name} se aquieta.`, false, this.worldAt(v.uv))
    this.stats = { ...this.stats, volcanoes: this.volcanoReports() }
  }

  private volcanoReports() {
    return this.volcanoes.map((v) => ({ name: v.name, erupting: v.erupting }))
  }

  /** The tide right now: the sea rises and falls twice a simulated day. */
  private get tide() {
    const s = this.settings
    if (!s.tides || !s.ocean) return 0
    return TIDE_AMPLITUDE * Math.sin((this.simTime * 2 * Math.PI) / ((s.dayLength * 60) / 2))
  }

  /** Mean sea level in effect: the slider, warming (the slider's in manual climate, the peoples' always), and the tide. */
  private get seaLevel() {
    const s = this.settings
    const warming = (s.autoClimate ? 0 : s.temperature) + this.civWarming + this.godWarming
    return climateOf({ temperature: 0, seaLevel: s.seaLevel }).seaLevel + warming * SEA_RISE_PER_DEGREE + this.tide
  }

  /** A sound for something that happened, when the sounds are on. */
  private playSound(kind: SoundKind) {
    if (this.settings.sound) this.audio.play(kind)
  }

  /** What the powers read of the land at a place (world units), from the last read-back. */
  private powerCell(pos: [number, number]): PowerCell | null {
    const f = this.field
    if (!f) return null
    const n = f.size
    const u = pos[0] / this.extent - f.origin[0] / n
    const v = pos[1] / this.extent - f.origin[1] / n
    if (u < 0 || v < 0 || u >= 1 || v >= 1) return null
    const i = (Math.floor(v * n) * n + Math.floor(u * n)) * 4
    return {
      water: f.water[i],
      vegetation: f.extra[i],
      moisture: f.extra[i + 1],
      snow: f.extra[i + 2],
      temperature: f.climate[i + 3],
      humidity: f.climate[i + 1],
      lava: f.lava[i],
    }
  }

  /** A notice that goes away by itself. */
  private toast(message: string) {
    this.notice(message)
    clearTimeout(this.toastTimer)
    this.toastTimer = window.setTimeout(() => {
      if (this.message === message) this.notice(null)
    }, 5000)
  }

  /** One arrow per plate centred in the window, pointing where it drifts. */
  private plateArrows(): PlateArrow[] {
    const [x0, y0] = this.worldAt([0, 0])
    const e = this.extent
    const field = this.plates()
    return platesIn(x0, y0, x0 + e, y0 + e, field).map(({ cell, site }) => ({
      uv: this.uvAt(site),
      velocity: plateVelocity(cell, field),
      selected: this.plateDrag !== null && sameCell(this.plateDrag.cell, cell),
    }))
  }

  // ---- infinite world ----------------------------------------------------------------

  private moveOrigin(origin: [number, number]) {
    this.origin = origin
    this.needsFar = true
    this.sim.platesDirty = true
    const cells = this.sim.size / TILES
    this.stats = {
      ...this.stats,
      region: [Math.floor(origin[0] / cells) + TILES / 2, Math.floor(origin[1] / cells) + TILES / 2],
      storedRegions: this.world.size,
    }
    this.emit()
  }

  /** Slides the window a region at a time when the camera wanders more than a region from its centre. */
  private followCamera() {
    if (!this.settings.infiniteWorld || this.busy) return
    const [ou, ov] = this.originUnits
    const f = this.camera.focusPoint
    // focus point in window widths, relative to the window centre
    const du = f[0] / this.extent - ou
    const dv = -f[2] / this.extent - ov
    const step = 1 / TILES
    const tx = Math.abs(du) > step ? Math.trunc(du / step) : 0
    const ty = Math.abs(dv) > step ? Math.trunc(dv / step) : 0
    if (tx || ty) void this.slideWindow(tx, ty)
  }

  /**
   * Moves the window (tx, ty) regions through the world: the buffers slide on the GPU,
   * regions coming in are restored if visited before or else generated from the seed,
   * and regions going out are read back and kept.
   */
  private async slideWindow(tx: number, ty: number) {
    this.busy = true
    try {
      const n = this.sim.size
      const cells = n / TILES
      const oldOrigin = this.origin
      const enc = this.device.createCommandEncoder({ label: 'slide window' })
      const readOld = this.sim.encodeReadState(enc)
      this.sim.encodeShift(enc, tx * cells, ty * cells)
      this.device.queue.submit([enc.finish()])
      this.clearUndo()
      this.hit = null

      const origin: [number, number] = [oldOrigin[0] + tx * cells, oldOrigin[1] + ty * cells]
      this.sim.writeOrigin(origin)
      // new strips: generate them all, then put back the regions already visited
      if (tx > 0) this.sim.generateRect([n - tx * cells, 0, n, n])
      if (tx < 0) this.sim.generateRect([0, 0, -tx * cells, n])
      if (ty > 0) this.sim.generateRect([0, n - ty * cells, n, n])
      if (ty < 0) this.sim.generateRect([0, 0, n, -ty * cells])
      const base = [origin[0] / cells, origin[1] / cells]
      for (let ly = 0; ly < TILES; ly++) {
        for (let lx = 0; lx < TILES; lx++) {
          const wasInside = lx + tx >= 0 && lx + tx < TILES && ly + ty >= 0 && ly + ty < TILES
          const stored = !wasInside && this.world.get(base[0] + lx, base[1] + ly)
          if (stored) this.sim.writeRegion(stored.data, cells, lx * cells, ly * cells)
        }
      }
      const restore = this.device.createCommandEncoder({ label: 'restored regions' })
      // the Change map starts over once the new strips are in
      this.sim.encodeResetBaseline(restore)
      this.sim.encodeDerived(restore, true)
      this.device.queue.submit([restore.finish()])
      this.moveOrigin(origin)

      // keep what left
      const state = await readOld()
      const oldBase = [oldOrigin[0] / cells, oldOrigin[1] / cells]
      for (let ly = 0; ly < TILES; ly++) {
        for (let lx = 0; lx < TILES; lx++) {
          const stillInside = lx - tx >= 0 && lx - tx < TILES && ly - ty >= 0 && ly - ty < TILES
          if (!stillInside) this.world.storeFrom(state, lx, ly, oldBase[0] + lx, oldBase[1] + ly)
        }
      }
      this.stats = { ...this.stats, storedRegions: this.world.size }
      this.needsFar = true
      this.emit()
    } catch (err) {
      this.notice(`Falha ao mover a região: ${(err as Error).message}`)
    } finally {
      this.busy = false
    }
  }

  /** Distant terrain from the noise, with the visited regions' real heights laid over it. */
  private refreshFar() {
    this.needsFar = false
    const enc = this.device.createCommandEncoder({ label: 'far terrain' })
    this.sim.encodeFar(enc)
    this.device.queue.submit([enc.finish()])
    const n = this.sim.size
    const cells = n / TILES
    const side = FAR_TEXELS_PER_WINDOW / TILES // far texels per region
    const grid = FAR_GRID
    // far texel (0, 0) sits half the far grid before the window centre
    const startX = (this.origin[0] / cells) * side - grid / 2 + FAR_TEXELS_PER_WINDOW / 2
    const startY = (this.origin[1] / cells) * side - grid / 2 + FAR_TEXELS_PER_WINDOW / 2
    for (const [tx, ty, region] of this.world.entries()) {
      const fx = tx * side - startX
      const fy = ty * side - startY
      if (fx < 0 || fy < 0 || fx + side > grid || fy + side > grid) continue
      for (let r = 0; r < side; r++) {
        this.device.queue.writeBuffer(
          this.sim.far,
          ((fy + r) * grid + fx) * 4,
          region.far as Float32Array<ArrayBuffer>,
          r * side,
          side,
        )
      }
    }
  }

  // ---- frame loop ------------------------------------------------------------------

  private brushFor(painting: boolean, clearing = false): Brush {
    const s = this.settings
    const amount = (s.mode === 'add' ? 1 : -1) * s.brushStrength
    return {
      active: painting,
      uv: this.hit ? [this.hit[0], this.hit[1]] : [0, 0],
      // the brush size is in world units; the simulation measures it in window uv
      radius: s.brushSize / this.extent,
      rock: s.tool === 'rock' ? amount : 0,
      soil: s.tool === 'soil' ? amount : 0,
      sand: s.tool === 'sand' ? amount : 0,
      water: s.tool === 'water' ? amount : 0,
      level: s.tool === 'level' ? s.brushStrength : 0,
      levelHeight: this.levelHeight,
      heat: s.tool === 'heat' && !s.autoClimate ? amount : 0,
      humidity: s.tool === 'humidity' && !s.autoClimate ? amount : 0,
      volcano: s.tool === 'volcano' ? amount : 0,
      pressure: s.tool === 'pressure' ? amount : 0,
      airMass: s.tool === 'airmass' && !s.airMassFixed ? amount : 0,
      airSource: s.tool === 'airmass' && s.airMassFixed ? amount : 0,
      clearAirSources: clearing,
      current: s.tool === 'current' ? amount : 0,
      forest: s.tool === 'forest' ? amount : 0,
    }
  }

  /** A stroke's first press: the one-shot tools (storm, meteor) act here. */
  private strokeStart(hit: [number, number, number]) {
    const s = this.settings
    const uv: [number, number] = [hit[0], hit[1]]
    if (s.tool === 'sun') {
      // the sun power: the whole planet a degree warmer (or cooler) per click, whatever the climate mode
      const delta = s.mode === 'add' ? 1 : -1
      this.godWarming = clamp(this.godWarming + delta, -10, 10)
      const shown = `${this.godWarming > 0 ? '+' : ''}${this.godWarming.toFixed(0)} °C`
      this.toast(delta > 0 ? `O sol se fortalece: o planeta esquenta 1 °C (${shown})` : `O sol enfraquece: o planeta esfria 1 °C (${shown})`)
      this.life.chronicle(delta > 0 ? 'O sol se fortalece: o mundo esquenta.' : 'O sol enfraquece: o mundo esfria.', true)
      this.stats = { ...this.stats, godWarming: this.godWarming }
      this.emit()
    } else if (s.tool === 'drought') {
      // the drought power: a fixed high that keeps the rain off a region until it is lifted
      if (s.mode === 'add') {
        const radius = clamp(s.brushSize * 2, 0.06, 0.4) / this.extent
        this.highs = [...this.highs, { uv, radius }].slice(-MAX_HIGHS)
        this.toast('Seca: uma alta pressão fixa; não chove aqui até você apagá-la (modo −)')
        this.life.chronicle('O céu se fecha para a chuva sobre uma região: uma seca decretada.', true, this.worldAt(uv))
      } else {
        const near = this.highs.findIndex((h) => Math.hypot(h.uv[0] - uv[0], h.uv[1] - uv[1]) < h.radius)
        if (near >= 0) {
          this.highs = this.highs.filter((_, k) => k !== near)
          this.toast('A seca acabou: a chuva volta à região')
          this.life.chronicle('A seca acaba: as chuvas voltam.', false, this.worldAt(uv))
        }
      }
      this.stats = { ...this.stats, droughts: this.highs.length }
      this.emit()
    } else if (s.tool === 'storm') {
      const radius = clamp(s.brushSize * 2, 0.06, 0.35) / this.extent
      this.storms = [...this.storms, { uv, age: 0, radius }].slice(-MAX_STORMS)
      this.toast('Tempestade a caminho: uma baixa profunda que o vento vai levar embora')
      this.playSound('thunder')
    } else if (s.tool === 'fire') {
      if (s.mode === 'add') {
        if (this.powers.ignite(this.worldAt(uv), s.brushSize)) this.playSound('whoosh')
        else this.toast('Nada pega fogo aqui: o fogo precisa de mato, fora da água e da neve')
      }
    } else if (s.tool === 'hurricane') {
      this.powers.hurricane(this.worldAt(uv))
    } else if (s.tool === 'quake') {
      this.powers.quake(this.worldAt(uv), quakeMagnitude(s.brushSize, s.area))
    } else if (s.tool === 'nuke') {
      this.powers.nuke(this.worldAt(uv))
    } else if (s.tool === 'people') {
      const born = this.life.seedCiv(this.worldAt(uv), this.extent)
      this.toast(born ? 'Um povo novo nasce aqui' : 'Aqui não: um povo precisa de terra firme, sem gelo nem lava, longe de outras cidades')
      if (born) this.playSound('chime')
    } else if ((PEOPLE_POWERS as readonly Tool[]).includes(s.tool)) {
      const told = this.life.godPower(s.tool as PeoplePower, this.worldAt(uv))
      this.toast(told ?? 'Nenhuma cidade aqui: clique numa cidade')
      if (told) this.playSound(s.tool === 'plague' ? 'plague' : s.tool === 'discord' ? 'war' : 'chime')
    } else if (s.tool === 'meteor') {
      const radius = clamp(s.brushSize, 0.015, 0.2)
      const depth = radius * 0.3
      this.pendingImpact = { uv, radius, depth }
      this.pendingQuake = { uv, normal: Math.random() * Math.PI, radius: radius * 4, slip: 0, rubble: depth * 0.08 }
      this.dust = Math.min(this.dust + Math.min(depth * 300, 6), 8)
      // the firestorm: the hot plume over the crater becomes a deep low the wind carries off
      const stormRadius = clamp(radius * 5, 0.06, 0.35) / this.extent
      this.storms = [...this.storms, { uv, age: 0, radius: stormRadius }].slice(-MAX_STORMS)
      // the dust cloud: shade and cold over the region for days, spreading as it settles
      const cooling = Math.min(4 + depth * 250, 14)
      this.dusts = [...this.dusts, { uv, cooling, radius: clamp(radius * 6, 0.1, 0.45) / this.extent }].slice(-MAX_DUSTS)
      this.toast(
        `Impacto! Bola de fogo, onda de choque e tempestade; a poeira esfria a região ${cooling.toFixed(0)} °C e o planeta ${this.dust.toFixed(1).replace('.', ',')} °C até baixar`,
      )
      this.life.chronicle('Uma estrela cai do céu: bola de fogo, terremoto e dias de poeira.', true, this.worldAt(uv))
      this.playSound('boom')
    }
  }

  /** Storms age and drift with the prevailing wind (at half its speed, like the weather systems). */
  private driftStorms(simSeconds: number) {
    if ((!this.storms.length && !this.dusts.length) || simSeconds <= 0) return
    const s = this.settings
    const speed = (s.autoClimate ? 0.8 : s.windSpeed) / (512 * this.extent)
    const angle = this.windAngle
    const move = (speed * 0.5 * simSeconds) / STEP
    this.storms = this.storms
      .map((st) => ({
        ...st,
        age: st.age + simSeconds,
        uv: [st.uv[0] + Math.cos(angle) * move, st.uv[1] + Math.sin(angle) * move] as [number, number],
      }))
      .filter((st) => st.age < STORM_LIFE && st.uv[0] > -0.3 && st.uv[0] < 1.3 && st.uv[1] > -0.3 && st.uv[1] < 1.3)
    // dust clouds hang over the region (the heavy column barely drifts: a tenth of the wind),
    // spread out and thin, and settle in a couple of days
    const settle = Math.exp(-simSeconds / (s.dayLength * 60 * 2))
    const drift = move * 0.1
    this.dusts = this.dusts
      .map((d) => ({
        uv: [d.uv[0] + Math.cos(angle) * drift, d.uv[1] + Math.sin(angle) * drift] as [number, number],
        cooling: d.cooling * settle,
        radius: d.radius * (1 + simSeconds / (s.dayLength * 60 * 4)),
      }))
      .filter((d) => d.cooling > 0.3 && d.uv[0] > -0.6 && d.uv[0] < 1.6 && d.uv[1] > -0.6 && d.uv[1] < 1.6)
  }

  /** Removes every fixed air mass painted in the window (undoable). */
  clearAirSources() {
    this.pendingClear = true
  }

  /**
   * Direction the prevailing wind blows towards right now, in radians (0 = east,
   * π/2 = north); with variation on it swings ±40° over a two-minute cycle.
   */
  get windAngle() {
    const s = this.settings
    const report = this.stats.climate
    if (s.autoClimate && report) return (report.windDirection * Math.PI) / 180
    const swing = s.windVariation ? 40 * Math.sin((this.simTime * 2 * Math.PI) / 120) : 0
    return ((s.windDirection + swing) * Math.PI) / 180
  }

  /** Camera heading in radians: 0 looks north, π/2 looks west. */
  get heading() {
    return this.camera.heading
  }

  /** Temperature anomaly in effect: the slider, or the season in automatic climate. */
  private get anomaly() {
    const s = this.settings
    const base = s.autoClimate ? seasonOf(this.simTime / (s.dayLength * 60 * DAYS_PER_YEAR)).anomaly : s.temperature
    return base - this.dust + this.civWarming + this.godWarming + this.powers.heat
  }

  private climate(): Climate {
    const s = this.settings
    const auto = s.autoClimate
    const angle = auto ? (s.windDirection * Math.PI) / 180 : this.windAngle
    // automatic: only the speed matters here, the direction comes from the latitude belts
    // cells per step at 512 cells per world unit → window uv per step
    const speed = (auto ? 0.8 : s.windSpeed) / (512 * this.extent)
    const temperature = this.anomaly
    return {
      baseTemperature: BASE_TEMPERATURE + temperature,
      temperature,
      seaLevel: this.seaLevel,
      ocean: s.ocean,
      latitude: auto ? 16 : s.latitude,
      lapseRate: LAPSE_RATE,
      wind: [Math.cos(angle) * speed, Math.sin(angle) * speed],
      windHumidity: auto ? 0.7 : s.windHumidity,
      rainAmount: auto ? 1 : s.rainAmount,
      pressureSystems: s.pressureSystems ? s.pressureStrength : 0,
      automatic: auto,
      pressureMean: this.pressureMean,
    }
  }

  /**
   * Every few seconds, reads the climate and wind back and sums them up: temperatures,
   * rain, humidity, biome shares, the mean wind and the weather systems.
   */
  private async analyzeClimate() {
    this.analysing = true
    try {
      const sim = this.sim
      const climateBytes = sim.cells * 16
      const windBytes = sim.flowSize * sim.flowSize * 16
      const staging = this.device.createBuffer({
        size: climateBytes * 5 + windBytes,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
      })
      const enc = this.device.createCommandEncoder({ label: 'climate analysis' })
      enc.copyBufferToBuffer(sim.climate, 0, staging, 0, climateBytes)
      enc.copyBufferToBuffer(sim.wind, 0, staging, climateBytes, windBytes)
      enc.copyBufferToBuffer(sim.water, 0, staging, climateBytes + windBytes, climateBytes)
      enc.copyBufferToBuffer(sim.extra, 0, staging, climateBytes * 2 + windBytes, climateBytes)
      enc.copyBufferToBuffer(sim.lava, 0, staging, climateBytes * 3 + windBytes, climateBytes)
      enc.copyBufferToBuffer(sim.ground, 0, staging, climateBytes * 4 + windBytes, climateBytes)
      const origin: [number, number] = [this.origin[0], this.origin[1]]
      this.device.queue.submit([enc.finish()])
      await staging.mapAsync(GPUMapMode.READ)
      const data = new Float32Array(staging.getMappedRange().slice(0))
      staging.unmap()
      staging.destroy()
      if (sim !== this.sim) return
      const n4 = sim.cells * 4
      const w4 = sim.flowSize * sim.flowSize * 4
      const wind = data.subarray(n4, n4 + w4)
      let sum = 0
      for (let i = 3; i < wind.length; i += 4) sum += wind[i]
      this.pressureMean = sum / (wind.length / 4)
      this.field = {
        size: sim.size,
        origin,
        climate: data.subarray(0, n4),
        water: data.subarray(n4 + w4, n4 * 2 + w4),
        extra: data.subarray(n4 * 2 + w4, n4 * 3 + w4),
        lava: data.subarray(n4 * 3 + w4, n4 * 4 + w4),
        ground: data.subarray(n4 * 4 + w4, n4 * 5 + w4),
      }
      const report = summarizeClimate(this.field, wind, sim.flowSize, this.extent)
      this.updateChallenge(report)
      this.stats = { ...this.stats, climate: report, challenge: this.challenge }
      this.emit()
    } catch {
      // device lost or simulation replaced mid-read: try again next time
    } finally {
      this.analysing = false
    }
  }

  /** Starts playing a challenge: its baseline is the next climate report (or the last one). */
  startChallenge(id: ChallengeId) {
    this.challenge = { id, start: this.stats.climate, progress: 0, done: false }
    this.stats = { ...this.stats, challenge: this.challenge }
    this.emit()
  }

  stopChallenge() {
    this.challenge = null
    this.stats = { ...this.stats, challenge: null }
    this.emit()
  }

  /** The peoples' measures for the challenges about them. */
  private worldMetrics(): WorldMetrics {
    const life = this.settings.life ? this.life.stats() : null
    const civs = life?.civs ?? []
    const year = life?.year ?? 0
    if (life && civs.length && !life.wars.length) this.peaceSince ??= year
    else this.peaceSince = null
    return {
      civs: civs.length,
      people: life?.people ?? 0,
      maxTech: Math.max(0, ...civs.map((c) => c.tech)),
      modernCivs: civs.filter((c) => c.eraIndex >= 6).length,
      peaceYears: this.peaceSince === null ? 0 : Math.max(0, year - this.peaceSince),
      voyages: this.life.voyagesTotal,
      nuclearWars: this.life.nuclearCount,
      civWarming: this.civWarming,
    }
  }

  private updateChallenge(report: ClimateReport) {
    const world = this.worldMetrics()
    const c = this.challenge
    if (!c) return
    const start = c.start ?? report
    const progress = clamp(challengeById(c.id).progress(report, start, world), 0, 1)
    const done = c.done || progress >= 1
    if (done && !c.done) {
      this.toast(`Desafio concluído: ${challengeById(c.id).name}!`)
      this.playSound('fanfare')
      if (!this.trophies.includes(c.id)) {
        this.trophies = [...this.trophies, c.id]
        saveTrophies(this.trophies)
        this.stats = { ...this.stats, trophies: this.trophies }
      }
    }
    this.challenge = { ...c, start, progress, done }
  }

  /** The overlay to draw: the chosen one, or the matching map while using the climate brush. */
  private overlay() {
    const s = this.settings
    if (s.overlay !== 'none') return s.overlay
    if (s.tool === 'pressure' || s.tool === 'storm' || s.tool === 'drought') return 'pressure'
    if (s.tool === 'plates') return 'plates'
    if (s.tool === 'airmass') return 'airmass'
    if (s.tool === 'current') return 'current'
    return s.tool === 'heat' ? 'temperature' : s.tool === 'humidity' ? 'humidity' : 'none'
  }

  /**
   * The territories as the map in view paints them: by people (the political map), or
   * each people's land in the colour of its era, faith, tongue's family, plague, hunger or
   * war; the human-impact map paints what the peoples made of the land instead.
   */
  private territoryFor(overlay: Overlay): Uint32Array<ArrayBuffer> | null {
    const base = this.life.territory(this.origin, this.sim.size, this.extent)
    if (overlay !== 'human' && (overlay === 'civilization' || !PEOPLE_MAPS.includes(overlay))) return base
    const out = this.paintedMap
    // repainted twice a second (the peoples change slowly), or when the map changes
    if (overlay === this.paintedFor && this.time - this.paintedAt < 0.5) return out
    this.paintedFor = overlay
    this.paintedAt = this.time
    out.fill(0)
    // a colour of its own for a cell: bit 19 and 4 bits each of red, green and blue above it
    const own = (c: Rgb) => ((1 << 19) | ((c[0] >> 4) << 28) | ((c[1] >> 4) << 24) | ((c[2] >> 4) << 20)) >>> 0
    if (overlay === 'human') {
      const T = TERRITORY_N
      const paint = (uv: [number, number], radius: number, mark: number) => {
        const value = ((mark + 1) | own(HUMAN_MARKS[mark].color)) >>> 0
        const r = radius * T
        const cx = uv[0] * T
        const cy = uv[1] * T
        for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(T - 1, Math.ceil(cy + r)); y++) {
          for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(T - 1, Math.ceil(cx + r)); x++) {
            if ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 > r * r) continue
            const i = y * T + x
            // the heavier mark wins
            if ((out[i] & 15) <= mark + 1) out[i] = value
          }
        }
      }
      for (const w of this.life.works(this.origin, this.sim.size, this.extent)) {
        if (w.kind === 8) continue
        if (w.kind & 1) paint(w.uv, w.radius, 0)
        if (w.kind & 2) paint(w.uv, w.radius * 0.8, 1)
        if (w.kind & 16) paint(w.uv, w.radius * 0.6, 2)
        if (w.kind & 32) paint(w.uv, w.radius * 0.35, 3)
        if (w.kind & 4) paint(w.uv, w.radius * 0.45, 4)
      }
      return out
    }
    if (!base) return null
    const colors: number[] = []
    for (const c of this.stats.life?.civs ?? []) {
      let col: Rgb
      if (overlay === 'eras') col = ERA_RAMP[Math.min(c.eraIndex, ERA_RAMP.length - 1)]
      else if (overlay === 'faith') col = CATEGORICAL[c.faithIndex % CATEGORICAL.length]
      else if (overlay === 'language') col = CATEGORICAL[c.family % CATEGORICAL.length]
      else if (overlay === 'plague') col = mixRgb(CALM, PLAGUE_COLOR, Math.min(1, c.plague * 1.5))
      else if (overlay === 'famine') col = mixRgb(CALM, FAMINE_COLOR, Math.min(1, c.famine * 1.5))
      else col = c.atWar ? WAR_COLOR : PEACE_COLOR
      colors[c.color] = own(col)
    }
    for (let i = 0; i < base.length; i++) {
      const v = base[i]
      const c = v ? colors[(v & 15) - 1] : 0
      out[i] = c ? (v | c) >>> 0 : v
    }
    return out
  }

  private resizeCanvas() {
    const p = this.profile
    let dpr = Math.min(window.devicePixelRatio || 1, p.maxPixelRatio) * this.renderScale
    if (this.shot) {
      // photos: full device resolution times the requested scale, within the GPU's texture limit
      const limit = this.device.limits.maxTextureDimension2D
      const biggest = Math.max(this.canvas.clientWidth, this.canvas.clientHeight, 1)
      dpr = Math.min(Math.max(window.devicePixelRatio || 1, 1) * this.shot.scale, limit / biggest)
    }
    const width = Math.max(1, Math.round(this.canvas.clientWidth * dpr))
    const height = Math.max(1, Math.round(this.canvas.clientHeight * dpr))
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width
      this.canvas.height = height
    }
    this.renderer.resize(width, height)
    this.camera.aspect = width / height
  }

  private tick(now: number) {
    const dt = Math.min((now - this.lastTime) / 1000, 0.25)
    this.lastTime = now
    this.time += dt
    const s = this.settings

    this.resizeCanvas()
    const [ou, ov] = this.originUnits
    const e = this.extent
    this.camera.setWorld([ou * e, 0, -ov * e], s.infiniteWorld, e)
    if (s.cinematic) this.camera.spin(((s.cinematicSpeed * Math.PI) / 180) * dt)
    this.camera.update(dt, this.input.move)
    this.followCamera()
    const view = this.camera.getView()
    const cursor = this.input.cursor
    const worldRay = cursor ? this.camera.ray(cursor[0], cursor[1]) : null
    // the simulation picks in window-local coordinates
    const ray = worldRay && {
      origin: [worldRay.origin[0] - ou * e, worldRay.origin[1], worldRay.origin[2] + ov * e] as [
        number,
        number,
        number,
      ],
      dir: worldRay.dir,
    }
    if (!cursor) this.hit = null

    const inspecting = s.tool === 'inspect'
    // the plates tool drags plates instead of painting
    // (a press that began and ended between two frames still counts, as one frame of painting;
    // it waits a few frames for the pick under the cursor to come back)
    if (this.input.takePress()) this.pressFrames = 5
    const pressed = this.pressFrames > 0 && this.hit !== null
    this.pressFrames = pressed ? 0 : Math.max(this.pressFrames - 1, 0)
    // a click while inspecting picks the town under the cursor for the Life tab
    if (inspecting && pressed && this.hit && s.life) {
      const town = this.life.townAt(this.worldAt(this.hit))
      this.selectedTown = town ? town.id : null
      this.stats = { ...this.stats, life: this.lifeStats() }
      this.emit()
    }
    const pressing = (this.input.painting || pressed) && this.hit !== null && !this.busy && !inspecting
    const painting = pressing && s.tool !== 'plates'
    this.dragPlate(pressing && s.tool === 'plates')
    const toUv = (p: [number, number]) => this.uvAt(p)
    const quake = this.pendingQuake ?? this.powers.nextQuake(toUv)
    this.pendingQuake = null
    const vent = this.pendingVent ?? this.powers.nextVent(toUv, e)
    this.pendingVent = null
    const clearing = this.pendingClear && !this.busy
    if (!this.busy) this.pendingClear = false
    const enc = this.device.createCommandEncoder({ label: 'simulation' })
    this.recordRewind(enc)

    if (painting && !this.wasPainting) {
      this.pushUndo(enc)
      if (this.hit) {
        this.levelHeight = this.hit[2]
        this.strokeStart(this.hit)
      }
    }
    this.wasPainting = painting
    // the fire power lights (or puts out) whatever the stroke passes over
    if (painting && s.tool === 'fire' && this.hit) {
      const at = this.worldAt(this.hit)
      if (s.mode === 'add') this.powers.ignite(at, s.brushSize)
      else this.powers.extinguish(at, s.brushSize)
    }
    if (clearing && !painting) this.pushUndo(enc)
    const impact = this.pendingImpact ?? this.powers.nextImpact(toUv)
    this.pendingImpact = null

    // in the automatic climate the sun follows the latitude in view and the season
    const sky = s.autoClimate ? skyAt(s.timeOfDay, this.latitude, declinationAt(this.yearPhase)) : skyAt(s.timeOfDay)
    this.sim.writeParams(
      {
        rain: s.rain,
        evaporate: s.evaporate,
        erode: s.erode,
        vegetation: s.vegetation,
        time: this.time,
        simTime: this.simTime,
        seed: s.seed,
        light: sky,
        origin: this.origin,
        shape: s.terrainShape,
        extent: e,
        geologicTime: s.geologicTime,
        plateTime: this.plateTime,
        plates: this.plateOverrides,
        impact,
        // the hurricanes first: they are never the ones dropped when there are too many storms
        storms: [
          ...this.powers.storms(toUv, e),
          ...this.storms.map((st) => ({ uv: st.uv, strength: stormStrength(st.age), radius: st.radius })),
        ].slice(0, MAX_STORMS),
        dusts: this.dusts,
        highs: this.highs.map((h) => ({ uv: h.uv, strength: 1, radius: h.radius })),
        quake,
        vent,
        climate: this.climate(),
        brush: this.brushFor(painting, clearing),
        ray,
      },
      this.frame,
    )

    let full = false
    if (this.needsGenerate && !this.busy) {
      if (now - this.lastGenerate > 1000 && this.frame > 0) this.pushUndo(enc)
      this.lastGenerate = now
      this.needsGenerate = false
      this.sim.encodeGenerate(enc)
      this.plateOverrides = []
      this.plateTime = 0
      this.carried.clear()
      full = true
      this.clearRewind()
      this.life.reset()
      this.powers.reset()
      this.peaceSince = null
      this.record = []
      this.eraLog = {}
      this.annals = []
      this.lastAnnal = -Infinity
      this.selectedTown = null
      this.lastFollowed = -1
      this.storms = []
      this.dusts = []
      this.dust = 0
      this.civWarming = 0
      this.godWarming = 0
      this.highs = []
      this.stats = { ...this.stats, godWarming: 0, droughts: 0 }
      this.volcanoes = []
      this.volcanoClock = VOLCANO_STEPS * 0.5
      this.stats = { ...this.stats, volcanoes: [] }
      // a new terrain: the regions visited before belong to the old one
      this.world.clear()
      this.stats = { ...this.stats, storedRegions: 0 }
      this.needsFar = true
    }
    const vents = full ? this.pendingVents : 0
    if (full) this.pendingVents = 0
    if (this.needsFar && s.infiniteWorld && !this.busy) this.refreshFar()

    let steps = 0
    if (!s.paused && !this.busy && !this.rewinding) {
      this.accumulator += dt * s.speed
      // when frames are already slow, run fewer steps (the simulation slows down)
      // instead of spiralling into ever longer frames
      const max = this.profile.maxStepsPerFrame
      // only the time beyond the intended frame interval counts as lag
      const lag = dt - this.frameInterval() / 1000
      const cap = Math.min(lag > 1 / 30 ? 1 : lag > 1 / 50 ? 2 : max, max)
      steps = Math.min(Math.floor(this.accumulator / STEP), cap)
      this.accumulator = Math.min(this.accumulator - steps * STEP, STEP * 2)
      for (let k = 0; k < steps; k++) this.sim.encodeStep(enc, painting)
    } else if (painting && !this.busy) {
      this.accumulator += dt
      const paints = Math.min(Math.floor(this.accumulator / STEP), this.profile.maxStepsPerFrame)
      this.accumulator -= paints * STEP
      for (let k = 0; k < paints; k++) this.sim.encodePaint(enc)
    }
    // the clearing flag is in this frame's params: one paint pass applies it even when
    // the simulation is paused and nothing is being painted
    if (clearing) this.sim.encodePaint(enc)
    // the strike and the fault slip after the steps, so they run on the ground as it was this frame
    if (impact) this.sim.encodeImpact(enc)
    // the peoples work the land while the simulation runs
    if (s.life && steps > 0) {
      const works = this.life.works(this.origin, this.sim.size, this.extent)
      if (works.length) {
        this.sim.writeWorks(works)
        this.sim.encodeWorks(enc)
      }
    }
    if (quake) this.sim.encodeQuake(enc)
    if (vent) this.sim.encodeVent(enc)
    if (s.continentalDrift && steps > 0 && !this.busy) this.driftLand(enc)
    else if (!s.continentalDrift) this.carried.clear()
    // fire, tsunamis, blasts, fallout and the cataclysm
    const acts = this.busy ? [] : this.powers.acts(toUv, e, steps > 0)
    if (acts.length) this.sim.encodeActs(enc, acts)
    this.sim.encodeDerived(enc, full)

    const readPick = ray ? this.sim.encodePick(enc) : null
    this.device.queue.submit([enc.finish()])
    if (vents) void this.placeVents(vents)
    if (readPick) {
      const sim = this.sim
      void readPick().then((hit) => {
        if (sim === this.sim && this.input.cursor) this.hit = hit
      })
    }
    if (inspecting && this.hit && cursor && !this.probing && now - this.lastProbe > 150) {
      void this.probeAt(this.hit, cursor)
    } else if ((!inspecting || !cursor || !this.hit) && this.probe) {
      this.probe = null
      this.emit()
    }

    const clean = s.photoMode || this.shot !== null
    // the maps of the peoples (and of what they made of the land) are all drawn as the atlas
    const shown = this.overlay()
    const peopleMap = PEOPLE_MAPS.includes(shown) || shown === 'human'
    this.renderer.render(
      view,
      {
        uv: this.hit ? [this.hit[0], this.hit[1]] : [0, 0],
        radius: s.brushSize / e,
        visible: this.hit !== null && !clean && !inspecting && s.tool !== 'plates',
      },
      this.time,
      {
        overlay: peopleMap ? 'civilization' : shown,
        arrows: s.windArrows && !clean,
        plateArrows: this.overlay() === 'plates' && !clean ? this.plateArrows() : [],
        life: [...(s.life ? this.life.markers(this.origin, this.sim.size, e) : []), ...this.powers.markers(toUv)],
        roads: s.life && !clean ? this.life.roads(this.origin, this.sim.size, e) : [],
        territory:
          s.life && (s.politicalMap || peopleMap) && !clean ? this.territoryFor(shown) : null,
        clouds: s.clouds,
        sky,
        cloudDrift: this.cloudDrift,
        simTime: this.simTime,
        origin: this.originUnits,
        horizon: s.infiniteWorld,
        extent: e,
        seed: s.seed,
        plates: this.plates(),
        seasonPhase: s.autoClimate ? (this.simTime / (s.dayLength * 60 * DAYS_PER_YEAR)) % 1 : -1,
        farClimate: {
          seaLevel: s.ocean ? this.seaLevel : null,
          baseTemperature: BASE_TEMPERATURE + this.anomaly,
          lapseRate: LAPSE_RATE,
          latitude: s.latitude,
        },
      },
    )
    const atlas = peopleMap
    const labels = s.life && !clean ? this.life.labels(this.origin, this.sim.size, e, this.selectedTown, atlas) : []
    const stormLabels = clean ? [] : this.powers.labels(toUv, (uv) => this.life.surfaceAt(this.worldAt(uv), e))
    this.drawLabels(view.viewProj, [...labels, ...stormLabels], atlas)
    if (this.shot) {
      // the canvas still holds this frame until the task ends; the next frame resizes it back
      const { done } = this.shot
      this.shot = null
      this.canvas.toBlob(done, 'image/png')
    }
    this.advanceTime(steps * STEP)
    this.driftStorms(steps * STEP)
    this.powers.update(steps * STEP)
    if (s.life) {
      this.life.update(steps * STEP, this.field, e)
      this.industrialWarming(steps * STEP)
      if (s.followEvents && !clean) this.followEvents()
    }
    this.plateTime += steps * s.geologicTime * s.plateDrift * PLATE_DRIFT
    this.scheduleQuake(steps)
    this.scheduleVolcanoes(steps)
    if (now - this.lastAnalysis > 3000 && !this.analysing && !this.busy) {
      this.lastAnalysis = now
      void this.analyzeClimate()
    }
    if (s.warming && steps > 0) this.warm(steps * STEP)

    this.frame++
    this.statFrames++
    this.statSteps += steps
    this.updateStats(now)
  }

  /** Industry warms the planet (a degree per ten smoking towns per five simulated minutes, up to 4 °C) and the warmth lingers. */
  private industrialWarming(simSeconds: number) {
    if (simSeconds <= 0) return
    const industries = this.life.stats().industries
    const before = this.civWarming
    if (industries > 0) this.civWarming = Math.min(4, this.civWarming + simSeconds * (industries / 3000))
    else {
      this.civWarming *= Math.exp(-simSeconds / (this.settings.dayLength * 60 * 6))
      if (this.civWarming < 0.02) this.civWarming = 0
    }
    if (before < 1 && this.civWarming >= 1) this.toast('A indústria dos povos já aquece o planeta 1 °C')
    if (Math.round(before * 10) !== Math.round(this.civWarming * 10)) this.stats = { ...this.stats, civWarming: this.civWarming }
  }

  /**
   * Draws the peoples' names over their capitals (and the chosen town) on the label canvas;
   * on the peoples' map (atlas) the names are set like a map's: dark on the parchment, the
   * peoples' in capitals over their land, the towns' small beside a dot.
   */
  private drawLabels(viewProj: Float32Array | number[], labels: LifeLabel[], atlas = false) {
    const c = this.labelCanvas
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const width = Math.round(c.clientWidth * dpr)
    const height = Math.round(c.clientHeight * dpr)
    if (!width || !height) return
    if (c.width !== width || c.height !== height) {
      c.width = width
      c.height = height
    }
    const ctx = c.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, width, height)
    if (!labels.length) return
    const [ou, ov] = this.originUnits
    const e = this.extent
    const m = viewProj
    ctx.textAlign = 'center'
    ctx.textBaseline = 'bottom'
    ctx.lineJoin = 'round'
    for (const l of labels) {
      const x = (l.uv[0] - 0.5 + ou) * e
      const y = l.height + 0.012
      const z = (0.5 - l.uv[1] - ov) * e
      // column-major, as the shaders take it
      const cx = m[0] * x + m[4] * y + m[8] * z + m[12]
      const cy = m[1] * x + m[5] * y + m[9] * z + m[13]
      const cw = m[3] * x + m[7] * y + m[11] * z + m[15]
      if (cw <= 0.0001) continue
      const sx = (cx / cw) * 0.5 + 0.5
      const sy = 0.5 - (cy / cw) * 0.5
      if (sx < -0.1 || sx > 1.1 || sy < -0.1 || sy > 1.1) continue
      const px = sx * width
      const py = sy * height
      const [r, g, b] = CIV_COLORS[l.color].map((v) => Math.round(v * 255))
      const civ = `rgb(${r}, ${g}, ${b})`
      ctx.letterSpacing = '0px'
      if (atlas && l.kind === 'people') {
        // the people's name spread over its land, in a darkened shade of its colour
        const size = (15 + 9 * l.size) * dpr
        ctx.font = `700 ${size}px Georgia, 'Times New Roman', serif`
        ctx.letterSpacing = `${0.18 * size}px`
        // set below its point, so it clears the town names above their dots
        const ty = py + size * 1.1
        ctx.lineWidth = 4 * dpr
        ctx.strokeStyle = 'rgba(248, 243, 228, 0.85)'
        ctx.strokeText(l.text.toUpperCase(), px, ty)
        ctx.fillStyle = `rgb(${Math.round(r * 0.45)}, ${Math.round(g * 0.45)}, ${Math.round(b * 0.45)})`
        ctx.fillText(l.text.toUpperCase(), px, ty)
      } else if (atlas && l.kind === 'town') {
        // a dot for the town (ringed for a capital) with its name beside it
        const radius = (l.major ? 4 : 2.2 + 1.5 * l.size) * dpr
        ctx.beginPath()
        ctx.arc(px, py, radius, 0, Math.PI * 2)
        ctx.fillStyle = l.major ? '#fff' : civ
        ctx.fill()
        ctx.lineWidth = (l.major ? 2 : 1) * dpr
        ctx.strokeStyle = l.major ? civ : 'rgba(30, 25, 20, 0.8)'
        ctx.stroke()
        ctx.font = `${l.major ? '700' : '500'} ${(l.major ? 11.5 : 10) * dpr}px system-ui, sans-serif`
        ctx.lineWidth = 3 * dpr
        ctx.strokeStyle = 'rgba(248, 243, 228, 0.9)'
        ctx.strokeText(l.text, px, py - radius - 2 * dpr)
        ctx.fillStyle = '#2a2622'
        ctx.fillText(l.text, px, py - radius - 2 * dpr)
      } else {
        ctx.font = `${l.kind === 'note' ? 'italic 500' : l.major ? '600' : '500'} ${(l.major ? 13 : 11) * dpr}px system-ui, sans-serif`
        ctx.lineWidth = 3 * dpr
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.75)'
        ctx.strokeText(l.text, px, py)
        ctx.fillStyle = l.major ? `rgb(${Math.min(255, r + 60)}, ${Math.min(255, g + 60)}, ${Math.min(255, b + 60)})` : '#fff'
        ctx.fillText(l.text, px, py)
        if (l.major) {
          ctx.beginPath()
          ctx.arc(px, py + 4 * dpr, 2.5 * dpr, 0, Math.PI * 2)
          ctx.fillStyle = civ
          ctx.fill()
        }
      }
    }
  }

  /** Moves simulated time on: clouds drift with the wind, the day turns. */
  private advanceTime(simSeconds: number) {
    if (simSeconds <= 0) return
    this.simTime += simSeconds
    // the dust from a strike settles with a half-life of about a simulated day and a half
    if (this.dust > 0) {
      this.dust *= Math.exp(-simSeconds / (this.settings.dayLength * 60 * 2))
      if (this.dust < 0.05) this.dust = 0
    }
    const angle = this.windAngle
    const drift = (this.settings.windSpeed / 512) * 60 * simSeconds * 0.5
    // wrapped: the cloud noise is sampled from it and must not lose precision
    this.cloudDrift = [
      (this.cloudDrift[0] - Math.cos(angle) * drift) % 64,
      (this.cloudDrift[1] - Math.sin(angle) * drift) % 64,
    ]
    const s = this.settings
    if (!s.dayNight) return
    const timeOfDay = (s.timeOfDay + simSeconds / (s.dayLength * 60)) % 1
    // the UI shows the clock in 15-minute steps; only re-render when that changes
    const changed = Math.floor(timeOfDay * 96) !== Math.floor(s.timeOfDay * 96)
    this.settings = { ...s, timeOfDay }
    if (changed) this.emit()
  }

  /** The point of the year (0 = start of spring … 1), from the simulated days gone by. */
  private get yearPhase() {
    return (this.simTime / (this.settings.dayLength * 60 * DAYS_PER_YEAR)) % 1
  }

  /** Degrees of latitude (north) at the centre of the window. */
  private get latitude() {
    return latitudeOfWorld(this.worldAt([0.5, 0.5])[1])
  }

  /** The season in the automatic climate, with the latitude in view and its hours of daylight. */
  private updateSeason() {
    const s = this.settings
    if (!s.autoClimate) {
      if (this.stats.season) this.stats = { ...this.stats, season: null }
      return
    }
    const { anomaly, season } = seasonOf(this.yearPhase)
    const latitude = this.latitude
    const hours = dayHours(latitude, declinationAt(this.yearPhase))
    const prev = this.stats.season
    if (
      !prev ||
      prev.name !== season ||
      Math.round(prev.anomaly * 10) !== Math.round(anomaly * 10) ||
      Math.round(prev.latitude) !== Math.round(latitude) ||
      Math.round(prev.dayHours * 2) !== Math.round(hours * 2)
    ) {
      this.stats = { ...this.stats, season: { name: season, anomaly, latitude, dayHours: hours } }
    }
  }

  /** Continuous warming, in simulated time; stops at the top of the scale. */
  private warm(simSeconds: number) {
    const s = this.settings
    const temperature = Math.min(s.temperature + (s.warmingRate / 60) * simSeconds, TEMPERATURE_MAX)
    const shown = (t: number) => Math.round(t * 10)
    const changed = shown(temperature) !== shown(s.temperature)
    this.settings = { ...s, temperature, warming: temperature < TEMPERATURE_MAX }
    // the UI shows tenths of a degree; only re-render when that changes
    if (changed || !this.settings.warming) this.emit()
  }

  private lifeStats() {
    if (!this.settings.life) return null
    return { ...this.life.stats(), selected: this.life.reportOf(this.selectedTown) }
  }

  /** CO₂ in the air (ppm): it doubles for every 3 °C the peoples' industry warmed the planet. */
  private get co2() {
    return 280 * 2 ** (this.civWarming / 3)
  }

  /**
   * Keeps the world's record for the charts (a line per simulated year), each people's
   * eras and the great moments of the chronicle for the history book.
   */
  private keepRecord(life: Stats['life']) {
    const s = this.settings
    const year = Math.floor(this.simTime / YEAR)
    const last = this.record[this.record.length - 1]
    if (!last || last.year !== year) {
      // a rewind takes the years after it back
      const kept = this.record.filter((r) => r.year < year)
      const sea = s.ocean ? (this.seaLevel - this.tide - climateOf({ temperature: 0, seaLevel: s.seaLevel }).seaLevel) * METERS_PER_HEIGHT : 0
      this.record = [
        ...kept,
        {
          year,
          temperature: this.stats.climate?.meanTemp ?? BASE_TEMPERATURE + this.anomaly,
          co2: this.co2,
          sea,
          population: life?.people ?? 0,
        },
      ].slice(-RECORD_YEARS)
    }
    if (!life) return
    let eraLog = this.eraLog
    for (const c of life.civs) {
      const log = eraLog[c.id] ?? []
      if (!log.length || log[log.length - 1][1] !== c.eraIndex) eraLog = { ...eraLog, [c.id]: [...log, [life.year, c.eraIndex]] }
    }
    this.eraLog = eraLog
    const fresh = this.life.chronicleEvents.filter((e) => e.major && e.time > this.lastAnnal)
    if (fresh.length) {
      this.lastAnnal = Math.max(...fresh.map((e) => e.time))
      this.annals = [...fresh.reverse(), ...this.annals].slice(0, MAX_ANNALS)
    }
  }

  private updateStats(now: number) {
    const elapsed = now - this.statStart
    if (elapsed < 500) return
    this.updateSeason()
    const frameMs = elapsed / this.statFrames
    const life = this.lifeStats()
    this.keepRecord(life)
    this.stats = {
      ...this.stats,
      record: this.record,
      co2: this.co2,
      eraLog: this.eraLog,
      annals: this.annals,
      fps: (this.statFrames * 1000) / elapsed,
      frameMs,
      simStepsPerSec: (this.statSteps * 1000) / elapsed,
      resolution: this.sim.size,
      dust: this.dust,
      life,
      powers: this.powers.report(),
      rewindSeconds: this.rewindReach(),
      tide: this.tide,
      timeline: this.timeline(),
    }
    this.statFrames = 0
    this.statSteps = 0
    this.statStart = now

    // frames the limiter spaced out on purpose are not slow frames
    const load = frameMs - Math.max(0, this.frameInterval() - BASE_FRAME_MS)
    if (this.focused) {
      this.adaptResolution(load)
      this.adaptQuality(load)
    }
    // a resolution change refused while busy (sliding the window, saving) happens now
    if (!this.busy && this.sim.size !== this.resolution) void this.changeResolution(this.resolution)
    this.emit()
  }

  /**
   * Dynamic resolution: draws fewer pixels while frames are slow (under ~30 fps) and
   * more again once they are comfortably fast, within the quality level's range.
   */
  private adaptResolution(frameMs: number) {
    const p = this.profile
    const scale = frameMs > 36 ? this.renderScale * 0.85 : frameMs < 22 ? this.renderScale * 1.1 : this.renderScale
    this.renderScale = clamp(scale, p.minRenderScale, p.renderScale)
  }

  /**
   * Automatic quality: one level down when frames stay slow for ~2 s with the render
   * scale already at its floor (straight to low when very slow), after giving the
   * previous change a few seconds to settle.
   */
  private adaptQuality(frameMs: number) {
    if (this.settings.quality !== 'auto' || this.level === 'low' || this.busy) return
    if (this.time - this.qualitySince < 3) return
    // dynamic resolution goes first; only when it is at its floor does the level drop
    const floor = this.renderScale <= this.profile.minRenderScale + 1e-6
    this.slowWindows = frameMs > 40 && floor ? this.slowWindows + 1 : 0
    if (this.slowWindows < 4) return
    const next = frameMs > 80 ? 'low' : QUALITY_ORDER[QUALITY_ORDER.indexOf(this.level) + 1]
    this.applyQuality(next)
    this.notice(
      `Qualidade automática reduzida para ${next === 'low' ? 'baixa' : 'média'} porque os quadros estavam lentos.`,
    )
  }
}

// Same thresholds as biome() in the render shader.
function biomeIndex(t: number, rain: number) {
  if (t < -2) return 0
  if (t < 3) return rain > 0.3 ? 1 : 2
  if (t < 9) return rain > 0.5 ? 3 : 4
  if (t < 20) return rain < 0.3 ? 6 : rain > 0.8 ? 5 : 4
  return rain < 0.3 ? 6 : rain > 1 ? 8 : 7
}

/** climate: cells × (offset, humidity, rain, temperature); then the wind grid (vx, vy, pressure, weather). */
/** The state as read back for the analysis (and the life): per-cell climate, water, extra and lava. */
export interface Field {
  size: number
  /** Window origin in the world (cells) when it was read. */
  origin: [number, number]
  climate: Float32Array
  water: Float32Array
  extra: Float32Array
  lava: Float32Array
  /** Per cell: surface height, rock, soil, sand. */
  ground: Float32Array
}

function summarizeClimate(field: Field, w: Float32Array, flowSize: number, extent: number): ClimateReport {
  const data = field.climate
  const cells = field.size * field.size
  let t = 0
  let tMin = Infinity
  let tMax = -Infinity
  let rain = 0
  let humidity = 0
  let wet = 0
  let icy = 0
  let molten = 0
  let plants = 0
  const biomes = new Array(9).fill(0)
  for (let i = 0; i < cells; i++) {
    const temp = data[i * 4 + 3]
    t += temp
    tMin = Math.min(tMin, temp)
    tMax = Math.max(tMax, temp)
    rain += data[i * 4 + 2]
    humidity += data[i * 4 + 1]
    biomes[biomeIndex(temp, data[i * 4 + 2])]++
    if (field.water[i * 4] > 0.001) wet++
    if (field.extra[i * 4 + 3] > 0.0005) icy++
    if (field.lava[i * 4] > 0.0002) molten++
    plants += field.extra[i * 4]
  }
  const n = flowSize
  let vx = 0
  let vy = 0
  for (let i = 0; i < n * n; i++) {
    vx += w[i * 4]
    vy += w[i * 4 + 1]
  }
  vx /= n * n
  vy /= n * n
  // weather systems: pronounced local extremes of the weather pressure
  let lows = 0
  let highs = 0
  const r = Math.max(2, Math.round(n / 16))
  const at = (x: number, y: number) => w[(y * n + x) * 4 + 3]
  for (let y = r; y < n - r; y += 2) {
    for (let x = r; x < n - r; x += 2) {
      const p = at(x, y)
      if (Math.abs(p) < 0.25) continue
      let extreme = true
      for (let dy = -r; dy <= r && extreme; dy += 2) {
        for (let dx = -r; dx <= r; dx += 2) {
          if ((dx || dy) && (p < 0 ? at(x + dx, y + dy) <= p : at(x + dx, y + dy) >= p)) {
            extreme = false
            break
          }
        }
      }
      if (extreme) {
        if (p < 0) lows++
        else highs++
      }
    }
  }
  // wind cells per step → cells per step at 512² (the slider's units)
  const speed = (Math.hypot(vx, vy) / n) * 512 * extent
  return {
    meanTemp: t / cells,
    minTemp: tMin,
    maxTemp: tMax,
    rain: rain / cells,
    humidity: humidity / cells,
    biomes: biomes.map((b) => b / cells),
    windDirection: ((Math.atan2(vy, vx) * 180) / Math.PI + 360) % 360,
    windSpeed: speed,
    waterShare: wet / cells,
    iceShare: icy / cells,
    lavaShare: molten / cells,
    vegetation: plants / cells,
    lows,
    highs,
  }
}
