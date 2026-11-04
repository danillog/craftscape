// Seeded value noise and fractal sums, for generating the tile worlds on the CPU.

/** A hash of two integers and a seed, 0–1. */
export function hash2(x: number, y: number, seed: number): number {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 1274126177)) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  h ^= h >>> 16
  return (h >>> 0) / 4294967296
}

/** Smooth value noise, 0–1. */
export function valueNoise(x: number, y: number, seed: number): number {
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const fx = x - x0
  const fy = y - y0
  const ux = fx * fx * (3 - 2 * fx)
  const uy = fy * fy * (3 - 2 * fy)
  const a = hash2(x0, y0, seed)
  const b = hash2(x0 + 1, y0, seed)
  const c = hash2(x0, y0 + 1, seed)
  const d = hash2(x0 + 1, y0 + 1, seed)
  return (a + (b - a) * ux) * (1 - uy) + (c + (d - c) * ux) * uy
}

/** Fractal (octave) sum of value noise, 0–1. */
export function fbm(x: number, y: number, seed: number, octaves = 6, gain = 0.5, lacunarity = 2): number {
  let v = 0
  let amp = 1
  let f = 1
  let norm = 0
  for (let k = 0; k < octaves; k++) {
    v += valueNoise(x * f, y * f, seed + k * 31) * amp
    norm += amp
    amp *= gain
    f *= lacunarity
  }
  return v / norm
}
