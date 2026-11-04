// The tile world: a small grid simulated on the CPU with simple rules (WorldBox-style), so
// it runs anywhere. Temperature from latitude and height, vapour carried by the wind that
// rains out where it is over capacity (and against the slopes it is pushed up), water that
// pools and drains, rivers by flow accumulation, vegetation, snow, ice, sand, lava, fire.
// The state is kept in the same layout the peoples' layer (Life) reads from the 3D game
// (a Field: 4 floats per cell), so the civilizations run unchanged on top of it.

import type { Field } from '../engine/engine'
import { fbm, hash2 } from './noise'

export interface WorldOptions {
  seed: number
  /** Tiles per side. */
  size: number
  /** 0: one landmass, 1: islands. */
  islands: number
  /** Height units above the generated zero that the sea reaches. */
  seaLevel: number
  /** °C added everywhere. */
  temperature: number
  /** Degrees: 0 blows east, 90 south. */
  windDirection: number
  /** 0–1.5: tiles per tick at 1. */
  windSpeed: number
  /** 0–1: humidity of the air blowing in, as a share of what it can hold. */
  windHumidity: number
}

export const DEFAULT_WORLD: WorldOptions = {
  seed: 1,
  size: 192,
  islands: 0.3,
  seaLevel: 0,
  temperature: 0,
  windDirection: 0,
  windSpeed: 0.6,
  windHumidity: 0.7,
}

/** Simulated seconds per tick; the peoples' year is ten simulated seconds. */
export const TICK = 0.05
/** °C colder per height unit. */
export const LAPSE = 100
/** Share of the vapour over capacity that rains out per tick anywhere, and extra on an upslope. */
const CONDENSATION = 0.5
const OROGRAPHIC = 0.35
/** Share of the vapour above 80% of capacity that rains out of warm humid air over land (convection). */
const CONVECTION = 0.12
/** Height units of water a unit of rain leaves on the ground. */
const RUNOFF = 0.004
const EVAPORATION = 0.00012
const WIND_TILES = 1.0
const STORM_LIFE = 1800
const RIVER_EVERY = 20
/** Flow accumulation (rain units drained) from which a stream shows as a river. */
const RIVER_MIN = 12

export interface Vent {
  x: number
  y: number
  strength: number
  left: number
}
export interface Storm {
  x: number
  y: number
  r: number
  age: number
}
export interface Drought {
  x: number
  y: number
  r: number
}

/** How much vapour air at t °C holds before it rains (1 at 15 °C). */
export const capacity = (t: number) => Math.exp(0.065 * (Math.min(Math.max(t, -40), 50) - 15))
const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v)
const smooth = (v: number, a: number, b: number) => {
  const t = clamp((v - a) / (b - a), 0, 1)
  return t * t * (3 - 2 * t)
}

export class TileWorld {
  readonly n: number
  /** Per tile: height, rock, soil, sand (0–1, how much the surface is sand). */
  readonly ground: Float32Array
  /** Per tile: water depth (pools plus river), flux x, flux y, river depth. */
  readonly water: Float32Array
  /** Per tile: vegetation 0–1, soil water 0–1, snow 0–1, ice. */
  readonly extra: Float32Array
  /** Per tile: painted temperature offset, relative humidity, long-run rain (1 typical), temperature °C. */
  readonly climate: Float32Array
  /** Per tile: lava thickness, lava heat, vent, unused. */
  readonly lava: Float32Array
  /** Vapour in the air per tile (1 = what air at 15 °C holds). */
  readonly q: Float32Array
  private readonly qTmp: Float32Array
  /** Rain this tick per tile. */
  readonly rain: Float32Array
  /** Burning, 0–1. */
  readonly fire: Float32Array
  private readonly fireTmp: Float32Array
  /** The water that pools and flows (the river depth is added on top for the Field). */
  private readonly pool: Float32Array
  private readonly poolTmp: Float32Array
  private readonly lavaTmp: Float32Array
  /** Flow accumulation: how much rain drains through each tile (rivers). */
  readonly acc: Float32Array
  private readonly order: Uint32Array
  /** Per tile, 0–1: how much a decreed drought (a fixed high) covers it. */
  readonly droughtCover: Float32Array
  /** Per tile, 0–1: how much a storm (a moving low) covers it. */
  readonly stormCover: Float32Array
  /** The heights at the reference (the new world, or the last reset), for the change map. */
  readonly reference: Float32Array
  readonly field: Field
  opts: WorldOptions
  /** Simulated seconds. */
  time = 0
  ticks = 0
  /** °C the sun power added to the planet. */
  sun = 0
  /** °C of cooling from dust in the air (strikes), decaying. */
  dust = 0
  vents: Vent[] = []
  storms: Storm[] = []
  droughts: Drought[] = []
  /** Mean temperature and the shares of the land under forest, desert, snow, water (refreshed with the rivers). */
  summary = { meanTemp: 15, forest: 0, desert: 0, snow: 0, water: 0, land: 0 }

