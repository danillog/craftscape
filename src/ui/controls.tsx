import type { ReactNode } from 'react'
import type { ClimateReport } from '../engine/settings'
import { BIOMES, compass } from './constants'

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="section">
      <h2>{title}</h2>
      {children}
    </section>
  )
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  wrap = false,
}: {
  value: T
  options: { id: T; label: string; hint?: string }[]
  onChange: (v: T) => void
  wrap?: boolean
}) {
  return (
    <div className={wrap ? 'segmented wrap' : 'segmented'} role="radiogroup">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          role="radio"
          aria-checked={value === o.id}
          className={value === o.id ? 'active' : ''}
          onClick={() => onChange(o.id)}
          title={o.hint}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Slider(props: {
  label: string
  value: number
  min: number
  max: number
  step: number
  format: (v: number) => string
  onChange: (v: number) => void
}) {
  return (
    <label className="slider">
      <span className="slider-label">
        {props.label}
        <output>{props.format(props.value)}</output>
      </span>
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        onChange={(e) => props.onChange(Number(e.target.value))}
      />
    </label>
  )
}

export function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string
  checked: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  )
}

export function ClimateAnalysis({ report: r }: { report: ClimateReport }) {
  const shares = BIOMES.map(([name, color], k) => ({ name, color, share: r.biomes[k] }))
    .filter((b) => b.share >= 0.005)
    .sort((a, b) => b.share - a.share)
  return (
    <>
      <dl className="analysis">
        <dt>Temperatura</dt>
        <dd>
          {r.meanTemp.toFixed(1)} °C{' '}
          <span className="muted">
            ({r.minTemp.toFixed(0)} a {r.maxTemp.toFixed(0)})
          </span>
        </dd>
        <dt>Chuva média</dt>
        <dd>{r.rain.toFixed(2)}×</dd>
        <dt>Umidade do ar</dt>
        <dd>{Math.round(r.humidity * 100)}%</dd>
        <dt>Vento médio</dt>
        <dd>{r.windSpeed < 0.05 ? 'calmo' : `${compass(r.windDirection)}, ${r.windSpeed.toFixed(1)}`}</dd>
        <dt>Sistemas</dt>
        <dd>
          {r.lows} {r.lows === 1 ? 'baixa' : 'baixas'} · {r.highs} {r.highs === 1 ? 'alta' : 'altas'}
        </dd>
      </dl>
      <div className="biome-bar" title="Biomas na área simulada">
        {shares.map((b) => (
          <span
            key={b.name}
            style={{ background: b.color, flexGrow: b.share }}
            title={`${b.name}: ${Math.round(b.share * 100)}%`}
          />
        ))}
      </div>
      <ul className="legend">
        {shares.slice(0, 4).map((b) => (
          <li key={b.name}>
            <span className="swatch" style={{ background: b.color }} />
            {b.name} {Math.round(b.share * 100)}%
          </li>
        ))}
      </ul>
    </>
  )
}
