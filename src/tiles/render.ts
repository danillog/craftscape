// Drawing the tile world on a 2D canvas: a colour per tile (biome, water, snow, lava,
// hillshade) scaled up pixel-sharp, feature sprites on top (trees, mountains, dunes, waves)
// drawn procedurally into an atlas and painted into a big offscreen canvas only when a
// tile's look changes, then the peoples' territories, roads, towns and travellers, the
// clouds and the names.

import { CIV_COLORS, TERRITORY_N, type LifeLabel, type LifeMarker, type RoadSegment } from '../engine/life'
import { LAPSE, type TileWorld } from './world'

/** Pixels per tile in the sprite layer. */
const SPR = 16
const KINDS = ['none', 'tree', 'conifer', 'bush', 'mountain', 'snowpeak', 'hill', 'dune', 'cactus', 'wave', 'rock', 'palm', 'flower', 'dead'] as const
type Kind = (typeof KINDS)[number]
const VARIANTS = 4

/** The map modes: the plain world, or a layer of data painted over it (as in the 3D game). */
export type Overlay2d = 'none' | 'biome' | 'temperature' | 'rain' | 'humidity' | 'pressure' | 'relief' | 'rivers' | 'change' | 'civilization'
export const OVERLAYS_2D: { id: Overlay2d; label: string }[] = [
  { id: 'none', label: 'Normal' },
  { id: 'biome', label: 'Biomas' },
  { id: 'temperature', label: 'Temp.' },
  { id: 'rain', label: 'Chuva' },
  { id: 'humidity', label: 'Ar' },
  { id: 'pressure', label: 'Pressão' },
  { id: 'relief', label: 'Relevo' },
  { id: 'rivers', label: 'Rios' },
  { id: 'change', label: 'Mudança' },
  { id: 'civilization', label: 'Povos' },
]
/** The tile world's long-run rain is about this much smaller than the 3D game's "1 typical". */
export const RAIN_SCALE = 2.5
type TerritoryStyle = 'soft' | 'strong' | 'lines'

/** The biome colours, the same as the 3D game's (and BIOMES in the interface's constants). */
const BIOME_COLORS: [number, number, number][] = [
  [217, 237, 255], [140, 153, 115], [179, 168, 153], [31, 97, 77], [191, 184, 97], [51, 153, 38], [237, 199, 115], [199, 158, 51], [0, 107, 31],
]
/** The biome of a place, by its temperature and its long-run rain (1 typical): the 3D game's rule. */
export function biomeOf(t: number, rain: number): number {
  if (t < -2) return 0
  if (t < 3) return rain > 0.3 ? 1 : 2
  if (t < 9) return rain > 0.5 ? 3 : 4
  if (t < 20) return rain < 0.3 ? 6 : rain > 0.8 ? 5 : 4
  return rain < 0.3 ? 6 : rain > 1.0 ? 8 : 7
}

export interface View {
  /** Centre of the screen, in tiles. */
  cx: number
  cy: number
  /** Screen pixels per tile. */
  zoom: number
}

export interface Scene {
  markers: LifeMarker[]
  roads: RoadSegment[]
  territory: Uint32Array | null
  labels: LifeLabel[]
  /** Real seconds, for animation. */
  time: number
  /** Wind, tiles per simulated second, for the clouds' drift. */
  wind: [number, number]
  /** Simulated seconds (the clouds drift by it). */
  simTime: number
  clouds: boolean
  /** Arrows showing the wind (and the swirl of the storms and the highs). */
  windArrows: boolean
  /** The brush under the cursor: tile centre and radius, or null. */
  brush: { x: number; y: number; r: number } | null
  selected: [number, number] | null
}

const civCss = (k: number, a = 1) => `rgba(${CIV_COLORS[k].map((v) => Math.round(v * 255)).join(', ')}, ${a})`
const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v)
const smooth = (v: number, a: number, b: number) => {
  const t = clamp((v - a) / (b - a), 0, 1)
  return t * t * (3 - 2 * t)
}
const mix = (a: number, b: number, t: number) => a + (b - a) * t

export class Renderer2D {
  private readonly world: TileWorld
  private readonly pixels: HTMLCanvasElement
  private readonly pixelCtx: CanvasRenderingContext2D
  private readonly image: ImageData
  private readonly features: HTMLCanvasElement
  private readonly featureCtx: CanvasRenderingContext2D
  private readonly look: Uint8Array
  private readonly atlas: HTMLCanvasElement
  private readonly territory: HTMLCanvasElement
  private readonly territoryCtx: CanvasRenderingContext2D
  private readonly territoryImage: ImageData
  private readonly cloud: HTMLCanvasElement
  private lastTerritory: Uint32Array | null = null
  private lastTerritoryStyle: TerritoryStyle = 'soft'
  /** The map mode drawn (the game sets it and calls refresh when it changes). */
  overlay: Overlay2d = 'none'
  private readonly ov = new Float32Array(4)

  constructor(world: TileWorld) {
    this.world = world
    const n = world.n
    this.pixels = document.createElement('canvas')
    this.pixels.width = n
    this.pixels.height = n
    this.pixelCtx = this.pixels.getContext('2d')!
    this.image = this.pixelCtx.createImageData(n, n)
    this.features = document.createElement('canvas')
    this.features.width = n * SPR
    this.features.height = n * SPR
    this.featureCtx = this.features.getContext('2d')!
    this.look = new Uint8Array(n * n).fill(255)
    this.atlas = buildAtlas()
    this.territory = document.createElement('canvas')
    this.territory.width = TERRITORY_N
    this.territory.height = TERRITORY_N
    this.territoryCtx = this.territory.getContext('2d')!
    this.territoryImage = this.territoryCtx.createImageData(TERRITORY_N, TERRITORY_N)
    this.cloud = buildCloud()
    this.refresh()
  }

