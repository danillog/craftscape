import type { TerrainShape } from './settings'
import { STATE_KEYS, type SimState, type StateKey } from './simulation'

// .craftscape file: gzip( "CSCP" | u32 version | u32 size | f32 seed | ground | water | waterLast | extra | climate | air | lava
//                        | i32 originX | i32 originY | u32 regionCount | regionCount × (i32 tx | i32 ty | 7 arrays)
//                        | f32 area | f32 continents | f32 continentScale | f32 offset | f32 relief
//                        | fine: size² × f32 | f32 plateTime )
// Regions are the visited parts of the infinite world outside the window, (size/4)² cells each.
// The area is the window's width in world units; the shape is how new regions are generated.
// Older versions stop earlier (v1 after extra, v2 after air, v3 after lava, v4 after the
// regions); they load at the world origin with a neutral climate, no lava, area 1 and the
// classic terrain shape. v6 has the same layout, but waterLast holds the water flux
// through the cell faces (see waterFluxShader). v7 adds the fine sediment in suspension
// (one float per window cell) after the trailer; the regions keep none. v8 adds the plate
// time (how far the plates have drifted, see plates.ts) after the fine sediment.
const MAGIC = 0x50435343 // "CSCP" little-endian
const VERSION = 8
const HEADER_BYTES = 16
const ARRAYS = STATE_KEYS
const ARRAYS_IN_VERSION: Record<number, number> = { 1: 4, 2: 6, 3: 7, 4: 7, 5: 7, 6: 7, 7: 7, 8: 7 }
const TRAILER_BYTES = 20
const CLASSIC_SHAPE: TerrainShape = { continents: 0, continentScale: 0.55, offset: 0, relief: 1 }

/** Climate for a terrain that has none yet: average rain, humid air; temperatures fill in on the first step. */
function neutralClimate(size: number) {
  const climate = new Float32Array(size * size * 4)
  const air = new Float32Array(size * size * 4)
  for (let i = 0; i < size * size; i++) {
    climate[i * 4 + 1] = 0.7
    climate[i * 4 + 2] = 1
    air[i * 4] = 0.7
    air[i * 4 + 2] = 15
  }
  return { climate, air, lava: new Float32Array(size * size * 4) }
}

export type SavedRegion = [tx: number, ty: number, data: Record<StateKey, Float32Array>]

export interface SavedTerrain {
  state: SimState
  seed: number
  /** Window origin in the world, in cells. */
  origin: [number, number]
  regions: SavedRegion[]
  /** Window width in world units. */
  area: number
  shape: TerrainShape
  /** Plate time (see plates.ts); 0 in files from before v8. */
  plateTime: number
}

async function pipeThrough(data: BlobPart, stream: CompressionStream | DecompressionStream): Promise<ArrayBuffer> {
  return new Response(new Blob([data]).stream().pipeThrough(stream)).arrayBuffer()
}

export async function encodeTerrain({ state, seed, origin, regions, area, shape, plateTime }: SavedTerrain): Promise<Blob> {
  const floats = state.size * state.size * 4
  const regionFloats = (state.size / 4) ** 2 * 4
  const windowBytes = HEADER_BYTES + floats * 4 * ARRAYS.length
  const regionBytes = 8 + regionFloats * 4 * ARRAYS.length
  const trailerAt = windowBytes + 12 + regions.length * regionBytes
  const cells = state.size * state.size
  const buffer = new ArrayBuffer(trailerAt + TRAILER_BYTES + cells * 4 + 4)
  const header = new DataView(buffer)
  header.setUint32(0, MAGIC, true)
  header.setUint32(4, VERSION, true)
  header.setUint32(8, state.size, true)
  header.setFloat32(12, seed, true)
  ARRAYS.forEach((key, k) => new Float32Array(buffer, HEADER_BYTES + k * floats * 4, floats).set(state[key]))
  header.setInt32(windowBytes, origin[0], true)
  header.setInt32(windowBytes + 4, origin[1], true)
  header.setUint32(windowBytes + 8, regions.length, true)
  regions.forEach(([tx, ty, data], r) => {
    const at = windowBytes + 12 + r * regionBytes
    header.setInt32(at, tx, true)
    header.setInt32(at + 4, ty, true)
    ARRAYS.forEach((key, k) => new Float32Array(buffer, at + 8 + k * regionFloats * 4, regionFloats).set(data[key]))
  })
  new Float32Array(buffer, trailerAt, TRAILER_BYTES / 4).set([
    area,
    shape.continents,
    shape.continentScale,
    shape.offset,
    shape.relief,
  ])
  if (state.fine) new Float32Array(buffer, trailerAt + TRAILER_BYTES, cells).set(state.fine)
  header.setFloat32(trailerAt + TRAILER_BYTES + cells * 4, plateTime, true)
  return new Blob([await pipeThrough(buffer, new CompressionStream('gzip'))], { type: 'application/octet-stream' })
}

