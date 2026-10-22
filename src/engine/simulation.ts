import type { TerrainShape } from './settings'
import {
  ACTIVITY_TILE,
  activityGrowShader,
  activityShader,
  FAR_GRID,
  SIM_UNIFORM_SIZE,
  farShader,
  shiftShader,
  airShader,
  erodeShader,
  flowsShader,
  generateShader,
  lavaShader,
  normalsShader,
  occlusionShader,
  changeShader,
  paintShader,
  pickShader,
  sedimentShader,
  settleShader,
  shadowShader,
  waterCycleShader,
  waterDiffuseXShader,
  waterDiffuseYShader,
  waterFlowShader,
  waterMomentumShader,
  waterNormalsShader,
  windForceShader,
  windPressureShader,
  windProjectShader,
  WATER_FLOW_TILE,
} from './shaders/sim'

export interface Brush {
  active: boolean
  uv: [number, number]
  radius: number
  // per-material rates; negative removes
  rock: number
  soil: number
  sand: number
  water: number
  /** Leveling rate (0 when not leveling) and the height it levels towards. */
  level: number
  levelHeight: number
  /** Climate brush: local temperature and humidity change rates; negative cools / dries. */
  heat: number
  humidity: number
  /** Volcano brush: opens vents (negative plugs them). */
  volcano: number
  /** Pressure brush: raises the weather pressure (a high) or, negative, lowers it (a low). */
  pressure: number
  /** Tectonic brush: marks zones that keep rising (negative: sinking). */
  uplift: number
}

export interface Climate {
  /** Temperature at height 0 on the middle latitude, in °C (anomaly included). */
  baseTemperature: number
  /** Temperature anomaly in °C. */
  temperature: number
  seaLevel: number
  ocean: boolean
  /** Temperature difference between the south (v = 0) and north (v = 1) edges, in °C. */
  latitude: number
  /** °C lost per unit of height. */
  lapseRate: number
  /** Wind in terrain units (uv) per step. */
  wind: [number, number]
  /** Relative humidity of the air blowing in across the border, 0–1. */
  windHumidity: number
  /** Multiplier on how much water the condensed vapour rains out. */
  rainAmount: number
  /** Strength of the weather highs and lows, 0 = off. */
  pressureSystems: number
  /** The simulation decides: belt winds, seasons, painted climate ignored. */
  automatic: boolean
  /** Mean weather pressure over the window, taken out again so highs and lows stay balanced. */
  pressureMean: number
}

export interface Light {
  /** Direction towards the light that casts shadows: the sun by day, the moon by night. */
  dir: [number, number, number]
  /** 0 at night, 1 in daylight. */
  daylight: number
}

export interface SimParams {
  rain: boolean
  evaporate: boolean
  erode: boolean
  vegetation: boolean
  time: number
  /** Simulated seconds (drives eruptions and the drifting weather). */
  simTime: number
  seed: number
  light: Light
  climate: Climate
  brush: Brush
  /** Ray in window-local coordinates (the window spans x, z ∈ [−0.5, 0.5]). */
  ray: { origin: [number, number, number]; dir: [number, number, number] } | null
  /** Where the window sits in the infinite world, in cells. */
  origin: [number, number]
  shape: TerrainShape
  /** Simulated area: the window's width in world units. */
  extent: number
  /** Geological time: multiplies erosion, weathering and tectonic uplift. */
  geologicTime: number
}

/** The persistent simulation state, as plain arrays (for files, undo and resampling). */
export interface SimState {
  size: number
  ground: Float32Array
  water: Float32Array
  waterLast: Float32Array
  extra: Float32Array
  climate: Float32Array
  air: Float32Array
  lava: Float32Array
}

const WG = 8
/** Occlusion and shadows can refresh 1/n of the rows per frame (see derivedSlices). */
const DERIVED_SLICES = [4, 16] as const
export const STATE_KEYS = ['ground', 'water', 'waterLast', 'extra', 'climate', 'air', 'lava'] as const
export type StateKey = (typeof STATE_KEYS)[number]

