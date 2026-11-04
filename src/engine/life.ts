// Life: herds that roam after grass and water and flee lava, floods, ice and heat, and
// small civilizations: peoples whose towns grow where the land feeds them, keep granaries,
// trade, found new towns, learn (technology, in eras, and adaptation to cold, heat,
// drought and floods), migrate when the land fails them, meet their neighbours, ally with
// them or fight them, conquer, unite, split and vanish. Life only happens where there is
// moisture and the right warmth; a cold land demands more of a people: more adaptation,
// more technology. Everything lives on the CPU and reads the world from the state read
// back for the climate analysis every few seconds (the Field), which is plenty for things
// this slow. A simulated year is ten simulated seconds.

import type { Field } from './engine'

export type LifeKind = 'herd' | 'village' | 'battle' | 'ruin' | 'boat' | 'party' | 'dam'

/** What a party on the road is: traders, soldiers, people fleeing, people going to found a town. */
export type PartyKind = 'caravan' | 'army' | 'migrants' | 'settlers'
const PARTY_KINDS: PartyKind[] = ['caravan', 'army', 'migrants', 'settlers']

/** A party walking from one place to another (world units), drawn as a file of figures. */
export interface Party {
  kind: PartyKind
  from: [number, number]
  to: [number, number]
  /** 0–1 along the way. */
  t: number
  /** World units per simulated second. */
  speed: number
  color: number
  /** 0–1: how many walk (the figures drawn). */
  size: number
}

export interface Creature {
  kind: LifeKind
  /** Position in world units (so the window may slide under it). */
  pos: [number, number]
  /** Where a herd is heading (unit vector), and 0 while it stays. */
  dir: [number, number]
  /** 0–1: a herd's condition. */
  health: number
  /** Simulated seconds since death; it comes back somewhere good after a while. */
  dead: number
  /** Simulated seconds until a herd picks a direction again. */
  think: number
  /** Index into SPECIES. */
  species: number
}

/** An animal species: the climate and the land it lives on (see SPECIES). */
export interface Species {
  name: string
  /** Temperatures it bears (°C); beyond them it weakens. */
  tMin: number
  tMax: number
  /** Least vegetation it grazes on. */
  veg: number
  /** Body size, 0–1 (how big it is drawn). */
  size: number
}

/** The fauna, by biome: forest deer, grassland bison, desert camels, tundra mammoths, savanna elephants. */
export const SPECIES: Species[] = [
  { name: 'cervos', tMin: -2, tMax: 26, veg: 0.3, size: 0.45 },
  { name: 'bisões', tMin: -8, tMax: 30, veg: 0.25, size: 0.7 },
  { name: 'camelos', tMin: 8, tMax: 48, veg: 0.04, size: 0.6 },
  { name: 'mamutes', tMin: -30, tMax: 6, veg: 0.08, size: 1 },
  { name: 'elefantes', tMin: 16, tMax: 42, veg: 0.3, size: 1 },
]

/** The beliefs a people may hold; which one it starts with comes from the land around its first town. */
export const FAITHS = [
  'culto do Sol',
  'culto do Rio',
  'culto da Montanha',
  'culto do Mar',
  'culto do Fogo',
  'culto do Gelo',
  'culto dos Ancestrais',
  'culto da Chuva',
] as const

/** Monuments, by the era that raises them (index into MONUMENTS; 0 is none). */
export const MONUMENTS = ['', 'pirâmide', 'templo', 'torre'] as const

/** A town that died: its footprint stays on the land for centuries. */
export interface Ruin {
  pos: [number, number]
  /** Simulated seconds since it fell. */
  age: number
  color: number
  /** The monument it had, if any (index into MONUMENTS). */
  monument: number
  civ: string
}

/** A road or trade route between two towns, in world units; kind 0 dirt road, 1 paved road, 2 trade route (between peoples), 3 sea route. */
export interface Route {
  a: [number, number]
  b: [number, number]
  kind: number
  /** Town ids, so a route may be told apart. */
  from: number
  to: number
  /** Civ colour of the boats on a sea route. */
  color: number
}

/** A route as drawn: window uv ends and kind. */
export interface RoadSegment {
  a: [number, number]
  b: [number, number]
  kind: number
}

/** The renderer draws this many route segments at most. */
export const MAX_ROADS = 192

/** Adaptation to each kind of harsh climate, 0–1, learned by living with it. */
export interface Adaptation {
  cold: number
  heat: number
  dry: number
  flood: number
}

export interface Civ {
  id: number
  name: string
  /** Index into CIV_COLORS. */
  color: number
  /** 0–1: knowledge; feeds the towns, reaches further, wins wars, unlocks the eras. */
  tech: number
  adapt: Adaptation
  /** Simulated seconds of existence. */
  age: number
  /** Civ ids → simulated seconds of peace left before a new war may start. */
  truces: Map<number, number>
  /** Civ ids this one is allied with → simulated seconds of alliance so far. */
  allies: Map<number, number>
  /** Civ ids → towns lost to them (a grudge; it fades). */
  grudges: Map<number, number>
  conquests: number
  /** Towns founded over its history. */
  founded: number
  dams: number
  industrial: boolean
  /** The era announced last (index into ERAS). */
  era: number
  /** Simulated seconds until another exodus of this people is worth telling. */
  exodusLog: number
  /** Town id of the capital. */
  capital: number
  /** What it believes (index into FAITHS). */
  faith: number
  /** Monuments raised over its history. */
  monuments: number
  /** Simulated seconds until another plague in this people is worth telling. */
  plagueLog: number
}

export interface War {
  a: number
  b: number
  /** Simulated seconds left. */
  left: number
  /** Simulated seconds fought so far. */
  age: number
  battles: number
  /** Towns taken by a and by b. */
  taken: [number, number]
  /** Why it started, in words. */
  cause: string
}

/** What a town needs and has, as last computed (see updateTowns). */
export interface TownNeeds {
  /** 0–1: what the land yields (grass, water), before moisture. */
  food: number
  /** 0–1: moisture (a river or lake nearby, or humid air). */
  moist: number
  waterNear: boolean
  /** The climate's demand here, what the people can bear, and the excess (0 is fine). */
  demand: number
  tolerance: number
  hardship: number
  /** 0–1: the population the land can carry for this people. */
  capacity: number
  /** Population change per simulated second. */
  rate: number
  temperature: number
  flooded: boolean
  burning: boolean
  frozen: boolean
  /** 0–1: a year of food in store. */
  granary: number
  famine: boolean
  /** A plague is running through it. */
  plague: boolean
  /** Its hunters live off a herd nearby. */
  hunting: boolean
}

/** A town as the panel and the inspect card show it. */
export interface TownReport {
  id: number
  name: string
  /** World units. */
  pos: [number, number]
  civ: string
  color: number
  people: number
  pop: number
  tech: number
  adapt: number
  /** Simulated seconds since it was founded. */
  age: number
  capital: boolean
  needs: TownNeeds
  /** Works around it: fields, terraces, industry, a dam. */
  works: { farms: boolean; terraces: boolean; industry: boolean; dam: boolean; irrigation: boolean }
  /** What is going on with it, in words. */
  status: string
  /** Its population over the last years, in words ("crescendo há 12 anos"). */
  trend: string
  /** The monument standing in it, if any (name from MONUMENTS). */
  monument: string
  faith: string
}

/** Something a people does to the land around a town (see worksShader): kind bits 1 farms, 2 terracing, 4 industry, 16 irrigation, 32 a big town; 8 a dam. */
export interface Work {
  /** Centre in window uv. */
  uv: [number, number]
  /** Radius in window uv. */
  radius: number
  kind: number
  /** 0–1: the people's technology (how hard it works the land); a dam: the wall's direction x. */
  strength: number
  /** 0–1: the town's population; a dam: the wall's direction y. */
  size: number
  /** A dam: the height its wall is raised to (height units, absolute). */
  crest?: number
}

/** The renderer and the simulation take this many works at most. */
export const MAX_WORKS = 128
/** Technology a people needs for each kind of work and each unlock. */
export const TECH_FARMS = 0.25
export const TECH_IRRIGATION = 0.35
export const TECH_SAILING = 0.4
export const TECH_DAMS = 0.5
export const TECH_HEATING = 0.55
export const TECH_TERRACES = 0.7
export const TECH_INDUSTRY = 0.8
export const TECH_COOLING = 0.85
export const TECH_GREENHOUSE = 0.95
/** How high a dam's wall rises over the river bed (height units). */
export const DAM_HEIGHT = 0.01
/** Half the length of a dam's wall (world units). */
export const DAM_HALF = 0.014

/** The eras, by the technology that opens them. */
export const ERAS: { name: string; tech: number }[] = [
  { name: 'Idade da Pedra', tech: 0 },
  { name: 'Idade do Bronze', tech: 0.15 },
  { name: 'Idade do Ferro', tech: 0.3 },
  { name: 'Era Medieval', tech: 0.45 },
  { name: 'Renascença', tech: 0.6 },
  { name: 'Era Industrial', tech: 0.8 },
  { name: 'Era Moderna', tech: 0.92 },
]

export function eraOf(tech: number): number {
  let era = 0
  for (let k = 0; k < ERAS.length; k++) if (tech >= ERAS[k].tech) era = k
  return era
}

/** A town's full state. */
export interface Town {
  id: number
  name: string
  pos: [number, number]
  /** Simulated seconds since it was founded. */
  age: number
  needs: TownNeeds
  /** Where this town dammed a river (world units), if it has, and the wall's direction (across the flow). */
  dam: [number, number] | null
  damDir: [number, number]
  /** The height the dam's wall is raised to (height units): the river bed there plus DAM_HEIGHT. */
  damCrest: number
  /** 0–1: population. */
  pop: number
  /** Owner civ id. */
  civ: number
  /** 0–1: a year of food in store. */
  granary: number
  /** Simulated seconds until it may send settlers again. */
  settle: number
  /** Simulated seconds until it may fight again. */
  rest: number
  /** Simulated seconds until its people may leave again (so an exodus is logged once). */
  exodus: number
  /** Simulated seconds until another party of its people may set out (for the roads). */
  leaving: number
  /** How hard the climate here is on it right now (0 is fine), for the markers and the panel. */
  strain: number
  /** Population at the end of each of the last years, newest last. */
  history: number[]
  /** Simulated seconds until the next yearly sample. */
  sample: number
  /** Simulated seconds of plague left (0: healthy). */
  plague: number
  /** Simulated seconds until it may catch a plague again. */
  immune: number
  /** The monument it raised (index into MONUMENTS; 0 none). */
  monument: number
  /** The herd its hunters follow this moment, if any. */
  hunting: boolean
}

interface Battle {
  pos: [number, number]
  /** Simulated seconds since it was fought. */
  age: number
}

/**
 * A marker to draw: window uv, kind, size (0–1), health (0–1), civ colour and tech.
 * A battle's size is how fresh it is (1 just fought, 0 faded).
 */
export interface LifeMarker {
  uv: [number, number]
  kind: LifeKind
  size: number
  health: number
  color: number
  tech: number
  /** A herd: its species; a town or ruin: its monument (index into MONUMENTS); a party: its kind (index into PARTY_KINDS); a boat or dam: 0. */
  flag: number
}

/** A name to draw over the map: window uv, text, colour, importance (1 a capital, 0 a town). */
export interface LifeLabel {
  uv: [number, number]
  text: string
  color: number
  major: boolean
  /** Height of the ground there (height units), for placing the label. */
  height: number
  /** A people's name, a town's name, or a note (the chosen town). */
  kind: 'people' | 'town' | 'note'
  /** 0–1: how big the thing named is (a people: its share of the towns; a town: its population). */
  size: number
}

export interface CivReport {
  id: number
  name: string
  color: number
  towns: number
  people: number
  tech: number
  adapt: number
  adapts: Adaptation
  atWar: boolean
  era: string
  /** People × (0.5 + tech): how much it weighs in the world. */
  power: number
  allies: string[]
  capital: string
  /** Share of its towns in famine, 0–1. */
  famine: number
  /** Civs it trades with (at peace and in contact). */
  trade: number
  faith: string
  monuments: number
  /** Share of its towns with the plague, 0–1. */
  plague: number
}

/** A species as the panel lists it. */
export interface FaunaReport {
  name: string
  herds: number
  extinct: boolean
}

