// The plates under the tile world, and continental drift. The plates are laid out from the
// land as on the Earth: every big continent rides whole on a plate of its own (the biggest
// on two), oceanic plates fill the seas between; a continental plate reaches out from its
// coast, some far (the boundary in mid-ocean, a passive margin as around the Atlantic), some
// barely past the shore (an active margin with a trench, as along the Andes); the boundaries
// follow the coasts and wander a little.
//
// Then the plates really move: a map of which plate every tile is on travels with the land,
// a tile at a time, carrying everything on it (rock, water, forests, snow, the peoples'
// towns and fields). Where a plate runs into another, oceanic crust dives under (a trench,
// volcanoes on the far side) and two continents pile up into a range; behind a plate new
// ocean floor opens (a ridge). A plate swallowed whole is gone; when too few are left a rift
// splits the biggest in two. Along the boundaries the land keeps rising or sinking by the 3D
// game's rules (platesShader). The drift speed says how fast; 0 holds everything still.

import type { BoundaryKind } from '../engine/plates'
import { fbm, hash2 } from './noise'
import { centreOf, wrap, wrapDelta } from './wrap'

/** World units across the map: the uplift's widths (from the 3D game) are in world units. */
export const WORLD_UNITS = 3
/** Tiles per tick a plate of unit speed drifts at drift 1: a tile every 3 s, half the map in ~5 min at 1×. */
const PLATE_TILES = 1 / 60
/** Ticks between moving the plates (all that are due move together, then the boundaries are worked out again). */
const MOVE_EVERY = 20
/** Height units per tick that a fully rising zone gains at drift 1 (a new range ~0.1 high in ~15 min at 1×). */
const UPLIFT_RATE = 4e-6
/** Where the rock stops rising (isostasy) and how fast it slumps back above the limit. */
const CRUST_SOFT = 0.17
const CRUST_MAX = 0.3
const COLLAPSE_RATE = 0.0003
/** How much a continental collision thickens the crust per step, and an ocean diving under a continent lifts its edge. */
const THICKEN = 0.003
const ARC = 0.001
/** Share of a squeezed-out continental tile's crust that goes into the range (the rest is the root, below). */
const OROGENY = 0.8
/** Height units of rock an oceanic tile diving under a continent adds to the volcanic range. */
const ARC_VOLUME = 0.004
/** Moves between continents breaking apart (at random, about), and the share of the map a continental plate needs to break. */
const RIFT_EVERY = 300
/** Share of the height step to a lower neighbour that slides down each move (see wearDown). */
const WEAR = 0.08
const RIFT_SIZE = 0.15
/** Each step two continents grind into each other, the plates involved slow down by this much (as India against Asia). */
const COLLISION_DRAG = 0.97
/** Sinking land (a rift on a continent) goes down this much slower than the sea floor. */
const LAND_SINK = 0.3
/** A rift on land (plates parting) sinks at this share of the sea floor's rate (the rest of the land sinks slower, LAND_SINK). */
const RIFT_SINK = 1
/** How fast new ocean floor ages (per tick at drift 1): old after ~40 s at 1×, by then ~0.09 below the sea. */
const FLOOR_AGEING = 0.0012
/** A landmass gets its own plate from this share of the map, two plates from the second. */
const CONTINENT_MIN = 0.012
const CONTINENT_SPLIT = 0.3
/** About this many plates in all (fewer on small maps), and the fewest before a rift splits one. */
const PLATES = 11
const MIN_PLATES = 7
/** A plate smaller than this share of the map is swallowed by its neighbours. */
const SWALLOWED = 0.004
/** How far the boundaries wander from the plain shape at the start, as a share of the map. */
const WARP = 0.045

export const BOUNDARY_NAMES: Record<BoundaryKind, string> = {
  convergent: 'placas colidindo',
  divergent: 'placas se afastando',
  transform: 'placas deslizando lado a lado',
}
const KINDS: BoundaryKind[] = ['convergent', 'divergent', 'transform']

export interface Site {
  /** [plate id, 1 continental / 0 oceanic]: the colour key. */
  cell: [number, number]
  continental: boolean
  alive: boolean
  /** The plate's centre now (tiles), where its arrow is drawn. */
  x: number
  y: number
  /** Velocity (unit speed ~1), map directions. */
  vx: number
  vy: number
}

/** A spot on a boundary: where, which kind, how fast the plates close (> 0) or part (< 0). */
export interface BoundarySpot {
  x: number
  y: number
  kind: BoundaryKind
  closing: number
  shear: number
  /** Unit normal from the plate here towards the other, map directions. */
  nx: number
  ny: number
}

/** A per-tile layer of the world that drifts with the plates: the array, floats per tile, and what new ocean floor gets. */
export interface DriftLayer {
  data: Float32Array
  stride: number
  /** The values for new crust (per float of a tile); omitted: the old values stay. */
  fresh?: number[]
}

/** What happened to the plates, for the world's notices. */
export interface TectonicNews {
  text: string
  fx?: 'rift'
  size?: number
  x?: number
  y?: number
  major?: boolean
}

interface Plate {
  id: number
  continental: boolean
  vx: number
  vy: number
  /** Drift not yet moved (tiles). */
  ax: number
  ay: number
  alive: boolean
  /** Held by the map's edge this way (its land against it): it still pushes, but does not move. */
  heldX: boolean
  heldY: boolean
  /** The speed the mantle drives it at: slowed by a collision, it picks up again towards this. */
  speed: number
}

const bump = (d: number, at: number, width: number) => {
  const t = (d - at) / width
  return Math.exp(-t * t)
}

