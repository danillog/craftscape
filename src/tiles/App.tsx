import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { CIV_COLORS, ERAS, FAITHS } from '../engine/life'
import { BIOMES } from '../ui/constants'
import { Icon } from '../ui/icons'
import { Charts } from './Charts'
import { ChallengeCard, HelpOverlay, HistoryPanel, Welcome } from './Extras'
import { seenTour, seenWelcome } from './goals'
import { Tour } from './Tour'
import type { News, Tool2d } from './game'
import type { GameApi } from './host'
import { startGame } from './start'
import { CATEGORICAL, ERA_RAMP, COOLWARM, HPA_MEAN, HPA_PER_UNIT, MM_PER_RAIN, OVERLAYS_2D, PUOR, RAIN_SCALE, VIRIDIS, YLGNBU, cssRamp, formatLat, formatLon, latAt, lonAt, zoneOf, type Overlay2d } from './render'
import { METERS_PER_HEIGHT, SEASON_SIM } from './world'
import './tiles.css'

const civCss = (k: number) => `rgb(${CIV_COLORS[k].map((v) => Math.round(v * 255)).join(', ')})`
/** The swatch of a notice: the people's colour, or a sky blue for the world's own news. */
const newsCss = (k: number | null) => (k === null ? 'rgb(124 196 255)' : civCss(k))
const COMPASS = ['leste', 'sudeste', 'sul', 'sudoeste', 'oeste', 'noroeste', 'norte', 'nordeste']
const ARROWS = ['→', '↘', '↓', '↙', '←', '↖', '↑', '↗']
/** Where a wind at this angle (0 east, 90 south, as on the screen) blows to. */
const compass = (deg: number) => {
  const k = Math.round(deg / 45) % 8
  return `${ARROWS[k]} para ${COMPASS[k]}`
}
/** A height over the sea (height units) in metres, or the depth below it. */
const meters = (h: number) => {
  const m = Math.round((h * METERS_PER_HEIGHT) / 10) * 10
  return m < 0 ? `${-m} m de profundidade` : `${m} m de altitude`
}
/** The season in words, from the world's season (−1 … 1) and time (for spring or autumn). */
const seasonName = (season: number, time: number) => {
  const rising = Math.cos((time / SEASON_SIM) * Math.PI * 2) > 0
  if (season > 0.7) return 'verão no norte, inverno no sul'
  if (season < -0.7) return 'inverno no norte, verão no sul'
  return rising ? 'primavera no norte, outono no sul' : 'outono no norte, primavera no sul'
}
const pressureLabel = (v: number) => (v < -0.5 ? 'baixa forte' : v < -0.12 ? 'baixa' : v > 0.5 ? 'alta forte' : v > 0.12 ? 'alta' : 'normal')
const useSettings = (game: GameApi) => useSyncExternalStore(game.subscribe, game.getSettings)
const useStats = (game: GameApi) => useSyncExternalStore(game.subscribe, game.getStats)