const WORLD_OFFSET = 208 // byte offsets of Sim.world and Sim.rect in the uniform
const RECT_OFFSET = 224
const SHAPE_OFFSET = 240
const GEO_OFFSET = 256

export class Simulation {
  readonly size: number
  readonly flowSize: number
  readonly cells: number
  /** Occlusion and shadows refresh 1/derivedSlices of the rows per frame; more is cheaper but lags. */
  derivedSlices: (typeof DERIVED_SLICES)[number] = 4
  /** Multirate: the atmosphere (air pass) runs once every climateEvery steps, scaled to cover them. */
  climateEvery = 1
  /**
   * Runs the water flow as three plain passes instead of the fused workgroup-memory
   * kernel; much faster when the GPU is emulated on the CPU, slower on real GPUs.
   */
  splitFlow = false
  private steps = 0

  readonly ground: GPUBuffer
  readonly water: GPUBuffer
  readonly waterLast: GPUBuffer
  readonly extra: GPUBuffer
  readonly climate: GPUBuffer
  readonly air: GPUBuffer
  /** Wind field at flowSize² (see windForceShader). */
  readonly wind: GPUBuffer
  readonly lava: GPUBuffer
  /** Heights of the distant terrain around the window (FAR_GRID², 32 texels per window). */
  readonly far: GPUBuffer
  readonly normals: GPUBuffer
  readonly wnormals: GPUBuffer
  readonly shadow: GPUBuffer
  readonly flows: GPUBuffer
  /** The reference terrain the Change map compares against. */
  private readonly baseline: GPUBuffer
  /** Silt and clay carried by the water (the sand rides in water.w), and its ping-pong copy. */
  readonly fine: GPUBuffer
  private readonly fineTmp: GPUBuffer
  private readonly groundTmp: GPUBuffer
  private readonly waterTmp: GPUBuffer
  private readonly extraTmp: GPUBuffer
  private readonly airTmp: GPUBuffer
  private readonly windTmp: GPUBuffer
  private readonly lavaTmp: GPUBuffer
  /** Sparse simulation: per-tile water/lava marks, raw and grown by one tile. */
  private readonly tilesRaw: GPUBuffer
  private readonly tiles: GPUBuffer
  private readonly tilesPerRow: number
  private readonly pickResult: GPUBuffer
  private readonly pickStaging: GPUBuffer[]
  private pickBusy: boolean[] = [false, false]
  private readonly uniform: GPUBuffer
  private readonly uniformData = new ArrayBuffer(SIM_UNIFORM_SIZE)

  private readonly passes: Record<string, { pipeline: GPUComputePipeline; bindGroup: GPUBindGroup }> = {}
  /** Shift uniforms for the full-resolution and the wind grid. */
  private readonly shiftParams: GPUBuffer[]
  private readonly shiftGroups: { bindGroup: GPUBindGroup; scratch: GPUBuffer; target: GPUBuffer; low: boolean }[] = []
  private shiftPipeline!: GPUComputePipeline
  private readonly device: GPUDevice

