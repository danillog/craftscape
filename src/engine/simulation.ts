import type { TerrainShape } from './settings'
import {
  ACTIVITY_TILE,
  activityGrowShader,
  activityShader,
  FAR_GRID,
  SIM_UNIFORM_SIZE,
  farShader,
  shiftShader,
  shiftScalarShader,
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
  platesShader,
  quakeShader,
  impactShader,
  shockShader,
  ventShader,
  worksShader,
  actsShader,
  MAX_ACTS,
  driftGatherScalarShader,
  driftGatherShader,
  driftMapShader,
  driftRiftShader,
  MAX_PLATE_MOVES,
  MAX_PLATE_OVERRIDES,
  MAX_DUSTS,
  MAX_HIGHS,
  MAX_STORMS,
  sedimentShader,
  settleShader,
  shadowShader,
  waterCycleShader,
  waterDiffuseXShader,
  waterDiffuseYShader,
  waterDepthShader,
  waterFlowShader,
  waterFluxShader,
  waterMomentumShader,
  waterNormalsShader,
  upperShader,
  windForceShader,
  windPressureShader,
  windProjectShader,
  WATER_FLOW_TILE,
} from './shaders/sim'
import { MAX_WORKS, type Work } from './life'

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
  /** Air-mass brush: warms the air near the ground into a warm mass or, negative, cools it into a cold one. */
  airMass: number
  /** Fixed air-mass brush: paints a source that keeps the air warm or, negative, cold for good. */
  airSource: number
  /** Clears every fixed air-mass source in the window this frame. */
  clearAirSources: boolean
  /** Ocean-current brush: warms (or, negative, cools) the sea it paints, and the air over it. */
  current: number
  /** Forest brush: plants take where it paints (negative clears them). */
  forest: number
}

/** Something a power does to the land at a place this frame (see actsShader for each kind's numbers). */
export interface Act {
  /** Centre in window uv. */
  uv: [number, number]
  /** Radius in window uv. */
  radius: number
  kind: 'fire' | 'tsunami' | 'blast' | 'cataclysm'
  values: [number, number, number, number]
}
const ACT_KINDS: Record<Act['kind'], number> = { fire: 1, tsunami: 2, blast: 3, cataclysm: 4 }

/** A plate whose land moves this frame (continental drift): its grid cell and the shift, in cells. */
export interface PlateMove {
  cell: [number, number]
  shift: [number, number]
}

/** A meteor strike to run this frame (see impactShader). */
export interface Impact {
  uv: [number, number]
  /** Crater radius in world units. */
  radius: number
  /** Crater depth in height units. */
  depth: number
}

/** A storm (the storm tool): a deep low held open while it lives. */
export interface Storm {
  uv: [number, number]
  /** 0–1: how deep the low is held right now. */
  strength: number
  /** Radius in window uv. */
  radius: number
}

/** A dust cloud left by a strike: it shades and cools the region under it while it settles. */
/** A natural volcano waking up or going quiet this frame (see ventShader). */
export interface Vent {
  uv: [number, number]
  /** Radius in window uv. */
  radius: number
  /** Change of the vent's strength: + opens, − plugs. */
  delta: number
}

export interface Dust {
  uv: [number, number]
  /** °C kept off the ground at its centre. */
  cooling: number
  /** Radius in window uv. */
  radius: number
}

/** A fixed high (the drought power): no rain under it while it stands. */
export interface High {
  uv: [number, number]
  /** 0–1: how hard it is held. */
  strength: number
  /** Radius in window uv. */
  radius: number
}

/** A plate whose motion was changed: its grid cell (see plates.ts) and new velocity. */
export interface PlateOverride {
  cell: [number, number]
  velocity: [number, number]
  /** How far it had drifted when its motion was changed (world units), and the plate time then. */
  from: [number, number]
  at: number
}