type Group = 'terra' | 'bencao' | 'praga' | 'povos'
const GROUP_NAMES: Record<Group, string> = { terra: 'Terra', bencao: 'Bênçãos', praga: 'Pragas', povos: 'Povos' }
const TOOLS: { id: Tool2d; label: string; key: string; hint: string; group: Group; icon: keyof typeof Icon }[] = [
  { id: 'inspect', label: 'Olhar', key: '0', hint: 'Arraste ou use WASD / setas para mover o mapa (Shift: mais rápido); clique numa cidade para acompanhá-la', group: 'terra', icon: 'inspect' },
  { id: 'terrain', label: 'Terreno', key: '1', hint: 'Segure: levanta montanhas (−: cava vales e mar)', group: 'terra', icon: 'rock' },
  { id: 'water', label: 'Água', key: '2', hint: 'Segure: enche lagos (−: seca)', group: 'terra', icon: 'water' },
  { id: 'plates', label: 'Placas', key: 'G', hint: 'Arraste uma placa para onde ela deve ir (mais longe: mais rápido); ao soltar, a borda treme. A deriva segue no slider do painel Mundo', group: 'terra', icon: 'uplift' },
  { id: 'forest', label: 'Floresta', key: '3', hint: 'Segure: planta mato e floresta (−: desmata)', group: 'terra', icon: 'tree' },
  { id: 'rain', label: 'Chuva', key: '4', hint: 'Segure: ar úmido, nuvens e chuva aqui (−: seca o ar)', group: 'bencao', icon: 'humidity' },
  { id: 'heat', label: 'Calor', key: '5', hint: 'Segure: esquenta a região para sempre (−: esfria)', group: 'bencao', icon: 'heat' },
  { id: 'pressure', label: 'Pressão', key: 'B', hint: 'Segure: cria uma alta, tempo seco e vento saindo (−: uma baixa, chuva e vento girando). O vento a leva e ela se desfaz aos poucos', group: 'bencao', icon: 'pressure' },
  { id: 'sun', label: 'Sol', key: '6', hint: 'Clique: o planeta inteiro esquenta 1 °C; segure para continuar (−: esfria)', group: 'bencao', icon: 'sun' },

  { id: 'drought', label: 'Seca', key: '8', hint: 'Clique ou arraste: uma alta pressão fixa trava a chuva na região (−: apaga a seca)', group: 'praga', icon: 'drought' },
  { id: 'storm', label: 'Tempestade', key: '9', hint: 'Clique ou arraste: um ciclone que o vento leva, chovendo por onde passa', group: 'praga', icon: 'storm' },
  { id: 'fire', label: 'Fogo', key: 'F', hint: 'Clique ou arraste: acende o mato; o fogo corre com o vento e a chuva apaga', group: 'praga', icon: 'fire' },
  { id: 'volcano', label: 'Vulcão', key: 'V', hint: 'Clique ou arraste: abre um vulcão; a lava desce e vira rocha', group: 'praga', icon: 'volcano' },
  { id: 'people', label: 'Povo', key: '7', hint: 'Clique: um povo novo nasce aqui; segure e arraste para semear vários', group: 'povos', icon: 'life' },
  { id: 'bless', label: 'Bênção', key: 'J', hint: 'Clique numa cidade: celeiros cheios, gente saudável, a cidade cresce', group: 'povos', icon: 'sparkles' },
  { id: 'inspire', label: 'Inspiração', key: 'K', hint: 'Clique numa cidade: uma ideia brilhante, o povo avança no saber (rumo à próxima era)', group: 'povos', icon: 'bulb' },
  { id: 'plague', label: 'Peste', key: 'L', hint: 'Clique numa cidade: uma peste irrompe e se espalha', group: 'povos', icon: 'skull' },
  { id: 'prophet', label: 'Profeta', key: 'N', hint: 'Clique numa cidade: um profeta converte o povo a outra fé', group: 'povos', icon: 'star' },
  { id: 'discord', label: 'Discórdia', key: 'Q', hint: 'Clique numa cidade: o povo entra em guerra com o vizinho mais próximo', group: 'povos', icon: 'swords' },
  { id: 'peace', label: 'Paz', key: 'E', hint: 'Clique numa cidade: todas as guerras desse povo terminam numa trégua', group: 'povos', icon: 'dove' },
  { id: 'hurricane', label: 'Furacão', key: 'Y', hint: 'Clique no mar: nasce um furacão com nome. Cresce sobre mar tropical acima de 25 °C até a categoria 5 (não nasce colado no equador), vai para oeste com os alísios e se curva para o polo do seu hemisfério; em terra ou mar frio morre. Chuva torrencial, vento girando e maré de tempestade nas costas', group: 'praga', icon: 'storm' },
  { id: 'quake', label: 'Terremoto', key: 'H', hint: 'Clique: um terremoto e suas réplicas. O pincel dá a magnitude (5 a 9,5). De 8,5 para cima a placa racha em duas; no mar, tsunami. Três de 9 ou mais em seguida: cataclismo, o planeta se refaz', group: 'praga', icon: 'seismic' },
  { id: 'nuke', label: 'Guerra nuclear', key: 'U', hint: 'Clique numa cidade: o povo dela lança ogivas contra o inimigo (os deuses dão a bomba a quem não a tem). Fora das cidades: uma bomba cai ali. Cidades arrasadas, radiação por décadas, inverno nuclear', group: 'praga', icon: 'radiation' },
  { id: 'meteor', label: 'Meteoro', key: 'M', hint: 'Clique: cratera, fogo e poeira que esfria o planeta; segure para uma chuva de meteoros (o pincel dá o tamanho)', group: 'praga', icon: 'meteor' },
]
const MODE_LABELS: Partial<Record<Tool2d, [string, string]>> = {
  sun: ['Esquentar 1 °C', 'Esfriar 1 °C'],
  drought: ['Decretar seca', 'Apagar seca'],
  terrain: ['Levantar', 'Cavar'],
  water: ['Encher', 'Secar'],
  forest: ['Plantar', 'Desmatar'],
  rain: ['Umedecer', 'Secar o ar'],
  heat: ['Esquentar', 'Esfriar'],
  pressure: ['Alta pressão', 'Baixa pressão'],
}
const POWERS: Tool2d[] = ['bless', 'inspire', 'plague', 'prophet', 'discord', 'peace', 'nuke']
const NO_MODE: Tool2d[] = ['inspect', 'people', 'storm', 'fire', 'volcano', 'meteor', 'plates', 'quake', 'hurricane', ...POWERS]
const NO_BRUSH: Tool2d[] = ['inspect', 'sun', 'people', 'volcano', 'plates', 'hurricane', ...POWERS]

export default function App() {
  const stageRef = useRef<HTMLDivElement>(null)
  const [game, setGame] = useState<GameApi | null>(null)
  useEffect(() => {
    // the game makes its canvases in the stage and runs in a worker where it can (see start.ts)
    return startGame(stageRef.current!, ({ game: g, thread }) => {
      setGame(g)
      Object.assign(window, { craftscape2d: g, craftscape2dThread: thread })
      // sent here by the 3D page because this browser has no usable WebGPU
      const reason = new URLSearchParams(window.location.search).get('sem-webgpu')
      if (!reason) return
      g.notice(
        reason === 'software'
          ? 'Sem GPU de verdade (só WebGPU por software, que travaria o computador): abrimos a versão 2D.'
          : reason === 'timeout'
            ? 'A GPU não respondeu: abrimos a versão 2D. Veja chrome://gpu ou reinicie o navegador para tentar o 3D.'
            : 'Este navegador não tem WebGPU: abrimos a versão 2D, que roda em qualquer computador.',
      )
    })
  }, [])
  return (
    <div className="app2d">
      <div ref={stageRef} className="stage" />
      {game && <Interface game={game} />}
    </div>
  )
}

