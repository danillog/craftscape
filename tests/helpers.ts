import { DEFAULT_WORLD, TileWorld, type WorldOptions } from '../src/tiles/world'

/** A small world for the tests: quick to make and to run. */
export const smallWorld = (opts: Partial<WorldOptions> = {}) => new TileWorld({ ...DEFAULT_WORLD, size: 64, seed: 7, ...opts })

/** Whether every number of an array is finite (no NaN, no infinity). */
export function allFinite(a: ArrayLike<number>): boolean {
  for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i])) return false
  return true
}

/** The state arrays of a world, by name, for checking them all. */
export const stateOf = (w: TileWorld) => ({
  ground: w.ground,
  water: w.water,
  extra: w.extra,
  climate: w.climate,
  lava: w.lava,
  q: w.q,
  airT: w.airT,
  press: w.press,
  windU: w.windU,
  windV: w.windV,
})

/** The share of the tiles that are land (above the sea). */
export function landShare(w: TileWorld): number {
  let land = 0
  for (let i = 0; i < w.n * w.n; i++) if (w.ground[i * 4] > w.sea) land++
  return land / (w.n * w.n)
}

/** Runs a world for a number of ticks. */
export function run(w: TileWorld, ticks: number) {
  for (let k = 0; k < ticks; k++) w.tick()
}
