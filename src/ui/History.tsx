import { useMemo, useState } from 'react'
import type { Engine } from '../engine/engine'
import { ERAS } from '../engine/life'
import { ERA_RAMP, rgbCss } from '../engine/palettes'
import { civCss } from './constants'
import { useSettings, useStats } from './useEngine'

const W = 288
const ROW = 18

/**
 * The history book: every people's life as a lane across the years (its population drawn
 * as the lane's thickness, its eras as a strip under it), and the great moments, newest
 * first; a click on one flies the camera to where it happened.
 */
export function HistoryBook({ engine }: { engine: Engine }) {
  const stats = useStats(engine)
  const s = useSettings(engine)
  const life = stats.life
  const lanes = useMemo(() => {
    if (!life || life.history.length < 2) return null
    const hist = life.history
    const first = hist[0].year
    const last = hist[hist.length - 1].year
    let peak = 1
    for (const h of hist) for (const [, p] of h.people) peak = Math.max(peak, p)
    return {
      first,
      last,
      peak,
      rows: life.lineage
        .map((civ) => {
          const pts = hist.map((h) => [h.year, h.people.find(([id]) => id === civ.id)?.[1] ?? 0] as [number, number])
          const alive = pts.filter(([, p]) => p > 0)
          return alive.length ? { civ, pts, from: alive[0][0], to: alive[alive.length - 1][0] } : null
        })
        .filter((r): r is NonNullable<typeof r> => r !== null)
        .slice(-14),
    }
  }, [life])
  const [filter, setFilter] = useState('')
  const annals = stats.annals.filter((e) => !filter || e.text.toLowerCase().includes(filter.toLowerCase()))
  return (
    <>
      {!s.life && <p className="hint">Ligue a vida na aba Vida para que os povos façam história.</p>}
      {lanes && (
        <figure className="lanes">
          <svg viewBox={`0 0 ${W} ${lanes.rows.length * ROW + 16}`} role="img" aria-label="A vida de cada povo ao longo dos anos">
            {lanes.rows.map((r, k) => {
              const sx = (y: number) => 4 + ((y - lanes.first) / Math.max(lanes.last - lanes.first, 1)) * (W - 8)
              const mid = k * ROW + ROW / 2
              const half = (p: number) => (p / lanes.peak) * (ROW / 2 - 2) + 0.6
              const top = r.pts.map(([y, p]) => `${sx(y).toFixed(1)},${(mid - half(p)).toFixed(1)}`)
              const bottom = r.pts.map(([y, p]) => `${sx(y).toFixed(1)},${(mid + half(p)).toFixed(1)}`).reverse()
              return (
                <g key={r.civ.id}>
                  <title>{`${r.civ.name}: do ano ${r.from} ao ano ${r.to}, até ${Math.max(...r.pts.map(([, p]) => p))} pessoas`}</title>
                  <polygon points={[...top, ...bottom].join(' ')} fill={civCss(r.civ.color)} opacity={0.85} />
                  {(stats.eraLog[r.civ.id] ?? []).map(([year, era], j, log) => {
                    const end = j + 1 < log.length ? log[j + 1][0] : r.to
                    const x0 = sx(Math.max(year, lanes.first))
                    const x1 = sx(Math.min(end, lanes.last))
                    if (x1 <= x0) return null
                    return (
                      <rect key={year} x={x0} y={k * ROW + ROW - 3} width={x1 - x0} height={2.5} fill={rgbCss(ERA_RAMP[era])}>
                        <title>{`${r.civ.name}: ${ERAS[era].name} a partir do ano ${year}`}</title>
                      </rect>
                    )
                  })}
                  <text x={sx(r.from) + 2} y={mid - 4} className="lane-name">
                    {r.civ.name}
                  </text>
                </g>
              )
            })}
            <text x={4} y={lanes.rows.length * ROW + 12} className="axis">
              ano {lanes.first}
            </text>
            <text x={W - 4} y={lanes.rows.length * ROW + 12} className="axis" textAnchor="end">
              ano {lanes.last}
            </text>
          </svg>
          <figcaption className="hint">
            A espessura é a população de cada povo; a faixa fina embaixo é a era (clara: Idade da Pedra, escura: Era
            Moderna). A faixa acaba quando o povo desaparece.
          </figcaption>
          <ul className="legend">
            {ERAS.map((e, k) => (
              <li key={e.name}>
                <span className="swatch" style={{ background: rgbCss(ERA_RAMP[k]) }} />
                {e.name}
              </li>
            ))}
          </ul>
        </figure>
      )}
      <input className="search" placeholder="Procurar na história…" value={filter} onChange={(e) => setFilter(e.target.value)} />
      {annals.length === 0 ? (
        <p className="hint">Os grandes momentos aparecem aqui: eras, guerras, catástrofes, povos que nascem e somem.</p>
      ) : (
        <ul className="chronicle annals">
          {annals.map((e, k) => (
            <li key={`${k}:${e.text}`} className="major">
              <span className="swatch" style={{ background: civCss(e.color) }} />
              {e.pos ? (
                <button type="button" className="annal" onClick={() => engine.flyTo(e.pos!)} data-tip="Ver onde foi">
                  <span className="muted">{e.year} · </span>
                  {e.text}
                </button>
              ) : (
                <span>
                  <span className="muted">{e.year} · </span>
                  {e.text}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  )
}
