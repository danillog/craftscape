// CPU copy of the plate model in platesModel / platesShader (sim.ts): the same integer
// hash, so the plates the tool grabs, the arrows and the earthquakes line up exactly with
// the uplift the GPU works out.
//
// The plates drift: each one's site moves with its velocity as the plate time goes by, so
// the boundaries migrate, plates grow and shrink, and a mountain belt is left behind where
// a boundary used to be. A plate stops once it has drifted PLATE_RANGE from where it began.

import type { PlateOverride } from './simulation'

export const PLATE_CELL = 0.8
/** How far a plate may drift from where it started (world units). */
export const PLATE_RANGE = 2.4

type Cell = [number, number]
type Vec = [number, number]

/** What the plates depend on: the terrain seed, how far they have drifted, and the user's changes. */
export interface PlateField {
  seed: number
  /** Plate time: how far a plate of unit speed has drifted (world units). */
  time: number
  overrides: PlateOverride[]
}

function plateHash(c: Cell, salt: number) {
  let h = (Math.imul(c[0] + 100000, 1597334677) ^ Math.imul(c[1] + 100000, 3812015801 | 0) ^ Math.imul(salt, 2654435769 | 0)) >>> 0
  h = (Math.imul(h, 747796405) + 2891336453) >>> 0
  h = Math.imul(((h >>> ((h >>> 28) + 4)) ^ h) >>> 0, 277803737) >>> 0
  h = ((h >>> 22) ^ h) >>> 0
  return h / 4294967295
}

const plateSalt = (seed: number) => Math.floor(Math.max(seed, 0)) * 8

export const sameCell = (a: Cell, b: Cell) => a[0] === b[0] && a[1] === b[1]

/** A plate's own drift, before any change by the user: up to one unit of speed. */
export function naturalVelocity(c: Cell, seed: number): Vec {
  const s = plateSalt(seed)
  const angle = plateHash(c, s + 2) * Math.PI * 2
  const speed = 0.4 + 0.6 * plateHash(c, s + 3)
  return [Math.cos(angle) * speed, Math.sin(angle) * speed]
}

export function plateVelocity(c: Cell, f: PlateField): Vec {
  return f.overrides.find((o) => sameCell(o.cell, c))?.velocity ?? naturalVelocity(c, f.seed)
}

/** How far the plate has drifted from where it started (world units). */
export function plateDrift(c: Cell, f: PlateField): Vec {
  const o = f.overrides.find((o) => sameCell(o.cell, c))
  let d: Vec
  if (o) d = [o.from[0] + o.velocity[0] * (f.time - o.at), o.from[1] + o.velocity[1] * (f.time - o.at)]
  else {
    const v = naturalVelocity(c, f.seed)
    d = [v[0] * f.time, v[1] * f.time]
  }
  const l = Math.hypot(d[0], d[1])
  return l > PLATE_RANGE ? [(d[0] * PLATE_RANGE) / l, (d[1] * PLATE_RANGE) / l] : d
}

/** Where the plate's site started: somewhere in the middle of its grid cell. */
export function plateOrigin(c: Cell, seed: number): Vec {
  const s = plateSalt(seed)
  return [(c[0] + 0.15 + 0.7 * plateHash(c, s)) * PLATE_CELL, (c[1] + 0.15 + 0.7 * plateHash(c, s + 1)) * PLATE_CELL]
}

export function plateSite(c: Cell, f: PlateField): Vec {
  const o = plateOrigin(c, f.seed)
  const d = plateDrift(c, f)
  return [o[0] + d[0], o[1] + d[1]]
}

/** How many grid cells away a site may have drifted to: the search radius. */
export function plateReach(f: PlateField) {
  return 1 + Math.ceil(Math.min(Math.max(f.time, 0), PLATE_RANGE) / PLATE_CELL)
}

export interface PlatePair {
  own: Cell
  other: Cell
  a: Vec
  b: Vec
  /** Distance to the boundary between them, in world units. */
  dist: number
}

/** The plate a world point is on, the nearest other plate and how far the boundary is. */
export function platePair(p: Vec, f: PlateField): PlatePair {
  const bx = Math.floor(p[0] / PLATE_CELL)
  const by = Math.floor(p[1] / PLATE_CELL)
  const r = plateReach(f)
  let d1 = Infinity
  let d2 = Infinity
  let own: Cell = [bx, by]
  let other: Cell = [bx, by]
  let a: Vec = [0, 0]
  let b: Vec = [0, 0]
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const c: Cell = [bx + dx, by + dy]
      const s = plateSite(c, f)
      const d = (p[0] - s[0]) ** 2 + (p[1] - s[1]) ** 2
      if (d < d1) {
        ;[d2, other, b] = [d1, own, a]
        ;[d1, own, a] = [d, c, s]
      } else if (d < d2) {
        ;[d2, other, b] = [d, c, s]
      }
    }
  }
  return { own, other, a, b, dist: (d2 - d1) / (2 * Math.max(Math.hypot(b[0] - a[0], b[1] - a[1]), 1e-6)) }
}

export type BoundaryKind = 'convergent' | 'divergent' | 'transform'

export interface Boundary {
  pair: PlatePair
  /** Unit vector from this plate towards the other one. */
  normal: Vec
  /** > 0: closing in; < 0: pulling apart (units of plate speed). */
  closing: number
  /** Sideways motion along the boundary. */
  shear: number
  kind: BoundaryKind
  /** The nearest point on the boundary. */
  point: Vec
}

export function boundaryAt(p: Vec, f: PlateField): Boundary {
  const pair = platePair(p, f)
  const len = Math.hypot(pair.b[0] - pair.a[0], pair.b[1] - pair.a[1]) || 1
  const normal: Vec = [(pair.b[0] - pair.a[0]) / len, (pair.b[1] - pair.a[1]) / len]
  const v1 = plateVelocity(pair.own, f)
  const v2 = plateVelocity(pair.other, f)
  const rel: Vec = [v1[0] - v2[0], v1[1] - v2[1]]
  const closing = rel[0] * normal[0] + rel[1] * normal[1]
  const shear = -rel[0] * normal[1] + rel[1] * normal[0]
  const kind: BoundaryKind =
    Math.abs(shear) > Math.abs(closing) * 2 ? 'transform' : closing > 0 ? 'convergent' : 'divergent'
  return {
    pair,
    normal,
    closing,
    shear,
    kind,
    point: [p[0] + normal[0] * pair.dist, p[1] + normal[1] * pair.dist],
  }
}

/** The plates whose site lies inside a rectangle of the world (plus a margin), for the arrows. */
export function platesIn(x0: number, y0: number, x1: number, y1: number, f: PlateField): { cell: Cell; site: Vec }[] {
  const out: { cell: Cell; site: Vec }[] = []
  const r = plateReach(f)
  for (let cy = Math.floor(y0 / PLATE_CELL) - r; cy <= Math.floor(y1 / PLATE_CELL) + r; cy++) {
    for (let cx = Math.floor(x0 / PLATE_CELL) - r; cx <= Math.floor(x1 / PLATE_CELL) + r; cx++) {
      const site = plateSite([cx, cy], f)
      if (site[0] >= x0 && site[0] <= x1 && site[1] >= y0 && site[1] <= y1) out.push({ cell: [cx, cy], site })
    }
  }
  return out
}