  /** Recomputes the tile colours and the sprites of the tiles whose look changed. */
  refresh() {
    const w = this.world
    const n = w.n
    const g = w.ground
    const e = w.extra
    const c = w.climate
    const wa = w.water
    const l = w.lava
    const f = w.fire
    const data = this.image.data
    const fc = this.featureCtx
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const i = y * n + x
        const i4 = i * 4
        const h = g[i4]
        const depth = wa[i4]
        const t = c[i4 + 3]
        const v = e[i4]
        const snow = e[i4 + 2]
        const ice = e[i4 + 3]
        const sand = g[i4 + 3]
        const lava = l[i4]
        const moist = clamp(e[i4 + 1] * 1.3 + c[i4 + 2] * 0.25, 0, 1)
        let r: number
        let gg: number
        let b: number
        let kind: Kind = 'none'
        const jit = w.jitter(i)
        // hillshade from the north-west
        const xm = x > 0 ? i4 - 4 : i4
        const ym = y > 0 ? i4 - n * 4 : i4
        const dz = g[i4] - (g[xm] + g[ym]) * 0.5
        const shade = clamp(0.92 - dz * 90, 0.55, 1.25)
        if (lava > 0.0002) {
          const glow = smooth(lava, 0.0002, 0.003)
          r = mix(70, 255, glow)
          gg = mix(30, 90, glow)
          b = mix(25, 20, glow)
        } else if (h < 0 || depth > 0.002) {
          const d = h < 0 ? -h + depth : depth
          const deep = smooth(d, 0.004, 0.08)
          r = mix(70, 18, deep)
          gg = mix(150, 60, deep)
          b = mix(190, 125, deep)
          if (ice > 0) {
            r = 205
            gg = 225
            b = 238
          } else if (jit < 0.06 && d > 0.01) kind = 'wave'
        } else {
          const cold = 1 - smooth(t, -2, 10)
          const hot = smooth(t, 22, 34)
          // the ground: rock high up, soil and grass by moisture, sand when dry and hot
          const grassR = mix(128, 92, moist)
          const grassG = mix(150, 152, moist)
          const grassB = mix(78, 60, moist)
          const dry = (1 - smooth(moist, 0.06, 0.3)) * 0.55
          r = mix(grassR, 160, dry)
          gg = mix(grassG, 146, dry)
          b = mix(grassB, 86, dry)
          const rocky = smooth(h, 0.12, 0.2)
          r = mix(r, 125, rocky)
          gg = mix(gg, 118, rocky)
          b = mix(b, 110, rocky)
          r = mix(r, 214, sand)
          gg = mix(gg, 192, sand)
          b = mix(b, 130, sand)
          // forest darkens the ground
          const forest = smooth(v, 0.3, 0.8)
          r = mix(r, 48, forest * 0.7)
          gg = mix(gg, 96, forest * 0.7)
          b = mix(b, 42, forest * 0.7)
          // tundra and snow
          r = mix(r, 150, cold * (1 - snow) * 0.5)
          gg = mix(gg, 148, cold * (1 - snow) * 0.5)
          b = mix(b, 125, cold * (1 - snow) * 0.5)
          r = mix(r, 238, snow)
          gg = mix(gg, 242, snow)
          b = mix(b, 248, snow)
          if (f[i] > 0) {
            r = 240
            gg = mix(60, 160, jit)
            b = 20
          }
          // river tiles
          const river = wa[i4 + 3]
          if (river > 0 && depth <= 0.002) {
            const rr = smooth(river, 0.0008, 0.003)
            r = mix(r, 60, 0.5 + 0.4 * rr)
            gg = mix(gg, 130, 0.5 + 0.4 * rr)
            b = mix(b, 190, 0.5 + 0.4 * rr)
          }
          // the sprite
          if (f[i] > 0) kind = 'none'
          else if (h > 0.17 || (h > 0.13 && snow > 0.5)) kind = snow > 0.5 || t < 0 ? 'snowpeak' : 'mountain'
          else if (h > 0.11 && jit < 0.7) kind = v > 0.6 ? (t < 8 ? 'conifer' : 'tree') : 'hill'
          else if (snow > 0.5) kind = v > 0.6 && jit < 0.6 ? 'conifer' : 'none'
          else if (v > 0.62) kind = jit > 0.72 ? 'none' : t < 9 ? 'conifer' : hot > 0.5 && jit < 0.25 ? 'palm' : 'tree'
          else if (v > 0.35 && jit < 0.35) kind = 'bush'
          else if (v > 0.2 && jit < 0.12) kind = 'flower'
          else if (sand > 0.5) kind = jit < 0.25 ? 'dune' : jit < 0.3 ? 'cactus' : 'none'
          else if (h > 0.08 && jit < 0.15) kind = 'rock'
          else if (v < 0.08 && moist < 0.1 && jit < 0.08 && hot > 0) kind = 'dead'
        }
        // the map mode paints its data over the ground (the atlas replaces it)
        if (this.overlay !== 'none' && this.overlayColor(i, i4, h, depth, t, snow, ice, lava, f[i] > 0)) {
          const o = this.ov
          r = mix(r, o[0], o[3])
          gg = mix(gg, o[1], o[3])
          b = mix(b, o[2], o[3])
        }
        data[i4] = r * shade
        data[i4 + 1] = gg * shade
        data[i4 + 2] = b * shade
        data[i4 + 3] = 255
        const id = KINDS.indexOf(kind) * VARIANTS + Math.floor(jit * VARIANTS)
        if (this.look[i] !== id) {
          this.look[i] = id
          fc.clearRect(x * SPR, y * SPR, SPR, SPR)
          if (kind !== 'none') fc.drawImage(this.atlas, (id % (KINDS.length * VARIANTS)) * SPR, 0, SPR, SPR, x * SPR, y * SPR, SPR, SPR)
        }
      }
    }
    this.pixelCtx.putImageData(this.image, 0, 0)
  }

  /**
   * The colour of the map mode at a tile, into `ov` (r, g, b, alpha over the ground); false
   * where the mode leaves the ground as it is. The colours follow the 3D game's overlays.
   */
  private overlayColor(i: number, i4: number, h: number, depth: number, t: number, snow: number, ice: number, lava: number, burning: boolean): boolean {
    const w = this.world
    const o = this.ov
    const c = w.climate
    const water = h < 0 || depth > 0.002
    const set = (r: number, g: number, b: number, a: number) => {
      o[0] = r
      o[1] = g
      o[2] = b
      o[3] = a
      return true
    }
    const ramp = (a: [number, number, number], b: [number, number, number], k: number, alpha: number) => set(mix(a[0], b[0], k), mix(a[1], b[1], k), mix(a[2], b[2], k), alpha)
    switch (this.overlay) {
      case 'civilization': {
        // the atlas: paper-coloured land darker with height, snow pale, the sea blue with a
        // darker line along the shore; lava and fire keep their colours
        if (lava > 0.0002 || burning) return false
        if (water) {
          if (ice > 0) return set(224, 230, 235, 1)
          const d = h < 0 ? -h + depth : depth
          const k = smooth(d, 0, 0.025)
          const shore = mix(0.72, 1, smooth(d, 0, 0.0012))
          return set(mix(112, 61, k) * shore, mix(148, 92, k) * shore, mix(194, 148, k) * shore, 1)
        }
        if (w.water[i4 + 3] > 0) return set(92, 124, 172, 1)
        const above = Math.sqrt(clamp(h / 0.1, 0, 1))
        const white = Math.max(smooth(snow, 0.1, 0.6), t < -2 ? 0.6 : 0)
        return set(mix(mix(199, 140, above), 224, white), mix(mix(189, 120, above), 230, white), mix(mix(153, 97, above), 235, white), 1)
      }
      case 'biome': {
        if (water) return false
        const col = BIOME_COLORS[biomeOf(t, c[i4 + 2] * RAIN_SCALE)]
        return set(col[0], col[1], col[2], 0.75)
      }
      case 'temperature': {
        // blue below zero, white at zero, red towards 35 °C
        if (t < 0) return ramp([242, 242, 242], [26, 77, 242], smooth(-t, 0, 20), 0.75)
        return ramp([242, 242, 242], [230, 38, 13], smooth(t, 0, 35), 0.75)
      }
      case 'rain':
        return ramp([217, 166, 89], [26, 64, 230], clamp((c[i4 + 2] * RAIN_SCALE) / 2.5, 0, 1), 0.75)
      case 'humidity':
        return ramp([204, 140, 77], [242, 242, 242], clamp(c[i4 + 1], 0, 1.2) / 1.2, 0.75)
      case 'pressure': {
        // the highs (decreed droughts) orange, the lows (storms) violet, with isobar-like bands
        const p = w.droughtCover[i] - w.stormCover[i]
        const low = smooth(p, -0.8, 0)
        const high = smooth(p, 0, 0.8)
        const band = 0.85 + 0.15 * smooth(Math.abs(((p * 4) % 1) - 0.5), 0.35, 0.5)
        const r = mix(mix(89, 235, low), 242, high) * band
        const g = mix(mix(64, 235, low), 140, high) * band
        const b = mix(mix(217, 235, low), 38, high) * band
        return set(r, g, b, 0.3 + 0.5 * Math.min(1, Math.abs(p) * 1.5))
      }
      case 'relief': {
        if (water) {
          const d = h < 0 ? -h + depth : depth
          return ramp([120, 180, 220], [10, 30, 90], smooth(d, 0, 0.08), 0.9)
        }
        // hypsometric tints: green lowlands, yellow, brown, grey, white; contour lines
        const stops: [number, [number, number, number]][] = [
          [0, [70, 130, 60]], [0.05, [150, 170, 80]], [0.11, [190, 160, 90]], [0.17, [140, 95, 60]], [0.23, [160, 160, 160]], [0.3, [245, 245, 250]],
        ]
        let k = 1
        while (k < stops.length - 1 && h > stops[k][0]) k++
        const [h0, a] = stops[k - 1]
        const [h1, b] = stops[k]
        const f = clamp((h - h0) / (h1 - h0), 0, 1)
        const line = (h / 0.02) % 1 < 0.12 ? 0.8 : 1
        return set(mix(a[0], b[0], f) * line, mix(a[1], b[1], f) * line, mix(a[2], b[2], f) * line, 0.9)
      }
      case 'rivers': {
        // the drainage: land dimmed, the sea deep blue, streams pale to big rivers deep
        if (h < 0) return set(0, 46, 120, 0.9)
        if (depth > 0.002) return set(40, 90, 170, 0.9)
        const acc = w.acc[i]
        if (acc > 8) return ramp([158, 219, 255], [0, 46, 191], clamp(Math.log(1 + (acc - 8) / 4) / Math.log(101), 0, 1), 0.92)
        return set(128, 128, 120, 0.6)
      }
      case 'change': {
        // orange where worn down, blue where built up since the reference, log scale to 0.03
        const d = h - w.reference[i]
        if (Math.abs(d) < 0.0003) return set(128, 128, 128, 0.45)
        const k = clamp(Math.log(1 + Math.abs(d) * 4000) / Math.log(121), 0, 1)
        return d > 0 ? ramp([209, 209, 209], [64, 140, 255], k, 0.82) : ramp([209, 209, 209], [242, 107, 51], k, 0.82)
      }
      default:
        return false
    }
  }

  private territoryStyle(): TerritoryStyle {
    return this.overlay === 'none' ? 'soft' : this.overlay === 'civilization' ? 'strong' : 'lines'
  }

  /** The peoples' lands: soft tints on the plain map, flat atlas colours with war fronts in red, or only the borders over a data map. */
  private refreshTerritory(map: Uint32Array | null, style: TerritoryStyle) {
    if (map === this.lastTerritory && style === this.lastTerritoryStyle) return
    this.lastTerritory = map
    this.lastTerritoryStyle = style
    const d = this.territoryImage.data
    const T = TERRITORY_N
    d.fill(0)
    if (map) {
      for (let y = 0; y < T; y++) {
        for (let x = 0; x < T; x++) {
          const v = map[y * T + x]
          const owner = v & 15
          if (!owner) continue
          const col = CIV_COLORS[owner - 1]
          const left = x > 0 ? map[y * T + x - 1] & 15 : 0
          const up = y > 0 ? map[(y - 1) * T + x] & 15 : 0
          const right = x < T - 1 ? map[y * T + x + 1] & 15 : 0
          const down = y < T - 1 ? map[(y + 1) * T + x] & 15 : 0
          const border = left !== owner || up !== owner || right !== owner || down !== owner
          // a front: the neighbour across the border is a people this one is at war with
          const wars = v >> 4
          const front = border && [left, up, right, down].some((o) => o && o !== owner && wars & (1 << (o - 1)))
          const k = (y * T + x) * 4
          if (style === 'soft') {
            d[k] = col[0] * 255 * (border ? 0.6 : 1)
            d[k + 1] = col[1] * 255 * (border ? 0.6 : 1)
            d[k + 2] = col[2] * 255 * (border ? 0.6 : 1)
            d[k + 3] = border ? 200 : 70
          } else if (style === 'strong') {
            if (front) {
              d[k] = 255
              d[k + 1] = 40
              d[k + 2] = 30
              d[k + 3] = 240
            } else {
              d[k] = col[0] * 255 * (border ? 0.45 : 1)
              d[k + 1] = col[1] * 255 * (border ? 0.45 : 1)
              d[k + 2] = col[2] * 255 * (border ? 0.45 : 1)
              d[k + 3] = border ? 230 : 150
            }
          } else if (border) {
            d[k] = front ? 255 : col[0] * 255 * 0.5
            d[k + 1] = front ? 40 : col[1] * 255 * 0.5
            d[k + 2] = front ? 30 : col[2] * 255 * 0.5
            d[k + 3] = 190
          }
        }
      }
    }
    this.territoryCtx.putImageData(this.territoryImage, 0, 0)
  }

  /** Draws the world as seen by the view onto the screen canvas. */
  draw(ctx: CanvasRenderingContext2D, width: number, height: number, view: View, scene: Scene) {
    const n = this.world.n
    const z = view.zoom
    const left = view.cx - width / 2 / z
    const top = view.cy - height / 2 / z
    const toScreen = (tx: number, ty: number): [number, number] => [(tx - left) * z, (ty - top) * z]
    ctx.save()
    ctx.fillStyle = '#0b1a2a'
    ctx.fillRect(0, 0, width, height)
    ctx.imageSmoothingEnabled = false
    const [ox, oy] = toScreen(0, 0)
    // the ground colours
    ctx.drawImage(this.pixels, ox, oy, n * z, n * z)
    // the sprites, when the tiles are big enough to show them (faint on the atlas, none over a data map)
    const sprites = this.overlay === 'none' ? 1 : this.overlay === 'civilization' ? 0.45 : 0
    if (z >= 5 && sprites > 0) {
      ctx.imageSmoothingEnabled = z < SPR
      ctx.globalAlpha = sprites
      const vx0 = clamp(Math.floor(left), 0, n)
      const vy0 = clamp(Math.floor(top), 0, n)
      const vx1 = clamp(Math.ceil(left + width / z), 0, n)
      const vy1 = clamp(Math.ceil(top + height / z), 0, n)
      if (vx1 > vx0 && vy1 > vy0) {
        const [sx, sy] = toScreen(vx0, vy0)
        ctx.drawImage(this.features, vx0 * SPR, vy0 * SPR, (vx1 - vx0) * SPR, (vy1 - vy0) * SPR, sx, sy, (vx1 - vx0) * z, (vy1 - vy0) * z)
      }
      ctx.globalAlpha = 1
      ctx.imageSmoothingEnabled = false
    }
    // the peoples' lands
    this.refreshTerritory(scene.territory, this.territoryStyle())
    if (scene.territory) {
      ctx.imageSmoothingEnabled = true
      ctx.drawImage(this.territory, ox, oy, n * z, n * z)
      ctx.imageSmoothingEnabled = false
    }
    // roads and routes
    if (scene.roads.length && z >= 2) {
      ctx.lineCap = 'round'
      for (const r of scene.roads) {
        const [ax, ay] = toScreen(r.a[0] * n, r.a[1] * n)
        const [bx, by] = toScreen(r.b[0] * n, r.b[1] * n)
        ctx.beginPath()
        ctx.moveTo(ax, ay)
        ctx.lineTo(bx, by)
        ctx.lineWidth = Math.max(1, z * 0.18)
        if (r.kind === 3) {
          ctx.setLineDash([z * 0.6, z * 0.6])
          ctx.strokeStyle = 'rgba(230, 240, 255, 0.5)'
        } else if (r.kind === 2) {
          ctx.setLineDash([z * 0.8, z * 0.5])
          ctx.strokeStyle = 'rgba(230, 190, 90, 0.8)'
        } else {
          ctx.setLineDash([])
          ctx.strokeStyle = r.kind === 1 ? 'rgba(110, 105, 95, 0.8)' : 'rgba(120, 95, 60, 0.7)'
        }
        ctx.stroke()
      }
      ctx.setLineDash([])
    }
    // towns, travellers, herds, ruins, battles, dams
    for (const m of scene.markers) {
      const [px, py] = toScreen(m.uv[0] * n, m.uv[1] * n)
      if (px < -40 || py < -40 || px > width + 40 || py > height + 40) continue
      drawMarker(ctx, m, px, py, z, scene.time)
    }
    // the clouds: soft blobs where the air is near saturation, drifting with the wind (only
    // on the plain map: the data maps stay readable)
    if (scene.clouds && z >= 1.5 && this.overlay === 'none') this.drawClouds(ctx, width, height, view, scene)
    if (scene.windArrows) this.drawWind(ctx, width, height, view, scene)
    // names
    ctx.textAlign = 'center'
    ctx.textBaseline = 'bottom'
    ctx.lineJoin = 'round'
    for (const l of scene.labels) {
      if (l.kind === 'town' && z < 7) continue
      const [px, py] = toScreen(l.uv[0] * n, l.uv[1] * n)
      const size = l.kind === 'people' ? 14 : 11
      ctx.font = `${l.kind === 'people' ? '700' : '500'} ${size}px system-ui, sans-serif`
      ctx.lineWidth = 3
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.8)'
      const text = l.kind === 'people' ? l.text.toUpperCase() : l.text
      const yy = py - (l.kind === 'people' ? z * 0.9 + 6 : z * 0.5 + 2)
      ctx.strokeText(text, px, yy)
      ctx.fillStyle = l.kind === 'people' ? civCss(l.color) : '#fff'
      ctx.fillText(text, px, yy)
    }
    // the selected town
    if (scene.selected) {
      const [px, py] = toScreen(scene.selected[0] * n, scene.selected[1] * n)
      ctx.beginPath()
      ctx.arc(px, py, Math.max(8, z * 1.2), 0, Math.PI * 2)
      ctx.strokeStyle = '#fff'
      ctx.lineWidth = 2
      ctx.setLineDash([4, 3])
      ctx.stroke()
      ctx.setLineDash([])
    }
    // the brush
    if (scene.brush) {
      const [px, py] = toScreen(scene.brush.x, scene.brush.y)
      ctx.beginPath()
      ctx.arc(px, py, Math.max(scene.brush.r * z, 4), 0, Math.PI * 2)
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.8)'
      ctx.lineWidth = 1.5
      ctx.stroke()
    }
    ctx.restore()
  }

  /**
   * Wind arrows on a grid: the prevailing wind, bent into a swirl around the storms (lows,
   * turning anticlockwise and drawing air in) and the decreed droughts (highs, clockwise and
   * pushing air out), as the 3D game's arrows show.
   */
  private drawWind(ctx: CanvasRenderingContext2D, width: number, height: number, view: View, scene: Scene) {
    const w = this.world
    const n = w.n
    const z = view.zoom
    const left = view.cx - width / 2 / z
    const top = view.cy - height / 2 / z
    // about 56 screen pixels apart, snapped to whole tiles so the grid stays put while panning
    const step = Math.max(2, Math.round(56 / z))
    const wind = scene.wind
    const speed = Math.hypot(wind[0], wind[1]) / 20
    const dirx = speed > 1e-6 ? wind[0] / (speed * 20) : 1
    const diry = speed > 1e-6 ? wind[1] / (speed * 20) : 0
    const x0 = Math.max(0, Math.floor(left / step) * step)
    const y0 = Math.max(0, Math.floor(top / step) * step)
    ctx.lineCap = 'round'
    ctx.lineWidth = 1.5
    for (let ty = y0; ty < Math.min(n, top + height / z + step); ty += step) {
      for (let tx = x0; tx < Math.min(n, left + width / z + step); tx += step) {
        let vx = dirx * speed
        let vy = diry * speed
        for (const s of w.storms) {
          const dx = tx - s.x
          const dy = ty - s.y
          const d = Math.hypot(dx, dy) / (s.r * 1.5)
          if (d >= 1 || d < 1e-6) continue
          const k = (1 - smooth(d, 0.2, 1)) * 1.2
          // anticlockwise on the screen (y grows downwards), and a pull inwards
          vx += ((dy - dx * 0.4) / (d * s.r * 1.5)) * k
          vy += ((-dx - dy * 0.4) / (d * s.r * 1.5)) * k
        }
        for (const h of w.droughts) {
          const dx = tx - h.x
          const dy = ty - h.y
          const d = Math.hypot(dx, dy) / (h.r * 1.4)
          if (d >= 1 || d < 1e-6) continue
          const k = (1 - smooth(d, 0.1, 1)) * 0.8
          vx += ((-dy + dx * 0.4) / (d * h.r * 1.4)) * k
          vy += ((dx + dy * 0.4) / (d * h.r * 1.4)) * k
        }
        const m = Math.hypot(vx, vy)
        if (m < 0.02) continue
        const len = Math.min(step * z * 0.42, 8 + 22 * Math.min(m / 1.2, 1.5))
        const ux = vx / m
        const uy = vy / m
        const px = (tx + 0.5 - left) * z
        const py = (ty + 0.5 - top) * z
        const ax = px - (ux * len) / 2
        const ay = py - (uy * len) / 2
        const bx = px + (ux * len) / 2
        const by = py + (uy * len) / 2
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.45)'
        ctx.lineWidth = 3
        ctx.beginPath()
        ctx.moveTo(ax, ay)
        ctx.lineTo(bx, by)
        ctx.moveTo(bx - (ux * 5 - uy * 4), by - (uy * 5 + ux * 4))
        ctx.lineTo(bx, by)
        ctx.lineTo(bx - (ux * 5 + uy * 4), by - (uy * 5 - ux * 4))
        ctx.stroke()
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)'
        ctx.lineWidth = 1.4
        ctx.stroke()
      }
    }
  }

  private drawClouds(ctx: CanvasRenderingContext2D, width: number, height: number, view: View, scene: Scene) {
    const w = this.world
    const n = w.n
    const c = w.climate
    const rain = w.rain
    const z = view.zoom
    const B = 4
    const left = view.cx - width / 2 / z
    const top = view.cy - height / 2 / z
    // the blobs drift with the wind: an offset that wraps every block
    const dx = ((scene.wind[0] * scene.simTime) % B) + B
    const dy = ((scene.wind[1] * scene.simTime) % B) + B
    const size = B * z * 2.2
    const bx0 = clamp(Math.floor(left / B) - 2, 0, n / B)
    const by0 = clamp(Math.floor(top / B) - 2, 0, n / B)
    const bx1 = clamp(Math.ceil((left + width / z) / B) + 1, 0, n / B)
    const by1 = clamp(Math.ceil((top + height / z) / B) + 1, 0, n / B)
    for (let by = by0; by < by1; by++) {
      for (let bx = bx0; bx < bx1; bx++) {
        let rh = 0
        let r = 0
        for (let yy = 0; yy < B; yy++) {
          for (let xx = 0; xx < B; xx++) {
            const i = (by * B + yy) * n + bx * B + xx
            rh += c[i * 4 + 1]
            r += rain[i]
          }
        }
        rh /= B * B
        r /= B * B
        const cover = clamp(smooth(rh, 0.84, 1.02) + smooth(r, 0.004, 0.03) * 0.7, 0, 1)
        if (cover < 0.05) continue
        const jx = (w.jitter(bx * 977 + by, 3) - 0.5) * B
        const jy = (w.jitter(bx + by * 313, 4) - 0.5) * B
        const px = (bx * B + B / 2 + jx + dx - left) * z
        const py = (by * B + B / 2 + jy + dy - top) * z
        ctx.globalAlpha = cover * 0.85
        ctx.drawImage(this.cloud, px - size / 2, py - size / 2, size, size)
        if (r > 0.01 && cover > 0.4) {
          // a wet cloud is darker underneath
          ctx.globalAlpha = Math.min(0.5, r * 8) * cover
          ctx.fillStyle = 'rgba(60, 70, 90, 1)'
          ctx.beginPath()
          ctx.arc(px, py + size * 0.08, size * 0.3, 0, Math.PI * 2)
          ctx.fill()
        }
      }
    }
    ctx.globalAlpha = 1
  }
}

