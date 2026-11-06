import type { Settings, TerrainShape } from './settings'

export type ScenarioId =
  | 'classic' | 'archipelago' | 'glacial' | 'desert' | 'rivers' | 'rainforest' | 'warming' | 'living' | 'pangaea' | 'young'

export interface Scenario {
  id: ScenarioId
  name: string
  tagline: string
  description: string
  /** Card gradient, top to bottom. */
  colors: [string, string]
  shape: TerrainShape
  /** Settings the scenario starts with (on top of the defaults). */
  settings: Partial<Settings>
  /** Volcanic vents opened on the highest peaks right after generating. */
  vents?: number
}

export const FLAT_SHAPE: TerrainShape = { continents: 0, continentScale: 0.55, offset: 0, relief: 1 }

export const SCENARIOS: Scenario[] = [
  {
    id: 'classic',
    name: 'Clássico',
    tagline: 'Montanhas, vales e chuva',
    description: 'O terreno original do Craftscape: relevo variado, clima temperado e rios que vão se formando.',
    colors: ['#3d7a4f', '#1c3326'],
    shape: FLAT_SHAPE,
    settings: {},
  },
  {
    id: 'archipelago',
    name: 'Arquipélago vulcânico',
    tagline: 'Ilhas, mar aberto e lava',
    description: 'Ilhas no meio do oceano com vulcões já em erupção. A lava escorre até o mar e vira rocha nova.',
    colors: ['#e0663a', '#123a5c'],
    shape: { continents: 0.1, continentScale: 1.7, offset: -0.05, relief: 0.85 },
    settings: { ocean: true, seaLevel: 0, temperature: 3, windHumidity: 0.8 },
    vents: 3,
  },
  {
    id: 'glacial',
    name: 'Era glacial',
    tagline: 'Geleiras descendo os vales',
    description: 'Frio intenso e montanhas altas. A neve compacta em gelo, as geleiras escorrem e raspam o vale.',
    colors: ['#cfe6ff', '#3b5873'],
    shape: { continents: 0, continentScale: 0.55, offset: 0.03, relief: 1.3 },
    settings: { temperature: -4, latitude: 24, windHumidity: 0.75 },
  },
  {
    id: 'desert',
    name: 'Deserto',
    tagline: 'Dunas que andam com o vento',
    description: 'Quente e seco. Pouca chuva, solo virando areia e dunas sendo empurradas pelo vento.',
    colors: ['#f2c26b', '#8a5a2b'],
    shape: { continents: 0, continentScale: 0.55, offset: -0.01, relief: 0.7 },
    settings: { temperature: 7, windHumidity: 0.2, rainAmount: 0.5, windSpeed: 1.2 },
  },
  {
    id: 'rivers',
    name: 'Vale dos rios',
    tagline: 'Muita chuva, muita erosão',
    description: 'Chuva forte o tempo todo: os rios cavam cânions, levam sedimento e formam deltas e lagos.',
    colors: ['#4fb3d9', '#1d4d3a'],
    shape: { continents: 0, continentScale: 0.55, offset: 0, relief: 1.2 },
    settings: { rainAmount: 2.5, windHumidity: 0.9, speed: 2 },
  },
  {
    id: 'rainforest',
    name: 'Floresta tropical',
    tagline: 'Rios voadores levam a chuva',
    description:
      'Quente e úmido, com vento vindo do mar. A floresta devolve ao ar a água da chuva e o vento leva esse vapor continente adentro.',
    colors: ['#2f9e5b', '#123d2a'],
    shape: { continents: 0, continentScale: 0.55, offset: 0, relief: 0.7 },
    settings: { temperature: 6, latitude: 4, windDirection: 0, windHumidity: 0.85, overlay: 'none' },
  },
  {
    id: 'warming',
    name: 'Planeta aquecendo',
    tagline: 'O gelo derrete, o mar sobe',
    description:
      'Começa frio, com picos nevados e mar nas bordas. A temperatura sobe sozinha: veja o gelo sumir e a costa recuar.',
    colors: ['#ff8a5c', '#2c4a6e'],
    shape: { continents: 0.05, continentScale: 0.55, offset: 0, relief: 1 },
    settings: { ocean: true, seaLevel: -0.02, temperature: -2, warming: true, warmingRate: 1.5 },
  },
  {
    id: 'living',
    name: 'Planeta vivo',
    tagline: 'Estações, ventos e mundo infinito',
    description:
      'O clima é decidido pela simulação: cinturões de vento, estações do ano e sistemas de pressão. Explore sem fim.',
    colors: ['#7bd88f', '#25407a'],
    shape: { continents: 0.08, continentScale: 0.55, offset: -0.015, relief: 1 },
    settings: { autoClimate: true, infiniteWorld: true, ocean: true, seaLevel: 0 },
  },
  {
    id: 'pangaea',
    name: 'Pangeia',
    tagline: 'Um supercontinente só',
    description:
      'Uma única massa de terra cercada de mar, numa área grande. Os povos disputam o mesmo chão e as placas trabalham por baixo.',
    colors: ['#c9a66b', '#1f4f6b'],
    shape: { continents: 0.14, continentScale: 0.3, offset: 0.005, relief: 1 },
    settings: { ocean: true, seaLevel: 0, area: 2, plateDrift: 2, windHumidity: 0.8 },
  },
  {
    id: 'young',
    name: 'Terra jovem',
    tagline: 'Um mundo que não para quieto',
    description:
      'Placas rápidas, tempo geológico acelerado, terremotos a toda hora e vulcões já acesos: montanhas nascem enquanto você olha.',
    colors: ['#d9532b', '#3b2a2a'],
    shape: { continents: 0.04, continentScale: 0.55, offset: 0, relief: 1.25 },
    settings: { plateDrift: 3, geologicTime: 10, earthquakes: true, volcanoes: true, temperature: 2 },
    vents: 4,
  },
]

export const scenarioById = (id: ScenarioId) => SCENARIOS.find((s) => s.id === id) ?? SCENARIOS[0]