export class Tectonics {
  readonly n: number
  readonly seed: number
  private plates: Plate[] = []
  sites: Site[] = []
  /** Per tile: the plate (index into sites), the other plate across the nearest boundary, the distance to it (world units), its kind (0–2), the uplift (−1…1). */
  readonly plate: Int16Array
  readonly other: Int16Array
  readonly dist: Float32Array
  readonly kind: Uint8Array
  readonly uplift: Float32Array
  /**
   * Per tile: how young its ocean floor is (1 just opened at a spreading rift, 0 old or not
   * new floor). Young floor is shallow and sinks as it ages and cools, so an opening sea
   * deepens away from its ridge (it rides with the plates: the world moves it as a layer).
   */
  readonly newFloor: Float32Array
  /** Per tile: unit vector towards the nearest boundary. */
  private readonly normX: Float32Array
  private readonly normY: Float32Array
  /** Scratch: the nearest boundary tile per tile, the plates before a move, where each tile goes, who lands on each tile. */
  private readonly near: Int32Array
  private readonly before: Int16Array
  private readonly dest: Int32Array
  private readonly claim: Int32Array
  private readonly lift: Float32Array
  private readonly opened: Uint8Array
  private readonly crushed: Uint8Array
  private readonly liftMoved: Float32Array
  private scratch = new Float32Array(0)
  /** The cosine and the sine of every column's longitude (for the plates' centres round the world). */
  private cosX = new Float64Array(0)
  private sinX = new Float64Array(0)
  private readonly edgeBand: Float32Array
  /** Mountains to raise after a move: front tile, direction into the winning side, volume, where the crest is and how wide. */
  private orogens: { j: number; dir: [number, number]; volume: number; peak: number; width: number }[] = []
  /** Moves since a continent last broke apart. */
  private sinceRift = 0
  private clock = 0
  private nextId = 0
  dirty = true
  /** Notices for the world (it empties this). */
  news: TectonicNews[] = []

