// Drawing the tile world on a 2D canvas: a colour per tile (biome, water, snow, lava,
// hillshade) scaled up pixel-sharp, feature sprites on top (trees, mountains, dunes, waves)
// drawn procedurally into an atlas and painted into a big offscreen canvas only when a
// tile's look changes, then the peoples' territories, roads, towns and travellers, the
// clouds and the names.

import { CIV_COLORS, TERRITORY_N, type LifeLabel, type LifeMarker, type RoadSegment } from '../engine/life'
import { context2d, makeCanvas, type Canvas, type Ctx } from './canvas'
import { fbm } from './noise'
import { LAPSE, TileWorld, type Hurricane } from './world'

/** Pixels per tile in the sprite layer. */
const SPR = 16
/** Tiles per pixel of the cloud layer. */
const CLOUD_PX = 2
/** Tiles across one puff of the clouds' texture. */
const CLOUD_SCALE = 22
const KINDS = ['none', 'tree', 'conifer', 'bush', 'mountain', 'snowpeak', 'hill', 'dune', 'cactus', 'wave', 'rock', 'palm', 'flower', 'dead'] as const
type Kind = (typeof KINDS)[number]
const VARIANTS = 4

/** The map modes: the plain world, or a layer of data painted over it (as in the 3D game). */
export type Overlay2d =
  | 'none' | 'biome' | 'temperature' | 'rain' | 'humidity' | 'pressure' | 'relief' | 'rivers' | 'change' | 'plates' | 'human' | 'current'
  | 'civilization' | 'eras' | 'faith' | 'language' | 'plague' | 'famine' | 'war'
/** The maps of the peoples: the atlas, and their lands painted by era, faith, tongue, plague, hunger, war. */
export const PEOPLE_MAPS: Overlay2d[] = ['civilization', 'eras', 'faith', 'language', 'plague', 'famine', 'war']
export const OVERLAYS_2D: { id: Overlay2d; label: string }[] = [
  { id: 'none', label: 'Normal' },
  { id: 'biome', label: 'Biomas' },
  { id: 'temperature', label: 'Temp.' },
  { id: 'rain', label: 'Chuva' },
  { id: 'humidity', label: 'Ar' },
  { id: 'pressure', label: 'Pressão' },
  { id: 'current', label: 'Correntes' },
  { id: 'relief', label: 'Relevo' },
  { id: 'rivers', label: 'Rios' },
  { id: 'change', label: 'Mudança' },
  { id: 'plates', label: 'Placas' },
  { id: 'human', label: 'Impacto' },
  { id: 'civilization', label: 'Povos' },
  { id: 'eras', label: 'Eras' },
  { id: 'faith', label: 'Religião' },
  { id: 'language', label: 'Idiomas' },
  { id: 'plague', label: 'Peste' },
  { id: 'famine', label: 'Fome' },
  { id: 'war', label: 'Guerras' },
]
/** The tile world's long-run rain is about this much smaller than the 3D game's "1 typical". */
export const RAIN_SCALE = 2.5
/** Millimetres a year of the 3D game's "1 typical" rain. */
export const MM_PER_RAIN = 900
/** hPa: the standard sea-level pressure, and hPa per unit of the pressure anomaly. */
export const HPA_MEAN = 1013
export const HPA_PER_UNIT = 30

/** Scientific colour maps (stops 0–1): perceptually even, readable in colour-blind vision. */
type Stops = [number, number, number][]
export const COOLWARM: Stops = [[59, 76, 192], [124, 159, 249], [192, 212, 245], [221, 221, 221], [242, 203, 183], [238, 132, 104], [180, 4, 38]]
export const YLGNBU: Stops = [[255, 255, 217], [199, 233, 180], [127, 205, 187], [65, 182, 196], [29, 145, 192], [34, 94, 168], [12, 44, 132]]
export const VIRIDIS: Stops = [[68, 1, 84], [70, 51, 127], [54, 92, 141], [39, 127, 142], [31, 161, 135], [74, 194, 109], [159, 218, 58], [253, 231, 37]]
export const PUOR: Stops = [[84, 39, 136], [128, 115, 172], [178, 171, 210], [247, 247, 247], [253, 184, 99], [224, 130, 20], [179, 88, 6]]
/** A CSS gradient of a colour map, for the legends. */
export const cssRamp = (stops: Stops) => `linear-gradient(90deg, ${stops.map((c, k) => `rgb(${c.join(' ')}) ${Math.round((k / (stops.length - 1)) * 100)}%`).join(', ')})`
function sample(stops: Stops, t: number, out: Float32Array) {
  const x = Math.min(Math.max(t, 0), 1) * (stops.length - 1)
  const k = Math.min(Math.floor(x), stops.length - 2)
  const f = x - k
  out[0] = mix(stops[k][0], stops[k + 1][0], f)
  out[1] = mix(stops[k][1], stops[k + 1][1], f)
  out[2] = mix(stops[k][2], stops[k + 1][2], f)
}
type TerritoryStyle = 'soft' | 'strong' | 'lines' | 'category'

// the categorical hues and the eras' ramp, shared with the 3D game's maps of the peoples
export { CATEGORICAL, ERA_RAMP } from '../engine/palettes'

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

/** A short animation where something happened: tile centre, radius (tiles), start and length (real seconds). */
export interface Effect {
  kind: 'impact' | 'eruption' | 'lightning' | 'quake' | 'sparkle' | 'inspire' | 'plague' | 'prophet' | 'war' | 'peace' | 'rift' | 'flare' | 'fireworks' | 'heat' | 'missile' | 'nuke' | 'tsunami'
  x: number
  y: number
  /** A missile's target (tiles). */
  tx?: number
  ty?: number
  r: number
  t0: number
  dur: number
}

export interface View {
  /** Centre of the screen, in tiles. */
  cx: number
  cy: number
  /** Screen pixels per tile. */
  zoom: number
}

export interface Scene {
  /** The map is being drawn to be wrapped on the globe: nothing that belongs to the screen (the scale bar) goes on it. */
  globe?: boolean
  markers: LifeMarker[]
  roads: RoadSegment[]
  territory: Uint32Array | null
  /** The era, faith and tongue maps: each people's colour index → its category's colour. */
  categories: Map<number, [number, number, number]> | null
  labels: LifeLabel[]
  /** Real seconds, for animation. */
  time: number
  clouds: boolean
  /** Arrows on the plates showing where they drift. */
  plateArrows: boolean
  /** The plates tool's drag: from (x, y) to (x, y) in tiles. */
  plateDrag: [number, number, number, number] | null
  /** Arrows showing the wind (and the swirl of the storms and the highs). */
  windArrows: boolean
  /** Satellite: the land as seen from orbit (no drawn trees or houses, towns as lights, a km grid); illustrated: the drawn map. */
  look: 'satellite' | 'illustrated'
  /** Satellite: the day and the night sweep over the map (the towns' lights show in the dark). */
  dayNight: boolean
  /** The powers' moments on screen (flashes, plumes, ripples), and the real time now (s). */
  effects: Effect[]
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
  private readonly pixels: Canvas
  private readonly pixelCtx: Ctx
  private readonly image: ImageData
  private readonly features: Canvas
  private readonly featureCtx: Ctx
  private readonly look: Uint8Array
  private readonly atlas: Canvas
  private readonly territory: Canvas
  private readonly territoryCtx: Ctx
  private readonly territoryImage: ImageData
  /** The cloud layer, one pixel per CLOUD_PX tiles, drawn smoothed over the map. */
  private readonly clouds: Canvas
  private readonly cloudCtx: Ctx
  private readonly cloudImage: ImageData
  /** The night (the Earth's shadow), a small image smoothed over the map. */
  private readonly night: Canvas
  private readonly nightCtx: Ctx
  private readonly nightImage: ImageData
  private lastTerritory: Uint32Array | null = null
  private lastTerritoryStyle: TerritoryStyle = 'soft'
  /** The map mode drawn (the game sets it and calls refresh when it changes). */
  overlay: Overlay2d = 'none'
  /** The look of the plain map (the game sets it and calls refresh when it changes). */
  mapLook: 'satellite' | 'illustrated' = 'satellite'
  private readonly ov = new Float32Array(4)

