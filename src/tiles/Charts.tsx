import { useState } from 'react'
import type { YearRecord } from './game'

/** One measure of the world's record: its name, unit, how to read it from a year, how many decimals. */
interface Measure {
  key: string
  title: string
  unit: string
  get: (r: YearRecord) => number
  digits: number
}

const MEASURES: Measure[] = [
  { key: 'temp', title: 'Temperatura média', unit: '°C', get: (r) => r.temperature, digits: 1 },
  { key: 'co2', title: 'CO₂ na atmosfera', unit: 'ppm', get: (r) => r.co2, digits: 0 },
  { key: 'sea', title: 'Nível do mar', unit: 'm', get: (r) => r.sea, digits: 1 },
  { key: 'pop', title: 'População', unit: 'pessoas', get: (r) => r.population, digits: 0 },
]

const W = 288
const H = 92
const PAD = { left: 4, right: 4, top: 8, bottom: 16 }

const number = (v: number, digits: number) => v.toLocaleString('pt-BR', { minimumFractionDigits: digits, maximumFractionDigits: digits })

/**
 * The world's record as small multiples: one line chart per measure (each its own scale,
 * never two on one axis), the newest value as the headline, a crosshair with the year and
 * the value under the pointer, and the numbers as a table for reading without hovering.
 */
export function Charts({ history }: { history: YearRecord[] }) {
  if (history.length < 2) return <p className="hint">Os gráficos aparecem depois do primeiro ano.</p>
  return (
    <div className="charts">
      {MEASURES.map((m) => (
        <Chart key={m.key} measure={m} history={history} />
      ))}
      <details className="chart-table">
        <summary>Ver tabela</summary>
        <table>
          <thead>
            <tr>
              <th>Ano</th>
              {MEASURES.map((m) => (
                <th key={m.key}>
                  {m.title} ({m.unit})
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {history
              .slice(-12)
              .reverse()
              .map((r) => (
                <tr key={r.year}>
                  <td>{r.year}</td>
                  {MEASURES.map((m) => (
                    <td key={m.key}>{number(m.get(r), m.digits)}</td>
                  ))}
                </tr>
              ))}
          </tbody>
        </table>
      </details>
    </div>
  )
}

function Chart({ measure, history }: { measure: Measure; history: YearRecord[] }) {
  const [hover, setHover] = useState<number | null>(null)
  const values = history.map(measure.get)
  let lo = Math.min(...values)
  let hi = Math.max(...values)
  // a flat series still gets some room, so a tiny wobble is not blown up to the full height
  const span = Math.max(hi - lo, Math.abs(hi) * 0.02, measure.digits ? 0.2 : 2)
  const mid = (hi + lo) / 2
  lo = mid - span * 0.55
  hi = mid + span * 0.55
  const x0 = history[0].year
  const x1 = history[history.length - 1].year
  const sx = (year: number) => PAD.left + ((year - x0) / Math.max(x1 - x0, 1)) * (W - PAD.left - PAD.right)
  const sy = (v: number) => PAD.top + (1 - (v - lo) / (hi - lo)) * (H - PAD.top - PAD.bottom)
  const path = history.map((r, k) => `${k ? 'L' : 'M'}${sx(r.year).toFixed(1)},${sy(values[k]).toFixed(1)}`).join('')
  const last = values[values.length - 1]
  const first = values[0]
  const shown = hover ?? history.length - 1
  const pick = (clientX: number, rect: DOMRect) => {
    const x = ((clientX - rect.left) / rect.width) * W
    const year = x0 + ((x - PAD.left) / (W - PAD.left - PAD.right)) * (x1 - x0)
    let best = 0
    for (let k = 1; k < history.length; k++) if (Math.abs(history[k].year - year) < Math.abs(history[best].year - year)) best = k
    setHover(best)
  }
  const change = last - first
  return (
    <figure className="chart">
      <figcaption>
        <span className="chart-title">{measure.title}</span>
        <span className="chart-value">
          {number(values[shown], measure.digits)} <small>{measure.unit}</small>
        </span>
        <span className="chart-sub">
          {hover !== null ? `ano ${history[shown].year}` : `${change >= 0 ? '+' : '−'}${number(Math.abs(change), measure.digits)} desde o ano ${x0}`}
        </span>
      </figcaption>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`${measure.title}: de ${number(first, measure.digits)} a ${number(last, measure.digits)} ${measure.unit}, anos ${x0} a ${x1}`}
        tabIndex={0}
        onPointerMove={(e) => pick(e.clientX, e.currentTarget.getBoundingClientRect())}
        onPointerLeave={() => setHover(null)}
        onBlur={() => setHover(null)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft') setHover(Math.max(0, (hover ?? history.length - 1) - 1))
          else if (e.key === 'ArrowRight') setHover(Math.min(history.length - 1, (hover ?? history.length - 1) + 1))
        }}
      >
        {/* recessive grid: the top, middle and bottom of the scale */}
        {[lo + (hi - lo) * 0.1, mid, hi - (hi - lo) * 0.1].map((v) => (
          <line key={v} className="grid" x1={PAD.left} x2={W - PAD.right} y1={sy(v)} y2={sy(v)} />
        ))}
        <path className="line" d={path} />
        <circle className="dot" cx={sx(history[shown].year)} cy={sy(values[shown])} r={3.5} />
        {hover !== null && <line className="cross" x1={sx(history[shown].year)} x2={sx(history[shown].year)} y1={PAD.top} y2={H - PAD.bottom} />}
        <text className="axis" x={PAD.left} y={H - 3}>
          {x0}
        </text>
        <text className="axis" x={W - PAD.right} y={H - 3} textAnchor="end">
          {x1}
        </text>
      </svg>
    </figure>
  )
}