function Interface({ game }: { game: GameApi }) {
  const s = useSettings(game)
  const stats = useStats(game)
  const [tab, setTab] = useState<'life' | 'map' | 'world' | 'data' | 'history' | null>('life')
  const [welcome, setWelcome] = useState(() => !seenWelcome())
  const [help, setHelp] = useState(false)
  // the first steps show once, after the first world is picked (and again from the shortcuts sheet)
  const [tour, setTour] = useState(() => !seenTour())
  const fileRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return
      if (e.key === '?') setHelp((h) => !h)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  const overlayName = OVERLAYS_2D.find((o) => o.id === s.overlay)?.label ?? ''
  const current = TOOLS.find((t) => t.id === s.tool)!
  const [addLabel, removeLabel] = MODE_LABELS[s.tool] ?? ['Adicionar', 'Remover']
  const year = stats.life ? stats.life.year : Math.floor(stats.simTime / 10)
  return (
    <>
      <header className="topbar glass">
        <strong>Craftscape 2D</strong>
        <span className="muted">
          ano {year} · {seasonName(stats.season, stats.simTime)}
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
        <div className="speeds" role="group" aria-label="Tempo">
          <button type="button" disabled={!stats.undoDepth} onClick={() => game.undo()} data-tip="Desfazer o último gesto (Ctrl + Z)">
            <Icon.undo size={16} />
          </button>
          <button type="button" disabled={!stats.rewindYears} onClick={() => game.rewind()} data-tip={`Voltar no tempo 10 anos (dá para voltar ${stats.rewindYears} anos)`}>
            <Icon.rewind size={16} />
          </button>
        </div>
        <button type="button" onClick={() => setWelcome(true)} data-tip="Escolher um mundo e um desafio">
          <Icon.refresh size={16} /> Novo mundo
        </button>
        {s.overlay !== 'none' && (
          <button type="button" className="active" onClick={() => setTab('map')} data-tip="O mapa mostrado (O troca)">
            <Icon.layers size={16} /> {overlayName}
          </button>
        )}
        <div className="speeds" role="radiogroup" aria-label="Visão">
          <button type="button" className={s.look === 'satellite' ? 'active' : ''} onClick={() => game.set({ look: 'satellite' })} data-tip="Como visto do espaço: sem desenhos, cidades como luzes, grade em km (I alterna)">
            <Icon.globe size={16} /> Satélite
          </button>
          <button type="button" className={s.look === 'illustrated' ? 'active' : ''} onClick={() => game.set({ look: 'illustrated' })} data-tip="O mapa desenhado: árvores, montanhas, casas e rebanhos (I alterna)">
            <Icon.map size={16} /> Ilustrado
          </button>
        </div>
        <button
          type="button"
          className={s.globe ? 'active' : ''}
          aria-pressed={s.globe}
          onClick={() => game.set({ globe: !s.globe })}
          data-tip="O planeta como um globo: arraste com o Olhar (ou com o botão direito) para girar, a roda aproxima, e os poderes funcionam nele"
        >
          <Icon.orbit size={16} /> Globo
        </button>
        <button type="button" onClick={() => void game.save()} data-tip="Salvar este mundo num arquivo">
          <Icon.save size={16} />
        </button>
        <button type="button" onClick={() => fileRef.current?.click()} data-tip="Abrir um mundo salvo">
          <Icon.folder size={16} />
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".json,.gz,application/json,application/gzip"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) void game.load(f)
            e.target.value = ''
          }}
        />
        <button type="button" className={s.sound ? 'active' : ''} onClick={() => game.set({ sound: !s.sound })} data-tip={s.sound ? 'Som ligado' : 'Som desligado'}>
          {s.sound ? '♪' : '♪̸'}
        </button>
        <button type="button" onClick={() => setHelp(true)} data-tip="Atalhos (?)">
          <Icon.help size={16} />
        </button>
        <button type="button" onClick={() => game.fit()} data-tip="Enquadra o mundo inteiro (R)">
          <Icon.map size={16} />
        </button>
        <a className="button" href={`${import.meta.env.BASE_URL}${new URLSearchParams(window.location.search).has('sem-webgpu') ? '?3d' : ''}`} data-tip="A versão 3D (precisa de WebGPU)">
          3D
        </a>
        <span className="fps muted">{Math.round(stats.fps)} fps</span>
      </header>

      <aside className="powers glass">
        {(['terra', 'bencao', 'praga', 'povos'] as Group[]).map((group) => (
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
            <label className="mini-slider" data-tip={s.tool === 'quake' ? 'Magnitude do terremoto ( [ ] ou Shift + roda )' : 'Tamanho do pincel ( [ ] ou Shift + roda )'}>
              <span>{s.tool === 'quake' ? `Magnitude ${(5 + (Math.min(s.brushSize, 40) / 40) * 4.5).toFixed(1).replace('.', ',')}` : 'Tamanho'}</span>
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
        <button type="button" className={tab === 'data' ? 'active' : ''} onClick={() => setTab(tab === 'data' ? null : 'data')}>
          <Icon.chart size={18} /> Dados
        </button>
        <button type="button" className={tab === 'history' ? 'active' : ''} onClick={() => setTab(tab === 'history' ? null : 'history')}>
          <Icon.book size={18} /> História
        </button>
      </nav>
      {tab && (
        <aside className="panel glass">
          {tab === 'life' ? (
            <LifePanel game={game} />
          ) : tab === 'map' ? (
            <MapPanel game={game} />
          ) : tab === 'data' ? (
            <DataPanel game={game} />
          ) : tab === 'history' ? (
            <HistoryPanel game={game} />
          ) : (
            <WorldPanel game={game} />
          )}
        </aside>
      )}

      <ChallengeCard game={game} onChange={() => setWelcome(true)} />
      {welcome && <Welcome game={game} onClose={() => setWelcome(false)} />}
      {help && (
        <HelpOverlay
          onClose={() => setHelp(false)}
          onTour={() => {
            setHelp(false)
            setTour(true)
          }}
        />
      )}
      {tour && !welcome && !help && <Tour game={game} onClose={() => setTour(false)} />}
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

function LifePanel({ game }: { game: GameApi }) {
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
          <HumanSummary game={game} />
          <p className="hint">
            <strong>Ano {life.year}.</strong> {life.herds} manadas, {life.villages} cidades, {life.people} pessoas.
            {life.ending && <strong> {life.ending}</strong>}
          </p>
          {life.civs.length > 0 && (
            <ul className="civs">
              {[...life.civs]
                .sort((a, b) => b.tech - a.tech)
                .map((c) => {
                  // how far along its era it is, towards the next
                  const from = ERAS[c.eraIndex].tech
                  const to = ERAS[c.eraIndex + 1]?.tech ?? 1
                  const along = c.eraIndex >= ERAS.length - 1 ? 1 : (c.tech - from) / (to - from)
                  const trend = stats.techTrend[c.id] ?? 0
                  return (
                    <li key={c.id}>
                      <span className="swatch" style={{ background: civCss(c.color) }} />
                      <span className="civ-name">
                        {c.name}
                        {c.atWar ? ' ⚔' : ''}
                        <span className="muted"> · {c.era}</span>
                        {trend > 0.03 && <span className="trend up" title="Avançando rápido (saber nos últimos 10 anos)"> ▲</span>}
                        {trend < -0.005 && <span className="trend down" title="Perdendo saber"> ▼</span>}
                      </span>
                      <span className="era-bar" title={c.eraIndex < ERAS.length - 1 ? `${Math.round(along * 100)}% do caminho até a ${ERAS[c.eraIndex + 1].name}` : 'Na última era'}>
                        <span className="fill" style={{ width: `${Math.max(0, Math.min(1, along)) * 100}%` }} />
                      </span>
                      <span className="muted small">
                        {c.towns} {c.towns === 1 ? 'cidade' : 'cidades'} · {c.people} pessoas · {c.faith} · língua da família {c.familyName}
                        {c.loansFrom.length > 0 && ` (palavras de ${c.loansFrom.join(', ')})`}
                        {c.famine > 0 && ` · fome em ${percent(c.famine)}`}
                        {c.plague > 0 && ` · peste em ${percent(c.plague)}`}
                      </span>
                    </li>
                  )
                })}
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
  temperature: 'Temperatura do ar agora, junto ao chão (paleta coolwarm): azul abaixo de 0 °C, cinza no ponto de congelamento, vermelho até 35 °C. O dia esquenta e a noite esfria em volta da média: muito no deserto seco (±10 °C), menos sob florestas e solo úmido, quase nada no mar, e as nuvens abafam a variação. O ar esfria 6,5 °C a cada 1000 m de altitude.',
  rain: 'Precipitação média anual (paleta YlGnBu). Veja a sombra de chuva a sotavento das montanhas e a chuva forte no centro das baixas.',
  humidity: 'Umidade relativa do ar (paleta viridis): onde chega perto de 100 % as nuvens se formam.',
  pressure: 'Pressão ao nível do mar em hPa (paleta PuOr), com isóbaras a cada 5 hPa. Laranja: alta (ar que desce, tempo seco; as secas decretadas são altas fixas). Roxo: baixa (ar que sobe, nuvens e chuva; as tempestades são baixas fortes). O planeta tem seus cinturões: baixa no equador (chuva), altas a 30° (os desertos), baixas a 60° (tempestades) e altas nos polos. Eles sobem e descem com o sol ao longo do ano, e os continentes viram baixa no verão e alta no inverno (as monções). O vento gira em volta das baixas no sentido anti-horário no hemisfério norte e horário no sul (o efeito de Coriolis, que some no equador); ligue as setas de vento para ver.',
  relief: 'A altura do terreno: verde nas baixadas, amarelo e marrom subindo, cinza e branco nos picos, com curvas de nível. O mar escurece com a profundidade.',
  rivers: 'A rede de drenagem: a terra apagada e a água pela vazão, de riachos claros a rios grandes em azul escuro. Bom para ver as bacias.',
  change: 'Quanto o terreno baixou ou subiu desde a referência (o mundo novo ou o botão abaixo): laranja desgastado, azul depositado. A cor satura perto de 0,03 de altura.',
  plates: 'Cada placa com sua cor e uma seta para onde ela anda. Bordas: vermelho colidindo (cordilheiras, e onde o mar mergulha sob o continente uma fossa e vulcões), azul se afastando (riftes, dorsais), amarelo deslizando (terremotos). Claro onde a terra sobe, escuro onde afunda. Arraste uma placa com a ferramenta Placas (G).',
  eras: 'A era de cada povo, do azul claro (Idade da Pedra) ao escuro (Era Moderna). A troca de saber pelo comércio puxa os vizinhos para a frente.',
  faith: 'A fé de cada povo. A fé do povo maior se espalha para os vizinhos menores; o poder Profeta (N) converte um povo.',
  language: 'A família de idiomas de cada povo. Vizinhos em paz trocam palavras; quando um idioma já pegou muitas palavras de outro, os dois viram a mesma família.',
  plague: 'A peste: do bege (sã) ao verde-doentio (muitas cidades doentes). Ela pula entre cidades vizinhas e pelas rotas. Poder Peste (L).',
  famine: 'A fome: do bege (fartura) ao laranja-escuro (muitas cidades com fome). Seca, frio e terra cansada causam fome; fome leva à guerra.',
  war: 'Quem está em guerra (vermelho) e quem está em paz (azul). As frentes de batalha aparecem nas fronteiras.',
  human: 'O que os povos fizeram da terra: cidades em lilás, lavouras em amarelo-trigo, floresta derrubada em marrom, fumaça e calor das indústrias em vermelho, represas em azul, irrigação em ciano. Tudo volta ao natural aos poucos quando as cidades somem.',
  civilization: 'O atlas dos povos: terra cor de papel, mar azul, cada povo pinta suas terras com fronteiras escuras e as frentes de guerra em vermelho. Os nomes dos povos aparecem sobre suas terras.',
}
const RAMPS: Partial<Record<Overlay2d, [string, string, string]>> = {
  // the colour maps are not linear in °C: freezing sits in the middle (−20 … 0 … 35)
  temperature: [cssRamp(COOLWARM), '−20 °C', '0 °C · 35 °C'],
  rain: [cssRamp(YLGNBU), '0 mm/ano', `${Math.round((2.5 * MM_PER_RAIN) / 50) * 50} mm/ano`],
  humidity: [cssRamp(VIRIDIS), '0 %', '100 %'],
  pressure: [cssRamp(PUOR), `${HPA_MEAN - HPA_PER_UNIT / 2} hPa (baixa)`, `${HPA_MEAN + HPA_PER_UNIT / 2} hPa (alta)`],
  current: [cssRamp(COOLWARM), 'corrente fria −6 °C', 'corrente quente +6 °C'],
  relief: ['linear-gradient(90deg, rgb(10 30 90), rgb(120 180 220) 25%, rgb(70 130 60) 26%, rgb(150 170 80), rgb(190 160 90), rgb(140 95 60), rgb(160 160 160), rgb(245 245 250))', 'mar fundo', 'pico'],
  rivers: ['linear-gradient(90deg, rgb(158 219 255), rgb(0 46 191))', 'riacho', 'rio grande'],
  change: ['linear-gradient(90deg, rgb(242 107 51), rgb(209 209 209), rgb(64 140 255))', 'desgastado', 'depositado'],
}

function MapPanel({ game }: { game: GameApi }) {
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
        <input type="checkbox" checked={s.windArrows} onChange={(e) => game.set({ windArrows: e.target.checked })} /> Setas de vento (T)
      </label>
      <label className="toggle">
        <input type="checkbox" checked={s.clouds} onChange={(e) => game.set({ clouds: e.target.checked })} /> Nuvens
      </label>
      {s.look === 'satellite' && (
        <label className="toggle">
          <input type="checkbox" checked={s.dayNight} onChange={(e) => game.set({ dayNight: e.target.checked })} /> Dia e noite (as cidades acendem no escuro)
        </label>
      )}
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
      {s.overlay === 'current' && (
        <p className="hint">
          Cada oceano gira com os ventos: nos subtrópicos uma corrente quente sobe pela costa leste dos continentes e uma fria
          desce pela costa oeste (onde ficam os desertos de neblina); perto dos polos é o contrário. O mar quente dá mais vapor
          ao ar, o frio menos, e a chuva das costas acompanha. Liga e desliga na aba Mundo.
        </p>
      )}
      {s.overlay === 'plates' && (
        <ul className="legend single">
          <li><span className="swatch" style={{ background: 'rgb(235 60 45)' }} /> Colidindo: montanhas, fossas, vulcões</li>
          <li><span className="swatch" style={{ background: 'rgb(60 140 245)' }} /> Se afastando: riftes, dorsais</li>
          <li><span className="swatch" style={{ background: 'rgb(245 205 60)' }} /> Deslizando: terremotos</li>
        </ul>
      )}
      {s.overlay === 'human' && (
        <>
          <ul className="legend single">
            <li><span className="swatch" style={{ background: 'rgb(120 100 150)' }} /> Cidades</li>
            <li><span className="swatch" style={{ background: 'rgb(230 190 60)' }} /> Lavouras</li>
            <li><span className="swatch" style={{ background: 'rgb(150 95 50)' }} /> Floresta derrubada</li>
            <li><span className="swatch" style={{ background: 'rgb(220 50 40)' }} /> Fumaça e calor das indústrias</li>
            <li><span className="swatch" style={{ background: 'rgb(40 110 230)' }} /> Represas</li>
            <li><span className="swatch" style={{ background: 'rgb(80 200 210)' }} /> Irrigação</li>
            <li><span className="swatch" style={{ background: 'rgb(190 230 20)' }} /> Radiação (guerra nuclear)</li>
          </ul>
          <HumanSummary game={game} />
        </>
      )}
      {s.overlay === 'eras' && (
        <ul className="legend single">
          {ERAS.map((e, k) => (
            <li key={e.name}>
              <span className="swatch" style={{ background: `rgb(${ERA_RAMP[k].join(' ')})` }} /> {e.name}
              <span className="muted"> · {stats.life?.civs.filter((c) => c.eraIndex === k).map((c) => c.name).join(', ') || 'ninguém'}</span>
            </li>
          ))}
        </ul>
      )}
      {s.overlay === 'faith' && (
        <ul className="legend single">
          {FAITHS.map((f, k) => {
            const who = stats.life?.civs.filter((c) => c.faithIndex === k) ?? []
            if (!who.length) return null
            return (
              <li key={f}>
                <span className="swatch" style={{ background: `rgb(${CATEGORICAL[k].join(' ')})` }} /> {f}
                <span className="muted"> · {who.map((c) => c.name).join(', ')}</span>
              </li>
            )
          })}
        </ul>
      )}
      {s.overlay === 'language' && stats.life && (
        <ul className="legend single">
          {[...new Map(stats.life.civs.map((c) => [c.family, c.familyName])).entries()].map(([fam, name], k) => (
            <li key={fam}>
              <span className="swatch" style={{ background: `rgb(${CATEGORICAL[k % CATEGORICAL.length].join(' ')})` }} /> família {name}
              <span className="muted"> · {stats.life!.civs.filter((c) => c.family === fam).map((c) => c.name).join(', ')}</span>
            </li>
          ))}
        </ul>
      )}
      {(s.overlay === 'plague' || s.overlay === 'famine') && stats.life && (
        <ul className="legend single">
          {[...stats.life.civs]
            .sort((a, b) => (s.overlay === 'plague' ? b.plague - a.plague : b.famine - a.famine))
            .map((c) => (
              <li key={c.id}>
                <span className="swatch" style={{ background: civCss(c.color) }} /> {c.name}
                <span className="muted"> · {Math.round((s.overlay === 'plague' ? c.plague : c.famine) * 100)}% das cidades</span>
              </li>
            ))}
        </ul>
      )}
      {s.overlay === 'war' && stats.life && (
        <ul className="legend single">
          <li><span className="swatch" style={{ background: 'rgb(230 103 103)' }} /> Em guerra: {stats.life.civs.filter((c) => c.atWar).map((c) => c.name).join(', ') || 'ninguém'}</li>
          <li><span className="swatch" style={{ background: 'rgb(150 172 196)' }} /> Em paz: {stats.life.civs.filter((c) => !c.atWar).map((c) => c.name).join(', ') || 'ninguém'}</li>
          {stats.life.wars.map((w) => (
            <li key={`${w.a}:${w.b}`} className="muted">⚔ {w.a} × {w.b}, por {w.cause}</li>
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

/** The world's record over the years, as charts. */
function DataPanel({ game }: { game: GameApi }) {
  const stats = useStats(game)
  return (
    <div className="panel-body">
      <h2>Dados</h2>
      <p className="hint">Um registro por ano simulado. Passe o mouse (ou use as setas com o gráfico em foco) para ler um ano.</p>
      <Charts history={stats.history} />
      <p className="hint">
        CO₂: 280 ppm antes da indústria, dobrando a cada 3 °C de aquecimento industrial (sensibilidade climática de 3 °C). Nível do mar em relação ao começo.
      </p>
    </div>
  )
}

/** How much the peoples have changed the land, and the warming they caused. */
function HumanSummary({ game }: { game: GameApi }) {
  const stats = useStats(game)
  const h = stats.human
  const pct = (v: number) => `${Math.round(v * 100)}%`
  return (
    <p className="hint">
      <strong>Antropoceno.</strong> Lavouras em {pct(h.farmed)} da terra, floresta derrubada em {pct(h.cut)}, cidades em {pct(h.urban)}.{' '}
      {h.forestLost > 0.02 ? `Já se perdeu ${pct(h.forestLost)} da floresta que o mundo chegou a ter. ` : ''}
      {stats.civWarming > 0.05 ? `A indústria aquece o planeta +${stats.civWarming.toFixed(1).replace('.', ',')} °C.` : 'Sem aquecimento industrial.'}
    </p>
  )
}

function WorldPanel({ game }: { game: GameApi }) {
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
        {stats.civWarming > 0.05 && ` Indústria: +${stats.civWarming.toFixed(1).replace('.', ',')} °C.`}
        {Math.abs(stats.sea) > 0.0005 && ` Mar ${stats.sea > 0 ? '+' : '−'}${Math.round(Math.abs(stats.sea) * 1000)} acima do normal.`.replace('− acima', '− abaixo')}
      </p>
      <label className="toggle">
        <input type="checkbox" checked={s.clouds} onChange={(e) => game.set({ clouds: e.target.checked })} /> Nuvens
      </label>
      <label className="toggle">
        <input type="checkbox" checked={w.planetWinds} onChange={(e) => game.set({ world: { ...w, planetWinds: e.target.checked } })} /> Ventos do planeta (alísios, de oeste, polares)
      </label>
      <p className="hint">
        O eixo inclinado (23,4°) faz as estações: quando é verão no norte é inverno no sul. O verão e o inverno quase não mudam no equador e mudam muito
        perto dos polos e no meio dos continentes; o mar segura o calor. O clima tem seu próprio ritmo, mais lento que os anos dos povos: as estações dão uma
        volta a cada ~1 minuto em 1× e o dia dura ~20 segundos, para dar tempo de ver a sombra da Terra curvar com as estações.
      </p>
      {!w.planetWinds && (
        <Slider label="Vento: direção" value={w.windDirection} min={0} max={359} step={1} unit="°" onChange={(windDirection) => game.set({ world: { ...w, windDirection } })} />
      )}
      <Slider label="Vento: força" value={w.windSpeed} min={0} max={1.5} step={0.05} onChange={(windSpeed) => game.set({ world: { ...w, windSpeed } })} />
      <Slider label="Umidade do vento" value={w.windHumidity} min={0} max={1} step={0.05} onChange={(windHumidity) => game.set({ world: { ...w, windHumidity } })} />
      <Slider label="Temperatura base" value={w.temperature} min={-15} max={15} step={0.5} unit=" °C" onChange={(temperature) => game.set({ world: { ...w, temperature } })} />
      <label className="toggle">
        <input type="checkbox" checked={w.pressureSystems} onChange={(e) => game.set({ world: { ...w, pressureSystems: e.target.checked } })} /> Altas e baixas pressões
      </label>
      {w.pressureSystems && (
        <Slider label="Intensidade dos sistemas" value={w.pressureStrength} min={0.25} max={3} step={0.25} onChange={(pressureStrength) => game.set({ world: { ...w, pressureStrength } })} />
      )}
      <p className="hint">
        Ar mais quente que a vizinhança (terra no verão, chuva liberando calor, lava, fogo) forma baixa pressão; ar mais frio forma alta. De vez em quando
        uma baixa ou uma alta chega com o vento e atravessa o mapa. O vento gira em volta delas (anti-horário nas baixas do hemisfério norte, horário nas do sul, quase nada no equador) e leva as nuvens. Para criar uma
        onde quiser, use o pincel Pressão (B).
      </p>
      <label className="toggle">
        <input type="checkbox" checked={w.warming} onChange={(e) => game.set({ world: { ...w, warming: e.target.checked } })} /> Aquecimento contínuo
      </label>
      {w.warming && (
        <Slider label="Ritmo (°C por minuto simulado)" value={w.warmingRate} min={0.25} max={4} step={0.25} onChange={(warmingRate) => game.set({ world: { ...w, warmingRate } })} />
      )}
      <label className="toggle">
        <input type="checkbox" checked={w.seaRise} onChange={(e) => game.set({ world: { ...w, seaRise: e.target.checked } })} /> O mar sobe com o aquecimento
      </label>
      <p className="hint">Com o mar ligado, cada grau de aquecimento (temperatura base, Sol e indústria dos povos) sobe o mar e alaga as costas baixas; o frio o faz recuar.</p>
      <label className="toggle">
        <input type="checkbox" checked={w.currents} onChange={(e) => game.set({ world: { ...w, currents: e.target.checked } })} /> Correntes marinhas
      </label>
      <p className="hint">Correntes quentes e frias ao longo das costas mudam a temperatura do mar e a chuva em terra. Veja no mapa Correntes.</p>
      <h2>Placas tectônicas</h2>
      <Slider label="Velocidade das placas" value={w.plateDrift} min={0} max={5} step={0.25} unit="×" onChange={(plateDrift) => game.set({ world: { ...w, plateDrift } })} />
      <label className="toggle">
        <input type="checkbox" checked={w.earthquakes} onChange={(e) => game.set({ world: { ...w, earthquakes: e.target.checked } })} /> Terremotos
      </label>
      <label className="toggle">
        <input type="checkbox" checked={w.volcanoes} onChange={(e) => game.set({ world: { ...w, volcanoes: e.target.checked } })} /> Vulcões nas bordas
      </label>
      <p className="hint">
        {w.plateDrift > 0 ? 'As placas andam: montanhas sobem onde colidem, riftes abrem onde se afastam.' : 'Placas paradas (0×): o relevo não muda sozinho.'} Veja no mapa Placas e
        arraste uma placa com a ferramenta Placas (G).
      </p>
      <p className="hint">Tudo acima vale na hora. Os abaixo fazem um mundo novo.</p>
      <Slider label="Ilhas" value={w.islands} min={0} max={1} step={0.05} onChange={(islands) => game.newWorld({ islands, seed: w.seed })} />
      <Slider label="Nível do mar" value={w.seaLevel} min={-0.06} max={0.08} step={0.005} onChange={(seaLevel) => game.newWorld({ seaLevel, seed: w.seed })} />
      <label className="row">
        <span>Tamanho</span>
        <select value={w.size} onChange={(e) => game.newWorld({ size: Number(e.target.value), seed: w.seed })}>
          {[128, 192, 256, 320, 384].map((n) => (
            <option key={n} value={n}>
              {n}×{n}{n >= 320 ? ' (pesado)' : ''}
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

function TileCard({ game }: { game: GameApi }) {
  const stats = useStats(game)
  const t = stats.tile
  if (!t) return null
  return (
    <div className="tile-card glass">
      <strong>{t.biome}</strong>
      <span className="muted">
         {formatLat(latAt(t.y + 0.5, stats.n), 1)} {formatLon(lonAt(t.x + 0.5, stats.n), 1)} ({zoneOf(latAt(t.y + 0.5, stats.n))}) · {t.airTemperature.toFixed(0)} °C agora (média do dia {t.temperature.toFixed(0)} °C) · umidade {Math.round(Math.min(t.humidity, 1) * 100)} % ·{' '}
        {Math.round((t.rain * RAIN_SCALE * MM_PER_RAIN) / 10) * 10} mm/ano · {meters(t.height - stats.sea)}
        {t.water > 0.002 && t.height >= stats.sea ? ` · lago de ${Math.round(t.water * METERS_PER_HEIGHT)} m` : t.river > 0 ? ' · rio' : ''}
        {t.vegetation > 0.05 && ` · vegetação ${Math.round(t.vegetation * 100)}%`}
        {` · ${Math.round(HPA_MEAN + t.pressure * HPA_PER_UNIT)} hPa (${pressureLabel(t.pressure)}) · vento ${compass(t.windAngle)} a ${Math.round(t.windSpeed * 2.5)} km/h`}
        {` · placa ${compass(t.plateAngle).replace('para', 'indo para')}`}
        {t.boundary && ` · borda: ${t.boundary}`}
        {t.urban > 0.3 ? ' · cidade' : t.farmland > 0.3 ? ' · lavoura' : t.cleared > 0.3 ? ' · floresta derrubada' : ''}
        {t.drought > 0.05 && ` · seca decretada`}
        {t.fallout > 0.02 && ` · ☢ radiação ${Math.round(t.fallout * 100)}%`}
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

/** How long a card stays, in milliseconds, and how many show at once. */
const CARD_LIFE = 12000
const MAX_CARDS = 4

/**
 * The news as it happens: a small stack of cards in the corner, the peoples' chronicle and
 * what the world does by itself (storms, fires, volcanoes, highs and lows), each with a
 * button that flies the view to where it happened. Shown with the peoples on or off.
 */
function EventCards({ game }: { game: GameApi }) {
  const stats = useStats(game)
  const s = useSettings(game)
  const [cards, setCards] = useState<{ news: News; born: number }[]>([])
  // the id of the newest notice already shown; -1 before the first look
  const seen = useRef(-1)
  const news = stats.news
  useEffect(() => {
    const newest = news[0]?.id ?? 0
    // a new world starts the news over (the old cards just run out)
    if (newest < seen.current || seen.current < 0) {
      seen.current = newest
      return
    }
    const fresh = news.filter((e) => e.id > seen.current)
    if (!fresh.length) return
    seen.current = newest
    const now = Date.now()
    setCards((old) => [...fresh.map((e) => ({ news: e, born: now })), ...old].slice(0, MAX_CARDS))
  }, [news])
  useEffect(() => {
    const id = window.setInterval(() => {
      const now = Date.now()
      setCards((old) => (old.some((c) => now - c.born > CARD_LIFE) ? old.filter((c) => now - c.born <= CARD_LIFE) : old))
    }, 1000)
    return () => window.clearInterval(id)
  }, [])
  return (
    <div className="event-cards" aria-live="polite">
      <button
        type="button"
        className={`follow ${s.followEvents ? 'active' : ''}`}
        onClick={() => game.set({ followEvents: !s.followEvents })}
        data-tip="A vista voa até cada acontecimento"
      >
        <Icon.eye size={16} /> {s.followEvents ? 'Seguindo os acontecimentos' : 'Seguir os acontecimentos'}
      </button>
      {cards.map(({ news: e }) => (
        <div key={e.id} className={`event-card glass ${e.major ? 'major' : ''}`}>
          <span className="swatch" style={{ background: newsCss(e.color) }} />
          <span className="text">
            <span className="muted">{e.year} · </span>
            {e.text}
          </span>
          {e.pos && (
            <button type="button" className="icon" onClick={() => game.flyTo(e.pos!)} aria-label="Ver onde aconteceu">
              <Icon.eye size={16} />
            </button>
          )}
          <button type="button" className="icon" onClick={() => setCards((old) => old.filter((c) => c.news.id !== e.id))} aria-label="Fechar">
            ×
          </button>
        </div>
      ))}
    </div>
  )
}
