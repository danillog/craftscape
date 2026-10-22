import { resampleState } from './io'
import { FAR_TEXELS_PER_WINDOW } from './shaders/sim'
import { STATE_KEYS, type SimState, type StateKey } from './simulation'

/** The simulation window is TILES × TILES regions; it slides one region at a time. */
export const TILES = 4

export type Region = Record<StateKey, Float32Array>

export interface StoredRegion {
  data: Region
  /** Mean height per far-terrain texel (FAR_TEXELS_PER_WINDOW / TILES on a side). */
  far: Float32Array
}

const key = (tx: number, ty: number) => `${tx},${ty}`

/**
 * Regions of the infinite world that have been simulated and then left the window.
 * They are kept as they were (rivers, plants, lava, painted climate) and come back
 * when the window returns; regions never visited are generated from the seed.
 */
export class WorldStore {
  private readonly regions = new Map<string, StoredRegion>()
  /** Cells per region side. */
  cells: number

  constructor(cells: number) {
    this.cells = cells
  }

  get size() {
    return this.regions.size
  }

  get(tx: number, ty: number) {
    return this.regions.get(key(tx, ty))
  }

  entries(): [number, number, StoredRegion][] {
    return [...this.regions].map(([k, region]) => {
      const [tx, ty] = k.split(',').map(Number)
      return [tx, ty, region]
    })
  }

  clear() {
    this.regions.clear()
  }

  set(tx: number, ty: number, data: Region) {
    this.regions.set(key(tx, ty), { data, far: farHeights(data, this.cells) })
  }

  /** Copies the region at window region (lx, ly) out of a window state and keeps it as world region (tx, ty). */
  storeFrom(state: SimState, lx: number, ly: number, tx: number, ty: number) {
    const n = this.cells
    const data = {} as Region
    for (const k of STATE_KEYS) {
      const out = new Float32Array(n * n * 4)
      for (let r = 0; r < n; r++) {
        const start = ((ly * n + r) * state.size + lx * n) * 4
        out.set(state[k].subarray(start, start + n * 4), r * n * 4)
      }
      data[k] = out
    }
    this.set(tx, ty, data)
  }

  /** Resamples every stored region for a new window resolution. */
  resample(cells: number) {
    if (cells === this.cells) return
    for (const [tx, ty, region] of this.entries()) {
      const state = resampleState({ size: this.cells, ...region.data }, cells)
      const data = {} as Region
      for (const k of STATE_KEYS) data[k] = state[k]
      this.regions.set(key(tx, ty), { data, far: farHeights(data, cells) })
    }
    this.cells = cells
  }
}

/** Block-averaged surface heights of a region, for the distant terrain. */
function farHeights(data: Region, cells: number): Float32Array {
  const side = FAR_TEXELS_PER_WINDOW / TILES
  const block = cells / side
  const out = new Float32Array(side * side)
  for (let by = 0; by < side; by++) {
    for (let bx = 0; bx < side; bx++) {
      let sum = 0
      for (let y = 0; y < block; y++) {
        for (let x = 0; x < block; x++) sum += data.ground[((by * block + y) * cells + bx * block + x) * 4]
      }
      out[by * side + bx] = sum / (block * block)
    }
  }
  return out
}
