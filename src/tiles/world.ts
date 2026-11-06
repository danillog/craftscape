// The tile world: a small grid simulated on the CPU with simple rules (WorldBox-style), so
// it runs anywhere. Temperature from latitude and height, vapour carried by the wind that
// rains out where it is over capacity (and against the slopes it is pushed up), water that
// pools and drains, rivers by flow accumulation, vegetation, snow, ice, sand, lava, fire.
// The state is kept in the same layout the peoples' layer (Life) reads from the 3D game
// (a Field: 4 floats per cell), so the civilizations run unchanged on top of it.

import type { Field } from '../engine/engine'
import type { Work } from '../engine/life'
import { fbm, hash2 } from './noise'
import { wrap, wrapDelta } from './wrap'
import { BOUNDARY_NAMES, Tectonics, type DriftLayer } from './tectonics'

export interface WorldOptions {
  seed: number
  /** Tiles per side. */
  size: number
  /** 0: one landmass, 1: islands. */
  islands: number
  /** Height units above the generated zero that the sea reaches. */
  seaLevel: number
  /** °C added everywhere. */
  temperature: number
  /** Degrees: 0 blows east, 90 south. */
  windDirection: number
  /** 0–1.5: tiles per tick at 1. */
  windSpeed: number
  /** 0–1: humidity of the air blowing in, as a share of what it can hold. */
  windHumidity: number
  /** Highs and lows that form by themselves (warm air and rain make lows, cool air highs). */
  pressureSystems: boolean
  /** How strongly heating differences build those systems (multiplier). */
  pressureStrength: number
  /** How fast the plates drift (1: a plate crosses a tenth of the map in ~5 min at 1×; 0 holds them). */
  plateDrift: number
  /** Earthquakes strike now and then along the plate boundaries. */
  earthquakes: boolean
  /** Volcanoes wake up now and then on the plate boundaries. */
  volcanoes: boolean
  /** The planet's wind belts (trade winds, westerlies, polar easterlies) instead of one wind everywhere. */
  planetWinds: boolean
  /** The sea rises as the planet warms (and falls as it cools), flooding the coasts. */
  seaRise: boolean
  /** The oceans turn: warm and cold currents along the shores change the climate of the coasts. */
  currents: boolean
  /** The temperature keeps rising while the world runs. */
  warming: boolean
  /** °C per simulated minute while warming is on. */
  warmingRate: number
}

export const DEFAULT_WORLD: WorldOptions = {
  seed: 1,
  size: 192,
  islands: 0.3,
  seaLevel: 0,
  temperature: 0,
  windDirection: 0,
  windSpeed: 0.6,
  windHumidity: 0.7,
  pressureSystems: true,
  pressureStrength: 1,
  plateDrift: 1,
  planetWinds: true,
  earthquakes: true,
  volcanoes: true,
  seaRise: true,
  currents: true,
  warming: false,
  warmingRate: 1,
}

/** The options that apply to a running world (the rest make a new one). */
export const LIVE_OPTIONS = [
  'temperature', 'windDirection', 'windSpeed', 'windHumidity', 'pressureSystems', 'pressureStrength',
  'plateDrift', 'earthquakes', 'volcanoes', 'seaRise', 'warming', 'warmingRate', 'planetWinds', 'currents',
] as const

/** A cataclysm: °C it adds at first, ticks the surface stays molten, the heat kept per tick
 *  while cooling (from 140 °C to nothing in ~1700 ticks, ~1½ min at 1×), and below how many
 *  °C of it the rain brings the oceans back. */
const CATACLYSM_HEAT = 140
const MOLTEN_TICKS = 450
const COOLING = 0.997
const OCEANS_RETURN = 70
/** Fallout kept per 10 ticks (half gone in ~25 years), and the °C of cooling the soot of one blast adds. */
const FALLOUT_DECAY = 0.9986
const NUCLEAR_SOOT = 1.2
/**
 * The ocean currents: °C a warm and a cold one add at the shore, how far out they reach
 * (a share of the map's width), how wide a sea must be to turn (the same), the share of
 * their warmth or chill that reaches the land beside them, and the ticks between working
 * them out again (the coasts move slowly).
 */
const CURRENT_WARM = 4
const CURRENT_COLD = 5
const CURRENT_REACH = 0.05
const CURRENT_BASIN = 0.12
const CURRENT_INLAND = 0.6
const CURRENTS_EVERY = 200
/** Simulated seconds in a day: the sun crosses the map (east to west) once in this. */
export const DAY_SIM = 20
/** The warmest hour comes this share of a day after noon (about 2½ hours). */
const AFTERNOON_LAG = 0.1
/**
 * The map is the whole planet (an equirectangular view): the north pole along the top, the
 * equator across the middle, the south pole along the bottom; west to east, 360°.
 * Latitude (degrees, north positive) of a tile row.
 */
export const latitudeOf = (y: number, n: number) => 90 - (180 * (y + 0.5)) / n
/** °C a latitude adds to (or takes from) the planet's base 15 °C, at sea level: about 27 °C at the equator, 12 °C at 45°, 2 °C at 60°, −14 °C at 80°, −23 °C at the poles (as on the Earth, the year round). */
const latitudeTemperature = (lat: number) => 12 - 50 * (Math.abs(lat) / 90) ** 1.7
/**
 * Simulated seconds the seasons take to go round. The climate keeps its own, slower pace
 * than the peoples' year (10 s): history needs short years to get anywhere, and the seasons
 * (and the Earth's shadow bending with them) need time to be seen.
 */
export const SEASON_SIM = 60
/** The axis' tilt (degrees): how far north and south the sun's overhead point travels. */
const TILT = 23.4
/** °C per unit of daily sunlight above or below the year's mean at a latitude, over land and over the sea (the water stores the heat). */
const SEASON_LAND = 50
const SEASON_SEA = 15

/**
 * The day's mean sunlight at a latitude (degrees) when the sun stands over `decl` (degrees),
 * as a share of the sun straight overhead all day (0 in the polar night, ~0.32 at the
 * equator, ~0.4 at a pole in midsummer, when the sun never sets).
 */
export function dailySunlight(lat: number, decl: number) {
  const phi = (lat * Math.PI) / 180
  const d = (decl * Math.PI) / 180
  const x = -Math.tan(phi) * Math.tan(d)
  const h0 = x >= 1 ? 0 : x <= -1 ? Math.PI : Math.acos(x)
  return (h0 * Math.sin(phi) * Math.sin(d) + Math.cos(phi) * Math.cos(d) * Math.sin(h0)) / Math.PI
}
/** The year's mean of the daily sunlight at a latitude (the sun going from tropic to tropic). */
const yearSunlight = (lat: number) => {
  let sum = 0
  for (let k = 0; k < 48; k++) sum += dailySunlight(lat, TILT * Math.sin((k / 48) * Math.PI * 2))
  return sum / 48
}
/** The planet's pressure belts: a low at the equator, highs at 30°, lows at 60°, highs at the poles (anomaly units). */
const BELT_PRESSURE = 0.35
/** Metres per height unit: the lapse rate over the standard 6.5 °C per km (as in the 3D game). */
export const METERS_PER_HEIGHT = (100 / 6.5) * 1000
/** Simulated seconds per tick; the peoples' year is ten simulated seconds. */
export const TICK = 0.05
/** °C colder per height unit. */
export const LAPSE = 100
/** Share of the vapour over capacity that rains out per tick anywhere, and extra on an upslope. */
const CONDENSATION = 0.5
const OROGRAPHIC = 0.35
/** Share of the vapour above 80% of capacity that rains out of warm humid air over land (convection). */
const CONVECTION = 0.12
/** Height units of water a unit of rain leaves on the ground. */
const RUNOFF = 0.004
const EVAPORATION = 0.00012
const WIND_TILES = 1.0
const STORM_LIFE = 1800
/** Storms and hurricanes drift at this share of the wind (as the pressure systems do). */
const SYSTEM_PACE = 0.35
/** Sea temperatures (°C, daily mean) above which a hurricane strengthens, below which it weakens. */
const HURRICANE_WARM = 25
const HURRICANE_COLD = 21
const HURRICANE_NAMES = ['Ana', 'Bruno', 'Carla', 'Davi', 'Elisa', 'Fábio', 'Gabriela', 'Heitor', 'Iara', 'Júlio', 'Kátia', 'Lucas', 'Marta', 'Nuno', 'Olga', 'Paulo', 'Rita', 'Sérgio', 'Tânia', 'Vítor']
const RIVER_EVERY = 20
/** Flow accumulation (rain units drained) from which a stream shows as a river. */
const RIVER_MIN = 12
/**
 * Height units the sea rises per °C of warming, and how fast it moves. Less than the 3D
 * game's 0.004: the tile world's lowlands are flatter (+5 °C floods about a tenth of the land).
 */
const SEA_RISE_PER_DEGREE = 0.0012
const SEA_SPEED = 0.00002
/** The highest step a fault leaves in the ground (height units, ~120 m). */
const MAX_SLIP = 0.008
/** Ticks between earthquakes and between volcanoes waking on the boundaries (on average). */
const QUAKE_TICKS = 1400
const VOLCANO_TICKS = 2600
/** Share of the way the peoples' marks on the land move to what the works ask, per update: they grow fast and fade slowly. */
const HUMAN_GROW = 0.03
const HUMAN_FADE = 0.004
/** Tiles per side of a pressure cell: the weather lives on a coarser grid. */
export const PB = 4
/** Share of the way the pressure moves to what the heating asks for, per tick. */
const PRESSURE_RELAX = 0.0015
/** Wind from the pressure: along the isobars (turning round the lows) and across them (into the lows). */
const GEOSTROPHIC = 5
const CROSS_ISOBAR = 2
const MAX_WIND = 1.6
/** The systems drift slower than the wind that steers them. */
const STEERING = 0.35
/** Pressure units per °C of air warmer (lower) or cooler (higher) than its surroundings. */
const THERMAL = 0.24
/** °C of heating that a unit of rain per tick releases into the air (latent heat). */
const LATENT = 160
/** How strongly converging wind gathers vapour (diverging wind spreads it). */
const CONVERGENCE = 1
/** Share of the gap to 85% humidity that open water breathes into the air over it, per tick. */
const SEA_EVAPORATION = 0.04
/** How much of the wind belts' own converging and diverging counts (the ITCZ's rain, the subtropics' dryness). */
const BELT_DIVERGENCE = 0.2
const DIVERGENCE = 0.6
/** Chance per tick that a travelling high or low comes in with the wind (systems on). */
const SYSTEM_CHANCE = 1 / 500

/** A world as plain data: see TileWorld.snapshot. */
export interface WorldSnapshot {
  opts: WorldOptions
  arrays: Record<string, Float32Array>
  scalars: {
    catHeat?: number
    genesis?: 'molten' | 'cooling' | null
    genesisTicks?: number
    time: number
    ticks: number
    sun: number
    dust: number
    sea: number
    civWarming: number
    forestPeak: number
    quakeClock: number
    volcanoClock: number
  }
  vents: Vent[]
  ash?: AshCloud[]
  hurricanes?: Hurricane[]
  storms: Storm[]
  droughts: Drought[]
  cloudDrift: [number, number]
  tectonics: unknown
}

/** Something that happened in the world worth a notice (the game turns it into a card). */
export interface WorldEvent {
  text: string
  /** An animation to play there (see render.ts Effect), and its size in tiles. */
  fx?: 'quake' | 'eruption' | 'rift' | 'tsunami' | 'hurricane'
  size?: number
  /** A hurricane's strength (0–1) and name. */
  strength?: number
  name?: string
  /** Tile coordinates, when it happened somewhere. */
  x?: number
  y?: number
  major?: boolean
}

export interface Vent {
  x: number
  y: number
  strength: number
  left: number
}
export interface AshCloud {
  x: number
  y: number
  r: number
  /** Ticks left. */
  left: number
}
export interface Hurricane {
  name: string
  x: number
  y: number
  /** 0–1 (see TileWorld.category), and the most it reached. */
  strength: number
  peak: number
  age: number
  overLand: boolean
}
export interface Storm {
  x: number
  y: number
  r: number
  age: number
}
export interface Drought {
  x: number
  y: number
  r: number
}

/** How much vapour air at t °C holds before it rains (1 at 15 °C). */
export const capacity = (t: number) => Math.exp(0.065 * (Math.min(Math.max(t, -40), 50) - 15))
const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v)
export { wrap, wrapDelta }
const smooth = (v: number, a: number, b: number) => {
  const t = clamp((v - a) / (b - a), 0, 1)
  return t * t * (3 - 2 * t)
}