// ---- the sprites --------------------------------------------------------------------

function buildAtlas(): HTMLCanvasElement {
  const atlas = document.createElement('canvas')
  atlas.width = KINDS.length * VARIANTS * SPR
  atlas.height = SPR
  const ctx = atlas.getContext('2d')!
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  KINDS.forEach((kind, k) => {
    for (let v = 0; v < VARIANTS; v++) {
      ctx.save()
      ctx.translate((k * VARIANTS + v) * SPR, 0)
      const j = (v + 0.5) / VARIANTS
      drawSprite(ctx, kind, j)
      ctx.restore()
    }
  })
  return atlas
}

function drawSprite(ctx: CanvasRenderingContext2D, kind: Kind, j: number) {
  const ox = (j - 0.5) * 5
  const s = 0.8 + j * 0.4
  switch (kind) {
    case 'tree': {
      ctx.fillStyle = '#5a3a1e'
      ctx.fillRect(7.3 + ox, 9, 1.6, 5)
      ctx.fillStyle = '#2f7a3a'
      ctx.beginPath()
      ctx.arc(8 + ox, 7, 4.2 * s, 0, Math.PI * 2)
      ctx.fill()
      ctx.fillStyle = '#4aa352'
      ctx.beginPath()
      ctx.arc(6.8 + ox, 5.8, 2.2 * s, 0, Math.PI * 2)
      ctx.fill()
      break
    }
    case 'conifer': {
      ctx.fillStyle = '#4a3220'
      ctx.fillRect(7.3 + ox, 11, 1.5, 4)
      ctx.fillStyle = '#1f5e3c'
      ctx.beginPath()
      ctx.moveTo(8 + ox, 1.5)
      ctx.lineTo(12.5 * s + ox - (s - 1) * 8, 12)
      ctx.lineTo(3.5 + ox, 12)
      ctx.closePath()
      ctx.fill()
      ctx.fillStyle = '#2d7d4f'
      ctx.beginPath()
      ctx.moveTo(8 + ox, 1.5)
      ctx.lineTo(10.5 + ox, 8)
      ctx.lineTo(5.5 + ox, 8)
      ctx.closePath()
      ctx.fill()
      break
    }
    case 'bush': {
      ctx.fillStyle = '#3d8a3f'
      ctx.beginPath()
      ctx.arc(7 + ox, 10, 2.6 * s, 0, Math.PI * 2)
      ctx.arc(10 + ox, 10.5, 2 * s, 0, Math.PI * 2)
      ctx.fill()
      break
    }
    case 'palm': {
      ctx.strokeStyle = '#7a5a2a'
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.moveTo(8 + ox, 15)
      ctx.quadraticCurveTo(9 + ox, 9, 8 + ox, 4)
      ctx.stroke()
      ctx.strokeStyle = '#3f9a45'
      ctx.lineWidth = 1.8
      for (let a = 0; a < 5; a++) {
        const ang = -Math.PI / 2 + (a - 2) * 0.55
        ctx.beginPath()
        ctx.moveTo(8 + ox, 4)
        ctx.quadraticCurveTo(8 + ox + Math.cos(ang) * 4, 4 + Math.sin(ang) * 4 + 1, 8 + ox + Math.cos(ang) * 6, 4 + Math.sin(ang) * 6 + 3)
        ctx.stroke()
      }
      break
    }
    case 'mountain':
    case 'snowpeak': {
      ctx.fillStyle = '#6e6a66'
      ctx.beginPath()
      ctx.moveTo(8 + ox * 0.5, 1)
      ctx.lineTo(15.5, 15)
      ctx.lineTo(0.5, 15)
      ctx.closePath()
      ctx.fill()
      ctx.fillStyle = '#4e4a48'
      ctx.beginPath()
      ctx.moveTo(8 + ox * 0.5, 1)
      ctx.lineTo(15.5, 15)
      ctx.lineTo(8 + ox * 0.5, 15)
      ctx.closePath()
      ctx.fill()
      if (kind === 'snowpeak') {
        ctx.fillStyle = '#f4f7fb'
        ctx.beginPath()
        ctx.moveTo(8 + ox * 0.5, 1)
        ctx.lineTo(11 + ox * 0.5, 6.5)
        ctx.lineTo(9.5 + ox * 0.5, 6)
        ctx.lineTo(8.3 + ox * 0.5, 7.2)
        ctx.lineTo(6.5 + ox * 0.5, 6)
        ctx.lineTo(5 + ox * 0.5, 6.5)
        ctx.closePath()
        ctx.fill()
      }
      break
    }
    case 'hill': {
      ctx.fillStyle = 'rgba(70, 95, 45, 0.55)'
      ctx.beginPath()
      ctx.arc(8 + ox, 14, 7 * s, Math.PI, 0)
      ctx.fill()
      ctx.fillStyle = 'rgba(130, 160, 90, 0.5)'
      ctx.beginPath()
      ctx.arc(6 + ox, 14, 5 * s, Math.PI, 0)
      ctx.fill()
      break
    }
    case 'dune': {
      ctx.strokeStyle = 'rgba(160, 130, 70, 0.7)'
      ctx.lineWidth = 1.2
      for (let k = 0; k < 2; k++) {
        ctx.beginPath()
        ctx.moveTo(1, 6 + k * 5 + ox * 0.3)
        ctx.quadraticCurveTo(5, 3 + k * 5 + ox * 0.3, 9, 6 + k * 5 + ox * 0.3)
        ctx.quadraticCurveTo(12, 8 + k * 5 + ox * 0.3, 15, 6 + k * 5 + ox * 0.3)
        ctx.stroke()
      }
      break
    }
    case 'cactus': {
      ctx.strokeStyle = '#3f8a3a'
      ctx.lineWidth = 2.2
      ctx.beginPath()
      ctx.moveTo(8 + ox, 15)
      ctx.lineTo(8 + ox, 4)
      ctx.moveTo(8 + ox, 9)
      ctx.lineTo(5 + ox, 9)
      ctx.lineTo(5 + ox, 6)
      ctx.moveTo(8 + ox, 11)
      ctx.lineTo(11 + ox, 11)
      ctx.lineTo(11 + ox, 7)
      ctx.stroke()
      break
    }
    case 'wave': {
      ctx.strokeStyle = 'rgba(220, 240, 255, 0.55)'
      ctx.lineWidth = 1.2
      ctx.beginPath()
      ctx.moveTo(3, 8 + ox)
      ctx.quadraticCurveTo(5.5, 6 + ox, 8, 8 + ox)
      ctx.quadraticCurveTo(10.5, 10 + ox, 13, 8 + ox)
      ctx.stroke()
      break
    }
    case 'rock': {
      ctx.fillStyle = '#8a8580'
      ctx.beginPath()
      ctx.moveTo(4 + ox, 13)
      ctx.lineTo(6 + ox, 8)
      ctx.lineTo(10 + ox, 7)
      ctx.lineTo(12.5 + ox, 13)
      ctx.closePath()
      ctx.fill()
      ctx.fillStyle = '#5c5854'
      ctx.beginPath()
      ctx.moveTo(10 + ox, 7)
      ctx.lineTo(12.5 + ox, 13)
      ctx.lineTo(8 + ox, 13)
      ctx.closePath()
      ctx.fill()
      break
    }
    case 'flower': {
      const colors = ['#f2d44a', '#e86b8a', '#f4f4f4', '#b48ae8']
      ctx.fillStyle = colors[Math.floor(j * 4) % 4]
      for (let k = 0; k < 3; k++) {
        ctx.beginPath()
        ctx.arc(4 + k * 4 + ox * 0.5, 7 + ((k * 7) % 5), 1.1, 0, Math.PI * 2)
        ctx.fill()
      }
      break
    }
    case 'dead': {
      ctx.strokeStyle = '#6a5a48'
      ctx.lineWidth = 1.2
      ctx.beginPath()
      ctx.moveTo(8 + ox, 15)
      ctx.lineTo(8 + ox, 6)
      ctx.lineTo(5 + ox, 3)
      ctx.moveTo(8 + ox, 9)
      ctx.lineTo(11 + ox, 6)
      ctx.stroke()
      break
    }
    default:
      break
  }
}

