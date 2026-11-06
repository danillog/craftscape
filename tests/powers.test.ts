import { describe, expect, it } from 'vitest'
import { CHALLENGES, type WorldMetrics } from '../src/engine/challenges'
import { Powers, type PowerCell, type PowersHost } from '../src/engine/powers'
import { emptyStats, quakeMagnitude, BRUSH_MIN, brushMax, type ClimateReport } from '../src/engine/settings'
import { dayHours, declinationAt, latitudeOfWorld, skyAt } from '../src/engine/sky'

type Vec = [number, number]

const FOREST: PowerCell = { water: 0, vegetation: 0.8, moisture: 0.3, snow: 0, temperature: 22, humidity: 0.4, lava: 0 }
const WARM_SEA: PowerCell = { water: 0.05, vegetation: 0, moisture: 1, snow: 0, temperature: 26, humidity: 0.8, lava: 0 }
const COLD_SEA: PowerCell = { ...WARM_SEA, temperature: 6 }
const toUv = (p: Vec): Vec => p

/** The powers over a world that is the same everywhere (or what `cell` says), keeping what they tell. */
function powersOver(cell: (pos: Vec) => PowerCell | null) {
  const told: string[] = []
  const sounds: string[] = []
  const host: PowersHost = {
    cell,
    wind: () => ({ angle: 0, speed: 0.02 }),
    fault: () => null,
    toast: (text) => told.push(text),
    chronicle: (text) => told.push(text),
    dust: () => {},
    sound: (kind) => sounds.push(kind),
    life: () => null,
  }
  return { powers: new Powers(host), told, sounds }
}

/** Lets simulated time pass in small steps, as the frames do. */
function pass(powers: Powers, seconds: number) {
  for (let t = 0; t < seconds; t += 0.1) powers.update(0.1)
}

describe('the 3D powers: fire', () => {
  it('lights a forest, spreads through it and burns the plants', () => {
    const { powers } = powersOver(() => FOREST)
    const lit = powers.ignite([0.5, 0.5], 0.02)
    expect(lit).toBeGreaterThan(0)
    const acts = powers.acts(toUv, 1, true)
    expect(acts.some((a) => a.kind === 'fire')).toBe(true)
    pass(powers, 20)
    expect(powers.report().fires).toBeGreaterThan(lit)
    expect(powers.report().fires).toBeLessThanOrEqual(500)
    expect(powers.markers(toUv).some((m) => m.kind === 'fire')).toBe(true)
  })

  it('does not burn water, and the rain puts it out', () => {
    expect(powersOver(() => WARM_SEA).powers.ignite([0.5, 0.5], 0.03)).toBe(0)
    let raining = false
    const { powers } = powersOver(() => (raining ? { ...FOREST, humidity: 1, moisture: 1 } : FOREST))
    powers.ignite([0.5, 0.5], 0.02)
    pass(powers, 5)
    expect(powers.report().fires).toBeGreaterThan(0)
    raining = true
    pass(powers, 40)
    expect(powers.report().fires).toBe(0)
  })

  it('goes out where the brush puts it out', () => {
    const { powers } = powersOver(() => FOREST)
    powers.ignite([0.5, 0.5], 0.03)
    expect(powers.extinguish([0.5, 0.5], 0.2)).toBeGreaterThan(0)
    expect(powers.report().fires).toBe(0)
  })
})

describe('the 3D powers: hurricanes', () => {
  it('is born only over warm sea', () => {
    expect(powersOver(() => FOREST).powers.hurricane([0.5, 0.5])).toBe(false)
    expect(powersOver(() => COLD_SEA).powers.hurricane([0.5, 0.5])).toBe(false)
    expect(powersOver(() => WARM_SEA).powers.hurricane([0.5, 0.5])).toBe(true)
  })

  it('grows over warm sea, is handed to the weather as a deep low, and dies over land', () => {
    let land = false
    const { powers } = powersOver(() => (land ? FOREST : WARM_SEA))
    powers.hurricane([0.5, 0.5])
    pass(powers, 60)
    const grown = powers.report().hurricanes[0]
    expect(grown.category).toBeGreaterThanOrEqual(3)
    expect(powers.storms(toUv, 1)[0].strength).toBeGreaterThan(0.6)
    expect(powers.markers(toUv).some((m) => m.kind === 'cyclone')).toBe(true)
    expect(powers.labels(toUv, () => 0)[0].text).toContain(grown.name)
    land = true
    pass(powers, 60)
    expect(powers.report().hurricanes.length).toBe(0)
  })

  it('is forgotten once it leaves the simulated window', () => {
    let gone = false
    const { powers } = powersOver(() => (gone ? null : WARM_SEA))
    powers.hurricane([0.5, 0.5])
    pass(powers, 5)
    gone = true
    pass(powers, 25)
    expect(powers.report().hurricanes.length).toBe(0)
  })
})

