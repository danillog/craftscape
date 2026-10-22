import type { ScenarioId } from './scenarios'

/** How the generated terrain is shaped (see terrainHeight in the simulation shaders). */
export interface TerrainShape {
  /** Very broad rises and basins on top of the relief: with the sea on, islands and continents. */
  continents: number
  /** How many of those rises and basins fit in a window width (higher: smaller islands). */
  continentScale: number
  /** Lifts (or sinks) the whole terrain. */
  offset: number
  /** Multiplier on the height of the relief. */
  relief: number
}

/** 'inspect' paints nothing: the cursor reports what is under it. */
export type Tool =
  'inspect' | 'rock' | 'soil' | 'sand' | 'water' | 'level' | 'heat' | 'humidity' | 'volcano' | 'pressure' | 'uplift'
export type BrushMode = 'add' | 'remove'
export type CameraMode = 'orbit' | 'fly'
export type ResolutionSetting = 'auto' | 256 | 512 | 1024
/** Simulated area: the window's width in world units (1 = the classic square). */
export type AreaSetting = 1 | 1.5 | 2
export type QualityLevel = 'low' | 'medium' | 'high'
export type Quality = 'auto' | QualityLevel
export type Overlay =
  'none' | 'biome' | 'temperature' | 'rain' | 'humidity' | 'pressure' | 'erosion' | 'change' | 'rivers'

export interface Settings {
  tool: Tool
  mode: BrushMode
  /** Brush radius in terrain units (the terrain spans 1×1). */
  brushSize: number
  /** Multiplier on the original per-step brush rates. */
  brushStrength: number
  /** When on, left click/touch paints instead of rotating the camera. */
  paintOnClick: boolean

  rain: boolean
  evaporate: boolean
  erode: boolean
  vegetation: boolean
  paused: boolean
  /** Simulation speed multiplier; the base rate is 60 steps per second. */
  speed: number
  /** Geological time: erosion, weathering and tectonic uplift run this many times faster. */
  geologicTime: 1 | 10 | 30

  seed: number
  /** The world this terrain started from, and the shape it gives the generator. */
  scenario: ScenarioId
  terrainShape: TerrainShape
  resolution: ResolutionSetting
  area: AreaSetting
  /** Graphics quality; automatic starts from the device and steps down while frames are slow. */
  quality: Quality
  /** The terrain goes on forever: the simulated window follows the camera through the world. */
  infiniteWorld: boolean
  /**
   * The simulation decides the climate: prevailing winds from the latitude belts,
   * seasons, fixed humidity and rain; the climate sliders and brushes are off.
   */
  autoClimate: boolean
  /** Global temperature anomaly in °C; warms every cell, raising the snow line. */
  temperature: number
  /** When on, the temperature keeps rising while the simulation runs. */
  warming: boolean
  /** Warming rate in °C per simulated minute. */
  warmingRate: number
  /** When on, the map border is open sea that floods inland below the sea level. */
  ocean: boolean
  /** Sea level at 0 °C anomaly; melting ice raises it. */
  seaLevel: number
  /** How much colder the north edge is than the south edge, in °C. */
  latitude: number
  /** Direction the wind blows towards, in degrees (0 = east, 90 = north). */
  windDirection: number
  /** Wind speed in cells per step at 512². */
  windSpeed: number
  /** Relative humidity of the air blowing in from outside the map, 0–1. */
  windHumidity: number
  /** Multiplier on rainfall. */
  rainAmount: number
  /** When on, the prevailing wind slowly swings back and forth around its direction. */
  windVariation: boolean
  /** Arrows over the terrain showing the local wind. */
  windArrows: boolean
  /** Drifting highs and lows that the wind circles; lows bring clouds and rain. */
  pressureSystems: boolean
  /** How strongly heating differences build those systems (multiplier). */
  pressureStrength: number
  /** Volumetric-looking cloud layer. */
  clouds: boolean
  /** When on, the time of day advances with the simulation. */
  dayNight: boolean
  /** Length of a simulated day, in simulated minutes. */
  dayLength: number
  /** 0 = midnight, 0.25 sunrise, 0.5 noon, 0.75 sunset. */
  timeOfDay: number
  /** Map overlay showing the climate instead of (or on top of) the terrain colours. */
  overlay: Overlay
  cameraMode: CameraMode
  /** Keyboard shortcut overlay (H or ?). */
  showHelp: boolean
  /** Photo mode: the interface hides, leaving the view and a small camera bar (K). */
  photoMode: boolean
  /** The camera slowly circles its target by itself. */
  cinematic: boolean
  /** Cinematic orbit speed, in degrees per second. */
  cinematicSpeed: number
}

