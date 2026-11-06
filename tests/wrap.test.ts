import { describe, expect, it } from 'vitest'
import { fbm } from '../src/tiles/noise'
import { centreOf, wrap, wrapDelta } from '../src/tiles/wrap'
import { allFinite, landShare, run, smallWorld, stateOf } from './helpers'

describe('round the world: the sums', () => {
  it('wraps a column into the map and finds the short way round', () => {
    expect(wrap(-1, 64)).toBe(63)
    expect(wrap(64, 64)).toBe(0)
    expect(wrap(130.5, 64)).toBeCloseTo(2.5, 9)
    expect(wrapDelta(1, 63, 64)).toBe(2)
    expect(wrapDelta(63, 1, 64)).toBe(-2)
    expect(wrapDelta(10, 4, 64)).toBe(6)
  })

  it('puts the middle of a set that lies across the map\'s edge on the edge', () => {
    const n = 64
    // columns 62, 63, 0, 1 of row 10: the middle is the edge itself
    const across = [62, 63, 0, 1].map((x) => 10 * n + x)
    const [x, y] = centreOf(across, n)
    expect(Math.abs(wrapDelta(x, 63.5, n))).toBeLessThan(0.01)
    expect(y).toBe(10)
    // a set in the middle of the map: the plain mean
    const [mx] = centreOf([30, 31, 32].map((c) => 5 * n + c), n)
    expect(mx).toBeCloseTo(31, 5)
  })

  it('makes noise that repeats east–west when asked', () => {
    for (const y of [0.1, 0.7, 2.3]) {
      expect(fbm(0.3, y, 5, 4, 0.5, 2, 2)).toBeCloseTo(fbm(2.3, y, 5, 4, 0.5, 2, 2), 9)
      expect(fbm(4.999, y, 9, 6, 0.5, 2, 5)).toBeCloseTo(fbm(-0.001, y, 9, 6, 0.5, 2, 5), 2)
    }
  })
})

describe('round the world: the 2D planet has no east or west edge', () => {
  it('the land joins up across the map\'s edge: no cliff there', () => {
    const w = smallWorld({ size: 128 })
    const n = w.n
    let seam = 0
    let inside = 0
    for (let y = 0; y < n; y++) {
      seam += Math.abs(w.ground[(y * n) * 4] - w.ground[(y * n + n - 1) * 4])
      inside += Math.abs(w.ground[(y * n + 40) * 4] - w.ground[(y * n + 41) * 4])
    }
    expect(seam).toBeLessThan(inside * 3 + 0.05)
  })

  it('land may lie on the edge (the sea no longer rings the map east and west)', () => {
    let onEdge = 0
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const w = smallWorld({ size: 64, seed })
      for (let y = 0; y < w.n; y++) if (w.ground[(y * w.n) * 4] > w.sea || w.ground[(y * w.n + w.n - 1) * 4] > w.sea) onEdge++
    }
    expect(onEdge).toBeGreaterThan(0)
  })

  it('a brush on the edge paints both sides of it', () => {
    const w = smallWorld()
    const n = w.n
    const y = 32
    const west = w.ground[(y * n) * 4]
    const east = w.ground[(y * n + n - 1) * 4]
    w.raise(0, y + 0.5, 4, 0.05)
    expect(w.ground[(y * n) * 4]).toBeGreaterThan(west)
    expect(w.ground[(y * n + n - 1) * 4]).toBeGreaterThan(east)
  })

  it('the wind and the pressure read the same at the two ends of a row', () => {
    const w = smallWorld()
    run(w, 60)
    for (const y of [10.5, 32.5, 50.5]) {
      expect(w.sampleCells(w.windU, 0, y)).toBeCloseTo(w.sampleCells(w.windU, w.n, y), 6)
      expect(w.pressureAt(0, y)).toBeCloseTo(w.pressureAt(w.n, y), 6)
    }
  })

  it('a storm crosses the edge and comes back on the other side', () => {
    const w = smallWorld({ planetWinds: false, windDirection: 0, windSpeed: 1.5, pressureSystems: false })
    w.storm(w.n - 3, 32, 5)
    run(w, 400)
    expect(w.storms.length).toBe(1)
    expect(w.storms[0].x).toBeGreaterThanOrEqual(0)
    expect(w.storms[0].x).toBeLessThan(w.n)
    // it started 3 tiles from the east edge and the wind blows east: it is in the west now
    expect(w.storms[0].x).toBeLessThan(w.n / 2)
  })

  it('a hurricane on the edge is not lost off the map', () => {
    const w = smallWorld()
    w.hurricane(0.5, 30)
    run(w, 5)
    for (const h of w.hurricanes) {
      expect(h.x).toBeGreaterThanOrEqual(0)
      expect(h.x).toBeLessThan(w.n)
    }
  })

  it('the plates drift round the world without breaking the land', () => {
    const w = smallWorld({ size: 128, plateDrift: 4, seed: 11 })
    const before = landShare(w)
    run(w, 2500)
    for (const [name, a] of Object.entries(stateOf(w))) expect(allFinite(a), name).toBe(true)
    const after = landShare(w)
    expect(after).toBeGreaterThan(before * 0.6)
    expect(after).toBeLessThan(before * 1.5 + 0.1)
    // every plate's centre is on the map
    for (const s of w.tectonics.sites) {
      if (!s.alive) continue
      expect(s.x).toBeGreaterThanOrEqual(0)
      expect(s.x).toBeLessThanOrEqual(w.n + 0.5)
    }
    // every tile's boundary is a real one: the plate across it is another plate, or its own when alone
    expect(allFinite(w.tectonics.dist)).toBe(true)
  })
})
