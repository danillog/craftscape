// Saved 2D worlds: the game's state as JSON, with what JSON cannot hold tagged (typed
// arrays as base64, Maps and Sets as entries, Infinity and NaN by name), gzipped when the
// browser can.

const TYPED = { Float32Array, Float64Array, Int16Array, Int32Array, Uint8Array, Uint16Array, Uint32Array } as const
type TypedName = keyof typeof TYPED

function toBase64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

function fromBase64(text: string): Uint8Array {
  const s = atob(text)
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}

/** A value made JSON-safe (see decode). */
export function encode(v: unknown): unknown {
  if (typeof v === 'number') return Number.isFinite(v) ? v : { $n: String(v) }
  if (v === null || typeof v !== 'object') return v
  if (ArrayBuffer.isView(v) && !(v instanceof DataView)) {
    const name = v.constructor.name as TypedName
    if (!(name in TYPED)) throw new Error(`não sei salvar ${name}`)
    return { $t: name, b: toBase64(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)) }
  }
  if (v instanceof Map) return { $m: [...v.entries()].map(([k, x]) => [encode(k), encode(x)]) }
  if (v instanceof Set) return { $s: [...v].map(encode) }
  if (Array.isArray(v)) return v.map(encode)
  const out: Record<string, unknown> = {}
  for (const [k, x] of Object.entries(v)) out[k] = encode(x)
  return out
}

/** The value back from encode. */
export function decode(v: unknown): unknown {
  if (v === null || typeof v !== 'object') return v
  if (Array.isArray(v)) return v.map(decode)
  const o = v as Record<string, unknown>
  if ('$n' in o) return Number(o.$n)
  if ('$t' in o) {
    const bytes = fromBase64(o.b as string)
    const Ctor = TYPED[o.$t as TypedName]
    const copy = new Uint8Array(bytes.length)
    copy.set(bytes)
    return new Ctor(copy.buffer)
  }
  if ('$m' in o) return new Map((o.$m as [unknown, unknown][]).map(([k, x]) => [decode(k), decode(x)]))
  if ('$s' in o) return new Set((o.$s as unknown[]).map(decode))
  const out: Record<string, unknown> = {}
  for (const [k, x] of Object.entries(o)) out[k] = decode(x)
  return out
}

/** The state as a file to download (gzipped JSON when the browser can compress). */
export async function toFile(state: unknown): Promise<Blob> {
  const json = JSON.stringify(encode(state))
  const blob = new Blob([json], { type: 'application/json' })
  if (typeof CompressionStream === 'undefined') return blob
  return new Response(blob.stream().pipeThrough(new CompressionStream('gzip'))).blob()
}

/** The state back from a file (gzipped or plain JSON). */
export async function fromFile(file: Blob): Promise<unknown> {
  const head = new Uint8Array(await file.slice(0, 2).arrayBuffer())
  const gzipped = head[0] === 0x1f && head[1] === 0x8b
  const text = gzipped ? await new Response(file.stream().pipeThrough(new DecompressionStream('gzip'))).text() : await file.text()
  return decode(JSON.parse(text))
}