export const defaultSettings: Settings = {
  tool: 'inspect',
  mode: 'add',
  brushSize: 0.04,
  brushStrength: 1,
  paintOnClick: false,
  rain: true,
  evaporate: true,
  erode: true,
  vegetation: true,
  paused: false,
  speed: 1,
  geologicTime: 1,
  seed: 1,
  scenario: 'classic',
  terrainShape: { continents: 0, continentScale: 0.55, offset: 0, relief: 1 },
  resolution: 'auto',
  area: 1,
  quality: 'auto',
  infiniteWorld: true,
  autoClimate: false,
  temperature: 0,
  warming: false,
  warmingRate: 1,
  ocean: false,
  seaLevel: -0.02,
  latitude: 16,
  windDirection: 0,
  windSpeed: 0.6,
  windHumidity: 0.7,
  rainAmount: 1,
  windVariation: false,
  windArrows: true,
  pressureSystems: true,
  pressureStrength: 1,
  clouds: true,
  dayNight: true,
  dayLength: 4,
  timeOfDay: 0.35,
  overlay: 'none',
  cameraMode: 'orbit',
  showHelp: false,
  photoMode: false,
  cinematic: false,
  cinematicSpeed: 4,
}

export interface QualityProfile {
  /** Cap on the device pixel ratio, then a scale on top: the canvas is drawn at fewer pixels and stretched. */
  maxPixelRatio: number
  renderScale: number
  /** Dynamic resolution: while frames are slow the scale drops towards this, and recovers when they are fast. */
  minRenderScale: number
  /** Terrain LOD: screen pixels per vertex (more = coarser mesh). */
  pixelsPerVertex: number
  /** Occlusion and shadows refresh 1/derivedSlices of the rows per frame. */
  derivedSlices: 4 | 16
  /** Draws every other vertex of the distant terrain. */
  coarseHorizon: boolean
  maxStepsPerFrame: number
  /** Multirate: the atmosphere updates once every this many simulation steps. */
  climateEvery: number
  /** Simulation size when the resolution is automatic. */
  autoResolution: 256 | 512
}

export const QUALITY: Record<QualityLevel, QualityProfile> = {
  high: {
    maxPixelRatio: 2,
    renderScale: 1,
    minRenderScale: 0.6,
    pixelsPerVertex: 6,
    derivedSlices: 4,
    coarseHorizon: false,
    maxStepsPerFrame: 8,
    climateEvery: 1,
    autoResolution: 512,
  },
  medium: {
    maxPixelRatio: 1.5,
    renderScale: 0.85,
    minRenderScale: 0.5,
    pixelsPerVertex: 9,
    derivedSlices: 4,
    coarseHorizon: true,
    maxStepsPerFrame: 4,
    climateEvery: 2,
    autoResolution: 512,
  },
  low: {
    maxPixelRatio: 1,
    renderScale: 0.6,
    minRenderScale: 0.4,
    pixelsPerVertex: 14,
    derivedSlices: 16,
    coarseHorizon: true,
    maxStepsPerFrame: 2,
    climateEvery: 4,
    autoResolution: 256,
  },
}

