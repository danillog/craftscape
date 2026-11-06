// The powers the 3D game shares with the 2D one: wildfire, hurricanes, the earthquake power
// with its aftershocks, tsunamis and rifts, nuclear blasts with their fallout, and the
// cataclysm. Everything here is kept in world units, so it stays where it is when the
// simulated window slides; the engine asks every frame for what to do to the land (acts),
// what to draw (markers, labels) and what to hand the weather (storms).

import type { Life, LifeLabel, LifeMarker } from './life'
import type { BoundaryKind } from './plates'
import type { Act, Impact, Quake, Storm, Vent } from './simulation'

type Vec = [number, number]

/** What the powers read of the land at a place (from the engine's last read-back). */
export interface PowerCell {
  water: number
  vegetation: number
  /** Soil water, as a share of what the soil holds. */
  moisture: number
  snow: number
  /** °C. */
  temperature: number
  /** Relative humidity of the air, 0–1. */
  humidity: number
  lava: number
}

export type PowerSound = 'boom' | 'rumble' | 'thunder' | 'whoosh' | 'siren'

/** What the powers need from the engine. */
export interface PowersHost {
  cell(pos: Vec): PowerCell | null
  /** The wind: the direction it blows towards (radians; 0 east, π/2 north) and its pace in world units per simulated second. */
  wind(): { angle: number; speed: number }
  /** The plate boundary near a place, if any: the direction across it (radians) and its kind. */
  fault(pos: Vec): { normal: number; kind: BoundaryKind } | null
  toast(text: string): void
  chronicle(text: string, major: boolean, pos?: Vec): void
  /** A dust cloud over a region (°C of shade, radius in world units) and dust over the whole planet (°C). */
  dust(pos: Vec, cooling: number, radius: number, planet: number): void
  sound(kind: PowerSound): void
  /** The peoples, or null with the life off. */
  life(): Life | null
}

export interface PowersReport {
  /** Patches of land burning. */
  fires: number
  hurricanes: { name: string; category: number }[]
  /** Places still radioactive. */
  fallout: number
  /** °C a cataclysm still adds to the whole planet (0: none). */
  cataclysm: number
}

/** Side of a patch of fire (world units). */
const FIRE_CELL = 0.012
const MAX_FIRES = 500
/** Simulated seconds between two steps of the fire. */
const FIRE_TICK = 0.5
/** Simulated seconds before a burnt patch has grown enough to burn again. */
const FIRE_REST = 90
/** Fire acts and flame markers handed over per frame, at most. */
const FIRE_ACTS = 30
const FIRE_MARKERS = 60
/** Plants burnt per frame in a burning patch, and the °C its air gains per frame. */
const FIRE_BURN = 0.004
const FIRE_HEAT = 0.2

const MAX_HURRICANES = 2
/** °C of sea a hurricane needs to grow, and below which it dies even at sea. */
const HURRICANE_WARM = 17
const HURRICANE_COLD = 11
const HURRICANE_NAMES = [
  'Ana', 'Bento', 'Carla', 'Davi', 'Elisa', 'Fábio', 'Gabi', 'Heitor', 'Iara', 'João', 'Karina',
  'Lucas', 'Marina', 'Nuno', 'Olga', 'Paulo', 'Quitéria', 'Rui', 'Sofia', 'Tiago', 'Úrsula', 'Vítor',
]

/** Simulated seconds a mushroom cloud stands, and the half-life of the fallout. */
const BLAST_LIFE = 14
const FALLOUT_HALF_LIFE = 150
const MAX_FALLOUT = 12
/** Radius of the burnt land round a blast and of its fallout (world units). */
const BLAST_RADIUS = 0.05
const FALLOUT_RADIUS = 0.07

/** A cataclysm: °C it adds at first, the simulated seconds the crust stays molten, and the half-life of the heat after. */
const CATACLYSM_HEAT = 60
const CATACLYSM_MOLTEN = 25
const CATACLYSM_HALF_LIFE = 45
/** Earthquakes of this magnitude or more count towards a cataclysm: three with no smaller one between and within this many simulated seconds. */
const CATACLYSM_MAGNITUDE = 9
const CATACLYSM_WINDOW = 240

interface Burning {
  x: number
  y: number
  /** Simulated seconds of fuel left. */
  left: number
}

