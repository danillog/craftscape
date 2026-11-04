import type { ClimateReport } from './settings'

export type ChallengeId = 'rain-desert' | 'forest' | 'cool' | 'ice-age' | 'inland-sea' | 'new-land' | 'garden'

/** A goal read off the climate analysis: progress is 0–1 against the report when it started. */
export interface Challenge {
  id: ChallengeId
  name: string
  goal: string
  hint: string
  progress(now: ClimateReport, start: ClimateReport): number
}

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
]

export const challengeById = (id: ChallengeId) => CHALLENGES.find((c) => c.id === id) ?? CHALLENGES[0]

/** The challenge being played: its baseline report (taken when it started), progress and whether it is done. */
export interface ChallengeState {
  id: ChallengeId
  start: ClimateReport | null
  progress: number
  done: boolean
}
