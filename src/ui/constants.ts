import type { Overlay, Quality, QualityLevel, ResolutionSetting, Tool } from '../engine/settings'

export const MODE_LABELS: Partial<Record<Tool, [string, string]>> = {
  heat: ['Esquentar', 'Esfriar'],
  humidity: ['Umedecer', 'Secar'],
  volcano: ['Abrir cratera', 'Tampar'],
  pressure: ['Alta pressão', 'Baixa pressão'],
  uplift: ['Soerguer', 'Afundar'],
}

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
]

export const QUALITIES: { value: Quality; label: string }[] = [
  { value: 'auto', label: 'Automática' },
  { value: 'low', label: 'Baixa' },
  { value: 'medium', label: 'Média' },
  { value: 'high', label: 'Alta' },
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
