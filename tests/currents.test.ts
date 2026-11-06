import { describe, expect, it } from 'vitest'
import { latitudeOf } from '../src/tiles/world'
import { allFinite, run, smallWorld } from './helpers'

describe('the ocean currents of the 2D world', () => {
  it('warm and cold currents run along the shores of the wide seas, and none far inland', () => {
    const w = smallWorld({ size: 128 })
    expect(allFinite(w.current)).toBe(true)
    let warm = 0
    let cold = 0
    let inland = 0
    for (let y = 2; y < w.n - 2; y++) {
      for (let x = 2; x < w.n - 2; x++) {
        const i = y * w.n + x
        const sea = w.ground[i * 4] < w.sea
        if (sea && w.current[i] > 1) warm++
        if (sea && w.current[i] < -1) cold++
        // land with land all round it two tiles out: the currents do not reach it
        let coast = false
        for (let dy = -2; dy <= 2 && !coast; dy++) for (let dx = -2; dx <= 2; dx++) if (w.ground[(i + dy * w.n + dx) * 4] < w.sea) coast = true
        if (!sea && !coast && w.current[i] !== 0) inland++
      }
    }
    expect(warm).toBeGreaterThan(20)
    expect(cold).toBeGreaterThan(20)
    expect(inland).toBe(0)
  })

  it('in the subtropics the warm current hugs the sea\'s western shore and the cold one its eastern shore', () => {
    const w = smallWorld({ size: 128 })
    let westShore = 0
    let eastShore = 0
    let westCount = 0
    let eastCount = 0
    for (let y = 0; y < w.n; y++) {
      const lat = Math.abs(latitudeOf(y, w.n))
      if (lat < 20 || lat > 36) continue
      for (let x = 1; x < w.n - 1; x++) {
        const i = y * w.n + x
        if (w.ground[i * 4] >= w.sea || w.current[i] === 0) continue
        // sea with land just to its west: the western shore of that sea; land just to its east: the eastern shore
        if (w.ground[(i - 1) * 4] >= w.sea) {
          westShore += w.current[i]
          westCount++
        }
        if (w.ground[(i + 1) * 4] >= w.sea) {
          eastShore += w.current[i]
          eastCount++
        }
      }
    }
    expect(westCount).toBeGreaterThan(0)
    expect(eastCount).toBeGreaterThan(0)
    expect(westShore / westCount).toBeGreaterThan(0.5)
    expect(eastShore / eastCount).toBeLessThan(-0.5)
  })

  it('warms and cools the sea they run through, and stop when turned off', () => {
    const on = smallWorld({ size: 128, plateDrift: 0 })
    const off = smallWorld({ size: 128, plateDrift: 0, currents: false })
    expect(off.current.every((v) => v === 0)).toBe(true)
    // the daily mean temperature of a sea tile differs by just what the current adds there
    let checked = 0
    for (let i = 0; i < on.n * on.n; i++) {
      if (on.ground[i * 4] >= on.sea || Math.abs(on.current[i]) < 2) continue
      expect(on.climate[i * 4 + 3] - off.climate[i * 4 + 3]).toBeCloseTo(on.current[i], 3)
      checked++
    }
    expect(checked).toBeGreaterThan(10)
    // turned off in a running world, they are gone by the next tick
    on.opts.currents = false
    run(on, 1)
    expect(on.current.every((v) => v === 0)).toBe(true)
  })
})