export const TEMPERATURE_MIN = -4
export const TEMPERATURE_MAX = 8

/** Temperature at height 0 on the middle latitude with no anomaly, in °C. */
export const BASE_TEMPERATURE = 13.5
/** °C lost per unit of terrain height (the generated terrain spans roughly −0.1 to 0.2). */
export const LAPSE_RATE = 150

/** Heights derived from the temperature: the freezing line on the middle latitude, and the sea. */
export function climateOf(s: Pick<Settings, 'temperature' | 'seaLevel'>) {
  return {
    snowLine: (BASE_TEMPERATURE + s.temperature) / LAPSE_RATE,
    seaLevel: s.seaLevel + s.temperature * 0.004,
  }
}

/** Heights in metres: the lapse rate in °C per height unit over the standard 6.5 °C per km. */
export const METERS_PER_HEIGHT = (LAPSE_RATE / 6.5) * 1000

/** What is at the cell under the cursor (the inspect tool), read back from the simulation. */
export interface Probe {
  /** Cursor in normalized device coordinates, where the card goes. */
  ndc: [number, number]
  /** Surface height (rock + soil + sand + ice + lava), in height units. */
  height: number
  rock: number
  soil: number
  sand: number
  water: number
  /** Water speed in cells per step (flux over depth). */
  flow: number
  /** Sediment the water is carrying. */
  sediment: number
  plants: number
  moisture: number
  snow: number
  ice: number
  /** °C, relative humidity 0–1, mean rain relative to the original uniform rain. */
  temperature: number
  humidity: number
  rain: number
  lava: number
  vent: number
  /** Tectonic zone: −1 sinking … 1 rising. */
  tectonic: number
  /** Wind towards, in degrees (0 = east, 90 = north), and speed in the slider's units. */
  windDirection: number
  windSpeed: number
  /** Weather pressure anomaly: lows < 0 < highs. */
  pressure: number
  /** Index into the biome list (biome() in the render shader). */
  biome: number
}

export const BRUSH_MIN = 0.01
export const BRUSH_MAX = 0.15

/** What the climate analysis found in the simulated window (see Engine.analyzeClimate). */
export interface ClimateReport {
  meanTemp: number
  minTemp: number
  maxTemp: number
  /** Mean rain relative to the original uniform rain. */
  rain: number
  /** Mean relative humidity of the air. */
  humidity: number
  /** Share of each biome (biome() order in the render shader). */
  biomes: number[]
  /** Mean wind: direction it blows towards (degrees, 0 = east, 90 = north) and speed (cells/step at 512²). */
  windDirection: number
  windSpeed: number
  lows: number
  highs: number
}

export const DAYS_PER_YEAR = 8
export const SEASONS = ['primavera', 'verão', 'outono', 'inverno'] as const

/** Seasonal temperature anomaly (°C) and season for a point of the year (0–1, 0 = start of spring). */
export function seasonOf(yearPhase: number) {
  const phase = ((yearPhase % 1) + 1) % 1
  return { anomaly: 5 * Math.sin(phase * 2 * Math.PI), season: SEASONS[Math.floor(phase * 4)] }
}

export interface Stats {
  fps: number
  frameMs: number
  simStepsPerSec: number
  resolution: number
  /** Quality level in effect (the chosen one, or where automatic settled). */
  quality: QualityLevel
  undoDepth: number
  adapter: string
  /** World region at the centre of the window, and how many visited regions are kept. */
  region: [number, number]
  storedRegions: number
  climate: ClimateReport | null
  /** Automatic climate: the season and its temperature anomaly. */
  season: { name: string; anomaly: number } | null
}

export const emptyStats: Stats = {
  fps: 0,
  frameMs: 0,
  simStepsPerSec: 0,
  resolution: 0,
  quality: 'high',
  undoDepth: 0,
  adapter: '',
  region: [0, 0],
  storedRegions: 0,
  climate: null,
  season: null,
}
