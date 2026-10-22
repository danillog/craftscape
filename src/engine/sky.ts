import type { Light } from './simulation'

export interface SkyState extends Light {
  /** Direction towards the sun (may be below the horizon). */
  sun: [number, number, number]
}

const normalize = (v: [number, number, number]): [number, number, number] => {
  const l = Math.hypot(...v)
  return [v[0] / l, v[1] / l, v[2] / l]
}

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1)
  return t * t * (3 - 2 * t)
}

/**
 * Sun and moon for a time of day (0 = midnight, 0.25 sunrise, 0.5 noon, 0.75 sunset).
 * The sun rises in the east (+x), crosses the southern sky (+z, since the cold north
 * is −z) and sets in the west; the moon is opposite it. Shadows follow whichever is
 * up, kept a little above the horizon so they never stretch to infinity.
 */
export function skyAt(timeOfDay: number): SkyState {
  const phi = (timeOfDay - 0.25) * 2 * Math.PI
  const up = Math.sin(phi)
  const sun = normalize([Math.cos(phi), up * 0.85, up * 0.45 + 0.15])
  const daylight = smoothstep(-0.08, 0.12, sun[1])
  const caster: [number, number, number] = sun[1] > 0 ? sun : [-sun[0], -sun[1], sun[2]]
  const dir = normalize([caster[0], Math.max(caster[1], 0.06), caster[2]])
  return { sun, dir, daylight }
}

/** "14:30" for a time of day. */
export function clockOf(timeOfDay: number) {
  const minutes = Math.floor((((timeOfDay % 1) + 1) % 1) * 24 * 60)
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
}
