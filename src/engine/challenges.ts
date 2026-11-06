import type { ClimateReport } from './settings'

export type ChallengeId =
  | 'rain-desert' | 'forest' | 'cool' | 'ice-age' | 'inland-sea' | 'new-land' | 'garden'
  | 'modern' | 'peace' | 'sailors' | 'billion' | 'no-nukes' | 'brake' | 'thaw'

/** The peoples' measures the goals about them are read from (the engine works them out with each climate analysis). */
export interface WorldMetrics {
  /** The peoples alive, the people in all, the most advanced one's technology and how many are in the Modern era. */
  civs: number
  people: number
  maxTech: number
  modernCivs: number
  /** Years in a row with peoples and no war. */
  peaceYears: number
  /** Overseas colonies founded so far, nuclear wars ever, and the warming the industry caused (°C). */
  voyages: number
  nuclearWars: number
  civWarming: number
}

/** A goal read off the climate analysis and the peoples: progress is 0–1 against the report when it started. */
export interface Challenge {
  id: ChallengeId
  name: string
  goal: string
  hint: string
  progress(now: ClimateReport, start: ClimateReport, world: WorldMetrics): number
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v))

// biome indices: see BIOMES in the UI constants (biome() order in the render shader)
const forest = (r: ClimateReport) => r.biomes[3] + r.biomes[5] + r.biomes[8]
const desert = (r: ClimateReport) => r.biomes[2] + r.biomes[6]

export const CHALLENGES: Challenge[] = [
  {
    id: 'rain-desert',
    name: 'Chuva no deserto',
    goal: 'Reduzir o deserto a menos de 10% do mapa',
    hint: 'Ar úmido, massa de ar fria fixa a barlavento ou uma corrente quente no mar fazem chover.',
    progress: (now, start) => {
      const from = Math.max(desert(start), 0.1 + 0.05)
      return (from - desert(now)) / (from - 0.1)
    },
  },
  {
    id: 'forest',
    name: 'Reflorestar',
    goal: 'Florestas (taiga, temperada, tropical) em metade do mapa',
    hint: 'Chuva constante e temperatura amena. Solo ajuda; areia e rocha nua, não.',
    progress: (now) => forest(now) / 0.5,
  },
  {
    id: 'cool',
    name: 'Esfriar o planeta',
    goal: 'Baixar a temperatura média em 2 °C',
    hint: 'Massas de ar frias fixas, correntes frias, altas pressões... ou um meteoro.',
    progress: (now, start) => (start.meanTemp - now.meanTemp) / 2,
  },
  {
    id: 'ice-age',
    name: 'Era do gelo',
    goal: 'Gelo cobrindo 20% do mapa',
    hint: 'Frio e neve: o ar frio fixo no alto das montanhas vira geleira com o tempo.',
    progress: (now) => now.iceShare / 0.2,
  },
  {
    id: 'inland-sea',
    name: 'Mar interior',
    goal: 'Água cobrindo 15% do mapa',
    hint: 'Cave uma bacia, pinte água ou deixe a chuva encher um vale represado.',
    progress: (now) => now.waterShare / 0.15,
  },
  {
    id: 'new-land',
    name: 'Terra nova',
    goal: 'Lava escorrendo em 2% do mapa ao mesmo tempo',
    hint: 'Abra várias crateras com o pincel de vulcão, ou jogue um meteoro grande.',
    progress: (now) => now.lavaShare / 0.02,
  },
  {
    id: 'garden',
    name: 'Jardim',
    goal: 'Vegetação média acima de 40%',
    hint: 'Solo, chuva regular e nada de inundação. A vegetação segura o solo e devolve água ao ar.',
    progress: (now) => now.vegetation / 0.4,
  },
  {
    id: 'modern',
    name: 'Da pedra ao avião',
    goal: 'Leve um povo da Idade da Pedra à Era Moderna',
    hint: 'Povos crescem com comida e água. Abençoe cidades, inspire os sábios e evite as guerras.',
    progress: (_now, _start, world) => clamp01(world.maxTech / 0.92),
  },
  {
    id: 'peace',
    name: 'Paz mundial',
    goal: 'Mantenha três ou mais povos por 100 anos sem nenhuma guerra',
    hint: 'O poder Paz encerra as guerras de um povo. A fome e a falta de terra levam à guerra.',
    progress: (_now, _start, world) => (world.civs >= 3 ? clamp01(world.peaceYears / 100) : 0),
  },
  {
    id: 'sailors',
    name: 'Além-mar',
    goal: 'Funde 5 colônias do outro lado do mar',
    hint: 'Povos navegam a partir da Era Medieval, de cidades na costa. Ligue o oceano nas bordas ou comece no Arquipélago.',
    progress: (_now, _start, world) => clamp01(world.voyages / 5),
  },
  {
    id: 'billion',
    name: 'Mundo cheio',
    goal: 'Chegue a 10 000 pessoas no mundo',
    hint: 'Terras férteis, lavouras e irrigação sustentam mais gente. Uma área maior cabe mais cidades.',
    progress: (_now, _start, world) => clamp01(world.people / 10000),
  },
  {
    id: 'no-nukes',
    name: 'Sem botão vermelho',
    goal: 'Leve dois povos à Era Moderna sem nenhuma guerra nuclear',
    hint: 'Povos modernos em guerra longa podem apertar o botão. A Paz e as alianças evitam o pior.',
    progress: (_now, _start, world) => (world.nuclearWars > 0 ? 0 : clamp01(world.modernCivs / 2)),
  },
  {
    id: 'brake',
    name: 'Freio no aquecimento',
    goal: 'Chegue à Era Industrial sem passar de +1 °C de aquecimento industrial',
    hint: 'Indústrias aquecem o planeta. Pestes freiam o crescimento; o vulcão e o meteoro esfriam por um tempo.',
    progress: (_now, _start, world) => (world.civWarming > 1 ? 0 : clamp01(world.maxTech / 0.8)),
  },
  {
    id: 'thaw',
    name: 'Degelo',
    goal: 'Derreta o gelo até cobrir menos de 1% do mapa, com povos vivos',
    hint: 'Comece na Era glacial. O Sol (+) esquenta o planeta 1 °C por clique; mas cuidado, o mar sobe.',
    progress: (now, start, world) => {
      const from = Math.max(start.iceShare, 0.03)
      return world.civs ? clamp01((from - now.iceShare) / (from - 0.01)) : 0
    },
  },
]

const TROPHIES_KEY = 'craftscape.trophies'
/** The challenges ever completed in this browser (the trophies). */
export function loadTrophies(): string[] {
  try {
    const saved = JSON.parse(localStorage.getItem(TROPHIES_KEY) ?? '[]')
    return Array.isArray(saved) ? saved.filter((v) => typeof v === 'string') : []
  } catch {
    return []
  }
}
export function saveTrophies(ids: string[]) {
  try {
    localStorage.setItem(TROPHIES_KEY, JSON.stringify(ids))
  } catch {
    // storage unavailable: the trophies last only until the page closes
  }
}

export const challengeById = (id: ChallengeId) => CHALLENGES.find((c) => c.id === id) ?? CHALLENGES[0]

/** The challenge being played: its baseline report (taken when it started), progress and whether it is done. */
export interface ChallengeState {
  id: ChallengeId
  start: ClimateReport | null
  progress: number
  done: boolean
}
