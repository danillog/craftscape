// East to west the tile world is round: the map is the planet unrolled, and its left and
// right edges are the same meridian. These are the two sums everything that crosses that
// edge needs.

/** A column of tiles (or of pressure cells) wrapped into 0 … n − 1; a position in tiles into 0 … n. */
export const wrap = (x: number, n: number) => ((x % n) + n) % n

/** The shortest way east–west from b to a, round the world (tiles; negative: a lies west of b). */
export const wrapDelta = (a: number, b: number, n: number) => {
  const d = a - b
  return d - n * Math.round(d / n)
}

/**
 * The middle of a set of tiles of an n-wide map: east–west the mean on the circle (a set
 * that straddles the map's edge has its middle on the edge, not in the middle of the map).
 */
export function centreOf(tiles: ArrayLike<number>, n: number): [number, number] {
  let c = 0
  let s = 0
  let y = 0
  for (let k = 0; k < tiles.length; k++) {
    const i = tiles[k]
    const a = ((i % n) / n) * Math.PI * 2
    c += Math.cos(a)
    s += Math.sin(a)
    y += Math.floor(i / n)
  }
  const count = Math.max(tiles.length, 1)
  return [wrap((Math.atan2(s, c) / (Math.PI * 2)) * n, n), y / count]
}
