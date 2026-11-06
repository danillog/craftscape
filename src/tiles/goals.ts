// What to play for in the 2D game: ready-made worlds (scenarios) and goals (challenges)
// read off the world's measures, each with its progress 0–1.

import type { WorldOptions } from './world'

/** The world's measures the goals are read from (the game works them out every few seconds). */
export interface Metrics {
  year: number
  /** Land masses of at least 300 tiles, and the biggest one's share of all the land. */
  continents: number
  biggestShare: number
  /** Shares of the land under forest, desert, snow; and the mean temperature. */
  forest: number
  desert: number
  snow: number
  meanTemp: number
  /** The peoples: how many, people in all, the most advanced one's technology and how many wars. */
  civs: number
  people: number
  maxTech: number
  wars: number
  /** Years in a row with peoples and no war. */
  peaceYears: number
  /** Overseas colonies founded so far, the warming the industry caused (°C) and the sea's rise (m). */
  voyages: number
  civWarming: number
  seaRise: number
  /** Towns standing. */
  towns: number
  /** Nuclear wars ever, and peoples in the Modern era now. */
  nuclearWars: number
  modernCivs: number
}

export interface Scenario {
  id: string
  name: string
  description: string
  world: Partial<WorldOptions>
  /** Suggested goal for it. */
  challenge?: string
}

export const SCENARIOS: Scenario[] = [
  { id: 'classic', name: 'Clássico', description: 'Dois ou três continentes, clima temperado, os povos começam do zero.', world: { islands: 0.3, temperature: 0, plateDrift: 1, seaLevel: 0 }, challenge: 'modern' },
  { id: 'pangaea', name: 'Pangeia', description: 'Um supercontinente só, com as placas prontas para parti-lo. Veja um oceano nascer.', world: { islands: 0, temperature: 0, plateDrift: 2.5, seaLevel: 0 }, challenge: 'breakup' },
  { id: 'archipelago', name: 'Arquipélago', description: 'Ilhas espalhadas num oceano grande: só quem navega se espalha.', world: { islands: 0.85, temperature: 2, plateDrift: 1 }, challenge: 'sailors' },
  { id: 'ice', name: 'Era do gelo', description: 'Um planeta frio, com geleiras descendo. Será que a vida aguenta?', world: { islands: 0.3, temperature: -9, plateDrift: 0.5 }, challenge: 'thaw' },
  { id: 'hot', name: 'Planeta quente', description: 'Calor e desertos. Os povos lutam por água.', world: { islands: 0.2, temperature: 8, windHumidity: 0.45, plateDrift: 0.5 }, challenge: 'green' },
  { id: 'young', name: 'Terra jovem', description: 'Placas rápidas, terremotos e vulcões: um mundo que não para quieto.', world: { islands: 0.5, temperature: 2, plateDrift: 4, earthquakes: true, volcanoes: true }, challenge: 'supercontinent' },
]

export interface Challenge {
  id: string
  name: string
  goal: string
  hint: string
  progress(now: Metrics, start: Metrics): number
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v))

export const CHALLENGES: Challenge[] = [
  {
    id: 'modern',
    name: 'Da pedra ao avião',
    goal: 'Leve um povo da Idade da Pedra à Era Moderna',
    hint: 'Povos crescem com comida e água. Abençoe cidades, inspire os sábios e evite as guerras.',
    progress: (now) => clamp01(now.maxTech / 0.92),
  },
  {
    id: 'peace',
    name: 'Paz mundial',
    goal: 'Mantenha três ou mais povos por 100 anos sem nenhuma guerra',
    hint: 'O poder Paz encerra as guerras de um povo. A fome e a falta de terra levam à guerra.',
    progress: (now) => (now.civs >= 3 ? clamp01(now.peaceYears / 100) : 0),
  },
  {
    id: 'sailors',
    name: 'Além-mar',
    goal: 'Funde 5 colônias do outro lado do mar',
    hint: 'Povos navegam a partir da Idade Medieval, de cidades na costa.',
    progress: (now) => clamp01(now.voyages / 5),
  },
  {
    id: 'breakup',
    name: 'Nasce um oceano',
    goal: 'Veja o supercontinente se partir em três continentes',
    hint: 'Aumente a velocidade das placas no painel Mundo, ou arraste as placas com a ferramenta Placas (G) para lados opostos.',
    progress: (now, start) => clamp01((now.continents - Math.min(start.continents, 1)) / (3 - Math.min(start.continents, 1))),
  },
  {
    id: 'supercontinent',
    name: 'Supercontinente',
    goal: 'Junte 80% da terra num único continente',
    hint: 'Arraste as placas umas contra as outras com a ferramenta Placas (G). Onde colidem, nascem montanhas.',
    progress: (now, start) => clamp01((now.biggestShare - start.biggestShare) / Math.max(0.8 - start.biggestShare, 0.01)),
  },
  {
    id: 'green',
    name: 'Deserto verde',
    goal: 'Faça a floresta cobrir 40% da terra',
    hint: 'Chuva vem do ar úmido: pinte Chuva (4), crie baixas pressões (B) e esfrie o planeta com o Sol (−).',
    progress: (now, start) => clamp01((now.forest - Math.min(start.forest, 0.39)) / (0.4 - Math.min(start.forest, 0.39))),
  },
  {
    id: 'thaw',
    name: 'Degelo',
    goal: 'Derreta a neve até cobrir menos de 10% da terra, com povos vivos',
    hint: 'O Sol (+) esquenta o planeta 1 °C por clique. Mas cuidado: o mar sobe.',
    progress: (now, start) => (now.civs ? clamp01((Math.max(start.snow, 0.11) - now.snow) / (Math.max(start.snow, 0.11) - 0.1)) : 0),
  },
  {
    id: 'billion',
    name: 'Mundo cheio',
    goal: 'Chegue a 10 000 pessoas no mundo',
    hint: 'Terras férteis, lavouras e irrigação sustentam mais gente.',
    progress: (now) => clamp01(now.people / 10000),
  },
  {
    id: 'no-nukes',
    name: 'Sem botão vermelho',
    goal: 'Leve dois povos à Era Moderna sem nenhuma guerra nuclear',
    hint: 'Povos modernos em guerra longa podem apertar o botão. Paz (E) e alianças evitam o pior.',
    progress: (now) => (now.nuclearWars > 0 ? 0 : clamp01(now.modernCivs / 2)),
  },
  {
    id: 'cool',
    name: 'Freio no aquecimento',
    goal: 'Chegue à Era Industrial sem passar de +1 °C de aquecimento industrial',
    hint: 'Indústrias aquecem o planeta. Pragas e pestes freiam o crescimento; o vulcão e o meteoro esfriam por um tempo.',
    progress: (now) => (now.civWarming > 1 ? 0 : clamp01(now.maxTech / 0.8)),
  },
]

export const challengeById = (id: string | null) => CHALLENGES.find((c) => c.id === id) ?? null

const WELCOMED_KEY = 'craftscape2d.welcomed'
export const seenWelcome = () => {
  try {
    return localStorage.getItem(WELCOMED_KEY) === '1'
  } catch {
    return false
  }
}
export const rememberWelcome = () => {
  try {
    localStorage.setItem(WELCOMED_KEY, '1')
  } catch {
    // storage unavailable: the welcome just shows again next time
  }
}