  constructor(n: number, seed: number) {
    this.n = n
    this.seed = seed
    const cells = n * n
    // the width of the sea band along the top and the bottom of the map, winding: 4 to 10 tiles
    this.edgeBand = new Float32Array(cells)
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) this.edgeBand[y * n + x] = 4 + 6 * fbm((x / n) * 6, (y / n) * 6, seed + 57, 3, 0.5, 2, 6)
    this.plate = new Int16Array(cells)
    this.other = new Int16Array(cells)
    this.dist = new Float32Array(cells)
    this.kind = new Uint8Array(cells)
    this.uplift = new Float32Array(cells)
    this.newFloor = new Float32Array(cells)
    this.normX = new Float32Array(cells)
    this.normY = new Float32Array(cells)
    this.near = new Int32Array(cells)
    this.before = new Int16Array(cells)
    this.dest = new Int32Array(cells)
    this.claim = new Int32Array(cells)
    this.lift = new Float32Array(cells)
    this.opened = new Uint8Array(cells)
    this.crushed = new Uint8Array(cells)
    this.liftMoved = new Float32Array(cells)
  }

  /** Tiles per world unit. */
  get scale() {
    return this.n / WORLD_UNITS
  }

  /** A seeded random number for plate k and a salt, 0–1. */
  private rand(k: number, salt: number) {
    return hash2(k, salt, this.seed + 977)
  }

  private newPlate(continental: boolean, angle: number, speed: number): Plate {
    const p: Plate = { id: this.nextId++, continental, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, ax: 0, ay: 0, alive: true, heldX: false, heldY: false, speed }
    this.plates.push(p)
    return p
  }

  /**
   * Lays the plates out from the land (ground: 4 floats per tile, height first; sea: the
   * sea level): a plate per continent (two for the biggest), oceanic plates in the seas;
   * each tile goes to the nearest, a continental plate's distance measured from its coast.
   */
  build(ground: Float32Array, sea: number) {
    const n = this.n
    const cells = n * n
    this.plates = []
    this.nextId = 0
    const land = (i: number) => ground[i * 4] >= sea
    // the landmasses (4-connected)
    const comp = new Int32Array(cells).fill(-1)
    const masses: number[][] = []
    const stack: number[] = []
    for (let s = 0; s < cells; s++) {
      if (comp[s] >= 0 || !land(s)) continue
      const id = masses.length
      const tiles: number[] = []
      comp[s] = id
      stack.push(s)
      while (stack.length) {
        const i = stack.pop()!
        tiles.push(i)
        for (const j of neighbours(i, n)) {
          if (j >= 0 && comp[j] < 0 && land(j)) {
            comp[j] = id
            stack.push(j)
          }
        }
      }
      masses.push(tiles)
    }
    // how each plate measures its distance: a continent from its coast (stretched by how far
    // its plate reaches out), an ocean plate from its centre
    const measures: ((x: number, y: number, i: number) => number)[] = []
    // the land each continental plate owns whole (no stretch of coast left on the ocean's plate)
    const owned: number[][] = []
    const centre = (t: number[]) => centreOf(t, n)
    const addContinent = (tiles: number[], angle?: number) => {
      const k = this.plates.length
      owned.push(tiles)
      // continents drift slowly
      this.newPlate(true, angle ?? this.rand(k, 1) * Math.PI * 2, 0.3 + 0.35 * this.rand(k, 2))
      // some reach to mid-ocean (passive margins), some barely past the coast (active, with trenches)
      const reach = this.rand(k, 3) < 0.45 ? 2.5 + 1.5 * this.rand(k, 4) : 1 + 0.4 * this.rand(k, 4)
      const field = distanceFrom(tiles, n)
      measures.push((_x, _y, i) => field[i] * reach)
    }
    const big = masses.filter((t) => t.length >= CONTINENT_MIN * cells).sort((a, b) => b.length - a.length)
    for (const tiles of big) {
      if (tiles.length >= CONTINENT_SPLIT * cells) {
        // a supercontinent breaking up (as Pangaea): its two halves drift apart, opening a
        // rift that becomes a new ocean between them
        const [a, b] = this.wavySplit(tiles)
        const [ax, ay] = centre(a)
        const [bx, by] = centre(b)
        const apart = Math.atan2(by - ay, wrapDelta(bx, ax, n))
        const turn = (this.rand(this.plates.length, 8) - 0.5) * 0.8
        addContinent(a, apart + Math.PI + turn)
        addContinent(b, apart + turn)
      } else addContinent(tiles)
    }
    // the oceanic plates: spread over the seas, each where it is farthest from the plates so far
    const want = Math.max(2, Math.round(PLATES * Math.min(1, cells / (192 * 192))) - this.plates.length)
    const seaTiles: number[] = []
    for (let i = 0; i < cells; i += 3) if (!land(i)) seaTiles.push(i)
    for (let k = 0; k < want && seaTiles.length; k++) {
      let best = seaTiles[0]
      let bestD = -1
      for (let c = 0; c < 40; c++) {
        const i = seaTiles[Math.floor(this.rand(this.plates.length * 50 + c, 5) * seaTiles.length)]
        const x = i % n
        const y = Math.floor(i / n)
        let d = Infinity
        for (const m of measures) d = Math.min(d, m(x, y, i))
        d = Math.min(d, 2 * Math.min(y, n - 1 - y) + n * 0.1)
        if (d > bestD) [best, bestD] = [i, d]
      }
      const kk = this.plates.length
      // oceanic plates drift faster
      this.newPlate(false, this.rand(kk, 1) * Math.PI * 2, 0.6 + 0.4 * this.rand(kk, 2))
      const cx = best % n
      const cy = Math.floor(best / n)
      measures.push((x, y) => Math.hypot(wrapDelta(x, cx, n), y - cy))
    }
    // every tile to the nearest plate, through a noise warp so the boundaries wander
    const amp = WARP * n
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const i = y * n + x
        const wx = x + (fbm((x / n) * 3, (y / n) * 3, this.seed + 41, 4, 0.5, 2, 3) - 0.5) * 2 * amp
        const wy = y + (fbm((x / n) * 3 + 7.3, (y / n) * 3 + 2.1, this.seed + 43, 4, 0.5, 2, 3) - 0.5) * 2 * amp
        const j = Math.min(Math.max(Math.round(wy), 0), n - 1) * n + wrap(Math.round(wx), n)
        let best = 0
        let bd = Infinity
        for (let k = 0; k < measures.length; k++) {
          const d = measures[k](wx, wy, j)
          if (d < bd) [bd, best] = [d, k]
        }
        this.plate[i] = best
      }
    }
    // every continent's land rides on its own plate, whole
    owned.forEach((tiles, k) => {
      for (const i of tiles) this.plate[i] = k
    })
    this.clock = 0
    this.dirty = true
  }

  /**
   * One tick: every MOVE_EVERY ticks the plates that have drifted a whole tile move it,
   * carrying the layers and (through `carry`) what lives on the land; along the boundaries
   * the land keeps rising or sinking.
   */
  tick(ground: Float32Array, sea: number, drift: number, layers: DriftLayer[], carry: (moved: (x: number, y: number) => [number, number] | null) => void) {
    if (this.dirty) this.recompute(ground, sea)
    if (drift <= 0) return
    for (const p of this.plates) {
      if (!p.alive) continue
      if (!p.heldX) p.ax += p.vx * PLATE_TILES * drift
      if (!p.heldY) p.ay += p.vy * PLATE_TILES * drift
    }
    if (++this.clock >= MOVE_EVERY) {
      this.clock = 0
      this.move(ground, sea, layers, carry)
    }
    // the new ocean floor ages and sinks: shallow at the ridge, deeper away from it
    const nf = this.newFloor
    for (let i = 0; i < this.n * this.n; i++) {
      const a = nf[i]
      if (a <= 0) continue
      nf[i] = Math.max(0, a - FLOOR_AGEING * drift)
      const target = sea - 0.02 - 0.07 * (1 - nf[i])
      const h = ground[i * 4]
      if (h > target) {
        const dh = Math.min(h - target, 0.0003 * drift)
        ground[i * 4] -= dh
        ground[i * 4 + 1] -= dh
      }
    }
    const u = this.uplift
    const k = UPLIFT_RATE * drift
    for (let i = 0; i < this.n * this.n; i++) {
      const h = ground[i * 4]
      let dh = 0
      if (u[i] !== 0) {
        // rising rock rises slower the higher it is already (its roots sink under its weight);
        // light continental crust sinks slower than the sea floor
        // (a rift on land, where the plates part, sinks at the full rate: that is how a new sea
        // opens between the halves of a continent, as the Red Sea)
        const up = u[i] > 0 ? u[i] * (1 - Math.min(Math.max((h - CRUST_SOFT) / (CRUST_MAX - CRUST_SOFT), 0), 1)) : u[i] * (h >= sea ? (this.kind[i] === 1 ? RIFT_SINK : LAND_SINK) : 1)
        dh = up * k
      }
      if (h > CRUST_MAX) dh -= Math.min(h - CRUST_MAX, COLLAPSE_RATE)
      if (dh === 0) continue
      ground[i * 4] = Math.max(h + dh, -0.12)
      ground[i * 4 + 1] = ground[i * 4] - ground[i * 4 + 2]
    }
  }

  /**
   * The plates that have drifted a whole tile move one (every one due, at once): each tile
   * of theirs goes to its neighbour that way. Where it lands on another plate the denser
   * crust dives: an oceanic tile under a continental one (whose edge rises a little, the
   * volcanic arc), the older ocean under the younger; two continents pile up (the higher
   * crust stays on top and thickens). Where a plate leaves, new ocean floor opens on it.
   */
  private move(ground: Float32Array, sea: number, layers: DriftLayer[], carry: (moved: (x: number, y: number) => [number, number] | null) => void) {
    const n = this.n
    const cells = n * n
    const steps: [number, number][] = this.plates.map((p) => {
      if (!p.alive) return [0, 0]
      const dx = Math.trunc(p.ax)
      const dy = Math.trunc(p.ay)
      p.ax -= dx
      p.ay -= dy
      return [Math.sign(dx), Math.sign(dy)]
    })
    if (!steps.some(([dx, dy]) => dx || dy)) return
    const L = this.before
    L.set(this.plate)
    const dest = this.dest
    const claim = this.claim
    const lift = this.lift
    const opened = this.opened
    claim.fill(-1)
    lift.fill(0)
    opened.fill(0)
    const continentalAt = (i: number) => ground[i * 4] >= sea - 0.02
    const grind = new Uint8Array(this.plates.length)
    for (let i = 0; i < cells; i++) {
      dest[i] = -1
      const [dx, dy] = steps[L[i]]
      if (!dx && !dy) continue
      // (east–west it goes round the world)
      const x = wrap((i % n) + dx, n)
      const y = Math.floor(i / n) + dy
      // off the top or the bottom of the map: gone (it slides under the map's edge)
      if (y >= 0 && y < n) dest[i] = y * n + x
    }
    // where two plates meet head-on, or a plate runs into one standing still, the crusts
    // contest the tile: the loser dives (it is gone), the winner takes the tile and the land
    // there rises (mountains, or the volcanic arc); a tile moving off sideways or ahead just
    // makes room
    const crushed = this.crushed
    crushed.fill(0)
    for (let i = 0; i < cells; i++) {
      const j = dest[i]
      if (j < 0) continue
      const k = L[i]
      const m = L[j]
      if (m === k || crushed[i] || crushed[j]) continue
      const sk = steps[k]
      const sm = steps[m]
      const facing = (!sm[0] && !sm[1]) || sm[0] * sk[0] + sm[1] * sk[1] < 0
      if (!facing) continue
      const ci = continentalAt(i)
      const cj = continentalAt(j)
      let wins: boolean
      // the crust that goes under or is squeezed out piles up as mountains (see orogeny)
      const crust = (t: number) => Math.max(ground[t * 4] - sea, 0) + 0.01
      if (ci && cj) {
        // two continents: neither dives; the crust piles up into a range (the higher stays on
        // top) and both plates slow down
        wins = ground[i * 4] >= ground[j * 4]
        lift[j] += THICKEN
        lift[i] += THICKEN
        grind[k] = 1
        grind[m] = 1
      } else if (ci !== cj) {
        // ocean meets continent: the ocean dives under it, the continent's edge rises (the arc)
        wins = ci
        lift[ci ? i : j] += ARC
      } else {
        // two oceans: the older, denser one dives (here: the plate with the lower hash)
        wins = this.rand(this.plates[k].id, 9) > this.rand(this.plates[m].id, 9)
      }
      if (wins) crushed[j] = 1
      else crushed[i] = 1
      // into the winner's side: behind the winning tile, against its motion (a standing
      // winner: on, past the front)
      const ws = wins ? sk : sm
      const dir: [number, number] = wins || ws[0] || ws[1] ? [-ws[0], -ws[1]] : [sk[0], sk[1]]
      if (ci && cj) this.orogens.push({ j, dir, volume: crust(wins ? j : i) * OROGENY, peak: 3, width: 3 })
      else if (ci !== cj) this.orogens.push({ j, dir, volume: ARC_VOLUME, peak: 5, width: 2.5 })
    }
    // every tile still moving takes its new place (if two arrive, the continental, higher one)
    for (let i = 0; i < cells; i++) {
      const j = dest[i]
      if (j < 0 || crushed[i]) continue
      const prev = claim[j]
      if (prev < 0 || ground[i * 4] > ground[prev * 4]) claim[j] = i
    }
    // the lift goes with the crust it was given to
    const moved = this.liftMoved
    moved.fill(0)
    for (let j = 0; j < cells; j++) {
      const from = claim[j]
      if (from >= 0) moved[j] += lift[from]
      else if (!crushed[j]) moved[j] += lift[j]
    }
    lift.set(moved)
    for (let k = 0; k < grind.length; k++) {
      const p = this.plates[k]
      // grinding continents slow down; free again, the plate picks up towards its speed
      const v = Math.hypot(p.vx, p.vy)
      const f = grind[k] ? COLLISION_DRAG : v > 1e-6 && v < p.speed ? Math.min(1.02, p.speed / v) : 1
      p.vx *= f
      p.vy *= f
    }
    // a tile nobody landed on, whose own crust left or dove, opens as new ocean floor
    for (let j = 0; j < cells; j++) {
      if (claim[j] >= 0) continue
      const [dx, dy] = steps[L[j]]
      if (dx || dy || crushed[j]) opened[j] = 1
    }
    // the layers move: each tile takes what was on the tile that landed on it
    for (const layer of layers) {
      const s = layer.stride
      if (this.scratch.length < cells * s) this.scratch = new Float32Array(cells * s)
      const old = this.scratch
      const d = layer.data
      old.set(d.subarray(0, cells * s))
      for (let j = 0; j < cells; j++) {
        const from = claim[j]
        if (from >= 0) {
          for (let c = 0; c < s; c++) d[j * s + c] = old[from * s + c]
        } else if (opened[j] && layer.fresh) {
          for (let c = 0; c < s; c++) d[j * s + c] = layer.fresh[c]
        }
      }
    }
    for (let j = 0; j < cells; j++) {
      const from = claim[j]
      if (from >= 0) this.plate[j] = L[from]
      // new floor where a continent left: shallow sea (the ocean keeps its depth, so the
      // floor stays smooth)
      if (opened[j] && ground[j * 4] > sea - 0.03) {
        ground[j * 4] = sea - 0.03
        ground[j * 4 + 1] = ground[j * 4]
        ground[j * 4 + 2] = 0
        ground[j * 4 + 3] = 0
      }
      if (lift[j]) {
        ground[j * 4] += lift[j]
        ground[j * 4 + 1] += lift[j]
      }
    }
    this.orogeny(ground)
    this.wearDown(ground, sea)
    this.edgeSea(ground, sea)
    this.smoothCoasts(ground, sea)
    // the peoples and the herds ride along
    carry((x, y) => {
      const xx = wrap(Math.floor(x), n)
      const yy = Math.min(Math.max(Math.floor(y), 0), n - 1)
      const [dx, dy] = steps[L[yy * n + xx]]
      return dx || dy ? [dx, dy] : null
    })
    this.tidyPlates()
    this.lifeCycle(ground, sea)
    this.recompute(ground, sea)
  }

  /**
   * Slivers left by the shuffle (a tile or a thin strip of one plate inside another) join
   * the plate around them: a tile with at least 5 of its 8 neighbours on one other plate
   * goes over to it (twice, which clears strips two tiles wide).
   */
  private tidyPlates() {
    const n = this.n
    const lab = this.plate
    const old = this.before
    const counts = new Int32Array(this.plates.length)
    for (let pass = 0; pass < 2; pass++) {
      old.set(lab)
      for (let y = 1; y < n - 1; y++) {
        for (let x = 0; x < n; x++) {
          const i = y * n + x
          const own = old[i]
          let best = -1
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              if (!dx && !dy) continue
              const k = old[beside(i, x, dx, dy, n)]
              if (k === own) continue
              counts[k]++
              if (best < 0 || counts[k] > counts[best]) best = k
            }
          }
          if (best >= 0 && counts[best] >= 5) lab[i] = best
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) counts[old[beside(i, x, dx, dy, n)]] = 0
        }
      }
    }
  }

  /**
   * The mountains a collision builds: each continental tile squeezed out at the front adds
   * its crust as a ridge of rock a few tiles into the winning side (a range along the suture,
   * as the Himalaya); an ocean diving under a continent raises a volcanic range a little
   * inland (as the Andes). The volume is conserved: the crust is not lost, it is stacked up.
   */
  private orogeny(ground: Float32Array) {
    const n = this.n
    for (const o of this.orogens) {
      const x0 = o.j % n
      const y0 = Math.floor(o.j / n)
      const R = Math.ceil(o.peak + o.width * 2)
      let total = 0
      for (let t = 0; t <= R; t++) total += Math.exp(-(((t - o.peak) / o.width) ** 2))
      for (let t = 0; t <= R; t++) {
        // the ridge spreads a tile to either side too, so it is a band, not a line
        for (let side = -1; side <= 1; side++) {
          const x = wrap(x0 + o.dir[0] * t + (o.dir[1] !== 0 ? side : 0), n)
          const y = y0 + o.dir[1] * t + (o.dir[0] !== 0 && o.dir[1] === 0 ? side : 0)
          if (y < 0 || y >= n) continue
          const i = y * n + x
          const dh = (o.volume * Math.exp(-(((t - o.peak) / o.width) ** 2))) / total / 3
          ground[i * 4] += dh
          ground[i * 4 + 1] += dh
        }
      }
    }
    this.orogens = []
  }

  /**
   * Mountains wear down and slump (erosion and gravity, sped up to the plates' pace): rock
   * above the lowlands slides to its lower neighbours, the volume kept, so the ranges spread
   * into foothills and the sediment builds the plains and the shelves back out (the land the
   * collisions squeeze is given back).
   */
  private wearDown(ground: Float32Array, sea: number) {
    const n = this.n
    const old = this.liftMoved
    for (let i = 0; i < n * n; i++) old[i] = ground[i * 4]
    for (let y = 1; y < n - 1; y++) {
      for (let x = 0; x < n; x++) {
        const i = y * n + x
        const h = old[i]
        if (h < sea + 0.06) continue
        for (const j of [beside(i, x, -1, 0, n), beside(i, x, 1, 0, n), i - n, i + n]) {
          const d = h - old[j]
          if (d <= 0.004) continue
          const f = Math.min((d - 0.004) * WEAR, 0.004)
          ground[i * 4] -= f
          ground[i * 4 + 1] -= f
          ground[j * 4] += f
          ground[j * 4 + 1] += f
        }
      }
    }
  }

  /**
   * The top and the bottom of the map are open sea: land pushed against them subsides into
   * a band of winding width (the coast there follows a noise, not the straight edge of the
   * map). East and west there is no edge.
   */
  private edgeSea(ground: Float32Array, sea: number) {
    const n = this.n
    const band = this.edgeBand
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const i = y * n + x
        const e = Math.min(y, n - 1 - y)
        if (e >= band[i] || ground[i * 4] < sea - 0.01) continue
        const dh = Math.min(0.004, ground[i * 4] - (sea - 0.01))
        ground[i * 4] -= dh
        ground[i * 4 + 1] -= dh
      }
    }
  }

  /**
   * Near the boundaries, where the crust was just shuffled, single tiles of land in the sea
   * sink and single gaps of sea in the land fill (the coasts stay whole, not torn).
   */
  private smoothCoasts(ground: Float32Array, sea: number) {
    const n = this.n
    const sc = this.scale
    const old = this.liftMoved
    for (let i = 0; i < n * n; i++) old[i] = ground[i * 4]
    for (let y = 1; y < n - 1; y++) {
      for (let x = 0; x < n; x++) {
        const i = y * n + x
        if (this.dist[i] * sc > 4 && !this.opened[i]) continue
        let land = 0
        let sum = 0
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue
            const h = old[beside(i, x, dx, dy, n)]
            sum += h
            if (h >= sea) land++
          }
        }
        const h = old[i]
        let next = h
        if (h >= sea && land <= 2) next = Math.min(sea - 0.004, sum / 8)
        // (a gap of sea between land is filled, unless it is a rift opening: new floor)
        else if (h < sea && land >= 6 && this.newFloor[i] <= 0 && !this.opened[i]) next = Math.max(sea + 0.002, sum / 8)
        if (next !== h) {
          ground[i * 4] = next
          ground[i * 4 + 1] = next - ground[i * 4 + 2]
        }
      }
    }
  }

  /** Plates swallowed whole are gone (their last tiles join the plate around them); with too few left, a rift splits the biggest. */
  private lifeCycle(ground: Float32Array, sea: number) {
    const n = this.n
    const cells = n * n
    const count = new Int32Array(this.plates.length)
    for (let i = 0; i < cells; i++) count[this.plate[i]]++
    for (let k = 0; k < this.plates.length; k++) {
      const p = this.plates[k]
      if (!p.alive || count[k] >= SWALLOWED * cells) continue
      // the neighbour it touches most takes what is left
      const touch = new Int32Array(this.plates.length)
      const last: number[] = []
      for (let i = 0; i < cells; i++) {
        if (this.plate[i] !== k) continue
        last.push(i)
        for (const j of neighbours(i, n)) if (j >= 0 && this.plate[j] !== k) touch[this.plate[j]]++
      }
      let heir = -1
      for (let m = 0; m < touch.length; m++) if (touch[m] > 0 && (heir < 0 || touch[m] > touch[heir])) heir = m
      p.alive = false
      const left = count[k]
      if (heir >= 0) {
        for (let i = 0; i < cells; i++) if (this.plate[i] === k) this.plate[i] = heir
        count[heir] += left
      }
      count[k] = 0
      // where it went under: the centre of its last tiles
      if (left > 0) {
        const [x, y] = centreOf(last, n)
        this.news.push({
          text: p.continental ? 'Uma placa continental foi engolida: a colisão a soldou à vizinha.' : 'Uma placa oceânica foi engolida inteira, mergulhando sob a vizinha.',
          x,
          y,
          major: true,
        })
      } else this.news.push({ text: 'Uma placa saiu do mapa, mergulhando sob a borda polar do mundo.' })
    }
    const alive = this.plates.filter((p) => p.alive).length
    if (alive < MIN_PLATES) this.rift(ground, sea, count)
    else if (++this.sinceRift > RIFT_EVERY * (0.5 + Math.random())) {
      // now and then a big continent breaks apart (as Pangaea, as East Africa now)
      let big = -1
      for (let k = 0; k < this.plates.length; k++) {
        if (this.plates[k].alive && this.plates[k].continental && count[k] > RIFT_SIZE * cells && (big < 0 || count[k] > count[big])) big = k
      }
      if (big >= 0) this.rift(ground, sea, count, big)
      this.sinceRift = 0
    }
  }

  /** A rift splits the biggest plate in two; the halves drift apart. */
  private rift(ground: Float32Array, sea: number, count: Int32Array, which = -1) {
    const n = this.n
    let big = which
    if (big < 0) for (let k = 0; k < this.plates.length; k++) if (this.plates[k].alive && (big < 0 || count[k] > count[big])) big = k
    if (big < 0) return
    const tiles: number[] = []
    for (let i = 0; i < n * n; i++) if (this.plate[i] === big) tiles.push(i)
    if (tiles.length < 50) return
    const [a, b] = this.wavySplit(tiles)
    const [ax, ay] = centreOf(a, n)
    const [bx, by] = centreOf(b, n)
    let land = 0
    for (const i of b) if (ground[i * 4] >= sea) land++
    const old = this.plates[big]
    const k = this.plates.length
    // the new half drifts away from the old one
    const away = Math.atan2(by - ay, wrapDelta(bx, ax, n))
    const p = this.newPlate(land > b.length * 0.3, away + (this.rand(k, 6) - 0.5) * 0.6, 0.4 + 0.4 * this.rand(k, 7))
    old.vx = -p.vx * 0.6
    old.vy = -p.vy * 0.6
    old.speed = Math.hypot(old.vx, old.vy)
    old.heldX = old.heldY = false
    for (const i of b) this.plate[i] = k
    // the rift valley: the land along the new boundary drops at once (a graben)
    const nb = new Uint8Array(n * n)
    for (const i of b) nb[i] = 1
    for (const i of b) {
      for (const j of neighbours(i, n)) {
        if (j < 0 || nb[j] || this.plate[j] !== big) continue
        for (const t of [i, j]) {
          if (ground[t * 4] < sea) continue
          ground[t * 4] = Math.max(sea - 0.004, ground[t * 4] - 0.02)
          ground[t * 4 + 1] = ground[t * 4] - ground[t * 4 + 2]
        }
      }
    }
    this.news.push({
      text: old.continental ? 'Um rifte parte o continente em dois: o vale afunda e um novo oceano começa a se abrir.' : 'Um rifte parte uma placa em duas: um novo oceano começa a se abrir.',
      x: wrap(ax + wrapDelta(bx, ax, n) / 2, n),
      y: (ay + by) / 2,
      major: true,
      fx: 'rift',
      size: 20,
    })
  }

  /**
   * A plate in two halves along a winding rift (the line between its two halves bent by a
   * low noise, as rifts follow old weak zones): so the new coasts are not straight.
   */
  private wavySplit(tiles: number[]): [number[], number[]] {
    const n = this.n
    const [a0, b0] = split(tiles, n)
    // (the columns are counted from the first half's middle, round the world, so a plate
    // that lies across the map's edge is split as the one piece it is)
    const [ax, ay] = centreOf(a0, n)
    const [cx, by] = centreOf(b0, n)
    const bx = ax + wrapDelta(cx, ax, n)
    const len = Math.hypot(bx - ax, by - ay) || 1
    const ux = (bx - ax) / len
    const uy = (by - ay) / len
    const mx = (ax + bx) / 2
    const my = (ay + by) / 2
    const salt = this.seed + 101 + this.nextId * 7
    const a: number[] = []
    const b: number[] = []
    for (const i of tiles) {
      const x = i % n
      const y = Math.floor(i / n)
      const bend = (fbm((x / n) * 3, (y / n) * 3, salt, 4, 0.5, 2, 3) - 0.5) * 2 * len * 0.45
      if (wrapDelta(x, mx, n) * ux + (y - my) * uy + bend < 0) a.push(i)
      else b.push(i)
    }
    return a.length && b.length ? [a, b] : [a0, b0]
  }

  /**
   * From the plate map: per tile the nearest boundary (a two-pass chamfer from the tiles
   * next to another plate), the plate across it, the kind and the uplift (platesShader's
   * rules); and every plate's centre for the arrows.
   */
  recompute(ground: Float32Array, sea: number) {
    this.dirty = false
    const n = this.n
    const cells = n * n
    const lab = this.plate
    const near = this.near
    const dist = this.dist
    // the seeds: tiles with a neighbour on another plate
    for (let i = 0; i < cells; i++) {
      const k = lab[i]
      let other = -1
      for (const j of neighbours(i, n)) {
        if (j >= 0 && lab[j] !== k) {
          other = lab[j]
          break
        }
      }
      near[i] = other >= 0 ? i : -1
      dist[i] = other >= 0 ? 0 : 1e9
      if (other >= 0) this.other[i] = other
    }
    // propagate the nearest seed of the same plate (squared distance to it, in chamfer
    // order: forwards, then backwards)
    const pass = (forward: boolean) => {
      const dys = forward ? [0, -1, -1, -1] : [0, 1, 1, 1]
      const dxs = forward ? [-1, 0, -1, 1] : [1, 0, 1, -1]
      for (let t = 0; t < cells; t++) {
        const i = forward ? t : cells - 1 - t
        const x = i % n
        const y = (i - x) / n
        const k = lab[i]
        for (let c = 0; c < 4; c++) {
          const yy = y + dys[c]
          if (yy < 0 || yy >= n) continue
          const j = yy * n + wrap(x + dxs[c], n)
          const s = near[j]
          if (s < 0 || lab[s] !== k) continue
          const ddx = wrapDelta(x, s % n, n)
          const ddy = y - (s - (s % n)) / n
          const d = ddx * ddx + ddy * ddy
          if (d < dist[i]) {
            dist[i] = d
            near[i] = s
            this.other[i] = this.other[s]
          }
        }
      }
    }
    pass(true)
    pass(false)
    pass(true)
    pass(false)
    for (let i = 0; i < cells; i++) if (near[i] >= 0) dist[i] = Math.sqrt(dist[i])
    // the plates' centres (the arrows): east–west the mean on the circle, so a plate lying
    // across the map's edge has its centre there (sum: cosine, sine, row, count)
    const P = this.plates
    const sum = new Float64Array(P.length * 4)
    if (this.cosX.length !== n) {
      this.cosX = new Float64Array(n)
      this.sinX = new Float64Array(n)
      for (let x = 0; x < n; x++) {
        this.cosX[x] = Math.cos((x / n) * Math.PI * 2)
        this.sinX[x] = Math.sin((x / n) * Math.PI * 2)
      }
    }
    for (let i = 0; i < cells; i++) {
      const k = lab[i]
      const x = i % n
      sum[k * 4] += this.cosX[x]
      sum[k * 4 + 1] += this.sinX[x]
      sum[k * 4 + 2] += (i - x) / n
      sum[k * 4 + 3]++
    }
    // which plates carry land close to the top or the bottom of the map
    const edge = new Uint8Array(P.length)
    // (past the sea band along the edge, see edgeSea: a continent stops before it wears into it)
    const margin = 11
    for (let i = 0; i < cells; i++) {
      if (ground[i * 4] < sea) continue
      const y = Math.floor(i / n)
      const k = lab[i]
      if (y < margin) edge[k] |= 4
      if (y >= n - margin) edge[k] |= 8
    }
    for (let k = 0; k < P.length; k++) {
      const p = P[k]
      const c = sum[k * 4 + 3]
      if (!p.alive || !c) continue
      // a continent against the top or the bottom of the map is held there that way (it
      // keeps pushing, so the boundaries still feel it: a rift keeps opening, a range keeps
      // rising; it slides along the edge). Ocean floor just runs on and dives under the edge
      // (plates do not bounce back: that would close every sea that opens). East and west
      // nothing holds a plate: it goes round the world
      p.heldX = false
      p.heldY = (p.vy < 0 && (edge[k] & 4) > 0) || (p.vy > 0 && (edge[k] & 8) > 0)
    }
    this.sites = P.map((p, k) => {
      const c = sum[k * 4 + 3]
      return {
        cell: [p.id, p.continental ? 1 : 0] as [number, number],
        continental: p.continental,
        alive: p.alive && c > 0,
        x: c ? wrap((Math.atan2(sum[k * 4 + 1], sum[k * 4]) / (Math.PI * 2)) * n + 0.5, n) : -1e4,
        y: c ? sum[k * 4 + 2] / c + 0.5 : -1e4,
        vx: p.vx,
        vy: p.vy,
      }
    })
    const sc = this.scale
    const rockAt = (x: number, y: number) => {
      const xx = wrap(Math.round(x), n)
      const yy = Math.min(Math.max(Math.round(y), 0), n - 1)
      return ground[(yy * n + xx) * 4 + 1]
    }
    for (let i = 0; i < cells; i++) {
      const s = near[i]
      const x = i % n
      const y = Math.floor(i / n)
      if (s < 0) {
        // a plate with no boundary (alone on the map)
        this.uplift[i] = 0
        this.kind[i] = 2
        this.other[i] = lab[i]
        this.normX[i] = 1
        this.normY[i] = 0
        continue
      }
      // the normal: towards the boundary; on the boundary itself, towards the other plate's neighbour
      let nx = wrapDelta(s % n, x, n)
      let ny = Math.floor(s / n) - y
      if (!nx && !ny) {
        const o = this.other[i]
        if (lab[beside(i, x, 1, 0, n)] === o) nx = 1
        else if (lab[beside(i, x, -1, 0, n)] === o) nx = -1
        else if (i < cells - n && lab[i + n] === o) ny = 1
        else ny = -1
      }
      const len = Math.hypot(nx, ny)
      nx /= len
      ny /= len
      this.normX[i] = nx
      this.normY[i] = ny
      const a = P[lab[i]]
      const b = P[this.other[i]]
      const rx = a.vx - b.vx
      const ry = a.vy - b.vy
      const closing = rx * nx + ry * ny
      const shear = -rx * ny + ry * nx
      this.kind[i] = Math.abs(shear) > Math.abs(closing) * 2 ? 2 : closing > 0 ? 0 : 1
      // world units to the boundary (it lies half a tile past the seed)
      const d = (dist[i] + 0.5) / sc
      dist[i] = d
      const into = 0.1 * sc
      const db = d * sc
      const ownLow = rockAt(x - nx * into, y - ny * into) < sea
      const otherLow = rockAt(x + nx * (db + into), y + ny * (db + into)) < sea
      let u = 0
      if (closing > 0) {
        let ownDives = ownLow && !otherLow
        let otherDives = otherLow && !ownLow
        if (ownLow && otherLow) {
          ownDives = this.rand(a.id, 9) < this.rand(b.id, 9)
          otherDives = !ownDives
        }
        if (ownDives) u = -0.8 * closing * bump(d, 0.015, 0.02)
        else if (otherDives) u = closing * (bump(d, 0.07, 0.04) + 0.3 * bump(d, 0, 0.03))
        else u = closing * (bump(d, 0, 0.09) - 0.1)
      } else {
        const opening = -closing
        if (ownLow && otherLow) u = 0.5 * opening * bump(d, 0, 0.04)
        else u = opening * (0.3 * bump(d, 0.05, 0.025) - 0.8 * bump(d, 0, 0.025))
      }
      this.uplift[i] = Math.max(-1, Math.min(1, u))
    }
  }

  /** The plate under a tile, its boundary nearby and how the two move. */
  boundaryAt(x: number, y: number): BoundarySpot {
    const n = this.n
    const i = Math.min(Math.max(Math.floor(y), 0), n - 1) * n + wrap(Math.floor(x), n)
    const a = this.plates[this.plate[i]]
    const b = this.plates[this.other[i]] ?? a
    const nx = this.normX[i]
    const ny = this.normY[i]
    const rx = a.vx - b.vx
    const ry = a.vy - b.vy
    const d = this.dist[i] * this.scale
    return { x: wrap(x + nx * d, n), y: y + ny * d, kind: KINDS[this.kind[i]], closing: rx * nx + ry * ny, shear: -rx * ny + ry * nx, nx, ny }
  }

  /** A random spot on a busy boundary in the map (for quakes and volcanoes), or null. */
  busySpot(score: (b: BoundarySpot) => number, near = 0.06): BoundarySpot | null {
    const n = this.n
    let best: BoundarySpot | null = null
    let bestScore = 0
    for (let k = 0; k < 24; k++) {
      const x = n * Math.random() * 0.9999
      const y = n * (0.06 + 0.88 * Math.random())
      const i = Math.floor(y) * n + Math.floor(x)
      if (this.dist[i] > near) continue
      const b = this.boundaryAt(x, y)
      if (b.y < 2 || b.y > n - 2) continue
      const s = score(b) * Math.random()
      if (s > bestScore) [best, bestScore] = [b, s]
    }
    return best
  }

  /**
   * A blow strong enough to crack a plate (a great quake, a giant impact): the plate under
   * the point splits along a winding crack through it, at a random angle; the far side
   * becomes a new plate drifting away, and a rift opens along the crack. False when the
   * plate is too small to split.
   */
  crack(x: number, y: number): boolean {
    const n = this.n
    const i0 = Math.min(Math.max(Math.floor(y), 0), n - 1) * n + wrap(Math.floor(x), n)
    const k = this.plate[i0]
    const old = this.plates[k]
    if (!old?.alive) return false
    const tiles: number[] = []
    for (let i = 0; i < n * n; i++) if (this.plate[i] === k) tiles.push(i)
    if (tiles.length < 300) return false
    const angle = Math.random() * Math.PI * 2
    const nx = Math.cos(angle)
    const ny = Math.sin(angle)
    const salt = this.seed + 313 + this.nextId * 11
    const a: number[] = []
    const b: number[] = []
    for (const i of tiles) {
      const tx = i % n
      const ty = Math.floor(i / n)
      const bend = (fbm((tx / n) * 3, (ty / n) * 3, salt, 4, 0.5, 2, 3) - 0.5) * 2 * n * 0.12
      if (wrapDelta(tx, x, n) * nx + (ty - y) * ny + bend < 0) a.push(i)
      else b.push(i)
    }
    if (a.length < 80 || b.length < 80) return false
    let land = 0
    for (const i of b) if (this.continentalTile(i)) land++
    const p = this.newPlate(land > b.length * 0.3, angle + (Math.random() - 0.5) * 0.6, 0.5 + 0.4 * Math.random())
    // the old part pushes back the other way
    old.vx = old.vx * 0.5 - p.vx * 0.5
    old.vy = old.vy * 0.5 - p.vy * 0.5
    old.speed = Math.max(0.3, Math.hypot(old.vx, old.vy))
    old.heldX = old.heldY = false
    const id = this.plates.length - 1
    for (const i of b) this.plate[i] = id
    this.dirty = true
    this.news.push({ text: 'A crosta não aguenta: a placa racha em duas e um rifte se abre pela rachadura.', x, y, major: true, fx: 'rift', size: 30 })
    return true
  }
  /** Set by the world: whether a tile is continental crust (land or shelf). */
  continentalTile: (i: number) => boolean = () => false

  /** Points the plate under a tile the way given (map directions, speed 0–1). */
  steer(x: number, y: number, vx: number, vy: number) {
    const n = this.n
    const i = Math.min(Math.max(Math.floor(y), 0), n - 1) * n + wrap(Math.floor(x), n)
    const p = this.plates[this.plate[i]]
    if (!p || !p.alive) return
    p.vx = vx
    p.vy = vy
    p.speed = Math.hypot(vx, vy)
    this.dirty = true
  }

  /** The plates as plain data (the plate map and every plate's motion). */
  snapshot(): unknown {
    return { plate: this.plate.slice(), plates: structuredClone(this.plates), clock: this.clock, nextId: this.nextId, sinceRift: this.sinceRift, newFloor: this.newFloor.slice() }
  }

  restore(snap: unknown) {
    const s = snap as { plate: Int16Array; plates: Plate[]; clock: number; nextId: number; sinceRift: number; newFloor?: Float32Array }
    this.plate.set(s.plate)
    if (s.newFloor) this.newFloor.set(s.newFloor)
    else this.newFloor.fill(0)
    this.plates = structuredClone(s.plates)
    this.clock = s.clock
    this.nextId = s.nextId
    this.sinceRift = s.sinceRift
    this.dirty = true
  }

  /** Works the boundaries out again on the next tick (after a quake moved the ground). */
  refresh() {
    this.dirty = true
  }
}

