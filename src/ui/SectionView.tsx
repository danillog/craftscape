import { useEffect, useRef, useState } from 'react'
import type { Engine } from '../engine/engine'
import { METERS_PER_HEIGHT } from '../engine/settings'
import { stratumColor, stratumOf } from '../engine/strata'
import { Icon } from './icons'

const HEIGHT = 190
const SOIL: [number, number, number] = [0.42, 0.3, 0.19]
const SAND: [number, number, number] = [0.86, 0.75, 0.5]
const WATER: [number, number, number] = [0.2, 0.5, 0.85]

type Section = Awaited<ReturnType<Engine['readSection']>>

/** Draws one row of the window from the side: rock in its strata, soil, sand and water. */
function draw(canvas: HTMLCanvasElement, s: Section) {
  const n = s.size
  canvas.width = n
  canvas.height = HEIGHT
  const ctx = canvas.getContext('2d')!
  const image = ctx.createImageData(n, HEIGHT)
  let lo = Infinity
  let hi = -Infinity
  for (let x = 0; x < n; x++) {
    const g = s.ground[x * 4]
    lo = Math.min(lo, s.ground[x * 4 + 1])
    hi = Math.max(hi, g + s.water[x * 4])
  }
  const pad = (hi - lo) * 0.08 + 0.002
  lo -= pad
  hi += pad
  const heightAt = (py: number) => hi - ((py + 0.5) / HEIGHT) * (hi - lo)
  const v = (s.row + 0.5) / n
  for (let x = 0; x < n; x++) {
    const rock = s.ground[x * 4 + 1]
    const soil = rock + s.ground[x * 4 + 2]
    const sand = soil + s.ground[x * 4 + 3]
    const surface = s.ground[x * 4]
    const water = surface + s.water[x * 4]
    const wx = ((x + 0.5) / n + s.origin[0] / n) * s.extent
    const wy = (v + s.origin[1] / n) * s.extent
    for (let py = 0; py < HEIGHT; py++) {
      const h = heightAt(py)
      let c: [number, number, number] | null = null
      if (h <= rock) c = stratumColor(stratumOf(wx, wy, h, s.seed))
      else if (h <= soil) c = SOIL
      else if (h <= Math.max(sand, surface)) c = SAND
      else if (h <= water && water - surface > 0.0002) c = WATER
      if (!c) continue
      const at = (py * n + x) * 4
      image.data[at] = c[0] * 255
      image.data[at + 1] = c[1] * 255
      image.data[at + 2] = c[2] * 255
      image.data[at + 3] = 255
    }
  }
  ctx.putImageData(image, 0, 0)
  return { lo, hi }
}

/** Bottom panel: a west–east cut through the terrain under the cursor (or the middle). */
export function SectionView({ engine, onClose }: { engine: Engine; onClose: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const [range, setRange] = useState<{ lo: number; hi: number } | null>(null)

  useEffect(() => {
    let alive = true
    let timer = 0
    const refresh = async () => {
      try {
        const section = await engine.readSection()
        if (alive && canvas.current) setRange(draw(canvas.current, section))
      } catch {
        // simulation replaced mid-read: next time
      }
      if (alive) timer = window.setTimeout(refresh, 700)
    }
    void refresh()
    return () => {
      alive = false
      window.clearTimeout(timer)
    }
  }, [engine])

  const m = (h: number) => `${Math.round((h * METERS_PER_HEIGHT) / 10) * 10} m`
  return (
    <div className="section-view glass">
      <header>
        <strong>Corte transversal</strong>
        <span className="muted">oeste → leste, na linha do cursor · camadas de rocha, solo, areia e água</span>
        <button type="button" className="icon ghost" onClick={onClose} aria-label="Fechar corte">
          <Icon.close size={18} />
        </button>
      </header>
      <div className="section-plot">
        <canvas ref={canvas} />
        {range && (
          <>
            <span className="axis top">{m(range.hi)}</span>
            <span className="axis bottom">{m(range.lo)}</span>
          </>
        )}
      </div>
    </div>
  )
}
