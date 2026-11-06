import { describe, expect, it } from 'vitest'
import { Life } from '../src/engine/life'
import { TICK, type TileWorld } from '../src/tiles/world'
import { run, smallWorld } from './helpers'

/** A place (world units, the map is 1 wide) on green land away from the map's edge. */
function goodLand(w: TileWorld, skip = 0): [number, number] {
  let found = 0
  for (let y = 12; y < w.n - 12; y += 3) {
    for (let x = 12; x < w.n - 12; x += 3) {
      const i = y * w.n + x
      if (w.ground[i * 4] > 0.01 && w.water[i * 4] < 0.001 && w.extra[i * 4] > 0.25 && found++ >= skip) return [(x + 0.5) / w.n, (y + 0.5) / w.n]
    }
  }
  throw new Error('no good land in the test world')
}

/** The peoples of a world that is round east to west, as the 2D game makes them. */
function roundLife(): Life {
  const life = new Life()
  life.wrapWidth = 1
  return life
}

/** Runs the world and the peoples together, as the game does, for some simulated seconds. */
function live(w: TileWorld, life: Life, seconds: number) {
  const steps = Math.round(seconds / (4 * TICK))
  for (let k = 0; k < steps; k++) {
    run(w, 4)
    life.update(4 * TICK, w.field, 1)
  }
}

describe('the peoples on the 2D world', () => {
  it('a people called into being founds a town, and the powers over it tell what they did', () => {
    const w = smallWorld({ plateDrift: 0 })
    const life = roundLife()
    life.update(TICK, w.field, 1)
    // the life starts a couple of peoples by itself: count from what is already there
    const before = life.stats()
    let pos = goodLand(w)
    for (let skip = 10; !life.seedCiv(pos, 1); skip += 10) pos = goodLand(w, skip)
    const stats = life.stats()
    expect(stats.civs.length).toBe(before.civs.length + 1)
    expect(stats.villages).toBe(before.villages + 1)
    expect(life.townAt(pos, 0.02)).not.toBeNull()
    for (const power of ['bless', 'inspire', 'plague', 'prophet', 'peace'] as const) {
      expect(typeof life.godPower(power, pos), power).toBe('string')
    }
    // nothing there: no power
    expect(life.godPower('bless', [pos[0] + 0.3, pos[1] + 0.3], 0.01)).toBeNull()
  })

  it('will not found a town on the sea or on top of another', () => {
    const w = smallWorld({ plateDrift: 0 })
    const life = roundLife()
    life.update(TICK, w.field, 1)
    let sea: [number, number] | null = null
    for (let i = 0; i < w.n * w.n && !sea; i++) if (w.water[i * 4] > 0.01) sea = [((i % w.n) + 0.5) / w.n, (Math.floor(i / w.n) + 0.5) / w.n]
    expect(life.seedCiv(sea!, 1)).toBe(false)
    let pos = goodLand(w)
    for (let skip = 10; !life.seedCiv(pos, 1); skip += 10) pos = goodLand(w, skip)
    expect(life.seedCiv(pos, 1)).toBe(false)
  })

  it('lives through decades without breaking: counts stay finite, markers stay on the map', () => {
    const w = smallWorld({ plateDrift: 0 })
    const life = roundLife()
    life.update(TICK, w.field, 1)
    life.seedCiv(goodLand(w), 1)
    life.seedCiv(goodLand(w, 40), 1)
    live(w, life, 300)
    const stats = life.stats()
    expect(Number.isFinite(stats.people)).toBe(true)
    expect(stats.people).toBeGreaterThanOrEqual(0)
    expect(stats.year).toBeGreaterThanOrEqual(29)
    for (const m of life.markers([0, 0], w.n, 1)) {
      expect(Number.isFinite(m.uv[0]) && Number.isFinite(m.uv[1])).toBe(true)
      expect(m.uv[0]).toBeGreaterThanOrEqual(0)
      expect(m.uv[0]).toBeLessThanOrEqual(1)
      expect(m.uv[1]).toBeGreaterThanOrEqual(0)
      expect(m.uv[1]).toBeLessThanOrEqual(1)
    }
    const territory = life.territory([0, 0], w.n, 1)
    if (territory) expect(territory.length).toBeGreaterThan(0)
  })

  it('a nuclear war hands the warheads over once', () => {
    const w = smallWorld({ plateDrift: 0 })
    const life = roundLife()
    life.update(TICK, w.field, 1)
    const a = goodLand(w)
    const b = goodLand(w, 60)
    life.seedCiv(a, 1)
    life.seedCiv(b, 1)
    const told = life.godNuke(a)
    if (told === null) return // the two towns fell too close to be two peoples: nothing to check
    const strikes = life.takeStrikes()
    expect(strikes.length).toBeGreaterThan(0)
    expect(life.takeStrikes().length).toBe(0)
    expect(life.nuclearCount).toBe(1)
  })
})

describe('the peoples on a round world', () => {
  /** A world with green land right at the map's west edge, and that place. */
  function landOnTheEdge(): { w: TileWorld; pos: [number, number] } {
    for (let seed = 1; seed < 40; seed++) {
      const w = smallWorld({ seed, plateDrift: 0 })
      for (let y = 12; y < w.n - 12; y++) {
        const i = y * w.n
        if (w.ground[i * 4] > 0.01 && w.water[i * 4] < 0.001 && w.extra[i * 4] > 0.25) return { w, pos: [0.5 / w.n, (y + 0.5) / w.n] }
      }
    }
    throw new Error('no test world with land on the edge')
  }

  it('a town just across the map\'s edge is near; on a flat world it is a whole map away', () => {
    const { w, pos } = landOnTheEdge()
    const round = roundLife()
    round.update(TICK, w.field, 1)
    expect(round.seedCiv(pos, 1)).toBe(true)
    // from the last column, east of it: the town is one tile away round the world
    const across: [number, number] = [1 - 0.5 / w.n, pos[1]]
    expect(round.townAt(across, 0.03)).not.toBeNull()
    expect(round.godPower('bless', across, 0.03)).not.toBeNull()
    const flat = new Life()
    flat.update(TICK, w.field, 1)
    expect(flat.seedCiv(pos, 1)).toBe(true)
    expect(flat.townAt(across, 0.03)).toBeNull()
  })

  it('its land goes on at the other side of the map', () => {
    const { w, pos } = landOnTheEdge()
    const life = roundLife()
    life.update(TICK, w.field, 1)
    life.seedCiv(pos, 1)
    live(w, life, 2)
    const map = life.territory([0, 0], w.n, 1)
    expect(map).not.toBeNull()
    const T = Math.sqrt(map!.length)
    const row = Math.floor(pos[1] * T)
    // owned on the first column, and (unless the sea is there) round the edge on the last
    expect(map![row * T]).toBeGreaterThan(0)
    const lastIsLand = w.ground[(Math.floor(pos[1] * w.n) * w.n + w.n - 1) * 4] > w.sea && w.water[(Math.floor(pos[1] * w.n) * w.n + w.n - 1) * 4] < 0.002
    if (lastIsLand) expect(map![row * T + T - 1]).toBeGreaterThan(0)
  })

  it('a place past the edge is read as the place round the world', () => {
    const { w, pos } = landOnTheEdge()
    const life = roundLife()
    life.update(TICK, w.field, 1)
    // the same place given a whole world further east or west
    expect(life.surfaceAt([pos[0] + 1, pos[1]], 1)).toBeCloseTo(life.surfaceAt(pos, 1), 9)
    expect(life.surfaceAt([pos[0] - 1, pos[1]], 1)).toBeCloseTo(life.surfaceAt(pos, 1), 9)
  })
})
