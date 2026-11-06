// The 2D game's play around the simulation: the welcome screen with its scenarios and goals,
// the goal card, the history book and the keys.

import { useMemo, useState, useSyncExternalStore } from 'react'
import { CIV_COLORS, ERAS } from '../engine/life'
import { Icon } from '../ui/icons'
import type { GameApi } from './host'
import { ERA_RAMP } from './render'
import { CHALLENGES, SCENARIOS, challengeById, rememberWelcome } from './goals'
import { DEFAULT_WORLD } from './world'

const civCss = (k: number) => `rgb(${CIV_COLORS[k].map((v) => Math.round(v * 255)).join(', ')})`
const useStats = (game: GameApi) => useSyncExternalStore(game.subscribe, game.getStats)
const useSettings = (game: GameApi) => useSyncExternalStore(game.subscribe, game.getSettings)

/** Pick a world to start from and a goal to play for. */
export function Welcome({ game, onClose }: { game: GameApi; onClose: () => void }) {
  const stats = useStats(game)
  const [scenario, setScenario] = useState(SCENARIOS[0].id)
  const picked = SCENARIOS.find((s) => s.id === scenario)!
  const [challenge, setChallenge] = useState<string | null>(picked.challenge ?? null)
  const start = () => {
    rememberWelcome()
    game.set({ challenge })
    // every scenario starts from the defaults (only the map size carries over), with a new seed
    const { seed: _seed, ...defaults } = DEFAULT_WORLD
    void _seed
    game.newWorld({ ...defaults, size: game.getSettings().world.size, ...picked.world })
    onClose()
  }
  return (
    <div className="welcome-backdrop" role="dialog" aria-modal="true" aria-label="Novo mundo">
      <div className="welcome glass">
        <header>
          <h1>Craftscape 2D</h1>
          <p className="muted">Um planeta inteiro nas suas mãos: placas que andam, clima que muda, povos que nascem, navegam e guerreiam. Escolha um mundo e um desafio.</p>
        </header>
        <h2>Mundo</h2>
        <div className="scenarios">
          {SCENARIOS.map((sc) => (
            <button
              key={sc.id}
              type="button"
              className={`scenario ${scenario === sc.id ? 'active' : ''}`}
              onClick={() => {
                setScenario(sc.id)
                setChallenge(sc.challenge ?? null)
              }}
            >
              <strong>{sc.name}</strong>
              <span>{sc.description}</span>
            </button>
          ))}
        </div>
        <h2>Desafio</h2>
        <div className="challenges">
          <button type="button" className={`challenge ${challenge === null ? 'active' : ''}`} onClick={() => setChallenge(null)}>
            <strong>Livre</strong>
            <span>Sem objetivo: só brincar de deus.</span>
          </button>
          {CHALLENGES.map((c) => (
            <button key={c.id} type="button" className={`challenge ${challenge === c.id ? 'active' : ''}`} onClick={() => setChallenge(c.id)}>
              <strong>
                {stats.completed.includes(c.id) && <Icon.trophy size={14} />} {c.name}
              </strong>
              <span>{c.goal}</span>
            </button>
          ))}
        </div>
        <footer>
          <a className="source" href="https://github.com/danillog/craftscape" target="_blank" rel="noreferrer">
            Código-fonte (AGPL)
          </a>
          <button type="button" onClick={onClose}>
            Continuar este mundo
          </button>
          <button type="button" className="primary" onClick={start}>
            Começar
          </button>
        </footer>
      </div>
    </div>
  )
}

/** The goal being played for: its progress, the hint, and a way to change it. */
export function ChallengeCard({ game, onChange }: { game: GameApi; onChange: () => void }) {
  const stats = useStats(game)
  const st = stats.challenge
  const c = challengeById(st?.id ?? null)
  if (!st || !c) return null
  const pct = Math.round(st.progress * 100)
  return (
    <div className={`challenge-card glass ${st.done ? 'done' : ''}`}>
      <div className="challenge-head">
        <Icon.trophy size={16} />
        <strong>{c.name}</strong>
        <span className="muted">{st.done ? 'cumprido!' : `${pct}%`}</span>
        <button type="button" className="icon tiny" onClick={onChange} aria-label="Trocar de desafio" data-tip="Trocar de desafio">
          ⋯
        </button>
      </div>
      <span className="goal">{c.goal}</span>
      <span className="bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <span className="fill" style={{ width: `${pct}%` }} />
      </span>
      {!st.done && <span className="hint">{c.hint}</span>}
    </div>
  )
}

/**
 * The history book: every people's life as a lane across the years (its population drawn
 * as the lane's thickness), and the big moments, newest first, each with a way to see where.
 */
