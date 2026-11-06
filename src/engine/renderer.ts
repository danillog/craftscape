import { mat4, type Mat4, type Vec3 } from './math'
import {
  CAMERA_UNIFORM_SIZE,
  MAX_PLATE_ARROWS,
  LIFE_VERTICES,
  MAX_LIFE,
  ROAD_VERTICES,
  lifeShader,
  roadShader,
  territoryShader,
  WIND_ARROW_GRID,
  cloudShader,
  farTerrainShader,
  plateArrowShader,
  skyShader,
  terrainShader,
  waterShader,
  windArrowShader,
} from './shaders/render'
import { FAR_GRID, MAX_PLATE_OVERRIDES } from './shaders/sim'
import type { PlateField } from './plates'
import { MAX_ROADS, TERRITORY_N, type LifeMarker, type RoadSegment } from './life'
import type { SkyState } from './sky'
import type { Overlay } from './settings'
import type { Simulation } from './simulation'
import { loadTexture } from './textures'

const CHUNK_CELLS = 64
/** Marker kinds in the order the life shader numbers them. */
const LIFE_KINDS: LifeMarker['kind'][] = ['herd', 'village', 'battle', 'ruin', 'boat', 'party', 'dam', 'plane', 'fire', 'blast', 'cyclone']
const LOD_LEVELS = 4 // vertex strides 1, 2, 4, 8
const OVERLAYS: Overlay[] = [
  'none',
  'biome',
  'temperature',
  'rain',
  'humidity',
  'pressure',
  'erosion',
  'change',
  'rivers',
  'plates',
  'airmass',
  'civilization',
  'current',
  'relief',
]

export interface View {
  viewProj: Mat4
  view: Mat4
  eye: Vec3
  fovY: number
}

/** A plate's drift arrow: its site in window uv and its velocity (world units, speed ≤ ~1). */
export interface PlateArrow {
  uv: [number, number]
  velocity: [number, number]
  selected: boolean
}

export interface SceneOptions {
  overlay: Overlay
  arrows: boolean
  /** Plate drift arrows to draw (empty: none). */
  plateArrows: PlateArrow[]
  /** Herds, towns and battles to draw (empty: none). */
  life: LifeMarker[]
  /** Roads and routes between towns, in window uv. */
  roads: RoadSegment[]
  /** The political map over the window (TERRITORY_N² owner cells), or null for none. */
  territory: Uint32Array<ArrayBuffer> | null
  clouds: boolean
  sky: SkyState
  /** How far the cloud pattern has drifted, in terrain units. */
  cloudDrift: [number, number]
  simTime: number
  /** Window origin in the world, in window widths. */
  origin: [number, number]
  /** Draw the distant terrain around the window (infinite world). */
  horizon: boolean
  /** Simulated area: the window's width in world units. */
  extent: number
  /** Terrain seed (the rock strata depend on it). */
  seed: number
  /** Point of the year, 0–1 from the start of spring; −1 without seasons. */
  seasonPhase: number
  /** The plates as they are now (for the plate map). */
  plates: PlateField
  /** For colouring the distant terrain: sea level (or null without a sea), temperature at height 0, °C per height, °C north–south per window. */
  farClimate: { seaLevel: number | null; baseTemperature: number; lapseRate: number; latitude: number }
}

export interface BrushView {
  uv: [number, number]
  radius: number
  visible: boolean
}

interface LodRange {
  firstIndex: number
  indexCount: number
}

interface ChunkMesh {
  buffer: GPUBuffer
  lods: LodRange[]
}

