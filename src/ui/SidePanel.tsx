import { useRef, type ReactNode } from 'react'
import type { Engine } from '../engine/engine'
import { scenarioById } from '../engine/scenarios'
import { CHALLENGES } from '../engine/challenges'
import { CIV_COLORS, type HistoryPoint } from '../engine/life'
import {
  TEMPERATURE_MAX,
  TEMPERATURE_MIN,
  climateOf,
  type AreaSetting,
  type FpsLimit,
  type Quality,
  type ResolutionSetting,
} from '../engine/settings'
import { clockOf } from '../engine/sky'
import { BIOMES, EROSION_LEGEND, FPS_LIMITS, OVERLAYS, QUALITIES, QUALITY_NAMES, RESOLUTIONS, compass } from './constants'
import { ClimateAnalysis, Section, Segmented, Slider, Toggle } from './controls'
import { Icon } from './icons'
import { useSettings, useStats } from './useEngine'

export type PanelTab = 'climate' | 'map' | 'world' | 'life' | 'challenges'

const TABS: { id: PanelTab; label: string; icon: (p: { size?: number }) => ReactNode }[] = [
  { id: 'climate', label: 'Clima', icon: Icon.climate },
  { id: 'map', label: 'Mapa', icon: Icon.layers },
  { id: 'world', label: 'Mundo', icon: Icon.globe },
  { id: 'life', label: 'Vida', icon: Icon.life },
  { id: 'challenges', label: 'Desafios', icon: Icon.flag },
]

const percent = (v: number) => `${Math.round(v * 100)}%`
const civCss = (k: number) => `rgb(${CIV_COLORS[k].map((v) => Math.round(v * 255)).join(', ')})`

/** People per civ over the years: one line per people, the world total dashed. */
function Timeline({ history, lineage }: { history: HistoryPoint[]; lineage: { id: number; name: string; color: number }[] }) {
  const W = 300
  const H = 80
  const y0 = history[0].year
  const y1 = history[history.length - 1].year
  const span = Math.max(1, y1 - y0)
  const max = Math.max(1, ...history.map((h) => h.total))
  const path = (pts: [number, number][]) =>
    pts
      .map(([x, y], k) => `${k ? 'L' : 'M'}${(((x - y0) / span) * W).toFixed(1)},${(H - 2 - (y / max) * (H - 6)).toFixed(1)}`)
      .join(' ')
  return (
    <div className="timeline-box">
      <svg className="timeline" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="População por povo ao longo dos anos">
        <path d={path(history.map((h) => [h.year, h.total]))} className="total" />
        {lineage.map((c) => {
          const pts: [number, number][] = history.map((h) => [h.year, h.people.find((p) => p[0] === c.id)?.[1] ?? 0])
          if (!pts.some((p) => p[1] > 0)) return null
          return <path key={c.id} d={path(pts)} stroke={civCss(c.color)} fill="none" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
        })}
      </svg>
      <p className="hint">
        Linha do tempo: ano {y0} a {y1} · pico de {max} pessoas · tracejado: o mundo todo.
      </p>
    </div>
  )
}

/** A need, 0–1, as a bar with an optional label instead of the percentage. */
function Bar({ value, label }: { value: number; label?: string }) {
  const v = Math.max(0, Math.min(1, value))
  return (
    <span className="bar" role="img" aria-label={label ?? percent(v)}>
      <span className="bar-fill" style={{ width: `${Math.round(v * 100)}%` }} />
      <span className="bar-label">{label ?? percent(v)}</span>
    </span>
  )
}