export async function decodeTerrain(file: Blob): Promise<SavedTerrain> {
  let buffer = await file.arrayBuffer()
  const bytes = new Uint8Array(buffer)
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) buffer = await pipeThrough(buffer, new DecompressionStream('gzip'))
  const header = new DataView(buffer)
  if (buffer.byteLength < HEADER_BYTES || header.getUint32(0, true) !== MAGIC) {
    throw new Error('Este arquivo não é um terreno do Craftscape.')
  }
  const version = header.getUint32(4, true)
  if (!ARRAYS_IN_VERSION[version]) throw new Error(`Versão de arquivo ${version} não suportada.`)
  const size = header.getUint32(8, true)
  const floats = size * size * 4
  const arrays = ARRAYS_IN_VERSION[version]
  if (size < 256 || size > 2048 || size % 64 !== 0 || buffer.byteLength < HEADER_BYTES + floats * 4 * arrays) {
    throw new Error('Arquivo de terreno corrompido.')
  }
  const read = (k: number) =>
    new Float32Array(buffer.slice(HEADER_BYTES + k * floats * 4, HEADER_BYTES + (k + 1) * floats * 4))
  const state = { size, ...neutralClimate(size) } as SimState
  for (let k = 0; k < arrays; k++) state[ARRAYS[k]] = read(k)
  const origin: [number, number] = [0, 0]
  const regions: SavedRegion[] = []
  let area = 1
  let shape = CLASSIC_SHAPE
  let plateTime = 0
  const windowBytes = HEADER_BYTES + floats * 4 * arrays
  if (version >= 4 && buffer.byteLength >= windowBytes + 12) {
    origin[0] = header.getInt32(windowBytes, true)
    origin[1] = header.getInt32(windowBytes + 4, true)
    const count = header.getUint32(windowBytes + 8, true)
    const regionFloats = (size / 4) ** 2 * 4
    const regionBytes = 8 + regionFloats * 4 * ARRAYS.length
    if (buffer.byteLength < windowBytes + 12 + count * regionBytes) throw new Error('Arquivo de terreno corrompido.')
    for (let r = 0; r < count; r++) {
      const at = windowBytes + 12 + r * regionBytes
      const data = {} as Record<StateKey, Float32Array>
      ARRAYS.forEach((key, k) => {
        const start = at + 8 + k * regionFloats * 4
        data[key] = new Float32Array(buffer.slice(start, start + regionFloats * 4))
      })
      regions.push([header.getInt32(at, true), header.getInt32(at + 4, true), data])
    }
    const trailerAt = windowBytes + 12 + count * regionBytes
    if (version >= 5 && buffer.byteLength >= trailerAt + TRAILER_BYTES) {
      const [a, continents, continentScale, offset, relief] = new Float32Array(
        buffer.slice(trailerAt, trailerAt + TRAILER_BYTES),
      )
      area = a > 0 ? a : 1
      shape = { continents, continentScale, offset, relief }
      const fineAt = trailerAt + TRAILER_BYTES
      if (version >= 7 && buffer.byteLength >= fineAt + size * size * 4) {
        state.fine = new Float32Array(buffer.slice(fineAt, fineAt + size * size * 4))
      }
      const plateAt = fineAt + size * size * 4
      if (version >= 8 && buffer.byteLength >= plateAt + 4) plateTime = header.getFloat32(plateAt, true)
    }
  }
  // before v6 the water flowed by another method, which kept something else in waterLast
  // (now the flux through each cell's faces): the water starts again from rest
  if (version < 6) {
    state.waterLast.fill(0)
    for (const [, , data] of regions) data.waterLast.fill(0)
  }
  return { seed: header.getFloat32(12, true), state, origin, regions, area, shape, plateTime }
}

/** Grayscale image → rock heights in roughly the range of the generated terrain. */
export async function heightmapToState(file: Blob, size: number): Promise<SimState> {
  const bitmap = await createImageBitmap(file, { resizeWidth: size, resizeHeight: size, resizeQuality: 'high' })
  const canvas = new OffscreenCanvas(size, size)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('Canvas 2D indisponível.')
  ctx.drawImage(bitmap, 0, 0)
  bitmap.close()
  const pixels = ctx.getImageData(0, 0, size, size).data
  const ground = new Float32Array(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // image rows go top-down; the simulation's v axis goes bottom-up
      const p = ((size - 1 - y) * size + x) * 4
      const lum = (0.299 * pixels[p] + 0.587 * pixels[p + 1] + 0.114 * pixels[p + 2]) / 255
      const h = -0.1 + lum * 0.35
      const i = (y * size + x) * 4
      ground[i] = h
      ground[i + 1] = h
    }
  }
  const empty = () => new Float32Array(size * size * 4)
  return { size, ground, water: empty(), waterLast: empty(), extra: empty(), ...neutralClimate(size) }
}

