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
  BRUSH_MAX,
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
  type AreaSetting,
  type Probe,
  type Settings,
  type Stats,
  type Tool,
} from './settings'
import { scenarioById, type ScenarioId } from './scenarios'
import { FAR_GRID, FAR_TEXELS_PER_WINDOW } from './shaders/sim'
import { Simulation, type Brush, type Climate, type SimState } from './simulation'
import { skyAt } from './sky'
import { TILES, WorldStore } from './world'

const STEP = 1 / 60 // the original simulated one step per frame at 60 fps
const UNDO_BUDGET_BYTES = 256 * 1024 * 1024
const MAX_UNDO = 30

export type WebGPUFailure = 'no-api' | 'no-adapter' | 'timeout'

export class WebGPUUnavailableError extends Error {
  readonly reason: WebGPUFailure
  constructor(reason: WebGPUFailure) {
    super(
      reason === 'no-api'
        ? 'Este navegador não expõe WebGPU.'
        : reason === 'no-adapter'
          ? 'Nenhum adaptador WebGPU disponível.'
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

  // stats accumulation
  private statFrames = 0
  private statSteps = 0
  private statStart = 0
  private slowWindows = 0
  /** Engine time of the last quality change; automatic quality waits for frames to settle. */
  private qualitySince = 0
  /** Dynamic resolution: the render scale in effect, between the profile's minimum and its scale. */
  private renderScale = 1

  static async create(canvas: HTMLCanvasElement, signal: AbortSignal): Promise<Engine> {
    if (!navigator.gpu) throw new WebGPUUnavailableError('no-api')
    let adapter: GPUAdapter | null = null
    let hardwareFailure: WebGPUFailure = 'no-adapter'
    try {
      adapter = await withTimeout(navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }), 8000)
    } catch (err) {
      if (!(err instanceof WebGPUUnavailableError)) throw err
      hardwareFailure = err.reason
    }
    // No usable GPU: fall back to the browser's software adapter (slow, but it runs).
    adapter ??= await withTimeout(navigator.gpu.requestAdapter({ forceFallbackAdapter: true }), 8000).catch(() => null)
    if (!adapter) throw new WebGPUUnavailableError(hardwareFailure)
    const device = await withTimeout(adapter.requestDevice(), 10000)
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
        this.set({ brushSize: clamp(this.settings.brushSize * 1.15 ** steps, BRUSH_MIN, BRUSH_MAX) }),
      undo: () => this.undo(),
      togglePause: () => this.set({ paused: !this.settings.paused }),
      toggleCamera: () => this.set({ cameraMode: this.settings.cameraMode === 'orbit' ? 'fly' : 'orbit' }),
      resetCamera: () => this.camera.reset(),
      focus: () => {
        const point = this.hitWorld()
        if (point) this.camera.focus(point)
      },
      selectTool: (tool: Tool) => this.set({ tool }),
      toggleMode: () => this.set({ mode: this.settings.mode === 'add' ? 'remove' : 'add' }),
      toggleHelp: () => this.set({ showHelp: !this.settings.showHelp }),
      closeHelp: () => {
        if (this.settings.showHelp) this.set({ showHelp: false })
        else if (this.settings.photoMode) this.set({ photoMode: false })
        // otherwise Escape puts the tool down: back to inspecting
        else if (this.settings.tool !== 'inspect') this.set({ tool: 'inspect' })
      },
      togglePhoto: () => this.set({ photoMode: !this.settings.photoMode }),
      paintOnClick: () => this.settings.paintOnClick,
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

  private get resolution(): number {
    if (this.settings.resolution !== 'auto') return this.settings.resolution
    // a bigger area gets more cells, keeping the detail per world unit (up to 1024²)
    return Math.min(1024, Math.round((QUALITY[this.level].autoResolution * this.settings.area) / 64) * 64)
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
    this.lastTime = performance.now()
    this.statStart = this.lastTime
    const loop = (now: number) => {
      if (this.disposed) return
      this.raf = requestAnimationFrame(loop)
      this.tick(now)
    }
    this.raf = requestAnimationFrame(loop)
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
      area: s.area,
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
      const { state, seed, origin, regions, area, shape } = await decodeTerrain(file)
      if (area !== this.extent) this.clearUndo()
      // the area and shape the file was made with, without regenerating
      this.settings = {
        ...this.settings,
        area: [1, 1.5, 2].includes(area) ? (area as AreaSetting) : 1,
        terrainShape: shape,
      }
      await this.replaceState(state)
      this.world = new WorldStore(state.size / TILES)
      for (const [tx, ty, data] of regions) this.world.set(tx, ty, data)
      this.moveOrigin(origin)
      this.settings = { ...this.settings, seed: Math.round(seed) || this.settings.seed }
      if (state.size !== this.resolution)
        this.settings = { ...this.settings, resolution: state.size as 256 | 512 | 1024 }
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
    this.disposed = true
    cancelAnimationFrame(this.raf)
    this.input?.dispose()
    this.clearUndo()
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
        tectonic: d[23],
        windDirection: ((Math.atan2(vy, vx) * 180) / Math.PI + 360) % 360,
        windSpeed: (Math.hypot(vx, vy) / sim.flowSize) * 512 * this.extent,
        pressure: d[27],
        biome: biomeIndex(d[15], d[14]),
      }
      this.emit()
    } catch {
      // device lost or the simulation replaced mid-read: the next probe will do
    } finally {
      staging.destroy()
      this.probing = false
    }
  }

  // ---- infinite world ----------------------------------------------------------------

  private moveOrigin(origin: [number, number]) {
    this.origin = origin
    this.needsFar = true
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

  private brushFor(painting: boolean): Brush {
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
      uplift: s.tool === 'uplift' ? amount : 0,
    }
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
    return s.autoClimate ? seasonOf(this.simTime / (s.dayLength * 60 * DAYS_PER_YEAR)).anomaly : s.temperature
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
      seaLevel: climateOf({ temperature: auto ? 0 : s.temperature, seaLevel: s.seaLevel }).seaLevel,
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
        size: climateBytes + windBytes,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
      })
      const enc = this.device.createCommandEncoder({ label: 'climate analysis' })
      enc.copyBufferToBuffer(sim.climate, 0, staging, 0, climateBytes)
      enc.copyBufferToBuffer(sim.wind, 0, staging, climateBytes, windBytes)
      this.device.queue.submit([enc.finish()])
      await staging.mapAsync(GPUMapMode.READ)
      const data = new Float32Array(staging.getMappedRange().slice(0))
      staging.unmap()
      staging.destroy()
      if (sim !== this.sim) return
      const wind = data.subarray(sim.cells * 4)
      let sum = 0
      for (let i = 3; i < wind.length; i += 4) sum += wind[i]
      this.pressureMean = sum / (wind.length / 4)
      this.stats = { ...this.stats, climate: summarizeClimate(data, sim.cells, sim.flowSize, this.extent) }
      this.emit()
    } catch {
      // device lost or simulation replaced mid-read: try again next time
    } finally {
      this.analysing = false
    }
  }

  /** The overlay to draw: the chosen one, or the matching map while using the climate brush. */
  private overlay() {
    const s = this.settings
    if (s.overlay !== 'none') return s.overlay
    if (s.tool === 'pressure') return 'pressure'
    return s.tool === 'heat' ? 'temperature' : s.tool === 'humidity' ? 'humidity' : 'none'
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
    const painting = this.input.painting && this.hit !== null && !this.busy && !inspecting
    const enc = this.device.createCommandEncoder({ label: 'simulation' })

    if (painting && !this.wasPainting) {
      this.pushUndo(enc)
      if (this.hit) this.levelHeight = this.hit[2]
    }
    this.wasPainting = painting

    const sky = skyAt(s.timeOfDay)
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
        climate: this.climate(),
        brush: this.brushFor(painting),
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
      full = true
      // a new terrain: the regions visited before belong to the old one
      this.world.clear()
      this.stats = { ...this.stats, storedRegions: 0 }
      this.needsFar = true
    }
    const vents = full ? this.pendingVents : 0
    if (full) this.pendingVents = 0
    if (this.needsFar && s.infiniteWorld && !this.busy) this.refreshFar()

    let steps = 0
    if (!s.paused && !this.busy) {
      this.accumulator += dt * s.speed
      // when frames are already slow, run fewer steps (the simulation slows down)
      // instead of spiralling into ever longer frames
      const max = this.profile.maxStepsPerFrame
      const cap = Math.min(dt > 1 / 30 ? 1 : dt > 1 / 50 ? 2 : max, max)
      steps = Math.min(Math.floor(this.accumulator / STEP), cap)
      this.accumulator = Math.min(this.accumulator - steps * STEP, STEP * 2)
      for (let k = 0; k < steps; k++) this.sim.encodeStep(enc, painting)
    } else if (painting && !this.busy) {
      this.accumulator += dt
      const paints = Math.min(Math.floor(this.accumulator / STEP), this.profile.maxStepsPerFrame)
      this.accumulator -= paints * STEP
      for (let k = 0; k < paints; k++) this.sim.encodePaint(enc)
    }
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
    this.renderer.render(
      view,
      {
        uv: this.hit ? [this.hit[0], this.hit[1]] : [0, 0],
        radius: s.brushSize / e,
        visible: this.hit !== null && !clean && !inspecting,
      },
      this.time,
      {
        overlay: this.overlay(),
        arrows: s.windArrows && !clean,
        clouds: s.clouds,
        sky,
        cloudDrift: this.cloudDrift,
        simTime: this.simTime,
        origin: this.originUnits,
        horizon: s.infiniteWorld,
        extent: e,
        seed: s.seed,
        farClimate: {
          seaLevel: s.ocean
            ? climateOf({ temperature: s.autoClimate ? 0 : s.temperature, seaLevel: s.seaLevel }).seaLevel
            : null,
          baseTemperature: BASE_TEMPERATURE + this.anomaly,
          lapseRate: LAPSE_RATE,
          latitude: s.latitude,
        },
      },
    )
    if (this.shot) {
      // the canvas still holds this frame until the task ends; the next frame resizes it back
      const { done } = this.shot
      this.shot = null
      this.canvas.toBlob(done, 'image/png')
    }
    this.advanceTime(steps * STEP)
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

  /** Moves simulated time on: clouds drift with the wind, the day turns. */
  private advanceTime(simSeconds: number) {
    if (simSeconds <= 0) return
    this.simTime += simSeconds
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

  /** Continuous warming, in simulated time; stops at the top of the scale. */
  private updateSeason() {
    const s = this.settings
    if (!s.autoClimate) {
      if (this.stats.season) this.stats = { ...this.stats, season: null }
      return
    }
    const { anomaly, season } = seasonOf(this.simTime / (s.dayLength * 60 * DAYS_PER_YEAR))
    const prev = this.stats.season
    if (!prev || prev.name !== season || Math.round(prev.anomaly * 10) !== Math.round(anomaly * 10)) {
      this.stats = { ...this.stats, season: { name: season, anomaly } }
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

  private updateStats(now: number) {
    const elapsed = now - this.statStart
    if (elapsed < 500) return
    this.updateSeason()
    const frameMs = elapsed / this.statFrames
    this.stats = {
      ...this.stats,
      fps: (this.statFrames * 1000) / elapsed,
      frameMs,
      simStepsPerSec: (this.statSteps * 1000) / elapsed,
      resolution: this.sim.size,
    }
    this.statFrames = 0
    this.statSteps = 0
    this.statStart = now

    this.adaptResolution(frameMs)
    this.adaptQuality(frameMs)
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
function summarizeClimate(data: Float32Array, cells: number, flowSize: number, extent: number): ClimateReport {
  let t = 0
  let tMin = Infinity
  let tMax = -Infinity
  let rain = 0
  let humidity = 0
  const biomes = new Array(9).fill(0)
  for (let i = 0; i < cells; i++) {
    const temp = data[i * 4 + 3]
    t += temp
    tMin = Math.min(tMin, temp)
    tMax = Math.max(tMax, temp)
    rain += data[i * 4 + 2]
    humidity += data[i * 4 + 1]
    biomes[biomeIndex(temp, data[i * 4 + 2])]++
  }
  const w = data.subarray(cells * 4)
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
    lows,
    highs,
  }
}