export interface WarReport {
  a: string
  aColor: number
  b: string
  bColor: number
  /** Simulated seconds fought so far. */
  age: number
  battles: number
  taken: [number, number]
  cause: string
}

export interface LifeEvent {
  /** Simulated seconds (life time) when it happened. */
  time: number
  /** The year (ten simulated seconds each). */
  year: number
  text: string
  /** Colour of the civ it is about, for the panel. */
  color: number
  /** A big one: a century's summary, a named catastrophe, an era, a victory. */
  major: boolean
  /** Where it happened (world units), when it happened somewhere. */
  pos?: [number, number]
}

/** People per civ at the end of a year, for the timeline. */
export interface HistoryPoint {
  year: number
  /** Civ id → people. */
  people: [number, number][]
  total: number
}

export interface LifeStats {
  /** The town the player picked with the inspect tool, if any (the engine fills it in). */
  selected?: TownReport | null
  herds: number
  villages: number
  people: number
  year: number
  /** Towns with industry (they warm the planet, see the engine). */
  industries: number
  dams: number
  civs: CivReport[]
  wars: WarReport[]
  events: LifeEvent[]
  history: HistoryPoint[]
  /** Names and colours of every civ that ever lived, for the timeline's legend. */
  lineage: { id: number; name: string; color: number }[]
  /** The game's end, if it came: a people in the Modern era, or a dead planet. */
  ending: string | null
  fauna: FaunaReport[]
  ruins: number
  monuments: number
  /** Roads and trade routes right now. */
  routes: number
  /** Towns with the plague right now. */
  plagued: number
}

/** Civ colours (0–1 rgb), shared by the shaders and the panel. */
export const CIV_COLORS: [number, number, number][] = [
  [0.85, 0.25, 0.2], // red
  [0.2, 0.45, 0.9], // blue
  [0.95, 0.75, 0.15], // yellow
  [0.25, 0.7, 0.35], // green
  [0.65, 0.3, 0.8], // purple
  [0.95, 0.5, 0.15], // orange
  [0.2, 0.75, 0.75], // teal
  [0.9, 0.45, 0.7], // pink
]

/** Cells per side of the political map drawn over the window. */
export const TERRITORY_N = 160
/** Simulated seconds in a year. */
export const YEAR = 10

const HERDS = 14
const MAX_CIVS = 6
/** Ruins stand this many simulated seconds (three centuries) before the land takes them back. */
const RUIN_LIFE = 3000
const MAX_RUINS = 48
/** Chance per simulated second that a plague breaks out in a crowded, hot, humid town at full pressure. */
const PLAGUE_CHANCE = 0.0015
/** Chance per simulated second that a plague crosses to a town in contact. */
const PLAGUE_SPREAD = 0.03
/** How long a plague runs through a town, and how long it is spared afterwards. */
const PLAGUE_LENGTH = 25
const PLAGUE_IMMUNITY = 150
/** Chance per simulated second that a rich town at peace raises a monument. */
const MONUMENT_CHANCE = 0.004
/** Chance per simulated second that a people adopts a stronger neighbour's faith, at full pressure. */
const CONVERSION_CHANCE = 0.0025
/** How far a hunter town's hunters go for a herd (world units), and how fast they wear it down. */
const HUNT_RANGE = 0.05
const HUNT_RATE = 0.012
/** Simulated seconds between two reckonings of the roads. */
const ROUTES_EVERY = 1
/** World units a boat sails per simulated second. */
const BOAT_SPEED = 0.02
/** How fast a party walks, in world units per simulated second (an army marches faster). */
const WALK_SPEED = 0.009
const MARCH_SPEED = 0.016
/** Parties on the roads at most. */
const MAX_PARTIES = 90
/** Simulated seconds between caravans on a trade route, and on a road within a people. */
const CARAVAN_EVERY = 18
const CART_EVERY = 45
/** Simulated seconds between parties of migrants leaving a failing town. */
const MIGRANTS_EVERY = 25
/** Herds a species must fail to come back for this long before it is counted extinct (simulated seconds). */
const EXTINCTION_WAIT = 600
/** Simulated seconds between two chances for a kind with no herd to find a home; herds at most. */
const ARRIVAL_EVERY = 60
const MAX_HERDS = 20
/** Markers are capped at 128 by the renderer; towns share them with the herds and battles. */
const MAX_TOWNS = 100
const MAX_BATTLES = 12
/** Simulated seconds a battle mark stays on the ground. */
const BATTLE_FADE = 25
/** World units per simulated second a herd walks. */
const HERD_SPEED = 0.012
/** How far ahead a herd looks when it picks a direction (world units). */
const LOOK = 0.03
const RESPAWN_HERD = 30
/** Simulated seconds between a civ vanishing (or the start) and a new people appearing. */
const NEW_CIV = 45
/** Towns closer than this (world units) cannot both exist. */
const TOWN_SPACING = 0.035
/** Towns of different civs closer than this are in contact: they trade knowledge and fight. */
const CONTACT = 0.09
/** How far settlers walk, at no tech and at full tech (world units). */
const REACH_MIN = 0.05
const REACH_MAX = 0.14
/** Population growth per simulated second, at full food. */
const GROWTH = 0.02
/** Technology per simulated second per unit of (saturating) population, ×(1 + 2·demand). */
const TECH_RATE = 0.00025
/** Adaptation per simulated second per unit of population living with a hard climate. */
const ADAPT_RATE = 0.0008
/** Towns a civ can hold together: a few, and more with technology. */
const TOWNS_BASE = 5
const TOWNS_PER_TECH = 15
/** Per second, how fast knowledge flows from a civ to a less advanced neighbour in contact. */
const DIFFUSION = 0.004
/** Chance per simulated second that two civs in contact go to war, at full pressure. */
const WAR_CHANCE = 0.006
const WAR_LENGTH = 90
const TRUCE_LENGTH = 120
/** Chance per simulated second that two frontier towns at war fight a battle. */
const BATTLE_CHANCE = 0.08
const MAX_EVENTS = 40
/** A town's land: this far around it at no population, more as it grows and learns (world units). */
const LAND_MIN = 0.03
const LAND_MAX = 0.085
/** Simulated seconds between two drawings of the political map. */
const TERRITORY_EVERY = 0.5
/** How many years of the timeline are kept. */
const HISTORY_YEARS = 400
/** Years of a town's population kept, for its trend. */
const TREND_YEARS = 20

interface Cell {
  vegetation: number
  water: number
  /** The water's flow (the simulation's water.yz). */
  flow: [number, number]
  lava: number
  ice: number
  temperature: number
  humidity: number
  height: number
}

const SYLLABLES = ['ka', 'tor', 'vel', 'mir', 'an', 'dor', 'sel', 'ul', 'ra', 'ne', 'ith', 'os', 'bra', 'lu', 'quen', 'zar']
const ENDINGS = ['ia', 'ar', 'um', 'os', 'and', 'ea', 'ia', 'or']

function pick<T>(list: T[]): T {
  return list[Math.floor(Math.random() * list.length)]
}

export function placeName(): string {
  return civName()
}

function civName(): string {
  const a = pick(SYLLABLES)
  const b = Math.random() < 0.6 ? pick(SYLLABLES) : ''
  const name = a + b + pick(ENDINGS)
  return name[0].toUpperCase() + name.slice(1)
}

/** What the cold demands of a people in a cell: 0 at 8 °C and above, 1 at −22 °C. */
export function coldDemand(temperature: number): number {
  return Math.min(1.5, Math.max(0, 8 - temperature) / 30)
}
/** What the heat demands: 0 at 32 °C and below, 1 at 47 °C. */
export function heatDemand(temperature: number): number {
  return Math.min(1.5, Math.max(0, temperature - 32) / 15)
}
/** The climate's whole demand (cold plus heat). */
export function climateDemand(temperature: number): number {
  return Math.min(1.5, coldDemand(temperature) + heatDemand(temperature))
}

/** How much hardship a civ can bear in a cell before its towns start to wither. */
function tolerance(civ: Civ, temperature: number): number {
  const cold = temperature < 20
  let t = 0.15 + civ.tech * 0.25 + (cold ? civ.adapt.cold : civ.adapt.heat)
  if (cold && civ.tech >= TECH_HEATING) t += 0.25
  if (!cold && civ.tech >= TECH_COOLING) t += 0.3
  return t
}

/** Many people have more ideas, but not without limit: x/(1 + x/3) tops out at 3. */
function saturate(x: number): number {
  return x / (1 + x / 3)
}

function dist(a: [number, number], b: [number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1])
}

export class Life {
  private creatures: Creature[] = []
  private civs: Civ[] = []
  private towns: Town[] = []
  private wars: War[] = []
  private battles: Battle[] = []
  private ruins: Ruin[] = []
  private parties: Party[] = []
  /** Roads and routes as last reckoned, and when. */
  private routeList: Route[] = []
  private routesTime = -Infinity
  /** Species gone from the world, the ones that have lived in it, and how long each has had no living herd. */
  private extinct = new Set<number>()
  private seen = new Set<number>()
  private missing = new Map<number, number>()
  /** Simulated seconds until a kind of animal with no herd may find a home. */
  private arrival = ARRIVAL_EVERY
  /** Simulated seconds until another plague anywhere is worth a line in the chronicle. */
  private plagueLog = 0
  private events: LifeEvent[] = []
  private history: HistoryPoint[] = []
  private lineage: { id: number; name: string; color: number }[] = []
  private nextCiv = 1
  private nextTown = 1
  /** Simulated seconds until a new people may appear. */
  private genesis = 0
  private time = 0
  private started = false
  private field: Field | null = null
  /** Towns with industry and dams built, counted when the works are listed. */
  private industryCount = 0
  private damCount = 0
  /** Simulated seconds until the next yearly bookkeeping, and the last century summarised. */
  private yearTick = YEAR
  private lastCentury = 0
  /** People at the end of the last few years (newest last), to spot catastrophes. */
  private recentPeople: number[] = []
  private lastCatastrophe = -1000
  private ending: string | null = null
  /** Years in a row in which no new people could find a place to live. */
  private barrenYears = 0
  /** The political map last drawn, and when and for which window. */
  private territoryMap = new Uint32Array(new ArrayBuffer(TERRITORY_N * TERRITORY_N * 4))
  private territoryTime = -1
  private territoryKey = ''

  reset() {
    this.creatures = []
    this.civs = []
    this.towns = []
    this.wars = []
    this.battles = []
    this.ruins = []
    this.parties = []
    this.routeList = []
    this.routesTime = -Infinity
    this.extinct = new Set()
    this.seen = new Set()
    this.missing = new Map()
    this.arrival = ARRIVAL_EVERY
    this.plagueLog = 0
    this.events = []
    this.history = []
    this.lineage = []
    this.nextCiv = 1
    this.nextTown = 1
    this.genesis = 0
    this.time = 0
    this.started = false
    this.field = null
    this.industryCount = 0
    this.damCount = 0
    this.yearTick = YEAR
    this.lastCentury = 0
    this.recentPeople = []
    this.lastCatastrophe = -1000
    this.ending = null
    this.barrenYears = 0
    this.territoryTime = -1
    this.territoryKey = ''
  }

  get year(): number {
    return Math.floor(this.time / YEAR)
  }

  /** The life's clock, in simulated seconds (the events' times are on it). */
  get now(): number {
    return this.time
  }

  /** The chronicle, oldest first, with the full list (the stats carry it newest first). */
  get chronicleEvents(): LifeEvent[] {
    return this.events
  }

  /** The towns in the window, for the map export: uv, population, colour, name of the people, capital. */
  townsIn(origin: [number, number], n: number, extent: number): { uv: [number, number]; pop: number; color: number; civ: string; capital: boolean; monument: number }[] {
    const civById = new Map(this.civs.map((c) => [c.id, c]))
    const out: { uv: [number, number]; pop: number; color: number; civ: string; capital: boolean; monument: number }[] = []
    for (const t of this.towns) {
      const uv = this.inWindow(t.pos, origin, n, extent)
      const civ = civById.get(t.civ)
      if (!uv || !civ) continue
      out.push({ uv, pop: t.pop, color: civ.color, civ: civ.name, capital: civ.capital === t.id, monument: t.monument })
    }
    return out
  }