/** The four neighbours of a tile: west and east round the world, north and south −1 off the map. */
function neighbours(i: number, n: number): [number, number, number, number] {
  const x = i % n
  return [x > 0 ? i - 1 : i + n - 1, x < n - 1 ? i + 1 : i - (n - 1), i >= n ? i - n : -1, i < n * n - n ? i + n : -1]
}

/** The tile dx columns (−1, 0, 1; round the world) and dy rows from tile i in column x (the row must be on the map). */
function beside(i: number, x: number, dx: number, dy: number, n: number): number {
  return i + dy * n + (dx < 0 ? (x > 0 ? -1 : n - 1) : dx > 0 ? (x < n - 1 ? 1 : -(n - 1)) : 0)
}

/** Distance in tiles from a set of tiles, everywhere (a two-pass chamfer transform). */
function distanceFrom(tiles: number[], n: number): Float32Array {
  const d = new Float32Array(n * n).fill(1e9)
  for (const i of tiles) d[i] = 0
  const D = Math.SQRT2
  // (twice over: the second time carries the distances across the map's edge, round the world)
  for (let round = 0; round < 2; round++) {
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const i = y * n + x
        const w = beside(i, x, -1, 0, n)
        const e = beside(i, x, 1, 0, n)
        let v = Math.min(d[i], d[w] + 1)
        if (y > 0) v = Math.min(v, d[i - n] + 1, d[w - n] + D, d[e - n] + D)
        d[i] = v
      }
    }
    for (let y = n - 1; y >= 0; y--) {
      for (let x = n - 1; x >= 0; x--) {
        const i = y * n + x
        const w = beside(i, x, -1, 0, n)
        const e = beside(i, x, 1, 0, n)
        let v = Math.min(d[i], d[e] + 1)
        if (y < n - 1) v = Math.min(v, d[i + n] + 1, d[e + n] + D, d[w + n] + D)
        d[i] = v
      }
    }
  }
  return d
}