function buildCloud(): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = 96
  c.height = 96
  const ctx = c.getContext('2d')!
  const blob = (x: number, y: number, r: number) => {
    const grad = ctx.createRadialGradient(x, y, 0, x, y, r)
    grad.addColorStop(0, 'rgba(255, 255, 255, 0.95)')
    grad.addColorStop(0.55, 'rgba(255, 255, 255, 0.6)')
    grad.addColorStop(1, 'rgba(255, 255, 255, 0)')
    ctx.fillStyle = grad
    ctx.fillRect(x - r, y - r, r * 2, r * 2)
  }
  blob(48, 50, 34)
  blob(32, 56, 26)
  blob(64, 56, 26)
  blob(48, 36, 24)
  return c
}

/** A town, a party, a herd, a ruin, a boat, a battle or a dam, at a screen point. */
function drawMarker(ctx: CanvasRenderingContext2D, m: LifeMarker, px: number, py: number, z: number, time: number) {
  const u = Math.max(z, 3)
  switch (m.kind) {
    case 'village': {
      const era = m.tech >= 0.92 ? 6 : m.tech >= 0.8 ? 5 : m.tech >= 0.6 ? 4 : m.tech >= 0.45 ? 3 : m.tech >= 0.3 ? 2 : m.tech >= 0.15 ? 1 : 0
      const size = u * (0.9 + m.size * 1.1)
      const roof = civCss(m.color)
      const grey = 0.35 + 0.65 * m.health
      ctx.globalAlpha = 0.6 + 0.4 * grey
      // the houses: huts, then houses, a keep, a palace, a factory, towers
      const houses = 1 + Math.round(m.size * 4)
      for (let k = 0; k < houses; k++) {
        const a = k * 2.4
        const d = k === 0 ? 0 : size * 0.7
        const hx = px + Math.cos(a) * d
        const hy = py + Math.sin(a) * d * 0.7
        const s = k === 0 ? size * 0.55 : size * 0.32
        if (era === 0) {
          ctx.fillStyle = '#8b6a3a'
          ctx.beginPath()
          ctx.arc(hx, hy, s * 0.6, 0, Math.PI * 2)
          ctx.fill()
          ctx.fillStyle = '#c9a85a'
          ctx.beginPath()
          ctx.moveTo(hx - s * 0.7, hy)
          ctx.lineTo(hx, hy - s * 0.9)
          ctx.lineTo(hx + s * 0.7, hy)
          ctx.closePath()
          ctx.fill()
        } else if (era >= 6) {
          const hh = s * (1.6 + (k % 3) * 0.5)
          ctx.fillStyle = '#b9c4d2'
          ctx.fillRect(hx - s * 0.35, hy - hh, s * 0.7, hh)
          ctx.fillStyle = '#7f8c9c'
          ctx.fillRect(hx, hy - hh, s * 0.35, hh)
          ctx.fillStyle = roof
          ctx.fillRect(hx - s * 0.35, hy - hh - 2, s * 0.7, 2)
        } else {
          const wall = era >= 5 ? '#8a4b3a' : era >= 3 ? '#b9b2a6' : '#a9814d'
          const hh = s * (era >= 3 ? 0.9 : 0.6) * (k === 0 && era === 3 ? 1.8 : 1)
          ctx.fillStyle = wall
          ctx.fillRect(hx - s * 0.5, hy - hh, s, hh)
          ctx.fillStyle = roof
          ctx.beginPath()
          ctx.moveTo(hx - s * 0.6, hy - hh)
          ctx.lineTo(hx, hy - hh - s * 0.55)
          ctx.lineTo(hx + s * 0.6, hy - hh)
          ctx.closePath()
          ctx.fill()
          if (era === 5 && k === 1) {
            ctx.fillStyle = '#555'
            ctx.fillRect(hx + s * 0.3, hy - hh - s * 1.2, s * 0.2, s * 1.2)
            ctx.globalAlpha *= 0.4
            ctx.fillStyle = '#ccc'
            ctx.beginPath()
            ctx.arc(hx + s * 0.4 + Math.sin(time) * s * 0.3, hy - hh - s * 1.6, s * 0.35, 0, Math.PI * 2)
            ctx.fill()
            ctx.globalAlpha = 0.6 + 0.4 * grey
          }
        }
      }
      if (era >= 2 && era <= 4 && m.size >= 0.5) {
        ctx.strokeStyle = '#9b958c'
        ctx.lineWidth = Math.max(1, u * 0.12)
        ctx.strokeRect(px - size * 1.05, py - size * 0.9, size * 2.1, size * 1.7)
      }
      if (m.flag > 0) {
        // the monument
        ctx.fillStyle = '#e8dcb8'
        ctx.beginPath()
        ctx.moveTo(px + size * 1.1, py + size * 0.2)
        ctx.lineTo(px + size * 1.35, py - size * 0.7)
        ctx.lineTo(px + size * 1.6, py + size * 0.2)
        ctx.closePath()
        ctx.fill()
      }
      ctx.globalAlpha = 1
      break
    }
    case 'party': {
      const col = m.flag === 1 ? civCss(m.color) : m.flag === 2 ? '#8a8078' : m.flag === 3 ? civCss(m.color) : '#b08552'
      const n = 2 + Math.round(m.size * 3)
      const dx = Math.cos(m.health)
      const dy = Math.sin(m.health)
      for (let k = 0; k < n; k++) {
        const s = (k - (n - 1) / 2) * u * 0.35
        const bob = Math.abs(Math.sin(time * 9 + k * 1.7)) * u * 0.1
        ctx.fillStyle = col
        ctx.beginPath()
        ctx.arc(px - dx * s, py - dy * s - bob, u * 0.14, 0, Math.PI * 2)
        ctx.fill()
      }
      if (m.flag === 1) {
        ctx.strokeStyle = civCss(m.color)
        ctx.lineWidth = Math.max(1, u * 0.08)
        ctx.beginPath()
        ctx.moveTo(px + dx * u * 0.5, py + dy * u * 0.5)
        ctx.lineTo(px + dx * u * 0.5, py + dy * u * 0.5 - u * 0.6)
        ctx.stroke()
      }
      break
    }
    case 'boat': {
      const dx = Math.cos(m.health)
      const dy = Math.sin(m.health)
      ctx.fillStyle = '#6b4a2a'
      ctx.beginPath()
      ctx.moveTo(px + dx * u * 0.45, py + dy * u * 0.45)
      ctx.lineTo(px - dy * u * 0.2 - dx * u * 0.3, py + dx * u * 0.2 - dy * u * 0.3)
      ctx.lineTo(px + dy * u * 0.2 - dx * u * 0.3, py - dx * u * 0.2 - dy * u * 0.3)
      ctx.closePath()
      ctx.fill()
      ctx.fillStyle = civCss(m.color)
      ctx.beginPath()
      ctx.moveTo(px, py)
      ctx.lineTo(px, py - u * 0.5)
      ctx.lineTo(px + u * 0.3, py - u * 0.2)
      ctx.closePath()
      ctx.fill()
      break
    }
    case 'herd': {
      ctx.fillStyle = ['#8a6a3a', '#4a3320', '#c9a56a', '#6b5a4a', '#8a8a90'][Math.min(m.flag, 4)]
      for (let k = 0; k < 3; k++) {
        ctx.beginPath()
        ctx.arc(px + Math.cos(k * 2.1) * u * 0.3, py + Math.sin(k * 2.1) * u * 0.25, u * (0.1 + 0.08 * m.size), 0, Math.PI * 2)
        ctx.fill()
      }
      break
    }
    case 'ruin': {
      ctx.fillStyle = `rgba(120, 115, 108, ${0.4 + 0.5 * m.size})`
      ctx.fillRect(px - u * 0.4, py - u * 0.1, u * 0.3, u * 0.3)
      ctx.fillRect(px + u * 0.05, py - u * 0.3, u * 0.25, u * 0.5)
      break
    }
    case 'battle': {
      ctx.fillStyle = `rgba(255, 60, 30, ${m.size})`
      ctx.beginPath()
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * Math.PI * 2
        const r = k % 2 ? u * 0.3 : u * 0.8
        ctx.lineTo(px + Math.cos(a) * r, py + Math.sin(a) * r)
      }
      ctx.closePath()
      ctx.fill()
      break
    }
    case 'dam': {
      const dx = Math.cos(m.health)
      const dy = Math.sin(m.health)
      ctx.strokeStyle = '#7a7672'
      ctx.lineWidth = Math.max(2, u * 0.3)
      ctx.beginPath()
      ctx.moveTo(px - dx * u * 1.2, py - dy * u * 1.2)
      ctx.lineTo(px + dx * u * 1.2, py + dy * u * 1.2)
      ctx.stroke()
      break
    }
  }
}

export { LAPSE }