  /** Advances the life by dt simulated seconds, reading the world from the field. */
  update(dt: number, field: Field | null, extent: number) {
    if (!field || dt <= 0) return
    this.field = field
    // at a low frame rate a frame covers seconds: step through it, the rates are per second
    while (dt > 0.5) {
      this.step(0.5, field, extent)
      dt -= 0.5
    }
    this.step(dt, field, extent)
  }

  /** The simulated area last seen (world units), for reading the field outside update(). */
  private extentSeen = 1

  private step(dt: number, field: Field, extent: number) {
    this.time += dt
    this.extentSeen = extent
    const at = (pos: [number, number]) => this.cellAt(field, pos, extent)
    if (!this.started) {
      this.started = true
      this.spawnHerds(field, extent)
      for (let k = 0; k < 2; k++) this.spawnCiv(field, extent)
      this.genesis = NEW_CIV
    }
    for (const c of this.creatures) {
      if (c.dead > 0) {
        c.dead += dt
        if (c.dead > RESPAWN_HERD && !this.extinct.has(c.species)) {
          // the herd comes back where its own kind can live; if nowhere, the species is on its way out
          const spot = this.goodSpot(field, extent, 'herd', c.species)
          if (spot) {
            c.pos = spot
            c.dead = 0
            c.health = 0.6
            this.missing.delete(c.species)
          } else {
            c.dead = RESPAWN_HERD * 0.5
          }
        }
        continue
      }
      const here = at(c.pos)
      if (!here) continue // outside the window: it waits where it is
      this.updateHerd(c, dt, here, at)
    }
    this.extinctions(dt)
    this.arrivals(dt, field, extent)
    this.updateCivs(dt, field, extent, at)
    this.updateParties(dt)
    for (const b of this.battles) b.age += dt
    this.battles = this.battles.filter((b) => b.age < BATTLE_FADE)
    for (const r of this.ruins) r.age += dt
    this.ruins = this.ruins.filter((r) => r.age < RUIN_LIFE)
    this.yearTick -= dt
    if (this.yearTick <= 0) {
      this.yearTick += YEAR
      this.endOfYear(field, extent)
    }
  }

