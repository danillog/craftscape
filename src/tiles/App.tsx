import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { CIV_COLORS, type LifeEvent } from '../engine/life'
import { BIOMES } from '../ui/constants'
import { Icon } from '../ui/icons'
import { Game, type Tool2d } from './game'
import { OVERLAYS_2D, type Overlay2d } from './render'
import './tiles.css'

const civCss = (k: number) => `rgb(${CIV_COLORS[k].map((v) => Math.round(v * 255)).join(', ')})`
const useSettings = (game: Game) => useSyncExternalStore(game.subscribe, game.getSettings)
const useStats = (game: Game) => useSyncExternalStore(game.subscribe, game.getStats)

type Group = 'terra' | 'bencao' | 'praga'
const GROUP_NAMES: Record<Group, string> = { terra: 'Terra', bencao: 'Bênçãos', praga: 'Pragas' }
const TOOLS: { id: Tool2d; label: string; key: string; hint: string; group: Group; icon: keyof typeof Icon }[] = [
  { id: 'inspect', label: 'Olhar', key: '0', hint: 'Arraste para mover o mapa; clique numa cidade para acompanhá-la', group: 'terra', icon: 'inspect' },
  { id: 'terrain', label: 'Terreno', key: '1', hint: 'Levanta montanhas (−: cava vales e mar)', group: 'terra', icon: 'rock' },
  { id: 'water', label: 'Água', key: '2', hint: 'Enche lagos (−: seca)', group: 'terra', icon: 'water' },
  { id: 'forest', label: 'Floresta', key: '3', hint: 'Planta mato e floresta (−: desmata)', group: 'terra', icon: 'tree' },
  { id: 'rain', label: 'Chuva', key: '4', hint: 'Ar úmido: nuvens e chuva aqui (−: seca o ar)', group: 'bencao', icon: 'humidity' },
  { id: 'heat', label: 'Calor', key: '5', hint: 'Esquenta a região para sempre (−: esfria)', group: 'bencao', icon: 'heat' },
  { id: 'sun', label: 'Sol', key: '6', hint: 'Clique: o planeta inteiro esquenta 1 °C (−: esfria 1 °C)', group: 'bencao', icon: 'sun' },
  { id: 'people', label: 'Povo', key: '7', hint: 'Clique: um povo novo nasce aqui', group: 'bencao', icon: 'life' },
  { id: 'drought', label: 'Seca', key: '8', hint: 'Clique: uma alta pressão fixa trava a chuva na região (−: apaga a seca)', group: 'praga', icon: 'drought' },
  { id: 'storm', label: 'Tempestade', key: '9', hint: 'Clique: um ciclone que o vento leva, chovendo por onde passa', group: 'praga', icon: 'storm' },
  { id: 'fire', label: 'Fogo', key: 'F', hint: 'Clique: acende o mato; o fogo corre com o vento e a chuva apaga', group: 'praga', icon: 'fire' },
  { id: 'volcano', label: 'Vulcão', key: 'V', hint: 'Clique: abre um vulcão; a lava desce e vira rocha', group: 'praga', icon: 'volcano' },
  { id: 'meteor', label: 'Meteoro', key: 'M', hint: 'Clique: cratera, fogo e poeira que esfria o planeta (o pincel dá o tamanho)', group: 'praga', icon: 'meteor' },
]
const MODE_LABELS: Partial<Record<Tool2d, [string, string]>> = {
  sun: ['Esquentar 1 °C', 'Esfriar 1 °C'],
  drought: ['Decretar seca', 'Apagar seca'],
  terrain: ['Levantar', 'Cavar'],
  water: ['Encher', 'Secar'],
  forest: ['Plantar', 'Desmatar'],
  rain: ['Umedecer', 'Secar o ar'],
  heat: ['Esquentar', 'Esfriar'],
}
const NO_MODE: Tool2d[] = ['inspect', 'people', 'storm', 'fire', 'volcano', 'meteor']
const NO_BRUSH: Tool2d[] = ['inspect', 'sun', 'people', 'volcano']

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [game, setGame] = useState<Game | null>(null)
  useEffect(() => {
    const g = new Game(canvasRef.current!)
    g.start()
    setGame(g)
    Object.assign(window, { craftscape2d: g })
    return () => g.dispose()
  }, [])
  return (
    <div className="app2d">
      <canvas ref={canvasRef} className="map" />
      {game && <Interface game={game} />}
    </div>
  )
}