interface Hurricane {
  name: string
  pos: Vec
  /** 0–1: category 1 at 0 to category 5 at 1. */
  strength: number
  age: number
  /** It has reached land with towns and been told. */
  told: boolean
  landfall: boolean
  category: number
  /** When it may batter the towns under it again. */
  nextHit: number
  /** Simulated seconds it has spent outside the simulated window (it is forgotten after a while). */
  away: number
}

interface Blast {
  pos: Vec
  age: number
}

interface Fallout {
  pos: Vec
  /** 1 fresh, fading. */
  strength: number
}

interface Later {
  at: number
  run: () => void
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v))
const smooth = (a: number, b: number, v: number) => {
  const t = clamp01((v - a) / (b - a))
  return t * t * (3 - 2 * t)
}
const fireKey = (x: number, y: number) => (y + 32768) * 65536 + (x + 32768)
const comma = (v: number, digits = 1) => v.toFixed(digits).replace('.', ',')

export class Powers {
  private readonly host: PowersHost
  /** Simulated seconds since the terrain was made. */
  private clock = 0
  private readonly fires = new Map<number, Burning>()
  /** Burnt patches: when each may burn again. */
  private readonly burnt = new Map<number, number>()
  private fireClock = 0
  private fireTold = false
  private fireTurn = 0
  private hurricanes: Hurricane[] = []
  private named = 0
  private blasts: Blast[] = []
  private fallouts: Fallout[] = []
  /** What waits for a frame of its own: one fault slip, one crater and one vent per frame. */
  private quakes: { pos: Vec; normal: number; radius: number; slip: number; rubble: number }[] = []
  private impacts: { pos: Vec; radius: number; depth: number }[] = []
  private vents: { pos: Vec; radius: number; delta: number }[] = []
  /** Acts that happen once (a tsunami, a blast), handed over with the next frame. */
  private once: { pos: Vec; radius: number; kind: Act['kind']; values: Act['values'] }[] = []
  private later: Later[] = []
  /** When the last big earthquakes of the power struck (see CATACLYSM_MAGNITUDE). */
  private bigQuakes: number[] = []
  /** A cataclysm under way: simulated seconds since it began, and the °C it still adds. */
  private cataclysmAge = -1
  private cataclysmHeat = 0

  constructor(host: PowersHost) {
    this.host = host
  }

  /** A new terrain: nothing burns, blows or glows any more. */
  reset() {
    this.clock = 0
    this.fires.clear()
    this.burnt.clear()
    this.fireClock = 0
    this.fireTold = false
    this.hurricanes = []
    this.blasts = []
    this.fallouts = []
    this.quakes = []
    this.impacts = []
    this.vents = []
    this.once = []
    this.later = []
    this.bigQuakes = []
    this.cataclysmAge = -1
    this.cataclysmHeat = 0
  }

  /** °C the powers add to the whole planet right now (a cataclysm). */
  get heat() {
    return this.cataclysmHeat
  }

  report(): PowersReport {
    return {
      fires: this.fires.size,
      hurricanes: this.hurricanes.map((h) => ({ name: h.name, category: h.category })),
      fallout: this.fallouts.length,
      cataclysm: this.cataclysmHeat,
    }
  }

  // ---- fire ------------------------------------------------------------------------------

  private fuelAt(x: number, y: number): number {
    const cell = this.host.cell([(x + 0.5) * FIRE_CELL, (y + 0.5) * FIRE_CELL])
    if (!cell || cell.water > 0.0005 || cell.snow > 0.0005 || cell.lava > 0.0002 || cell.vegetation < 0.12) return 0
    return cell.vegetation
  }

  /** The fire power: lights the plants in a disc (world units). Returns the patches lit. */
  ignite(pos: Vec, radius: number): number {
    const r = Math.max(1, Math.ceil(radius / FIRE_CELL))
    const cx = Math.floor(pos[0] / FIRE_CELL)
    const cy = Math.floor(pos[1] / FIRE_CELL)
    let lit = 0
    for (let y = cy - r; y <= cy + r; y++) {
      for (let x = cx - r; x <= cx + r; x++) {
        if ((x - cx) ** 2 + (y - cy) ** 2 > r * r || this.fires.size >= MAX_FIRES) continue
        const key = fireKey(x, y)
        if (this.fires.has(key)) continue
        const fuel = this.fuelAt(x, y)
        if (fuel <= 0) continue
        this.fires.set(key, { x, y, left: 5 + 12 * fuel })
        lit++
      }
    }
    return lit
  }