  constructor(world: TileWorld) {
    this.world = world
    const n = world.n
    this.pixels = makeCanvas()
    this.pixels.width = n
    this.pixels.height = n
    this.pixelCtx = context2d(this.pixels)
    this.image = this.pixelCtx.createImageData(n, n)
    this.features = makeCanvas()
    this.features.width = n * SPR
    this.features.height = n * SPR
    this.featureCtx = context2d(this.features)
    this.look = new Uint8Array(n * n).fill(255)
    this.atlas = buildAtlas()
    this.territory = makeCanvas()
    this.territory.width = TERRITORY_N
    this.territory.height = TERRITORY_N
    this.territoryCtx = context2d(this.territory)
    this.territoryImage = this.territoryCtx.createImageData(TERRITORY_N, TERRITORY_N)
    const cn = Math.ceil(n / CLOUD_PX)
    this.clouds = makeCanvas()
    this.clouds.width = cn
    this.clouds.height = cn
    this.cloudCtx = context2d(this.clouds)
    this.cloudImage = this.cloudCtx.createImageData(cn, cn)
    this.night = makeCanvas()
    this.night.width = 128
    this.night.height = 128
    this.nightCtx = context2d(this.night)
    this.nightImage = this.nightCtx.createImageData(128, 128)
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
        let shade = clamp(0.92 - dz * 90, 0.55, 1.25)
        const sat = this.mapLook === 'satellite' && this.overlay === 'none'
        if (sat) {
          // a finer relief shading: the slope from both sides, lit from the north-west, land only
          const xp = x < n - 1 ? i4 + 4 : i4
          const yp = y < n - 1 ? i4 + n * 4 : i4
          const sx = (g[xp] - g[xm]) * 0.5
          const sy = (g[yp] - g[ym]) * 0.5
          shade = h >= w.sea ? clamp(1 - (sx + sy) * 70, 0.62, 1.3) : 1
        }
        if (lava > 0.0002) {
          const glow = smooth(lava, 0.0002, 0.003)
          r = mix(70, 255, glow)
          gg = mix(30, 90, glow)
          b = mix(25, 20, glow)
        } else if (h < w.sea || depth > 0.002) {
          const d = h < w.sea ? w.sea - h + depth : depth
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
          // the peoples' fields (a patchwork of crops) and towns (paved, roofs)
          const fields = w.farmland[i]
          if (fields > 0.05) {
            const patch = Math.floor(jit * 4)
            const crop = [[196, 178, 92], [150, 168, 78], [176, 150, 86], [128, 150, 70]][patch]
            const k = smooth(fields, 0.1, 0.7) * 0.75
            r = mix(r, crop[0], k)
            gg = mix(gg, crop[1], k)
            b = mix(b, crop[2], k)
          }
          const town = w.urban[i]
          if (town > 0.05) {
            const k = smooth(town, 0.1, 0.6) * 0.85
            const roof = jit < 0.5 ? [150, 92, 70] : [140, 136, 132]
            r = mix(r, roof[0], k)
            gg = mix(gg, roof[1], k)
            b = mix(b, roof[2], k)
          }
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
          if (f[i] > 0 || w.urban[i] > 0.3 || w.farmland[i] > 0.5) kind = 'none'
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
        // seen from orbit: the colours of a true-colour satellite image (as in Blue Marble)
        if (sat && lava <= 0.0002 && f[i] <= 0) {
          const o = this.ov
          satelliteColor(o, h - w.sea, depth, t, v, snow, ice, sand, moist, w.farmland[i], w.urban[i], wa[i4 + 3], jit)
          r = o[0]
          gg = o[1]
          b = o[2]
          kind = 'none'
        }
        // radioactive ground: dead grey-olive
        const fall = w.fallout[i]
        if (fall > 0.02 && h >= w.sea) {
          r = mix(r, 112, fall * 0.6)
          gg = mix(gg, 108, fall * 0.6)
          b = mix(b, 82, fall * 0.6)
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
    this.refreshClouds()
  }

  /**
   * The clouds: where the air is near saturation or raining, broken up by a puffy texture
   * that drifts with the wind. The humid air itself moves with the local wind (round the
   * highs and lows), so the cloud banks travel with the weather; the texture only adds the
   * shapes, and it slides smoothly, never jumping back.
   */
  private refreshClouds() {
    const w = this.world
    const n = w.n
    const c = w.climate
    const rain = w.rain
    const cn = this.clouds.width
    const d = this.cloudImage.data
    const [driftX, driftY] = w.cloudDrift
    const seed = w.opts.seed + 11
    for (let py = 0; py < cn; py++) {
      for (let px = 0; px < cn; px++) {
        let rh = 0
        let r = 0
        let k = 0
        for (let yy = py * CLOUD_PX; yy < Math.min(n, (py + 1) * CLOUD_PX); yy++) {
          for (let xx = px * CLOUD_PX; xx < Math.min(n, (px + 1) * CLOUD_PX); xx++) {
            const i = yy * n + xx
            rh += c[i * 4 + 1]
            r += rain[i]
            k++
          }
        }
        rh /= k
        r /= k
        const dens = Math.min(1, smooth(rh, 0.8, 1.02) + smooth(r, 0.004, 0.03) * 0.7)
        const o = (py * cn + px) * 4
        if (dens < 0.02) {
          d[o + 3] = 0
          continue
        }
        const tx = (px * CLOUD_PX - driftX) / CLOUD_SCALE
        const ty = (py * CLOUD_PX - driftY) / CLOUD_SCALE
        const tex = fbm(tx, ty, seed, 4)
        // the texture cuts the edges into puffs and leaves gaps in thin cover; denser air is
        // covered more (the threshold on the texture drops as the air saturates), never less
        const cover = smooth(dens, 0.1, 0.8) * smooth(tex, 0.6 - 0.5 * dens, 0.95 - 0.45 * dens)
        // white as from orbit; only the heaviest rain clouds a little grey
        const grey = mix(255, 205, smooth(r, 0.01, 0.05))
        d[o] = grey
        d[o + 1] = grey
        d[o + 2] = Math.min(255, grey + 12)
        d[o + 3] = cover * 200
      }
    }
    this.cloudCtx.putImageData(this.cloudImage, 0, 0)
  }

  /**
   * The colour of the map mode at a tile, into `ov` (r, g, b, alpha over the ground); false
   * where the mode leaves the ground as it is. The colours follow the 3D game's overlays.
   */
  private overlayColor(i: number, i4: number, h: number, depth: number, t: number, snow: number, ice: number, lava: number, burning: boolean): boolean {
    const w = this.world
    const o = this.ov
    const c = w.climate
    const sea = w.sea
    const water = h < sea || depth > 0.002
    const set = (r: number, g: number, b: number, a: number) => {
      o[0] = r
      o[1] = g
      o[2] = b
      o[3] = a
      return true
    }
    const ramp = (a: [number, number, number], b: [number, number, number], k: number, alpha: number) => set(mix(a[0], b[0], k), mix(a[1], b[1], k), mix(a[2], b[2], k), alpha)
    switch (this.overlay) {
      case 'civilization':
      case 'eras':
      case 'faith':
      case 'language':
      case 'plague':
      case 'famine':
      case 'war': {
        // the atlas: paper-coloured land darker with height, snow pale, the sea blue with a
        // darker line along the shore; lava and fire keep their colours
        if (lava > 0.0002 || burning) return false
        if (water) {
          if (ice > 0) return set(224, 230, 235, 1)
          const d = h < sea ? sea - h + depth : depth
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
        // the air now (the day's warmth and the night's chill sweep across with the sun);
        // coolwarm, centred on freezing: −20 °C … 0 °C … 35 °C
        const now = w.airT[i]
        sample(COOLWARM, now < 0 ? 0.5 + (now / 20) * 0.5 : 0.5 + (now / 35) * 0.5, o)
        return set(o[0], o[1], o[2], 0.85)
      }
      case 'current': {
        // the ocean currents: the sea warmer (red) or colder (blue) than its latitude's by up
        // to 6 °C; the land dim, with the share of it that reaches the coast
        const cur = w.current[i]
        if (!water && cur === 0) return set(128, 128, 120, 0.6)
        sample(COOLWARM, clamp(0.5 + cur / 12, 0, 1), o)
        return set(o[0], o[1], o[2], water ? 0.92 : 0.7)
      }
      case 'rain':
        // YlGnBu, 0 … 2250 mm a year
        sample(YLGNBU, (c[i4 + 2] * RAIN_SCALE) / 2.5, o)
        return set(o[0], o[1], o[2], 0.85)
      case 'humidity':
        // viridis, relative humidity 0 … 100 %
        sample(VIRIDIS, c[i4 + 1], o)
        return set(o[0], o[1], o[2], 0.85)
      case 'pressure': {
        // PuOr: lows purple, highs orange (±15 hPa at the ends), isobars every 5 hPa
        const n = w.n
        const p = w.pressureAt((i % n) + 0.5, Math.floor(i / n) + 0.5)
        sample(PUOR, 0.5 + p, o)
        const hpa = p * HPA_PER_UNIT
        const band = Math.abs(hpa / 5 - Math.round(hpa / 5)) < 0.06 ? 0.7 : 1
        return set(o[0] * band, o[1] * band, o[2] * band, 0.85)
      }
      case 'relief': {
        if (water) {
          const d = h < sea ? sea - h + depth : depth
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
        if (h < sea) return set(0, 46, 120, 0.9)
        if (depth > 0.002) return set(40, 90, 170, 0.9)
        const acc = w.acc[i]
        if (acc > 8) return ramp([158, 219, 255], [0, 46, 191], clamp(Math.log(1 + (acc - 8) / 4) / Math.log(101), 0, 1), 0.92)
        return set(128, 128, 120, 0.6)
      }
      case 'plates': {
        // each plate its own colour, the boundaries by kind: red colliding, blue parting,
        // yellow sliding; faint where the land rises or sinks
        const t = w.tectonics
        const site = t.sites[t.plate[i]]
        if (!site) return false
        const hue = plateHue(site.cell)
        const dist = t.dist[i] * t.scale
        if (dist < 0.9) {
          const k = t.kind[i]
          return k === 0 ? set(235, 60, 45, 0.95) : k === 1 ? set(60, 140, 245, 0.95) : set(245, 205, 60, 0.95)
        }
        const u = t.uplift[i]
        const lift = u > 0 ? [255, 210, 160] : [40, 50, 90]
        const base = water ? 0.45 : 0.6
        return set(mix(hue[0], lift[0], Math.min(Math.abs(u), 1) * 0.5), mix(hue[1], lift[1], Math.min(Math.abs(u), 1) * 0.5), mix(hue[2], lift[2], Math.min(Math.abs(u), 1) * 0.5), base)
      }
      case 'human': {
        // what the peoples made of the land: towns violet-grey, fields wheat, cut forest
        // brown, smog and heat red, dams and reservoirs blue; the untouched land dim
        if (w.fallout[i] > 0.05) return ramp([200, 220, 120], [190, 230, 20], w.fallout[i], 0.95)
        if (w.built[i] > 0.001) return set(40, 110, 230, 0.95)
        if (w.urban[i] > 0.2) return set(120, 100, 150, 0.95)
        if (w.smog[i] > 0.5) return ramp([235, 200, 190], [220, 50, 40], smooth(w.smog[i], 0.5, 3.5), 0.85)
        if (w.farmland[i] > 0.15) return ramp([225, 215, 150], [230, 190, 60], smooth(w.farmland[i], 0.15, 0.8), 0.9)
        if (w.cleared[i] > 0.15) return ramp([200, 180, 150], [150, 95, 50], smooth(w.cleared[i], 0.15, 0.8), 0.85)
        if (w.irrigated[i] > 0.15) return set(80, 200, 210, 0.7)
        if (water) return set(60, 90, 130, 0.7)
        return set(120, 125, 120, 0.6)
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
    if (this.overlay === 'none') return 'soft'
    if (this.overlay === 'civilization') return 'strong'
    return PEOPLE_MAPS.includes(this.overlay) ? 'category' : 'lines'
  }
  /** On the era, faith and tongue maps: each people's colour index → the colour of its category. */
  private categoryColors: Map<number, [number, number, number]> = new Map()
  private categoryKey = ''

  /** The peoples' lands: soft tints on the plain map, flat atlas colours with war fronts in red, or only the borders over a data map. */
  private refreshTerritory(map: Uint32Array | null, style: TerritoryStyle, categories: Map<number, [number, number, number]> | null) {
    const key = categories ? [...categories.entries()].map(([k, c]) => `${k}:${c.join(',')}`).join('|') : ''
    if (map === this.lastTerritory && style === this.lastTerritoryStyle && key === this.categoryKey) return
    this.categoryKey = key
    if (categories) this.categoryColors = categories
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
          if (style === 'category') {
            // filled with its category's colour, the peoples' borders drawn dark across it
            const c = this.categoryColors.get(owner - 1)
            if (!c) continue
            d[k] = c[0] * (border ? 0.55 : 1)
            d[k + 1] = c[1] * (border ? 0.55 : 1)
            d[k + 2] = c[2] * (border ? 0.55 : 1)
            d[k + 3] = border ? 235 : 185
          } else if (style === 'soft') {
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
  /**
   * Draws the world. East to west it is round, so the map goes on sideways: the view may
   * lie across the map's edge, and then the two copies of the map that meet there are
   * drawn. A view wider than the world still shows it only once (one sun, one night, every
   * town in one place): the world's width round the middle of the view, the rest left dark.
   */
  draw(ctx: Ctx, width: number, height: number, view: View, scene: Scene) {
    const n = this.world.n
    const z = view.zoom
    const left = view.cx - width / 2 / z
    const top = view.cy - height / 2 / z
    ctx.fillStyle = '#0b1a2a'
    ctx.fillRect(0, 0, width, height)
    this.refreshTerritory(scene.territory, this.territoryStyle(), scene.categories)
    const first = Math.floor(left / n)
    const last = Math.ceil((left + width / z) / n) - 1
    const wider = width / z > n
    if (wider) {
      ctx.save()
      ctx.beginPath()
      ctx.rect(width / 2 - (n * z) / 2, 0, n * z, height)
      ctx.clip()
    }
    for (let k = first; k <= last; k++) this.drawCopy(ctx, width, height, { ...view, cx: view.cx - k * n }, scene, k === first)
    if (wider) ctx.restore()
    // what follows the pointer is drawn once, where the pointer is
    const toScreen = (tx: number, ty: number): [number, number] => [(tx - left) * z, (ty - top) * z]
    if (scene.plateDrag) {
      const [ax, ay] = toScreen(scene.plateDrag[0], scene.plateDrag[1])
      const [bx, by] = toScreen(scene.plateDrag[2], scene.plateDrag[3])
      arrow(ctx, ax, ay, bx, by, 'rgba(255, 220, 120, 0.95)', 3)
    }
    if (scene.brush) {
      const [px, py] = toScreen(scene.brush.x, scene.brush.y)
      ctx.beginPath()
      ctx.arc(px, py, Math.max(scene.brush.r * z, 4), 0, Math.PI * 2)
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.8)'
      ctx.lineWidth = 1.5
      ctx.stroke()
    }
  }

  /** One copy of the map, where `view` puts it (`once`: the copy that also draws what belongs to the screen, as the scale bar). */
  private drawCopy(ctx: Ctx, width: number, height: number, view: View, scene: Scene, once: boolean) {
    const n = this.world.n
    const z = view.zoom
    const left = view.cx - width / 2 / z
    const top = view.cy - height / 2 / z
    const toScreen = (tx: number, ty: number): [number, number] => [(tx - left) * z, (ty - top) * z]
    ctx.save()
    ctx.imageSmoothingEnabled = false
    const [ox, oy] = toScreen(0, 0)
    // the ground colours
    ctx.drawImage(this.pixels, ox, oy, n * z, n * z)
    // the sprites, when the tiles are big enough to show them (faint on the atlas, none over a data map)
    const satellite = scene.look === 'satellite'
    const sprites = satellite ? 0 : this.overlay === 'none' ? 1 : PEOPLE_MAPS.includes(this.overlay) ? 0.45 : 0
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
    if (!satellite) {
      for (const m of scene.markers) {
        if (m.kind === 'plane') continue
        const [px, py] = toScreen(m.uv[0] * n, m.uv[1] * n)
        if (px < -40 || py < -40 || px > width + 40 || py > height + 40) continue
        drawMarker(ctx, m, px, py, z, scene.time)
      }
    }
    // the clouds, where the air is near saturation, travelling with the weather (only
    // on the plain map: the data maps stay readable)
    if (scene.clouds && this.overlay === 'none') {
      ctx.imageSmoothingEnabled = true
      ctx.drawImage(this.clouds, ox, oy, n * z, n * z)
      ctx.imageSmoothingEnabled = false
    }
    // hurricanes: spiral rain bands turning clockwise (southern hemisphere) round a clear eye
    for (const h of this.world.hurricanes) drawHurricane(ctx, h, toScreen, z, scene.time, this.world.hurricaneRadius(h))
    // volcanic ash clouds: dark grey plumes drifting with the wind
    for (const a of this.world.ash) {
      const [ax, ay] = toScreen(a.x, a.y)
      const ar = a.r * z
      const fade = Math.min(1, a.left / 300)
      const grad = ctx.createRadialGradient(ax, ay, 0, ax, ay, ar)
      grad.addColorStop(0, `rgba(70, 64, 60, ${0.55 * fade})`)
      grad.addColorStop(0.6, `rgba(90, 84, 80, ${0.35 * fade})`)
      grad.addColorStop(1, 'rgba(100, 95, 90, 0)')
      ctx.fillStyle = grad
      ctx.beginPath()
      ctx.arc(ax, ay, ar, 0, Math.PI * 2)
      ctx.fill()
    }
    // a cataclysm's heat: the whole planet glows red, fading as it cools
    if (this.world.catHeat > 10) {
      ctx.fillStyle = `rgba(255, 70, 20, ${Math.min(0.4, this.world.catHeat / 350).toFixed(3)})`
      ctx.fillRect(ox, oy, n * z, n * z)
    }
    // soot and dust in the air (a nuclear winter, a meteor's dust): a brown haze over the world
    if (this.world.dust > 0.4) {
      ctx.fillStyle = `rgba(62, 52, 42, ${Math.min(0.45, this.world.dust * 0.05).toFixed(3)})`
      ctx.fillRect(ox, oy, n * z, n * z)
    }
    // seen from orbit: the night side of the planet, then the lights (brighter in the dark)
    let night: (x: number, y: number) => number = () => 0
    if (satellite) {
      if (scene.dayNight) {
        // the Earth's shadow: a curve that bends with the seasons, drawn from a small image of
        // the night smoothed over the map
        const nightOf = nightAt(this.world)
        night = nightOf
        const S = this.night.width
        const d = this.nightImage.data
        for (let py = 0; py < S; py++) {
          for (let px = 0; px < S; px++) {
            const k = (py * S + px) * 4
            d[k] = 3
            d[k + 1] = 7
            d[k + 2] = 22
            d[k + 3] = 184 * nightOf(((px + 0.5) / S) * n, ((py + 0.5) / S) * n)
          }
        }
        this.nightCtx.putImageData(this.nightImage, 0, 0)
        ctx.imageSmoothingEnabled = true
        ctx.drawImage(this.night, ox, oy, n * z, n * z)
        ctx.imageSmoothingEnabled = false
      }
      for (const m of scene.markers) {
        if (m.kind === 'plane') continue
        const [px, py] = toScreen(m.uv[0] * n, m.uv[1] * n)
        if (px < -40 || py < -40 || px > width + 40 || py > height + 40) continue
        drawLight(ctx, m, px, py, z, scene.time, night(m.uv[0] * n, m.uv[1] * n))
      }
    }
    // the planes fly above the clouds
    for (const m of scene.markers) {
      if (m.kind !== 'plane') continue
      const [px, py] = toScreen(m.uv[0] * n, m.uv[1] * n)
      if (px < -40 || py < -40 || px > width + 40 || py > height + 40) continue
      if (satellite) drawLight(ctx, m, px, py, z, scene.time, night(m.uv[0] * n, m.uv[1] * n))
      else drawMarker(ctx, m, px, py, z, scene.time)
    }
    for (const fx of scene.effects) drawEffect(ctx, fx, toScreen, z, scene.time, width, height)
    if (satellite) drawGrid(ctx, width, height, view, n, once && !scene.globe)
    if (scene.windArrows) this.drawWind(ctx, width, height, view)
    if (scene.plateArrows) this.drawPlates(ctx, toScreen, z)
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
    ctx.restore()
  }

  /** An arrow at each plate's centre showing where it drifts and how fast. */
  private drawPlates(ctx: Ctx, toScreen: (x: number, y: number) => [number, number], z: number) {
    const t = this.world.tectonics
    const n = this.world.n
    for (const s of t.sites) {
      if (!s.alive || s.x < 0 || s.y < 0 || s.x > n || s.y > n) continue
      const [px, py] = toScreen(s.x, s.y)
      const len = Math.max(18, 16 * z) * Math.hypot(s.vx, s.vy)
      const m = Math.hypot(s.vx, s.vy) || 1
      ctx.fillStyle = 'rgba(255, 255, 255, 0.9)'
      ctx.beginPath()
      ctx.arc(px, py, 3, 0, Math.PI * 2)
      ctx.fill()
      arrow(ctx, px, py, px + (s.vx / m) * len, py + (s.vy / m) * len, 'rgba(255, 255, 255, 0.9)', 2.5)
    }
  }

  /**
   * Wind arrows on a grid: the local wind, the prevailing one bent round the highs and lows
   * (clockwise round a low, drawing air in, as in the southern hemisphere; anticlockwise out of a high).
   */
  private drawWind(ctx: Ctx, width: number, height: number, view: View) {
    const w = this.world
    const n = w.n
    const z = view.zoom
    const left = view.cx - width / 2 / z
    const top = view.cy - height / 2 / z
    // about 56 screen pixels apart, snapped to whole tiles so the grid stays put while panning
    const step = Math.max(2, Math.round(56 / z))
    const x0 = Math.max(0, Math.floor(left / step) * step)
    const y0 = Math.max(0, Math.floor(top / step) * step)
    ctx.lineCap = 'round'
    for (let ty = y0; ty < Math.min(n, top + height / z + step); ty += step) {
      for (let tx = x0; tx < Math.min(n, left + width / z + step); tx += step) {
        const vx = w.sampleCells(w.windU, tx + 0.5, ty + 0.5)
        const vy = w.sampleCells(w.windV, tx + 0.5, ty + 0.5)
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
}

/**
 * A plane and its contrail (behind it along its heading; `size` is how far it is from either
 * end, so the trail is no longer than the way flown). Seen from orbit only a speck and a white line.
 */
function drawPlane(ctx: Ctx, m: LifeMarker, px: number, py: number, u: number, satellite: boolean) {
  const dx = Math.cos(m.health)
  const dy = Math.sin(m.health)
  const trail = Math.min(u * 6, 40, m.size * 400 * (u / 3))
  const grad = ctx.createLinearGradient(px, py, px - dx * trail, py - dy * trail)
  grad.addColorStop(0, 'rgba(255, 255, 255, 0.7)')
  grad.addColorStop(1, 'rgba(255, 255, 255, 0)')
  ctx.strokeStyle = grad
  ctx.lineWidth = satellite ? 1.2 : 1.6
  ctx.beginPath()
  ctx.moveTo(px, py)
  ctx.lineTo(px - dx * trail, py - dy * trail)
  ctx.stroke()
  if (satellite) {
    ctx.fillStyle = '#fff'
    ctx.fillRect(px - 1, py - 1, 2, 2)
    return
  }
  // the plane: fuselage and wings in the people's colour
  const L = u * 0.45
  ctx.strokeStyle = '#f2f2f2'
  ctx.lineWidth = Math.max(1.5, u * 0.12)
  ctx.beginPath()
  ctx.moveTo(px + dx * L, py + dy * L)
  ctx.lineTo(px - dx * L, py - dy * L)
  ctx.moveTo(px - dy * L * 0.8, py + dx * L * 0.8)
  ctx.lineTo(px + dy * L * 0.8, py - dx * L * 0.8)
  ctx.stroke()
  ctx.strokeStyle = civCss(m.color)
  ctx.lineWidth = Math.max(1, u * 0.08)
  ctx.beginPath()
  ctx.moveTo(px - dx * L - dy * L * 0.3, py - dy * L + dx * L * 0.3)
  ctx.lineTo(px - dx * L + dy * L * 0.3, py - dy * L - dx * L * 0.3)
  ctx.stroke()
}

/**
 * A tile's colour in a true-colour satellite image (Blue Marble tones), into `o`: the sea
 * from turquoise shelves to navy deeps, forests dark green (bluer in the tropics, greyer in
 * the taiga), grassland olive, deserts ochre and pale sand, tundra grey-brown, bare rock
 * grey, snow and ice white; fields a lighter patchwork, towns grey. `above`: height over the sea.
 */
function satelliteColor(o: Float32Array, above: number, depth: number, t: number, v: number, snow: number, ice: number, sand: number, moist: number, fields: number, town: number, river: number, jit: number) {
  const put = (r: number, g: number, b: number) => {
    o[0] = r
    o[1] = g
    o[2] = b
  }
  if (above < 0 || depth > 0.002) {
    if (ice > 0) return put(225, 234, 242)
    const d = above < 0 ? -above + depth : depth
    const k = smooth(d, 0.002, 0.06)
    // a lake inland is darker and greener than the open sea's shelf
    if (above >= 0) return put(mix(40, 18, k), mix(80, 50, k), mix(95, 80, k))
    return put(mix(46, 8, k), mix(128, 26, k), mix(150, 62, k))
  }
  // dry ground: pale sand to ochre, by heat; grass and forest over it by the plants
  const hot = smooth(t, 18, 32)
  let r = mix(160, 205, hot)
  let g = mix(140, 168, hot)
  let b = mix(110, 118, hot)
  r = mix(r, 222, sand * 0.8)
  g = mix(g, 196, sand * 0.8)
  b = mix(b, 150, sand * 0.8)
  // tundra
  const cold = 1 - smooth(t, -2, 8)
  r = mix(r, 122, cold * 0.7)
  g = mix(g, 116, cold * 0.7)
  b = mix(b, 100, cold * 0.7)
  // grass, then forest: olive to deep green (bluer in the tropics, greyer in the taiga)
  const grass = smooth(v, 0.08, 0.45)
  r = mix(r, mix(118, 96, moist), grass)
  g = mix(g, mix(118, 112, moist), grass)
  b = mix(b, mix(66, 60, moist), grass)
  const forest = smooth(v, 0.45, 0.85)
  const fr = t > 22 ? 18 : t < 8 ? 34 : 30
  const fg = t > 22 ? 56 : t < 8 ? 52 : 62
  const fb = t > 22 ? 34 : t < 8 ? 42 : 30
  r = mix(r, fr, forest)
  g = mix(g, fg, forest)
  b = mix(b, fb, forest)
  // bare rock high up
  const rock = smooth(above, 0.11, 0.2) * (1 - forest * 0.6)
  r = mix(r, 118, rock)
  g = mix(g, 110, rock)
  b = mix(b, 102, rock)
  // fields: a lighter patchwork; towns: grey
  if (fields > 0.05) {
    const k = smooth(fields, 0.1, 0.7) * 0.6
    const light = jit < 0.5 ? [150, 150, 88] : [176, 160, 104]
    r = mix(r, light[0], k)
    g = mix(g, light[1], k)
    b = mix(b, light[2], k)
  }
  if (town > 0.05) {
    const k = smooth(town, 0.1, 0.6) * 0.8
    r = mix(r, 128, k)
    g = mix(g, 124, k)
    b = mix(b, 120, k)
  }
  // rivers: thin and dark, only the bigger ones show
  if (river > 0.0015) {
    const k = smooth(river, 0.0015, 0.0035) * 0.7
    r = mix(r, 30, k)
    g = mix(g, 60, k)
    b = mix(b, 80, k)
  }
  // snow and ice
  r = mix(r, 242, snow)
  g = mix(g, 245, snow)
  b = mix(b, 250, snow)
  put(r, g, b)
}

/** A hurricane seen from above: the dense overcast, the spiral bands, the eye, its name and category. */
function drawHurricane(ctx: Ctx, h: Hurricane, toScreen: (x: number, y: number) => [number, number], z: number, time: number, radius: number) {
  const [px, py] = toScreen(h.x, h.y)
  const R = Math.max(radius * z, 18)
  const a = 0.35 + 0.6 * h.strength
  // the overcast around the eye
  const core = ctx.createRadialGradient(px, py, R * 0.08, px, py, R * 0.55)
  core.addColorStop(0, `rgba(255, 255, 255, 0)`)
  core.addColorStop(0.18, `rgba(250, 252, 255, ${0.95 * a})`)
  core.addColorStop(1, `rgba(235, 240, 248, 0)`)
  ctx.fillStyle = core
  ctx.beginPath()
  ctx.arc(px, py, R * 0.55, 0, Math.PI * 2)
  ctx.fill()
  // four spiral bands (logarithmic spirals), turning clockwise on the screen
  const spin = -time * (0.6 + h.strength)
  ctx.lineCap = 'round'
  for (let arm = 0; arm < 4; arm++) {
    const base = spin + (arm * Math.PI) / 2
    for (let k = 0; k < 36; k++) {
      const u = k / 36
      const r = R * (0.15 + 0.85 * u)
      const ang = base - u * 3.2
      const x = px + Math.cos(ang) * r
      const y = py + Math.sin(ang) * r
      ctx.fillStyle = `rgba(245, 248, 252, ${a * 0.55 * (1 - u)})`
      ctx.beginPath()
      ctx.arc(x, y, R * (0.16 - 0.1 * u), 0, Math.PI * 2)
      ctx.fill()
    }
  }
  // the eye
  if (h.strength > 0.2) {
    ctx.fillStyle = 'rgba(20, 40, 70, 0.55)'
    ctx.beginPath()
    ctx.arc(px, py, Math.max(2, R * 0.06), 0, Math.PI * 2)
    ctx.fill()
  }
  const cat = TileWorld.category(h.strength)
  ctx.font = '600 11px system-ui, sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'top'
  ctx.lineWidth = 3
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.75)'
  const label = cat ? `Furacão ${h.name} · cat. ${cat}` : `Tempestade tropical ${h.name}`
  ctx.strokeText(label, px, py + R * 0.62)
  ctx.fillStyle = '#fff'
  ctx.fillText(label, px, py + R * 0.62)
}

/** The planet's circumference at the equator (km): the map is 360° across. */
export const EQUATOR_KM = 40075
/** Kilometres a tile spans east–west at the equator. */
export const kmPerTile = (n: number) => EQUATOR_KM / n

/**
 * Seen from orbit: a town is a cluster of lights (brighter and wider with its people, warm
 * white, its people's colour faint around it); boats a white speck with a wake; battles a
 * flash; herds, travellers on foot and ruins are too small to see.
 */
function drawLight(ctx: Ctx, m: LifeMarker, px: number, py: number, z: number, time: number, night = 0) {
  switch (m.kind) {
    case 'village': {
      // by day a faint glint, by night the full glow of the streets (more with technology)
      const lit = 0.25 + 0.75 * night
      const r = Math.max(2, z * (0.5 + m.size * 1.2)) * (0.8 + 0.4 * night) * (0.8 + 0.4 * m.tech)
      const glow = ctx.createRadialGradient(px, py, 0, px, py, r * 2.2)
      const a = (0.35 + 0.55 * m.health) * lit
      glow.addColorStop(0, `rgba(255, 236, 190, ${a})`)
      glow.addColorStop(0.35, `rgba(255, 200, 120, ${a * 0.5})`)
      glow.addColorStop(1, 'rgba(255, 180, 90, 0)')
      ctx.fillStyle = glow
      ctx.beginPath()
      ctx.arc(px, py, r * 2.2, 0, Math.PI * 2)
      ctx.fill()
      ctx.fillStyle = `rgba(255, 250, 235, ${(0.5 + 0.5 * m.health) * lit})`
      ctx.beginPath()
      ctx.arc(px, py, Math.max(1, r * 0.35), 0, Math.PI * 2)
      ctx.fill()
      ctx.strokeStyle = civCss(m.color, 0.55 * (1 - 0.5 * night))
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.arc(px, py, r * 1.3, 0, Math.PI * 2)
      ctx.stroke()
      break
    }
    case 'boat': {
      const dx = Math.cos(m.health)
      const dy = Math.sin(m.health)
      const u = Math.max(z, 3)
      // the wake: longer behind faster ships
      const wake = u * (1.6 + m.flag * 0.9)
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(px - dy * 0.8, py + dx * 0.8)
      ctx.lineTo(px - dx * wake - dy * u * 0.3, py - dy * wake + dx * u * 0.3)
      ctx.moveTo(px + dy * 0.8, py - dx * 0.8)
      ctx.lineTo(px - dx * wake + dy * u * 0.3, py - dy * wake - dx * u * 0.3)
      ctx.stroke()
      ctx.fillStyle = 'rgba(255, 255, 255, 0.95)'
      const s = m.flag === 2 ? 3 : 2
      ctx.fillRect(px - s / 2, py - s / 2, s, s)
      break
    }
    case 'plane': {
      drawPlane(ctx, m, px, py, Math.max(z, 3), true)
      break
    }
    case 'battle': {
      ctx.fillStyle = `rgba(255, 120, 60, ${0.6 * m.size * (0.6 + 0.4 * Math.sin(time * 12))})`
      ctx.beginPath()
      ctx.arc(px, py, Math.max(2, z * 0.6), 0, Math.PI * 2)
      ctx.fill()
      break
    }
    case 'dam':
      drawMarker(ctx, m, px, py, z, time)
      break
    default:
      break
  }
}

/**
 * The map is the whole planet, flattened (equirectangular): 90°N along the top, the equator
 * across the middle, 90°S along the bottom, 180°W to 180°E from left to right (so a tile spans
 * twice as many degrees east–west as north–south). Latitude (north +) and longitude (east +).
 */
export const latAt = (y: number, n: number) => 90 - (180 * y) / n
export const lonAt = (x: number, n: number) => -180 + (360 * x) / n
export const formatLat = (lat: number, digits = 0) => `${Math.abs(lat).toFixed(digits).replace('.', ',')}°${lat < 0 ? 'S' : 'N'}`
export const formatLon = (lon: number, digits = 0) => `${Math.abs(lon).toFixed(digits).replace('.', ',')}°${lon < 0 ? 'O' : 'L'}`
/** The latitude of a row as words: its climate zone. */
export const zoneOf = (lat: number) => {
  const a = Math.abs(lat)
  return a < 23.5 ? 'trópicos' : a < 35 ? 'subtrópicos' : a < 66.5 ? 'zona temperada' : 'círculo polar'
}

/** How dark the night is at a place (tiles; 0 day, 1 night), from the sun's height there, with a soft twilight round the Earth's shadow. */
function nightAt(world: TileWorld) {
  return (x: number, y: number) => smooth(-world.sunHeight(x, y), -0.06, 0.14)
}

/** A grid of latitude and longitude every few degrees with labels, and a scale bar in the corner: the map read as a map. */
function drawGrid(ctx: Ctx, width: number, height: number, view: View, n: number, bar: boolean) {
  const z = view.zoom
  const left = view.cx - width / 2 / z
  const top = view.cy - height / 2 / z
  const pxPerKm = z / kmPerTile(n)
  ctx.save()
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.13)'
  ctx.lineWidth = 1
  ctx.fillStyle = 'rgba(255, 255, 255, 0.6)'
  ctx.font = '10px ui-monospace, monospace'
  // a round step in degrees, lines about 110 px apart (a degree of latitude is n/180 tiles)
  const degPx = (n / 180) * z
  const step = [1, 2, 5, 10, 15, 30].find((d) => d * degPx >= 110) ?? 30
  const x0 = Math.max(0, -left * z)
  const x1 = Math.min(width, (n - left) * z)
  const y0 = Math.max(0, -top * z)
  const y1 = Math.min(height, (n - top) * z)
  // parallels
  for (let lat = -90 + step; lat < 90; lat += step) {
    const y = (((90 - lat) / 180) * n - top) * z
    if (y < y0 || y > y1) continue
    ctx.beginPath()
    ctx.moveTo(x0, Math.round(y) + 0.5)
    ctx.lineTo(x1, Math.round(y) + 0.5)
    ctx.stroke()
    ctx.textAlign = 'right'
    ctx.textBaseline = 'bottom'
    ctx.fillText(lat === 0 ? 'Equador' : formatLat(lat), x1 - 4, y - 2)
  }
  // meridians
  for (let lon = -180 + step * 2; lon < 180; lon += step * 2) {
    const x = (((lon + 180) / 360) * n - left) * z
    if (x < x0 || x > x1) continue
    ctx.beginPath()
    ctx.moveTo(Math.round(x) + 0.5, y0)
    ctx.lineTo(Math.round(x) + 0.5, y1)
    ctx.stroke()
    ctx.textAlign = 'left'
    ctx.textBaseline = 'bottom'
    ctx.fillText(formatLon(lon), x + 3, y1 - 4)
  }
  // (the scale bar belongs to the screen: once, however many copies of the map show)
  if (!bar) {
    ctx.restore()
    return
  }
  const steps = [100, 200, 250, 500, 1000, 2000, 5000]
  // the scale bar (bottom right)
  const barKm = steps.find((s) => s * pxPerKm >= 90) ?? 2000
  const barPx = barKm * pxPerKm
  const bx = width - barPx - 110
  const by = height - 24
  ctx.fillStyle = 'rgba(0, 0, 0, 0.45)'
  ctx.fillRect(bx - 8, by - 16, barPx + 16, 26)
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)'
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.moveTo(bx, by - 4)
  ctx.lineTo(bx, by)
  ctx.lineTo(bx + barPx, by)
  ctx.lineTo(bx + barPx, by - 4)
  ctx.moveTo(bx + barPx / 2, by)
  ctx.lineTo(bx + barPx / 2, by - 3)
  ctx.stroke()
  ctx.fillStyle = 'rgba(255, 255, 255, 0.9)'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'bottom'
  ctx.fillText(`${barKm} km (no equador)`, bx + barPx / 2, by - 5)
  ctx.restore()
}

/** One effect at its moment (see Effect): drawn over the map, fading as it ends. */
function drawEffect(ctx: Ctx, fx: Effect, toScreen: (x: number, y: number) => [number, number], z: number, time: number, width: number, height: number) {
  const t = (time - fx.t0) / fx.dur
  if (t < 0 || t > 1) return
  const [px, py] = toScreen(fx.x, fx.y)
  const R = Math.max(fx.r * z, 12)
  const fade = 1 - t
  // a stable pseudo-random per effect, for the particles
  const rnd = (k: number) => {
    const v = Math.sin((fx.t0 * 1000 + k * 12.9898) * 43758.5453)
    return v - Math.floor(v)
  }
  ctx.save()
  switch (fx.kind) {
    case 'impact': {
      // the flash, the fireball and the shockwave running out
      if (t < 0.15) {
        ctx.fillStyle = `rgba(255, 250, 230, ${0.5 * (1 - t / 0.15)})`
        ctx.fillRect(0, 0, width, height)
      }
      const fire = ctx.createRadialGradient(px, py, 0, px, py, R * (0.6 + t))
      fire.addColorStop(0, `rgba(255, 240, 200, ${fade})`)
      fire.addColorStop(0.4, `rgba(255, 140, 40, ${0.8 * fade})`)
      fire.addColorStop(1, 'rgba(120, 40, 10, 0)')
      ctx.fillStyle = fire
      ctx.beginPath()
      ctx.arc(px, py, R * (0.6 + t), 0, Math.PI * 2)
      ctx.fill()
      ctx.strokeStyle = `rgba(255, 255, 255, ${0.8 * fade})`
      ctx.lineWidth = 3 * fade + 1
      ctx.beginPath()
      ctx.arc(px, py, R * (0.5 + 3 * t), 0, Math.PI * 2)
      ctx.stroke()
      break
    }
    case 'eruption': {
      // the glow at the vent and ash puffs rising and drifting
      const glow = ctx.createRadialGradient(px, py, 0, px, py, R)
      glow.addColorStop(0, `rgba(255, 170, 60, ${0.7 * fade * (0.7 + 0.3 * Math.sin(time * 9))})`)
      glow.addColorStop(1, 'rgba(255, 80, 20, 0)')
      ctx.fillStyle = glow
      ctx.beginPath()
      ctx.arc(px, py, R, 0, Math.PI * 2)
      ctx.fill()
      for (let k = 0; k < 14; k++) {
        const age = (t * 3 + k / 14) % 1
        const ax = px + (rnd(k) - 0.3) * R * 0.6 + age * R * 1.2
        const ay = py - age * R * 2.2
        ctx.fillStyle = `rgba(70, 64, 60, ${0.55 * (1 - age) * fade})`
        ctx.beginPath()
        ctx.arc(ax, ay, R * (0.15 + 0.35 * age), 0, Math.PI * 2)
        ctx.fill()
      }
      break
    }
    case 'lightning': {
      // a bolt now and then inside the storm
      const slot = Math.floor(time * 6)
      const k = slot % 7
      if (rnd(slot) < 0.45) {
        const bx = px + (rnd(slot + 1) - 0.5) * R * 1.6
        let by = py - R * 0.8
        let x = bx
        ctx.strokeStyle = 'rgba(235, 240, 255, 0.95)'
        ctx.lineWidth = 2
        ctx.shadowColor = 'rgba(180, 200, 255, 0.9)'
        ctx.shadowBlur = 10
        ctx.beginPath()
        ctx.moveTo(x, by)
        for (let s = 0; s < 6; s++) {
          x += (rnd(slot * 7 + s + k) - 0.5) * R * 0.35
          by += R * 0.28
          ctx.lineTo(x, by)
        }
        ctx.stroke()
        ctx.fillStyle = 'rgba(220, 230, 255, 0.12)'
        ctx.fillRect(0, 0, width, height)
      }
      break
    }
    case 'quake':
    case 'rift': {
      // ripples running out from the epicentre
      for (let k = 0; k < 3; k++) {
        const tt = (t * 2 + k / 3) % 1
        ctx.strokeStyle = fx.kind === 'rift' ? `rgba(255, 150, 60, ${0.7 * (1 - tt) * fade})` : `rgba(255, 230, 180, ${0.7 * (1 - tt) * fade})`
        ctx.lineWidth = 2
        ctx.beginPath()
        ctx.arc(px, py, R * (0.2 + 1.6 * tt), 0, Math.PI * 2)
        ctx.stroke()
      }
      break
    }
    case 'sparkle':
    case 'inspire':
    case 'prophet':
    case 'plague': {
      // particles rising: gold (a blessing), blue (an idea), white (a prophet), green (a plague)
      const col = fx.kind === 'sparkle' ? '255, 215, 90' : fx.kind === 'inspire' ? '120, 200, 255' : fx.kind === 'prophet' ? '255, 255, 255' : '120, 200, 70'
      if (fx.kind === 'prophet') {
        const beam = ctx.createLinearGradient(px, py - R * 3, px, py)
        beam.addColorStop(0, `rgba(255, 255, 255, 0)`)
        beam.addColorStop(1, `rgba(255, 255, 230, ${0.6 * fade})`)
        ctx.fillStyle = beam
        ctx.fillRect(px - R * 0.25, py - R * 3, R * 0.5, R * 3)
      }
      for (let k = 0; k < 18; k++) {
        const a = rnd(k) * Math.PI * 2
        const d = R * (0.3 + 0.7 * rnd(k + 40)) * (fx.kind === 'plague' ? 0.8 + 0.4 * t : t + 0.2)
        const rise = fx.kind === 'plague' ? 0 : t * R * 1.2
        ctx.fillStyle = `rgba(${col}, ${(fx.kind === 'plague' ? 0.35 : 0.9) * fade})`
        ctx.beginPath()
        ctx.arc(px + Math.cos(a) * d, py + Math.sin(a) * d * 0.6 - rise, fx.kind === 'plague' ? R * 0.25 : 2.2, 0, Math.PI * 2)
        ctx.fill()
      }
      break
    }
    case 'war':
    case 'peace': {
      ctx.strokeStyle = fx.kind === 'war' ? `rgba(255, 70, 50, ${fade})` : `rgba(255, 255, 255, ${fade})`
      ctx.lineWidth = 3
      ctx.beginPath()
      ctx.arc(px, py, R * (0.4 + t * 1.4), 0, Math.PI * 2)
      ctx.stroke()
      if (fx.kind === 'war') {
        // crossed swords
        const s = R * 0.5
        ctx.beginPath()
        ctx.moveTo(px - s, py - s)
        ctx.lineTo(px + s, py + s)
        ctx.moveTo(px + s, py - s)
        ctx.lineTo(px - s, py + s)
        ctx.stroke()
      }
      break
    }
    case 'flare': {
      // the sun grows stronger (or weaker): the whole view warms (or cools) for a moment
      ctx.fillStyle = fx.r > 0 ? `rgba(255, 190, 80, ${0.25 * fade})` : `rgba(120, 170, 255, ${0.25 * fade})`
      ctx.fillRect(0, 0, width, height)
      break
    }
    case 'heat': {
      ctx.strokeStyle = `rgba(255, 170, 60, ${0.6 * fade})`
      ctx.setLineDash([6, 6])
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.arc(px, py, R * (0.9 + 0.1 * Math.sin(time * 6)), 0, Math.PI * 2)
      ctx.stroke()
      break
    }
    case 'missile': {
      // a ballistic arc from the launch site to the target, the trail behind the warhead
      const [bx, by] = toScreen(fx.tx ?? fx.x, fx.ty ?? fx.y)
      const lift = Math.hypot(bx - px, by - py) * 0.45 + 30
      const at = (u: number): [number, number] => [px + (bx - px) * u, py + (by - py) * u - Math.sin(u * Math.PI) * lift]
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)'
      ctx.lineWidth = 1.5
      ctx.beginPath()
      const tail = Math.max(0, t - 0.35)
      for (let k = 0; k <= 20; k++) {
        const [x, y] = at(tail + ((t - tail) * k) / 20)
        if (k) ctx.lineTo(x, y)
        else ctx.moveTo(x, y)
      }
      ctx.stroke()
      const [hx, hy] = at(t)
      ctx.fillStyle = 'rgba(255, 90, 60, 1)'
      ctx.shadowColor = 'rgba(255, 120, 80, 0.9)'
      ctx.shadowBlur = 8
      ctx.beginPath()
      ctx.arc(hx, hy, 2.6, 0, Math.PI * 2)
      ctx.fill()
      break
    }
    case 'nuke': {
      // the flash, the fireball, the shock wave and the mushroom cloud rising
      if (t < 0.06) {
        ctx.fillStyle = `rgba(255, 255, 255, ${0.85 * (1 - t / 0.06)})`
        ctx.fillRect(0, 0, width, height)
      }
      const ball = ctx.createRadialGradient(px, py, 0, px, py, R * (0.8 + t))
      ball.addColorStop(0, `rgba(255, 255, 230, ${fade})`)
      ball.addColorStop(0.35, `rgba(255, 190, 80, ${0.9 * fade})`)
      ball.addColorStop(1, 'rgba(160, 50, 20, 0)')
      ctx.fillStyle = ball
      ctx.beginPath()
      ctx.arc(px, py, R * (0.8 + t), 0, Math.PI * 2)
      ctx.fill()
      ctx.strokeStyle = `rgba(255, 255, 255, ${0.6 * fade})`
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.arc(px, py, R * (0.5 + 5 * t), 0, Math.PI * 2)
      ctx.stroke()
      if (t > 0.08) {
        const up = Math.min(1, (t - 0.08) * 2.5)
        const capY = py - R * 2.2 * up
        ctx.fillStyle = `rgba(150, 120, 100, ${0.75 * fade})`
        ctx.fillRect(px - R * 0.18, capY, R * 0.36, py - capY)
        const cap = ctx.createRadialGradient(px, capY, 0, px, capY, R * (0.6 + 0.6 * up))
        cap.addColorStop(0, `rgba(255, 170, 90, ${0.85 * fade})`)
        cap.addColorStop(0.5, `rgba(140, 110, 95, ${0.8 * fade})`)
        cap.addColorStop(1, 'rgba(90, 80, 75, 0)')
        ctx.fillStyle = cap
        ctx.beginPath()
        ctx.ellipse(px, capY, R * (0.7 + 0.6 * up), R * (0.4 + 0.3 * up), 0, 0, Math.PI * 2)
        ctx.fill()
      }
      break
    }
    case 'tsunami': {
      // the wave: crests running out across the sea, white foam on the leading one
      for (let k = 0; k < 4; k++) {
        const tt = t - k * 0.06
        if (tt <= 0) continue
        const rr = R * tt
        ctx.strokeStyle = k === 0 ? `rgba(240, 250, 255, ${0.85 * fade})` : `rgba(120, 200, 235, ${0.5 * fade})`
        ctx.lineWidth = k === 0 ? 3 : 2
        ctx.beginPath()
        ctx.arc(px, py, rr, 0, Math.PI * 2)
        ctx.stroke()
      }
      break
    }
    case 'fireworks': {
      for (let b = 0; b < 6; b++) {
        const tb = t * 1.6 - b * 0.12
        if (tb < 0 || tb > 1) continue
        const cx = width * (0.2 + 0.6 * rnd(b + 3))
        const cy = height * (0.2 + 0.4 * rnd(b + 9))
        const hue = Math.floor(rnd(b + 17) * 360)
        for (let k = 0; k < 24; k++) {
          const a = (k / 24) * Math.PI * 2
          const d = 90 * tb
          ctx.fillStyle = `hsla(${hue}, 90%, 65%, ${1 - tb})`
          ctx.beginPath()
          ctx.arc(cx + Math.cos(a) * d, cy + Math.sin(a) * d + tb * tb * 30, 2.5, 0, Math.PI * 2)
          ctx.fill()
        }
      }
      break
    }
  }
  ctx.restore()
}

/** A plate's own colour (from its grid cell). */
function plateHue(c: [number, number]): [number, number, number] {
  const h = ((Math.imul(c[0] + 31, 2654435761) ^ Math.imul(c[1] + 17, 40503)) >>> 0) / 4294967295
  const a = h * Math.PI * 2
  return [150 + 80 * Math.cos(a), 150 + 80 * Math.cos(a + 2.1), 150 + 80 * Math.cos(a + 4.2)]
}

/** An arrow from (ax, ay) to (bx, by), outlined in black. */
function arrow(ctx: Ctx, ax: number, ay: number, bx: number, by: number, color: string, width: number) {
  const len = Math.hypot(bx - ax, by - ay)
  if (len < 1) return
  const ux = (bx - ax) / len
  const uy = (by - ay) / len
  const head = Math.min(10, len * 0.4)
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.beginPath()
  ctx.moveTo(ax, ay)
  ctx.lineTo(bx, by)
  ctx.moveTo(bx - ux * head + uy * head * 0.6, by - uy * head - ux * head * 0.6)
  ctx.lineTo(bx, by)
  ctx.lineTo(bx - ux * head - uy * head * 0.6, by - uy * head + ux * head * 0.6)
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)'
  ctx.lineWidth = width + 2.5
  ctx.stroke()
  ctx.strokeStyle = color
  ctx.lineWidth = width
  ctx.stroke()
}

// ---- the sprites --------------------------------------------------------------------

function buildAtlas(): Canvas {
  const atlas = makeCanvas()
  atlas.width = KINDS.length * VARIANTS * SPR
  atlas.height = SPR
  const ctx = context2d(atlas)
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

function drawSprite(ctx: Ctx, kind: Kind, j: number) {
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

/** A town, a party, a herd, a ruin, a boat, a battle or a dam, at a screen point. */
function drawMarker(ctx: Ctx, m: LifeMarker, px: number, py: number, z: number, time: number) {
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
      // a sailing ship, a steamship with its smoke, or a long cargo ship
      const L = u * (m.flag === 2 ? 0.75 : 0.45)
      const W = u * (m.flag === 2 ? 0.22 : 0.2)
      ctx.fillStyle = m.flag === 2 ? '#3b4a5c' : m.flag === 1 ? '#2b2b2b' : '#6b4a2a'
      ctx.beginPath()
      ctx.moveTo(px + dx * L, py + dy * L)
      ctx.lineTo(px - dy * W - dx * L * 0.7, py + dx * W - dy * L * 0.7)
      ctx.lineTo(px + dy * W - dx * L * 0.7, py - dx * W - dy * L * 0.7)
      ctx.closePath()
      ctx.fill()
      if (m.flag === 0) {
        ctx.fillStyle = civCss(m.color)
        ctx.beginPath()
        ctx.moveTo(px, py)
        ctx.lineTo(px, py - u * 0.5)
        ctx.lineTo(px + u * 0.3, py - u * 0.2)
        ctx.closePath()
        ctx.fill()
      } else if (m.flag === 1) {
        ctx.fillStyle = civCss(m.color)
        ctx.fillRect(px - u * 0.06, py - u * 0.35, u * 0.12, u * 0.3)
        ctx.fillStyle = 'rgba(200, 200, 200, 0.5)'
        ctx.beginPath()
        ctx.arc(px - dx * u * 0.3 + Math.sin(time * 3) * u * 0.05, py - u * 0.5 - dy * u * 0.3, u * 0.18, 0, Math.PI * 2)
        ctx.fill()
      } else {
        // the containers, in rows of colours
        const cols = ['#c0392b', '#2980b9', '#e0a030', '#27ae60']
        for (let k = 0; k < 4; k++) {
          const t = -0.45 + k * 0.28
          ctx.fillStyle = cols[(k + m.color) % 4]
          ctx.fillRect(px + dx * L * t - u * 0.07, py + dy * L * t - u * 0.07, u * 0.14, u * 0.14)
        }
      }
      break
    }
    case 'plane': {
      drawPlane(ctx, m, px, py, u, false)
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