export class TileWorld {
  readonly n: number
  /** Per tile: height, rock, soil, sand (0–1, how much the surface is sand). */
  readonly ground: Float32Array
  /** Per tile: water depth (pools plus river), flux x, flux y, river depth. */
  readonly water: Float32Array
  /** Per tile: vegetation 0–1, soil water 0–1, snow 0–1, ice. */
  readonly extra: Float32Array
  /** Per tile: painted temperature offset, relative humidity, long-run rain (1 typical), temperature °C. */
  readonly climate: Float32Array
  /** Per tile: lava thickness, lava heat, vent, unused. */
  readonly lava: Float32Array
  /** Vapour in the air per tile (1 = what air at 15 °C holds). */
  readonly q: Float32Array
  private readonly qTmp: Float32Array
  /** Rain this tick per tile. */
  readonly rain: Float32Array
  /** Burning, 0–1. */
  readonly fire: Float32Array
  private readonly fireTmp: Float32Array
  /** The water that pools and flows (the river depth is added on top for the Field). */
  private readonly pool: Float32Array
  private readonly poolTmp: Float32Array
  private readonly lavaTmp: Float32Array
  /** Flow accumulation: how much rain drains through each tile (rivers). */
  readonly acc: Float32Array
  private readonly order: Uint32Array
  private readonly sortKeys: Float64Array
  /** Per tile, 0–1: how much a decreed drought (a fixed high) covers it. */
  readonly droughtCover: Float32Array
  /** Per tile, 0–1: how much a storm (a moving low) covers it. */
  readonly stormCover: Float32Array
  /** Pressure cells (PB×PB tiles each) per side. */
  readonly pm: number
  /** Per pressure cell: the air's own highs and lows (thermal, latent heat, painted), advected by the wind. */
  readonly press: Float32Array
  private readonly pressTmp: Float32Array
  /** Per pressure cell: the pressure in effect, the decreed droughts and the storms added. */
  readonly pEff: Float32Array
  /** Per pressure cell: the wind, tiles per tick. */
  readonly windU: Float32Array
  readonly windV: Float32Array
  /** Per pressure cell: the wind that carries the systems along. */
  private readonly steerU: Float32Array
  private readonly steerV: Float32Array
  /** Per tile: the wind and the air's own pressure, sampled from the pressure cells. */
  readonly tileU: Float32Array
  readonly tileV: Float32Array
  readonly tilePress: Float32Array
  /** Per tile: the wind's divergence (tiles per tick per tile; < 0 converging), smooth between the cells. */
  private readonly tileDiv: Float32Array
  private readonly cellDiv: Float32Array
  /** Per row of pressure cells: the wind belts' wind (tiles per tick). */
  private readonly beltU: Float32Array
  private readonly beltV: Float32Array
  private readonly blockT: Float32Array
  private readonly blockBlur: Float32Array
  private readonly blockLand: Float32Array
  private readonly landBlur: Float32Array
  private readonly blockHeat: Float32Array
  private readonly heatBlur: Float32Array
  private readonly anomaly: Float32Array
  private readonly advTmp: Float32Array
  private readonly blurTmp: Float32Array
  /**
   * Per tile: the air's temperature right now (°C), the daily mean (climate[3]) plus the day's
   * swing: warmer by day, cooler by night, by as much as the place lets it (see temperatures).
   */
  readonly airT: Float32Array
  /** Per column: the cosine of the sun's hour angle (see temperatures); per row: the year's mean daily sunlight. */
  private readonly hourCos: Float32Array
  private readonly yearSun: Float32Array
  /** °C a cataclysm still adds to the whole planet (0: none), its stage, and how long into it. */
  catHeat = 0
  genesis: 'molten' | 'cooling' | null = null
  private genesisTicks = 0
  private rainTold = false
  private moltenBase: Float32Array | null = null
  /** The sea level (height units): 0 at the start, it follows the warming when seaRise is on. */
  sea = 0
  /** °C the peoples' industry has added to the planet. */
  civWarming = 0
  /** The plates under the map. */
  tectonics: Tectonics
  private quakeClock = QUAKE_TICKS
  private volcanoClock = VOLCANO_TICKS
  /**
   * The peoples' marks on the land, per tile, 0–1 unless said: fields, cleared forest, town,
   * °C of heat (heat island, smog), height units a dam added. They follow the works while
   * the towns stand and fade back when they are gone (the land heals).
   */
  readonly farmland: Float32Array
  readonly cleared: Float32Array
  readonly urban: Float32Array
  readonly smog: Float32Array
  readonly built: Float32Array
  readonly irrigated: Float32Array
  /** Per tile, 0–1: radioactive fallout from nuclear blasts; it kills the plants and fades over decades. */
  readonly fallout: Float32Array
  /** Per tile: °C the ocean currents add to (or take from) the sea there, and a share of it on the coast beside (see currents). */
  readonly current: Float32Array
  private readonly currentTmp: Float32Array
  /** Whether the currents in `current` were worked out with the option on. */
  private currentsOn = false
  private readonly humanTarget: Float32Array
  /** The most of the land the forest has covered (for the forest lost). */
  forestPeak = 0
  /** Told how the land moved when the plates drift (the game carries the peoples along). */
  onDrift: ((moved: (x: number, y: number) => [number, number] | null) => void) | null = null
  /** The per-tile layers that ride on the plates, and what new ocean floor gets. */
  private get driftLayers(): DriftLayer[] {
    if (this.layersCache) return this.layersCache
    const z1 = [0]
    const z4 = [0, 0, 0, 0]
    this.layersCache = [
      // the ground keeps its depth where new floor opens (the tectonics sinks land left behind)
      { data: this.ground, stride: 4 },
      { data: this.water, stride: 4, fresh: z4 },
      { data: this.extra, stride: 4, fresh: z4 },
      { data: this.climate, stride: 4 },
      { data: this.lava, stride: 4, fresh: z4 },
      { data: this.pool, stride: 1, fresh: z1 },
      { data: this.fire, stride: 1, fresh: z1 },
      { data: this.reference, stride: 1 },
      { data: this.farmland, stride: 1, fresh: z1 },
      { data: this.cleared, stride: 1, fresh: z1 },
      { data: this.urban, stride: 1, fresh: z1 },
      { data: this.smog, stride: 1, fresh: z1 },
      { data: this.built, stride: 1, fresh: z1 },
      { data: this.irrigated, stride: 1, fresh: z1 },
      { data: this.fallout, stride: 1, fresh: z1 },
      // new ocean floor where plates part: it opens young (1) and rides with its plate
      { data: this.tectonics.newFloor, stride: 1, fresh: [1] },
    ]
    return this.layersCache
  }
  private layersCache: DriftLayer[] | null = null
  /** What stands on the land moves with it: the volcanoes' vents here, the peoples through onDrift. */
  private carry = (moved: (x: number, y: number) => [number, number] | null) => {
    for (const v of this.vents) {
      const d = moved(v.x + 0.5, v.y + 0.5)
      if (!d) continue
      v.x = wrap(v.x + d[0], this.n)
      v.y = clamp(v.y + d[1], 0, this.n - 1)
    }
    this.onDrift?.(moved)
  }
  /** How far the clouds' texture has drifted with the prevailing wind, in tiles. */
  cloudDrift: [number, number] = [0, 0]
  /** What happened since the game last looked (it empties this). */
  events: WorldEvent[] = []
  /** The fallout still on the map (to skip the fading when there is none). */
  private falloutLeft = 0
  private fireTiles = 0
  private fireAt: [number, number] = [0, 0]
  private burned = 0
  private lastSystemNews = -10000
  /** The heights at the reference (the new world, or the last reset), for the change map. */
  readonly reference: Float32Array
  readonly field: Field
  opts: WorldOptions
  /** Simulated seconds. */
  time = 0
  ticks = 0
  /** °C the sun power added to the planet. */
  sun = 0
  /** °C of cooling from dust in the air (strikes), decaying. */
  dust = 0
  vents: Vent[] = []
  /** Hurricanes over the map (with their names), and how many have been named. */
  hurricanes: Hurricane[] = []
  private hurricaneCount = 0
  /** Volcanic ash in the air: it drifts with the wind and closes the sky to planes while it lasts. */
  ash: AshCloud[] = []
  storms: Storm[] = []
  droughts: Drought[] = []
  /** Mean temperature and the shares of the land under forest, desert, snow, water (refreshed with the rivers). */
  summary = { meanTemp: 15, forest: 0, desert: 0, snow: 0, water: 0, land: 0 }

  constructor(opts: WorldOptions) {
    this.opts = { ...opts }
    const n = (this.n = opts.size)
    const cells = n * n
    this.ground = new Float32Array(cells * 4)
    this.water = new Float32Array(cells * 4)
    this.extra = new Float32Array(cells * 4)
    this.climate = new Float32Array(cells * 4)
    this.lava = new Float32Array(cells * 4)
    this.q = new Float32Array(cells)
    this.qTmp = new Float32Array(cells)
    this.rain = new Float32Array(cells)
    this.fire = new Float32Array(cells)
    this.fireTmp = new Float32Array(cells)
    this.pool = new Float32Array(cells)
    this.poolTmp = new Float32Array(cells)
    this.lavaTmp = new Float32Array(cells)
    this.acc = new Float32Array(cells)
    this.order = new Uint32Array(cells)
    this.sortKeys = new Float64Array(cells)
    this.droughtCover = new Float32Array(cells)
    this.stormCover = new Float32Array(cells)
    this.reference = new Float32Array(cells)
    this.farmland = new Float32Array(cells)
    this.cleared = new Float32Array(cells)
    this.urban = new Float32Array(cells)
    this.smog = new Float32Array(cells)
    this.built = new Float32Array(cells)
    this.irrigated = new Float32Array(cells)
    this.fallout = new Float32Array(cells)
    this.current = new Float32Array(cells)
    this.currentTmp = new Float32Array(cells)
    this.humanTarget = new Float32Array(cells * 6)
    this.tectonics = new Tectonics(n, opts.seed)
    this.tectonics.continentalTile = (i) => this.ground[i * 4] >= this.sea - 0.02
    const m = (this.pm = Math.ceil(n / PB))
    this.press = new Float32Array(m * m)
    this.pressTmp = new Float32Array(m * m)
    this.pEff = new Float32Array(m * m)
    this.windU = new Float32Array(m * m)
    this.windV = new Float32Array(m * m)
    this.cellDiv = new Float32Array(m * m)
    this.beltU = new Float32Array(m)
    this.beltV = new Float32Array(m)
    this.steerU = new Float32Array(m * m)
    this.steerV = new Float32Array(m * m)
    this.tileU = new Float32Array(cells)
    this.tileV = new Float32Array(cells)
    this.tilePress = new Float32Array(cells)
    this.tileDiv = new Float32Array(cells)
    this.airT = new Float32Array(cells)
    this.hourCos = new Float32Array(n)
    this.yearSun = new Float32Array(n)
    for (let y = 0; y < n; y++) this.yearSun[y] = yearSunlight(latitudeOf(y, n))
    this.blockT = new Float32Array(m * m)
    this.blockBlur = new Float32Array(m * m)
    this.blockLand = new Float32Array(m * m)
    this.landBlur = new Float32Array(m * m)
    this.blockHeat = new Float32Array(m * m)
    this.heatBlur = new Float32Array(m * m)
    this.anomaly = new Float32Array(m * m)
    this.advTmp = new Float32Array(m * m)
    this.blurTmp = new Float32Array(m * m)
    this.field = { size: n, origin: [0, 0], climate: this.climate, water: this.water, extra: this.extra, lava: this.lava, ground: this.ground }
    this.generate()
  }

  // ---- generation ---------------------------------------------------------------------