  /** Puts the fire out in a disc (world units). Returns the patches put out. */
  extinguish(pos: Vec, radius: number): number {
    let out = 0
    for (const [key, f] of this.fires) {
      if (Math.hypot((f.x + 0.5) * FIRE_CELL - pos[0], (f.y + 0.5) * FIRE_CELL - pos[1]) > radius + FIRE_CELL) continue
      this.fires.delete(key)
      this.burnt.set(key, this.clock + FIRE_REST)
      out++
    }
    return out
  }

  private stepFire() {
    const wind = this.host.wind()
    const wx = Math.cos(wind.angle)
    const wy = Math.sin(wind.angle)
    for (const [key, f] of [...this.fires]) {
      const cell = this.host.cell([(f.x + 0.5) * FIRE_CELL, (f.y + 0.5) * FIRE_CELL])
      // rain (air close to saturated) puts it out several times faster
      const wet = cell ? smooth(0.8, 1, cell.humidity) : 0
      f.left -= FIRE_TICK * (1 + 5 * wet)
      if (f.left <= 0 || !cell || cell.water > 0.0005) {
        this.fires.delete(key)
        this.burnt.set(key, this.clock + FIRE_REST)
        continue
      }
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if ((!dx && !dy) || this.fires.size >= MAX_FIRES) continue
          const nk = fireKey(f.x + dx, f.y + dy)
          if (this.fires.has(nk) || (this.burnt.get(nk) ?? 0) > this.clock) continue
          const fuel = this.fuelAt(f.x + dx, f.y + dy)
          if (fuel <= 0) continue
          const there = this.host.cell([(f.x + dx + 0.5) * FIRE_CELL, (f.y + dy + 0.5) * FIRE_CELL])
          if (!there) continue
          const len = Math.hypot(dx, dy)
          const along = (dx * wx + dy * wy) / len
          // it runs with the wind and creeps against it; wet soil and damp air hold it back
          const push = 1 + 1.6 * Math.max(0, along) - 0.5 * Math.max(0, -along)
          const dry = Math.max(0.15, Math.min(1, 1.15 - there.moisture)) * (1 - 0.85 * smooth(0.75, 1, there.humidity))
          if (Math.random() < (0.17 * fuel * dry * push * FIRE_TICK) / len) {
            this.fires.set(nk, { x: f.x + dx, y: f.y + dy, left: 5 + 12 * fuel })
          }
        }
      }
    }
    for (const [key, until] of this.burnt) if (until <= this.clock) this.burnt.delete(key)
    if (this.fires.size >= 40 && !this.fireTold) {
      this.fireTold = true
      const first = this.fires.values().next().value as Burning
      const pos: Vec = [(first.x + 0.5) * FIRE_CELL, (first.y + 0.5) * FIRE_CELL]
      this.host.toast('O incêndio se alastra: o vento empurra o fogo, só a chuva ou a falta de mato o param')
      this.host.chronicle('Um grande incêndio corre pela mata.', true, pos)
    }
    if (!this.fires.size) this.fireTold = false
  }

  // ---- hurricanes ------------------------------------------------------------------------

  /** The hurricane power: one is born over the sea at a place, if the water is warm enough. */
  hurricane(pos: Vec): boolean {
    const cell = this.host.cell(pos)
    if (!cell || cell.water < 0.004) {
      this.host.toast('Um furacão só nasce no mar')
      return false
    }
    if (cell.temperature < HURRICANE_WARM) {
      this.host.toast(`Mar frio demais (${comma(cell.temperature, 0)} °C): um furacão precisa de água a ${HURRICANE_WARM} °C ou mais`)
      return false
    }
    if (this.hurricanes.length >= MAX_HURRICANES) this.hurricanes.shift()
    const name = HURRICANE_NAMES[this.named++ % HURRICANE_NAMES.length]
    this.hurricanes.push({ name, pos: [pos[0], pos[1]], strength: 0.05, age: 0, told: false, landfall: false, category: 1, nextHit: 0, away: 0 })
    this.host.toast(`Nasce o furacão ${name}: cresce sobre o mar quente, anda com o vento e morre em terra`)
    this.host.chronicle(`Uma tempestade tropical ganha nome: ${name}.`, false, pos)
    this.host.sound('whoosh')
    return true
  }

  private stepHurricanes(dt: number) {
    if (!this.hurricanes.length) return
    const wind = this.host.wind()
    const life = this.host.life()
    for (const h of this.hurricanes) {
      h.age += dt
      const cell = this.host.cell(h.pos)
      h.away = cell ? 0 : h.away + dt
      const sea = !!cell && cell.water >= 0.004
      if (cell && sea && cell.temperature >= HURRICANE_WARM) {
        h.strength += dt * 0.012 * Math.min(2, (cell.temperature - HURRICANE_WARM + 3) / 6)
      } else if (cell && sea) {
        h.strength -= dt * (cell.temperature < HURRICANE_COLD ? 0.03 : 0.008)
      } else if (cell) {
        // over land it runs out of warm water
        h.strength -= dt * 0.035
      }
      h.strength = Math.min(1, h.strength)
      // carried by the wind at a quarter of its pace, drifting towards the pole (north) as it grows old
      const pace = wind.speed * 0.25 * dt
      h.pos = [h.pos[0] + Math.cos(wind.angle) * pace, h.pos[1] + Math.sin(wind.angle) * pace + 0.0006 * dt * Math.min(1, h.age / 120)]
      const category = 1 + Math.min(4, Math.floor(Math.max(0, h.strength) * 5))
      if (category > h.category && category >= 3) {
        this.host.toast(`O furacão ${h.name} chega à categoria ${category}`)
        if (category === 5) this.host.chronicle(`O furacão ${h.name} chega à categoria 5: o maior que há.`, true, h.pos)
      }
      h.category = category
      if (cell && !sea) {
        if (!h.landfall) {
          h.landfall = true
          this.host.toast(`O furacão ${h.name} chega à terra na categoria ${h.category}: vento e chuva torrencial, e ele começa a morrer`)
          this.host.sound('thunder')
        }
        // its wind and rain batter the towns under it, once every few simulated seconds
        if (life && this.clock >= h.nextHit) {
          h.nextHit = this.clock + 6
          const hit = life.windstorm(h.pos, this.hurricaneRadius(h), 0.2 + 0.8 * Math.max(0, h.strength), h.name, !h.told)
          if (hit) h.told = true
        }
      }
    }
    for (const h of this.hurricanes) {
      if (h.strength <= 0 && h.age > 5) this.host.toast(`O furacão ${h.name} se desfaz`)
    }
    // one that left the simulated window for good is forgotten
    this.hurricanes = this.hurricanes.filter((h) => (h.strength > 0 || h.age <= 5) && h.away < 20)
  }

  private hurricaneRadius(h: Hurricane) {
    return 0.07 + 0.09 * Math.max(0, h.strength)
  }

  // ---- earthquakes -----------------------------------------------------------------------

  /** Whether a place is on a low coast: land with the sea close by. */
  private coastal(pos: Vec): boolean {
    const here = this.host.cell(pos)
    if (!here || here.water >= 0.004) return false
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2
      const c = this.host.cell([pos[0] + Math.cos(a) * 0.035, pos[1] + Math.sin(a) * 0.035])
      if (c && c.water >= 0.004) return true
    }
    return false
  }

  /** A fault slips at a place with this magnitude (queued for a frame of its own); a tsunami if it is under the sea. */
  private shock(pos: Vec, magnitude: number, tell: boolean) {
    // each step of magnitude: about 3× the slip and the size of the shaken area (capped, the land is small)
    const scale = 10 ** ((magnitude - 6) / 2)
    const fault = this.host.fault(pos)
    const kind = fault?.kind ?? (Math.random() < 0.5 ? 'convergent' : 'divergent')
    const slip = kind === 'convergent' ? 0.0006 : kind === 'divergent' ? -0.0006 : 0
    const radius = Math.min(0.06 * scale, 0.9)
    this.quakes.push({
      pos,
      normal: fault?.normal ?? Math.random() * Math.PI,
      radius,
      slip: slip * Math.min(scale, 25),
      rubble: 0.0008 * Math.min(scale, 15),
    })
    this.host.life()?.shake(pos, radius * 0.8, clamp01((magnitude - 5) / 4))
    this.tsunami(pos, magnitude, tell)
  }

  /**
   * A tsunami, if an earthquake of this magnitude (6.5 or more) struck under the sea: the
   * water is thrown up in a ring round the epicentre and the towns on the low coasts near
   * it are flooded. Returns whether there was one.
   */
  tsunami(pos: Vec, magnitude: number, tell: boolean): boolean {
    const cell = this.host.cell(pos)
    if (!cell || cell.water < 0.004 || magnitude < 6.5) return false
    const reach = 0.08 + 0.05 * (magnitude - 6.5)
    this.once.push({ pos, radius: reach, kind: 'tsunami', values: [Math.min(0.0015 * 3 ** (magnitude - 6.5), 0.02), 0, 0, 0] })
    const life = this.host.life()
    const towns = life ? life.flood(pos, reach * 4, (p) => this.coastal(p)) : 0
    if (tell) {
      this.host.toast(`Tsunami! O mar recua e volta numa onda${towns ? `: ${towns} ${towns === 1 ? 'cidade atingida' : 'cidades atingidas'}` : ''}`)
      this.host.chronicle('O fundo do mar se move: um tsunami corre para as costas.', true, pos)
      this.host.sound('whoosh')
    }
    return true
  }

  /**
   * The earthquake power: a quake of this magnitude here and, over the next simulated
   * minute, its aftershocks. From 8.5 the land splits (a rift drops and fissures pour
   * lava for a while); three of 9 or more in a row set off a cataclysm.
   */
  quake(pos: Vec, magnitude: number) {
    this.host.sound('rumble')
    this.host.toast(`Terremoto de magnitude ${comma(magnitude)}${magnitude >= 8.5 ? ': a terra racha' : ''}`)
    // after the notice: a tsunami's own notice is the one that stays
    this.shock(pos, magnitude, true)
    if (magnitude >= 6.5) this.host.chronicle(`Um terremoto de magnitude ${comma(magnitude)} sacode a terra.`, magnitude >= 7, pos)
    const reach = Math.min(0.06 * 10 ** ((magnitude - 6) / 2), 0.5)
    const aftershocks = Math.round((magnitude - 5) * 1.5)
    for (let k = 0; k < aftershocks; k++) {
      const a = Math.random() * Math.PI * 2
      const r = reach * 0.5 * Math.random()
      const at: Vec = [pos[0] + Math.cos(a) * r, pos[1] + Math.sin(a) * r]
      const m = Math.max(4.5, magnitude - 1.2 - 1.5 * Math.random())
      this.later.push({ at: this.clock + 4 + 50 * Math.random(), run: () => this.shock(at, m, false) })
    }
    if (magnitude >= 8.5) this.rift(pos)
    if (magnitude >= CATACLYSM_MAGNITUDE) {
      this.bigQuakes = [...this.bigQuakes.filter((t) => this.clock - t < CATACLYSM_WINDOW), this.clock]
      if (this.bigQuakes.length >= 3) {
        this.bigQuakes = []
        this.cataclysm()
      } else {
        const left = 3 - this.bigQuakes.length
        this.host.toast(`Terremoto de magnitude ${comma(magnitude)}: a crosta range. Mais ${left} desse tamanho em seguida e o planeta se desfaz`)
      }
    } else {
      this.bigQuakes = []
    }
  }

  /** The land splits along the fault: a strip drops and fissures along it pour lava for a while. */
  private rift(pos: Vec) {
    const fault = this.host.fault(pos)
    const normal = fault?.normal ?? Math.random() * Math.PI
    this.quakes.push({ pos, normal, radius: 0.5, slip: -0.012, rubble: 0.004 })
    // the fissures open along the fault (across its normal)
    const ax = -Math.sin(normal)
    const ay = Math.cos(normal)
    for (let k = -2; k <= 2; k++) {
      const at: Vec = [pos[0] + ax * k * 0.07, pos[1] + ay * k * 0.07]
      const strength = 0.35 + 0.3 * Math.random()
      this.later.push({ at: this.clock + 1 + Math.abs(k) * 1.5, run: () => this.vents.push({ pos: at, radius: 0.012, delta: strength }) })
      this.later.push({ at: this.clock + 40 + 30 * Math.random(), run: () => this.vents.push({ pos: at, radius: 0.012, delta: -strength }) })
    }
    this.host.chronicle('A terra se parte: uma fenda se abre e a lava sobe por ela.', true, pos)
  }

  // ---- nuclear blasts --------------------------------------------------------------------

  /** A warhead goes off at a place: crater, burnt land, the mushroom, fallout and soot in the sky. */
  detonate(pos: Vec) {
    this.impacts.push({ pos, radius: 0.012, depth: 0.0025 })
    this.once.push({ pos, radius: BLAST_RADIUS, kind: 'blast', values: [1, 1, 45, 0] })
    this.blasts.push({ pos, age: 0 })
    this.fallouts = [...this.fallouts, { pos, strength: 1 }].slice(-MAX_FALLOUT)
    this.host.dust(pos, 7, 0.3, 0.6)
    this.host.sound('boom')
  }

  /**
   * The nuclear power: on a town, its people launches at its enemy (the gods hand the
   * bomb to a people that has none); anywhere else one bomb falls there.
   */
  nuke(pos: Vec) {
    const life = this.host.life()
    const told = life ? life.godNuke(pos) : null
    if (told) {
      this.host.toast(told)
      this.host.sound('siren')
      return
    }
    life?.blast(pos)
    this.detonate(pos)
    this.host.toast('☢ Uma bomba atômica: terra queimada, radiação por anos e fuligem que esfria o planeta')
    if (!life) this.host.chronicle('☢ Uma bomba atômica explode.', true, pos)
  }

  /** The warheads the peoples launched since last frame land one after the other. */
  private takeStrikes() {
    const life = this.host.life()
    if (!life) return
    const strikes = life.takeStrikes()
    if (!strikes.length) return
    strikes.forEach((s, k) => this.later.push({ at: this.clock + 0.6 * k, run: () => this.detonate(s.to) }))
    this.host.toast(`☢ Guerra nuclear: ${strikes.length} ${strikes.length === 1 ? 'ogiva a caminho' : 'ogivas a caminho'}`)
    this.host.sound('siren')
  }

  // ---- cataclysm -------------------------------------------------------------------------

  /** The planet's crust melts: the seas boil, everything alive burns, and it cools again as another land. */
  cataclysm() {
    if (this.cataclysmAge >= 0) return
    this.cataclysmAge = 0
    this.cataclysmHeat = CATACLYSM_HEAT
    this.fires.clear()
    this.hurricanes = []
    this.host.life()?.cataclysm()
    this.host.toast('Cataclismo: a crosta do planeta derrete, os mares fervem e nada sobrevive')
    this.host.chronicle('O planeta se desfaz em fogo: a crosta derrete e os mares fervem.', true)
    this.host.sound('boom')
  }

  private stepCataclysm(dt: number) {
    if (this.cataclysmAge < 0) return
    this.cataclysmAge += dt
    if (this.cataclysmAge > CATACLYSM_MOLTEN) {
      this.cataclysmHeat *= 0.5 ** (dt / CATACLYSM_HALF_LIFE)
      if (this.cataclysmHeat < 0.5) {
        this.cataclysmHeat = 0
        this.cataclysmAge = -1
        this.host.toast('O planeta esfriou: a chuva volta a encher os mares e a vida pode recomeçar')
        this.host.chronicle('O fogo se apaga. A terra é outra, e está vazia.', true)
      }
    }
  }

  // ---- every frame -----------------------------------------------------------------------

  update(dt: number) {
    if (dt <= 0) return
    this.clock += dt
    this.takeStrikes()
    const due = this.later.filter((l) => l.at <= this.clock)
    if (due.length) {
      this.later = this.later.filter((l) => l.at > this.clock)
      for (const l of due) l.run()
    }
    this.fireClock += dt
    while (this.fireClock >= FIRE_TICK) {
      this.fireClock -= FIRE_TICK
      if (this.fires.size) this.stepFire()
    }
    this.stepHurricanes(dt)
    this.blasts = this.blasts.map((b) => ({ ...b, age: b.age + dt })).filter((b) => b.age < BLAST_LIFE)
    const fade = 0.5 ** (dt / FALLOUT_HALF_LIFE)
    this.fallouts = this.fallouts.map((f) => ({ ...f, strength: f.strength * fade })).filter((f) => f.strength > 0.05)
    this.stepCataclysm(dt)
  }

  /** What the powers do to the land this frame (`running`: the simulation is not paused). */
  acts(toUv: (p: Vec) => Vec, extent: number, running: boolean): Act[] {
    const out: Act[] = this.once.map((o) => ({ uv: toUv(o.pos), radius: o.radius / extent, kind: o.kind, values: o.values }))
    this.once = []
    if (!running) return out
    if (this.cataclysmAge >= 0 && this.cataclysmAge <= CATACLYSM_MOLTEN) {
      out.push({ uv: [0.5, 0.5], radius: 3, kind: 'cataclysm', values: [0.03, 0.08, 1.5, 0.00002] })
    }
    for (const f of this.fallouts) {
      out.push({ uv: toUv(f.pos), radius: FALLOUT_RADIUS / extent, kind: 'blast', values: [0.03 * f.strength, 0, 0, 0] })
    }
    // a share of the burning patches each frame, in turn, burning that much faster
    const fires = [...this.fires.values()]
    const n = Math.min(fires.length, FIRE_ACTS)
    const scale = n ? fires.length / n : 1
    for (let k = 0; k < n; k++) {
      const f = fires[(this.fireTurn + k) % fires.length]
      out.push({
        uv: toUv([(f.x + 0.5) * FIRE_CELL, (f.y + 0.5) * FIRE_CELL]),
        radius: (FIRE_CELL * 0.9) / extent,
        kind: 'fire',
        values: [FIRE_BURN * scale, Math.min(FIRE_HEAT * scale, 2), 0, 0],
      })
    }
    this.fireTurn = fires.length ? (this.fireTurn + n) % fires.length : 0
    return out
  }

  private inWindow(uv: Vec, margin = 0) {
    return uv[0] >= -margin && uv[1] >= -margin && uv[0] <= 1 + margin && uv[1] <= 1 + margin
  }

  /** The flames, mushroom clouds and hurricanes to draw. */
  markers(toUv: (p: Vec) => Vec): LifeMarker[] {
    const out: LifeMarker[] = []
    for (const h of this.hurricanes) {
      const uv = toUv(h.pos)
      if (this.inWindow(uv, 0.2)) out.push({ uv, kind: 'cyclone', size: this.hurricaneRadius(h), health: clamp01(h.strength), color: 0, tech: 0, flag: 0 })
    }
    for (const b of this.blasts) {
      const uv = toUv(b.pos)
      if (this.inWindow(uv)) out.push({ uv, kind: 'blast', size: 1 - b.age / BLAST_LIFE, health: 1, color: 0, tech: 0, flag: 0 })
    }
    const fires = [...this.fires.values()]
    const stride = Math.max(1, Math.ceil(fires.length / FIRE_MARKERS))
    for (let k = 0; k < fires.length; k += stride) {
      const f = fires[k]
      const uv = toUv([(f.x + 0.5) * FIRE_CELL, (f.y + 0.5) * FIRE_CELL])
      if (this.inWindow(uv)) out.push({ uv, kind: 'fire', size: clamp01(0.3 + f.left / 12), health: 1, color: 0, tech: 0, flag: 0 })
    }
    return out
  }

  /** The hurricanes' names over the map. */
  labels(toUv: (p: Vec) => Vec, height: (uv: Vec) => number): LifeLabel[] {
    const out: LifeLabel[] = []
    for (const h of this.hurricanes) {
      const uv = toUv(h.pos)
      if (!this.inWindow(uv)) continue
      out.push({ uv, text: `${h.name} · cat. ${h.category}`, color: 0, major: true, height: height(uv) + 0.04, kind: 'note', size: 1 })
    }
    return out
  }

  /** The hurricanes as the deep lows the weather takes. */
  storms(toUv: (p: Vec) => Vec, extent: number): Storm[] {
    return this.hurricanes.map((h) => ({
      uv: toUv(h.pos),
      strength: 0.6 + 0.9 * Math.max(0, h.strength),
      radius: (this.hurricaneRadius(h) * 1.3) / extent,
    }))
  }

  /** The next fault slip, crater or vent that waits for a frame, if any. */
  nextQuake(toUv: (p: Vec) => Vec): Quake | null {
    const q = this.quakes.shift()
    return q ? { uv: toUv(q.pos), normal: q.normal, radius: q.radius, slip: q.slip, rubble: q.rubble } : null
  }

  nextImpact(toUv: (p: Vec) => Vec): Impact | null {
    const m = this.impacts.shift()
    return m ? { uv: toUv(m.pos), radius: m.radius, depth: m.depth } : null
  }

  nextVent(toUv: (p: Vec) => Vec, extent: number): Vent | null {
    const v = this.vents.shift()
    return v ? { uv: toUv(v.pos), radius: v.radius / extent, delta: v.delta } : null
  }
}
