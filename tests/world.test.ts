import { describe, expect, it } from 'vitest'
import { TICK } from '../src/tiles/world'
import { allFinite, landShare, run, smallWorld, stateOf } from './helpers'

describe('the 2D world', () => {
  it('is born sane: finite everywhere, part land and part sea, a temperate planet', () => {
    const w = smallWorld()
    for (const [name, a] of Object.entries(stateOf(w))) expect(allFinite(a), name).toBe(true)
    const land = landShare(w)
    expect(land).toBeGreaterThan(0.2)
    expect(land).toBeLessThan(0.8)
    expect(w.summary.meanTemp).toBeGreaterThan(0)
    expect(w.summary.meanTemp).toBeLessThan(30)
  })

  it('makes the same land for the same seed, and another for another seed', () => {
    const a = smallWorld({ seed: 3 })
    const b = smallWorld({ seed: 3 })
    const c = smallWorld({ seed: 4 })
    expect(Array.from(a.ground)).toEqual(Array.from(b.ground))
    let differs = 0
    for (let i = 0; i < a.ground.length; i += 4) if (a.ground[i] !== c.ground[i]) differs++
    expect(differs).toBeGreaterThan(a.n * a.n * 0.5)
  })

  it('runs for a while without breaking: finite, no negative water, plants between 0 and 1', () => {
    const w = smallWorld()
    run(w, 600)
    for (const [name, a] of Object.entries(stateOf(w))) expect(allFinite(a), name).toBe(true)
    let minWater = Infinity
    let minPlants = Infinity
    let maxPlants = -Infinity
    for (let i = 0; i < w.n * w.n; i++) {
      minWater = Math.min(minWater, w.water[i * 4])
      minPlants = Math.min(minPlants, w.extra[i * 4])
      maxPlants = Math.max(maxPlants, w.extra[i * 4])
    }
    expect(minWater).toBeGreaterThanOrEqual(0)
    expect(minPlants).toBeGreaterThanOrEqual(0)
    expect(maxPlants).toBeLessThanOrEqual(1.0001)
    expect(w.time).toBeCloseTo(600 * TICK, 5)
    expect(w.summary.meanTemp).toBeGreaterThan(0)
    expect(w.summary.meanTemp).toBeLessThan(30)
  })

  it('keeps its land while the plates drift fast', () => {
    const w = smallWorld({ size: 128, plateDrift: 3 })
    const before = landShare(w)
    run(w, 1500)
    expect(allFinite(w.ground)).toBe(true)
    const after = landShare(w)
    expect(after).toBeGreaterThan(before * 0.6)
    expect(after).toBeLessThan(before * 1.5 + 0.1)
  })

  it('goes back to a snapshot', () => {
    const w = smallWorld()
    run(w, 50)
    const snap = w.snapshot()
    const ground = Array.from(w.ground)
    const time = w.time
    run(w, 100)
    w.raise(32, 32, 6, 0.05)
    w.restore(snap)
    expect(w.time).toBeCloseTo(time, 6)
    expect(Array.from(w.ground)).toEqual(ground)
  })
})

describe('the powers over the 2D world', () => {
  /** A land tile far from the map's edge, and a sea tile. */
  const places = (w: ReturnType<typeof smallWorld>) => {
    let land = -1
    let sea = -1
    for (let y = 16; y < w.n - 16 && (land < 0 || sea < 0); y++) {
      for (let x = 16; x < w.n - 16; x++) {
        const i = y * w.n + x
        if (land < 0 && w.ground[i * 4] > 0.02) land = i
        if (sea < 0 && w.ground[i * 4] < -0.02) sea = i
      }
    }
    return { land: [land % w.n, Math.floor(land / w.n)] as [number, number], sea: [sea % w.n, Math.floor(sea / w.n)] as [number, number] }
  }

  it('raises the land where the terrain brush paints', () => {
    const w = smallWorld()
    const [x, y] = places(w).land
    const i = y * w.n + x
    const before = w.ground[i * 4]
    w.raise(x, y, 4, 0.05)
    expect(w.ground[i * 4]).toBeGreaterThan(before)
  })

  it('pours water where the water brush paints', () => {
    const w = smallWorld()
    const [x, y] = places(w).land
    const i = y * w.n + x
    const before = w.water[i * 4]
    w.pour(x, y, 3, 0.02)
    run(w, 1)
    expect(w.water[i * 4]).toBeGreaterThan(before)
  })

  it('leaves fallout where a bomb falls, and it fades with the years', () => {
    const w = smallWorld()
    const [x, y] = places(w).land
    const i = y * w.n + x
    w.nuke(x, y)
    const fresh = w.fallout[i]
    expect(fresh).toBeGreaterThan(0)
    run(w, 400)
    expect(w.fallout[i]).toBeLessThan(fresh)
  })

  it('melts the planet in a cataclysm and lets it cool again', () => {
    const w = smallWorld()
    w.cataclysm()
    expect(w.genesis).not.toBeNull()
    expect(w.catHeat).toBeGreaterThan(0)
    run(w, 300)
    for (const [name, a] of Object.entries(stateOf(w))) expect(allFinite(a), name).toBe(true)
  })

  it('shakes the land with an earthquake without breaking it', () => {
    const w = smallWorld()
    const [x, y] = places(w).land
    w.quake(x, y, 1, 0, 'convergent', 8)
    run(w, 20)
    expect(allFinite(w.ground)).toBe(true)
  })
})
