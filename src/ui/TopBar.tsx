import { useState } from 'react'
import type { Engine } from '../engine/engine'
import { scenarioById } from '../engine/scenarios'
import { clockOf } from '../engine/sky'
import { Icon } from './icons'
import { useSettings, useStats } from './useEngine'

export function TopBar({ engine, onNewWorld }: { engine: Engine; onNewWorld: () => void }) {
  const s = useSettings(engine)
  return (
    <header className="topbar">
      <div className="brand glass">
        <span className="brand-mark" aria-hidden="true" />
        <div>
          <h1>Craftscape</h1>
          <span className="brand-sub">{scenarioById(s.scenario).name}</span>
        </div>
      </div>
      <div className="top-actions glass">
        <button type="button" className="pill" onClick={onNewWorld} data-tip="Escolher um cenário">
          <Icon.sparkles size={18} />
          <span>Novo mundo</span>
        </button>
        <a className="pill" href="2d.html" data-tip="A versão 2D, de tiles, que roda sem GPU">
          <Icon.map size={18} />
          <span>2D</span>
        </a>
        <button type="button" className="pill" onClick={() => engine.set({ photoMode: true })} data-tip="Modo foto (K)">
          <Icon.camera size={18} />
          <span>Foto</span>
        </button>
        <button
          type="button"
          className="icon-button"
          onClick={() => engine.set({ showHelp: true })}
          data-tip="Atalhos (H)"
          aria-label="Atalhos"
        >
          <Icon.help size={20} />
        </button>
      </div>
    </header>
  )
}

/** Time of day (and season in automatic climate) under the compass. */
export function ClockChip({ engine }: { engine: Engine }) {
  const s = useSettings(engine)
  const stats = useStats(engine)
  const day = s.timeOfDay > 0.25 && s.timeOfDay < 0.75
  return (
    <div className="clock-chip glass" data-tip={s.dayNight ? 'O dia passa com a simulação' : 'Hora fixa'}>
      {day ? <Icon.sun size={16} /> : <Icon.moon size={16} />}
      <span>{clockOf(s.timeOfDay)}</span>
      {stats.season && <span className="muted">· {stats.season.name}</span>}
    </div>
  )
}

/** Compact performance readout; click for the details. */
export function StatusChip({ engine }: { engine: Engine }) {
  const stats = useStats(engine)
  const s = useSettings(engine)
  const [open, setOpen] = useState(false)
  // judged against the frame limit: 30 fps under a 30 fps limit is as good as it gets
  const goal = s.fpsLimit > 0 ? Math.min(s.fpsLimit, 60) : 60
  const tone = stats.fps >= goal * 0.75 ? 'good' : stats.fps >= goal * 0.4 ? 'ok' : 'bad'
  return (
    <button type="button" className={`status-chip glass ${open ? 'open' : ''}`} onClick={() => setOpen(!open)}>
      <span className={`dot ${tone}`} />
      <span>{stats.fps.toFixed(0)} fps</span>
      {open && (
        <span className="status-details">
          <span>{stats.frameMs.toFixed(1)} ms</span>
          <span>{s.paused ? 'pausado' : `${stats.simStepsPerSec.toFixed(0)} passos/s`}</span>
          <span>{stats.resolution}²</span>
          {s.infiniteWorld && (
            <span>
              região {stats.region[0]}, {stats.region[1]}
            </span>
          )}
          <span className="adapter">{stats.adapter}</span>
        </span>
      )}
    </button>
  )
}