  constructor(opts: WorldOptions) {
    this.opts = { ...opts }
    const n = (this.n = opts.size)
    const cells = n * n
    this.ground = new Float32Array(cells * 4)
    this.water = new Float32Array(cells * 4)
    this.extra = new Float32Array(cells * 4)
    this.climate = new Float32Array(cells * 4)
    this.lava = new Float32Array(cells * 4)
    this.q = new Float32Array(cells)
    this.qTmp = new Float32Array(cells)
    this.rain = new Float32Array(cells)
    this.fire = new Float32Array(cells)
    this.fireTmp = new Float32Array(cells)
    this.pool = new Float32Array(cells)
    this.poolTmp = new Float32Array(cells)
    this.lavaTmp = new Float32Array(cells)
    this.acc = new Float32Array(cells)
    this.order = new Uint32Array(cells)
    this.droughtCover = new Float32Array(cells)
    this.stormCover = new Float32Array(cells)
    this.reference = new Float32Array(cells)
    this.field = { size: n, origin: [0, 0], climate: this.climate, water: this.water, extra: this.extra, lava: this.lava, ground: this.ground }
    this.generate()
  }

  // ---- generation ---------------------------------------------------------------------

  generate() {
    const n = this.n
    const o = this.opts
    const s = o.seed
    const g = this.ground
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const i = y * n + x
        const nx = x / n
        const ny = y / n
        const cont = fbm(nx * 1.6 + 0.3, ny * 1.6 + 0.7, s + 1, 4)
        const detail = fbm(nx * 5, ny * 5, s + 2, 6)
        const ridge = 1 - Math.abs(2 * fbm(nx * 3.5 + 9, ny * 3.5 + 4, s + 3, 5) - 1)
        // islands: the sea reaches in from the edges and the land breaks up
        const edge = Math.min(nx, 1 - nx, ny, 1 - ny)
        const rim = o.islands * (1 - smooth(edge, 0.02, 0.2)) * 0.3
        const land = (cont - 0.5) * 0.9 + (detail - 0.5) * 0.4 + 0.17 - o.islands * 0.25 - rim
        g[i * 4] = land * 0.18 + Math.max(0, land) * ridge * ridge * 0.22
      }
    }
    // the sea reaches a set share of the map whatever the seed: the heights are shifted so
    // that share lies below zero (more with islands), then the sea level asked for
    const sorted = Float32Array.from({ length: n * n }, (_, i) => g[i * 4]).sort()
    const shift = sorted[Math.floor((0.42 + 0.25 * o.islands) * n * n)] + o.seaLevel
    for (let i = 0; i < n * n; i++) {
      const h = Math.max(g[i * 4] - shift, -0.12)
      const soil = h > 0 && h < 0.16 ? 0.01 : 0
      g[i * 4] = h
      g[i * 4 + 1] = h - soil
      g[i * 4 + 2] = soil
      g[i * 4 + 3] = 0
      this.pool[i] = h < 0 ? -h : 0
    }
    this.extra.fill(0)
    this.climate.fill(0)
    this.lava.fill(0)
    this.fire.fill(0)
    this.q.fill(0)
    this.acc.fill(0)
    this.vents = []
    this.storms = []
    this.droughts = []
    this.droughtCover.fill(0)
    this.sun = 0
    this.dust = 0
    this.time = 0
    this.ticks = 0
    this.temperatures()
    // the land starts green where it is warm enough, moister towards the coasts
    for (let i = 0; i < n * n; i++) {
      const h = g[i * 4]
      const t = this.climate[i * 4 + 3]
      const moist = fbm((i % n) / n * 4, Math.floor(i / n) / n * 4, s + 5, 4)
      const v = h > 0 && h < 0.2 ? smooth(t, 2, 10) * (1 - smooth(t, 32, 40)) * (0.25 + 0.6 * moist) : 0
      this.extra[i * 4] = v
      this.extra[i * 4 + 1] = v * 0.6
      this.q[i] = capacity(t) * o.windHumidity
      this.climate[i * 4 + 1] = o.windHumidity
      this.climate[i * 4 + 2] = 0.5 + moist
    }
    this.rivers()
    this.writeWater()
    this.resetChange()
  }

  /** Takes the heights of now as the reference the change map counts from. */
  resetChange() {
    const g = this.ground
    for (let i = 0; i < this.n * this.n; i++) this.reference[i] = g[i * 4]
  }

  // ---- the tick -----------------------------------------------------------------------

  /** One tick of TICK simulated seconds. */
  tick() {
    this.temperatures()
    this.air()
    this.flow()
    this.ground_()
    this.lavaFlow()
    this.burn()
    if (this.ticks % RIVER_EVERY === 0) this.rivers()
    this.writeWater()
    this.dust = Math.max(0, this.dust - 0.0008)
    this.driftStorms()
    this.ticks++
    this.time += TICK
  }

  private temperatures() {
    const n = this.n
    const c = this.climate
    const g = this.ground
    const base = 15 + this.opts.temperature + this.sun - this.dust
    for (let y = 0; y < n; y++) {
      const lat = 16 * (0.5 - y / n)
      for (let x = 0; x < n; x++) {
        const i = y * n + x
        const h = g[i * 4]
        const surface = Math.max(h, 0)
        c[i * 4 + 3] = base + lat - LAPSE * surface + c[i * 4]
      }
    }
  }

  /** Vapour: carried by the wind, fed by water and plants, rained out over capacity. */
  private air() {
    const n = this.n
    const o = this.opts
    const q = this.q
    const qt = this.qTmp
    const c = this.climate
    const g = this.ground
    const e = this.extra
    const w = this.water
    const rain = this.rain
    const ang = (o.windDirection * Math.PI) / 180
    const wx = Math.cos(ang) * o.windSpeed * WIND_TILES
    const wy = Math.sin(ang) * o.windSpeed * WIND_TILES
    // advection from upwind (bilinear), fresh air at the upwind border
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const i = y * n + x
        const sx = x - wx
        const sy = y - wy
        if (sx < 0 || sy < 0 || sx > n - 1 || sy > n - 1) {
          qt[i] = o.windHumidity * capacity(c[i * 4 + 3])
          continue
        }
        const x0 = Math.floor(sx)
        const y0 = Math.floor(sy)
        const fx = sx - x0
        const fy = sy - y0
        const x1 = Math.min(x0 + 1, n - 1)
        const y1 = Math.min(y0 + 1, n - 1)
        qt[i] = (q[y0 * n + x0] * (1 - fx) + q[y0 * n + x1] * fx) * (1 - fy) + (q[y1 * n + x0] * (1 - fx) + q[y1 * n + x1] * fx) * fy
      }
    }
    // a little mixing, then sources, condensation and rain
    const ux = Math.abs(wx) > 1e-6 || Math.abs(wy) > 1e-6 ? Math.round(-Math.sign(wx) * (Math.abs(wx) >= Math.abs(wy) ? 1 : 0)) : 0
    const uy = Math.abs(wx) > 1e-6 || Math.abs(wy) > 1e-6 ? Math.round(-Math.sign(wy) * (Math.abs(wy) > Math.abs(wx) ? 1 : 0)) : 0
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const i = y * n + x
        const xm = x > 0 ? i - 1 : i
        const xp = x < n - 1 ? i + 1 : i
        const ym = y > 0 ? i - n : i
        const yp = y < n - 1 ? i + n : i
        let v = qt[i] * 0.88 + (qt[xm] + qt[xp] + qt[ym] + qt[yp]) * 0.03
        const t = c[i * 4 + 3]
        const drought = this.droughtCover[i]
        const storm = this.stormCover[i]
        const cap = capacity(t) * (1 + 0.6 * drought) * (1 - 0.25 * storm)
        const depth = w[i * 4]
        const ice = e[i * 4 + 3]
        if (depth > 0.0005) {
          // open water breathes vapour into the air (frozen water hardly any)
          v += (0.82 * cap - v) * 0.02 * (ice > 0 ? 0.1 : 1)
        } else {
          // plants transpire the soil's water
          const give = Math.min(e[i * 4 + 1], 0.01 * e[i * 4] * cap)
          v += give
          e[i * 4 + 1] -= give * 0.25
        }
        // under a decreed drought the air sinks and dries
        if (drought > 0) v = Math.min(v, Math.max(v - 0.01 * drought * cap, 0.45 * cap))
        let r = 0
        const excess = v - cap
        if (excess > 0) {
          r = excess * CONDENSATION
          v -= r
        }
        // pushed up a slope by the wind, humid air wrings out before the crest
        // (the slope over two tiles, so one bumpy tile does not switch the rule on and off)
        const up = g[i * 4] - g[(clamp(y + 2 * uy, 0, n - 1) * n + clamp(x + 2 * ux, 0, n - 1)) * 4]
        if (up > 0.0015 && v > 0.7 * cap) {
          const r2 = (v - 0.7 * cap) * OROGRAPHIC * Math.min(1, up * 60)
          v -= r2
          r += r2
        }
        // warm humid air over land bubbles up into showers
        if (v > 0.8 * cap && g[i * 4] >= 0) {
          const r3 = (v - 0.8 * cap) * CONVECTION * smooth(t, 5, 25)
          v -= r3
          r += r3
        }
        if (storm > 0) r += 0.02 * cap * storm
        r *= 1 - 0.95 * drought
        q[i] = Math.max(v, 0)
        rain[i] = r
        c[i * 4 + 1] = q[i] / cap
      }
    }
    // the long-run rain, from the rain blurred over the neighbours: the slope rule picks
    // single tiles, and the sharp pattern would otherwise print on the maps and the soil
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const i = y * n + x
        const rs = 0.5 * rain[i] + 0.125 * (rain[x > 0 ? i - 1 : i] + rain[x < n - 1 ? i + 1 : i] + rain[y > 0 ? i - n : i] + rain[y < n - 1 ? i + n : i])
        c[i * 4 + 2] += (rs * 40 - c[i * 4 + 2]) * 0.004
      }
    }
  }

  /** Water: rain pools on the land and flows downhill, the sea stays put, pools evaporate. */
  private flow() {
    const n = this.n
    const g = this.ground
    const p = this.pool
    const pt = this.poolTmp
    const w = this.water
    const c = this.climate
    const e = this.extra
    const rain = this.rain
    const sea = this.opts.seaLevel * 0
    pt.set(p)
    for (let i = 0; i < n * n; i++) {
      w[i * 4 + 1] = 0
      w[i * 4 + 2] = 0
    }
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const i = y * n + x
        const h = g[i * 4]
        const land = h >= sea
        if (land) {
          // rain soaks the soil and the rest runs off
          const r = rain[i]
          e[i * 4 + 1] = clamp(e[i * 4 + 1] + r * 6 - 0.0008 - 0.0015 * e[i * 4], 0, 1)
          pt[i] += r * RUNOFF
          // the pool evaporates, faster when warm
          const d = pt[i]
          if (d > 0) pt[i] = Math.max(0, d - EVAPORATION * (0.5 + capacity(c[i * 4 + 3])))
        }
        const d = p[i]
        if (d <= 1e-6) continue
        const S = h + d
        // down to the lower neighbours, a share of the difference
        let total = 0
        let gx = 0
        let gy = 0
        const give = (j: number, dirx: number, diry: number) => {
          const dS = S - (g[j * 4] + p[j])
          if (dS <= 0) return
          const f = Math.min(d * 0.25, dS * 0.2)
          pt[i] -= f
          pt[j] += f
          total += f
          gx += f * dirx
          gy += f * diry
        }
        if (x > 0) give(i - 1, -1, 0)
        if (x < n - 1) give(i + 1, 1, 0)
        if (y > 0) give(i - n, 0, -1)
        if (y < n - 1) give(i + n, 0, 1)
        w[i * 4 + 1] = gx
        w[i * 4 + 2] = gy
        void total
      }
    }
    for (let i = 0; i < n * n; i++) {
      const h = g[i * 4]
      // the sea is bottomless: whatever drains into it is gone, and it never runs dry
      p[i] = h < sea ? sea - h : Math.max(pt[i], 0)
    }
  }

  /** Rivers by flow accumulation, and the slow erosion along them. */
  private rivers() {
    const n = this.n
    const g = this.ground
    const p = this.pool
    const c = this.climate
    const acc = this.acc
    const order = this.order
    const cells = n * n
    for (let i = 0; i < cells; i++) order[i] = i
    const surface = (i: number) => g[i * 4] + p[i]
    // highest first (a typed-array sort on a key: by surface, descending)
    const keys = new Float32Array(cells)
    for (let i = 0; i < cells; i++) keys[i] = -surface(i)
    order.sort((a, b) => keys[a] - keys[b])
    acc.fill(0)
    for (let k = 0; k < cells; k++) {
      const i = order[k]
      const x = i % n
      const y = (i - x) / n
      acc[i] += Math.max(c[i * 4 + 2], 0.05)
      if (g[i * 4] < 0) continue
      const S = surface(i)
      let best = -1
      let bestS = S
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue
          const xx = x + dx
          const yy = y + dy
          if (xx < 0 || yy < 0 || xx >= n || yy >= n) continue
          const j = yy * n + xx
          const Sj = surface(j)
          if (Sj < bestS) {
            bestS = Sj
            best = j
          }
        }
      }
      if (best >= 0) {
        acc[best] += acc[i]
        // rivers cut into the land where they run fast
        const slope = S - bestS
        if (acc[i] > 40 && slope > 0.001) {
          const cut = Math.min(0.00002 * Math.min(acc[i] / 60, 6) * Math.min(slope * 100, 1), 0.00008)
          g[i * 4] -= cut
          g[i * 4 + 1] -= cut
        }
      }
    }
    // the summary for the panel
    let temp = 0
    let forest = 0
    let desert = 0
    let snow = 0
    let water = 0
    let land = 0
    for (let i = 0; i < cells; i++) {
      temp += c[i * 4 + 3]
      if (g[i * 4] < 0 || p[i] > 0.002) {
        water++
        continue
      }
      land++
      if (this.extra[i * 4] > 0.6) forest++
      if (g[i * 4 + 3] > 0.5) desert++
      if (this.extra[i * 4 + 2] > 0.5) snow++
    }
    this.summary = { meanTemp: temp / cells, forest: forest / Math.max(land, 1), desert: desert / Math.max(land, 1), snow: snow / Math.max(land, 1), water: water / cells, land: land / cells }
  }

  /** The Field's water: pools plus the rivers. */
  private writeWater() {
    const n = this.n
    const w = this.water
    const p = this.pool
    const acc = this.acc
    const g = this.ground
    for (let i = 0; i < n * n; i++) {
      const a = acc[i]
      const river = g[i * 4] >= 0 && a > RIVER_MIN && p[i] < 0.002 ? Math.min(0.004, 0.0008 + 0.00025 * Math.sqrt(a - RIVER_MIN)) : 0
      w[i * 4 + 3] = river
      w[i * 4] = p[i] + river
    }
  }

  /** Vegetation, snow, ice and sand follow the climate. */
  private ground_() {
    const n = this.n
    const g = this.ground
    const e = this.extra
    const c = this.climate
    const w = this.water
    const l = this.lava
    const fire = this.fire
    for (let i = 0; i < n * n; i++) {
      const t = c[i * 4 + 3]
      const depth = w[i * 4]
      const wet = depth > 0.002
      // the soil water the plants see is shared with the neighbours (groundwater), which
      // keeps a forest tile from drying its own soil while the bare tile next to it soaks
      const x = i % n
      const soil = 0.5 * e[i * 4 + 1] + 0.125 * (e[(x > 0 ? i - 1 : i) * 4 + 1] + e[(x < n - 1 ? i + 1 : i) * 4 + 1] + e[(i >= n ? i - n : i) * 4 + 1] + e[(i < n * n - n ? i + n : i) * 4 + 1])
      const m = clamp(soil * 1.3 + c[i * 4 + 2] * 0.25, 0, 1)
      let target = smooth(t, 2, 10) * (1 - smooth(t, 34, 42)) * smooth(m, 0.08, 0.5)
      if (wet || l[i * 4] > 0.0002 || fire[i] > 0 || t < -2 || g[i * 4] < 0) target = 0
      const v = e[i * 4]
      e[i * 4] = v + (target - v) * (target > v ? 0.004 : 0.02)
      // snow on cold land, ice on cold water
      if (!wet && g[i * 4] >= 0) e[i * 4 + 2] = t < 0 ? Math.min(1, e[i * 4 + 2] + 0.05) : Math.max(0, e[i * 4 + 2] - 0.03)
      else e[i * 4 + 2] = 0
      e[i * 4 + 3] = (wet || g[i * 4] < 0) && t < -2 ? 0.001 : 0
      // hot dry bare land turns to sand
      const sandy = t > 22 && m < 0.12 && v < 0.05 && !wet && g[i * 4] >= 0
      g[i * 4 + 3] = clamp(g[i * 4 + 3] + (sandy ? 0.002 : -0.001), 0, 1)
    }
  }

  /** Lava from the vents spreads downhill, cools into rock, burns what it touches. */
  private lavaFlow() {
    const n = this.n
    const l = this.lava
    const lt = this.lavaTmp
    const g = this.ground
    const e = this.extra
    for (let k = this.vents.length - 1; k >= 0; k--) {
      const v = this.vents[k]
      const i = v.y * n + v.x
      l[i * 4] += v.strength * 0.003
      l[i * 4 + 2] = v.strength
      v.left--
      if (v.left <= 0) {
        l[i * 4 + 2] = 0
        this.vents.splice(k, 1)
      }
    }
    let any = false
    for (let i = 0; i < n * n; i++) {
      lt[i] = l[i * 4]
      if (lt[i] > 0.0003) any = true
    }
    if (!any) return
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const i = y * n + x
        const d = l[i * 4]
        if (d <= 0.0003) continue
        const S = g[i * 4] + d
        const give = (j: number) => {
          const dS = S - (g[j * 4] + l[j * 4])
          if (dS <= 0) return
          const f = Math.min(d * 0.2, dS * 0.3)
          lt[i] -= f
          lt[j] += f
        }
        if (x > 0) give(i - 1)
        if (x < n - 1) give(i + 1)
        if (y > 0) give(i - n)
        if (y < n - 1) give(i + n)
      }
    }
    for (let i = 0; i < n * n; i++) {
      let d = Math.max(lt[i], 0)
      if (d <= 0) {
        l[i * 4] = 0
        continue
      }
      // cooling: the lava turns to rock, and the ground grows
      const cool = d * 0.015
      d -= cool
      g[i * 4] += cool
      g[i * 4 + 1] += cool
      l[i * 4] = d < 0.00005 ? 0 : d
      l[i * 4 + 1] = 1
      if (d > 0.0002) {
        e[i * 4] *= 0.6
        e[i * 4 + 1] = 0
        e[i * 4 + 2] = 0
        this.pool[i] = Math.max(this.pool[i] - d, 0)
        // the forest next to it catches fire
        const x = i % n
        if (x > 0 && e[(i - 1) * 4] > 0.3 && Math.random() < 0.02) this.fire[i - 1] = 1
        if (x < n - 1 && e[(i + 1) * 4] > 0.3 && Math.random() < 0.02) this.fire[i + 1] = 1
      }
    }
  }

  /** Fire eats the vegetation and spreads downwind through dry forest; rain puts it out. */
  private burn() {
    const n = this.n
    const f = this.fire
    const ft = this.fireTmp
    const e = this.extra
    const rain = this.rain
    const w = this.water
    let any = false
    for (let i = 0; i < n * n; i++) if (f[i] > 0) any = true
    if (!any) return
    ft.set(f)
    const ang = (this.opts.windDirection * Math.PI) / 180
    const wx = Math.cos(ang)
    const wy = Math.sin(ang)
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const i = y * n + x
        const b = f[i]
        if (b <= 0) continue
        const v = e[i * 4]
        e[i * 4] = Math.max(0, v - 0.08 * b)
        e[i * 4 + 1] = Math.max(0, e[i * 4 + 1] - 0.05)
        ft[i] = v < 0.05 || rain[i] > 0.02 ? 0 : Math.max(0, b - 0.02)
        const spread = (j: number, dx: number, dy: number) => {
          if (f[j] > 0 || ft[j] > 0 || e[j * 4] < 0.2 || w[j * 4] > 0.002 || rain[j] > 0.01) return
          const downwind = 1 + 2 * Math.max(0, dx * wx + dy * wy)
          if (Math.random() < 0.06 * e[j * 4] * (1 - 0.8 * e[j * 4 + 1]) * downwind * b) ft[j] = 1
        }
        if (x > 0) spread(i - 1, -1, 0)
        if (x < n - 1) spread(i + 1, 1, 0)
        if (y > 0) spread(i - n, 0, -1)
        if (y < n - 1) spread(i + n, 0, 1)
      }
    }
    f.set(ft)
  }

  private driftStorms() {
    if (!this.storms.length) {
      if (this.stormCover[0] !== 0 || this.stormCoverDirty) {
        this.stormCover.fill(0)
        this.stormCoverDirty = false
      }
      return
    }
    const ang = (this.opts.windDirection * Math.PI) / 180
    const move = this.opts.windSpeed * WIND_TILES * 0.5
    for (const s of this.storms) {
      s.x += Math.cos(ang) * move
      s.y += Math.sin(ang) * move
      s.age++
    }
    const n = this.n
    this.storms = this.storms.filter((s) => s.age < STORM_LIFE && s.x > -s.r && s.y > -s.r && s.x < n + s.r && s.y < n + s.r)
    this.stormCover.fill(0)
    this.stormCoverDirty = true
    for (const s of this.storms) {
      const strength = s.age < 100 ? s.age / 100 : s.age > STORM_LIFE - 400 ? (STORM_LIFE - s.age) / 400 : 1
      this.disc(this.stormCover, s.x, s.y, s.r, strength)
    }
  }
  private stormCoverDirty = false

  /** Adds a soft disc (1 at the centre, 0 at the edge) to a per-tile cover. */
  private disc(cover: Float32Array, cx: number, cy: number, r: number, strength: number) {
    const n = this.n
    const x0 = Math.max(0, Math.floor(cx - r))
    const x1 = Math.min(n - 1, Math.ceil(cx + r))
    const y0 = Math.max(0, Math.floor(cy - r))
    const y1 = Math.min(n - 1, Math.ceil(cy + r))
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const d = Math.hypot(x - cx, y - cy) / r
        if (d >= 1) continue
        const i = y * n + x
        cover[i] = Math.max(cover[i], (1 - smooth(d, 0.5, 1)) * strength)
      }
    }
  }

  private refreshDroughts() {
    this.droughtCover.fill(0)
    for (const d of this.droughts) this.disc(this.droughtCover, d.x, d.y, d.r, 1)
  }

  // ---- the powers ---------------------------------------------------------------------

  /** Raises (or lowers) the land in a disc, height units at the centre. */
  raise(cx: number, cy: number, r: number, amount: number) {
    this.brush(cx, cy, r, (i, cover) => {
      const g = this.ground
      const dh = amount * cover
      g[i * 4] = Math.max(g[i * 4] + dh, -0.12)
      g[i * 4 + 1] = g[i * 4] - g[i * 4 + 2]
      if (g[i * 4] < 0) this.pool[i] = -g[i * 4]
      else if (dh > 0 && this.pool[i] > 0) this.pool[i] = Math.max(0, this.pool[i] - dh)
    })
  }

  /** Adds (or takes) pooled water in a disc. */
  pour(cx: number, cy: number, r: number, amount: number) {
    this.brush(cx, cy, r, (i, cover) => {
      if (this.ground[i * 4] < 0) return
      this.pool[i] = Math.max(0, this.pool[i] + amount * cover)
    })
  }

  /** Grows (or clears) the vegetation in a disc. */
  plant(cx: number, cy: number, r: number, amount: number) {
    this.brush(cx, cy, r, (i, cover) => {
      const e = this.extra
      if (this.water[i * 4] > 0.002 || this.ground[i * 4] < 0) return
      e[i * 4] = clamp(e[i * 4] + amount * cover, 0, 1)
      if (amount > 0) e[i * 4 + 1] = clamp(e[i * 4 + 1] + amount * cover, 0, 1)
    })
  }

  /** Wets (or dries) the air in a disc, as a share of its capacity. */
  humidify(cx: number, cy: number, r: number, amount: number) {
    this.brush(cx, cy, r, (i, cover) => {
      const cap = capacity(this.climate[i * 4 + 3])
      this.q[i] = clamp(this.q[i] + amount * cap * cover, 0, 3 * cap)
    })
  }

  /** Warms (or cools) a region for good, °C at the centre. */
  heat(cx: number, cy: number, r: number, amount: number) {
    this.brush(cx, cy, r, (i, cover) => {
      this.climate[i * 4] = clamp(this.climate[i * 4] + amount * cover, -25, 25)
    })
  }

  /** Sets a region on fire. */
  ignite(cx: number, cy: number, r: number) {
    this.brush(cx, cy, r, (i) => {
      if (this.extra[i * 4] > 0.15 && this.water[i * 4] < 0.002) this.fire[i] = 1
    })
  }

  /** Opens a volcano: a vent that erupts for a while and builds a cone. */
  erupt(cx: number, cy: number, strength: number) {
    const x = clamp(Math.round(cx), 0, this.n - 1)
    const y = clamp(Math.round(cy), 0, this.n - 1)
    this.vents.push({ x, y, strength, left: Math.round(600 + 1200 * strength) })
    this.raise(cx, cy, 4, 0.02 * strength)
  }

  /** A strike: a crater, lava around it, fire, dust that cools the planet. */
  strike(cx: number, cy: number, r: number) {
    const depth = 0.05 * Math.min(r / 8, 2)
    this.brush(cx, cy, r, (i, cover) => {
      const g = this.ground
      g[i * 4] = Math.max(g[i * 4] - depth * cover, -0.12)
      g[i * 4 + 1] = g[i * 4] - g[i * 4 + 2]
      this.extra[i * 4] = 0
      this.extra[i * 4 + 2] = 0
      this.pool[i] = g[i * 4] < 0 ? -g[i * 4] : 0
      if (cover < 0.45 && cover > 0.1) this.lava[i * 4] += 0.002
    })
    this.brush(cx, cy, r * 1.6, (i, cover) => {
      if (cover < 0.6 && this.extra[i * 4] > 0.2 && Math.random() < 0.3) this.fire[i] = 1
    })
    this.dust = Math.min(this.dust + Math.min(0.3 * r, 6), 8)
    this.storms.push({ x: cx, y: cy, r: r * 3, age: 0 })
  }

  /** A storm: a moving low with rain under it. */
  storm(cx: number, cy: number, r: number) {
    this.storms = [...this.storms, { x: cx, y: cy, r, age: 0 }].slice(-4)
  }

  /** A decreed drought: a fixed high; or lifts the one at the place (returns whether one was lifted). */
  drought(cx: number, cy: number, r: number, lift: boolean): boolean {
    if (lift) {
      const k = this.droughts.findIndex((d) => Math.hypot(d.x - cx, d.y - cy) < d.r)
      if (k < 0) return false
      this.droughts.splice(k, 1)
    } else {
      this.droughts = [...this.droughts, { x: cx, y: cy, r }].slice(-6)
    }
    this.refreshDroughts()
    return true
  }

  private brush(cx: number, cy: number, r: number, fn: (i: number, cover: number) => void) {
    const n = this.n
    const x0 = Math.max(0, Math.floor(cx - r))
    const x1 = Math.min(n - 1, Math.ceil(cx + r))
    const y0 = Math.max(0, Math.floor(cy - r))
    const y1 = Math.min(n - 1, Math.ceil(cy + r))
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) / Math.max(r, 0.5)
        if (d >= 1) continue
        fn(y * n + x, 1 - smooth(d, 0.4, 1))
      }
    }
  }

  /** A hash per tile, for the sprites' variety. */
  jitter(i: number, salt = 0): number {
    return hash2(i % this.n, Math.floor(i / this.n), this.opts.seed + salt)
  }
}