/** Bilinear resample of every channel, used when the resolution changes. */
export function resampleState(state: SimState, size: number): SimState {
  if (state.size === size) return state
  const src = state.size
  const resample = (data: Float32Array, channels = 4) => {
    const out = new Float32Array(size * size * channels)
    for (let y = 0; y < size; y++) {
      const fy = Math.min(Math.max(((y + 0.5) / size) * src - 0.5, 0), src - 1)
      const y0 = Math.floor(fy)
      const y1 = Math.min(y0 + 1, src - 1)
      const ty = fy - y0
      for (let x = 0; x < size; x++) {
        const fx = Math.min(Math.max(((x + 0.5) / size) * src - 0.5, 0), src - 1)
        const x0 = Math.floor(fx)
        const x1 = Math.min(x0 + 1, src - 1)
        const tx = fx - x0
        for (let c = 0; c < channels; c++) {
          const a = data[(y0 * src + x0) * channels + c] * (1 - tx) + data[(y0 * src + x1) * channels + c] * tx
          const b = data[(y1 * src + x0) * channels + c] * (1 - tx) + data[(y1 * src + x1) * channels + c] * tx
          out[(y * size + x) * channels + c] = a * (1 - ty) + b * ty
        }
      }
    }
    return out
  }
  const out = { size } as SimState
  for (const key of ARRAYS) out[key] = resample(state[key])
  if (state.fine) out.fine = resample(state.fine, 1)
  return out
}

export function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

// ---- exports ----------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(bytes: Uint8Array) {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Uint8Array) {
  const chunk = new Uint8Array(12 + data.length)
  const view = new DataView(chunk.buffer)
  view.setUint32(0, data.length)
  for (let k = 0; k < 4; k++) chunk[4 + k] = type.charCodeAt(k)
  chunk.set(data, 8)
  view.setUint32(8 + data.length, crc32(chunk.subarray(4, 8 + data.length)))
  return chunk
}

/**
 * Surface heights as a 16-bit greyscale PNG (canvas only writes 8 bits): lowest black,
 * highest white, north up. Returns the height range so it can be mapped back.
 */
export async function encodeHeightmapPNG(heights: Float32Array, size: number) {
  let min = Infinity
  let max = -Infinity
  for (const h of heights) {
    min = Math.min(min, h)
    max = Math.max(max, h)
  }
  const span = max - min || 1
  // one filter byte (0 = none) per row, then big-endian 16-bit samples
  const raw = new Uint8Array(size * (1 + size * 2))
  for (let row = 0; row < size; row++) {
    const v = size - 1 - row // the window's v grows northwards; images go top to bottom
    const at = row * (1 + size * 2)
    for (let x = 0; x < size; x++) {
      const sample = Math.round(((heights[v * size + x] - min) / span) * 65535)
      raw[at + 1 + x * 2] = sample >> 8
      raw[at + 2 + x * 2] = sample & 0xff
    }
  }
  const header = new Uint8Array(13)
  const hv = new DataView(header.buffer)
  hv.setUint32(0, size)
  hv.setUint32(4, size)
  header.set([16, 0, 0, 0, 0], 8) // 16-bit, greyscale, deflate, no filter, no interlace
  const idat = new Uint8Array(await pipeThrough(raw, new CompressionStream('deflate')))
  const signature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const blob = new Blob(
    [signature, pngChunk('IHDR', header), pngChunk('IDAT', idat), pngChunk('IEND', new Uint8Array())],
    { type: 'image/png' },
  )
  return { blob, min, max }
}

/**
 * Surface as a Wavefront OBJ triangle mesh, at most 512 vertices a side. x and z span
 * the simulated area in world units (the window is `extent` wide), y is the height in
 * the same units, as the game draws it.
 */
export function encodeMeshOBJ(heights: Float32Array, size: number, extent: number) {
  const step = Math.ceil(size / 512)
  const side = Math.floor((size - 1) / step) + 1
  const lines: string[] = [
    '# Craftscape terrain',
    `# ${side} x ${side} vertices; x and z in world units (the window is ${extent} wide), y the height`,
  ]
  for (let j = 0; j < side; j++) {
    for (let i = 0; i < side; i++) {
      const x = i * step
      const v = j * step
      const u = (x + 0.5) / size
      const vv = (v + 0.5) / size
      lines.push(
        `v ${((u - 0.5) * extent).toFixed(5)} ${heights[v * size + x].toFixed(5)} ${((0.5 - vv) * extent).toFixed(5)}`,
      )
    }
  }
  for (let j = 0; j < side - 1; j++) {
    for (let i = 0; i < side - 1; i++) {
      const a = j * side + i + 1
      const b = a + 1
      const c = a + side
      const d = c + 1
      lines.push(`f ${a} ${c} ${b}`, `f ${b} ${c} ${d}`)
    }
  }
  return new Blob([lines.join('\n') + '\n'], { type: 'model/obj' })
}