function Interface({ game }: { game: Game }) {
  const s = useSettings(game)
  const stats = useStats(game)
  const [tab, setTab] = useState<'life' | 'map' | 'world' | null>('life')
  const overlayName = OVERLAYS_2D.find((o) => o.id === s.overlay)?.label ?? ''
  const current = TOOLS.find((t) => t.id === s.tool)!
  const [addLabel, removeLabel] = MODE_LABELS[s.tool] ?? ['Adicionar', 'Remover']
  const year = stats.life ? stats.life.year : Math.floor(stats.simTime / 10)
  return (
    <>
      <header className="topbar glass">
        <strong>Craftscape 2D</strong>
        <span className="muted">
          ano {year}
          {stats.life && ` · ${stats.life.people} pessoas · ${stats.life.villages} cidades · ${stats.life.civs.length} povos`}
        </span>
        <span className="spacer" />
        <div className="speeds" role="group" aria-label="Velocidade">
          <button type="button" className={s.paused ? 'active' : ''} onClick={() => game.set({ paused: !s.paused })} data-tip="Pausa (P)">
            {s.paused ? <Icon.play size={16} /> : <Icon.pause size={16} />}
          </button>
          {[1, 2, 4, 8].map((v) => (
            <button key={v} type="button" className={!s.paused && s.speed === v ? 'active' : ''} onClick={() => game.set({ speed: v, paused: false })}>
              {v}×
            </button>
          ))}
        </div>
        <button type="button" onClick={() => game.newWorld()} data-tip="Um mundo novo com outra semente">
          <Icon.refresh size={16} /> Novo mundo
        </button>
        {s.overlay !== 'none' && (
          <button type="button" className="active" onClick={() => setTab('map')} data-tip="O mapa mostrado (O troca)">
            <Icon.layers size={16} /> {overlayName}
          </button>
        )}
        <button type="button" onClick={() => game.fit()} data-tip="Enquadra o mundo inteiro (R)">
          <Icon.map size={16} />
        </button>
        <a className="button" href="/" data-tip="A versão 3D (precisa de WebGPU)">
          3D
        </a>
        <span className="fps muted">{Math.round(stats.fps)} fps</span>
      </header>

      <aside className="powers glass">
        {(['terra', 'bencao', 'praga'] as Group[]).map((group) => (
          <div key={group} className={`group group-${group}`}>
            <span className="group-name">{GROUP_NAMES[group]}</span>
            {TOOLS.filter((t) => t.group === group).map((t) => {
              const ToolIcon = Icon[t.icon]
              return (
                <button
                  key={t.id}
                  type="button"
                  className={`tool ${s.tool === t.id ? 'active' : ''}`}
                  onClick={() => game.set({ tool: t.id })}
                  data-tip={`${t.label} · ${t.hint}`}
                >
                  <ToolIcon size={20} />
                  <kbd>{t.key}</kbd>
                </button>
              )
            })}
          </div>
        ))}
        <div className="tool-meta">
          <strong>{current.label}</strong>
          {!NO_MODE.includes(s.tool) && (
            <div className="mode-switch" role="radiogroup">
              <button type="button" className={s.mode === 'add' ? 'active' : ''} onClick={() => game.set({ mode: 'add' })} data-tip={`${addLabel} (X alterna)`}>
                +
              </button>
              <button type="button" className={s.mode === 'remove' ? 'active' : ''} onClick={() => game.set({ mode: 'remove' })} data-tip={`${removeLabel} (X alterna)`}>
                −
              </button>
            </div>
          )}
          {!NO_BRUSH.includes(s.tool) && (
            <label className="mini-slider" data-tip="Tamanho do pincel ( [ ] ou Shift + roda )">
              <span>Tamanho</span>
              <input type="range" min={1} max={40} step={1} value={s.brushSize} onChange={(e) => game.set({ brushSize: Number(e.target.value) })} />
            </label>
          )}
          <p className="hint">{current.hint}</p>
        </div>
      </aside>

      <nav className="tabs glass">
        <button type="button" className={tab === 'life' ? 'active' : ''} onClick={() => setTab(tab === 'life' ? null : 'life')}>
          <Icon.life size={18} /> Vida
        </button>
        <button type="button" className={tab === 'map' ? 'active' : ''} onClick={() => setTab(tab === 'map' ? null : 'map')}>
          <Icon.layers size={18} /> Mapa
        </button>
        <button type="button" className={tab === 'world' ? 'active' : ''} onClick={() => setTab(tab === 'world' ? null : 'world')}>
          <Icon.globe size={18} /> Mundo
        </button>
      </nav>
      {tab && (
        <aside className="panel glass">
          {tab === 'life' ? <LifePanel game={game} /> : tab === 'map' ? <MapPanel game={game} /> : <WorldPanel game={game} />}
        </aside>
      )}

      <EventCards game={game} />
      {stats.tile && <TileCard game={game} />}
      {stats.message && (
        <div className="toast" role="alert">
          <span>{stats.message}</span>
          <button type="button" className="icon" onClick={() => game.notice(null)} aria-label="Fechar">
            ×
          </button>
        </div>
      )}
    </>
  )
}