describe('the 3D powers: earthquakes, bombs and the cataclysm', () => {
  it('queues the fault slip and its aftershocks, one per frame', () => {
    const { powers } = powersOver(() => FOREST)
    powers.quake([0.5, 0.5], 7)
    expect(powers.nextQuake(toUv)).not.toBeNull()
    expect(powers.nextQuake(toUv)).toBeNull()
    pass(powers, 60)
    let aftershocks = 0
    while (powers.nextQuake(toUv)) aftershocks++
    expect(aftershocks).toBeGreaterThan(0)
  })

  it('raises a tsunami under the sea, not on land', () => {
    const sea = powersOver(() => WARM_SEA)
    sea.powers.quake([0.5, 0.5], 7.5)
    expect(sea.powers.acts(toUv, 1, true).some((a) => a.kind === 'tsunami')).toBe(true)
    expect(sea.told.some((t) => t.includes('Tsunami'))).toBe(true)
    const land = powersOver(() => FOREST)
    land.powers.quake([0.5, 0.5], 7.5)
    expect(land.powers.acts(toUv, 1, true).some((a) => a.kind === 'tsunami')).toBe(false)
  })

  it('opens a rift from magnitude 8.5: fissures that open and close again', () => {
    const { powers } = powersOver(() => FOREST)
    powers.quake([0.5, 0.5], 8.6)
    let opened = 0
    let closed = 0
    for (let t = 0; t < 90; t += 0.1) {
      powers.update(0.1)
      const vent = powers.nextVent(toUv, 1)
      if (vent && vent.delta > 0) opened++
      else if (vent) closed++
    }
    expect(opened).toBe(5)
    expect(closed).toBe(5)
  })

  it('three earthquakes of 9 or more in a row melt the planet; a smaller one between breaks the count', () => {
    const calm = powersOver(() => FOREST)
    calm.powers.quake([0.5, 0.5], 9.2)
    calm.powers.quake([0.5, 0.5], 9.2)
    calm.powers.quake([0.5, 0.5], 7)
    calm.powers.quake([0.5, 0.5], 9.2)
    expect(calm.powers.report().cataclysm).toBe(0)
    const doomed = powersOver(() => FOREST)
    for (let k = 0; k < 3; k++) doomed.powers.quake([0.5, 0.5], 9.2)
    expect(doomed.powers.report().cataclysm).toBeGreaterThan(0)
    expect(doomed.powers.heat).toBeGreaterThan(0)
    expect(doomed.powers.acts(toUv, 1, true).some((a) => a.kind === 'cataclysm')).toBe(true)
    pass(doomed.powers, 600)
    expect(doomed.powers.report().cataclysm).toBe(0)
  })

  it('a bomb digs a crater, raises a mushroom and leaves fallout that fades', () => {
    const { powers, sounds } = powersOver(() => FOREST)
    powers.nuke([0.5, 0.5])
    expect(powers.nextImpact(toUv)).not.toBeNull()
    expect(powers.acts(toUv, 1, true).some((a) => a.kind === 'blast')).toBe(true)
    expect(powers.markers(toUv).some((m) => m.kind === 'blast')).toBe(true)
    expect(powers.report().fallout).toBe(1)
    expect(sounds).toContain('boom')
    pass(powers, 30)
    expect(powers.markers(toUv).some((m) => m.kind === 'blast')).toBe(false)
    pass(powers, 900)
    expect(powers.report().fallout).toBe(0)
  })

  it('forgets everything with a new terrain', () => {
    const { powers } = powersOver(() => FOREST)
    powers.ignite([0.5, 0.5], 0.03)
    powers.nuke([0.4, 0.4])
    powers.reset()
    expect(powers.report()).toEqual({ fires: 0, hurricanes: [], fallout: 0, cataclysm: 0 })
    expect(powers.acts(toUv, 1, true)).toEqual([])
  })
})