  /**
   * The relief of a new world for a seed: continents, detail and ridges from noise, the sea
   * always ringing the map (more of it with islands), shifted so a set share lies under the sea.
   */
  private relief(seed: number): Float32Array {
    const n = this.n
    const o = this.opts
    const out = new Float32Array(n * n)
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const nx = x / n
        const ny = y / n
        // (the noise repeats east–west once round the world, so the land joins up across the map's edge)
        const cont = fbm(nx * 2 + 0.3, ny * 1.6 + 0.7, seed + 1, 4, 0.5, 2, 2)
        const detail = fbm(nx * 5, ny * 5, seed + 2, 6, 0.5, 2, 5)
        const ridge = 1 - Math.abs(2 * fbm(nx * 4 + 9, ny * 3.5 + 4, seed + 3, 5, 0.5, 2, 4) - 1)
        // the sea always lies along the top and the bottom of the map (the poles; a continent
        // is never cut straight by them); with islands it reaches further in and the land
        // breaks up. East and west there is no edge: the world goes round
        const edge = Math.min(ny, 1 - ny)
        const rim = (1 - smooth(edge, 0, 0.12)) * 0.5 + o.islands * (1 - smooth(edge, 0.02, 0.2)) * 0.3
        const land = (cont - 0.5) * 0.9 + (detail - 0.5) * 0.4 + 0.17 - o.islands * 0.25 - rim
        out[y * n + x] = land * 0.18 + Math.max(0, land) * ridge * ridge * 0.22
      }
    }
    // the sea reaches a set share of the map whatever the seed: the heights are shifted so
    // that share lies below zero (more with islands), then the sea level asked for
    const sorted = out.slice().sort()
    const shift = sorted[Math.floor((0.42 + 0.25 * o.islands) * n * n)] + o.seaLevel
    for (let i = 0; i < n * n; i++) out[i] = Math.max(out[i] - shift, -0.12)
    return out
  }

  generate() {
    const n = this.n
    const o = this.opts
    const s = o.seed
    const g = this.ground
    const relief = this.relief(s)
    for (let i = 0; i < n * n; i++) {
      const h = relief[i]
      const soil = h > 0 && h < 0.16 ? 0.01 : 0
      g[i * 4] = h
      g[i * 4 + 1] = h - soil
      g[i * 4 + 2] = soil
      g[i * 4 + 3] = 0
      this.pool[i] = h < 0 ? -h : 0
    }
    this.extra.fill(0)
    this.climate.fill(0)
    this.lava.fill(0)
    this.fire.fill(0)
    this.q.fill(0)
    this.acc.fill(0)
    this.vents = []
    this.ash = []
    this.hurricanes = []
    this.storms = []
    this.droughts = []
    this.droughtCover.fill(0)
    this.stormCover.fill(0)
    this.press.fill(0)
    this.events = []
    this.fireTiles = 0
    this.burned = 0
    this.sun = 0
    this.dust = 0
    this.sea = 0
    this.civWarming = 0
    for (const a of [this.farmland, this.cleared, this.urban, this.smog, this.built, this.irrigated, this.fallout]) a.fill(0)
    this.tectonics = new Tectonics(n, o.seed)
    this.tectonics.continentalTile = (i) => this.ground[i * 4] >= this.sea - 0.02
    this.layersCache = null
    this.time = 0
    this.ticks = 0
    this.currents()
    this.temperatures()
    this.pressure(2)
    // the land starts green where it is warm enough, moister towards the coasts
    for (let i = 0; i < n * n; i++) {
      const h = g[i * 4]
      const t = this.climate[i * 4 + 3]
      const moist = fbm((i % n) / n * 4, Math.floor(i / n) / n * 4, s + 5, 4, 0.5, 2, 4)
      const v = h > 0 && h < 0.2 ? smooth(t, 2, 10) * (1 - smooth(t, 32, 40)) * (0.25 + 0.6 * moist) : 0
      this.extra[i * 4] = v
      this.extra[i * 4 + 1] = v * 0.6
      this.q[i] = capacity(t) * o.windHumidity
      this.climate[i * 4 + 1] = o.windHumidity
      this.climate[i * 4 + 2] = 0.5 + moist
    }
    this.rivers()
    this.writeWater()
    this.resetChange()
    this.forestPeak = this.summary.forest
    // the plates follow the land: a plate per continent, oceanic ones between
    this.tectonics.build(this.ground, this.sea)
    this.tectonics.recompute(this.ground, this.sea)
  }

  /** Takes the heights of now as the reference the change map counts from. */
  resetChange() {
    const g = this.ground
    for (let i = 0; i < this.n * this.n; i++) this.reference[i] = g[i * 4]
  }

  // ---- the tick -----------------------------------------------------------------------

  /** One tick of TICK simulated seconds. */
  tick() {
    if (this.ticks % CURRENTS_EVERY === 0 || this.currentsOn !== this.opts.currents) this.currents()
    this.temperatures()
    // the weather's pressure is slow: every other tick, two ticks' worth
    if (this.ticks % 2 === 0) this.pressure(2)
    this.air()
    this.flow()
    this.ground_()
    this.lavaFlow()
    this.burn()
    if (this.ticks % RIVER_EVERY === 0) this.rivers()
    this.writeWater()
    const ang = (this.opts.windDirection * Math.PI) / 180
    this.cloudDrift[0] += Math.cos(ang) * this.opts.windSpeed * WIND_TILES * 0.5
    this.cloudDrift[1] += Math.sin(ang) * this.opts.windSpeed * WIND_TILES * 0.5
    const dust = this.dust
    this.dust = Math.max(0, this.dust - 0.0008)
    if (dust >= 0.3 && this.dust < 0.3) this.events.push({ text: 'A poeira assenta: o sol volta a aquecer o mundo.' })
    this.driftStorms()
    this.driftAsh()
    if (this.ticks % 100 === 0) this.watchSystems()
    // the fallout fades: half gone in ~25 years (every 10 ticks, a tenth of a year)
    if (this.ticks % 10 === 0 && this.falloutLeft > 0) {
      let left = 0
      for (let i = 0; i < this.fallout.length; i++) {
        const f = this.fallout[i]
        if (f <= 0) continue
        const next = f * FALLOUT_DECAY
        this.fallout[i] = next < 0.01 ? 0 : next
        left += this.fallout[i]
      }
      this.falloutLeft = left
    }
    this.genesisStep()
    this.seaLevel()
    this.tectonics.tick(this.ground, this.sea, this.opts.plateDrift, this.driftLayers, this.carry)
    if (this.tectonics.news.length) {
      this.events.push(...this.tectonics.news)
      this.tectonics.news = []
    }
    this.geology()
    this.ticks++
    this.time += TICK
  }

  /** The season, −1 (northern winter) … 1 (northern summer): it goes round once a year. */
  get season() {
    return Math.sin((this.time / SEASON_SIM) * Math.PI * 2)
  }

  /** The latitude (degrees) where the sun stands overhead at noon: the tropics' edges at the solstices. */
  get subsolar() {
    return TILT * this.season
  }

  /** The planet's belt pressure at a latitude (degrees), following the sun north and south. */
  beltPressure(lat: number) {
    const phi = ((lat - this.subsolar * 0.4) * Math.PI) / 180
    return -BELT_PRESSURE * Math.cos(6 * phi)
  }

  /** Where the sun is overhead now (a tile column; it moves west, a day every DAY_SIM). */
  get sunX() {
    return this.n * (1 - ((this.time / DAY_SIM) % 1))
  }

  /**
   * The sun's height at a place (tiles): the cosine of its angle from overhead, from the
   * latitude, the season and the hour; below 0 it has set. Its 0 line is the Earth's shadow:
   * a curve that bends with the seasons (the midnight sun, the polar night).
   */
  sunHeight(x: number, y: number) {
    const phi = (latitudeOf(y, this.n) * Math.PI) / 180
    const d = (this.subsolar * Math.PI) / 180
    return Math.sin(phi) * Math.sin(d) + Math.cos(phi) * Math.cos(d) * Math.cos(((x - this.sunX) / this.n) * Math.PI * 2)
  }

  /**
   * The daily mean temperature (climate[3]: latitude, height, the warming, painted heat,
   * the towns' heat), and the air's temperature now (airT): the mean plus the day's swing,
   * which averages out over a day. The swing is big where the ground heats and cools fast
   * (dry bare land, deserts: ±10 °C), smaller under plants and moist soil, small over water
   * (±0.4 °C), and damped by clouds (humid air): the night under clouds stays mild.
   */
  private temperatures() {
    const n = this.n
    const c = this.climate
    const g = this.ground
    const e = this.extra
    const base = 15 + this.opts.temperature + this.sun - this.dust + this.civWarming + this.catHeat
    // the hour at every column (the cosine of the hour angle, the warmest hour a little after noon)
    for (let x = 0; x < n; x++) this.hourCos[x] = Math.cos(((x - this.sunX) / n - AFTERNOON_LAG) * Math.PI * 2)
    for (let y = 0; y < n; y++) {
      const phi = latitudeOf(y, n)
      const lat = latitudeTemperature(phi)
      // the seasons: summer in the north is winter in the south; more swing towards the poles
      // and over land (the sea's water stores the heat)
      // the seasons from the sunlight: more than the year's mean in summer (long days, a high
      // sun; the midnight sun near the pole), less in winter (short days; the polar night)
      const decl = this.subsolar
      const qDay = dailySunlight(phi, decl)
      const swingYear = qDay - this.yearSun[y]
      // the sun's height through the day here: sin φ sin δ + cos φ cos δ cos(hour)
      const sinPart = Math.sin((phi * Math.PI) / 180) * Math.sin((decl * Math.PI) / 180)
      const cosPart = Math.cos((phi * Math.PI) / 180) * Math.cos((decl * Math.PI) / 180)
      for (let x = 0; x < n; x++) {
        const i = y * n + x
        const h = g[i * 4]
        const surface = Math.max(h, this.sea)
        const seasonal = swingYear * (h >= this.sea ? SEASON_LAND : SEASON_SEA)
        // lava and fire heat the ground and the air over them (lava is ~1000 °C; the air a
        // little above it, scorching)
        const lava = this.lava[i * 4]
        const hot = (lava > 0.0002 ? 40 + 160 * smooth(lava, 0.0002, 0.003) : 0) + (this.fire[i] > 0 ? 25 : 0)
        const mean = base + lat + seasonal - LAPSE * surface + c[i * 4] + this.smog[i] + hot + this.current[i]
        c[i * 4 + 3] = mean
        let swing: number
        if (h < this.sea || this.water[i * 4] > 0.002) swing = 0.4
        else {
          const moist = clamp(e[i * 4 + 1] * 1.2 + e[i * 4] * 0.5, 0, 1)
          swing = 3 + 7 * (1 - moist)
        }
        // clouds (air near saturation) keep the day's heat out and the night's in
        swing *= 1 - 0.6 * smooth(c[i * 4 + 1], 0.75, 1)
        // the day's warmth follows the sun's height (a little after noon), against the day's
        // mean sunlight: hot at a high noon sun, cool at night, no daily swing in the polar night
        const height = Math.max(0, sinPart + cosPart * this.hourCos[x])
        this.airT[i] = mean + swing * clamp((height - qDay) * 2.2, -1, 1)
      }
    }
  }

  /**
   * The ocean currents, read off the shape of the seas. In the subtropics every ocean
   * turns with the wind belts: a warm current runs towards the pole along its western
   * shore (the east coast of a continent) and a cold one comes back along its eastern
   * shore (a west coast, with its fogs and its deserts). Nearer the poles it is the other
   * way round: a warm drift keeps the west coasts mild and a cold current runs down the
   * east coasts. Only a sea wide enough to turn has them. A share of the warmth or the
   * chill reaches the land beside the sea. The warmer sea gives the air more vapour and
   * the colder one less, so the rain on the coasts follows.
   */
  private currents() {
    const n = this.n
    const cur = this.current
    this.currentsOn = this.opts.currents
    if (!this.opts.currents) {
      cur.fill(0)
      return
    }
    const g = this.ground
    const sea = this.sea
    const reach = Math.max(2, CURRENT_REACH * n)
    const wide = CURRENT_BASIN * n
    const west = this.currentTmp
    const bell = (v: number, at: number, width: number) => Math.exp(-(((v - at) / width) ** 2))
    for (let y = 0; y < n; y++) {
      const lat = Math.abs(latitudeOf(y, n))
      const subtropics = bell(lat, 28, 14)
      const subpolar = bell(lat, 58, 12)
      const row = y * n
      // how far the land to the west is: twice round the world, so a sea that crosses the
      // map's edge finds its shore on the other side (a row with no land has none: far)
      let d = Infinity
      for (let k = 0; k < 2 * n; k++) {
        const x = k % n
        d = g[(row + x) * 4] >= sea ? 0 : d + 1
        west[row + x] = d
      }
      // and the land to the east, the same way back (the first lap only measures)
      d = Infinity
      for (let k = 2 * n - 1; k >= 0; k--) {
        const i = row + (k % n)
        if (g[i * 4] >= sea) {
          d = 0
          cur[i] = 0
          continue
        }
        d++
        if (k >= n) continue
        const open = smooth(Math.min(west[i] + d, 1e6), wide * 0.5, wide)
        const w = Math.exp(-west[i] / reach)
        const e = Math.exp(-d / reach)
        cur[i] = open * (subtropics * (CURRENT_WARM * w - CURRENT_COLD * e) + subpolar * (CURRENT_WARM * e - 0.6 * CURRENT_COLD * w))
      }
    }
    // the coast: the land next to the sea takes a share of what the sea beside it has,
    // and the land behind it a share of that
    for (let pass = 0; pass < 2; pass++) {
      west.set(cur)
      for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
          const i = y * n + x
          if (g[i * 4] < sea || west[i] !== 0) continue
          let sum = 0
          let count = 0
          const take = (j: number) => {
            if (west[j] === 0) return
            sum += west[j]
            count++
          }
          take(x > 0 ? i - 1 : i + n - 1)
          take(x < n - 1 ? i + 1 : i - (n - 1))
          if (y > 0) take(i - n)
          if (y < n - 1) take(i + n)
          if (count) cur[i] = (sum / count) * CURRENT_INLAND
        }
      }
    }
  }

  /**
   * The weather's pressure on a coarse grid: air warmer than its surroundings (heated land in
   * the warm season, painted heat, lava, fire, the heat rain releases) makes lows, cooler air
   * highs; the systems drift with the wind and fill in slowly. The decreed droughts (highs) and
   * the storms (lows) are added on top, and the wind follows: the prevailing wind plus a turn
   * round the systems (clockwise round the lows, as in the southern hemisphere the map lies
   * in: see render.ts latAt) and a pull into the lows.
   */
  private pressure(dt: number) {
    const n = this.n
    const m = this.pm
    const o = this.opts
    const g = this.ground
    const P = this.press
    const Pt = this.pressTmp
    const bt = this.blockT
    const land = this.blockLand
    const heat = this.blockHeat
    // the block means: sea-level temperature (mountains are not highs for being cold), land share, heat sources
    bt.fill(0)
    land.fill(0)
    heat.fill(0)
    const count = this.blurTmp
    count.fill(0)
    for (let y = 0; y < n; y++) {
      const by = Math.floor(y / PB)
      for (let x = 0; x < n; x++) {
        const i = y * n + x
        const b = by * m + Math.floor(x / PB)
        const h = g[i * 4]
        bt[b] += this.airT[i] + LAPSE * Math.max(h, 0)
        if (h >= this.sea && this.pool[i] < 0.002) land[b]++
        heat[b] += this.rain[i] * LATENT + (this.lava[i * 4] > 0.0002 ? 6 : 0) + (this.fire[i] > 0 ? 8 : 0)
        count[b]++
      }
    }
    for (let b = 0; b < m * m; b++) {
      bt[b] /= count[b]
      land[b] /= count[b]
      heat[b] /= count[b]
    }
    this.blur(bt, this.blockBlur, 5)
    this.blur(land, this.landBlur, 5)
    this.blur(heat, this.heatBlur, 5)
    // the land heats more than the sea in the warm half of the year and cools more in the cold half
    const season = this.season * 1.5
    const k = o.pressureSystems ? THERMAL * o.pressureStrength : 0
    // advected by the wind of the last tick, at the systems' slower pace (MacCormack: a
    // semi-Lagrangian step back, one forward to measure its error, the error corrected and
    // clamped to the cells it came from; plain bilinear steps would blur the systems away)
    const back = (src: Float32Array, dst: Float32Array, sign: number, limit: boolean) => {
      for (let y = 0; y < m; y++) {
        for (let x = 0; x < m; x++) {
          const b = y * m + x
          // (east–west the air comes round the world)
          const sx = x - (sign * this.steerU[b] * STEERING * dt) / PB
          const sy = clamp(y - (sign * this.steerV[b] * STEERING * dt) / PB, 0, m - 1)
          const xf = Math.floor(sx)
          const y0 = Math.floor(sy)
          const x0 = wrap(xf, m)
          const x1 = wrap(xf + 1, m)
          const y1 = Math.min(y0 + 1, m - 1)
          const fx = sx - xf
          const fy = sy - y0
          const a = src[y0 * m + x0]
          const bb = src[y0 * m + x1]
          const c2 = src[y1 * m + x0]
          const d = src[y1 * m + x1]
          if (limit) {
            // the corrected value, kept within the four cells it came from
            dst[b] = clamp(dst[b], Math.min(a, bb, c2, d), Math.max(a, bb, c2, d))
          } else dst[b] = (a * (1 - fx) + bb * fx) * (1 - fy) + (c2 * (1 - fx) + d * fx) * fy
        }
      }
    }
    const fwd = this.advTmp
    back(P, Pt, 1, false)
    back(Pt, fwd, -1, false)
    for (let b = 0; b < m * m; b++) fwd[b] = Pt[b] + 0.5 * (P[b] - fwd[b])
    back(P, fwd, 1, true)
    Pt.set(fwd)
    // how much warmer than its surroundings each cell's air is, centred so that the highs
    // and the lows balance over the map
    const anomaly = this.anomaly
    let mean = 0
    for (let b = 0; b < m * m; b++) {
      // (the land warmer than the sea in its hemisphere's summer, colder in its winter: the monsoons)
      const hemi = Math.sign(latitudeOf((Math.floor(b / m) + 0.5) * PB - 0.5, n))
      anomaly[b] = bt[b] - this.blockBlur[b] + 4 * (land[b] - this.landBlur[b]) * season * hemi + heat[b] - this.heatBlur[b]
      mean += anomaly[b]
    }
    mean /= m * m
    for (let y = 0; y < m; y++) {
      for (let x = 0; x < m; x++) {
        const b = y * m + x
        const nb = (Pt[x > 0 ? b - 1 : b + m - 1] + Pt[x < m - 1 ? b + 1 : b - (m - 1)] + Pt[y > 0 ? b - m : b] + Pt[y < m - 1 ? b + m : b]) * 0.25
        let v = Pt[b] * 0.98 + nb * 0.02
        const target = clamp(-(anomaly[b] - mean) * k, -1, 1)
        v += (target - v) * PRESSURE_RELAX * dt
        P[b] = clamp(v, -1.5, 1.5)
      }
    }
    // now and then a travelling system comes in from upwind (mostly lows), and the heat of
    // its rain keeps it going while it crosses moist land
    if (o.pressureSystems && Math.random() < SYSTEM_CHANCE * dt * o.pressureStrength) {
      const n2 = n / 2
      const along = (Math.random() - 0.5) * n * 0.8
      const ang = (o.windDirection * Math.PI) / 180
      const dx = Math.cos(ang)
      const dy = Math.sin(ang)
      const x = n2 - dx * n * 0.35 - dy * along
      const y = n2 - dy * n * 0.35 + dx * along
      this.pushPressure(x, y, n * (0.1 + 0.08 * Math.random()), Math.random() < 0.7 ? -1 : 0.8)
    }
    // the pressure in effect: the decreed highs and the storms' lows added
    const pe = this.pEff
    pe.set(P)
    for (let y = 0; y < n; y++) {
      const by = Math.floor(y / PB)
      for (let x = 0; x < n; x++) {
        const i = y * n + x
        const d = this.droughtCover[i] - this.stormCover[i]
        if (d !== 0) pe[by * m + Math.floor(x / PB)] += d / (PB * PB)
      }
    }
    // the wind
    const ang = (o.windDirection * Math.PI) / 180
    const speed = o.windSpeed * WIND_TILES
    for (let y = 0; y < m; y++) {
      // the latitude of the row: the wind belts and the Coriolis turn (f: + north, − south, 0 at the equator)
      // (the belts follow the sun north and south through the year)
      const phi = ((latitudeOf((y + 0.5) * PB - 0.5, n) - this.subsolar * 0.4) * Math.PI) / 180
      const f = Math.sin(phi)
      // the belts: trade winds blowing west and towards the equator (0–30°), westerlies
      // blowing east and poleward (30–60°), polar easterlies (60–90°); calm at the equator,
      // at 30° and at 60° (screen y grows southwards)
      const a = Math.abs(phi)
      const s6 = Math.sin(6 * a)
      const wx = o.planetWinds ? -s6 * (a > Math.PI / 3 ? 0.5 : 1) * speed : Math.cos(ang) * speed
      // (the north–south part is small: on the Earth the belts blow mostly east or west)
      const wy = o.planetWinds ? Math.sign(phi) * s6 * 0.12 * speed : Math.sin(ang) * speed
      this.beltU[y] = wx
      this.beltV[y] = wy
      for (let x = 0; x < m; x++) {
        const b = y * m + x
        const gx = (pe[x < m - 1 ? b + 1 : b - (m - 1)] - pe[x > 0 ? b - 1 : b + m - 1]) * 0.5
        const gy = (pe[y < m - 1 ? b + m : b] - pe[y > 0 ? b - m : b]) * 0.5
        // the systems are steered by the wind without its pull into the lows (that inflow is
        // carried off aloft; advecting with it would fill every low from inside). The turn
        // round them follows the Coriolis force: lows anticlockwise in the north, clockwise
        // in the south, hardly any at the equator
        this.steerU[b] = wx + GEOSTROPHIC * f * gy
        this.steerV[b] = wy - GEOSTROPHIC * f * gx
        let u = wx + GEOSTROPHIC * f * gy - CROSS_ISOBAR * gx
        let v = wy - GEOSTROPHIC * f * gx - CROSS_ISOBAR * gy
        const s = Math.hypot(u, v)
        if (s > MAX_WIND) {
          u *= MAX_WIND / s
          v *= MAX_WIND / s
        }
        this.windU[b] = u
        this.windV[b] = v
      }
    }
    // the divergence per cell (central differences, per tile of distance)
    const U = this.windU
    const V = this.windV
    // (of the weather's own wind, the belts' taken out: their steady rising and sinking is
    // counted only a little, BELT_DIVERGENCE, so the subtropics are dry but not barren)
    const D = this.cellDiv
    const bu = (b: number) => this.beltU[Math.floor(b / m)] * (1 - BELT_DIVERGENCE)
    const bv = (b: number) => this.beltV[Math.floor(b / m)] * (1 - BELT_DIVERGENCE)
    for (let y = 0; y < m; y++) {
      for (let x = 0; x < m; x++) {
        const b = y * m + x
        const xp = x < m - 1 ? b + 1 : b - (m - 1)
        const xm = x > 0 ? b - 1 : b + m - 1
        const yp = y < m - 1 ? b + m : b
        const ym = y > 0 ? b - m : b
        const du = U[xp] - bu(xp) - (U[xm] - bu(xm))
        const dv = V[yp] - bv(yp) - (V[ym] - bv(ym))
        D[b] = (du * 0.5 + dv * (y > 0 && y < m - 1 ? 0.5 : 1)) / PB
      }
    }
    // sampled per tile (bilinear between the cell centres), for the air, the fire and the maps
    for (let y = 0; y < n; y++) {
      // the planet's pressure belts count for the rain (the subtropical highs keep it off)
      const rowBelt = this.opts.planetWinds ? this.beltPressure(latitudeOf(y, n)) : 0
      const sy = clamp((y + 0.5) / PB - 0.5, 0, m - 1)
      const y0 = Math.floor(sy)
      const r0 = y0 * m
      const r1 = Math.min(y0 + 1, m - 1) * m
      const fy = sy - y0
      for (let x = 0; x < n; x++) {
        const sx = (x + 0.5) / PB - 0.5
        const xf = Math.floor(sx)
        const x0 = wrap(xf, m)
        const x1 = wrap(xf + 1, m)
        const fx = sx - xf
        const a = (1 - fx) * (1 - fy)
        const b = fx * (1 - fy)
        const cc = (1 - fx) * fy
        const d = fx * fy
        const i = y * n + x
        this.tileU[i] = U[r0 + x0] * a + U[r0 + x1] * b + U[r1 + x0] * cc + U[r1 + x1] * d
        this.tileV[i] = V[r0 + x0] * a + V[r0 + x1] * b + V[r1 + x0] * cc + V[r1 + x1] * d
        this.tilePress[i] = P[r0 + x0] * a + P[r0 + x1] * b + P[r1 + x0] * cc + P[r1 + x1] * d + rowBelt
        this.tileDiv[i] = D[r0 + x0] * a + D[r0 + x1] * b + D[r1 + x0] * cc + D[r1 + x1] * d
      }
    }
  }

  /** A pressure-cell field read at a point in tiles (bilinear between the cell centres). */
  sampleCells(field: Float32Array, tx: number, ty: number): number {
    const m = this.pm
    const sx = tx / PB - 0.5
    const sy = clamp(ty / PB - 0.5, 0, m - 1)
    const xf = Math.floor(sx)
    const y0 = Math.floor(sy)
    const x0 = wrap(xf, m)
    const x1 = wrap(xf + 1, m)
    const y1 = Math.min(y0 + 1, m - 1)
    const fx = sx - xf
    const fy = sy - y0
    return (field[y0 * m + x0] * (1 - fx) + field[y0 * m + x1] * fx) * (1 - fy) + (field[y1 * m + x0] * (1 - fx) + field[y1 * m + x1] * fx) * fy
  }

  /** A box blur of radius r cells over a pressure-cell field, twice (close to a gaussian). */
  private blur(src: Float32Array, dst: Float32Array, r: number) {
    const m = this.pm
    const t = this.blurTmp
    dst.set(src)
    for (let pass = 0; pass < 2; pass++) {
      for (let y = 0; y < m; y++) {
        for (let x = 0; x < m; x++) {
          let s = 0
          let k = 0
          for (let d = -r; d <= r; d++) {
            s += dst[y * m + wrap(x + d, m)]
            k++
          }
          t[y * m + x] = s / k
        }
      }
      for (let y = 0; y < m; y++) {
        for (let x = 0; x < m; x++) {
          let s = 0
          let k = 0
          for (let d = -r; d <= r; d++) {
            const yy = y + d
            if (yy < 0 || yy >= m) continue
            s += t[yy * m + x]
            k++
          }
          dst[y * m + x] = s / k
        }
      }
    }
  }

  /** Notices for the strong highs and lows that form by themselves (not the decreed ones). */
  private watchSystems() {
    if (!this.opts.pressureSystems || this.ticks - this.lastSystemNews < 1600) return
    const m = this.pm
    const P = this.press
    let lo = 0
    let hi = 0
    for (let b = 1; b < m * m; b++) {
      if (P[b] < P[lo]) lo = b
      if (P[b] > P[hi]) hi = b
    }
    const at = (b: number) => ({ x: ((b % m) + 0.5) * PB, y: (Math.floor(b / m) + 0.5) * PB })
    if (P[lo] < -0.55) {
      this.lastSystemNews = this.ticks
      this.events.push({ text: 'Uma baixa pressão se forma: o vento gira em volta, nuvens e chuva a caminho.', ...at(lo) })
    } else if (P[hi] > 0.55) {
      this.lastSystemNews = this.ticks
      this.events.push({ text: 'Uma alta pressão se instala: ar que desce, céu limpo e tempo seco.', ...at(hi) })
    }
  }

  /** Vapour: carried by the wind, fed by water and plants, rained out over capacity. */
  private air() {
    const n = this.n
    const o = this.opts
    const q = this.q
    const qt = this.qTmp
    const c = this.climate
    const g = this.ground
    const e = this.extra
    const w = this.water
    const rain = this.rain
    const tu = this.tileU
    const tv = this.tileV
    // advection from upwind (bilinear) with the local wind, fresh air at the upwind border
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const i = y * n + x
        const sx = x - tu[i]
        const sy = y - tv[i]
        // (air from beyond the top or the bottom of the map comes in as humid as the setting
        // says; east and west it comes round the world)
        if (sy < 0 || sy > n - 1) {
          qt[i] = o.windHumidity * capacity(c[i * 4 + 3])
          continue
        }
        const xf = Math.floor(sx)
        const y0 = Math.floor(sy)
        const fx = sx - xf
        const fy = sy - y0
        const x0 = wrap(xf, n)
        const x1 = wrap(xf + 1, n)
        const y1 = Math.min(y0 + 1, n - 1)
        qt[i] = (q[y0 * n + x0] * (1 - fx) + q[y0 * n + x1] * fx) * (1 - fy) + (q[y1 * n + x0] * (1 - fx) + q[y1 * n + x1] * fx) * fy
      }
    }
    // a little mixing, then sources, condensation and rain
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const i = y * n + x
        // the upwind neighbour along the main axis of the local wind
        const wx = tu[i]
        const wy = tv[i]
        const calm = Math.abs(wx) < 1e-6 && Math.abs(wy) < 1e-6
        const ux = calm ? 0 : Math.abs(wx) >= Math.abs(wy) ? -Math.sign(wx) : 0
        const uy = calm ? 0 : Math.abs(wy) > Math.abs(wx) ? -Math.sign(wy) : 0
        const xm = x > 0 ? i - 1 : i + n - 1
        const xp = x < n - 1 ? i + 1 : i - (n - 1)
        const ym = y > 0 ? i - n : i
        const yp = y < n - 1 ? i + n : i
        let v = qt[i] * 0.88 + (qt[xm] + qt[xp] + qt[ym] + qt[yp]) * 0.03
        // the wind converging into a low piles the vapour up at its heart (where the air then
        // rises), diverging out of a high spreads it thin: the advection alone does not keep
        // the vapour that flows in
        const div = this.tileDiv[i]
        v *= 1 - clamp(div, -0.04, 0.04) * (div < 0 ? CONVERGENCE : DIVERGENCE)
        // the air now (warm afternoons hold more vapour, cold nights wring it out as dew and fog)
        const t = this.airT[i]
        const drought = this.droughtCover[i]
        const storm = this.stormCover[i]
        // the air's own highs and lows: in a high the air sinks and warms, holds far more
        // vapour before it rains, and the sky clears; in a low it rises and cools, and
        // clouds and rain come easily
        const p = this.tilePress[i]
        const high = smooth(p, 0.05, 0.5)
        const low = smooth(-p, 0.05, 0.5)
        const cap = capacity(t) * (1 + 0.6 * drought + 0.9 * high) * (1 - 0.25 * storm - 0.35 * low)
        const depth = w[i * 4]
        const ice = e[i * 4 + 3]
        if (depth > 0.0005) {
          // open water breathes vapour into the air (frozen water hardly any)
          v += (0.85 * cap - v) * SEA_EVAPORATION * (ice > 0 ? 0.1 : 1)
        } else {
          // plants transpire the soil's water (a forest makes much of its own rain, as the
          // Amazon does), and wet bare soil evaporates too
          const give = Math.min(e[i * 4 + 1], 0.02 * e[i * 4] * cap)
          v += give + Math.min(e[i * 4 + 1] * 0.3, 0.004 * cap)
          e[i * 4 + 1] -= give * 0.25
        }
        // under a decreed drought the air sinks and dries
        if (drought > 0) v = Math.min(v, Math.max(v - 0.01 * drought * cap, 0.45 * cap))
        // and so does the air in a high, more slowly
        if (high > 0) v = Math.min(v, Math.max(v - 0.006 * high * cap, 0.5 * cap))
        let r = 0
        const excess = v - cap
        if (excess > 0) {
          r = excess * CONDENSATION
          v -= r
        }
        // pushed up a slope by the wind, humid air wrings out before the crest
        // (the slope over two tiles, so one bumpy tile does not switch the rule on and off)
        const up = g[i * 4] - g[(clamp(y + 2 * uy, 0, n - 1) * n + wrap(x + 2 * ux, n)) * 4]
        if (up > 0.0015 && v > 0.7 * cap) {
          const r2 = (v - 0.7 * cap) * OROGRAPHIC * Math.min(1, up * 60)
          v -= r2
          r += r2
        }
        // warm humid air over land bubbles up into showers
        if (v > 0.8 * cap && g[i * 4] >= this.sea) {
          const r3 = (v - 0.8 * cap) * CONVECTION * smooth(t, 5, 25)
          v -= r3
          r += r3
        }
        if (storm > 0) r += 0.02 * cap * storm
        // a low lifts the humid air it draws in (the wind turns into it) and wrings it out
        if (low > 0 && v > 0.55 * cap) {
          const r4 = (v - 0.55 * cap) * 0.08 * low
          v -= r4
          r += r4
        }
        r *= (1 - 0.95 * drought) * (1 - 0.9 * high)
        q[i] = Math.max(v, 0)
        rain[i] = r
        c[i * 4 + 1] = q[i] / cap
      }
    }
    // the long-run rain, from the rain blurred over the neighbours: the slope rule picks
    // single tiles, and the sharp pattern would otherwise print on the maps and the soil
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const i = y * n + x
        const rs = 0.5 * rain[i] + 0.125 * (rain[x > 0 ? i - 1 : i + n - 1] + rain[x < n - 1 ? i + 1 : i - (n - 1)] + rain[y > 0 ? i - n : i] + rain[y < n - 1 ? i + n : i])
        c[i * 4 + 2] += (rs * 40 - c[i * 4 + 2]) * 0.004
      }
    }
  }

  /** Water: rain pools on the land and flows downhill, the sea stays put, pools evaporate. */
  private flow() {
    const n = this.n
    const g = this.ground
    const p = this.pool
    const pt = this.poolTmp
    const w = this.water
    const c = this.climate
    const e = this.extra
    const rain = this.rain
    const sea = this.sea
    pt.set(p)
    for (let i = 0; i < n * n; i++) {
      w[i * 4 + 1] = 0
      w[i * 4 + 2] = 0
    }
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const i = y * n + x
        const h = g[i * 4]
        const land = h >= sea
        if (land) {
          // rain soaks the soil and the rest runs off
          const r = rain[i]
          e[i * 4 + 1] = clamp(e[i * 4 + 1] + r * 6 - 0.0004 - 0.0008 * e[i * 4], 0, 1)
          pt[i] += r * RUNOFF
          // the pool evaporates, faster when warm
          const d = pt[i]
          if (d > 0) pt[i] = Math.max(0, d - EVAPORATION * (0.5 + capacity(c[i * 4 + 3])))
        }
        const d = p[i]
        if (d <= 1e-6) continue
        const S = h + d
        // down to the lower neighbours, a share of the difference
        let total = 0
        let gx = 0
        let gy = 0
        const give = (j: number, dirx: number, diry: number) => {
          const dS = S - (g[j * 4] + p[j])
          if (dS <= 0) return
          const f = Math.min(d * 0.25, dS * 0.2)
          pt[i] -= f
          pt[j] += f
          total += f
          gx += f * dirx
          gy += f * diry
        }
        give(x > 0 ? i - 1 : i + n - 1, -1, 0)
        give(x < n - 1 ? i + 1 : i - (n - 1), 1, 0)
        if (y > 0) give(i - n, 0, -1)
        if (y < n - 1) give(i + n, 0, 1)
        w[i * 4 + 1] = gx
        w[i * 4 + 2] = gy
        void total
      }
    }
    for (let i = 0; i < n * n; i++) {
      const h = g[i * 4]
      // the sea is bottomless: whatever drains into it is gone, and it never runs dry
      p[i] = h < sea ? sea - h : Math.max(pt[i], 0)
    }
  }

  /** Rivers by flow accumulation, and the slow erosion along them. */
  private rivers() {
    const n = this.n
    const g = this.ground
    const p = this.pool
    const c = this.climate
    const acc = this.acc
    const order = this.order
    const cells = n * n
    const surface = (i: number) => g[i * 4] + p[i]
    // highest first: the surface (lowest key first, so negated) quantized and packed with
    // the tile's index into one number, sorted natively without a comparator (fast, and no
    // garbage: a comparator sort of every tile stalled a frame each time)
    const keys = this.sortKeys
    for (let i = 0; i < cells; i++) keys[i] = Math.round((1 - surface(i)) * 2 ** 28) * 65536 + i
    keys.sort()
    for (let k = 0; k < cells; k++) order[k] = keys[k] % 65536
    acc.fill(0)
    for (let k = 0; k < cells; k++) {
      const i = order[k]
      const x = i % n
      const y = (i - x) / n
      acc[i] += Math.max(c[i * 4 + 2], 0.05)
      if (g[i * 4] < this.sea) continue
      const S = surface(i)
      let best = -1
      let bestS = S
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue
          const xx = wrap(x + dx, n)
          const yy = y + dy
          if (yy < 0 || yy >= n) continue
          const j = yy * n + xx
          const Sj = surface(j)
          if (Sj < bestS) {
            bestS = Sj
            best = j
          }
        }
      }
      if (best >= 0) {
        acc[best] += acc[i]
        // rivers cut into the land where they run fast
        const slope = S - bestS
        if (acc[i] > 40 && slope > 0.001) {
          const cut = Math.min(0.00002 * Math.min(acc[i] / 60, 6) * Math.min(slope * 100, 1), 0.00008)
          g[i * 4] -= cut
          g[i * 4 + 1] -= cut
        }
      }
    }
    // the summary for the panel
    let temp = 0
    let forest = 0
    let desert = 0
    let snow = 0
    let water = 0
    let land = 0
    // weighted by the area each row stands for (the rows near the poles are stretched on the map)
    let area = 0
    for (let i = 0; i < cells; i++) {
      const wgt = Math.cos((latitudeOf(Math.floor(i / n), n) * Math.PI) / 180)
      area += wgt
      temp += c[i * 4 + 3] * wgt
      if (g[i * 4] < this.sea || p[i] > 0.002) {
        water += wgt
        continue
      }
      land += wgt
      if (this.extra[i * 4] > 0.6) forest += wgt
      if (g[i * 4 + 3] > 0.5) desert += wgt
      if (this.extra[i * 4 + 2] > 0.5) snow += wgt
    }
    this.forestPeak = Math.max(this.forestPeak, forest / Math.max(land, 1e-6))
    this.summary = { meanTemp: temp / area, forest: forest / Math.max(land, 1e-6), desert: desert / Math.max(land, 1e-6), snow: snow / Math.max(land, 1e-6), water: water / area, land: land / area }
  }

  /** The Field's water: pools plus the rivers. */
  private writeWater() {
    const n = this.n
    const w = this.water
    const p = this.pool
    const acc = this.acc
    const g = this.ground
    for (let i = 0; i < n * n; i++) {
      const a = acc[i]
      const river = g[i * 4] >= this.sea && a > RIVER_MIN && p[i] < 0.002 ? Math.min(0.004, 0.0008 + 0.00025 * Math.sqrt(a - RIVER_MIN)) : 0
      w[i * 4 + 3] = river
      w[i * 4] = p[i] + river
    }
  }

  /** Vegetation, snow, ice and sand follow the climate. */
  private ground_() {
    const n = this.n
    const g = this.ground
    const e = this.extra
    const c = this.climate
    const w = this.water
    const l = this.lava
    const fire = this.fire
    for (let i = 0; i < n * n; i++) {
      const t = c[i * 4 + 3]
      const depth = w[i * 4]
      const wet = depth > 0.002
      // the soil water the plants see is shared with the neighbours (groundwater), which
      // keeps a forest tile from drying its own soil while the bare tile next to it soaks
      const x = i % n
      const soil = 0.5 * e[i * 4 + 1] + 0.125 * (e[(x > 0 ? i - 1 : i + n - 1) * 4 + 1] + e[(x < n - 1 ? i + 1 : i - (n - 1)) * 4 + 1] + e[(i >= n ? i - n : i) * 4 + 1] + e[(i < n * n - n ? i + n : i) * 4 + 1])
      const m = clamp(soil * 1.3 + c[i * 4 + 2] * 0.25, 0, 1)
      // (plants get by on little water: steppe and savanna on a semi-arid land, forest where it is wet)
      let target = smooth(t, 2, 10) * (1 - smooth(t, 34, 42)) * smooth(Math.max(m, 0.6 * this.irrigated[i]), 0.04, 0.32)
      // the peoples' marks: the forest cut, fields in its place (green, never forest), towns
      target *= 1 - 0.85 * this.cleared[i]
      const fields = this.farmland[i]
      if (fields > 0) target += (Math.max(0.42, Math.min(target, 0.55)) - target) * fields
      target *= 1 - this.urban[i]
      // radioactive ground grows nothing
      target *= 1 - this.fallout[i]
      if (wet || l[i * 4] > 0.0002 || fire[i] > 0 || t < -2 || g[i * 4] < this.sea) target = 0
      const v = e[i * 4]
      e[i * 4] = v + (target - v) * (target > v ? 0.004 : 0.02)
      // snow on cold land, ice on cold water
      if (!wet && g[i * 4] >= this.sea) e[i * 4 + 2] = t < 0 ? Math.min(1, e[i * 4 + 2] + 0.05) : Math.max(0, e[i * 4 + 2] - 0.03)
      else e[i * 4 + 2] = 0
      e[i * 4 + 3] = (wet || g[i * 4] < this.sea) && t < -2 ? 0.001 : 0
      // hot dry bare land turns to sand
      // and farmed dry land wears out into sand (it heals when the fields are left)
      const sandy = ((t > 22 && m < 0.12 && v < 0.05) || (this.farmland[i] > 0.4 && t > 18 && m < 0.1)) && !wet && g[i * 4] >= this.sea
      g[i * 4 + 3] = clamp(g[i * 4 + 3] + (sandy ? 0.002 : -0.001), 0, 1)
    }
  }

  /** Lava from the vents spreads downhill, cools into rock, burns what it touches. */
  private lavaFlow() {
    const n = this.n
    const l = this.lava
    const lt = this.lavaTmp
    const g = this.ground
    const e = this.extra
    for (let k = this.vents.length - 1; k >= 0; k--) {
      const v = this.vents[k]
      const i = v.y * n + v.x
      l[i * 4] += v.strength * 0.003
      l[i * 4 + 2] = v.strength
      v.left--
      if (v.left <= 0) {
        l[i * 4 + 2] = 0
        this.vents.splice(k, 1)
        this.events.push({ text: 'O vulcão adormece: a lava esfria e vira rocha nova.', x: v.x, y: v.y })
      }
    }
    let any = false
    for (let i = 0; i < n * n; i++) {
      lt[i] = l[i * 4]
      if (lt[i] > 0.0003) any = true
    }
    if (!any) return
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const i = y * n + x
        const d = l[i * 4]
        if (d <= 0.0003) continue
        const S = g[i * 4] + d
        const give = (j: number) => {
          const dS = S - (g[j * 4] + l[j * 4])
          if (dS <= 0) return
          const f = Math.min(d * 0.2, dS * 0.3)
          lt[i] -= f
          lt[j] += f
        }
        give(x > 0 ? i - 1 : i + n - 1)
        give(x < n - 1 ? i + 1 : i - (n - 1))
        if (y > 0) give(i - n)
        if (y < n - 1) give(i + n)
      }
    }
    for (let i = 0; i < n * n; i++) {
      let d = Math.max(lt[i], 0)
      if (d <= 0) {
        l[i * 4] = 0
        continue
      }
      // cooling: the lava turns to rock, and the ground grows
      const cool = d * 0.015
      d -= cool
      g[i * 4] += cool
      g[i * 4 + 1] += cool
      l[i * 4] = d < 0.00005 ? 0 : d
      l[i * 4 + 1] = 1
      if (d > 0.0002) {
        e[i * 4] *= 0.6
        e[i * 4 + 1] = 0
        e[i * 4 + 2] = 0
        this.pool[i] = Math.max(this.pool[i] - d, 0)
        // the forest next to it catches fire
        const x = i % n
        const west = x > 0 ? i - 1 : i + n - 1
        const east = x < n - 1 ? i + 1 : i - (n - 1)
        if (e[west * 4] > 0.3 && Math.random() < 0.02) this.fire[west] = 1
        if (e[east * 4] > 0.3 && Math.random() < 0.02) this.fire[east] = 1
      }
    }
  }

  /** Fire eats the vegetation and spreads downwind through dry forest; rain puts it out. */
  private burn() {
    const n = this.n
    const f = this.fire
    const ft = this.fireTmp
    const e = this.extra
    const rain = this.rain
    const w = this.water
    let burning = 0
    let sx = 0
    let sy = 0
    for (let i = 0; i < n * n; i++) {
      if (f[i] <= 0) continue
      burning++
      sx += i % n
      sy += Math.floor(i / n)
    }
    if (!burning) {
      if (this.fireTiles > 0 && this.burned >= 25) this.events.push({ text: `O incêndio se apaga: ${this.burned} terras queimadas.`, x: this.fireAt[0], y: this.fireAt[1] })
      this.fireTiles = 0
      this.burned = 0
      return
    }
    if (burning > this.fireTiles) this.burned += burning - this.fireTiles
    this.fireTiles = burning
    this.fireAt = [sx / burning, sy / burning]
    ft.set(f)
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const i = y * n + x
        const b = f[i]
        if (b <= 0) continue
        // the fire runs with the local wind
        const ws = Math.hypot(this.tileU[i], this.tileV[i])
        const wx = ws > 1e-6 ? this.tileU[i] / ws : 0
        const wy = ws > 1e-6 ? this.tileV[i] / ws : 0
        const v = e[i * 4]
        e[i * 4] = Math.max(0, v - 0.08 * b)
        e[i * 4 + 1] = Math.max(0, e[i * 4 + 1] - 0.05)
        ft[i] = v < 0.05 || rain[i] > 0.02 ? 0 : Math.max(0, b - 0.02)
        const spread = (j: number, dx: number, dy: number) => {
          if (f[j] > 0 || ft[j] > 0 || e[j * 4] < 0.2 || w[j * 4] > 0.002 || rain[j] > 0.01) return
          const downwind = 1 + 2 * Math.max(0, dx * wx + dy * wy)
          if (Math.random() < 0.06 * e[j * 4] * (1 - 0.8 * e[j * 4 + 1]) * downwind * b) ft[j] = 1
        }
        spread(x > 0 ? i - 1 : i + n - 1, -1, 0)
        spread(x < n - 1 ? i + 1 : i - (n - 1), 1, 0)
        if (y > 0) spread(i - n, 0, -1)
        if (y < n - 1) spread(i + n, 0, 1)
      }
    }
    f.set(ft)
  }

  /**
   * The storms and the hurricanes move and leave their mark: a storm drifts at the pace of
   * the weather systems (a third of the wind round it), deepens within a second and presses
   * its low into the air's own pressure (which then lives on, carried by the wind, after the
   * storm is gone); a hurricane steers the same way, westward and then towards the pole,
   * feeding on warm sea and dying over land or cold water. Both rain hard under them.
   */
  private driftStorms() {
    if (!this.storms.length && !this.hurricanes.length) {
      if (this.stormCover[0] !== 0 || this.stormCoverDirty) {
        this.stormCover.fill(0)
        this.stormCoverDirty = false
      }
      return
    }
    const n = this.n
    for (const s of this.storms) {
      s.x = wrap(s.x + this.sampleCells(this.windU, s.x, s.y) * SYSTEM_PACE, n)
      s.y += this.sampleCells(this.windV, s.x, s.y) * SYSTEM_PACE
      s.age++
      if (s.age % 4 === 0) this.pushPressure(s.x, s.y, s.r, -0.02 * this.stormStrength(s))
    }
    for (const s of this.storms) {
      if (s.age >= STORM_LIFE) this.events.push({ text: 'A tempestade perde força e se desfaz.', x: s.x, y: s.y })
    }
    this.storms = this.storms.filter((s) => s.age < STORM_LIFE && s.y > -s.r && s.y < n + s.r)
    this.driftHurricanes()
    this.stormCover.fill(0)
    this.stormCoverDirty = true
    for (const s of this.storms) this.disc(this.stormCover, s.x, s.y, s.r, this.stormStrength(s))
    for (const h of this.hurricanes) this.disc(this.stormCover, h.x, h.y, this.hurricaneRadius(h), Math.min(1, 0.5 + h.strength))
  }

  /** How deep a storm is at its age (0–1): it deepens in a second, holds, then fills in. */
  private stormStrength(s: Storm) {
    return s.age < 20 ? s.age / 20 : s.age > STORM_LIFE - 400 ? (STORM_LIFE - s.age) / 400 : 1
  }

  // ---- hurricanes -----------------------------------------------------------------------

  /** The rain band's radius (tiles): wider as it strengthens. */
  hurricaneRadius(h: Hurricane) {
    return 9 + 11 * h.strength
  }

  /** Category 1–5 (0: a tropical storm), from the strength. */
  static category(strength: number) {
    return strength < 0.2 ? 0 : Math.min(5, 1 + Math.floor((strength - 0.2) / 0.16))
  }

  /** A hurricane is born here (over land it starts weak and soon dies). */
  hurricane(cx: number, cy: number) {
    const name = HURRICANE_NAMES[this.hurricaneCount++ % HURRICANE_NAMES.length]
    const i = this.tileAt(cx, cy)
    const sea = this.ground[i * 4] < this.sea
    this.hurricanes = [...this.hurricanes, { name, x: cx, y: cy, strength: sea ? 0.3 : 0.15, age: 0, overLand: !sea, peak: 0 }].slice(-4)
    this.events.push({ text: `Nasce o furacão ${name}${sea ? '' : ', mas sobre terra: vai morrer logo'}.`, x: cx, y: cy, major: true })
  }

  private driftHurricanes() {
    if (!this.hurricanes.length) {
      // now and then one is born over a very warm sea
      if (this.opts.pressureSystems && this.ticks % 200 === 0 && Math.random() < 0.02) {
        // in the tropics, but not on the equator itself (no Coriolis turn there to spin it up)
        const x = Math.floor(Math.random() * this.n)
        const y = Math.floor(Math.random() * this.n)
        const i = y * this.n + x
        const lat = Math.abs(latitudeOf(y, this.n))
        if (lat > 5 && lat < 28 && this.ground[i * 4] < this.sea - 0.02 && this.climate[i * 4 + 3] > HURRICANE_WARM + 1) this.hurricane(x, y)
      }
      return
    }
    const n = this.n
    for (const h of this.hurricanes) {
      const i = this.tileAt(h.x, h.y)
      const sea = this.ground[i * 4] < this.sea
      const t = this.climate[i * 4 + 3]
      // warm sea (25 °C and more) feeds it; cold sea starves it; land kills it (no more warm water to drink)
      const grow = sea ? (t > HURRICANE_WARM ? 0.0012 * Math.min(2, (t - HURRICANE_WARM) / 2) : t < HURRICANE_COLD ? -0.0015 : -0.0002) : -0.0015
      h.strength = clamp(h.strength + grow, 0, 1)
      h.peak = Math.max(h.peak, h.strength)
      // steered by the wind around it (west with the trades), curving towards its own pole
      const pole = latitudeOf(h.y, n) >= 0 ? -1 : 1
      h.x = wrap(h.x + this.sampleCells(this.windU, h.x, h.y) * SYSTEM_PACE - 0.03 * (1 - Math.min(1, h.age / 2000)), n)
      h.y += this.sampleCells(this.windV, h.x, h.y) * SYSTEM_PACE + pole * (0.03 + 0.04 * Math.min(1, h.age / 1500))
      h.age++
      // its low: deep, and deeper as it strengthens
      if (h.age % 2 === 0) this.pushPressure(h.x, h.y, 6 + 8 * h.strength, -0.06 * (0.3 + h.strength))
      const cat = TileWorld.category(h.strength)
      if (!sea && !h.overLand) {
        this.events.push({ text: `O furacão ${h.name} atinge a terra ${cat ? `como categoria ${cat}` : 'já enfraquecido'}.`, x: h.x, y: h.y, major: cat >= 3 })
      }
      h.overLand = !sea
      // the wind and the rain strike what is under it, and the sea surges onto the coast
      if (h.age % 30 === 0) {
        this.events.push({ text: '', x: h.x, y: h.y, fx: 'hurricane', size: this.hurricaneRadius(h) * 0.8, strength: h.strength, name: h.name })
        if (h.strength > 0.35 && this.seaNear(h.x, h.y, 4)) this.floodCoast(h.x, h.y, this.hurricaneRadius(h) * 0.7, 0.6 * h.strength)
      }
    }
    for (const h of this.hurricanes) {
      if (h.strength < 0.04) this.events.push({ text: `O furacão ${h.name} se desfaz (chegou à categoria ${TileWorld.category(h.peak) || '—'}).`, x: h.x, y: h.y })
    }
    for (const h of this.hurricanes) {
      if (h.strength >= 0.04 && (h.y < 0 || h.y >= n)) this.events.push({ text: `O furacão ${h.name} se perde além do polo.` })
    }
    this.hurricanes = this.hurricanes.filter((h) => h.strength >= 0.04 && h.y >= 0 && h.y < n)
  }

  private stormCoverDirty = false

  /** Adds a soft disc (1 at the centre, 0 at the edge) to a per-tile cover. */
  private disc(cover: Float32Array, cx: number, cy: number, r: number, strength: number) {
    const n = this.n
    // (east–west the disc goes round the world: the columns are wrapped)
    const x0 = Math.floor(cx - r)
    const x1 = Math.ceil(cx + r)
    const y0 = Math.max(0, Math.floor(cy - r))
    const y1 = Math.min(n - 1, Math.ceil(cy + r))
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const d = Math.hypot(x - cx, y - cy) / r
        if (d >= 1) continue
        const i = y * n + wrap(x, n)
        cover[i] = Math.max(cover[i], (1 - smooth(d, 0.5, 1)) * strength)
      }
    }
  }

  private refreshDroughts() {
    this.droughtCover.fill(0)
    for (const d of this.droughts) this.disc(this.droughtCover, d.x, d.y, d.r, 1)
  }

  // ---- the sea, the plates, the peoples' marks ------------------------------------------

  /** The warming in effect (the slider, the sun power, the industry): what the sea follows. */
  get warming() {
    return this.opts.temperature + this.sun + this.civWarming
  }

  /** The sea creeps towards the level the warming asks for (or back to 0 with seaRise off). */
  private seaLevel() {
    let target = this.opts.seaRise ? clamp(this.warming * SEA_RISE_PER_DEGREE, -0.04, 0.08) : 0
    let speed = SEA_SPEED
    if (this.genesis) {
      // a cataclysm boils the oceans away, and the rain fills them again as the planet cools
      const back = this.genesis === 'molten' ? 0 : smooth(OCEANS_RETURN - this.catHeat, 0, OCEANS_RETURN - 5)
      target = -0.125 + (target + 0.125) * back
      speed = 0.0005
      this.sea += clamp(target - this.sea, -speed, speed)
      return
    }
    const before = this.sea
    this.sea += clamp(target - this.sea, -speed, speed)
    // a notice every 0.003 height units the sea climbs or drops
    const step = (h: number) => Math.floor(h / 0.003)
    if (step(this.sea) !== step(before) && Math.abs(target - this.sea) > 1e-6) {
      this.events.push({
        text: this.sea > before ? 'O mar sobe com o aquecimento e avança sobre as costas baixas.' : 'O mar recua com o frio: novas praias aparecem.',
        major: Math.abs(this.sea) >= 0.006,
      })
    }
  }

  /** Earthquakes and volcanoes along the plate boundaries, now and then. */
  private geology() {
    const o = this.opts
    const t = this.tectonics
    if (o.earthquakes && --this.quakeClock <= 0) {
      this.quakeClock = QUAKE_TICKS * (0.5 + Math.random())
      const b = t.busySpot((b) => Math.abs(b.closing) + Math.abs(b.shear))
      if (b) this.quake(b.x, b.y, b.nx, b.ny, b.kind, 5 + 2.5 * Math.random() ** 2)
    }
    if (o.volcanoes && --this.volcanoClock <= 0) {
      this.volcanoClock = VOLCANO_TICKS * (0.5 + Math.random())
      const b = t.busySpot((b) => (b.kind === 'convergent' ? b.closing * 2 : b.kind === 'divergent' ? -b.closing : 0), 0.05)
      if (!b) return
      const x = wrap(Math.round(b.x), this.n)
      const y = clamp(Math.round(b.y), 0, this.n - 1)
      const i = y * this.n + x
      // not under the deep sea, not on another vent
      if (this.ground[i * 4] < this.sea - 0.01 || this.vents.some((v) => Math.hypot(wrapDelta(v.x, x, this.n), v.y - y) < 10)) return
      this.erupt(x, y, 0.5 + 0.5 * Math.random())
      this.events.push({ text: `Um vulcão desperta onde as ${BOUNDARY_NAMES[b.kind]}.`, x, y, major: true, fx: 'eruption', size: 5 })
    }
  }

  /**
   * A fault slips: where the plates collide one side jumps up (a scarp), where they part a
   * strip drops (a rift); the shaking shakes rubble loose on the slopes. Magnitude 5–7.5.
   */
  quake(cx: number, cy: number, nx: number, ny: number, kind: 'convergent' | 'divergent' | 'transform', magnitude: number) {
    const scale = 10 ** ((magnitude - 6) / 2)
    const r = Math.min(Math.max(10 * scale, 4), 40)
    // the step the fault leaves in the ground: some metres on the Earth (tens in the very
    // greatest quakes); here exaggerated to be seen, but capped (~120 m): a great quake must
    // not lift and drop the whole map
    const slip = Math.min(0.004 * scale, MAX_SLIP)
    const g = this.ground
    this.brush(cx, cy, r, (i, cover, x, y) => {
      const side = x * nx + y * ny
      let dh = 0
      if (kind === 'convergent' && side < 0) dh = slip * cover
      else if (kind === 'divergent' && Math.abs(side) < 2) dh = -slip * cover
      if (dh) {
        g[i * 4] = Math.max(g[i * 4] + dh, -0.12)
        g[i * 4 + 1] = g[i * 4] - g[i * 4 + 2]
      }
      // rubble on steep ground
      const xm = i % this.n > 0 ? i - 1 : i + this.n - 1
      if (Math.abs(g[i * 4] - g[xm * 4]) > 0.004) g[i * 4 + 3] = Math.min(1, g[i * 4 + 3] + 0.3 * cover)
    })
    this.tectonics.refresh()
    const m = magnitude.toFixed(1).replace('.', ',')
    this.events.push({ text: `Terremoto de magnitude ${m}: ${BOUNDARY_NAMES[kind]}.`, x: cx, y: cy, major: magnitude >= 7, fx: 'quake', size: r })
    // under the sea (or at the shore) a strong quake lifts the water: a tsunami
    if (magnitude >= 6.3 && this.seaNear(cx, cy, 3)) this.tsunami(cx, cy, 20 + (magnitude - 6) * 25)
  }

  /**
   * The peoples' works mark the land (the 3D game's worksShader, kept reversible): fields
   * replace the wild cover, the forest is cut for wood around the towns, the big towns pave
   * the ground and hold heat, industry adds smog and heat and harms the plants, irrigation
   * keeps the fields wet, dams raise a wall across the river. Every mark fades back slowly
   * once nobody keeps it up. Works in map uv (life.works([0, 0], n, 1)); kind 0: a
   * village's wood cutting only.
   */
  applyWorks(works: Work[]) {
    const n = this.n
    const T = this.humanTarget
    T.fill(0)
    const cells = n * n
    // targets: 0 farmland, 1 cleared, 2 urban, 3 smog °C, 4 built, 5 irrigated
    const disc = (cx: number, cy: number, r: number, fn: (i: number, cover: number) => void) => {
      const x0 = Math.floor(cx - r)
      const x1 = Math.ceil(cx + r)
      const y0 = Math.max(0, Math.floor(cy - r))
      const y1 = Math.min(n - 1, Math.ceil(cy + r))
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) / Math.max(r, 0.5)
          if (d < 1) fn(y * n + wrap(x, n), 1 - smooth(d, 0.6, 1))
        }
      }
    }
    const put = (k: number, i: number, v: number) => {
      const j = k * cells + i
      if (v > T[j]) T[j] = v
    }
    for (const w of works) {
      const cx = w.uv[0] * n
      const cy = w.uv[1] * n
      const r = w.radius * n
      if (w.kind === 8) {
        // a dam: a wall across the river (strength, size: its direction), up to its crest
        const dx = w.strength
        const dy = w.size
        const crest = w.crest ?? 0
        disc(cx, cy, r + 1, (i) => {
          const rx = wrapDelta((i % n) + 0.5, cx, n)
          const ry = Math.floor(i / n) + 0.5 - cy
          const along = rx * dx + ry * dy
          const across = Math.abs(rx * dy - ry * dx)
          if (Math.abs(along) > r || across > 1.2) return
          const bed = this.ground[i * 4] - this.built[i]
          put(4, i, Math.max(0, crest - bed))
        })
        continue
      }
      const tech = w.strength
      // any village: wood for fires and huts, cut around it
      if (w.kind === 0) {
        disc(cx, cy, r * 1.5, (i, c) => put(1, i, c * (0.3 + 0.4 * w.size)))
        continue
      }
      if (w.kind & 1) {
        disc(cx, cy, r, (i, c) => put(0, i, c * (0.6 + 0.4 * tech)))
        // the wood: the forest around the fields is cut, more by bigger, more advanced towns
        disc(cx, cy, r * 1.9, (i, c) => put(1, i, c * Math.min(0.9, 0.25 + 0.45 * w.size + 0.35 * tech)))
      }
      if (w.kind & 16) disc(cx, cy, r, (i, c) => put(5, i, c))
      if (w.kind & 32) disc(cx, cy, r * 0.35, (i, c) => {
        put(2, i, c)
        put(3, i, 1.5 * c)
      })
      if (w.kind & 4) disc(cx, cy, r * 1.2, (i, c) => {
        put(3, i, 3.5 * c)
        put(1, i, 0.5 * c)
      })
    }
    const layers = [this.farmland, this.cleared, this.urban, this.smog, this.built, this.irrigated]
    const g = this.ground
    for (let k = 0; k < layers.length; k++) {
      const a = layers[k]
      for (let i = 0; i < cells; i++) {
        const target = T[k * cells + i]
        const v = a[i]
        if (v === target) continue
        let next = v + (target - v) * (target > v ? HUMAN_GROW : HUMAN_FADE)
        if (Math.abs(next - target) < 1e-4) next = target
        if (k === 4) {
          // a dam's wall is ground: raise it bit by bit, or let it wear away
          const dh = clamp(next - v, -0.00002, 0.0002)
          next = v + dh
          g[i * 4] += dh
          g[i * 4 + 1] += dh
        }
        a[i] = next
      }
    }
  }

  /** How the peoples have changed the land: the shares of the land farmed, cut, built on; the forest lost since the start. */
  humanSummary() {
    const n = this.n
    let land = 0
    let farmed = 0
    let cut = 0
    let towns = 0
    for (let i = 0; i < n * n; i++) {
      if (this.ground[i * 4] < this.sea) continue
      land++
      if (this.farmland[i] > 0.3) farmed++
      if (this.cleared[i] > 0.3) cut++
      if (this.urban[i] > 0.3) towns++
    }
    const L = Math.max(land, 1)
    return {
      farmed: farmed / L,
      cut: cut / L,
      urban: towns / L,
      forestLost: this.forestPeak > 0 ? Math.max(0, 1 - this.summary.forest / this.forestPeak) : 0,
    }
  }

  // ---- snapshots (undo, rewind, saved worlds) ----------------------------------------------

  /** The per-tile state worth keeping (the rest is worked out again from it). */
  private get stateArrays(): Record<string, Float32Array> {
    return {
      ground: this.ground, water: this.water, extra: this.extra, climate: this.climate, lava: this.lava, q: this.q,
      fire: this.fire, pool: this.pool, acc: this.acc, reference: this.reference, press: this.press,
      farmland: this.farmland, cleared: this.cleared, urban: this.urban, smog: this.smog, built: this.built, irrigated: this.irrigated,
      fallout: this.fallout,
    }
  }

  /** Everything the world is, as plain data (copies). */
  snapshot(): WorldSnapshot {
    const arrays: Record<string, Float32Array> = {}
    for (const [k, a] of Object.entries(this.stateArrays)) arrays[k] = a.slice()
    return {
      opts: { ...this.opts },
      arrays,
      scalars: {
        catHeat: this.catHeat, genesis: this.genesis, genesisTicks: this.genesisTicks,
        time: this.time, ticks: this.ticks, sun: this.sun, dust: this.dust, sea: this.sea, civWarming: this.civWarming,
        forestPeak: this.forestPeak, quakeClock: this.quakeClock, volcanoClock: this.volcanoClock,
      },
      vents: structuredClone(this.vents),
      ash: structuredClone(this.ash),
      hurricanes: structuredClone(this.hurricanes),
      storms: structuredClone(this.storms),
      droughts: structuredClone(this.droughts),
      cloudDrift: [...this.cloudDrift] as [number, number],
      tectonics: this.tectonics.snapshot(),
    }
  }

  /** Back to a snapshot of a world of the same size. */
  restore(s: WorldSnapshot) {
    // a world saved before an option existed gets that option's default
    this.opts = { ...DEFAULT_WORLD, ...s.opts }
    for (const [k, a] of Object.entries(this.stateArrays)) if (s.arrays[k]) a.set(s.arrays[k])
    const v = s.scalars
    this.time = v.time
    this.ticks = v.ticks
    this.sun = v.sun
    this.dust = v.dust
    this.sea = v.sea
    this.civWarming = v.civWarming
    this.forestPeak = v.forestPeak
    this.quakeClock = v.quakeClock
    this.volcanoClock = v.volcanoClock
    this.catHeat = v.catHeat ?? 0
    this.genesis = v.genesis ?? null
    this.genesisTicks = v.genesisTicks ?? 0
    this.vents = structuredClone(s.vents)
    this.ash = structuredClone(s.ash ?? [])
    this.hurricanes = structuredClone(s.hurricanes ?? [])
    this.storms = structuredClone(s.storms)
    this.droughts = structuredClone(s.droughts)
    this.cloudDrift = [...s.cloudDrift] as [number, number]
    this.tectonics.restore(s.tectonics)
    this.falloutLeft = 1
    this.events = []
    this.refreshDroughts()
    this.currents()
    this.temperatures()
    this.writeWater()
  }

  // ---- the powers ---------------------------------------------------------------------

  /** Raises (or lowers) the land in a disc, height units at the centre. */
  raise(cx: number, cy: number, r: number, amount: number) {
    this.brush(cx, cy, r, (i, cover) => {
      const g = this.ground
      const dh = amount * cover
      g[i * 4] = Math.max(g[i * 4] + dh, -0.12)
      g[i * 4 + 1] = g[i * 4] - g[i * 4 + 2]
      if (g[i * 4] < this.sea) this.pool[i] = this.sea - g[i * 4]
      else if (dh > 0 && this.pool[i] > 0) this.pool[i] = Math.max(0, this.pool[i] - dh)
    })
  }

  /** Adds (or takes) pooled water in a disc. */
  pour(cx: number, cy: number, r: number, amount: number) {
    this.brush(cx, cy, r, (i, cover) => {
      if (this.ground[i * 4] < this.sea) return
      this.pool[i] = Math.max(0, this.pool[i] + amount * cover)
    })
  }

  /** Grows (or clears) the vegetation in a disc. */
  plant(cx: number, cy: number, r: number, amount: number) {
    this.brush(cx, cy, r, (i, cover) => {
      const e = this.extra
      if (this.water[i * 4] > 0.002 || this.ground[i * 4] < this.sea) return
      e[i * 4] = clamp(e[i * 4] + amount * cover, 0, 1)
      if (amount > 0) e[i * 4 + 1] = clamp(e[i * 4 + 1] + amount * cover, 0, 1)
    })
  }

  /** Wets (or dries) the air in a disc, as a share of its capacity. */
  humidify(cx: number, cy: number, r: number, amount: number) {
    this.brush(cx, cy, r, (i, cover) => {
      const cap = capacity(this.climate[i * 4 + 3])
      this.q[i] = clamp(this.q[i] + amount * cap * cover, 0, 3 * cap)
    })
  }

  /** Warms (or cools) a region for good, °C at the centre. */
  heat(cx: number, cy: number, r: number, amount: number) {
    this.brush(cx, cy, r, (i, cover) => {
      this.climate[i * 4] = clamp(this.climate[i * 4] + amount * cover, -25, 25)
    })
  }

  /** Builds a high (or a low) in a disc; the wind carries it and it fills in slowly. */
  pushPressure(cx: number, cy: number, r: number, amount: number) {
    const m = this.pm
    const P = this.press
    for (let y = 0; y < m; y++) {
      for (let x = 0; x < m; x++) {
        const d = Math.hypot(wrapDelta((x + 0.5) * PB, cx, this.n), (y + 0.5) * PB - cy) / Math.max(r, PB)
        if (d >= 1) continue
        const b = y * m + x
        P[b] = clamp(P[b] + amount * (1 - smooth(d, 0.3, 1)), -1.5, 1.5)
      }
    }
  }

  /** The pressure in effect at a tile (droughts and storms included): lows < 0 < highs. */
  pressureAt(tx: number, ty: number): number {
    const belt = this.opts.planetWinds ? this.beltPressure(latitudeOf(ty - 0.5, this.n)) : 0
    return this.sampleCells(this.pEff, tx, ty) + belt
  }

  /**
   * A nuclear blast: a crater, the town and the land around it burning, fallout downwind
   * (the radioactive dust drifts with the wind), and soot in the air that shades the
   * planet for years (a nuclear winter: added to the dust that cools it).
   */
  nuke(cx: number, cy: number) {
    const g = this.ground
    this.brush(cx, cy, 2.5, (i, cover) => {
      g[i * 4] = Math.max(g[i * 4] - 0.012 * cover, -0.12)
      g[i * 4 + 1] = g[i * 4] - g[i * 4 + 2]
      this.extra[i * 4] = 0
      this.urban[i] *= 0.2
    })
    this.brush(cx, cy, 7, (i, cover) => {
      if (this.extra[i * 4] > 0.1 && this.water[i * 4] < 0.002 && Math.random() < 0.6 * cover + 0.2) this.fire[i] = 1
    })
    // the fallout: a plume downwind of the blast
    const i0 = this.tileAt(cx, cy)
    const wx = this.tileU[i0]
    const wy = this.tileV[i0]
    const ws = Math.hypot(wx, wy) || 1
    for (let k = 0; k <= 4; k++) {
      const along = k * 4
      this.brush(cx + (wx / ws) * along, cy + (wy / ws) * along, 6 - k * 0.6, (i, cover) => {
        this.fallout[i] = Math.min(1, this.fallout[i] + cover * (1 - k * 0.15))
      })
    }
    this.falloutLeft = Math.max(this.falloutLeft, 1)
    this.dust = Math.min(this.dust + NUCLEAR_SOOT, 12)
  }

  /**
   * A cataclysm (the gods' blows piling up: great quakes one after another): the planet's
   * crust breaks up and melts, and the world is born again, in stages (see genesisStep):
   * - molten: the surface is a sea of lava, over 100 °C hotter; the oceans boil away and the
   *   sea floor lies bare; every living thing dies; under it a new relief takes shape;
   * - cooling: the heat ebbs, the steam rains back for centuries and the oceans fill again,
   *   in new basins; the lava sets into new continents; new plates are laid out on them;
   * - then the plants come back, and life, when it can.
   */
  cataclysm() {
    const n = this.n
    const g = this.ground
    const fresh = this.relief(1 + Math.floor(Math.random() * 100000))
    for (let i = 0; i < n * n; i++) {
      const h = g[i * 4] + (fresh[i] - g[i * 4]) * 0.85
      g[i * 4] = Math.max(h, -0.12)
      g[i * 4 + 1] = g[i * 4] - g[i * 4 + 2]
      this.extra[i * 4] = 0
      this.extra[i * 4 + 1] = 0
      this.extra[i * 4 + 2] = 0
      this.farmland[i] = 0
      this.urban[i] = 0
      this.cleared[i] = 0
      this.built[i] = 0
      this.smog[i] = 0
      this.fallout[i] = 0
      this.fire[i] = 0
    }
    this.storms = []
    this.hurricanes = []
    this.droughts = []
    this.refreshDroughts()
    this.catHeat = CATACLYSM_HEAT
    this.genesis = 'molten'
    this.genesisTicks = 0
    // the new relief: kept, so the melt (lava setting into rock) does not pile onto it
    this.moltenBase = new Float32Array(n * n)
    for (let i = 0; i < n * n; i++) this.moltenBase[i] = g[i * 4]
    this.dust = Math.min(this.dust + 2, 12)
    this.events.push({ text: 'CATACLISMO: a crosta do planeta se parte e derrete. A superfície vira um mar de lava, mais de 100 °C mais quente.', major: true })
    this.resetChange()
  }

  /** The stages of a cataclysm, a tick at a time (see cataclysm). */
  private genesisStep() {
    if (!this.genesis) return
    const n = this.n
    this.genesisTicks++
    if (this.genesis === 'molten') {
      // the surface stays molten: lava over everything above the (falling) sea
      if (this.genesisTicks % 10 === 0) {
        const salt = this.genesisTicks
        for (let i = 0; i < n * n; i++) {
          if (this.ground[i * 4] < this.sea) continue
          const glow = 0.0012 + 0.002 * fbm((i % n) / n * 6 + salt * 0.002, Math.floor(i / n) / n * 6, this.opts.seed + 71, 3)
          this.lava[i * 4] = Math.max(this.lava[i * 4], glow)
        }
      }
      if (this.genesisTicks === 160) this.events.push({ text: 'Os oceanos fervem e evaporam: o fundo do mar fica exposto, o céu é puro vapor.', major: true })
      if (this.genesisTicks >= MOLTEN_TICKS) {
        this.genesis = 'cooling'
        // the lava sets: the crust is the new relief (the melt added nothing), a few pools still glowing
        if (this.moltenBase) {
          for (let i = 0; i < n * n; i++) {
            this.ground[i * 4] = this.moltenBase[i]
            this.ground[i * 4 + 1] = this.moltenBase[i] - this.ground[i * 4 + 2]
            this.lava[i * 4] = this.lava[i * 4] > 0.0028 ? 0.001 : 0
          }
          this.moltenBase = null
        }
        // the new plates, laid out on the land that will stand when the seas come back
        this.tectonics.build(this.ground, 0)
        this.tectonics.recompute(this.ground, this.sea)
        this.layersCache = null
        this.events.push({ text: 'O planeta começa a esfriar: a lava endurece em crosta nova.', major: true })
      }
    } else {
      this.catHeat *= COOLING
      if (!this.rainTold && this.catHeat < OCEANS_RETURN) {
        this.rainTold = true
        this.events.push({ text: 'Chove sem parar por séculos: os oceanos voltam a se encher, em bacias novas.', major: true })
      }
      if (this.catHeat < 2) {
        this.catHeat = 0
        this.genesis = null
        this.rainTold = false
        this.events.push({ text: 'A crosta endurece: novos continentes, novos oceanos. As plantas voltam, e a vida pode recomeçar.', major: true })
      }
    }
  }

  /** Sets a region on fire. */
  ignite(cx: number, cy: number, r: number) {
    this.brush(cx, cy, r, (i) => {
      if (this.extra[i * 4] > 0.15 && this.water[i * 4] < 0.002) this.fire[i] = 1
    })
  }

  /** Opens a volcano: a vent that erupts for a while and builds a cone. */
  erupt(cx: number, cy: number, strength: number) {
    const x = wrap(Math.round(cx), this.n)
    const y = clamp(Math.round(cy), 0, this.n - 1)
    this.vents.push({ x, y, strength, left: Math.round(600 + 1200 * strength) })
    this.raise(cx, cy, 4, 0.02 * strength)
    // the ash column: a cloud the wind carries off (no planes fly through it)
    this.ash = [...this.ash, { x: cx, y: cy, r: 8 + 10 * strength, left: Math.round(900 + 900 * strength) }].slice(-6)
    this.dust = Math.min(this.dust + 0.3 * strength, 12)
    // a volcano at the shore may slide into the sea or blow the island apart: a tsunami
    if (this.seaNear(cx, cy, 4) && Math.random() < 0.5) this.tsunami(cx, cy, 15 + 15 * strength)
  }

  /** The ash clouds drift with the wind and thin out. */
  private driftAsh() {
    if (!this.ash.length) return
    for (const a of this.ash) {
      a.x = wrap(a.x + this.sampleCells(this.windU, a.x, a.y) * 0.6, this.n)
      a.y += this.sampleCells(this.windV, a.x, a.y) * 0.6
      a.r += 0.004
      a.left--
    }
    this.ash = this.ash.filter((a) => a.left > 0)
  }

  /** Whether a point (tiles) lies over volcanic ash. */
  inAsh(x: number, y: number): boolean {
    return this.ash.some((a) => Math.hypot(wrapDelta(x, a.x, this.n), y - a.y) < a.r)
  }

  /** Whether the sea is within `r` tiles of a point. */
  seaNear(cx: number, cy: number, r: number): boolean {
    const n = this.n
    for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(n - 1, Math.ceil(cy + r)); y++) {
      for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
        if (this.ground[(y * n + wrap(x, n)) * 4] < this.sea - 0.004) return true
      }
    }
    return false
  }

  /** Whether a town here stands on the coast a great wave reaches: below ~460 m, the sea within 6 tiles. */
  coastTown(x: number, y: number): boolean {
    const n = this.n
    const h = this.ground[(clamp(Math.floor(y), 0, n - 1) * n + wrap(Math.floor(x), n)) * 4]
    return h < this.sea + 0.03 && this.seaNear(x, y, 6)
  }

  /** Whether a tile is low coast a wave can reach: land just above the sea, the sea within 3 tiles. */
  lowCoast(x: number, y: number): boolean {
    const n = this.n
    const xx = wrap(Math.floor(x), n)
    const yy = clamp(Math.floor(y), 0, n - 1)
    const h = this.ground[(yy * n + xx) * 4]
    return h >= this.sea && h < this.sea + 0.015 && this.seaNear(xx, yy, 3)
  }

  /**
   * The sea floods the low coast within `reach` (tiles) of a point, weaker further away and
   * by `power` (1 a tsunami): the water runs in, the plants and the fields are torn up.
   * Returns how many tiles were flooded.
   */
  private floodCoast(cx: number, cy: number, reach: number, power: number): number {
    const n = this.n
    const g = this.ground
    let hit = 0
    for (let y = Math.max(0, Math.floor(cy - reach)); y <= Math.min(n - 1, Math.ceil(cy + reach)); y++) {
      for (let x = Math.floor(cx - reach); x <= Math.ceil(cx + reach); x++) {
        const d = Math.hypot(x - cx, y - cy) / reach
        if (d >= 1) continue
        const i = y * n + wrap(x, n)
        const h = g[i * 4]
        if (h < this.sea) continue
        const k = (1 - d) * power
        // how high the wave runs up: the coast must be lower than that, and near the sea
        if (h > this.sea + 0.015 * k + 0.002 || !this.seaNear(x, y, 1 + 3 * k)) continue
        this.pool[i] += 0.004 * k
        this.extra[i * 4] *= 1 - 0.6 * k
        this.farmland[i] *= 1 - 0.7 * k
        this.urban[i] *= 1 - 0.5 * k
        hit++
      }
    }
    return hit
  }

  /**
   * A tsunami: the wave runs out from the source across the sea and floods the low coasts
   * within its reach (tiles), weaker further away: the water floods in, the plants and the
   * fields are torn up, the towns on the shore are struck (see the game, via the event).
   */
  tsunami(cx: number, cy: number, reach: number) {
    const hit = this.floodCoast(cx, cy, reach, 1)
    this.events.push({
      text: hit > 30 ? `Um tsunami varre as costas: ${hit} terras alagadas.` : 'Um tsunami atravessa o mar, mas quase não acha costa baixa.',
      x: cx,
      y: cy,
      major: hit > 30,
      fx: 'tsunami',
      size: reach,
    })
  }

  /** A strike: a crater, lava around it, fire, dust that cools the planet. */
  strike(cx: number, cy: number, r: number) {
    // into the sea: a great wave
    const i0 = this.tileAt(cx, cy)
    if (this.ground[i0 * 4] < this.sea) this.tsunami(cx, cy, Math.min(90, r * 7))
    const depth = 0.05 * Math.min(r / 8, 2)
    this.brush(cx, cy, r, (i, cover) => {
      const g = this.ground
      g[i * 4] = Math.max(g[i * 4] - depth * cover, -0.12)
      g[i * 4 + 1] = g[i * 4] - g[i * 4 + 2]
      this.extra[i * 4] = 0
      this.extra[i * 4 + 2] = 0
      this.pool[i] = g[i * 4] < this.sea ? this.sea - g[i * 4] : 0
      if (cover < 0.45 && cover > 0.1) this.lava[i * 4] += 0.002
    })
    this.brush(cx, cy, r * 1.6, (i, cover) => {
      if (cover < 0.6 && this.extra[i * 4] > 0.2 && Math.random() < 0.3) this.fire[i] = 1
    })
    this.dust = Math.min(this.dust + Math.min(0.3 * r, 6), 8)
    this.storms.push({ x: cx, y: cy, r: r * 3, age: 0 })
  }

  /** A storm: a moving low with rain under it. */
  storm(cx: number, cy: number, r: number) {
    this.storms = [...this.storms, { x: cx, y: cy, r, age: 0 }].slice(-4)
  }

  /** A decreed drought: a fixed high; or lifts the one at the place (returns whether one was lifted). */
  drought(cx: number, cy: number, r: number, lift: boolean): boolean {
    if (lift) {
      const k = this.droughts.findIndex((d) => Math.hypot(wrapDelta(d.x, cx, this.n), d.y - cy) < d.r)
      if (k < 0) return false
      this.droughts.splice(k, 1)
    } else {
      this.droughts = [...this.droughts, { x: cx, y: cy, r }].slice(-6)
    }
    this.refreshDroughts()
    return true
  }

  /**
   * Calls `fn` for every tile of a disc with how much it covers the tile (1 at the centre,
   * 0 at the edge) and the tile's place from the centre (tiles). East–west the disc goes
   * round the world.
   */
  private brush(cx: number, cy: number, r: number, fn: (i: number, cover: number, dx: number, dy: number) => void) {
    const n = this.n
    const x0 = Math.floor(cx - r)
    const x1 = Math.ceil(cx + r)
    const y0 = Math.max(0, Math.floor(cy - r))
    const y1 = Math.min(n - 1, Math.ceil(cy + r))
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = x + 0.5 - cx
        const dy = y + 0.5 - cy
        const d = Math.hypot(dx, dy) / Math.max(r, 0.5)
        if (d >= 1) continue
        fn(y * n + wrap(x, n), 1 - smooth(d, 0.4, 1), dx, dy)
      }
    }
  }

  /** The tile under a point (tiles): its column wrapped round the world, its row kept on the map. */
  private tileAt(x: number, y: number): number {
    return clamp(Math.round(y), 0, this.n - 1) * this.n + wrap(Math.round(x), this.n)
  }

  /** A hash per tile, for the sprites' variety. */
  jitter(i: number, salt = 0): number {
    return hash2(i % this.n, Math.floor(i / this.n), this.opts.seed + salt)
  }
}