  constructor(device: GPUDevice, size: number) {
    this.device = device
    this.size = size
    this.flowSize = size / 4
    this.cells = size * size

    const storage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
    const vec4Buffer = (label: string) => device.createBuffer({ label, size: this.cells * 16, usage: storage })

    this.ground = vec4Buffer('ground')
    this.groundTmp = vec4Buffer('groundTmp')
    this.water = vec4Buffer('water')
    this.waterTmp = vec4Buffer('waterTmp')
    this.waterLast = vec4Buffer('waterLast')
    this.extra = vec4Buffer('extra')
    this.extraTmp = vec4Buffer('extraTmp')
    this.climate = vec4Buffer('climate')
    this.air = vec4Buffer('air')
    this.airTmp = vec4Buffer('airTmp')
    this.lava = vec4Buffer('lava')
    this.lavaTmp = vec4Buffer('lavaTmp')
    this.far = device.createBuffer({ label: 'far', size: FAR_GRID * FAR_GRID * 4, usage: storage })
    this.shiftParams = [this.size, this.flowSize].map((n) => {
      const buffer = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
      device.queue.writeBuffer(buffer, 0, new Uint32Array([n, 0, 0, 0]))
      return buffer
    })
    const windBuffer = (label: string) =>
      device.createBuffer({ label, size: this.flowSize * this.flowSize * 16, usage: storage })
    this.wind = windBuffer('wind')
    this.windTmp = windBuffer('windTmp')
    this.normals = vec4Buffer('normals')
    this.wnormals = vec4Buffer('waterNormals')
    // x terrain shadow, y water shadow, z height change since the reference terrain
    this.shadow = vec4Buffer('shadow')
    this.baseline = vec4Buffer('baseline')
    this.flows = device.createBuffer({ label: 'flows', size: this.flowSize * this.flowSize * 8, usage: storage })
    this.fine = device.createBuffer({ label: 'fine', size: this.cells * 4, usage: storage })
    this.fineTmp = device.createBuffer({ label: 'fineTmp', size: this.cells * 4, usage: storage })
    this.tilesPerRow = Math.ceil(size / ACTIVITY_TILE)
    const tileBuffer = (label: string) =>
      device.createBuffer({ label, size: this.tilesPerRow * this.tilesPerRow * 4, usage: storage })
    this.tilesRaw = tileBuffer('activityRaw')
    this.tiles = tileBuffer('activity')
    this.pickResult = device.createBuffer({ label: 'pick', size: 16, usage: storage })
    this.pickStaging = [0, 1].map(() =>
      device.createBuffer({ size: 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }),
    )
    this.uniform = device.createBuffer({
      label: 'simParams',
      size: SIM_UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })

    const add = (name: string, code: string, buffers: GPUBuffer[], constants?: Record<string, number>) => {
      const pipeline = device.createComputePipeline({
        label: name,
        layout: 'auto',
        compute: { module: device.createShaderModule({ label: name, code }), entryPoint: 'main', constants },
      })
      const bindGroup = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [this.uniform, ...buffers].map((buffer, binding) => ({ binding, resource: { buffer } })),
      })
      this.passes[name] = { pipeline, bindGroup }
    }

    add('generate', generateShader, [this.ground, this.extra, this.air, this.climate])
    add('activity', activityShader, [this.water, this.lava, this.tilesRaw, this.fine])
    add('activityGrow', activityGrowShader, [this.tilesRaw, this.tiles])
    add('flow', waterFlowShader, [this.ground, this.water, this.waterLast, this.waterTmp, this.tiles])
    // split flow: groundTmp and extraTmp are free until the erode pass, so they hold the intermediates
    add('diffuseY', waterDiffuseYShader, [this.ground, this.tiles, this.water, this.groundTmp])
    add('diffuseX', waterDiffuseXShader, [this.ground, this.tiles, this.groundTmp, this.extraTmp])
    add('momentum', waterMomentumShader, [this.ground, this.tiles, this.extraTmp, this.waterLast, this.waterTmp])
    add('windForce', windForceShader, [this.ground, this.wind, this.windTmp, this.water, this.air, this.climate])
    add('windPressureA', windPressureShader, [this.windTmp, this.wind])
    add('windPressureB', windPressureShader, [this.wind, this.windTmp])
    add('windProject', windProjectShader, [this.windTmp, this.wind])
    add('air', airShader, [
      this.ground,
      this.water,
      this.extra,
      this.air,
      this.airTmp,
      this.climate,
      this.wind,
      this.shadow,
    ])
    add('cycle', waterCycleShader, [
      this.waterTmp,
      this.water,
      this.ground,
      this.extra,
      this.airTmp,
      this.air,
      this.climate,
      this.lava,
    ])
    add('flows', flowsShader, [this.water, this.flows])
    add('lava', lavaShader, [this.ground, this.water, this.lava, this.lavaTmp, this.tiles])
    add('sediment', sedimentShader, [
      this.ground,
      this.water,
      this.extra,
      this.groundTmp,
      this.waterTmp,
      this.tiles,
      this.fine,
      this.fineTmp,
    ])
    add('erode', erodeShader, [
      this.ground,
      this.water,
      this.extra,
      this.groundTmp,
      this.extraTmp,
      this.climate,
      this.lava,
      this.tiles,
    ])
    add('settle', settleShader, [
      this.groundTmp,
      this.water,
      this.extraTmp,
      this.ground,
      this.extra,
      this.climate,
      this.wind,
      this.lava,
    ])
    add('paint', paintShader, [this.ground, this.extra, this.water, this.climate, this.air, this.lava])
    add('normals', normalsShader, [this.ground, this.normals])
    add('waterNormals', waterNormalsShader, [this.ground, this.water, this.wnormals])
    const shadowBuffers = [this.ground, this.water, this.normals, this.wnormals, this.shadow]
    add('occlusion', occlusionShader, [this.ground, this.normals])
    add('shadow', shadowShader, shadowBuffers)
    for (const SLICES of DERIVED_SLICES) {
      add(`occlusionSlice${SLICES}`, occlusionShader, [this.ground, this.normals], { SLICES })
      add(`shadowSlice${SLICES}`, shadowShader, shadowBuffers, { SLICES })
    }
    add('pick', pickShader, [this.ground, this.water, this.pickResult])
    add('far', farShader, [this.far])
    add('change', changeShader, [this.ground, this.baseline, this.shadow])

    this.shiftPipeline = device.createComputePipeline({
      label: 'shift',
      layout: 'auto',
      compute: { module: device.createShaderModule({ label: 'shift', code: shiftShader }), entryPoint: 'main' },
    })
    const shifted = (target: GPUBuffer, scratch: GPUBuffer, low: boolean) =>
      this.shiftGroups.push({
        target,
        scratch,
        low,
        bindGroup: device.createBindGroup({
          layout: this.shiftPipeline.getBindGroupLayout(0),
          entries: [this.shiftParams[low ? 1 : 0], target, scratch].map((buffer, binding) => ({
            binding,
            resource: { buffer },
          })),
        }),
      })
    for (const key of STATE_KEYS) shifted(this[key], this.groundTmp, false)
    shifted(this.wind, this.windTmp, true)
  }

  writeParams(p: SimParams, frame: number) {
    const u32 = new Uint32Array(this.uniformData)
    const f32 = new Float32Array(this.uniformData)
    u32[0] = this.size
    u32[1] = this.flowSize
    u32[2] = frame
    f32[4] = p.rain ? 1 : 0
    f32[5] = p.evaporate ? 1 : 0
    // erosion runs faster in geological time (weathering and transport scale with this)
    f32[6] = p.erode ? p.geologicTime : 0
    f32[7] = p.vegetation ? 1 : 0
    f32[8] = p.brush.uv[0]
    f32[9] = p.brush.uv[1]
    f32[10] = p.brush.radius
    f32[11] = p.brush.active ? 1 : 0
    f32[12] = p.brush.rock
    f32[13] = p.brush.soil
    f32[14] = p.brush.sand
    f32[15] = p.brush.water
    f32[16] = p.time
    f32[17] = p.seed
    const light = p.light.dir
    f32[18] = light[1] / Math.hypot(light[0], light[2])
    f32[19] = this.climateEvery
    f32.set([...light, 0], 20)
    if (p.ray) {
      f32.set([...p.ray.origin, 1], 24)
      f32.set([...p.ray.dir, 0], 28)
    }
    const c = p.climate
    f32.set([c.baseTemperature, c.temperature, c.seaLevel, c.ocean ? 1 : 0], 32)
    f32.set([p.brush.level, p.brush.levelHeight, p.brush.pressure, c.pressureMean], 36)
    f32.set([c.wind[0], c.wind[1], c.windHumidity, c.rainAmount], 40)
    f32.set([c.latitude, c.lapseRate, p.brush.heat, p.brush.humidity], 44)
    f32.set([p.simTime, c.pressureSystems, p.light.daylight, p.brush.volcano], 48)
    f32.set([p.origin[0], p.origin[1], c.automatic ? 1 : 0, p.extent], WORLD_OFFSET / 4)
    f32.set([0, 0, this.size, this.size], RECT_OFFSET / 4)
    f32.set([p.shape.continents, p.shape.offset, p.shape.relief, p.shape.continentScale], SHAPE_OFFSET / 4)
    f32.set([p.geologicTime, p.brush.uplift, 0, 0], GEO_OFFSET / 4)
    this.device.queue.writeBuffer(this.uniform, 0, this.uniformData)
  }

  private dispatch(pass: GPUComputePassEncoder, name: string, size = this.size, rows = size, wg = WG) {
    const { pipeline, bindGroup } = this.passes[name]
    pass.setPipeline(pipeline)
    pass.setBindGroup(0, bindGroup)
    pass.dispatchWorkgroups(Math.ceil(size / wg), Math.ceil(rows / wg))
  }

  /**
   * New fractal terrain for the seed in the params; clears water, plants, flows and the
   * painted climate, snows the peaks and fills the air with the incoming humidity.
   */
  encodeGenerate(enc: GPUCommandEncoder) {
    for (const buffer of [
      this.water,
      this.waterTmp,
      this.waterLast,
      this.extra,
      this.extraTmp,
      this.airTmp,
      this.wind,
      this.windTmp,
      this.lava,
      this.lavaTmp,
      this.flows,
      this.fine,
      this.fineTmp,
    ]) {
      enc.clearBuffer(buffer)
    }
    const pass = enc.beginComputePass()
    this.dispatch(pass, 'generate')
    pass.end()
    this.encodeResetBaseline(enc)
    this.encodeDerived(enc, true)
  }

  /** Moves the window origin right away (before generating newly uncovered regions). */
  writeOrigin(origin: [number, number]) {
    this.device.queue.writeBuffer(this.uniform, WORLD_OFFSET, new Float32Array([origin[0], origin[1]]))
  }

  /**
   * Generates fresh terrain, from the world noise, in a rectangle of window cells
   * (x0, y0, x1, y1); submits right away, since the rectangle lives in the uniform.
   */
  generateRect(rect: [number, number, number, number]) {
    this.device.queue.writeBuffer(this.uniform, RECT_OFFSET, new Float32Array(rect))
    const enc = this.device.createCommandEncoder({ label: 'generate region' })
    const pass = enc.beginComputePass()
    this.dispatch(pass, 'generate')
    pass.end()
    this.device.queue.submit([enc.finish()])
    this.device.queue.writeBuffer(this.uniform, RECT_OFFSET, new Float32Array([0, 0, this.size, this.size]))
  }

  /** Slides every persistent buffer by (dx, dy) cells; dx, dy must be multiples of 4 (the wind grid). */
  encodeShift(enc: GPUCommandEncoder, dx: number, dy: number) {
    const q = this.device.queue
    q.writeBuffer(this.shiftParams[0], 8, new Int32Array([dx, dy]))
    q.writeBuffer(this.shiftParams[1], 8, new Int32Array([dx / 4, dy / 4]))
    for (const { bindGroup, scratch, target, low } of this.shiftGroups) {
      const n = low ? this.flowSize : this.size
      const pass = enc.beginComputePass({ label: 'shift' })
      pass.setPipeline(this.shiftPipeline)
      pass.setBindGroup(0, bindGroup)
      pass.dispatchWorkgroups(Math.ceil(n / WG), Math.ceil(n / WG))
      pass.end()
      enc.copyBufferToBuffer(scratch, 0, target, 0, n * n * 16)
    }
    enc.clearBuffer(this.flows)
    enc.clearBuffer(this.fine)
    this.encodeResetBaseline(enc)
    this.encodeDerived(enc, true)
  }

  /** Recomputes the distant terrain heights around the window (uses the origin in the uniform). */
  encodeFar(enc: GPUCommandEncoder) {
    const pass = enc.beginComputePass({ label: 'far' })
    this.dispatch(pass, 'far', FAR_GRID)
    pass.end()
  }

  /** Writes one square of cells (all persistent channels) at window cell (x, y). */
  writeRegion(data: Record<StateKey, Float32Array>, cells: number, x: number, y: number) {
    const q = this.device.queue
    for (const key of STATE_KEYS) {
      const src = data[key] as Float32Array<ArrayBuffer>
      for (let r = 0; r < cells; r++) {
        q.writeBuffer(this[key], ((y + r) * this.size + x) * 16, src, r * cells * 4, cells * 4)
      }
    }
  }

  /** One fixed simulation step (the original ran exactly one per frame at 60 fps). */
  encodeStep(enc: GPUCommandEncoder, paint: boolean) {
    let pass = enc.beginComputePass({ label: 'step' })
    // sparse: mark the tiles with water or lava, then skip the rest in those passes
    this.dispatch(pass, 'activity', this.size, this.size, ACTIVITY_TILE)
    this.dispatch(pass, 'activityGrow', this.tilesPerRow)
    if (this.splitFlow) {
      this.dispatch(pass, 'diffuseY')
      this.dispatch(pass, 'diffuseX')
      this.dispatch(pass, 'momentum')
    } else {
      this.dispatch(pass, 'flow', this.size, this.size, WATER_FLOW_TILE)
    }
    this.dispatch(pass, 'windForce', this.flowSize)
    this.dispatch(pass, 'windPressureA', this.flowSize)
    this.dispatch(pass, 'windPressureB', this.flowSize)
    this.dispatch(pass, 'windProject', this.flowSize)
    // multirate: the slow atmosphere runs every climateEvery steps; in between the
    // water cycle keeps using its last precipitation (it reads airTmp, so copy it there)
    if (this.steps++ % this.climateEvery === 0) {
      this.dispatch(pass, 'air')
    } else {
      pass.end()
      enc.copyBufferToBuffer(this.air, 0, this.airTmp, 0, this.cells * 16)
      pass = enc.beginComputePass({ label: 'step (water cycle)' })
    }
    this.dispatch(pass, 'cycle')
    this.dispatch(pass, 'flows', this.flowSize)
    this.dispatch(pass, 'lava')
    this.dispatch(pass, 'sediment')
    pass.end()
    // the lava and sediment passes gather from their neighbours, so they write copies
    enc.copyBufferToBuffer(this.lavaTmp, 0, this.lava, 0, this.cells * 16)
    enc.copyBufferToBuffer(this.groundTmp, 0, this.ground, 0, this.cells * 16)
    enc.copyBufferToBuffer(this.waterTmp, 0, this.water, 0, this.cells * 16)
    enc.copyBufferToBuffer(this.fineTmp, 0, this.fine, 0, this.cells * 4)
    pass = enc.beginComputePass({ label: 'step (ground)' })
    this.dispatch(pass, 'erode')
    this.dispatch(pass, 'settle')
    if (paint) this.dispatch(pass, 'paint')
    pass.end()
  }

  /** Applies one step of the brush; also used on its own while the simulation is paused. */
  encodePaint(enc: GPUCommandEncoder) {
    const pass = enc.beginComputePass({ label: 'paint' })
    this.dispatch(pass, 'paint')
    pass.end()
  }

  /**
   * Normals every frame. Occlusion and shadows are the expensive ray marches: normally
   * 1/derivedSlices of their rows refresh per frame; `full` redoes everything (after a reset).
   */
  encodeDerived(enc: GPUCommandEncoder, full: boolean) {
    const pass = enc.beginComputePass({ label: 'derived' })
    this.dispatch(pass, 'normals')
    this.dispatch(pass, 'waterNormals')
    if (full) {
      this.dispatch(pass, 'occlusion')
      this.dispatch(pass, 'shadow')
    } else {
      const slices = this.derivedSlices
      const rows = Math.ceil(this.size / slices)
      this.dispatch(pass, `occlusionSlice${slices}`, this.size, rows)
      this.dispatch(pass, `shadowSlice${slices}`, this.size, rows)
    }
    this.dispatch(pass, 'change')
    pass.end()
  }

  /** The terrain as it is now becomes the Change map's reference. */
  encodeResetBaseline(enc: GPUCommandEncoder) {
    enc.copyBufferToBuffer(this.ground, 0, this.baseline, 0, this.cells * 16)
  }

  /** Queues a ray pick; returns a reader to call after submit, or null if both slots are busy. */
  encodePick(enc: GPUCommandEncoder): (() => Promise<[number, number, number] | null>) | null {
    const slot = this.pickBusy[0] ? (this.pickBusy[1] ? -1 : 1) : 0
    if (slot < 0) return null
    const pass = enc.beginComputePass({ label: 'pick' })
    const { pipeline, bindGroup } = this.passes.pick
    pass.setPipeline(pipeline)
    pass.setBindGroup(0, bindGroup)
    pass.dispatchWorkgroups(1)
    pass.end()
    const staging = this.pickStaging[slot]
    enc.copyBufferToBuffer(this.pickResult, 0, staging, 0, 16)
    this.pickBusy[slot] = true
    return async () => {
      try {
        await staging.mapAsync(GPUMapMode.READ)
        const r = new Float32Array(staging.getMappedRange().slice(0))
        staging.unmap()
        return r[3] > 0 ? [r[0], r[1], r[2]] : null
      } catch {
        return null // buffer destroyed (resolution change) while mapping
      } finally {
        this.pickBusy[slot] = false
      }
    }
  }

  // ---- state snapshots (undo) -------------------------------------------------

  get snapshotBytes() {
    return this.cells * 16 * STATE_KEYS.length
  }

  encodeSnapshot(enc: GPUCommandEncoder): GPUBuffer {
    const snap = this.device.createBuffer({
      label: 'undo',
      size: this.snapshotBytes,
      usage: GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    })
    STATE_KEYS.forEach((key, k) => enc.copyBufferToBuffer(this[key], 0, snap, k * this.cells * 16, this.cells * 16))
    return snap
  }

  encodeRestore(enc: GPUCommandEncoder, snap: GPUBuffer) {
    STATE_KEYS.forEach((key, k) => enc.copyBufferToBuffer(snap, k * this.cells * 16, this[key], 0, this.cells * 16))
    enc.clearBuffer(this.flows)
    enc.clearBuffer(this.fine)
    this.encodeResetBaseline(enc)
    this.encodeDerived(enc, true)
  }

  // ---- CPU readback / upload ----------------------------------------------------

  async readState(): Promise<SimState> {
    const enc = this.device.createCommandEncoder()
    const read = this.encodeReadState(enc)
    this.device.queue.submit([enc.finish()])
    return read()
  }

  /** Copies the state as it is at this point of the command stream; call the reader after submitting. */
  encodeReadState(enc: GPUCommandEncoder): () => Promise<SimState> {
    const bytes = this.cells * 16
    const staging = this.device.createBuffer({
      size: bytes * STATE_KEYS.length,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    })
    STATE_KEYS.forEach((key, k) => enc.copyBufferToBuffer(this[key], 0, staging, k * bytes, bytes))
    return async () => {
      await staging.mapAsync(GPUMapMode.READ)
      const all = new Float32Array(staging.getMappedRange().slice(0))
      staging.unmap()
      staging.destroy()
      const state = { size: this.size } as SimState
      STATE_KEYS.forEach((key, k) => (state[key] = all.slice((k * bytes) / 4, ((k + 1) * bytes) / 4)))
      return state
    }
  }

  writeState(state: SimState) {
    if (state.size !== this.size) throw new Error(`state is ${state.size}², simulation is ${this.size}²`)
    const q = this.device.queue
    for (const key of STATE_KEYS) q.writeBuffer(this[key], 0, state[key] as Float32Array<ArrayBuffer>)
    const enc = this.device.createCommandEncoder()
    enc.clearBuffer(this.flows)
    enc.clearBuffer(this.fine)
    this.encodeResetBaseline(enc)
    this.encodeDerived(enc, true)
    q.submit([enc.finish()])
  }

  destroy() {
    for (const b of [
      this.ground,
      this.groundTmp,
      this.water,
      this.waterTmp,
      this.waterLast,
      this.extra,
      this.extraTmp,
      this.climate,
      this.air,
      this.airTmp,
      this.wind,
      this.windTmp,
      this.lava,
      this.lavaTmp,
      this.far,
      ...this.shiftParams,
      this.normals,
      this.wnormals,
      this.shadow,
      this.flows,
      this.fine,
      this.fineTmp,
      this.baseline,
      this.pickResult,
      this.tilesRaw,
      this.tiles,
      this.uniform,
      ...this.pickStaging,
    ])
      b.destroy()
  }
}
