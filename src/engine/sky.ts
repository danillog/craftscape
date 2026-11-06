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

/** The sun's tilt at the solstices (degrees): how far north or south of the equator it stands overhead. */
export const AXIAL_TILT = 23.44

/** Degrees of latitude for a world v (see planetary() in the simulation: the trade winds end near v = 0, the polar belt begins near 1.4). */
export const latitudeOfWorld = (v: number) => Math.max(0, Math.min(85, 26 + 25.5 * v))

/** Where the sun stands overhead (degrees of latitude) at a point of the year (0 = start of spring, 0.25 midsummer). */
export const declinationAt = (yearPhase: number) => AXIAL_TILT * Math.sin(yearPhase * 2 * Math.PI)

/** Hours of daylight at a latitude (degrees north) when the sun stands over `declination`: 24 under the midnight sun, 0 in the polar night. */
export function dayHours(latitude: number, declination: number) {
  const x = -Math.tan((latitude * Math.PI) / 180) * Math.tan((declination * Math.PI) / 180)
  return (24 / Math.PI) * Math.acos(Math.max(-1, Math.min(1, x)))
}

/**
 * Sun and moon for a time of day (0 = midnight, 0.25 sunrise, 0.5 noon, 0.75 sunset).
 * The sun rises in the east (+x), crosses the southern sky (+z, since the cold north
 * is −z) and sets in the west; the moon is opposite it. Shadows follow whichever is
 * up, kept a little above the horizon so they never stretch to infinity.
 *
 * With a latitude (degrees north) and the sun's declination (degrees) the sun follows
 * the real geometry of the place and the season: high and long in summer, low and short
 * in winter, never setting near the pole in midsummer and never rising in midwinter.
 */
export function skyAt(timeOfDay: number, latitude?: number, declination = 0): SkyState {
  let sun: [number, number, number]
  if (latitude === undefined) {
    const phi = (timeOfDay - 0.25) * 2 * Math.PI
    const up = Math.sin(phi)
    sun = normalize([Math.cos(phi), up * 0.85, up * 0.45 + 0.15])
  } else {
    const lat = (latitude * Math.PI) / 180
    const decl = (declination * Math.PI) / 180
    // the hour angle: 0 at noon, negative in the morning
    const hour = (timeOfDay - 0.5) * 2 * Math.PI
    sun = normalize([
      -Math.cos(decl) * Math.sin(hour),
      Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(hour),
      Math.sin(lat) * Math.cos(decl) * Math.cos(hour) - Math.cos(lat) * Math.sin(decl),
    ])
  }
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