/** Vertical tab rail on the right edge; the active tab's panel slides out next to it. */
export function SidePanel({
  engine,
  tab,
  onTab,
  onNewWorld,
  section,
  onSection,
}: {
  engine: Engine
  tab: PanelTab | null
  onTab: (tab: PanelTab | null) => void
  onNewWorld: () => void
  section: boolean
  onSection: (open: boolean) => void
}) {
  const s = useSettings(engine)
  const stats = useStats(engine)
  const loadInput = useRef<HTMLInputElement>(null)
  const imageInput = useRef<HTMLInputElement>(null)

  const pickFile = (input: HTMLInputElement | null, fn: (file: File) => void) => {
    if (!input) return
    input.onchange = () => {
      const file = input.files?.[0]
      input.value = ''
      if (file) fn(file)
    }
    input.click()
  }

  return (
    <div className="side">
      {tab && (
        <aside className="drawer glass" aria-label={TABS.find((t) => t.id === tab)?.label}>
          <header className="drawer-header">
            <h2>{TABS.find((t) => t.id === tab)?.label}</h2>
            <button type="button" className="icon ghost" onClick={() => onTab(null)} aria-label="Fechar painel">
              <Icon.close size={18} />
            </button>
          </header>
          <div className="drawer-body">
            {tab === 'life' && (
              <>
                <Section title="Vida">
                  {s.life && stats.life?.selected ? (
                    <div className="town-card">
                      <header>
                        <span className="swatch" style={{ background: civCss(stats.life.selected.color) }} />
                        <strong>Cidade de {stats.life.selected.civ}</strong>
                        <span className="muted">
                          {stats.life.selected.people} pessoas · {Math.max(1, Math.round(stats.life.selected.age / 10))}{' '}
                          {Math.round(stats.life.selected.age / 10) <= 1 ? 'ano' : 'anos'}
                        </span>
                      </header>
                      <p className="hint">
                        Estado: {stats.life.selected.status}. {stats.life.selected.trend[0].toUpperCase()}
                        {stats.life.selected.trend.slice(1)}.{stats.life.selected.capital ? ' É a capital.' : ''}
                      </p>
                      <ul className="needs">
                        <li>
                          <span>Comida</span>
                          <Bar value={stats.life.selected.needs.food} />
                        </li>
                        <li>
                          <span>Umidade</span>
                          <Bar value={stats.life.selected.needs.moist} />
                        </li>
                        <li>
                          <span>Clima</span>
                          <Bar
                            value={1 - Math.min(1, stats.life.selected.needs.hardship * 4)}
                            label={`${stats.life.selected.needs.temperature.toFixed(0)} °C`}
                          />
                        </li>
                        <li>
                          <span>Celeiro</span>
                          <Bar value={stats.life.selected.needs.granary} />
                        </li>
                        <li>
                          <span>Lotação</span>
                          <Bar
                            value={stats.life.selected.needs.capacity > 0 ? stats.life.selected.pop / stats.life.selected.needs.capacity : 0}
                            label={`${stats.life.selected.people} de ${Math.round(stats.life.selected.needs.capacity * 200)}`}
                          />
                        </li>
                        <li>
                          <span>Tecnologia</span>
                          <Bar value={stats.life.selected.tech} />
                        </li>
                        <li>
                          <span>Adaptação</span>
                          <Bar value={stats.life.selected.adapt} />
                        </li>
                      </ul>
                      <p className="hint">
                        Obras:{' '}
                        {[
                          stats.life.selected.works.farms && 'fazendas',
                          stats.life.selected.works.irrigation && 'irrigação',
                          stats.life.selected.works.dam && 'represa',
                          stats.life.selected.works.terraces && 'terraplenagem',
                          stats.life.selected.works.industry && 'indústria',
                          stats.life.selected.needs.hunting && 'caça',
                        ]
                          .filter(Boolean)
                          .join(', ') || 'nenhuma ainda'}
                        . Fazendas com 25% de tecnologia, represa com 50%, terraplenagem com 70%, indústria com 80%.
                        {stats.life.selected.monument && ` Tem ${stats.life.selected.monument === 'torre' ? 'uma' : 'um'} ${stats.life.selected.monument}.`}
                        {stats.life.selected.faith && ` O povo segue o ${stats.life.selected.faith}.`}
                      </p>
                    </div>
                  ) : (
                    s.life && (
                      <p className="hint">
                        Com a ferramenta Inspecionar, passe o mouse sobre uma cidade para ver o que ela precisa, e
                        clique para acompanhá-la aqui.
                      </p>
                    )
                  )}
                  <Toggle
                    label="Vida: manadas e civilizações"
                    checked={s.life}
                    onChange={(life) => engine.set({ life })}
                  />
                  {s.life && (
                    <>
                      <Toggle
                        label="Mapa político: territórios e fronteiras"
                        checked={s.politicalMap}
                        onChange={(politicalMap) => engine.set({ politicalMap })}
                      />
                      <Toggle
                        label="Seguir os acontecimentos: a câmera voa até cada evento"
                        checked={s.followEvents}
                        onChange={(followEvents) => engine.set({ followEvents })}
                      />
                      <p className="hint">
                        Manadas procuram pasto e água e fogem de lava, enchente, gelo e calor. Povos só vivem
                        onde há umidade e calor suficientes: as cidades (telhados na cor do povo) crescem com pasto
                        e água perto, fundam outras, aprendem (as paredes viram pedra, surge uma torre) e disputam
                        fronteiras. Quanto mais frio (ou quente), mais adaptação e tecnologia um povo precisa para
                        ficar ali; cidades cinzentas estão sofrendo com o clima. No mapa político, cada povo pinta
                        suas terras; a fronteira fica vermelha e pulsa onde há guerra, e as batalhas deixam uma
                        marca no chão.
                        {stats.life &&
                          ` Agora: ${stats.life.herds} manadas, ${stats.life.villages} cidades, ${stats.life.people} pessoas.`}
                      </p>
                      {stats.life && (
                        <p className="hint">
                          <strong>Ano {stats.life.year}.</strong>
                          {stats.life.ending && <strong> {stats.life.ending}</strong>}
                        </p>
                      )}
                      {stats.life && stats.life.civs.length > 0 && (
                        <ul className="legend single civs">
                          {stats.life.civs.map((c) => (
                            <li key={c.id}>
                              <span className="swatch" style={{ background: civCss(c.color) }} />
                              <span className="civ-name">
                                {c.name}
                                {c.atWar ? ' ⚔' : ''}
                                <span className="muted"> · {c.era} · poder {c.power}</span>
                              </span>
                              <span className="muted">
                                {c.towns} {c.towns === 1 ? 'cidade' : 'cidades'} · {c.people} pessoas · capital com {c.capital} ·{' '}
                                {c.faith} · tec. {percent(c.tech)} · adapt. frio {percent(c.adapts.cold)}, calor {percent(c.adapts.heat)}
                                , seca {percent(c.adapts.dry)}, cheia {percent(c.adapts.flood)}
                                {c.monuments > 0 && ` · ${c.monuments} ${c.monuments === 1 ? 'monumento' : 'monumentos'}`}
                                {c.trade > 0 && ` · comércio com ${c.trade}`}
                                {c.allies.length > 0 && ` · aliado de ${c.allies.join(', ')}`}
                                {c.famine > 0 && ` · fome em ${percent(c.famine)} das cidades`}
                                {c.plague > 0 && ` · peste em ${percent(c.plague)} das cidades`}
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                      {stats.life && (
                        <p className="hint">
                          Fauna:{' '}
                          {stats.life.fauna
                            .map((f) => (f.extinct ? `${f.name} (extintos)` : `${f.herds} ${f.herds === 1 ? 'manada' : 'manadas'} de ${f.name}`))
                            .join(', ')}
                          . Cada espécie vive no seu bioma e migra com as estações; os povos sem agricultura caçam as manadas
                          por perto.
                          {(stats.life.routes > 0 || stats.life.ruins > 0 || stats.life.monuments > 0) &&
                            ` No mapa: ${stats.life.routes} ${stats.life.routes === 1 ? 'estrada ou rota' : 'estradas e rotas'}, ${stats.life.monuments} ${stats.life.monuments === 1 ? 'monumento' : 'monumentos'}, ${stats.life.ruins} ${stats.life.ruins === 1 ? 'ruína' : 'ruínas'}.`}
                          {stats.life.plagued > 0 &&
                            ` A peste corre em ${stats.life.plagued} ${stats.life.plagued === 1 ? 'cidade' : 'cidades'}.`}
                        </p>
                      )}
                      {stats.life && stats.life.history.length > 2 && (
                        <Timeline history={stats.life.history} lineage={stats.life.lineage} />
                      )}
                      {stats.life && stats.life.wars.length > 0 && (
                        <ul className="legend single civs wars">
                          {stats.life.wars.map((w) => (
                            <li key={`${w.a}:${w.b}`}>
                              <span className="swatch" style={{ background: civCss(w.aColor) }} />
                              <span className="civ-name">{w.a}</span>
                              <span className="muted">⚔</span>
                              <span className="swatch" style={{ background: civCss(w.bColor) }} />
                              <span className="civ-name">{w.b}</span>
                              <span className="muted">
                                {w.cause === 'aliança' ? 'por aliança' : `por ${w.cause}`} ·{' '}
                                {Math.max(1, Math.round(w.age / 10))} {Math.round(w.age / 10) <= 1 ? 'ano' : 'anos'} ·{' '}
                                {w.battles} {w.battles === 1 ? 'batalha' : 'batalhas'} · cidades tomadas {w.taken[0]}–
                                {w.taken[1]}
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                      {stats.life && stats.life.events.length > 0 && (
                        <ul className="chronicle">
                          {stats.life.events.map((e, k) => (
                            <li key={`${k}:${e.text}`} className={e.major ? 'major' : undefined}>
                              <span className="swatch" style={{ background: civCss(e.color) }} />
                              <span>
                                <span className="muted">{e.year} · </span>
                                {e.text}
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </>
                  )}
                  {stats.life && (stats.life.dams > 0 || stats.life.industries > 0 || stats.civWarming > 0) && (
                    <p className="hint">
                      Obras: {stats.life.dams} {stats.life.dams === 1 ? 'represa' : 'represas'}, {stats.life.industries}{' '}
                      {stats.life.industries === 1 ? 'cidade industrial' : 'cidades industriais'}.
                      {stats.civWarming > 0 &&
                        ` A indústria aquece o planeta ${stats.civWarming.toFixed(1).replace('.', ',')} °C.`}
                    </p>
                  )}
                  <p className="hint">
                    Conforme aprendem, os povos mudam a terra: fazendas em volta das cidades (tec. 25%), represas nos
                    rios (50%), terraplenagem (70%) e indústria (80%), que esquenta e polui a região e aquece o
                    planeta inteiro.
                  </p>
                  {s.life && (
                    <div className="row">
                      <button type="button" onClick={() => void engine.exportPoliticalMap()}>
                        <Icon.download size={16} /> Mapa político (PNG)
                      </button>
                      <button type="button" onClick={() => void engine.exportChronicle()}>
                        <Icon.download size={16} /> Crônica (PNG)
                      </button>
                    </div>
                  )}
                </Section>
              </>
            )}
            {tab === 'challenges' && (
              <Section title="Desafios">
                <p className="hint">
                  Metas lidas da análise do clima, atualizada a cada poucos segundos. Escolha uma, mude o mundo e
                  veja a barra subir.
                </p>
                {CHALLENGES.map((c) => {
                  const active = stats.challenge?.id === c.id ? stats.challenge : null
                  return (
                    <div key={c.id} className={`challenge ${active ? 'active' : ''} ${active?.done ? 'done' : ''}`}>
                      <div className="challenge-head">
                        <div>
                          <strong>{c.name}</strong>
                          <div className="challenge-goal">{c.goal}</div>
                        </div>
                        <button
                          type="button"
                          className={active ? 'ghost' : ''}
                          onClick={() => (active ? engine.stopChallenge() : engine.startChallenge(c.id))}
                        >
                          {active ? 'Parar' : 'Começar'}
                        </button>
                      </div>
                      {active && (
                        <>
                          <div className="progress" role="progressbar" aria-valuenow={Math.round(active.progress * 100)}>
                            <span style={{ width: percent(active.progress) }} />
                          </div>
                          <div className="challenge-status">
                            {active.done ? 'Concluído!' : `${percent(active.progress)} · ${c.hint}`}
                          </div>
                        </>
                      )}
                    </div>
                  )
                })}
              </Section>
            )}
            {tab === 'climate' && (
              <>
                <Section title="Clima">
                  <Toggle
                    label="Clima automático"
                    checked={s.autoClimate}
                    onChange={(autoClimate) => engine.set({ autoClimate })}
                  />
                  {stats.godWarming !== 0 && (
                    <p className="hint">
                      Sol (poder J): {stats.godWarming > 0 ? '+' : ''}
                      {stats.godWarming.toFixed(0)} °C no planeta inteiro, em qualquer clima.
                    </p>
                  )}
                  {stats.droughts > 0 && (
                    <p className="hint">
                      {stats.droughts === 1 ? 'Uma seca decretada' : `${stats.droughts} secas decretadas`} (poder N): não chove
                      nessas regiões até você apagá-las.
                    </p>
                  )}
                  {stats.dust > 0.05 && (
                    <p className="hint">
                      Poeira de impacto no ar: −{stats.dust.toFixed(1).replace('.', ',')} °C no planeta inteiro até
                      ela baixar.
                    </p>
                  )}
                  {s.autoClimate ? (
                    <p className="hint">
                      A simulação decide: ventos dos cinturões de latitude (alísios no sul quente, ventos de oeste no
                      meio, ventos polares no norte), estações do ano e pressão vinda do aquecimento. Os controles e
                      pincéis de temperatura e umidade ficam desligados.
                      {stats.season &&
                        ` Agora: ${stats.season.name}, ${stats.season.anomaly >= 0 ? '+' : ''}${stats.season.anomaly.toFixed(1)} °C.`}
                    </p>
                  ) : (
                    <>
                      <Slider
                        label="Temperatura"
                        value={s.temperature}
                        min={TEMPERATURE_MIN}
                        max={TEMPERATURE_MAX}
                        step={0.1}
                        format={(v) => `${v > 0 ? '+' : ''}${v.toFixed(1)} °C`}
                        onChange={(temperature) => engine.set({ temperature })}
                      />
                      <Toggle
                        label="Aquecimento contínuo"
                        checked={s.warming}
                        onChange={(warming) => engine.set({ warming })}
                      />
                      {s.warming && (
                        <Slider
                          label="Ritmo"
                          value={s.warmingRate}
                          min={0.1}
                          max={5}
                          step={0.1}
                          format={(v) => `${v.toFixed(1)} °C/min`}
                          onChange={(warmingRate) => engine.set({ warmingRate })}
                        />
                      )}
                      <Slider
                        label="Diferença norte–sul"
                        value={s.latitude}
                        min={0}
                        max={30}
                        step={1}
                        format={(v) => `${v} °C`}
                        onChange={(latitude) => engine.set({ latitude })}
                      />
                    </>
                  )}
                  <Toggle label="Oceano nas bordas" checked={s.ocean} onChange={(ocean) => engine.set({ ocean })} />
                  {s.ocean && (
                    <Slider
                      label="Nível do mar (base)"
                      value={s.seaLevel}
                      min={-0.1}
                      max={0.15}
                      step={0.005}
                      format={(v) => v.toFixed(3)}
                      onChange={(seaLevel) => engine.set({ seaLevel })}
                    />
                  )}
                  {s.ocean && <Toggle label="Marés" checked={s.tides} onChange={(tides) => engine.set({ tides })} />}
                  <p className="hint">
                    Congela acima de {climateOf(s).snowLine.toFixed(3)} no centro
                    {s.ocean && ` · mar ${climateOf(s).seaLevel.toFixed(3)}`}
                    {s.ocean && stats.tide !== 0 && ` · maré ${stats.tide > 0 ? '+' : ''}${(stats.tide * 1000).toFixed(1)}‰`}
                    {s.ocean && stats.civWarming > 0 && ` · o aquecimento industrial sobe o mar ${(stats.civWarming * 4).toFixed(0)}‰`}
                  </p>
                </Section>
                <Section title="Dia e noite">
                  <Toggle
                    label="Ciclo de dia e noite"
                    checked={s.dayNight}
                    onChange={(dayNight) => engine.set({ dayNight })}
                  />
                  <Slider
                    label="Hora"
                    value={s.timeOfDay}
                    min={0}
                    max={0.999}
                    step={1 / 96}
                    format={clockOf}
                    onChange={(timeOfDay) => engine.set({ timeOfDay })}
                  />
                  {s.dayNight && (
                    <Slider
                      label="Duração do dia"
                      value={s.dayLength}
                      min={1}
                      max={20}
                      step={1}
                      format={(v) => `${v} min`}
                      onChange={(dayLength) => engine.set({ dayLength })}
                    />
                  )}
                  <p className="hint">
                    O sol esquenta mais a terra que a água: de dia a brisa vem do mar e sobe as encostas, e nas tardes
                    quentes formam-se nuvens de chuva. À noite o vento se inverte.
                  </p>
                </Section>
                <Section title="Vento e chuva">
                  <p className="hint">
                    O vento contorna montanhas e acelera nos vales entre elas. A bússola no canto mostra o norte e o
                    vento dominante; as setas no mapa ficam maiores e mais vermelhas onde ele é forte.
                  </p>
                  {!s.autoClimate && (
                    <>
                      <Slider
                        label="Direção"
                        value={s.windDirection}
                        min={0}
                        max={345}
                        step={15}
                        format={compass}
                        onChange={(windDirection) => engine.set({ windDirection })}
                      />
                      <Slider
                        label="Força"
                        value={s.windSpeed}
                        min={0}
                        max={2}
                        step={0.1}
                        format={(v) => (v === 0 ? 'parado' : `${v.toFixed(1)}`)}
                        onChange={(windSpeed) => engine.set({ windSpeed })}
                      />
                      <Toggle
                        label="Vento variável (oscila ±40°)"
                        checked={s.windVariation}
                        onChange={(windVariation) => engine.set({ windVariation })}
                      />
                      <Slider
                        label="Umidade do vento"
                        value={s.windHumidity}
                        min={0}
                        max={1}
                        step={0.05}
                        format={(v) => `${Math.round(v * 100)}%`}
                        onChange={(windHumidity) => engine.set({ windHumidity })}
                      />
                      <Slider
                        label="Quantidade de chuva"
                        value={s.rainAmount}
                        min={0.25}
                        max={3}
                        step={0.25}
                        format={(v) => `${v}×`}
                        onChange={(rainAmount) => engine.set({ rainAmount })}
                      />
                    </>
                  )}
                  <Toggle
                    label="Altas e baixas pressões"
                    checked={s.pressureSystems}
                    onChange={(pressureSystems) => engine.set({ pressureSystems })}
                  />
                  {s.pressureSystems && (
                    <Slider
                      label="Intensidade dos sistemas"
                      value={s.pressureStrength}
                      min={0.25}
                      max={3}
                      step={0.25}
                      format={(v) => `${v}×`}
                      onChange={(pressureStrength) => engine.set({ pressureStrength })}
                    />
                  )}
                  <p className="hint">
                    Ar mais quente que a vizinhança (terra ao sol, lava, chuva liberando calor) forma baixa pressão; ar
                    mais frio forma alta. Os sistemas andam com o vento e se desfazem aos poucos. Para criar uma alta ou
                    uma baixa onde quiser, use o pincel Pressão (tecla 9).
                  </p>
                </Section>
              </>
            )}
            {tab === 'map' && (
              <>
                <Section title="Mapa">
                  <Segmented
                    value={s.overlay}
                    options={OVERLAYS}
                    onChange={(overlay) => engine.set({ overlay })}
                    wrap
                  />
                  <div className="toggles">
                    <Toggle
                      label="Setas de vento"
                      checked={s.windArrows}
                      onChange={(windArrows) => engine.set({ windArrows })}
                    />
                    <Toggle label="Nuvens" checked={s.clouds} onChange={(clouds) => engine.set({ clouds })} />
                  </div>
                  {s.overlay === 'biome' && (
                    <ul className="legend">
                      {BIOMES.map(([name, color]) => (
                        <li key={name}>
                          <span className="swatch" style={{ background: color }} />
                          {name}
                        </li>
                      ))}
                    </ul>
                  )}
                  {s.overlay === 'temperature' && (
                    <p className="hint">Azul: abaixo de 0 °C · branco: 0 °C · vermelho: até 35 °C.</p>
                  )}
                  {s.overlay === 'erosion' && (
                    <>
                      <ul className="legend single">
                        {EROSION_LEGEND.map(([name, color, what]) => (
                          <li key={name}>
                            <span className="swatch" style={{ background: color }} />
                            <span>
                              {name}
                              {what && <span className="muted"> · {what}</span>}
                            </span>
                          </li>
                        ))}
                      </ul>
                      <p className="hint">
                        Cada lugar mostra o processo que mais desgasta ali agora; quanto mais forte a cor, mais rápido.
                      </p>
                    </>
                  )}
                  {s.overlay === 'change' && (
                    <>
                      <ul className="legend">
                        <li>
                          <span className="swatch" style={{ background: 'rgb(242 107 51)' }} />
                          Desgastado
                        </li>
                        <li>
                          <span className="swatch" style={{ background: 'rgb(64 140 255)' }} />
                          Depositado
                        </li>
                      </ul>
                      <p className="hint">
                        Quanto o terreno baixou ou subiu desde a referência (o mundo novo, um arquivo carregado ou o
                        botão abaixo). A cor satura perto de 3 cm de altura.
                      </p>
                      <button type="button" className="wide" onClick={() => engine.resetChange()}>
                        Zerar referência (contar a partir de agora)
                      </button>
                    </>
                  )}
                  {s.overlay === 'rivers' && (
                    <p className="hint">
                      A rede de drenagem: a terra fica apagada e a água aparece pela vazão, de riachos claros a rios
                      grandes em azul escuro. Bom para ver as bacias e onde os rios se juntam.
                    </p>
                  )}
                  {s.overlay === 'plates' && (
                    <p className="hint">
                      Cada placa tectônica com uma cor e as bordas em linha escura; as setas mostram para onde cada
                      uma se move. Vermelho: as placas estão levantando a rocha (colisão, arco de montanhas). Azul:
                      afundando (fossa, rifte). Use a ferramenta Placas (U) para mudar a direção.
                    </p>
                  )}
                  {s.overlay === 'rain' && <p className="hint">Chuva média recente: marrom seco, azul chuvoso.</p>}
                  {s.overlay === 'humidity' && (
                    <p className="hint">Umidade do ar: marrom seco, branco saturado (nuvens).</p>
                  )}
                  {s.overlay === 'airmass' && (
                    <p className="hint">
                      Massas de ar: azul mais frio que o normal da latitude, laranja mais quente. Roxo: o ar é
                      forçado a subir (frentes e tempestades); escuro: desce. Quadriculado: massa de ar fixa
                      pintada ali.
                    </p>
                  )}
                  {s.overlay === 'pressure' && (
                    <p className="hint">
                      Roxo: baixa pressão (nuvens e chuva, o vento gira no sentido anti-horário). Laranja: alta (tempo
                      seco).
                    </p>
                  )}
                  {s.overlay === 'current' && (
                    <p className="hint">
                      Correntes marinhas: mar mais quente que o normal em vermelho, mais frio em azul. O vento arrasta
                      a corrente pela superfície; o ar que passa por cima dela esquenta e umedece (ou esfria e seca)
                      e leva isso para a costa a sotavento. Pinte com o pincel Corrente (O), só no mar.
                    </p>
                  )}
                  {s.overlay === 'civilization' && (
                    <>
                      <p className="hint">
                        O mapa dos povos: cada povo pinta suas terras; fronteiras em linha escura, frentes de guerra em
                        vermelho pulsando, batalhas marcadas no chão. As cidades mostram a população (casas) e a
                        tecnologia (torre, paredes de pedra).
                        {!s.life && ' Ligue a vida na aba Mundo para ver os povos.'}
                      </p>
                      {stats.life && stats.life.civs.length > 0 && (
                        <ul className="legend single">
                          {stats.life.civs.map((c) => (
                            <li key={c.id}>
                              <span className="swatch" style={{ background: civCss(c.color) }} />
                              <span className="civ-name">
                                {c.name}
                                {c.atWar ? ' ⚔' : ''}
                              </span>
                              <span className="muted">
                                {c.towns} {c.towns === 1 ? 'cidade' : 'cidades'} · {c.people} pessoas
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </>
                  )}
                </Section>
                <button type="button" className={`wide ${section ? 'active' : ''}`} onClick={() => onSection(!section)}>
                  {section ? 'Esconder corte transversal' : 'Mostrar corte transversal'}
                </button>
                <Section title="Análise do clima">
                  {stats.climate ? <ClimateAnalysis report={stats.climate} /> : <p className="hint">Analisando…</p>}
                </Section>
              </>
            )}
            {tab === 'world' && (
              <>
                <section className="scenario-current">
                  <div
                    className="scenario-swatch"
                    style={{
                      background: `linear-gradient(160deg, ${scenarioById(s.scenario).colors[0]}, ${scenarioById(s.scenario).colors[1]})`,
                    }}
                  />
                  <div>
                    <div className="eyebrow">Cenário</div>
                    <strong>{scenarioById(s.scenario).name}</strong>
                  </div>
                  <button type="button" onClick={onNewWorld}>
                    <Icon.sparkles size={16} /> Trocar
                  </button>
                </section>
                <Section title="Processos">
                  <div className="toggles">
                    <Toggle label="Chuva" checked={s.rain} onChange={(rain) => engine.set({ rain })} />
                    <Toggle
                      label="Evaporação"
                      checked={s.evaporate}
                      onChange={(evaporate) => engine.set({ evaporate })}
                    />
                    <Toggle label="Erosão" checked={s.erode} onChange={(erode) => engine.set({ erode })} />
                    <Toggle
                      label="Vegetação"
                      checked={s.vegetation}
                      onChange={(vegetation) => engine.set({ vegetation })}
                    />
                  </div>
                  <div className="field">
                    <span className="field-label">Tempo geológico</span>
                    <Segmented
                      value={String(s.geologicTime) as '1' | '10' | '30'}
                      options={[
                        { id: '1', label: '1×' },
                        { id: '10', label: '10×' },
                        { id: '30', label: '30×' },
                      ]}
                      onChange={(v) => engine.set({ geologicTime: Number(v) as 1 | 10 | 30 })}
                    />
                    <p className="hint">
                      Acelera erosão, intemperismo e o movimento das placas tectônicas; a água e o clima seguem no
                      ritmo normal. Bom para ver vales, cânions e cordilheiras se formarem.
                    </p>
                  </div>
                  <Toggle
                    label="Terremotos"
                    checked={s.earthquakes}
                    onChange={(earthquakes) => engine.set({ earthquakes })}
                  />
                  <Toggle label="Vulcões" checked={s.volcanoes} onChange={(volcanoes) => engine.set({ volcanoes })} />
                  {stats.volcanoes.length > 0 && (
                    <p className="hint">
                      Vulcões:{' '}
                      {stats.volcanoes.map((v) => `${v.name} (${v.erupting ? 'em erupção' : 'adormecido'})`).join(', ')}. Nascem
                      onde as placas colidem ou se afastam, erguem um cone de lava a cada erupção e a cinza esfria a região.
                    </p>
                  )}
                  <Slider
                    label="Deriva das placas"
                    value={s.plateDrift}
                    min={0}
                    max={3}
                    step={0.1}
                    format={(v) => `${v.toFixed(1).replace('.', ',')}×`}
                    onChange={(plateDrift) => engine.set({ plateDrift })}
                  />
                  <p className="hint">
                    As placas deslizam de verdade: as fronteiras migram, placas crescem e encolhem, e as
                    cordilheiras ficam para trás de onde a fronteira passou. Veja no mapa Placas (tecla U para
                    arrastar uma placa).
                  </p>
                </Section>
                <Section title="Terreno">
                  <Toggle
                    label="Mundo infinito"
                    checked={s.infiniteWorld}
                    onChange={(infiniteWorld) => engine.set({ infiniteWorld })}
                  />
                  {s.infiniteWorld && (
                    <p className="hint">
                      Ande com WASD ou arrastando: a simulação acompanha a câmera, uma região por vez. As regiões que
                      você deixa para trás ficam guardadas como estavam ({stats.storedRegions} até agora). Ao norte fica
                      mais frio, ao sul mais quente. Mudar de região limpa o desfazer.
                    </p>
                  )}
                  <Slider
                    label="Seed"
                    value={s.seed}
                    min={1}
                    max={1000}
                    step={1}
                    format={(v) => `${v}`}
                    onChange={(seed) => engine.set({ seed })}
                  />
                  <div className="row">
                    <button type="button" onClick={() => engine.set({ seed: 1 + Math.floor(Math.random() * 1000) })}>
                      Seed aleatória
                    </button>
                    <button type="button" onClick={() => engine.regenerate()}>
                      Recriar
                    </button>
                  </div>
                  <div className="field">
                    <span className="field-label">Área simulada</span>
                    <Segmented
                      value={String(s.area) as '1' | '1.5' | '2' | '3' | '4'}
                      options={[
                        { id: '1', label: '1×', hint: 'O quadrado clássico' },
                        { id: '1.5', label: '1,5×', hint: '2,25× mais terreno simulado' },
                        { id: '2', label: '2×', hint: '4× mais terreno simulado' },
                        { id: '3', label: '3×', hint: '9× mais terreno simulado' },
                        { id: '4', label: '4×', hint: '16× mais terreno simulado' },
                      ]}
                      onChange={(v) => engine.set({ area: Number(v) as AreaSetting })}
                    />
                    <p className="hint">
                      Quanto terreno é simulado de verdade (rios, clima, erosão). Com a resolução automática o detalhe
                      se mantém e a GPU trabalha mais ({stats.resolution}² agora; até{' '}
                      {engine.supportsHugeWorld ? '2048²' : '1024²'} nesta GPU, depois o detalhe diminui). Mudar a área
                      cria um mundo novo.
                    </p>
                  </div>
                  <label className="select">
                    <span>Resolução</span>
                    <select
                      value={String(s.resolution)}
                      onChange={(e) => {
                        const v = e.target.value
                        engine.set({ resolution: v === 'auto' ? 'auto' : (Number(v) as ResolutionSetting) })
                      }}
                    >
                      {RESOLUTIONS.filter((r) => r.value !== 2048 || engine.supportsHugeWorld).map((r) => (
                        <option key={r.value} value={String(r.value)}>
                          {r.label}
                          {r.value === 'auto' && stats.resolution ? ` (${stats.resolution}²)` : ''}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="select">
                    <span>Qualidade gráfica</span>
                    <select value={s.quality} onChange={(e) => engine.set({ quality: e.target.value as Quality })}>
                      {QUALITIES.map((q) => (
                        <option key={q.value} value={q.value}>
                          {q.label}
                          {q.value === 'auto' ? ` (${QUALITY_NAMES[stats.quality]})` : ''}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="select">
                    <span>Limite de quadros</span>
                    <select value={String(s.fpsLimit)} onChange={(e) => engine.set({ fpsLimit: Number(e.target.value) as FpsLimit })}>
                      {FPS_LIMITS.map((f) => (
                        <option key={f.value} value={String(f.value)}>
                          {f.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <p className="hint">Menos quadros por segundo esquentam menos a placa de vídeo. Com a janela fora de foco o mapa é redesenhado só 10 vezes por segundo.</p>
                </Section>
                <Section title="Câmera">
                  <Segmented
                    value={s.cameraMode}
                    options={[
                      { id: 'orbit', label: 'Órbita' },
                      { id: 'fly', label: 'Voo livre' },
                    ]}
                    onChange={(cameraMode) => engine.set({ cameraMode })}
                  />
                  <button type="button" className="wide" onClick={() => engine.resetCamera()}>
                    Vista inicial <kbd>R</kbd>
                  </button>
                </Section>
                <Section title="Arquivo">
                  <div className="row">
                    <button type="button" onClick={() => void engine.save()}>
                      Salvar
                    </button>
                    <button type="button" onClick={() => pickFile(loadInput.current, (f) => void engine.load(f))}>
                      Carregar
                    </button>
                  </div>
                  <div className="row">
                    <button
                      type="button"
                      onClick={() => pickFile(imageInput.current, (f) => void engine.importHeightmap(f))}
                    >
                      Importar heightmap
                    </button>
                    <button type="button" disabled={!stats.undoDepth} onClick={() => engine.undo()}>
                      Desfazer ({stats.undoDepth})
                    </button>
                  </div>
                  <div className="row">
                    <button type="button" onClick={() => void engine.exportHeightmap()}>
                      <Icon.download size={16} /> Heightmap 16 bits
                    </button>
                    <button type="button" onClick={() => void engine.exportMesh()}>
                      <Icon.download size={16} /> Malha OBJ
                    </button>
                  </div>
                  <input ref={loadInput} type="file" accept=".craftscape" hidden />
                  <input ref={imageInput} type="file" accept="image/*" hidden />
                </Section>
                <p className="credits">
                  Baseado no Craftscape de Florian Boesch ·{' '}
                  <a href="https://github.com/danillog/craftscape" target="_blank" rel="noreferrer">
                    código-fonte (AGPL-3.0)
                  </a>
                </p>
              </>
            )}
          </div>
        </aside>
      )}
      <nav className="rail glass" aria-label="Painéis">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`rail-button ${tab === t.id ? 'active' : ''}`}
            aria-pressed={tab === t.id}
            onClick={() => onTab(tab === t.id ? null : t.id)}
            title={t.label}
          >
            <t.icon size={22} />
            <span>{t.label}</span>
          </button>
        ))}
      </nav>
    </div>
  )
}