/** An earthquake to run this frame (see quakeShader). */
export interface Quake {
  /** Epicentre in window uv. */
  uv: [number, number]
  /** Direction across the fault, in radians (world x/y). */
  normal: number
  /** Radius in world units. */
  radius: number
  /** Fault throw: positive raises the far side, negative drops a strip; 0 only shakes. */
  slip: number
  /** Rock shaken loose into rubble on steep slopes, at the epicentre. */
  rubble: number
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
  /** Plate time: how far a plate of unit speed has drifted (world units). */
  plateTime: number
  /** A meteor strike this frame. */
  impact: Impact | null
  /** The storms alive (at most MAX_STORMS are used). */
  storms: Storm[]
  /** Dust clouds from strikes (at most MAX_DUSTS are used). */
  dusts: Dust[]
  /** The fixed highs standing (at most MAX_HIGHS are used). */
  highs: High[]
  plates: PlateOverride[]
  quake: Quake | null
  vent: Vent | null
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
  /** Silt and clay in suspension, one float per cell; absent (clear water) in older files. */
  fine?: Float32Array
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
const PLATES_OFFSET = 272
const QUAKE_OFFSET = PLATES_OFFSET + MAX_PLATE_OVERRIDES * 32
const SOURCE_OFFSET = QUAKE_OFFSET + 32
const IMPACT_OFFSET = SOURCE_OFFSET + 16
const STORMS_OFFSET = IMPACT_OFFSET + 16
const DUSTS_OFFSET = STORMS_OFFSET + MAX_STORMS * 16
const HIGHS_OFFSET = DUSTS_OFFSET + MAX_DUSTS * 16
const VENT_OFFSET = HIGHS_OFFSET + MAX_HIGHS * 16

/**
 * Geological time runs the ground passes (sediment, weathering, slumping, uplift) several
 * times per step, each at a rate the slopes can still keep up with; multiplying the rates
 * alone made erosion and deposition outrun the slumping that smooths them, and spikes and
 * pits popped up everywhere.
 */
export function geologicSubsteps(geologicTime: number) {
  return Math.max(1, Math.ceil(geologicTime / 3))
}

export class Simulation {
  readonly size: number
  readonly flowSize: number
  readonly cells: number
  /** Occlusion and shadows refresh 1/derivedSlices of the rows per frame; more is cheaper but lags. */
  derivedSlices: (typeof DERIVED_SLICES)[number] = 4
  /** Multirate: the atmosphere (air pass) runs once every climateEvery steps, scaled to cover them. */
  climateEvery = 1
  /** Multirate: at 1× the ground passes (sediment, weathering, slumping) run every groundEvery steps, at that much the rate. */
  groundEvery = 2
  /** The ground passes' stride this frame (groundEvery at 1×, every step in geological time). */
  private groundStride = 1
  /**
   * Runs the water flow as three plain passes instead of the fused workgroup-memory
   * kernel; much faster when the GPU is emulated on the CPU, slower on real GPUs.
   */
  splitFlow = false
  /**
   * How water flows: 'inertial' solves the local inertial shallow water equations on the
   * cell faces; 'classic' is the original diffusion + momentum heuristic (kept to compare).
   * The two keep different things in waterLast, so switching clears it.
   */
  get waterMethod() {
    return this.method
  }
  set waterMethod(m: 'inertial' | 'classic') {
    if (m === this.method) return
    this.method = m
    const enc = this.device.createCommandEncoder()
    enc.clearBuffer(this.waterLast)
    this.device.queue.submit([enc.finish()])
  }
  private method: 'inertial' | 'classic' = 'inertial'
  private steps = 0
  /** Ground substeps per step (geological time), set with the params each frame. */
  private geoSubsteps = 1
  /** The plate uplift is worked out every few frames, or on the next one when this is set. */
  platesDirty = true
  private derivedFrames = 0

