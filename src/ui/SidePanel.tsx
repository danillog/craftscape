import { useRef, type ReactNode } from 'react'
import type { Engine } from '../engine/engine'
import { scenarioById } from '../engine/scenarios'
import {
  TEMPERATURE_MAX,
  TEMPERATURE_MIN,
  climateOf,
  type AreaSetting,
  type Quality,
  type ResolutionSetting,
} from '../engine/settings'
import { clockOf } from '../engine/sky'
import { BIOMES, EROSION_LEGEND, OVERLAYS, QUALITIES, QUALITY_NAMES, RESOLUTIONS, compass } from './constants'
import { ClimateAnalysis, Section, Segmented, Slider, Toggle } from './controls'
import { Icon } from './icons'
import { useSettings, useStats } from './useEngine'

export type PanelTab = 'climate' | 'map' | 'world'

const TABS: { id: PanelTab; label: string; icon: (p: { size?: number }) => ReactNode }[] = [
  { id: 'climate', label: 'Clima', icon: Icon.climate },
  { id: 'map', label: 'Mapa', icon: Icon.layers },
  { id: 'world', label: 'Mundo', icon: Icon.globe },
]

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
            {tab === 'climate' && (
              <>
                <Section title="Clima">
                  <Toggle
                    label="Clima automático"
                    checked={s.autoClimate}
                    onChange={(autoClimate) => engine.set({ autoClimate })}
                  />
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
                  <p className="hint">
                    Congela acima de {climateOf(s).snowLine.toFixed(3)} no centro
                    {s.ocean && ` · mar ${climateOf(s).seaLevel.toFixed(3)}`}
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
                  {s.overlay === 'rain' && <p className="hint">Chuva média recente: marrom seco, azul chuvoso.</p>}
                  {s.overlay === 'humidity' && (
                    <p className="hint">Umidade do ar: marrom seco, branco saturado (nuvens).</p>
                  )}
                  {s.overlay === 'pressure' && (
                    <p className="hint">
                      Roxo: baixa pressão (nuvens e chuva, o vento gira no sentido anti-horário). Laranja: alta (tempo
                      seco).
                    </p>
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
                      Acelera erosão, intemperismo e as zonas tectônicas (pincel Tectônica, tecla U); a água e o clima
                      seguem no ritmo normal. Bom para ver vales e cânions se formarem.
                    </p>
                  </div>
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
                      value={String(s.area) as '1' | '1.5' | '2'}
                      options={[
                        { id: '1', label: '1×', hint: 'O quadrado clássico' },
                        { id: '1.5', label: '1,5×', hint: '2,25× mais terreno simulado' },
                        { id: '2', label: '2×', hint: '4× mais terreno simulado' },
                      ]}
                      onChange={(v) => engine.set({ area: Number(v) as AreaSetting })}
                    />
                    <p className="hint">
                      Quanto terreno é simulado de verdade (rios, clima, erosão). Com a resolução automática o detalhe
                      se mantém e a GPU trabalha mais ({stats.resolution}² agora). Mudar a área cria um mundo novo.
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
                      {RESOLUTIONS.map((r) => (
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