/** A set of tiles in two halves (two-means from its two farthest-apart tiles). */
function split(tiles: number[], n: number): [number[], number[]] {
  // (the columns are counted from the first tile's, round the world: a set that lies across
  // the map's edge is one piece)
  const x0 = tiles[0] % n
  const xy = (i: number) => [x0 + wrapDelta(i % n, x0, n), Math.floor(i / n)]
  let [ax, ay] = xy(tiles[0])
  let far = 0
  for (const i of tiles) {
    const [x, y] = xy(i)
    const d = (x - ax) ** 2 + (y - ay) ** 2
    if (d > far) [far, ax, ay] = [d, x, y]
  }
  let bx = ax
  let by = ay
  far = 0
  for (const i of tiles) {
    const [x, y] = xy(i)
    const d = (x - ax) ** 2 + (y - ay) ** 2
    if (d > far) [far, bx, by] = [d, x, y]
  }
  let a: number[] = []
  let b: number[] = []
  for (let it = 0; it < 4; it++) {
    a = []
    b = []
    for (const i of tiles) {
      const [x, y] = xy(i)
      if ((x - ax) ** 2 + (y - ay) ** 2 <= (x - bx) ** 2 + (y - by) ** 2) a.push(i)
      else b.push(i)
    }
    const mean = (t: number[]) => t.reduce((s, i) => [s[0] + xy(i)[0] / t.length, s[1] + xy(i)[1] / t.length], [0, 0])
    ;[ax, ay] = mean(a)
    ;[bx, by] = mean(b)
  }
  return [a, b]
}