  readonly ground: GPUBuffer
  readonly water: GPUBuffer
  readonly waterLast: GPUBuffer
  readonly extra: GPUBuffer
  readonly climate: GPUBuffer
  readonly air: GPUBuffer
  /** Wind field at flowSize² (see windForceShader). */
  readonly wind: GPUBuffer
  /** Upper atmosphere at flowSize² (see upperShader), and its ping-pong copy. */
  readonly upper: GPUBuffer
  private readonly upperTmp: GPUBuffer
  readonly lava: GPUBuffer
  /** Heights of the distant terrain around the window (FAR_GRID², 32 texels per window). */
  readonly far: GPUBuffer
  /** The peoples' works for this frame (see writeWorks). */
  readonly works: GPUBuffer
  private readonly worksData = new Float32Array(4 + MAX_WORKS * 8)
  /** Continental drift: the plates that move this frame, and where each cell's land comes from (see driftMapShader). */
  private readonly plateMoves: GPUBuffer
  private readonly plateMovesData = new Float32Array(4 + MAX_PLATE_MOVES * 4)
  private readonly driftMap: GPUBuffer
  private readonly driftGroups: { bindGroup: GPUBindGroup; target: GPUBuffer }[] = []
  private driftPipeline!: GPUComputePipeline
  /** The powers' acts on the land for this frame (see writeActs). */
  readonly acts: GPUBuffer
  private readonly actsData = new Float32Array(4 + MAX_ACTS * 8)
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
  private shiftFine!: { pipeline: GPUComputePipeline; bindGroup: GPUBindGroup }
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
    this.works = device.createBuffer({ label: 'works', size: this.worksData.byteLength, usage: storage })
    this.acts = device.createBuffer({ label: 'acts', size: this.actsData.byteLength, usage: storage })
    this.plateMoves = device.createBuffer({ label: 'plateMoves', size: this.plateMovesData.byteLength, usage: storage })
    this.driftMap = device.createBuffer({ label: 'driftMap', size: this.cells * 4, usage: storage })
    this.shiftParams = [this.size, this.flowSize].map((n) => {
      const buffer = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
      device.queue.writeBuffer(buffer, 0, new Uint32Array([n, 0, 0, 0]))
      return buffer
    })
    const windBuffer = (label: string) =>
      device.createBuffer({ label, size: this.flowSize * this.flowSize * 16, usage: storage })
    this.wind = windBuffer('wind')
    this.windTmp = windBuffer('windTmp')
    this.upper = windBuffer('upper')
    this.upperTmp = windBuffer('upperTmp')
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
    add('waterFlux', waterFluxShader, [this.ground, this.water, this.waterLast, this.waterTmp, this.tiles])
    add('waterDepth', waterDepthShader, [this.waterTmp, this.water, this.waterLast, this.tiles])
    // split flow: groundTmp and extraTmp are free until the erode pass, so they hold the intermediates
    add('diffuseY', waterDiffuseYShader, [this.ground, this.tiles, this.water, this.groundTmp])
    add('diffuseX', waterDiffuseXShader, [this.ground, this.tiles, this.groundTmp, this.extraTmp])
    add('momentum', waterMomentumShader, [this.ground, this.tiles, this.extraTmp, this.waterLast, this.waterTmp])
    add('windForce', windForceShader, [this.ground, this.wind, this.windTmp, this.water, this.air, this.climate])
    add('windPressureA', windPressureShader, [this.windTmp, this.wind])
    add('windPressureB', windPressureShader, [this.wind, this.windTmp])
    add('windProject', windProjectShader, [this.windTmp, this.wind, this.upper])
    add('upper', upperShader, [this.ground, this.water, this.air, this.upper, this.upperTmp, this.wind, this.airTmp, this.shadow])
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
    add('plates', platesShader, [this.ground, this.lava])
    add('quake', quakeShader, [this.ground, this.groundTmp])
    add('impact', impactShader, [this.ground, this.groundTmp, this.extra, this.water, this.lava, this.air])
    add('shock', shockShader, [this.wind])
    add('vent', ventShader, [this.lava])
    add('works', worksShader, [this.ground, this.groundTmp, this.extra, this.water, this.climate, this.works, this.air])
    add('acts', actsShader, [this.ground, this.extra, this.water, this.air, this.lava, this.acts])
    add('driftMap', driftMapShader, [this.plateMoves, this.driftMap])
    add('driftRift', driftRiftShader, [this.driftMap, this.ground, this.extra, this.lava])
    add('driftFine', driftGatherScalarShader, [this.driftMap, this.fine, this.fineTmp])
    // the vec4 buffers the land carries with it, each gathered into groundTmp and copied back
    this.driftPipeline = device.createComputePipeline({
      label: 'drift gather',
      layout: 'auto',
      compute: { module: device.createShaderModule({ label: 'drift gather', code: driftGatherShader }), entryPoint: 'main' },
    })
    for (const target of [this.ground, this.water, this.waterLast, this.extra, this.climate, this.lava]) {
      this.driftGroups.push({
        target,
        bindGroup: device.createBindGroup({
          layout: this.driftPipeline.getBindGroupLayout(0),
          entries: [this.uniform, this.driftMap, target, this.groundTmp].map((buffer, binding) => ({ binding, resource: { buffer } })),
        }),
      })
    }
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
    const shiftFine = device.createComputePipeline({
      label: 'shift fine',
      layout: 'auto',
      compute: { module: device.createShaderModule({ label: 'shift fine', code: shiftScalarShader }), entryPoint: 'main' },
    })
    this.shiftFine = {
      pipeline: shiftFine,
      bindGroup: device.createBindGroup({
        layout: shiftFine.getBindGroupLayout(0),
        entries: [this.shiftParams[0], this.fine, this.fineTmp].map((buffer, binding) => ({ binding, resource: { buffer } })),
      }),
    }
    shifted(this.wind, this.windTmp, true)
    shifted(this.upper, this.upperTmp, true)
  }