export class Renderer {
  private readonly device: GPUDevice
  private readonly context: GPUCanvasContext
  private readonly uniform: GPUBuffer
  private readonly uniformData = new Float32Array(CAMERA_UNIFORM_SIZE / 4)
  /** Index buffers per chunk size (see chunkCells), one range per LOD. */
  private readonly chunkMeshes = new Map<number, ChunkMesh>()
  private readonly chunkList: GPUBuffer
  private readonly terrainLayout: GPUBindGroupLayout
  private readonly waterLayout: GPUBindGroupLayout
  private readonly textureLayout: GPUBindGroupLayout
  private readonly terrainPipeline: GPURenderPipeline
  private readonly waterPipeline: GPURenderPipeline
  private readonly skyPipeline: GPURenderPipeline
  private readonly skyBindGroup: GPUBindGroup
  private readonly arrowPipeline: GPURenderPipeline
  private arrowBindGroup: GPUBindGroup | null = null
  private readonly plateArrowPipeline: GPURenderPipeline
  private plateArrowBindGroup: GPUBindGroup | null = null
  private readonly plateArrowBuffer: GPUBuffer
  private readonly plateArrowData = new Float32Array(MAX_PLATE_ARROWS * 8)
  private readonly lifePipeline: GPURenderPipeline
  private lifeBindGroup: GPUBindGroup | null = null
  private readonly lifeBuffer: GPUBuffer
  private readonly lifeData = new Float32Array(MAX_LIFE * 8)
  private readonly territoryPipeline: GPURenderPipeline
  private territoryBindGroup: GPUBindGroup | null = null
  private readonly territoryBuffer: GPUBuffer
  private readonly roadPipeline: GPURenderPipeline
  private roadBindGroup: GPUBindGroup | null = null
  private readonly roadBuffer: GPUBuffer
  private readonly roadData = new Float32Array(MAX_ROADS * 8)
  private readonly farPipeline: GPURenderPipeline
  /** Distant terrain index buffers: every vertex, and every other one. */
  private readonly farMeshes: { buffer: GPUBuffer; count: number }[]
  private farBindGroup: GPUBindGroup | null = null
  private readonly cloudPipeline: GPURenderPipeline
  private cloudBindGroup: GPUBindGroup | null = null
  private textureBindGroup: GPUBindGroup | null = null
  private terrainBindGroup: GPUBindGroup | null = null
  private waterBindGroup: GPUBindGroup | null = null
  private sim: Simulation | null = null
  private depthTarget: GPUTexture | null = null
  private width = 0
  private height = 0

  /** Triangles drawn last frame, for the stats panel. */
  triangles = 0
  /** Terrain LOD: screen pixels per vertex. */
  pixelsPerVertex = 6
  coarseHorizon = false