export function HistoryPanel({ game }: { game: GameApi }) {
  const stats = useStats(game)
  const s = useSettings(game)
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
      rows: life.lineage
        .map((civ) => {
          const pts = hist.map((h) => [h.year, h.people.find(([id]) => id === civ.id)?.[1] ?? 0] as [number, number])
          const alive = pts.filter(([, p]) => p > 0)
          return alive.length ? { civ, pts, from: alive[0][0], to: alive[alive.length - 1][0] } : null
        })
        .filter((r): r is NonNullable<typeof r> => r !== null)
        .slice(-14),
      peak,
    }
  }, [life])
  const [filter, setFilter] = useState('')
  const annals = stats.annals.filter((e) => !filter || e.text.toLowerCase().includes(filter.toLowerCase()))
  const W = 288
  const ROW = 18
  return (
    <div className="panel-body">
      <h2>História</h2>
      {!s.life && <p className="hint">Ligue a vida na aba Vida para que os povos façam história.</p>}
      {lanes && (
        <figure className="lanes">
          <svg viewBox={`0 0 ${W} ${lanes.rows.length * ROW + 16}`} role="img" aria-label="A vida de cada povo ao longo dos anos">
            {lanes.rows.map((r, k) => {
              const sx = (y: number) => 4 + ((y - lanes.first) / Math.max(lanes.last - lanes.first, 1)) * (W - 8)
              const mid = k * ROW + ROW / 2
              const top = r.pts.map(([y, p]) => `${sx(y).toFixed(1)},${(mid - (p / lanes.peak) * (ROW / 2 - 2) - 0.6).toFixed(1)}`)
              const bottom = r.pts.map(([y, p]) => `${sx(y).toFixed(1)},${(mid + (p / lanes.peak) * (ROW / 2 - 2) + 0.6).toFixed(1)}`).reverse()
              return (
                <g key={r.civ.id}>
                  <title>{`${r.civ.name}: do ano ${r.from} ao ano ${r.to}, até ${Math.max(...r.pts.map(([, p]) => p))} pessoas`}</title>
                  <polygon points={[...top, ...bottom].join(' ')} fill={civCss(r.civ.color)} opacity={0.85} />
                  {/* its eras: a strip under the lane, light (Stone Age) to dark (Modern) */}
                  {(stats.eraLog[r.civ.id] ?? []).map(([year, era], j, log) => {
                    const end = j + 1 < log.length ? log[j + 1][0] : r.to
                    const x0 = sx(Math.max(year, lanes.first))
                    const x1 = sx(Math.min(end, lanes.last))
                    if (x1 <= x0) return null
                    return (
                      <rect key={year} x={x0} y={k * ROW + ROW - 3} width={x1 - x0} height={2.5} fill={`rgb(${ERA_RAMP[era].join(' ')})`}>
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
          <figcaption className="hint">A espessura é a população de cada povo; a faixa fina embaixo é a era (clara: Idade da Pedra, escura: Era Moderna). A faixa some quando o povo desaparece.</figcaption>
          <ul className="legend era-legend">
            {ERAS.map((e, k) => (
              <li key={e.name}>
                <span className="swatch" style={{ background: `rgb(${ERA_RAMP[k].join(' ')})` }} /> {e.name}
              </li>
            ))}
          </ul>
        </figure>
      )}
      <input className="search" placeholder="Procurar na história…" value={filter} onChange={(e) => setFilter(e.target.value)} />
      {annals.length === 0 ? (
        <p className="hint">Os grandes momentos aparecem aqui: eras, guerras, catástrofes, continentes que se partem.</p>
      ) : (
        <ul className="chronicle annals">
          {annals.map((e) => (
            <li key={e.id} className="major">
              <span className="swatch" style={{ background: e.color === null ? 'rgb(124 196 255)' : civCss(e.color) }} />
              <span>
                <span className="muted">ano {e.year} · </span>
                {e.text}
              </span>
              {e.pos && (
                <button type="button" className="icon tiny" onClick={() => game.flyTo(e.pos!)} aria-label="Ver onde">
                  <Icon.eye size={14} />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <p className="hint">As eras: {ERAS.map((e) => e.name).join(' → ')}.</p>
    </div>
  )
}

const KEYS: [string, string][] = [
  ['WASD / setas', 'mover o mapa (Shift: mais rápido)'],
  ['roda do mouse', 'zoom (Shift + roda: tamanho do pincel)'],
  ['0 – 9, F, V, M, B, G, H, U, Y', 'ferramentas da Terra, Bênçãos e Pragas (H: terremoto, U: guerra nuclear, Y: furacão)'],
  ['7, J, K, L, N, Q, E', 'poderes sobre os povos: povo, bênção, inspiração, peste, profeta, discórdia, paz'],
  ['X', 'alternar + / −'],
  ['[ ]', 'tamanho do pincel'],
  ['P ou espaço', 'pausar'],
  ['Ctrl + Z', 'desfazer'],
  ['O / Shift + O', 'trocar o mapa'],
  ['I', 'satélite / ilustrado'],
  ['T', 'setas de vento'],
  ['R', 'enquadrar o mundo'],
  ['?', 'esta ajuda'],
]

export function HelpOverlay({ onClose, onTour }: { onClose: () => void; onTour: () => void }) {
  return (
    <div className="welcome-backdrop" role="dialog" aria-modal="true" aria-label="Atalhos" onClick={onClose}>
      <div className="help glass" onClick={(e) => e.stopPropagation()}>
        <h2>Atalhos</h2>
        <dl>
          {KEYS.map(([k, v]) => (
            <div key={k}>
              <dt>
                <kbd>{k}</kbd>
              </dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
        <p className="hint">Toda ferramenta funciona segurando e arrastando. Os poderes sobre os povos agem na cidade mais perto do clique.</p>
        <p className="hint">
          Baseado no <a href="https://github.com/pyalot/craftscape" target="_blank" rel="noreferrer">Craftscape original</a> de Florian Boesch.{' '}
          <a href="https://github.com/danillog/craftscape" target="_blank" rel="noreferrer">Código-fonte (AGPL)</a>.
        </p>
        <button type="button" onClick={onTour}>
          Rever os primeiros passos
        </button>
        <button type="button" className="primary" onClick={onClose}>
          Fechar
        </button>
      </div>
    </div>
  )
}
