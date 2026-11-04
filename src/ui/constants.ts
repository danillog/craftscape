import { CIV_COLORS } from '../engine/life'
import type { FpsLimit, Overlay, Quality, QualityLevel, ResolutionSetting, Tool } from '../engine/settings'

/** A people's colour as CSS. */
export const civCss = (k: number) => `rgb(${CIV_COLORS[k].map((v) => Math.round(v * 255)).join(', ')})`

export const MODE_LABELS: Partial<Record<Tool, [string, string]>> = {
  sun: ['Esquentar o planeta 1 °C', 'Esfriar o planeta 1 °C'],
  drought: ['Decretar uma seca', 'Apagar a seca'],
  heat: ['Esquentar', 'Esfriar'],
  humidity: ['Umedecer', 'Secar'],
  volcano: ['Abrir cratera', 'Tampar'],
  pressure: ['Alta pressão', 'Baixa pressão'],
  airmass: ['Ar quente', 'Ar frio'],
  current: ['Corrente quente', 'Corrente fria'],
}

/** The air-mass brush's modes while its masses are fixed in place. */
export const FIXED_AIR_LABELS: [string, string] = ['Fonte de ar quente', 'Fonte de ar frio']

export const OVERLAYS: { id: Overlay; label: string }[] = [
  { id: 'none', label: 'Normal' },
  { id: 'biome', label: 'Biomas' },
  { id: 'temperature', label: 'Temp.' },
  { id: 'rain', label: 'Chuva' },
  { id: 'humidity', label: 'Ar' },
  { id: 'pressure', label: 'Pressão' },
  { id: 'erosion', label: 'Erosão' },
  { id: 'change', label: 'Mudança' },
  { id: 'rivers', label: 'Rios' },
  { id: 'plates', label: 'Placas' },
  { id: 'airmass', label: 'Frentes' },
  { id: 'civilization', label: 'Povos' },
  { id: 'current', label: 'Correntes' },
]

// same colours as biomeColor() in the render shader
export const BIOMES: [string, string][] = [
  ['Gelo', 'rgb(217 237 255)'],
  ['Tundra', 'rgb(140 153 115)'],
  ['Deserto frio', 'rgb(179 168 153)'],
  ['Taiga', 'rgb(31 97 77)'],
  ['Estepe / campo', 'rgb(191 184 97)'],
  ['Floresta temperada', 'rgb(51 153 38)'],
  ['Deserto', 'rgb(237 199 115)'],
  ['Savana', 'rgb(199 158 51)'],
  ['Floresta tropical', 'rgb(0 107 31)'],
]

const COMPASS = ['leste', 'nordeste', 'norte', 'noroeste', 'oeste', 'sudoeste', 'sul', 'sudeste']
const ARROWS = ['→', '↗', '↑', '↖', '←', '↙', '↓', '↘']
export const compass = (deg: number) => {
  const k = Math.round(deg / 45) % 8
  return `${ARROWS[k]} para ${COMPASS[k]}`
}

export const RESOLUTIONS: { value: ResolutionSetting; label: string }[] = [
  { value: 'auto', label: 'Automática' },
  { value: 256, label: '256²' },
  { value: 512, label: '512²' },
  { value: 1024, label: '1024²' },
  { value: 2048, label: '2048² (GPU forte)' },
]

export const QUALITIES: { value: Quality; label: string }[] = [
  { value: 'auto', label: 'Automática' },
  { value: 'low', label: 'Baixa' },
  { value: 'medium', label: 'Média' },
  { value: 'high', label: 'Alta' },
]

export const FPS_LIMITS: { value: FpsLimit; label: string }[] = [
  { value: 30, label: '30 fps (econômico)' },
  { value: 60, label: '60 fps' },
  { value: 120, label: '120 fps' },
  { value: 0, label: 'Sem limite' },
]

export const QUALITY_NAMES: Record<QualityLevel, string> = { low: 'baixa', medium: 'média', high: 'alta' }

// same colours as erosionAt() in the render shader
export const EROSION_LEGEND: [string, string, string][] = [
  ['Água cavando', 'rgb(51 140 255)', 'rios escavando vales, ondas na costa'],
  ['Água depositando', 'rgb(115 217 89)', 'sedimento assentando: deltas, lagos, planícies'],
  ['Vento', 'rgb(250 184 64)', 'areia jateando a rocha, solo seco levado'],
  ['Gelo e geada', 'rgb(158 115 255)', 'geleiras raspando o vale, gelo rachando a rocha'],
  ['Calor', 'rgb(255 107 51)', 'dia quente e noite fria, clima úmido decompondo'],
  ['Pouca erosão', 'rgb(107 107 107)', ''],
]