  constructor(device: GPUDevice, context: GPUCanvasContext, format: GPUTextureFormat) {
    this.device = device
    this.context = context

    this.uniform = device.createBuffer({
      label: 'camera',
      size: CAMERA_UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })
    this.chunkList = device.createBuffer({
      label: 'chunkList',
      size: 4 * 16 * 16 * LOD_LEVELS,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    })
    for (const cells of [CHUNK_CELLS, CHUNK_CELLS * 2]) this.chunkMeshes.set(cells, this.buildIndices(cells))

    const V = GPUShaderStage.VERTEX
    const F = GPUShaderStage.FRAGMENT
    const storage = (binding: number, visibility: number): GPUBindGroupLayoutEntry => ({
      binding,
      visibility,
      buffer: { type: 'read-only-storage' },
    })
    // chunks, ground and water (bindings 1–3) are shared; the rest is per surface
    const surfaceLayout = (label: string, fragmentBuffers: number) =>
      device.createBindGroupLayout({
        label,
        entries: [
          { binding: 0, visibility: V | F, buffer: { type: 'uniform' } },
          storage(1, V),
          storage(2, V | F),
          storage(3, V | F),
          ...Array.from({ length: fragmentBuffers }, (_, k) => storage(4 + k, F)),
        ],
      })
    this.terrainLayout = surfaceLayout('terrain', 6)
    this.waterLayout = surfaceLayout('water', 5)
    const textureLayout = (this.textureLayout = device.createBindGroupLayout({
      label: 'materials',
      entries: [
        { binding: 0, visibility: F, sampler: {} },
        ...[1, 2, 3, 4].map((binding) => ({ binding, visibility: F, texture: {} })),
      ],
    }))
    const surface = (label: string, code: string, water: boolean) => {
      const module = device.createShaderModule({ label, code })
      return device.createRenderPipeline({
        label,
        layout: device.createPipelineLayout({
          bindGroupLayouts: [water ? this.waterLayout : this.terrainLayout, textureLayout],
        }),
        vertex: { module, entryPoint: 'vs' },
        fragment: {
          module,
          entryPoint: 'fs',
          targets: [
            {
              format,
              blend: water
                ? {
                    color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
                    alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
                  }
                : undefined,
            },
          ],
        },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: {
          format: 'depth24plus',
          depthWriteEnabled: !water,
          depthCompare: water ? 'less-equal' : 'less',
        },
      })
    }
    this.terrainPipeline = surface('terrain', terrainShader, false)
    this.waterPipeline = surface('water', waterShader, true)

    const skyModule = device.createShaderModule({ label: 'sky', code: skyShader })
    this.skyPipeline = device.createRenderPipeline({
      label: 'sky',
      layout: 'auto',
      vertex: { module: skyModule, entryPoint: 'vs' },
      fragment: { module: skyModule, entryPoint: 'fs', targets: [{ format }] },
      depthStencil: { format: 'depth24plus', depthWriteEnabled: false, depthCompare: 'always' },
    })
    const arrows = (label: string, code: string, solid = false) => {
      const module = device.createShaderModule({ label, code })
      return device.createRenderPipeline({
        label,
        layout: 'auto',
        vertex: { module, entryPoint: 'vs' },
        fragment: {
          module,
          entryPoint: 'fs',
          targets: [
            {
              format,
              blend: {
                color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
                alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
              },
            },
          ],
        },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: { format: 'depth24plus', depthWriteEnabled: solid, depthCompare: 'less-equal' },
      })
    }
    this.arrowPipeline = arrows('windArrows', windArrowShader)
    this.plateArrowPipeline = arrows('plateArrows', plateArrowShader)
    this.plateArrowBuffer = device.createBuffer({
      label: 'plateArrows',
      size: this.plateArrowData.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    })
    this.lifePipeline = arrows('life', lifeShader, true)
    this.territoryPipeline = arrows('territory', territoryShader)
    this.territoryBuffer = device.createBuffer({
      label: 'territory',
      size: TERRITORY_N * TERRITORY_N * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    })
    this.lifeBuffer = device.createBuffer({
      label: 'life',
      size: this.lifeData.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    })
    this.roadPipeline = arrows('roads', roadShader)
    this.roadBuffer = device.createBuffer({
      label: 'roads',
      size: this.roadData.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    })
    const farModule = device.createShaderModule({ label: 'far terrain', code: farTerrainShader })
    this.farPipeline = device.createRenderPipeline({
      label: 'far terrain',
      layout: 'auto',
      vertex: { module: farModule, entryPoint: 'vs' },
      fragment: { module: farModule, entryPoint: 'fs', targets: [{ format }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' },
    })
    this.farMeshes = [1, 2].map((stride) => {
      const indices: number[] = []
      for (let y = 0; y + stride < FAR_GRID; y += stride) {
        for (let x = 0; x + stride < FAR_GRID; x += stride) {
          const v = y * FAR_GRID + x
          const s = stride
          indices.push(v, v + s, v + s * FAR_GRID, v + s, v + s * FAR_GRID + s, v + s * FAR_GRID)
        }
      }
      const buffer = device.createBuffer({
        label: `farIndices${stride}`,
        size: indices.length * 4,
        usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
      })
      device.queue.writeBuffer(buffer, 0, new Uint32Array(indices))
      return { buffer, count: indices.length }
    })

    const cloudModule = device.createShaderModule({ label: 'clouds', code: cloudShader })
    this.cloudPipeline = device.createRenderPipeline({
      label: 'clouds',
      layout: 'auto',
      vertex: { module: cloudModule, entryPoint: 'vs' },
      fragment: {
        module: cloudModule,
        entryPoint: 'fs',
        targets: [
          {
            format,
            blend: {
              color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
              alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
            },
          },
        ],
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: 'depth24plus', depthWriteEnabled: false, depthCompare: 'less' },
    })
    this.skyBindGroup = device.createBindGroup({
      layout: this.skyPipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.uniform } }],
    })
  }

  async loadTextures() {
    const [rock, rockNormals, grass, grassNormals] = await Promise.all([
      loadTexture(this.device, `${import.meta.env.BASE_URL}textures/rock_texture.png`),
      loadTexture(this.device, `${import.meta.env.BASE_URL}textures/rock2_normals.png`, true),
      loadTexture(this.device, `${import.meta.env.BASE_URL}textures/grass_material.png`),
      loadTexture(this.device, `${import.meta.env.BASE_URL}textures/grass_normals.png`, true),
    ])
    const sampler = this.device.createSampler({
      addressModeU: 'repeat',
      addressModeV: 'repeat',
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
      maxAnisotropy: 8,
    })
    this.textureBindGroup = this.device.createBindGroup({
      layout: this.textureLayout,
      entries: [
        { binding: 0, resource: sampler },
        ...[rock, rockNormals, grass, grassNormals].map((t, k) => ({ binding: k + 1, resource: t.createView() })),
      ],
    })
  }

  setSimulation(sim: Simulation) {
    this.sim = sim
    const group = (layout: GPUBindGroupLayout, buffers: GPUBuffer[]) =>
      this.device.createBindGroup({
        layout,
        entries: [this.uniform, ...buffers].map((buffer, binding) => ({ binding, resource: { buffer } })),
      })
    const shared = [this.chunkList, sim.ground, sim.water]
    this.terrainBindGroup = group(this.terrainLayout, [
      ...shared,
      sim.normals,
      sim.extra,
      sim.shadow,
      sim.climate,
      sim.lava,
      sim.wind,
    ])
    this.waterBindGroup = group(this.waterLayout, [
      ...shared,
      sim.shadow,
      sim.flows,
      sim.wnormals,
      sim.climate,
      sim.fine,
    ])
    this.cloudBindGroup = group(this.cloudPipeline.getBindGroupLayout(0), [sim.climate, sim.air, sim.ground, sim.water])
    this.farBindGroup = group(this.farPipeline.getBindGroupLayout(0), [sim.far, sim.ground])
    this.arrowBindGroup = this.device.createBindGroup({
      layout: this.arrowPipeline.getBindGroupLayout(0),
      entries: [this.uniform, sim.ground, sim.water, sim.wind].map((buffer, binding) => ({
        binding,
        resource: { buffer },
      })),
    })
    this.plateArrowBindGroup = group(this.plateArrowPipeline.getBindGroupLayout(0), [
      sim.ground,
      sim.water,
      this.plateArrowBuffer,
    ])
    this.lifeBindGroup = group(this.lifePipeline.getBindGroupLayout(0), [sim.ground, sim.water, this.lifeBuffer])
    this.roadBindGroup = group(this.roadPipeline.getBindGroupLayout(0), [sim.ground, sim.water, this.roadBuffer])
    this.territoryBindGroup = group(this.territoryPipeline.getBindGroupLayout(0), [
      sim.ground,
      sim.water,
      this.territoryBuffer,
    ])
  }

  // One index range per LOD: the (C+1)² vertex grid of a chunk at stride s.
  // Cracks between chunks of different LOD are closed in the vertex shader, which
  // snaps edge vertices onto the coarser neighbour's edge.
  private buildIndices(C: number): ChunkMesh {
    const side = C + 1
    const indices: number[] = []
    const lods: LodRange[] = []
    for (let level = 0; level < LOD_LEVELS; level++) {
      const s = 1 << level
      const firstIndex = indices.length
      for (let b = 0; b < C; b += s) {
        for (let a = 0; a < C; a += s) {
          const v00 = a + b * side
          const v10 = a + s + b * side
          const v01 = a + (b + s) * side
          const v11 = a + s + (b + s) * side
          indices.push(v00, v10, v01, v10, v11, v01)
        }
      }
      lods.push({ firstIndex, indexCount: indices.length - firstIndex })
    }
    const data = new Uint16Array(indices.length + (indices.length % 2))
    data.set(indices)
    const buffer = this.device.createBuffer({
      label: 'chunkIndices',
      size: data.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    })
    this.device.queue.writeBuffer(buffer, 0, data)
    return { buffer, lods }
  }

  /**
   * Cells per chunk side: 64, doubled past 1024² (1536², 2048²) so there are never more
   * than 16×16 chunks (the chunk id gets 8 bits in a chunk-list entry).
   */
  private get chunkCells() {
    return this.sim!.size > 1024 ? CHUNK_CELLS * 2 : CHUNK_CELLS
  }

  resize(width: number, height: number) {
    if (width === this.width && height === this.height && this.depthTarget) return
    this.width = width
    this.height = height
    this.depthTarget?.destroy()
    this.depthTarget = this.device.createTexture({
      size: [width, height],
      format: 'depth24plus',
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    })
  }

  /**
   * Frustum-culls chunks and buckets the visible ones by LOD. Each entry packs the
   * chunk id (bits 0-7: at most 16×16 chunks, see chunkCells), its LOD (8-9) and the LODs of its bottom/top/left/right
   * neighbours (10-17) so the vertex shader can stitch shared edges.
   */
  private selectChunks(view: View, origin: [number, number], extent: number): number[][] {
    const sim = this.sim!
    const m = view.viewProj
    const row = (r: number) => [m[r], m[4 + r], m[8 + r], m[12 + r]]
    const [r0, r1, r2, r3] = [row(0), row(1), row(2), row(3)]
    const planes = [
      r3.map((v, k) => v + r0[k]),
      r3.map((v, k) => v - r0[k]),
      r3.map((v, k) => v + r1[k]),
      r3.map((v, k) => v - r1[k]),
      r2,
      r3.map((v, k) => v - r2[k]),
    ]
    const perRow = sim.size / this.chunkCells
    const chunkSize = 1 / perRow // in window widths
    const k = (this.pixelsPerVertex * 2 * Math.tan(view.fovY / 2)) / this.height
    const lodOf = new Int8Array(perRow * perRow).fill(-1)
    const [ex, ey, ez] = view.eye
    for (let cy = 0; cy < perRow; cy++) {
      for (let cx = 0; cx < perRow; cx++) {
        const min = [
          (cx * chunkSize - 0.5 + origin[0]) * extent,
          -0.6,
          (0.5 - (cy + 1) * chunkSize - origin[1]) * extent,
        ]
        const max = [
          ((cx + 1) * chunkSize - 0.5 + origin[0]) * extent,
          0.6,
          (0.5 - cy * chunkSize - origin[1]) * extent,
        ]
        const outside = planes.some((p) => {
          const px = p[0] >= 0 ? max[0] : min[0]
          const py = p[1] >= 0 ? max[1] : min[1]
          const pz = p[2] >= 0 ? max[2] : min[2]
          return p[0] * px + p[1] * py + p[2] * pz + p[3] < 0
        })
        if (outside) continue
        const dx = Math.max(min[0] - ex, 0, ex - max[0])
        const dy = Math.max(-0.1 - ey, 0, ey - 0.2)
        const dz = Math.max(min[2] - ez, 0, ez - max[2])
        const dist = Math.hypot(dx, dy, dz)
        const stride = (k * dist * sim.size) / extent // cells per pixel-budget, at sim.size / extent cells per unit
        lodOf[cy * perRow + cx] = Math.min(LOD_LEVELS - 1, Math.max(0, Math.floor(Math.log2(Math.max(stride, 1)))))
      }
    }
    const buckets: number[][] = Array.from({ length: LOD_LEVELS }, () => [])
    for (let cy = 0; cy < perRow; cy++) {
      for (let cx = 0; cx < perRow; cx++) {
        const id = cy * perRow + cx
        const lod = lodOf[id]
        if (lod < 0) continue
        // culled or off-map neighbours count as the same LOD (nothing to stitch to)
        const at = (x: number, y: number) =>
          x < 0 || y < 0 || x >= perRow || y >= perRow || lodOf[y * perRow + x] < 0 ? lod : lodOf[y * perRow + x]
        const packed =
          id |
          (lod << 8) |
          (at(cx, cy - 1) << 10) |
          (at(cx, cy + 1) << 12) |
          (at(cx - 1, cy) << 14) |
          (at(cx + 1, cy) << 16)
        buckets[lod].push(packed)
      }
    }
    return buckets
  }

  render(view: View, brush: BrushView, time: number, scene: SceneOptions) {
    const sim = this.sim
    if (!sim || !this.terrainBindGroup || !this.waterBindGroup || !this.textureBindGroup || !this.depthTarget) return
    const device = this.device

    const u = this.uniformData
    u.set(view.viewProj, 0)
    u.set(view.view, 16)
    u.set(mat4.invert(view.viewProj), 32)
    u.set([...view.eye, 1], 48)
    u.set([...scene.sky.dir, 0], 52)
    u.set([brush.uv[0], brush.uv[1], brush.radius, brush.visible ? 1 : 0], 56)
    u.set([sim.size, sim.flowSize, OVERLAYS.indexOf(scene.overlay), time], 60)
    u.set([this.chunkCells, sim.size / this.chunkCells, scene.seasonPhase, 1 - Math.min(Math.max(0.0035 / brush.radius, 0.03), 0.5)], 64)
    u.set([this.width, this.height, 0, 0], 68)
    u.set([...scene.sky.sun, scene.sky.daylight], 72)
    u.set([...scene.cloudDrift, scene.simTime, 0], 76)
    const fc = scene.farClimate
    u.set([...scene.origin, scene.horizon ? 1 : 0, scene.extent], 80)
    u.set([fc.seaLevel ?? 0, fc.seaLevel === null ? 0 : 1, fc.baseTemperature, fc.lapseRate], 84)
    const overrides = scene.plates.overrides.slice(0, MAX_PLATE_OVERRIDES)
    u.set([fc.latitude, scene.seed, scene.plates.time, overrides.length], 88)
    overrides.forEach((o, k) => u.set([...o.cell, ...o.velocity, ...o.from, o.at, 0], 92 + k * 8))
    device.queue.writeBuffer(this.uniform, 0, u)

    const buckets = this.selectChunks(view, scene.origin, scene.extent)
    const list = new Uint32Array(buckets.flat())
    if (list.length) device.queue.writeBuffer(this.chunkList, 0, list)

    const enc = device.createCommandEncoder({ label: 'render' })
    const pass = enc.beginRenderPass({
      colorAttachments: [
        {
          view: this.context.getCurrentTexture().createView(),
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: [0.7, 0.7, 0.7, 1],
        },
      ],
      depthStencilAttachment: {
        view: this.depthTarget.createView(),
        depthLoadOp: 'clear',
        depthStoreOp: 'discard',
        depthClearValue: 1,
      },
    })

    pass.setPipeline(this.skyPipeline)
    pass.setBindGroup(0, this.skyBindGroup)
    pass.draw(3)

    let triangles = 0
    const mesh = this.chunkMeshes.get(this.chunkCells)!
    const surfaces: [GPURenderPipeline, GPUBindGroup][] = [
      [this.terrainPipeline, this.terrainBindGroup],
      [this.waterPipeline, this.waterBindGroup],
    ]
    for (const [pipeline, bindGroup] of surfaces) {
      pass.setPipeline(pipeline)
      pass.setBindGroup(0, bindGroup)
      pass.setBindGroup(1, this.textureBindGroup)
      pass.setIndexBuffer(mesh.buffer, 'uint16')
      let first = 0
      buckets.forEach((chunks, level) => {
        if (chunks.length) {
          const { firstIndex, indexCount } = mesh.lods[level]
          pass.drawIndexed(indexCount, chunks.length, firstIndex, 0, first)
          triangles += (indexCount / 3) * chunks.length
        }
        first += chunks.length
      })
    }
    if (scene.territory && this.territoryBindGroup) {
      device.queue.writeBuffer(this.territoryBuffer, 0, scene.territory)
      pass.setPipeline(this.territoryPipeline)
      pass.setBindGroup(0, this.territoryBindGroup)
      pass.draw(6, TERRITORY_N * TERRITORY_N)
    }
    if (scene.horizon && this.farBindGroup) {
      pass.setPipeline(this.farPipeline)
      pass.setBindGroup(0, this.farBindGroup)
      const far = this.farMeshes[this.coarseHorizon ? 1 : 0]
      pass.setIndexBuffer(far.buffer, 'uint32')
      pass.drawIndexed(far.count)
    }
    if (scene.clouds && this.cloudBindGroup) {
      pass.setPipeline(this.cloudPipeline)
      pass.setBindGroup(0, this.cloudBindGroup)
      pass.draw(36)
    }
    if (scene.arrows && this.arrowBindGroup) {
      pass.setPipeline(this.arrowPipeline)
      pass.setBindGroup(0, this.arrowBindGroup)
      pass.draw(9, WIND_ARROW_GRID * WIND_ARROW_GRID)
    }
    const plates = scene.plateArrows.slice(0, MAX_PLATE_ARROWS)
    if (plates.length && this.plateArrowBindGroup) {
      plates.forEach((a, k) => this.plateArrowData.set([...a.uv, ...a.velocity, a.selected ? 1 : 0, 0, 0, 0], k * 8))
      device.queue.writeBuffer(this.plateArrowBuffer, 0, this.plateArrowData, 0, plates.length * 8)
      pass.setPipeline(this.plateArrowPipeline)
      pass.setBindGroup(0, this.plateArrowBindGroup)
      pass.draw(9, plates.length)
    }
    const roads = scene.roads.slice(0, MAX_ROADS)
    if (roads.length && this.roadBindGroup) {
      roads.forEach((r, k) => this.roadData.set([...r.a, ...r.b, r.kind, 0, 0, 0], k * 8))
      device.queue.writeBuffer(this.roadBuffer, 0, this.roadData, 0, roads.length * 8)
      pass.setPipeline(this.roadPipeline)
      pass.setBindGroup(0, this.roadBindGroup)
      pass.draw(ROAD_VERTICES, roads.length)
    }
    // kinds this renderer does not draw (the 2D game's planes) are left out
    const life = scene.life.filter((m) => LIFE_KINDS.includes(m.kind)).slice(0, MAX_LIFE)
    if (life.length && this.lifeBindGroup) {
      life.forEach((m, k) =>
        this.lifeData.set(
          [...m.uv, LIFE_KINDS.indexOf(m.kind), m.size, m.health, m.color, m.tech, m.flag],
          k * 8,
        ),
      )
      device.queue.writeBuffer(this.lifeBuffer, 0, this.lifeData, 0, life.length * 8)
      pass.setPipeline(this.lifePipeline)
      pass.setBindGroup(0, this.lifeBindGroup)
      pass.draw(LIFE_VERTICES, life.length)
    }
    pass.end()
    device.queue.submit([enc.finish()])
    this.triangles = triangles
  }
}