function LifePanel({ game }: { game: Game }) {
  const s = useSettings(game)
  const stats = useStats(game)
  const life = stats.life
  const percent = (v: number) => `${Math.round(v * 100)}%`
  return (
    <div className="panel-body">
      <h2>Vida</h2>
      <label className="toggle">
        <input type="checkbox" checked={s.life} onChange={(e) => game.set({ life: e.target.checked })} /> Manadas e civilizações
      </label>
      <label className="toggle">
        <input type="checkbox" checked={s.territory} onChange={(e) => game.set({ territory: e.target.checked })} /> Mapa político
      </label>
      <label className="toggle">
        <input type="checkbox" checked={s.followEvents} onChange={(e) => game.set({ followEvents: e.target.checked })} /> Seguir os acontecimentos
      </label>
      {life?.selected && (
        <div className="town-card">
          <header>
            <span className="swatch" style={{ background: civCss(life.selected.color) }} />
            <strong>{life.selected.name}</strong>
            <span className="muted">{life.selected.civ}</span>
          </header>
          <p className="hint">
            {life.selected.people} pessoas · {life.selected.status}. {life.selected.trend}.{life.selected.capital ? ' É a capital.' : ''}
          </p>
          <ul className="bars">
            <li><span>Comida</span><Bar value={life.selected.needs.food} /></li>
            <li><span>Umidade</span><Bar value={life.selected.needs.moist} /></li>
            <li><span>Clima</span><Bar value={1 - Math.min(1, life.selected.needs.hardship * 4)} label={`${life.selected.needs.temperature.toFixed(0)} °C`} /></li>
            <li><span>Celeiro</span><Bar value={life.selected.needs.granary} /></li>
            <li><span>Tecnologia</span><Bar value={life.selected.tech} /></li>
          </ul>
        </div>
      )}
      {life && (
        <>
          <p className="hint">
            <strong>Ano {life.year}.</strong> {life.herds} manadas, {life.villages} cidades, {life.people} pessoas.
            {life.ending && <strong> {life.ending}</strong>}
          </p>
          {life.civs.length > 0 && (
            <ul className="civs">
              {life.civs.map((c) => (
                <li key={c.id}>
                  <span className="swatch" style={{ background: civCss(c.color) }} />
                  <span className="civ-name">
                    {c.name}
                    {c.atWar ? ' ⚔' : ''}
                    <span className="muted"> · {c.era}</span>
                  </span>
                  <span className="muted small">
                    {c.towns} {c.towns === 1 ? 'cidade' : 'cidades'} · {c.people} pessoas · {c.faith} · tec. {percent(c.tech)}
                    {c.famine > 0 && ` · fome em ${percent(c.famine)}`}
                    {c.plague > 0 && ` · peste`}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {life.wars.length > 0 && (
            <ul className="civs wars">
              {life.wars.map((w) => (
                <li key={`${w.a}:${w.b}`}>
                  <span className="swatch" style={{ background: civCss(w.aColor) }} />
                  <span className="civ-name">{w.a}</span>
                  <span className="muted">⚔</span>
                  <span className="swatch" style={{ background: civCss(w.bColor) }} />
                  <span className="civ-name">{w.b}</span>
                  <span className="muted small">por {w.cause} · {w.battles} batalhas</span>
                </li>
              ))}
            </ul>
          )}
          {life.events.length > 0 && (
            <ul className="chronicle">
              {life.events.map((e, k) => (
                <li key={`${k}:${e.text}`} className={e.major ? 'major' : undefined}>
                  <span className="swatch" style={{ background: civCss(e.color) }} />
                  <span>
                    <span className="muted">{e.year} · </span>
                    {e.text}
                  </span>
                  {e.pos && (
                    <button type="button" className="icon tiny" onClick={() => game.flyTo(e.pos!)} aria-label="Ver">
                      <Icon.eye size={14} />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  )
}

const OVERLAY_HINTS: Partial<Record<Overlay2d, string>> = {
  none: 'O mundo como ele é: biomas, neve, rios, lava, fogo, nuvens, e os povos em tons suaves.',
  temperature: 'Azul: abaixo de 0 °C · branco: 0 °C · vermelho: até 35 °C. Lembre que o ar esfria com a altura.',
  rain: 'Chuva média recente: marrom seco, azul chuvoso. Veja a sombra de chuva atrás das montanhas.',
  humidity: 'Umidade do ar: marrom seco, branco saturado (onde as nuvens se formam).',
  pressure: 'Laranja: alta pressão (as secas decretadas: ar que desce e seca). Roxo: baixa (as tempestades, chovendo por onde passam). Ligue as setas de vento para ver o ar girar em volta.',
  relief: 'A altura do terreno: verde nas baixadas, amarelo e marrom subindo, cinza e branco nos picos, com curvas de nível. O mar escurece com a profundidade.',
  rivers: 'A rede de drenagem: a terra apagada e a água pela vazão, de riachos claros a rios grandes em azul escuro. Bom para ver as bacias.',
  change: 'Quanto o terreno baixou ou subiu desde a referência (o mundo novo ou o botão abaixo): laranja desgastado, azul depositado. A cor satura perto de 0,03 de altura.',
  civilization: 'O atlas dos povos: terra cor de papel, mar azul, cada povo pinta suas terras com fronteiras escuras e as frentes de guerra em vermelho. Os nomes dos povos aparecem sobre suas terras.',
}
const RAMPS: Partial<Record<Overlay2d, [string, string, string]>> = {
  temperature: ['linear-gradient(90deg, rgb(26 77 242), rgb(242 242 242) 36%, rgb(230 38 13))', '−20 °C', '35 °C'],
  rain: ['linear-gradient(90deg, rgb(217 166 89), rgb(26 64 230))', 'seco', 'chuvoso'],
  humidity: ['linear-gradient(90deg, rgb(204 140 77), rgb(242 242 242))', 'seco', 'saturado'],
  pressure: ['linear-gradient(90deg, rgb(89 64 217), rgb(235 235 235), rgb(242 140 38))', 'baixa (tempestade)', 'alta (seca)'],
  relief: ['linear-gradient(90deg, rgb(10 30 90), rgb(120 180 220) 25%, rgb(70 130 60) 26%, rgb(150 170 80), rgb(190 160 90), rgb(140 95 60), rgb(160 160 160), rgb(245 245 250))', 'mar fundo', 'pico'],
  rivers: ['linear-gradient(90deg, rgb(158 219 255), rgb(0 46 191))', 'riacho', 'rio grande'],
  change: ['linear-gradient(90deg, rgb(242 107 51), rgb(209 209 209), rgb(64 140 255))', 'desgastado', 'depositado'],
}

function MapPanel({ game }: { game: Game }) {
  const s = useSettings(game)
  const stats = useStats(game)
  const ramp = RAMPS[s.overlay]
  return (
    <div className="panel-body">
      <h2>Mapa</h2>
      <div className="chips" role="radiogroup" aria-label="Modo do mapa">
        {OVERLAYS_2D.map((o) => (
          <button key={o.id} type="button" className={s.overlay === o.id ? 'active' : ''} onClick={() => game.set({ overlay: o.id })}>
            {o.label}
          </button>
        ))}
      </div>
      <p className="hint">O troca o mapa (Shift+O volta).</p>
      <label className="toggle">
        <input type="checkbox" checked={s.windArrows} onChange={(e) => game.set({ windArrows: e.target.checked })} /> Setas de vento (W)
      </label>
      <label className="toggle">
        <input type="checkbox" checked={s.clouds} onChange={(e) => game.set({ clouds: e.target.checked })} /> Nuvens
      </label>
      {ramp && (
        <div className="ramp">
          <span className="bar" style={{ background: ramp[0] }} />
          <span className="ends">
            <span>{ramp[1]}</span>
            <span>{ramp[2]}</span>
          </span>
        </div>
      )}
      {s.overlay === 'biome' && (
        <ul className="legend">
          {BIOMES.map(([name, color]) => (
            <li key={name}>
              <span className="swatch" style={{ background: color }} /> {name}
            </li>
          ))}
        </ul>
      )}
      {s.overlay === 'civilization' && stats.life && stats.life.civs.length > 0 && (
        <ul className="legend single">
          {stats.life.civs.map((c) => (
            <li key={c.id}>
              <span className="swatch" style={{ background: civCss(c.color) }} />
              <span>
                {c.name}
                {c.atWar ? ' ⚔' : ''}
                <span className="muted"> · {c.towns} {c.towns === 1 ? 'cidade' : 'cidades'} · {c.people} pessoas</span>
              </span>
            </li>
          ))}
        </ul>
      )}
      {s.overlay === 'civilization' && !s.life && <p className="hint">Ligue a vida na aba Vida para ver os povos.</p>}
      <p className="hint">{OVERLAY_HINTS[s.overlay] ?? 'Cada bioma com sua cor, como no 3D: gelo, tundra, taiga, campo, floresta, deserto, savana, floresta tropical.'}</p>
      {s.overlay === 'change' && (
        <button type="button" className="wide" onClick={() => game.resetChange()}>
          Zerar referência (contar a partir de agora)
        </button>
      )}
    </div>
  )
}

function WorldPanel({ game }: { game: Game }) {
  const s = useSettings(game)
  const stats = useStats(game)
  const w = s.world
  const [seed, setSeed] = useState(String(w.seed))
  const sum = stats.summary
  return (
    <div className="panel-body">
      <h2>Mundo</h2>
      <p className="hint">
        Temperatura média {sum.meanTemp.toFixed(1).replace('.', ',')} °C · floresta {Math.round(sum.forest * 100)}% da terra · deserto{' '}
        {Math.round(sum.desert * 100)}% · neve {Math.round(sum.snow * 100)}% · água {Math.round(sum.water * 100)}% do mapa.
        {stats.sun !== 0 && ` Sol: ${stats.sun > 0 ? '+' : ''}${stats.sun.toFixed(0)} °C.`}
        {stats.dust > 0.05 && ` Poeira: −${stats.dust.toFixed(1).replace('.', ',')} °C.`}
        {stats.droughts > 0 && ` ${stats.droughts} ${stats.droughts === 1 ? 'seca decretada' : 'secas decretadas'}.`}
        {stats.volcanoes > 0 && ` ${stats.volcanoes} ${stats.volcanoes === 1 ? 'vulcão ativo' : 'vulcões ativos'}.`}
      </p>
      <label className="toggle">
        <input type="checkbox" checked={s.clouds} onChange={(e) => game.set({ clouds: e.target.checked })} /> Nuvens
      </label>
      <Slider label="Vento: direção" value={w.windDirection} min={0} max={359} step={1} unit="°" onChange={(windDirection) => game.set({ world: { ...w, windDirection } })} />
      <Slider label="Vento: força" value={w.windSpeed} min={0} max={1.5} step={0.05} onChange={(windSpeed) => game.set({ world: { ...w, windSpeed } })} />
      <Slider label="Umidade do vento" value={w.windHumidity} min={0} max={1} step={0.05} onChange={(windHumidity) => game.set({ world: { ...w, windHumidity } })} />
      <Slider label="Temperatura base" value={w.temperature} min={-15} max={15} step={0.5} unit=" °C" onChange={(temperature) => game.set({ world: { ...w, temperature } })} />
      <p className="hint">O vento e a temperatura valem na hora. Os abaixo fazem um mundo novo.</p>
      <Slider label="Ilhas" value={w.islands} min={0} max={1} step={0.05} onChange={(islands) => game.newWorld({ islands, seed: w.seed })} />
      <Slider label="Nível do mar" value={w.seaLevel} min={-0.06} max={0.08} step={0.005} onChange={(seaLevel) => game.newWorld({ seaLevel, seed: w.seed })} />
      <label className="row">
        <span>Tamanho</span>
        <select value={w.size} onChange={(e) => game.newWorld({ size: Number(e.target.value), seed: w.seed })}>
          {[128, 160, 192, 256].map((n) => (
            <option key={n} value={n}>
              {n}×{n}
            </option>
          ))}
        </select>
      </label>
      <label className="row">
        <span>Semente</span>
        <input value={seed} onChange={(e) => setSeed(e.target.value)} onBlur={() => game.newWorld({ seed: Number(seed) || 1 })} />
      </label>
    </div>
  )
}

function Slider({ label, value, min, max, step, unit = '', onChange }: { label: string; value: number; min: number; max: number; step: number; unit?: string; onChange: (v: number) => void }) {
  return (
    <label className="slider">
      <span>
        {label} <em>{Number.isInteger(step) ? value : value.toFixed(2).replace('.', ',')}{unit}</em>
      </span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  )
}

function Bar({ value, label }: { value: number; label?: string }) {
  const v = Math.max(0, Math.min(1, value))
  return (
    <span className="bar">
      <span className="fill" style={{ width: `${v * 100}%` }} />
      <span className="label">{label ?? `${Math.round(v * 100)}%`}</span>
    </span>
  )
}

function TileCard({ game }: { game: Game }) {
  const stats = useStats(game)
  const t = stats.tile
  if (!t) return null
  return (
    <div className="tile-card glass">
      <strong>{t.biome}</strong>
      <span className="muted">
        {t.temperature.toFixed(0)} °C · ar {Math.round(t.humidity * 100)}% · chuva {t.rain.toFixed(1).replace('.', ',')}× · altura {Math.round(t.height * 1000)}
        {t.water > 0.002 ? ` · água ${t.water.toFixed(3)}` : t.river > 0 ? ' · rio' : ''}
        {t.vegetation > 0.05 && ` · vegetação ${Math.round(t.vegetation * 100)}%`}
        {t.drought > 0.05 && ` · seca decretada`}
        {t.storm > 0.05 && ` · tempestade`}
      </span>
      {t.town && (
        <span className="town">
          <span className="swatch" style={{ background: civCss(t.town.color) }} /> {t.town.name} ({t.town.civ}): {t.town.people} pessoas, {t.town.status}
        </span>
      )}
    </div>
  )
}

const CARD_LIFE = 12000
function EventCards({ game }: { game: Game }) {
  const stats = useStats(game)
  const s = useSettings(game)
  const [cards, setCards] = useState<{ key: string; event: LifeEvent; born: number }[]>([])
  const seen = useRef(-1)
  const events = stats.life?.events
  useEffect(() => {
    if (!events) return
    const newest = events[0]?.time ?? 0
    if (newest < seen.current) seen.current = -1
    if (seen.current < 0) {
      seen.current = newest
      return
    }
    const fresh = events.filter((e) => e.time > seen.current)
    if (!fresh.length) return
    seen.current = newest
    const now = Date.now()
    setCards((old) => [...fresh.reverse().map((event) => ({ key: `${event.time}:${event.text}`, event, born: now })), ...old].slice(0, 4))
  }, [events])
  useEffect(() => {
    const id = window.setInterval(() => {
      const now = Date.now()
      setCards((old) => (old.some((c) => now - c.born > CARD_LIFE) ? old.filter((c) => now - c.born <= CARD_LIFE) : old))
    }, 1000)
    return () => window.clearInterval(id)
  }, [])
  if (!s.life) return null
  return (
    <div className="event-cards">
      {cards.map((c) => (
        <div key={c.key} className={`event-card glass ${c.event.major ? 'major' : ''}`}>
          <span className="swatch" style={{ background: civCss(c.event.color) }} />
          <span className="text">
            <span className="muted">{c.event.year} · </span>
            {c.event.text}
          </span>
          {c.event.pos && (
            <button type="button" className="icon" onClick={() => game.flyTo(c.event.pos!)} aria-label="Ver onde aconteceu">
              <Icon.eye size={16} />
            </button>
          )}
        </div>
      ))}
    </div>
  )
}