describe('the sun by latitude and season', () => {
  it('gives twelve hours at the equinox, the midnight sun and the polar night far north', () => {
    expect(dayHours(0, 0)).toBeCloseTo(12, 5)
    expect(dayHours(45, 0)).toBeCloseTo(12, 5)
    expect(dayHours(80, declinationAt(0.25))).toBeCloseTo(24, 5)
    expect(dayHours(80, declinationAt(0.75))).toBeCloseTo(0, 5)
    expect(dayHours(45, declinationAt(0.25))).toBeGreaterThan(14)
    expect(dayHours(45, declinationAt(0.75))).toBeLessThan(10)
  })

  it('puts the noon sun at the height the latitude gives, in the south, and under the horizon at midnight', () => {
    const noon = skyAt(0.5, 45, 0)
    expect(noon.sun[1]).toBeCloseTo(Math.SQRT1_2, 5)
    expect(noon.sun[2]).toBeGreaterThan(0)
    expect(noon.daylight).toBeCloseTo(1, 5)
    expect(skyAt(0, 45, 0).sun[1]).toBeLessThan(0)
    // morning: the sun in the east
    expect(skyAt(0.3, 45, 0).sun[0]).toBeGreaterThan(0)
    // the old sky, without a latitude, still has day at noon and night at midnight
    expect(skyAt(0.5).daylight).toBeCloseTo(1, 5)
    expect(skyAt(0).daylight).toBeCloseTo(0, 5)
  })

  it('maps the world north to higher latitudes', () => {
    expect(latitudeOfWorld(2)).toBeGreaterThan(latitudeOfWorld(0.5))
    expect(latitudeOfWorld(0.5)).toBeGreaterThan(latitudeOfWorld(-1))
    expect(latitudeOfWorld(-5)).toBe(0)
    expect(latitudeOfWorld(50)).toBe(85)
  })
})

describe('the goals', () => {
  const report: ClimateReport = {
    meanTemp: 14, minTemp: -5, maxTemp: 30, rain: 1, humidity: 0.6, biomes: [0.1, 0.1, 0.1, 0.1, 0.2, 0.1, 0.1, 0.1, 0.1],
    windDirection: 0, windSpeed: 0.5, lows: 0, highs: 0, waterShare: 0.1, iceShare: 0.1, lavaShare: 0, vegetation: 0.3,
  }
  const world: WorldMetrics = { civs: 0, people: 0, maxTech: 0, modernCivs: 0, peaceYears: 0, voyages: 0, nuclearWars: 0, civWarming: 0 }

  it('every goal gives a finite progress, and none is done on an empty world', () => {
    for (const c of CHALLENGES) {
      const p = c.progress(report, report, world)
      expect(Number.isFinite(p), c.id).toBe(true)
      expect(p, c.id).toBeLessThan(1)
    }
  })

  it('the goals about the peoples are reached when the peoples get there', () => {
    const goal = (id: string) => CHALLENGES.find((c) => c.id === id)!
    expect(goal('modern').progress(report, report, { ...world, maxTech: 0.92 })).toBe(1)
    expect(goal('peace').progress(report, report, { ...world, civs: 3, peaceYears: 100 })).toBe(1)
    expect(goal('peace').progress(report, report, { ...world, civs: 2, peaceYears: 100 })).toBe(0)
    expect(goal('sailors').progress(report, report, { ...world, voyages: 5 })).toBe(1)
    expect(goal('no-nukes').progress(report, report, { ...world, modernCivs: 2 })).toBe(1)
    expect(goal('no-nukes').progress(report, report, { ...world, modernCivs: 2, nuclearWars: 1 })).toBe(0)
    expect(goal('brake').progress(report, report, { ...world, maxTech: 0.8, civWarming: 1.5 })).toBe(0)
    expect(goal('thaw').progress({ ...report, iceShare: 0.005 }, report, { ...world, civs: 1 })).toBe(1)
  })

  it('the earthquake brush gives 5 at its smallest and 9.5 at its biggest', () => {
    expect(quakeMagnitude(BRUSH_MIN, 1)).toBeCloseTo(5, 5)
    expect(quakeMagnitude(brushMax(1), 1)).toBeCloseTo(9.5, 5)
    expect(emptyStats.co2).toBe(280)
  })
})