  writeParams(p: SimParams, frame: number) {
    const u32 = new Uint32Array(this.uniformData)
    const f32 = new Float32Array(this.uniformData)
    u32[0] = this.size
    u32[1] = this.flowSize
    u32[2] = frame
    f32[4] = p.rain ? 1 : 0
    f32[5] = p.evaporate ? 1 : 0
    // in geological time each ground substep runs this much faster (see geologicSubsteps)
    this.geoSubsteps = geologicSubsteps(p.geologicTime)
    this.groundStride = p.geologicTime === 1 ? this.groundEvery : 1
    const rate = (p.geologicTime * this.groundStride) / this.geoSubsteps
    f32[6] = p.erode ? rate : 0
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
    const plates = p.plates.slice(0, MAX_PLATE_OVERRIDES)
    f32.set([rate, p.plateTime, plates.length, p.brush.airMass], GEO_OFFSET / 4)
    plates.forEach((o, k) => f32.set([...o.cell, ...o.velocity, ...o.from, o.at, 0], PLATES_OFFSET / 4 + k * 8))
    const q = p.quake
    f32.set(q ? [q.uv[0], q.uv[1], q.normal, q.radius, q.slip, q.rubble, 1, 0] : [0, 0, 0, 1, 0, 0, 0, 0], QUAKE_OFFSET / 4)
    f32.set([p.brush.airSource, p.brush.clearAirSources ? 1 : 0, p.brush.current, p.brush.forest], SOURCE_OFFSET / 4)
    const m = p.impact
    f32.set(m ? [m.uv[0], m.uv[1], m.radius, m.depth] : [0, 0, 0, 0], IMPACT_OFFSET / 4)
    for (let k = 0; k < MAX_STORMS; k++) {
      const st = p.storms[k]
      f32.set(st ? [st.uv[0], st.uv[1], st.strength, st.radius] : [0, 0, 0, 0], STORMS_OFFSET / 4 + k * 4)
    }
    for (let k = 0; k < MAX_DUSTS; k++) {
      const d = p.dusts[k]
      f32.set(d ? [d.uv[0], d.uv[1], d.cooling, d.radius] : [0, 0, 0, 0], DUSTS_OFFSET / 4 + k * 4)
    }
    for (let k = 0; k < MAX_HIGHS; k++) {
      const h = p.highs[k]
      f32.set(h ? [h.uv[0], h.uv[1], h.strength, h.radius] : [0, 0, 0, 0], HIGHS_OFFSET / 4 + k * 4)
    }
    const v = p.vent
    f32.set(v ? [v.uv[0], v.uv[1], v.radius, v.delta] : [0, 0, 0, 0], VENT_OFFSET / 4)
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
      this.upper,
      this.upperTmp,
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
    const fine = enc.beginComputePass({ label: 'shift fine' })
    fine.setPipeline(this.shiftFine.pipeline)
    fine.setBindGroup(0, this.shiftFine.bindGroup)
    fine.dispatchWorkgroups(Math.ceil(this.size / WG), Math.ceil(this.size / WG))
    fine.end()
    enc.copyBufferToBuffer(this.fineTmp, 0, this.fine, 0, this.cells * 4)
    enc.clearBuffer(this.flows)
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
    if (this.method === 'inertial') {
      // faces, then depths (written back to water); the water cycle reads waterTmp
      this.dispatch(pass, 'waterFlux')
      this.dispatch(pass, 'waterDepth')
      pass.end()
      enc.copyBufferToBuffer(this.water, 0, this.waterTmp, 0, this.cells * 16)
      pass = enc.beginComputePass({ label: 'step (after water)' })
    } else if (this.splitFlow) {
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
    // (the upper layer first: it trades air with the layer below, which the air pass then moves)
    const step = this.steps++
    const climateStep = step % this.climateEvery === 0
    const groundStep = step % this.groundStride === 0
    if (climateStep) {
      this.dispatch(pass, 'upper', this.flowSize)
      this.dispatch(pass, 'air')
    } else {
      pass.end()
      enc.copyBufferToBuffer(this.air, 0, this.airTmp, 0, this.cells * 16)
      pass = enc.beginComputePass({ label: 'step (water cycle)' })
    }
    this.dispatch(pass, 'cycle')
    this.dispatch(pass, 'flows', this.flowSize)
    this.dispatch(pass, 'lava')
    pass.end()
    // the lava and sediment passes gather from their neighbours, so they write copies
    enc.copyBufferToBuffer(this.lavaTmp, 0, this.lava, 0, this.cells * 16)
    if (climateStep) enc.copyBufferToBuffer(this.upperTmp, 0, this.upper, 0, this.flowSize * this.flowSize * 16)
    // the ground: once (every groundStride steps at 1×), or in geological time several
    // substeps against the same water
    for (let k = 0; k < this.geoSubsteps && groundStep; k++) {
      pass = enc.beginComputePass({ label: 'step (sediment)' })
      this.dispatch(pass, 'sediment')
      pass.end()
      enc.copyBufferToBuffer(this.groundTmp, 0, this.ground, 0, this.cells * 16)
      enc.copyBufferToBuffer(this.waterTmp, 0, this.water, 0, this.cells * 16)
      enc.copyBufferToBuffer(this.fineTmp, 0, this.fine, 0, this.cells * 4)
      pass = enc.beginComputePass({ label: 'step (ground)' })
      this.dispatch(pass, 'erode')
      this.dispatch(pass, 'settle')
      pass.end()
    }
    if (paint) this.encodePaint(enc)
  }

  /** Works out the plate uplift (lava.w) again, e.g. after a plate's motion changed. */
  encodePlates(enc: GPUCommandEncoder) {
    const pass = enc.beginComputePass({ label: 'plates' })
    this.dispatch(pass, 'plates')
    pass.end()
    this.platesDirty = false
  }

  /** The earthquake in this frame's params: the fault slips and the slopes shake. */
  encodeQuake(enc: GPUCommandEncoder) {
    const pass = enc.beginComputePass({ label: 'quake' })
    this.dispatch(pass, 'quake')
    pass.end()
    enc.copyBufferToBuffer(this.groundTmp, 0, this.ground, 0, this.cells * 16)
  }

  /** Hands the simulation the peoples' works to apply (see encodeWorks). */
  writeWorks(works: Work[]) {
    const list = works.slice(0, MAX_WORKS)
    const d = this.worksData
    d.fill(0)
    d[0] = list.length
    list.forEach((w, k) => d.set([w.uv[0], w.uv[1], w.radius, w.kind, w.strength, w.size, w.crest ?? 0, 0], 4 + k * 8))
    this.device.queue.writeBuffer(this.works, 0, d)
  }

  /** Applies the works handed over by writeWorks to the land (one frame's worth). */
  encodeWorks(enc: GPUCommandEncoder) {
    const pass = enc.beginComputePass({ label: 'works' })
    this.dispatch(pass, 'works')
    pass.end()
    enc.copyBufferToBuffer(this.groundTmp, 0, this.ground, 0, this.cells * 16)
  }

  /**
   * Continental drift: the land of these plates moves by their shifts (a cell at most each),
   * with everything on it; the rifts opened at the trailing edges sink (see driftMapShader).
   */
  encodeDrift(enc: GPUCommandEncoder, moves: PlateMove[]) {
    const list = moves.slice(0, MAX_PLATE_MOVES)
    const d = this.plateMovesData
    d.fill(0)
    d[0] = list.length
    list.forEach((m, k) => d.set([m.cell[0], m.cell[1], m.shift[0], m.shift[1]], 4 + k * 4))
    this.device.queue.writeBuffer(this.plateMoves, 0, d)
    let pass = enc.beginComputePass({ label: 'drift map' })
    this.dispatch(pass, 'driftMap')
    pass.end()
    for (const { bindGroup, target } of this.driftGroups) {
      pass = enc.beginComputePass({ label: 'drift gather' })
      pass.setPipeline(this.driftPipeline)
      pass.setBindGroup(0, bindGroup)
      pass.dispatchWorkgroups(Math.ceil(this.size / WG), Math.ceil(this.size / WG))
      pass.end()
      enc.copyBufferToBuffer(this.groundTmp, 0, target, 0, this.cells * 16)
    }
    pass = enc.beginComputePass({ label: 'drift fine and rifts' })
    this.dispatch(pass, 'driftFine')
    pass.end()
    enc.copyBufferToBuffer(this.fineTmp, 0, this.fine, 0, this.cells * 4)
    pass = enc.beginComputePass({ label: 'drift rifts' })
    this.dispatch(pass, 'driftRift')
    pass.end()
    this.platesDirty = true
  }

  /** Hands the simulation the powers' acts on the land and applies them (one frame's worth). */
  encodeActs(enc: GPUCommandEncoder, acts: Act[]) {
    const list = acts.slice(0, MAX_ACTS)
    const d = this.actsData
    d.fill(0)
    d[0] = list.length
    list.forEach((a, k) => d.set([a.uv[0], a.uv[1], a.radius, ACT_KINDS[a.kind], ...a.values], 4 + k * 8))
    this.device.queue.writeBuffer(this.acts, 0, d)
    const pass = enc.beginComputePass({ label: 'acts' })
    this.dispatch(pass, 'acts')
    pass.end()
  }

  /** The meteor strike in this frame's params: the crater is dug and the ground copied back. */
  encodeImpact(enc: GPUCommandEncoder) {
    const pass = enc.beginComputePass({ label: 'impact' })
    this.dispatch(pass, 'impact')
    this.dispatch(pass, 'shock', this.flowSize)
    pass.end()
    enc.copyBufferToBuffer(this.groundTmp, 0, this.ground, 0, this.cells * 16)
  }

  /** The volcano in this frame's params wakes up or goes quiet (see ventShader). */
  encodeVent(enc: GPUCommandEncoder) {
    const pass = enc.beginComputePass({ label: 'vent' })
    this.dispatch(pass, 'vent')
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
    // the plates only follow the rock height slowly (who dives under whom); every 8 frames does
    if (full || this.platesDirty || this.derivedFrames++ % 8 === 0) this.encodePlates(enc)
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
    return this.cells * (16 * STATE_KEYS.length + 4)
  }

  encodeSnapshot(enc: GPUCommandEncoder): GPUBuffer {
    const snap = this.device.createBuffer({
      label: 'undo',
      size: this.snapshotBytes,
      usage: GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    })
    STATE_KEYS.forEach((key, k) => enc.copyBufferToBuffer(this[key], 0, snap, k * this.cells * 16, this.cells * 16))
    enc.copyBufferToBuffer(this.fine, 0, snap, STATE_KEYS.length * this.cells * 16, this.cells * 4)
    return snap
  }

  encodeRestore(enc: GPUCommandEncoder, snap: GPUBuffer) {
    STATE_KEYS.forEach((key, k) => enc.copyBufferToBuffer(snap, k * this.cells * 16, this[key], 0, this.cells * 16))
    enc.copyBufferToBuffer(snap, STATE_KEYS.length * this.cells * 16, this.fine, 0, this.cells * 4)
    enc.clearBuffer(this.flows)
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
      size: bytes * STATE_KEYS.length + this.cells * 4,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    })
    STATE_KEYS.forEach((key, k) => enc.copyBufferToBuffer(this[key], 0, staging, k * bytes, bytes))
    enc.copyBufferToBuffer(this.fine, 0, staging, bytes * STATE_KEYS.length, this.cells * 4)
    return async () => {
      await staging.mapAsync(GPUMapMode.READ)
      const all = new Float32Array(staging.getMappedRange().slice(0))
      staging.unmap()
      staging.destroy()
      const state = { size: this.size } as SimState
      STATE_KEYS.forEach((key, k) => (state[key] = all.slice((k * bytes) / 4, ((k + 1) * bytes) / 4)))
      const fineAt = (bytes * STATE_KEYS.length) / 4
      state.fine = all.slice(fineAt, fineAt + this.cells)
      return state
    }
  }

  writeState(state: SimState) {
    if (state.size !== this.size) throw new Error(`state is ${state.size}², simulation is ${this.size}²`)
    const q = this.device.queue
    for (const key of STATE_KEYS) q.writeBuffer(this[key], 0, state[key] as Float32Array<ArrayBuffer>)
    const enc = this.device.createCommandEncoder()
    if (state.fine) q.writeBuffer(this.fine, 0, state.fine as Float32Array<ArrayBuffer>)
    else enc.clearBuffer(this.fine)
    enc.clearBuffer(this.flows)
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
      this.upper,
      this.upperTmp,
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
      this.acts,
      this.plateMoves,
      this.driftMap,
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