  private updateHerd(c: Creature, dt: number, here: Cell, at: (p: [number, number]) => Cell | null) {
    const sp = SPECIES[c.species]
    c.think -= dt
    if (c.think <= 0) {
      c.think = 1 + Math.random()
      // look around: the best of eight directions, or staying put
      let best = this.score(here, sp) + 0.15
      let dir: [number, number] = [0, 0]
      // too cold or too hot for its kind: it migrates towards the warmer south (lower v) or the
      // cooler north, which the seasons make a yearly migration
      const chill = Math.max(0, sp.tMin + 3 - here.temperature) / 6
      const swelter = Math.max(0, here.temperature - (sp.tMax - 3)) / 6
      const pull = Math.min(1, swelter) - Math.min(1, chill)
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2
        const d: [number, number] = [Math.cos(a), Math.sin(a)]
        const cell = at([c.pos[0] + d[0] * LOOK, c.pos[1] + d[1] * LOOK])
        if (!cell) continue
        const s = this.score(cell, sp) + Math.random() * 0.3 + d[1] * pull * 1.5
        if (s > best) {
          best = s
          dir = d
        }
      }
      c.dir = dir
    }
    const danger = here.lava > 0.0002 || here.water > 0.01
    const speed = HERD_SPEED * (danger ? 2 : 1) * (0.7 + 0.6 * (1 - sp.size))
    c.pos = [c.pos[0] + c.dir[0] * speed * dt, c.pos[1] + c.dir[1] * speed * dt]
    // grazing feeds it; bare ground, cold, heat, floods and lava wear it down
    const fed = here.vegetation > sp.veg && here.water < 0.001 && here.ice < 0.0005
    const harsh = here.temperature < sp.tMin - 3 || here.temperature > sp.tMax + 3
    c.health += dt * (danger ? -0.5 : harsh ? -0.08 : fed ? 0.05 : -0.03)
    c.health = Math.min(c.health, 1)
    if (c.health <= 0) {
      c.health = 0
      c.dead = 0.001
    }
  }

  /** A species with no living herd for long, and nowhere to come back to, is gone for good. */
  private extinctions(dt: number) {
    const alive = new Set<number>()
    for (const c of this.creatures) if (c.dead <= 0) alive.add(c.species)
    for (let k = 0; k < SPECIES.length; k++) {
      // (a kind that was never here cannot die out)
      if (this.extinct.has(k) || alive.has(k) || !this.seen.has(k)) {
        this.missing.delete(k)
        continue
      }
      const t = (this.missing.get(k) ?? 0) + dt
      this.missing.set(k, t)
      if (t > EXTINCTION_WAIT) {
        this.extinct.add(k)
        this.missing.delete(k)
        this.log(`Os ${SPECIES[k].name} desapareceram do mundo: o clima não os sustenta mais.`, 0, true)
      }
    }
  }

  // ---- civilizations ------------------------------------------------------------------

  private warBetween(a: number, b: number): War | undefined {
    return this.wars.find((w) => (w.a === a && w.b === b) || (w.a === b && w.b === a))
  }

  private civById(id: number): Civ | undefined {
    return this.civs.find((c) => c.id === id)
  }

  private updateCivs(dt: number, field: Field, extent: number, at: (p: [number, number]) => Cell | null) {
    const civById = new Map(this.civs.map((c) => [c.id, c]))
    const learned = new Map<number, { tech: number; cold: number; heat: number; dry: number; flood: number }>()
    for (const civ of this.civs) learned.set(civ.id, { tech: 0, cold: 0, heat: 0, dry: 0, flood: 0 })

    // trade partners: civs at peace and in contact feed each other a little
    const trade = this.tradePartners()
    // the hunters: a town without farming lives partly off the herds around it
    const herds = this.creatures.filter((c) => c.dead <= 0)

    // towns: food, climate, disasters, granaries
    for (const town of this.towns) {
      const civ = civById.get(town.civ)
      const here = at(town.pos)
      if (!civ || !here) continue // outside the window: it waits
      const irrigated = civ.tech >= TECH_IRRIGATION
      const waterNear = this.waterNear(town.pos, at, irrigated ? 0.03 : 0.02)
      // life needs moisture: a river or lake nearby, or humid air (less with irrigation)
      const dryAir = Math.max(0, Math.min(1, (here.humidity - (irrigated ? 0.15 : 0.25)) / 0.35))
      const moist = waterNear ? 1 : dryAir * (1 - 0.6 * (1 - civ.adapt.dry)) + 0.6 * civ.adapt.dry * dryAir
      const demand = climateDemand(here.temperature)
      const tol = tolerance(civ, here.temperature)
      const hardship = Math.max(0, demand - tol)
      // what the land yields: grass and water; technology makes more of it, adaptation
      // (herding, fishing, shelter) adds a living even where little grows; greenhouses
      // feed a town whatever grows outside; trade partners add a share
      const adaptMean = (civ.adapt.cold + civ.adapt.heat + civ.adapt.dry + civ.adapt.flood) / 4
      const frozen = here.ice > 0.0005
      let food = Math.min(1, here.vegetation * 1.6 + (waterNear ? 0.25 : 0)) * moist
      // hunters: before farming, a herd within reach feeds the town and is worn down by it
      town.hunting = false
      if (civ.tech < TECH_FARMS) {
        const prey = herds.find((h) => dist(h.pos, town.pos) < HUNT_RANGE)
        if (prey) {
          town.hunting = true
          food = Math.min(1, food + 0.2 * SPECIES[prey.species].size + 0.1)
          prey.health -= dt * HUNT_RATE * (0.5 + town.pop)
        }
      }
      // greenhouses feed a town some of what it needs whatever grows outside
      if (civ.tech >= TECH_GREENHOUSE && !frozen) food = Math.max(food, 0.3)
      const partners = trade.get(civ.id) ?? 0
      const capacity = Math.min(1, food * (0.55 + 0.7 * civ.tech) * (1 + 0.05 * Math.min(partners, 3)) + 0.3 * adaptMean)
      const flooded = here.water > 0.0008 * (1 + 2 * civ.adapt.flood)
      const burning = here.lava > 0.0002
      // the granary: a surplus fills it over a few years, a shortfall empties it faster
      const surplus = capacity - town.pop
      if (surplus > 0) town.granary = Math.min(1, town.granary + dt * surplus * 0.05 * (0.5 + civ.tech))
      else if (surplus < -0.02) town.granary = Math.max(0, town.granary + dt * surplus * 0.05)
      // famine: the store is empty and the land feeds clearly fewer than live here
      const famine = town.granary <= 0 && surplus < -0.12
      // the plague: crowded, hot, humid towns breed it, floods spread it, medicine
      // (the Renaissance, then the Modern era) keeps it down; it runs its course and
      // leaves the town spared for a while
      town.plague = Math.max(0, town.plague - dt)
      town.immune = Math.max(0, town.immune - dt)
      if (town.plague <= 0 && town.immune <= 0) {
        const medicine = civ.tech >= TECH_GREENHOUSE ? 0.05 : civ.tech >= 0.6 ? 0.4 : 1
        const heat = Math.max(0, Math.min(1, (here.temperature - 16) / 14))
        const humid = 0.4 + here.humidity
        const crowd = 1 + 2 * this.towns.filter((o) => o !== town && dist(o.pos, town.pos) < 0.06).length
        const chance = PLAGUE_CHANCE * dt * town.pop * crowd * heat * humid * (flooded ? 3 : 1) * medicine
        if (Math.random() < chance) this.outbreak(town, civ)
      }
      const plague = town.plague > 0
      town.strain = Math.min(1, hardship * 2 + (plague ? 0.5 : 0))
      let rate: number
      if (burning || flooded) rate = -0.3
      else if (frozen) rate = -0.1
      else if (famine) rate = GROWTH * surplus * 2 - 0.06 * hardship
      else rate = GROWTH * Math.max(surplus, surplus * 0.3) - 0.06 * hardship
      if (plague) rate -= 0.03
      town.pop = Math.min(1, town.pop + dt * rate)
      town.age += dt
      town.needs = {
        food,
        moist,
        waterNear,
        demand,
        tolerance: tol,
        hardship,
        capacity,
        rate,
        temperature: here.temperature,
        flooded,
        burning,
        frozen,
        granary: town.granary,
        famine,
        plague,
        hunting: town.hunting,
      }
      // a rich town at peace raises a monument to its gods (a pyramid, a temple, a tower)
      const atWar = this.wars.some((w) => w.a === civ.id || w.b === civ.id)
      if (!town.monument && !atWar && town.pop >= 0.6 && town.granary >= 0.4 && civ.tech >= ERAS[1].tech && !plague) {
        if (civ.monuments < 1 + Math.floor(civ.tech * 4) && Math.random() < MONUMENT_CHANCE * dt) {
          town.monument = civ.tech >= ERAS[4].tech ? 3 : civ.tech >= ERAS[2].tech ? 2 : 1
          civ.monuments++
          const what = MONUMENTS[town.monument]
          const where = town.id === civ.capital ? 'na capital' : 'numa de suas cidades'
          this.log(`${civ.name} ergue ${what === 'torre' ? 'uma' : 'um'} ${what} ${where} em honra ao ${FAITHS[civ.faith]}.`, civ.color, true, town.pos)
        }
      }
      // a learned, big town dams the river next to it
      if (!town.dam && civ.tech >= TECH_DAMS && town.pop >= 0.5) {
        const site = this.damSite(town.pos, at)
        if (site) {
          town.dam = site.pos
          town.damDir = site.dir
          town.damCrest = site.bed + DAM_HEIGHT
          civ.dams++
          if (civ.dams === 1) this.log(`${civ.name} construiu sua primeira represa.`, civ.color, false, site.pos)
        }
      }
      if (!civ.industrial && civ.tech >= TECH_INDUSTRY && town.pop >= 0.5) {
        civ.industrial = true
        this.log(`${civ.name} entrou na era industrial: fumaça, calor e o planeta aquecendo.`, civ.color, false, town.pos)
      }
      // knowledge: people make ideas, and need sharpens them; a hard climate teaches
      // adaptation to its kind of hardship
      const l = learned.get(civ.id)!
      l.tech += town.pop * (1 + 2 * demand)
      const exposure = Math.min(demand, tol + 0.15)
      if (here.temperature < 20) l.cold += town.pop * exposure
      else l.heat += town.pop * exposure
      if (!waterNear && here.humidity < 0.4) l.dry += town.pop * 0.3
      if (here.water > 0.0004) l.flood += town.pop * 0.3
      town.settle -= dt
      town.rest -= dt
      town.exodus -= dt
      // the yearly sample of its population, for the trend
      town.sample -= dt
      if (town.sample <= 0) {
        town.sample += YEAR
        town.history.push(town.pop)
        if (town.history.length > TREND_YEARS) town.history.shift()
      }
    }
    for (const civ of this.civs) {
      const l = learned.get(civ.id)!
      civ.tech = Math.min(1, civ.tech + dt * TECH_RATE * saturate(l.tech))
      civ.adapt.cold = Math.min(1, civ.adapt.cold + dt * ADAPT_RATE * saturate(l.cold))
      civ.adapt.heat = Math.min(1, civ.adapt.heat + dt * ADAPT_RATE * saturate(l.heat))
      civ.adapt.dry = Math.min(1, civ.adapt.dry + dt * ADAPT_RATE * saturate(l.dry))
      civ.adapt.flood = Math.min(1, civ.adapt.flood + dt * ADAPT_RATE * saturate(l.flood))
      civ.age += dt
      const era = eraOf(civ.tech)
      if (era > civ.era) {
        civ.era = era
        this.log(`${civ.name} entrou na ${ERAS[era].name}.`, civ.color, true, this.capitalPos(civ))
        if (era === ERAS.length - 1 && !this.ending) {
          this.ending = `${civ.name} chegou à Era Moderna: a história tem um vencedor.`
          this.log(this.ending, civ.color, true)
        }
      }
      for (const [other, g] of civ.grudges) {
        if (g - dt * 0.002 > 0) civ.grudges.set(other, g - dt * 0.002)
        else civ.grudges.delete(other)
      }
      for (const [other, age] of civ.allies) civ.allies.set(other, age + dt)
      civ.exodusLog -= dt
      civ.plagueLog -= dt
    }
    this.plagueLog -= dt
    // the plague travels the roads: from a sick town to the towns in contact with it
    for (const sick of this.towns) {
      if (sick.plague <= 0) continue
      for (const other of this.towns) {
        if (other === sick || other.plague > 0 || other.immune > 0 || dist(other.pos, sick.pos) > 0.07) continue
        const civ = civById.get(other.civ)
        if (!civ) continue
        const medicine = civ.tech >= TECH_GREENHOUSE ? 0.05 : civ.tech >= 0.6 ? 0.4 : 1
        if (Math.random() < PLAGUE_SPREAD * dt * medicine) this.outbreak(other, civ)
      }
    }

    // granaries: towns with full stores feed hungry towns of the same people within reach
    this.shareFood(dt, civById)

    // migration: people leave towns that fail them
    this.migrate(dt, civById, at)

    // abandoned towns: their ruins stay on the land
    for (let k = this.towns.length - 1; k >= 0; k--) {
      const town = this.towns[k]
      if (town.pop > 0.02) continue
      const civ = civById.get(town.civ)
      this.towns.splice(k, 1)
      this.ruins.push({ pos: town.pos, age: 0, color: civ?.color ?? 0, monument: town.monument, civ: civ?.name ?? '—' })
      if (this.ruins.length > MAX_RUINS) this.ruins.shift()
      if (civ) this.checkCapital(civ)
      if (civ && !this.towns.some((t) => t.civ === civ.id)) {
        this.removeCiv(civ)
        civById.delete(civ.id)
        this.log(`O povo ${civ.name} desapareceu após ${this.ageText(civ.age)}.`, civ.color, true, town.pos)
      }
    }

    // settlers: a thriving town founds another within reach, while the civ holds together
    const count = new Map<number, number>()
    for (const town of this.towns) count.set(town.civ, (count.get(town.civ) ?? 0) + 1)
    for (const town of this.towns) {
      const civ = civById.get(town.civ)
      if (!civ || town.pop < 0.5 || town.settle > 0 || this.towns.length >= MAX_TOWNS) continue
      if ((count.get(civ.id) ?? 0) >= this.townCap(civ)) continue
      town.settle = 40 + Math.random() * 40
      const spot = this.settleSpot(town.pos, this.reach(civ), civ, at)
      if (!spot) continue
      town.pop -= 0.15
      this.towns.push(this.newTown(spot, civ.id, 0.12, 60))
      this.send('settlers', town.pos, spot, civ.color, 0.4)
      count.set(civ.id, (count.get(civ.id) ?? 0) + 1)
      civ.founded++
      const over = this.ruinAt(spot)
      if (over) this.log(`${civ.name} funda uma cidade sobre as ruínas de ${over.civ}.`, civ.color, false, spot)
      else if (civ.founded === 3 || civ.founded % 5 === 0) this.log(`${civ.name} já fundou ${civ.founded} cidades.`, civ.color, false, spot)
    }

    // contact between civs: knowledge flows, tension builds, battles are fought
    const contact = new Map<string, { a: Civ; b: Civ; pressure: number }>()
    for (let i = 0; i < this.towns.length; i++) {
      const ta = this.towns[i]
      const ca = civById.get(ta.civ)
      if (!ca) continue
      for (let j = i + 1; j < this.towns.length; j++) {
        const tb = this.towns[j]
        if (tb.civ === ta.civ) continue
        const cb = civById.get(tb.civ)
        if (!cb) continue
        const d = dist(ta.pos, tb.pos)
        if (d > CONTACT) continue
        const key = ta.civ < tb.civ ? `${ta.civ}:${tb.civ}` : `${tb.civ}:${ta.civ}`
        const pair = contact.get(key) ?? { a: ca, b: cb, pressure: 0 }
        pair.pressure += (ta.pop + tb.pop) / 2
        contact.set(key, pair)
        const war = this.warBetween(ca.id, cb.id)
        if (war && ta.rest <= 0 && tb.rest <= 0 && Math.random() < BATTLE_CHANCE * dt) {
          this.battle(war, ta, ca, tb, cb)
        }
      }
    }
    for (const { a, b, pressure } of contact.values()) {
      // the less advanced learns from the other (faster between allies and trade partners)
      const gap = a.tech - b.tech
      const close = a.allies.has(b.id) ? 2 : this.warBetween(a.id, b.id) ? 0.5 : 1
      const flow = DIFFUSION * dt * Math.min(1, pressure) * close
      if (gap > 0) b.tech = Math.min(a.tech, b.tech + gap * flow)
      else a.tech = Math.min(b.tech, a.tech + -gap * flow)
      // faith spreads from the greater people to the smaller one it touches (faster in peace)
      if (a.faith !== b.faith) {
        const pa = this.power(a)
        const pb = this.power(b)
        const [big, small] = pa >= pb ? [a, b] : [b, a]
        const ratio = Math.max(pa, pb) / Math.max(1, Math.min(pa, pb))
        const chance = CONVERSION_CHANCE * dt * Math.min(1, pressure) * Math.min(3, ratio - 0.5) * (this.warBetween(a.id, b.id) ? 0.3 : 1)
        if (chance > 0 && Math.random() < chance) {
          small.faith = big.faith
          this.log(`${small.name} adota o ${FAITHS[big.faith]}, a fé de ${big.name}.`, small.color, true, this.capitalPos(small))
        }
      }
      if (this.warBetween(a.id, b.id) || a.truces.has(b.id) || a.allies.has(b.id)) continue
      // crowded frontiers breed war; hunger, grudges, a weak neighbour and a strange faith make it likelier
      const famineA = this.famineShare(a.id)
      const famineB = this.famineShare(b.id)
      const grudge = (a.grudges.get(b.id) ?? 0) + (b.grudges.get(a.id) ?? 0)
      const techGap = Math.abs(gap)
      const heresy = a.faith !== b.faith
      const chance =
        WAR_CHANCE * dt * Math.min(2, pressure) * (1 + 2 * Math.max(famineA, famineB) + 1.5 * grudge + 2 * techGap) * (heresy ? 1.6 : 0.7)
      if (Math.random() < chance) {
        const cause =
          Math.max(famineA, famineB) > 0.2 ? 'fome' : grudge > 0.5 ? 'vingança' : techGap > 0.25 ? 'conquista' : heresy ? 'fé' : 'terra'
        const aggressor =
          cause === 'fome' ? (famineA >= famineB ? a : b) : cause === 'conquista' ? (gap > 0 ? a : b) : cause === 'fé' ? (this.power(a) >= this.power(b) ? a : b) : a
        const victim = aggressor === a ? b : a
        this.declareWar(aggressor, victim, cause)
      }
    }
    // wars end in truces
    for (let k = this.wars.length - 1; k >= 0; k--) {
      const war = this.wars[k]
      war.left -= dt
      war.age += dt
      if (war.left > 0) continue
      this.wars.splice(k, 1)
      const a = civById.get(war.a)
      const b = civById.get(war.b)
      if (!a || !b) continue
      const truce = TRUCE_LENGTH * (0.5 + Math.random())
      a.truces.set(b.id, truce)
      b.truces.set(a.id, truce)
      this.log(`Paz entre ${a.name} e ${b.name} após ${this.ageText(war.age)} de guerra.`, a.color)
    }
    for (const civ of this.civs) {
      for (const [other, left] of civ.truces) {
        if (left - dt > 0) civ.truces.set(other, left - dt)
        else civ.truces.delete(other)
      }
    }

    // politics: a small ally joins its protector; a sprawling people falls apart
    this.unifyAndSplit(dt)

    // a new people appears now and then where the land is good
    this.genesis -= dt
    if (this.genesis <= 0 && this.civs.length < MAX_CIVS && this.towns.length < MAX_TOWNS) {
      this.genesis = NEW_CIV * (0.6 + Math.random() * 0.8)
      this.spawnCiv(field, extent)
    }
  }

  /** Sends a party walking from one place to another; too many on the roads and the oldest gives way. */
  private send(kind: PartyKind, from: [number, number], to: [number, number], color: number, size = 0.5) {
    if (dist(from, to) < 1e-6) return
    this.parties.push({ kind, from: [from[0], from[1]], to: [to[0], to[1]], t: 0, speed: kind === 'army' ? MARCH_SPEED : WALK_SPEED, color, size })
    if (this.parties.length > MAX_PARTIES) this.parties.shift()
  }

  /** The parties walk on and arrive; caravans set out along the trade routes and the roads. */
  private updateParties(dt: number) {
    for (const p of this.parties) p.t += (dt * p.speed) / Math.max(dist(p.from, p.to), 1e-6)
    this.parties = this.parties.filter((p) => p.t < 1)
    // traders: a caravan now and then on each trade route, a cart on each road, either way
    for (const r of this.routeList) {
      if (r.kind === 3) continue
      const every = r.kind === 2 ? CARAVAN_EVERY : CART_EVERY
      if (Math.random() < dt / every) {
        const back = Math.random() < 0.5
        this.send('caravan', back ? r.b : r.a, back ? r.a : r.b, r.color, r.kind === 2 ? 0.6 : 0.15)
      }
    }
    for (const t of this.towns) t.leaving -= dt
  }

  /** People × (0.5 + tech): how much a people weighs in the world. */
  private power(civ: Civ): number {
    let people = 0
    for (const t of this.towns) if (t.civ === civ.id) people += t.pop * 200
    return people * (0.5 + civ.tech)
  }

  /** A plague breaks out in a town; the chronicle tells of it once in a while. */
  private outbreak(town: Town, civ: Civ) {
    town.plague = PLAGUE_LENGTH * (0.6 + 0.8 * Math.random())
    town.immune = PLAGUE_IMMUNITY
    if (this.plagueLog > 0 && civ.plagueLog > 0) return
    this.plagueLog = 60
    civ.plagueLog = 200
    const where = town.id === civ.capital ? 'na capital de' : 'numa cidade de'
    this.log(`A peste irrompe ${where} ${civ.name}.`, civ.color, false, town.pos)
  }

  /** The ruin a spot stands on, if any (it is taken off the land). */
  private ruinAt(pos: [number, number]): Ruin | null {
    const k = this.ruins.findIndex((r) => dist(r.pos, pos) < TOWN_SPACING * 0.6)
    if (k < 0) return null
    return this.ruins.splice(k, 1)[0]
  }

  /** The faith a people born in a cell takes up: what rules the land around its first town. */
  private faithFor(pos: [number, number], cell: Cell, at: (p: [number, number]) => Cell | null): number {
    let sea = false
    let fire = false
    let river = false
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2
      for (const r of [0.03, 0.06]) {
        const c = at([pos[0] + Math.cos(a) * r, pos[1] + Math.sin(a) * r])
        if (!c) continue
        if (c.water > 0.03) sea = true
        else if (c.water > 0.0003) river = true
        if (c.lava > 0.0001) fire = true
      }
    }
    if (fire) return 4
    if (cell.temperature < 4) return 5
    if (sea) return 3
    if (cell.height > 0.35) return 2
    if (river && Math.random() < 0.6) return 1
    if (cell.humidity > 0.7 && Math.random() < 0.5) return 7
    if (cell.temperature > 26 || cell.humidity < 0.35) return 0
    return Math.random() < 0.5 ? 6 : 1
  }

  /** How many towns a people holds together, and how far its settlers walk. */
  private townCap(civ: Civ): number {
    return TOWNS_BASE + TOWNS_PER_TECH * civ.tech
  }
  private reach(civ: Civ): number {
    return (REACH_MIN + (REACH_MAX - REACH_MIN) * civ.tech) * (civ.tech >= TECH_SAILING ? 1.5 : 1)
  }

  /** Share of a civ's towns in famine. */
  private famineShare(civ: number): number {
    let n = 0
    let famine = 0
    for (const t of this.towns) {
      if (t.civ !== civ) continue
      n++
      if (t.needs.famine) famine++
    }
    return n ? famine / n : 0
  }

  /** Civ id → how many civs it trades with: at peace, in contact, not allied against it. */
  private tradePartners(): Map<number, number> {
    const partners = new Map<number, Set<number>>()
    for (let i = 0; i < this.towns.length; i++) {
      for (let j = i + 1; j < this.towns.length; j++) {
        const ta = this.towns[i]
        const tb = this.towns[j]
        if (ta.civ === tb.civ || dist(ta.pos, tb.pos) > CONTACT) continue
        if (this.warBetween(ta.civ, tb.civ)) continue
        if (!partners.has(ta.civ)) partners.set(ta.civ, new Set())
        if (!partners.has(tb.civ)) partners.set(tb.civ, new Set())
        partners.get(ta.civ)!.add(tb.civ)
        partners.get(tb.civ)!.add(ta.civ)
      }
    }
    return new Map([...partners].map(([id, set]) => [id, set.size]))
  }

  private shareFood(dt: number, civById: Map<number, Civ>) {
    for (const hungry of this.towns) {
      if (hungry.granary > 0.2) continue
      const civ = civById.get(hungry.civ)
      if (!civ) continue
      const range = this.reach(civ) * 2
      for (const full of this.towns) {
        if (full === hungry || full.civ !== hungry.civ || full.granary < 0.6) continue
        if (dist(full.pos, hungry.pos) > range) continue
        const moved = Math.min(full.granary - 0.5, dt * 0.03)
        full.granary -= moved
        hungry.granary = Math.min(1, hungry.granary + moved)
        break
      }
    }
  }

  /** People leave towns in famine or decline: to another town of theirs, to a neighbour at peace, or to new land. */
  private migrate(dt: number, civById: Map<number, Civ>, at: (p: [number, number]) => Cell | null) {
    for (const town of this.towns) {
      const n = town.needs
      const failing = n.famine || n.flooded || n.burning || (n.hardship > 0.03 && n.rate < 0)
      if (!failing || town.pop <= 0.1) continue
      const civ = civById.get(town.civ)
      if (!civ) continue
      const leaving = Math.min(town.pop - 0.06, dt * 0.02)
      if (leaving <= 0) continue
      const range = this.reach(civ) * 2
      // the best of their own towns with room, then a neighbour at peace, then new land
      let dest: Town | null = null
      let bestRoom = 0.05
      for (const other of this.towns) {
        if (other === town || other.needs.famine) continue
        const own = other.civ === town.civ
        const d = dist(other.pos, town.pos)
        if (d > (own ? range : range * 0.6)) continue
        if (!own && (this.warBetween(other.civ, town.civ) || other.pop > 0.6)) continue
        const room = other.needs.capacity - other.pop - (own ? 0 : 0.2)
        if (room > bestRoom) {
          bestRoom = room
          dest = other
        }
      }
      const why = n.burning ? 'da lava' : n.flooded ? 'da enchente' : n.famine ? 'da fome' : n.temperature < 8 ? 'do frio' : 'do calor'
      if (dest) {
        town.pop -= leaving
        dest.pop = Math.min(1, dest.pop + leaving)
        if (town.leaving <= 0) {
          town.leaving = MIGRANTS_EVERY
          this.send('migrants', town.pos, dest.pos, civ.color, 0.3 + town.pop * 0.5)
        }
        if (town.exodus <= 0 && civ.exodusLog <= 0) {
          town.exodus = 120
          civ.exodusLog = 150
          const foreign = dest.civ !== town.civ
          const destCiv = civById.get(dest.civ)
          this.log(
            foreign
              ? `Refugiados de ${civ.name} fogem ${why} e chegam a uma cidade de ${destCiv?.name ?? '—'}.`
              : `Êxodo em ${civ.name}: gente foge ${why} para outra cidade.`,
            civ.color,
            false,
            town.pos,
          )
        }
      } else if (town.exodus <= 0 && this.towns.length < MAX_TOWNS) {
        // no room anywhere: they try new land, further than settlers would go
        town.exodus = 120
        const spot = this.settleSpot(town.pos, this.reach(civ) * 1.6, civ, at)
        if (spot) {
          town.pop -= Math.min(town.pop - 0.06, 0.15)
          this.towns.push(this.newTown(spot, civ.id, 0.12, 60))
          this.send('migrants', town.pos, spot, civ.color, 0.6)
          civ.founded++
          if (civ.exodusLog > 0) continue
          civ.exodusLog = 150
          this.log(`Gente de ${civ.name} foge ${why} e funda uma cidade em terra nova.`, civ.color, false, spot)
        }
      }
    }
  }

  private declareWar(aggressor: Civ, victim: Civ, cause: string) {
    this.wars.push({ a: aggressor.id, b: victim.id, left: WAR_LENGTH * (0.5 + Math.random()), age: 0, battles: 0, taken: [0, 0], cause })
    const why = { fome: 'por fome', vingança: 'por vingança', conquista: 'de conquista', terra: 'por terra', fé: 'em nome da fé' }[cause] ?? ''
    this.log(`${aggressor.name} declara guerra a ${victim.name} ${why}!`, aggressor.color, true, this.capitalPos(victim))
    // the victim's allies come to its side; the aggressor's too
    for (const [allyId] of victim.allies) {
      const ally = this.civById(allyId)
      if (!ally || this.warBetween(ally.id, aggressor.id) || ally.allies.has(aggressor.id)) continue
      this.wars.push({ a: ally.id, b: aggressor.id, left: WAR_LENGTH * 0.8, age: 0, battles: 0, taken: [0, 0], cause: 'aliança' })
      this.log(`${ally.name} entra na guerra ao lado de ${victim.name}.`, ally.color)
    }
    // two peoples at peace that share an enemy become allies
    for (const other of this.civs) {
      if (other === victim || other === aggressor) continue
      const sharesEnemy = this.warBetween(other.id, aggressor.id) && !this.warBetween(other.id, victim.id)
      // (brothers in faith stand together more readily)
      if (sharesEnemy && !other.allies.has(victim.id) && Math.random() < (other.faith === victim.faith ? 0.75 : 0.4)) {
        other.allies.set(victim.id, 0)
        victim.allies.set(other.id, 0)
        this.log(`${other.name} e ${victim.name} fazem uma aliança contra ${aggressor.name}.`, victim.color)
      }
    }
  }

  /** A battle between two frontier towns; the loser may be conquered. */
  private battle(war: War, ta: Town, ca: Civ, tb: Town, cb: Civ) {
    ta.rest = tb.rest = 8 + Math.random() * 8
    war.battles++
    const strength = (t: Town, c: Civ) => t.pop * (0.5 + c.tech) * (0.7 + Math.random() * 0.6) * (t.needs.famine ? 0.7 : 1)
    const aWins = strength(ta, ca) >= strength(tb, cb)
    const winner = aWins ? ta : tb
    const loser = aWins ? tb : ta
    const wc = aWins ? ca : cb
    const lc = aWins ? cb : ca
    winner.pop = Math.max(0.05, winner.pop - 0.05)
    loser.pop -= 0.25
    // the fight is marked where the loser stood, and the victors are seen marching on it
    this.battles.push({ pos: [loser.pos[0], loser.pos[1]], age: 0 })
    this.send('army', winner.pos, loser.pos, wc.color, 0.5 + 0.5 * winner.pop)
    if (this.battles.length > MAX_BATTLES) this.battles.shift()
    if (loser.pop < 0.2) {
      // conquered: the town changes hands with what is left of its people
      loser.civ = wc.id
      loser.pop = Math.max(0.1, loser.pop + 0.1)
      loser.rest = 45
      winner.rest = 30
      wc.conquests++
      lc.grudges.set(wc.id, (lc.grudges.get(wc.id) ?? 0) + 1)
      war.taken[wc.id === war.a ? 0 : 1]++
      this.log(`${wc.name} conquistou uma cidade de ${lc.name}.`, wc.color, false, loser.pos)
      // the victors learn from the conquered, and tear down the gods' monument
      wc.tech = Math.min(1, Math.max(wc.tech, wc.tech * 0.8 + lc.tech * 0.2))
      if (loser.monument && wc.faith !== lc.faith) {
        this.log(`Os conquistadores derrubam ${MONUMENTS[loser.monument] === 'torre' ? 'a' : 'o'} ${MONUMENTS[loser.monument]} de ${lc.name}.`, wc.color)
        loser.monument = 0
      }
      this.checkCapital(lc)
      if (!this.towns.some((t) => t.civ === lc.id)) {
        this.removeCiv(lc)
        this.log(`${lc.name} foi conquistado por ${wc.name} após ${this.ageText(lc.age)}.`, lc.color, true, loser.pos)
      }
    }
  }

  /** A small ally joins its protector; a people with more towns than it can hold splits. */
  private unifyAndSplit(dt: number) {
    for (const civ of this.civs) {
      for (const [allyId, age] of civ.allies) {
        const ally = this.civById(allyId)
        if (!ally || age < 200) continue
        const mine = this.towns.filter((t) => t.civ === civ.id).length
        const theirs = this.towns.filter((t) => t.civ === ally.id).length
        if (theirs > 0 && theirs * 4 <= mine && Math.random() < dt * 0.01) {
          for (const t of this.towns) if (t.civ === ally.id) t.civ = civ.id
          this.log(`${ally.name} se une a ${civ.name}: um só povo.`, civ.color, true)
          this.removeCiv(ally)
          return
        }
      }
      const towns = this.towns.filter((t) => t.civ === civ.id)
      if (towns.length >= 12 && towns.length > this.townCap(civ) + 3 && Math.random() < dt * 0.004) {
        this.split(civ, towns)
        return
      }
    }
  }

  private split(civ: Civ, towns: Town[]) {
    const capital = towns.find((t) => t.id === civ.capital) ?? towns[0]
    const far = towns
      .filter((t) => t !== capital)
      .sort((p, q) => dist(q.pos, capital.pos) - dist(p.pos, capital.pos))
      .slice(0, Math.floor(towns.length / 2))
    if (!far.length) return
    const rebel = this.makeCiv(civ.tech * 0.95, { ...civ.adapt }, civ.faith)
    for (const t of far) t.civ = rebel.id
    rebel.capital = far[0].id
    civ.grudges.set(rebel.id, 1)
    rebel.grudges.set(civ.id, 1)
    // a schism now and then: the rebels take up a faith of their own
    if (Math.random() < 0.35) {
      rebel.faith = (civ.faith + 1 + Math.floor(Math.random() * (FAITHS.length - 1))) % FAITHS.length
      this.log(`${rebel.name} se separa de ${civ.name} num cisma: segue o ${FAITHS[rebel.faith]}.`, rebel.color, true, this.capitalPos(rebel))
    } else this.log(`${rebel.name} se separa de ${civ.name}: o povo era grande demais para ficar unido.`, rebel.color, true, this.capitalPos(rebel))
  }

  private checkCapital(civ: Civ) {
    if (this.towns.some((t) => t.id === civ.capital && t.civ === civ.id)) return
    const mine = this.towns.filter((t) => t.civ === civ.id).sort((p, q) => q.pop - p.pop)
    if (mine.length) {
      civ.capital = mine[0].id
      this.log(`${civ.name} perdeu sua capital; a corte se muda para outra cidade.`, civ.color)
    }
  }

  private removeCiv(civ: Civ) {
    this.civs = this.civs.filter((c) => c !== civ)
    this.wars = this.wars.filter((w) => w.a !== civ.id && w.b !== civ.id)
    for (const other of this.civs) {
      other.truces.delete(civ.id)
      other.allies.delete(civ.id)
      other.grudges.delete(civ.id)
    }
  }

  private makeCiv(tech: number, adapt: Adaptation, faith = 6): Civ {
    const used = new Set(this.civs.map((c) => c.color))
    const free = CIV_COLORS.map((_, k) => k).filter((k) => !used.has(k))
    let name = civName()
    for (let tries = 0; tries < 20 && this.lineage.some((c) => c.name === name); tries++) name = civName()
    const civ: Civ = {
      id: this.nextCiv++,
      name,
      color: free.length ? pick(free) : Math.floor(Math.random() * CIV_COLORS.length),
      tech,
      adapt,
      age: 0,
      truces: new Map(),
      allies: new Map(),
      grudges: new Map(),
      conquests: 0,
      founded: 1,
      dams: 0,
      industrial: tech >= TECH_INDUSTRY,
      era: eraOf(tech),
      capital: 0,
      exodusLog: 0,
      faith,
      monuments: 0,
      plagueLog: 0,
    }
    this.civs.push(civ)
    this.lineage.push({ id: civ.id, name: civ.name, color: civ.color })
    return civ
  }

  /**
   * The player calls a people into being at a place (world units): a town there, if the
   * land can feed one and no town stands too close. Returns whether it happened.
   */
  seedCiv(pos: [number, number], extent: number): boolean {
    const field = this.field
    if (!field || this.towns.length >= MAX_TOWNS) return false
    const at = (p: [number, number]) => this.cellAt(field, p, extent)
    const cell = at(pos)
    if (!cell || cell.water > 0.002 || cell.lava > 0.0002 || cell.ice >= 0.0005) return false
    if (this.towns.some((t) => dist(t.pos, pos) < TOWN_SPACING)) return false
    this.started = true
    const faith = this.faithFor(pos, cell, at)
    const civ = this.makeCiv(0, { cold: 0, heat: 0, dry: 0, flood: 0 }, faith)
    const town = this.newTown(pos, civ.id, 0.25, 20)
    this.towns.push(town)
    civ.capital = town.id
    this.log(`Surgiu o povo ${civ.name}, chamado à vida; segue o ${FAITHS[faith]}.`, civ.color, true, pos)
    return true
  }

  private spawnCiv(field: Field, extent: number) {
    const spot = this.goodSpot(field, extent, 'village')
    if (!spot) {
      this.barrenYears += NEW_CIV / YEAR
      if (this.barrenYears > 100 && !this.civs.length && !this.ending) {
        this.ending = 'O planeta ficou inabitável: há cem anos nenhum povo encontra onde viver.'
        this.log(this.ending, 0, true)
      }
      return
    }
    this.barrenYears = 0
    const at = (p: [number, number]) => this.cellAt(field, p, extent)
    const cell = at(spot)
    const faith = cell ? this.faithFor(spot, cell, at) : 6
    const civ = this.makeCiv(0, { cold: 0, heat: 0, dry: 0, flood: 0 }, faith)
    const town = this.newTown(spot, civ.id, 0.2, 20)
    this.towns.push(town)
    civ.capital = town.id
    const over = this.ruinAt(spot)
    this.log(`Surgiu o povo ${civ.name}, que segue o ${FAITHS[faith]}${over ? `, sobre as ruínas de ${over.civ}` : ''}.`, civ.color, true, spot)
  }

  private newTown(pos: [number, number], civ: number, pop: number, settle: number): Town {
    return {
      id: this.nextTown++,
      name: placeName(),
      pos,
      age: 0,
      needs: {
        food: 0,
        moist: 0,
        waterNear: false,
        demand: 0,
        tolerance: 0,
        hardship: 0,
        capacity: 0,
        rate: 0,
        temperature: 15,
        flooded: false,
        burning: false,
        frozen: false,
        granary: 0.3,
        famine: false,
        plague: false,
        hunting: false,
      },
      dam: null,
      damDir: [1, 0],
      damCrest: 0,
      pop,
      civ,
      granary: 0.3,
      settle,
      rest: settle > 30 ? 10 : 0,
      exodus: 0,
      leaving: 0,
      strain: 0,
      history: [pop],
      sample: YEAR,
      plague: 0,
      immune: 0,
      monument: 0,
      hunting: false,
    }
  }

  /** The best of a few spots within reach of a town for its settlers, or null. */
  private settleSpot(from: [number, number], reach: number, civ: Civ, at: (p: [number, number]) => Cell | null) {
    let best: [number, number] | null = null
    const adaptMean = (civ.adapt.cold + civ.adapt.heat + civ.adapt.dry + civ.adapt.flood) / 4
    // a learned, adapted people makes do with poorer land
    let bestScore = 0.25 - 0.1 * civ.tech - 0.1 * adaptMean
    for (let k = 0; k < 12; k++) {
      const a = Math.random() * Math.PI * 2
      const r = reach * (0.4 + 0.6 * Math.random())
      const pos: [number, number] = [from[0] + Math.cos(a) * r, from[1] + Math.sin(a) * r]
      const cell = at(pos)
      if (!cell || cell.lava > 0 || cell.water > 0.0005 || cell.ice > 0.0005) continue
      if (this.towns.some((t) => dist(t.pos, pos) < TOWN_SPACING)) continue
      const waterNear = this.waterNear(pos, at, civ.tech >= TECH_IRRIGATION ? 0.03 : 0.02)
      const moist = waterNear ? 1 : Math.max(0, Math.min(1, (cell.humidity - 0.25) / 0.35))
      const hardship = Math.max(0, climateDemand(cell.temperature) - tolerance(civ, cell.temperature))
      const s = (cell.vegetation * 1.6 + (waterNear ? 0.25 : 0)) * moist + 0.3 * adaptMean - hardship * 3
      if (s > bestScore) {
        bestScore = s
        best = pos
      }
    }
    return best
  }

  /**
   * The nearest running water (a river, not a lake or the sea) within a short walk of a
   * town, and the direction a wall across it runs (across the flow), or null.
   */
  private damSite(
    pos: [number, number],
    at: (p: [number, number]) => Cell | null,
  ): { pos: [number, number]; dir: [number, number]; bed: number } | null {
    for (const d of [0.024, 0.036]) {
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * Math.PI * 2
        const p: [number, number] = [pos[0] + Math.cos(a) * d, pos[1] + Math.sin(a) * d]
        const cell = at(p)
        if (!cell || cell.water < 0.0003 || cell.water > 0.01 || cell.ice >= 0.0005) continue
        // the flow's direction, averaged a little around the site; the wall runs across it
        let fx = cell.flow[0]
        let fy = cell.flow[1]
        for (let j = 0; j < 8; j++) {
          const b = (j / 8) * Math.PI * 2
          const c = at([p[0] + Math.cos(b) * 0.006, p[1] + Math.sin(b) * 0.006])
          if (c) {
            fx += c.flow[0]
            fy += c.flow[1]
          }
        }
        const len = Math.hypot(fx, fy)
        const dir: [number, number] = len > 1e-9 ? [-fy / len, fx / len] : [Math.cos(a + Math.PI / 2), Math.sin(a + Math.PI / 2)]
        return { pos: p, dir, bed: cell.height }
      }
    }
    return null
  }

  private waterNear(pos: [number, number], at: (p: [number, number]) => Cell | null, radius = 0.02): boolean {
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2
      const cell = at([pos[0] + Math.cos(a) * radius, pos[1] + Math.sin(a) * radius])
      if (cell && cell.water > 0.0003 && cell.water < 0.03) return true
    }
    return false
  }

  private log(text: string, color: number, major = false, pos?: [number, number]) {
    this.events.push({ time: this.time, year: this.year, text, color, major, pos: pos ? [pos[0], pos[1]] : undefined })
    if (this.events.length > MAX_EVENTS) this.events.shift()
  }

  /** Where a people's capital stands, for placing its news. */
  private capitalPos(civ: Civ): [number, number] | undefined {
    return this.towns.find((t) => t.id === civ.capital && t.civ === civ.id)?.pos
  }

  /** The surface (ground plus water) at a place, in height units; 0 outside the window. */
  surfaceAt(pos: [number, number], extent: number): number {
    const cell = this.field ? this.cellAt(this.field, pos, extent) : null
    return cell ? cell.height + cell.water : 0
  }

  private ageText(seconds: number): string {
    const years = Math.max(1, Math.round(seconds / YEAR))
    return years === 1 ? '1 ano' : `${years} anos`
  }

  // ---- the long run -----------------------------------------------------------------------

  /** Once a year: the timeline, the century's summary, and named catastrophes. */
  private endOfYear(field: Field, extent: number) {
    const year = this.year
    const people = (t: Town) => Math.round(t.pop * 200)
    const byCiv = new Map<number, number>()
    for (const t of this.towns) byCiv.set(t.civ, (byCiv.get(t.civ) ?? 0) + people(t))
    const total = [...byCiv.values()].reduce((s, v) => s + v, 0)
    this.history.push({ year, people: [...byCiv], total })
    // keep the timeline bounded: past the limit, drop every other old point
    if (this.history.length > HISTORY_YEARS) this.history = this.history.filter((_, k) => k % 2 === 0 || k > HISTORY_YEARS / 2)
    // a catastrophe: a fifth of the world's people lost within five years
    this.recentPeople.push(total)
    if (this.recentPeople.length > 6) this.recentPeople.shift()
    const peak = Math.max(...this.recentPeople)
    if (peak >= 400 && total < peak * 0.8 && year - this.lastCatastrophe > 10) {
      this.lastCatastrophe = year
      this.log(`${this.catastropheName(field, extent)} de ${year}: o mundo perdeu ${Math.round((1 - total / peak) * 100)}% da sua gente em poucos anos.`, 0, true)
    }
    // the century's summary
    const century = Math.floor(year / 100)
    if (century > this.lastCentury) {
      this.lastCentury = century
      const eras = this.civs.map((c) => c.era)
      const era = eras.length ? ERAS[Math.max(...eras)].name : 'nenhuma'
      const wars = this.wars.length
      this.log(
        `Século ${century + 1}: ${total} pessoas em ${this.towns.length} cidades, ${this.civs.length} povos, era mais avançada: ${era}${wars ? `, ${wars} guerra${wars > 1 ? 's' : ''} em curso` : ', em paz'}.`,
        0,
        true,
      )
    }
  }

  /** What killed the most people lately, by the towns in trouble. */
  private catastropheName(field: Field, extent: number): string {
    const causes = { frio: 0, calor: 0, seca: 0, enchente: 0, fome: 0, guerra: 0, lava: 0, peste: 0 }
    for (const t of this.towns) {
      const n = t.needs
      if (n.burning) causes.lava++
      else if (n.plague) causes.peste++
      else if (n.flooded) causes.enchente++
      else if (n.hardship > 0.03) {
        if (n.temperature < 8) causes.frio++
        else causes.calor++
      } else if (n.moist < 0.3) causes.seca++
      else if (n.famine) causes.fome++
      else if (t.rest > 0) causes.guerra++
    }
    if (!this.towns.length) {
      // every town gone: judge by the land where they used to live
      const cell = this.cellAt(field, [(0.5 + field.origin[0] / field.size) * extent, (0.5 + field.origin[1] / field.size) * extent], extent)
      if (cell && cell.temperature < 0) return 'O Grande Frio'
      if (cell && cell.temperature > 35) return 'O Grande Calor'
    }
    const [cause] = Object.entries(causes).sort((p, q) => q[1] - p[1])[0]
    return {
      frio: 'O Grande Frio',
      calor: 'O Grande Calor',
      seca: 'A Grande Seca',
      enchente: 'A Grande Enchente',
      fome: 'A Grande Fome',
      guerra: 'A Grande Guerra',
      lava: 'O Grande Fogo',
      peste: 'A Grande Peste',
    }[cause]!
  }

  // ---- the world as seen by the life ----------------------------------------------------

  /** How much a herd of a species likes a cell. */
  private score(cell: Cell, sp: Species) {
    let s = Math.min(cell.vegetation, 0.6) * 2 + (cell.vegetation > sp.veg ? 0.5 : -0.5)
    if (cell.water > 0.0003 && cell.water < 0.01) s += 0.6
    if (cell.water >= 0.01) s -= 4
    if (cell.lava > 0.0002) s -= 6
    if (cell.ice > 0.0005) s -= 1.5
    if (cell.temperature < sp.tMin) s -= 1 + (sp.tMin - cell.temperature) * 0.1
    if (cell.temperature > sp.tMax) s -= 1 + (cell.temperature - sp.tMax) * 0.1
    return s
  }

  /** Whether a species can live in a cell: its temperatures, its grazing, no water, lava or ice. */
  private suits(cell: Cell, sp: Species): boolean {
    return (
      cell.temperature >= sp.tMin &&
      cell.temperature <= sp.tMax &&
      cell.vegetation > sp.veg &&
      cell.water < 0.0005 &&
      cell.lava <= 0 &&
      cell.ice < 0.0005
    )
  }

  private spawnHerds(field: Field, extent: number) {
    for (let k = 0; k < HERDS; k++) {
      // the species take turns, so each kind the land can feed gets its herds; a kind with
      // no place here (mammoths in a warm world) is skipped for the next
      for (let j = 0; j < SPECIES.length; j++) {
        const species = (k + j) % SPECIES.length
        const spot = this.goodSpot(field, extent, 'herd', species)
        if (!spot) continue
        this.creatures.push({ kind: 'herd', pos: spot, dir: [0, 0], health: 0.7, dead: 0, think: 0, species })
        this.seen.add(species)
        break
      }
    }
  }

  /**
   * Now and then a kind of animal with no herd in the world finds a home in it, if the
   * climate has made one (mammoths come down with the cold, elephants up with the heat);
   * a kind that died out stays gone.
   */
  private arrivals(dt: number, field: Field, extent: number) {
    this.arrival -= dt
    if (this.arrival > 0) return
    this.arrival = ARRIVAL_EVERY
    if (this.creatures.length >= MAX_HERDS) return
    for (let k = 0; k < SPECIES.length; k++) {
      if (this.extinct.has(k) || this.creatures.some((c) => c.species === k)) continue
      const spot = this.goodSpot(field, extent, 'herd', k)
      if (!spot) continue
      this.creatures.push({ kind: 'herd', pos: spot, dir: [0, 0], health: 0.7, dead: 0, think: 0, species: k })
      this.seen.add(k)
      this.log(`Os ${SPECIES[k].name} chegam ao mundo: o clima agora os sustenta.`, 0)
      break
    }
  }

  /**
   * A random cell in the window with grass, no water on it and no lava, where the species
   * can live; a new people also wants a mild climate, moisture and room from the other
   * towns. Null if none is found.
   */
  private goodSpot(field: Field, extent: number, kind: LifeKind, species = 0): [number, number] | null {
    const n = field.size
    const sp = SPECIES[species]
    for (let tries = 0; tries < 60; tries++) {
      const uv: [number, number] = [0.08 + 0.84 * Math.random(), 0.08 + 0.84 * Math.random()]
      const pos: [number, number] = [(uv[0] + field.origin[0] / n) * extent, (uv[1] + field.origin[1] / n) * extent]
      const cell = this.cellAt(field, pos, extent)
      if (!cell) continue
      const ok =
        kind === 'herd'
          ? this.suits(cell, sp)
          : cell.vegetation > 0.25 && cell.water < 0.0005 && cell.lava <= 0 && cell.ice < 0.0005
      if (!ok) continue
      if (kind === 'village') {
        if (climateDemand(cell.temperature) > 0.1) continue
        const at = (p: [number, number]) => this.cellAt(field, p, extent)
        if (!this.waterNear(pos, at) && cell.humidity < 0.4) continue
        if (this.towns.some((t) => dist(t.pos, pos) < CONTACT)) continue
      }
      return pos
    }
    return null
  }

  /** The field's cell under a world position, or null outside the window it was read from. */
  private cellAt(field: Field, pos: [number, number], extent: number): Cell | null {
    const n = field.size
    const u = pos[0] / extent - field.origin[0] / n
    const v = pos[1] / extent - field.origin[1] / n
    if (u < 0 || v < 0 || u >= 1 || v >= 1) return null
    const i = Math.floor(v * n) * n + Math.floor(u * n)
    return {
      vegetation: field.extra[i * 4],
      water: field.water[i * 4],
      flow: [field.water[i * 4 + 1], field.water[i * 4 + 2]],
      lava: field.lava[i * 4],
      ice: field.extra[i * 4 + 3],
      temperature: field.climate[i * 4 + 3],
      humidity: field.climate[i * 4 + 1],
      height: field.ground ? field.ground[i * 4] : 0,
    }
  }

  // ---- what is drawn --------------------------------------------------------------------

  private inWindow(pos: [number, number], origin: [number, number], n: number, extent: number): [number, number] | null {
    const uv: [number, number] = [pos[0] / extent - origin[0] / n, pos[1] / extent - origin[1] / n]
    return uv[0] < 0 || uv[1] < 0 || uv[0] > 1 || uv[1] > 1 ? null : uv
  }

  /** The living creatures, towns and battles as markers in the window given by origin (cells, of n) and extent. */
  markers(origin: [number, number], n: number, extent: number): LifeMarker[] {
    const out: LifeMarker[] = []
    const civById = new Map(this.civs.map((c) => [c.id, c]))
    for (const t of this.towns) {
      const uv = this.inWindow(t.pos, origin, n, extent)
      const civ = civById.get(t.civ)
      if (!uv || !civ) continue
      out.push({ uv, kind: 'village', size: t.pop, health: 1 - t.strain, color: civ.color, tech: civ.tech, flag: t.monument })
      if (t.dam) {
        const duv = this.inWindow(t.dam, origin, n, extent)
        if (duv) out.push({ uv: duv, kind: 'dam', size: 1, health: Math.atan2(t.damDir[1], t.damDir[0]), color: civ.color, tech: t.damCrest, flag: 0 })
      }
    }
    for (const p of this.parties) {
      const pos: [number, number] = [p.from[0] + (p.to[0] - p.from[0]) * p.t, p.from[1] + (p.to[1] - p.from[1]) * p.t]
      const uv = this.inWindow(pos, origin, n, extent)
      if (!uv) continue
      const heading = Math.atan2(p.to[1] - p.from[1], p.to[0] - p.from[0])
      out.push({ uv, kind: 'party', size: p.size, health: heading, color: p.color, tech: 0, flag: PARTY_KINDS.indexOf(p.kind) })
    }
    for (const c of this.creatures) {
      if (c.dead > 0) continue
      const uv = this.inWindow(c.pos, origin, n, extent)
      if (uv) out.push({ uv, kind: 'herd', size: SPECIES[c.species].size, health: c.health, color: 0, tech: 0, flag: c.species })
    }
    for (const r of this.ruins) {
      const uv = this.inWindow(r.pos, origin, n, extent)
      if (uv) out.push({ uv, kind: 'ruin', size: 1 - r.age / RUIN_LIFE, health: 1, color: r.color, tech: 0, flag: r.monument })
    }
    for (const b of this.battles) {
      const uv = this.inWindow(b.pos, origin, n, extent)
      if (uv) out.push({ uv, kind: 'battle', size: 1 - b.age / BATTLE_FADE, health: 1, color: 0, tech: 0, flag: 0 })
    }
    // boats sail the sea routes back and forth
    for (const r of this.routes()) {
      if (r.kind !== 3) continue
      const len = dist(r.a, r.b)
      if (len < 1e-6) continue
      const phase = ((this.time * BOAT_SPEED) / len + (r.from * 7 + r.to * 13) * 0.137) % 2
      const t = phase < 1 ? phase : 2 - phase
      const pos: [number, number] = [r.a[0] + (r.b[0] - r.a[0]) * t, r.a[1] + (r.b[1] - r.a[1]) * t]
      const cell = this.field ? this.cellAt(this.field, pos, extent) : null
      if (!cell || cell.water < 0.003) continue
      const uv = this.inWindow(pos, origin, n, extent)
      const heading = Math.atan2((r.b[1] - r.a[1]) * (phase < 1 ? 1 : -1), (r.b[0] - r.a[0]) * (phase < 1 ? 1 : -1))
      if (uv) out.push({ uv, kind: 'boat', size: 1, health: heading, color: r.color, tech: 0, flag: 0 })
    }
    return out
  }

  /**
   * The roads and routes of the moment, in world units, reckoned once a simulated second:
   * roads between towns of one people within its settlers' reach (paved once it knows the
   * Medieval arts), trade routes between towns of peoples at peace and in contact, and sea
   * routes where a route crosses open water and the people can sail (boats run on them,
   * see markers).
   */
  private routes(): Route[] {
    if (this.time - this.routesTime < ROUTES_EVERY) return this.routeList
    this.routesTime = this.time
    const field = this.field
    const out: Route[] = []
    const civById = new Map(this.civs.map((c) => [c.id, c]))
    const extent = this.extentSeen
    const waterBetween = (a: [number, number], b: [number, number]) => {
      if (!field) return 0
      let wet = 0
      for (let k = 1; k < 8; k++) {
        const t = k / 8
        const c = this.cellAt(field, [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], extent)
        if (c && c.water > 0.003) wet++
      }
      return wet
    }
    for (let i = 0; i < this.towns.length; i++) {
      const ta = this.towns[i]
      const ca = civById.get(ta.civ)
      if (!ca) continue
      for (let j = i + 1; j < this.towns.length; j++) {
        const tb = this.towns[j]
        const cb = civById.get(tb.civ)
        if (!cb) continue
        const d = dist(ta.pos, tb.pos)
        let kind: number
        if (ta.civ === tb.civ) {
          if (d > this.reach(ca) * 1.1) continue
          kind = ca.tech >= ERAS[3].tech ? 1 : 0
        } else {
          if (d > CONTACT || this.warBetween(ta.civ, tb.civ)) continue
          kind = 2
        }
        const wet = waterBetween(ta.pos, tb.pos)
        // a road fords a stream; across open water only sailors keep the link, and then by sea
        const ford = wet < 2 && kind !== 2
        if (wet > 0 && !ford) {
          if (ca.tech >= TECH_SAILING && cb.tech >= TECH_SAILING) kind = 3
          else continue
        }
        out.push({ a: ta.pos, b: tb.pos, kind, from: ta.id, to: tb.id, color: ca.color })
      }
    }
    // the shortest first when there are too many
    out.sort((p, q) => dist(p.a, p.b) - dist(q.a, q.b))
    this.routeList = out.slice(0, MAX_ROADS)
    return this.routeList
  }

  /** The routes in the window, as the renderer draws them (window uv). */
  roads(origin: [number, number], n: number, extent: number): RoadSegment[] {
    const out: RoadSegment[] = []
    for (const r of this.routes()) {
      const a = this.inWindow(r.a, origin, n, extent)
      const b = this.inWindow(r.b, origin, n, extent)
      if (a && b) out.push({ a, b, kind: r.kind })
    }
    return out
  }

  /**
   * Names to draw over the map: each people's name at its capital, and the selected town.
   * On the peoples' map (political), the people's name sits in the middle of its land and
   * the bigger towns and capitals are named too, like an atlas.
   */
  labels(origin: [number, number], n: number, extent: number, selected: number | null, political = false): LifeLabel[] {
    const out: LifeLabel[] = []
    const field = this.field
    const surface = (pos: [number, number]) => {
      const cell = field ? this.cellAt(field, pos, extent) : null
      return cell ? cell.height + cell.water : 0
    }
    for (const civ of this.civs) {
      const towns = this.towns.filter((t) => t.civ === civ.id)
      const capital = towns.find((t) => t.id === civ.capital)
      if (!capital) continue
      let at: [number, number] = capital.pos
      if (political) {
        // the middle of the people's land in the window, weighted by its towns
        let wx = 0
        let wy = 0
        let sum = 0
        for (const t of towns) {
          if (!this.inWindow(t.pos, origin, n, extent)) continue
          const w = 0.3 + t.pop
          wx += t.pos[0] * w
          wy += t.pos[1] * w
          sum += w
        }
        if (sum > 0) at = [wx / sum, wy / sum]
      }
      const uv = this.inWindow(at, origin, n, extent)
      if (!uv) continue
      out.push({
        uv,
        text: civ.name,
        color: civ.color,
        major: true,
        height: surface(at),
        kind: 'people',
        size: Math.min(1, towns.length / 8),
      })
    }
    if (political) {
      for (const t of this.towns) {
        const civ = this.civById(t.civ)
        const capital = civ?.capital === t.id
        if (!civ || (!capital && t.pop < 0.35)) continue
        const uv = this.inWindow(t.pos, origin, n, extent)
        if (!uv) continue
        out.push({ uv, text: t.name, color: civ.color, major: capital, height: surface(t.pos), kind: 'town', size: t.pop })
      }
    }
    if (selected !== null) {
      const t = this.towns.find((x) => x.id === selected)
      if (t) {
        const uv = this.inWindow(t.pos, origin, n, extent)
        const civ = this.civById(t.civ)
        const named = political && (civ?.capital === t.id || t.pop >= 0.35)
        if (uv) out.push({ uv, text: named ? 'escolhida' : t.name, color: civ?.color ?? 0, major: false, height: surface(t.pos), kind: 'note', size: t.pop })
      }
    }
    return out
  }

  /**
   * The works of the peoples in the window: fields, irrigation, terraces and industry around
   * the towns that have the technology for them, and the dams they built. The simulation
   * applies them to the land every frame (worksShader).
   */
  works(origin: [number, number], n: number, extent: number): Work[] {
    const out: Work[] = []
    const civById = new Map(this.civs.map((c) => [c.id, c]))
    let industries = 0
    let dams = 0
    for (const t of this.towns) {
      const civ = civById.get(t.civ)
      if (!civ) continue
      let kind = 0
      if (civ.tech >= TECH_FARMS && t.pop >= 0.3) kind |= 1
      if (civ.tech >= TECH_TERRACES && t.pop >= 0.6) kind |= 2
      if (civ.tech >= TECH_INDUSTRY && t.pop >= 0.5) {
        kind |= 4
        industries++
      }
      if (civ.tech >= TECH_IRRIGATION && t.pop >= 0.3 && t.needs.waterNear) kind |= 16
      if (t.pop >= 0.7) kind |= 32
      const uv = this.inWindow(t.pos, origin, n, extent)
      if (kind && uv && out.length < MAX_WORKS) {
        out.push({ uv, radius: (0.012 + 0.022 * t.pop) / extent, kind, strength: civ.tech, size: t.pop })
      }
      if (t.dam) {
        dams++
        const duv = this.inWindow(t.dam, origin, n, extent)
        if (duv && out.length < MAX_WORKS) {
          out.push({ uv: duv, radius: DAM_HALF / extent, kind: 8, strength: t.damDir[0], size: t.damDir[1], crest: t.damCrest })
        }
      }
    }
    this.industryCount = industries
    this.damCount = dams
    return out
  }

  /**
   * The political map over the window: per cell (TERRITORY_N per side, row-major from the
   * window's top-left), 0 for no one's land, or the owner's colour index + 1 in the low
   * 4 bits and, from bit 4, one bit per colour the owner is at war with. Redrawn at most
   * every half simulated second; the same array comes back in between.
   */
  territory(origin: [number, number], n: number, extent: number): Uint32Array<ArrayBuffer> | null {
    if (!this.field || !this.towns.length) return null
    const key = `${origin[0]},${origin[1]},${n},${extent}`
    if (key === this.territoryKey && this.time - this.territoryTime < TERRITORY_EVERY) return this.territoryMap
    this.territoryKey = key
    this.territoryTime = this.time
    const T = TERRITORY_N
    const map = this.territoryMap
    const strength = new Float32Array(T * T)
    map.fill(0)
    const civById = new Map(this.civs.map((c) => [c.id, c]))
    const warMask = new Map<number, number>()
    for (const civ of this.civs) {
      let mask = 0
      for (const w of this.wars) {
        const other = w.a === civ.id ? w.b : w.b === civ.id ? w.a : -1
        const o = other >= 0 ? civById.get(other) : undefined
        if (o) mask |= 1 << o.color
      }
      warMask.set(civ.id, mask)
    }
    const field = this.field
    const cellsPerUnit = T / extent
    for (const t of this.towns) {
      const civ = civById.get(t.civ)
      if (!civ) continue
      const land = (LAND_MIN + (LAND_MAX - LAND_MIN) * t.pop) * (0.8 + 0.4 * civ.tech)
      const cx = (t.pos[0] / extent - origin[0] / n) * T
      const cy = (t.pos[1] / extent - origin[1] / n) * T
      const r = land * cellsPerUnit
      const x0 = Math.max(0, Math.floor(cx - r))
      const x1 = Math.min(T - 1, Math.ceil(cx + r))
      const y0 = Math.max(0, Math.floor(cy - r))
      const y1 = Math.min(T - 1, Math.ceil(cy + r))
      const weight = (0.3 + t.pop) * (1 + civ.tech)
      const value = (civ.color + 1) | ((warMask.get(civ.id) ?? 0) << 4)
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const dx = (x + 0.5 - cx) / r
          const dy = (y + 0.5 - cy) / r
          const d2 = dx * dx + dy * dy
          if (d2 > 1) continue
          const s = weight * (1 - d2)
          const i = y * T + x
          if (s <= strength[i]) continue
          strength[i] = s
          map[i] = value
        }
      }
    }
    // no one's land on open water or lava
    for (let y = 0; y < T; y++) {
      for (let x = 0; x < T; x++) {
        const i = y * T + x
        if (!map[i]) continue
        const pos: [number, number] = [((x + 0.5) / T + origin[0] / n) * extent, ((y + 0.5) / T + origin[1] / n) * extent]
        const cell = this.cellAt(field, pos, extent)
        if (!cell || cell.water > 0.002 || cell.lava > 0.0002) map[i] = 0
      }
    }
    return map
  }

  // ---- reports ----------------------------------------------------------------------------

  /** The town nearest a world position, within a short distance, as a report; null if none. */
  townAt(pos: [number, number], within = 0.022): TownReport | null {
    let best: Town | null = null
    let bestD = within
    for (const t of this.towns) {
      const d = dist(t.pos, pos)
      if (d < bestD) {
        bestD = d
        best = t
      }
    }
    return best ? this.report(best) : null
  }

  /** A town's report by id; null once it is gone. */
  reportOf(id: number | null): TownReport | null {
    if (id === null) return null
    const t = this.towns.find((x) => x.id === id)
    return t ? this.report(t) : null
  }

  private report(t: Town): TownReport {
    const civ = this.civById(t.civ)
    const n = t.needs
    const tech = civ?.tech ?? 0
    const works = {
      farms: tech >= TECH_FARMS && t.pop >= 0.3,
      terraces: tech >= TECH_TERRACES && t.pop >= 0.6,
      industry: tech >= TECH_INDUSTRY && t.pop >= 0.5,
      dam: t.dam !== null,
      irrigation: tech >= TECH_IRRIGATION && t.pop >= 0.3 && n.waterNear,
    }
    let status: string
    if (n.burning) status = 'queimando na lava'
    else if (n.flooded) status = 'afogada pela enchente'
    else if (n.frozen) status = 'congelada sob o gelo'
    else if (n.plague) status = 'assolada pela peste'
    else if (n.hardship > 0.03) {
      const cold = n.temperature < 8
      status = `sofrendo com o ${cold ? 'frio' : 'calor'}: precisa de mais adaptação ou tecnologia`
    } else if (n.famine) status = 'passando fome: o celeiro está vazio'
    else if (n.moist < 0.3) status = 'secando: falta umidade (rio, lago ou ar úmido)'
    else if (n.food < 0.3) status = 'terra pobre: pouco pasto e água'
    else if (t.pop >= n.capacity - 0.03) status = 'estável, no limite do que a terra dá'
    else if (n.rate > 0) status = 'crescendo'
    else status = 'encolhendo'
    // the trend: how many years in a row it has grown or shrunk
    const h = t.history
    let years = 0
    let sign = 0
    for (let k = h.length - 1; k > 0; k--) {
      const d = h[k] - h[k - 1]
      const s = d > 0.005 ? 1 : d < -0.005 ? -1 : 0
      if (years === 0) sign = s
      if (s !== sign || s === 0) break
      years++
    }
    const trend = years === 0 ? 'população parada nos últimos anos' : `${sign > 0 ? 'crescendo' : 'encolhendo'} há ${years} ano${years > 1 ? 's' : ''}`
    const adaptMean = civ ? (civ.adapt.cold + civ.adapt.heat + civ.adapt.dry + civ.adapt.flood) / 4 : 0
    return {
      id: t.id,
      name: t.name,
      pos: [t.pos[0], t.pos[1]],
      civ: civ?.name ?? '—',
      color: civ?.color ?? 0,
      people: Math.round(t.pop * 200),
      pop: t.pop,
      tech,
      adapt: adaptMean,
      age: t.age,
      capital: civ?.capital === t.id,
      needs: n,
      works,
      status,
      trend,
      monument: MONUMENTS[t.monument],
      faith: civ ? FAITHS[civ.faith] : '',
    }
  }

  /** A line for the chronicle from outside the life (the engine's eruptions, strikes and quakes). */
  chronicle(text: string, major = false, pos?: [number, number]) {
    this.log(text, 0, major, pos)
  }

  stats(): LifeStats {
    let herds = 0
    for (const c of this.creatures) if (c.dead <= 0) herds++
    const people = (t: Town) => Math.round(t.pop * 200)
    const trade = this.tradePartners()
    const civs: CivReport[] = this.civs
      .map((c) => {
        const towns = this.towns.filter((t) => t.civ === c.id)
        const total = towns.reduce((s, t) => s + people(t), 0)
        const capital = towns.find((t) => t.id === c.capital)
        return {
          id: c.id,
          name: c.name,
          color: c.color,
          towns: towns.length,
          people: total,
          tech: c.tech,
          adapt: (c.adapt.cold + c.adapt.heat + c.adapt.dry + c.adapt.flood) / 4,
          adapts: { ...c.adapt },
          atWar: this.wars.some((w) => w.a === c.id || w.b === c.id),
          era: ERAS[c.era].name,
          power: Math.round(total * (0.5 + c.tech)),
          allies: [...c.allies.keys()].map((id) => this.civById(id)?.name ?? '').filter(Boolean),
          capital: capital ? `${people(capital)} pessoas` : '—',
          famine: towns.length ? towns.filter((t) => t.needs.famine).length / towns.length : 0,
          trade: trade.get(c.id) ?? 0,
          faith: FAITHS[c.faith],
          monuments: towns.filter((t) => t.monument > 0).length,
          plague: towns.length ? towns.filter((t) => t.plague > 0).length / towns.length : 0,
        }
      })
      .sort((a, b) => b.power - a.power)
    const fauna: FaunaReport[] = SPECIES.map((sp, k) => ({
      name: sp.name,
      herds: this.creatures.filter((c) => c.dead <= 0 && c.species === k).length,
      extinct: this.extinct.has(k),
    })).filter((f) => f.herds > 0 || f.extinct)
    const civById = new Map(this.civs.map((c) => [c.id, c]))
    const wars: WarReport[] = []
    for (const w of this.wars) {
      const a = civById.get(w.a)
      const b = civById.get(w.b)
      if (!a || !b) continue
      wars.push({ a: a.name, aColor: a.color, b: b.name, bColor: b.color, age: w.age, battles: w.battles, taken: w.taken, cause: w.cause })
    }
    return {
      herds,
      villages: this.towns.length,
      people: this.towns.reduce((s, t) => s + people(t), 0),
      year: this.year,
      industries: this.industryCount,
      dams: this.damCount,
      civs,
      wars,
      events: this.events.slice().reverse(),
      history: this.history,
      lineage: this.lineage,
      ending: this.ending,
      fauna,
      ruins: this.ruins.length,
      monuments: this.towns.filter((t) => t.monument > 0).length,
      routes: this.routeList.length,
      plagued: this.towns.filter((t) => t.plague > 0).length,
    }
  }
}
