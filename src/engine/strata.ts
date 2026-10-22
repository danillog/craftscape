// CPU copy of the rock strata in the simulation shaders (stratumOf, stratumHardness and
// stratumColor in shaders/sim.ts), for the cross-section. The integer hash matches the
// shader's bit for bit; the warp uses doubles here and f32 there, which can only move a
// layer boundary by a hair.

const STRATA_PER_UNIT = 45

function strataHash(n: number) {
  let h = (Math.imul((n | 0) + 1000000, 747796405) + 2891336453) >>> 0
  h = Math.imul(((h >>> ((h >>> 28) + 4)) ^ h) >>> 0, 277803737) >>> 0
  h = ((h >>> 22) ^ h) >>> 0
  return h / 4294967295
}

const fract = (x: number) => x - Math.floor(x)

export function stratumOf(wx: number, wy: number, height: number, seed: number) {
  const dip = [Math.sin(seed * 1.7) * 0.012, Math.cos(seed * 2.3) * 0.012]
  const warp = (Math.sin(wx * 3.1 + seed) + Math.sin(wy * 2.7 - seed * 0.5)) * 0.004
  return Math.floor((height + wx * dip[0] + wy * dip[1] + warp) * STRATA_PER_UNIT + fract(seed * 0.618) * 7)
}

export function stratumHardness(layer: number) {
  return strataHash(layer) > 0.66 ? 1.8 + 1.4 * strataHash(layer + 31) : 0.4 + 0.7 * strataHash(layer + 17)
}

/** RGB 0–1, as the render shader tints bare rock. */
export function stratumColor(layer: number): [number, number, number] {
  const h = strataHash(layer + 5)
  let c: [number, number, number] = [0.78, 0.68, 0.52]
  if (h > 0.25) c = [0.72, 0.42, 0.3]
  if (h > 0.5) c = [0.62, 0.62, 0.6]
  if (h > 0.78) c = [0.36, 0.33, 0.32]
  const t = Math.min(Math.max(stratumHardness(layer) - 1, 0), 1)
  const k = 0.92 + 0.16 * t * t * (3 - 2 * t)
  return [c[0] * k, c[1] * k, c[2] * k]
}
