import type { Engine } from '../engine/engine'
import { BRUSH_MIN, brushMax, quakeMagnitude, type Tool } from '../engine/settings'
import { FIXED_AIR_LABELS, MODE_LABELS } from './constants'
import { Icon, TOOL_ICONS } from './icons'
import { useSettings, useStats } from './useEngine'
import { useEffect, useRef, useState } from 'react'
import { CIV_COLORS } from '../engine/life'

const civCss = (k: number) => `rgb(${CIV_COLORS[k].map((v) => Math.round(v * 255)).join(', ')})`

/**
 * The timeline strip: what the rewind ring covers, with a tick per snapshot and a dot per
 * event of the chronicle (bigger for the big ones). Click a point to go back there.
 */
function TimeStrip({ engine }: { engine: Engine }) {
  const stats = useStats(engine)
  const [hover, setHover] = useState<string | null>(null)
  const tl = stats.timeline
  if (tl.reach < 1) return null
  const at = (ago: number) => `${(100 * (1 - ago / tl.reach)).toFixed(2)}%`
  return (
    <div
      className="timestrip glass"
      role="slider"
      aria-label="Linha do tempo: clique para rebobinar até ali"
      aria-valuemin={0}
      aria-valuemax={Math.round(tl.reach)}
      aria-valuenow={Math.round(tl.reach)}
      onClick={(e) => {
        const r = e.currentTarget.getBoundingClientRect()
        const x = (e.clientX - r.left) / r.width
        engine.rewindTo((1 - Math.max(0, Math.min(1, x))) * tl.reach)
      }}
    >
      <span className="ts-label">−{Math.round(tl.reach)} s</span>
      <div className="ts-track">
        {tl.snapshots.map((ago, k) => (
          <span key={k} className="ts-tick" style={{ left: at(ago) }} />
        ))}
        {tl.marks.map((m, k) => (
          <span
            key={k}
            className={`ts-mark ${m.major ? 'major' : ''}`}
            style={{ left: at(m.ago), background: civCss(m.color) }}
            onPointerEnter={() => setHover(m.text)}
            onPointerLeave={() => setHover(null)}
          />
        ))}
      </div>
      <span className="ts-label">agora</span>
      {hover && <span className="ts-tip">{hover}</span>}
    </div>
  )
}

/** The powers, in their groups: shaping the land, blessings, plagues, and the advanced (climate machinery) ones. */
type Group = 'terra' | 'bencao' | 'praga' | 'povos' | 'avancado'
const GROUP_NAMES: Record<Group, string> = { terra: 'Terra', bencao: 'Bênçãos', praga: 'Pragas', povos: 'Povos', avancado: 'Avançado' }
/** key: the shortcut, or '' for a power that is only picked on the bar. */
const TOOLS: { id: Tool; label: string; key: string; hint: string; group: Group }[] = [
  { id: 'inspect', label: 'Inspecionar', key: '0', hint: 'O cursor mostra o que há em cada lugar (Esc volta para cá)', group: 'terra' },
  { id: 'rock', label: 'Rocha', key: '1', hint: 'Levanta ou cava montanhas', group: 'terra' },
  { id: 'soil', label: 'Solo', key: '2', hint: 'Terra fértil, onde a vegetação cresce', group: 'terra' },
  { id: 'sand', label: 'Areia', key: '3', hint: 'Desliza em encostas e anda com o vento', group: 'terra' },
  { id: 'water', label: 'Água', key: '4', hint: 'Cria lagos e rios', group: 'terra' },
  { id: 'level', label: 'Nivelar', key: '5', hint: 'Aplaina na altura onde a pincelada começou', group: 'terra' },
  { id: 'forest', label: 'Floresta', key: '', hint: 'Segure: planta mato e floresta onde há solo (−: desmata)', group: 'terra' },
  { id: 'humidity', label: 'Chuva', key: '7', hint: 'Ar úmido: nuvens e chuva onde você pintar (−: seca o ar)', group: 'bencao' },
  { id: 'heat', label: 'Calor', key: '6', hint: 'Esquenta a região (−: esfria)', group: 'bencao' },
  { id: 'sun', label: 'Sol', key: 'J', hint: 'Clique: o planeta inteiro esquenta 1 °C (−: esfria 1 °C). Vale em qualquer clima', group: 'bencao' },
  { id: 'drought', label: 'Seca', key: 'N', hint: 'Clique: uma alta pressão fixa trava a chuva na região até você apagá-la (−). O tamanho do pincel dá o tamanho dela', group: 'praga' },
  { id: 'storm', label: 'Tempestade', key: 'T', hint: 'Clique: nasce um ciclone que o vento leva, com chuva e vento forte (o tamanho do pincel dá o tamanho dele)', group: 'praga' },
  { id: 'volcano', label: 'Vulcão', key: '8', hint: 'Abre uma cratera que entra em erupção', group: 'praga' },
  { id: 'meteor', label: 'Meteoro', key: 'I', hint: 'Clique: cratera, lava, terremoto e poeira que esfria o planeta (o tamanho do pincel dá o tamanho da cratera)', group: 'praga' },
  { id: 'fire', label: 'Fogo', key: 'V', hint: 'Clique ou arraste: acende o mato; o fogo corre com o vento e a chuva apaga (−: apaga o fogo)', group: 'praga' },
  { id: 'hurricane', label: 'Furacão', key: 'Y', hint: 'Clique no mar: nasce um furacão com nome. Cresce sobre mar quente até a categoria 5, anda com o vento e morre em terra ou em mar frio', group: 'praga' },
  { id: 'quake', label: 'Terremoto', key: 'G', hint: 'Clique: um terremoto e suas réplicas. O pincel dá a magnitude (5 a 9,5). De 8,5 para cima a terra racha; no mar, tsunami. Três de 9 ou mais em seguida: cataclismo', group: 'praga' },
  { id: 'nuke', label: 'Guerra nuclear', key: '', hint: 'Clique numa cidade: o povo dela lança ogivas contra o inimigo (os deuses dão a bomba a quem não a tem). Fora das cidades: uma bomba cai ali. Terra queimada, radiação por anos e céu escuro', group: 'praga' },
  { id: 'people', label: 'Povo', key: 'L', hint: 'Clique em terra boa: um povo novo nasce aqui', group: 'povos' },
  { id: 'bless', label: 'Bênção', key: '', hint: 'Clique numa cidade: celeiros cheios, gente saudável, a cidade cresce', group: 'povos' },
  { id: 'inspire', label: 'Inspiração', key: '', hint: 'Clique numa cidade: uma ideia brilhante, o povo avança no saber (rumo à próxima era)', group: 'povos' },
  { id: 'plague', label: 'Peste', key: '', hint: 'Clique numa cidade: uma peste irrompe e se espalha', group: 'povos' },
  { id: 'prophet', label: 'Profeta', key: '', hint: 'Clique numa cidade: um profeta converte o povo a outra fé', group: 'povos' },
  { id: 'discord', label: 'Discórdia', key: '', hint: 'Clique numa cidade: o povo entra em guerra com o vizinho mais próximo', group: 'povos' },
  { id: 'peace', label: 'Paz', key: '', hint: 'Clique numa cidade: todas as guerras desse povo terminam numa trégua', group: 'povos' },
  { id: 'pressure', label: 'Pressão', key: '9', hint: 'Altas (tempo firme) ou baixas (nuvens e chuva) que o tempo dissolve', group: 'avancado' },
  { id: 'airmass', label: 'Massa de ar', key: 'M', hint: 'Ar quente ou frio que o vento leva embora, formando frentes', group: 'avancado' },
  { id: 'current', label: 'Corrente', key: 'O', hint: 'Corrente marinha quente ou fria: pinte no mar e o ar que passa por cima muda', group: 'avancado' },
  { id: 'plates', label: 'Placas', key: 'U', hint: 'Arraste sobre uma placa para mudar a direção em que ela se move', group: 'avancado' },
]
const GROUPS: Group[] = ['terra', 'bencao', 'praga', 'povos', 'avancado']
const ONE_SHOT: Tool[] = ['storm', 'meteor', 'hurricane', 'quake', 'nuke', 'people', 'bless', 'inspire', 'plague', 'prophet', 'discord', 'peace']

const SPEEDS = [0.5, 1, 2, 4]

/** Bottom bar: tools, add/remove, brush, undo and the simulation clock. */
export function Toolbar({ engine }: { engine: Engine }) {
  const s = useSettings(engine)
  const stats = useStats(engine)
  // hold to rewind: one snapshot back every 350 ms while the button is pressed
  const rewindTimer = useRef(0)
  const stopRewind = () => {
    if (!rewindTimer.current) return
    clearInterval(rewindTimer.current)
    rewindTimer.current = 0
    engine.rewindEnd()
  }
  const startRewind = () => {
    stopRewind()
    engine.rewind()
    rewindTimer.current = window.setInterval(() => engine.rewind(), 350)
  }
  useEffect(() => stopRewind, []) // eslint-disable-line react-hooks/exhaustive-deps
  const tools = TOOLS.filter((t) => !(s.autoClimate && (t.id === 'heat' || t.id === 'humidity')) && !(t.group === 'povos' && !s.life))
  const current = TOOLS.find((t) => t.id === s.tool)!
  // the advanced powers stay folded until asked for (or while one of them is in hand)
  const [advanced, setAdvanced] = useState(false)
  const showAdvanced = advanced || current.group === 'avancado'
  // so do the powers over the peoples
  const [peoples, setPeoples] = useState(false)
  const showPeoples = s.life && (peoples || current.group === 'povos')
  const [addLabel, removeLabel] =
    s.tool === 'airmass' && s.airMassFixed ? FIXED_AIR_LABELS : (MODE_LABELS[s.tool] ?? ['Adicionar', 'Remover'])
  // the size slider is logarithmic: the biggest brush on a 4× map is 60× the smallest
  const [logMin, logMax] = [Math.log(BRUSH_MIN), Math.log(brushMax(s.area))]
  const brushPx = Math.round(((Math.log(s.brushSize) - logMin) / (logMax - logMin)) * 22 + 8)

  return (
    <>
    <TimeStrip engine={engine} />
    <div className="toolbar glass" role="toolbar" aria-label="Ferramentas">
      {GROUPS.map((group) => {
        if (group === 'avancado' && !showAdvanced) return null
        if (group === 'povos' && !showPeoples) return null
        const members = tools.filter((t) => t.group === group)
        if (!members.length) return null
        return (
          <div key={group} className={`tool-group group-${group}`} role="radiogroup" aria-label={GROUP_NAMES[group]}>
            <span className="group-name">{GROUP_NAMES[group]}</span>
            {members.map((t) => {
              const ToolIcon = TOOL_ICONS[t.id]
              return (
                <button
                  key={t.id}
                  type="button"
                  role="radio"
                  aria-checked={s.tool === t.id}
                  className={`tool tool-${t.id} ${s.tool === t.id ? 'active' : ''}`}
                  onClick={() => engine.set({ tool: t.id })}
                  data-tip={`${t.label} · ${t.hint}`}
                >
                  <ToolIcon size={22} />
                  {t.key && <kbd>{t.key}</kbd>}
                </button>
              )
            })}
          </div>
        )
      })}
      {s.life && (
        <button
          type="button"
          className={`more ${showPeoples ? 'active' : ''}`}
          onClick={() => setPeoples(!showPeoples)}
          data-tip={showPeoples ? 'Esconde os poderes sobre os povos' : 'Poderes sobre os povos: novo povo, bênção, inspiração, peste, profeta, discórdia, paz'}
          aria-pressed={showPeoples}
        >
          {showPeoples ? '‹' : <Icon.life size={16} />}
        </button>
      )}
      <button
        type="button"
        className={`more ${showAdvanced ? 'active' : ''}`}
        onClick={() => setAdvanced(!showAdvanced)}
        data-tip={showAdvanced ? 'Esconde os poderes avançados' : 'Poderes avançados: pressão, massa de ar, corrente marinha, placas'}
        aria-pressed={showAdvanced}
      >
        {showAdvanced ? '‹' : '…'}
      </button>

      <div className="divider" />

      <div className="tool-meta">
        <div className="tool-name">
          <strong>{current.label}</strong>
          {s.tool !== 'level' && s.tool !== 'inspect' && s.tool !== 'plates' && !ONE_SHOT.includes(s.tool) && (
            <div className="mode-switch" role="radiogroup" aria-label="Modo">
              <button
                type="button"
                role="radio"
                aria-checked={s.mode === 'add'}
                className={s.mode === 'add' ? 'active' : ''}
                onClick={() => engine.set({ mode: 'add' })}
                data-tip={`${addLabel} (X alterna)`}
              >
                <Icon.plus size={16} />
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={s.mode === 'remove'}
                className={s.mode === 'remove' ? 'active' : ''}
                onClick={() => engine.set({ mode: 'remove' })}
                data-tip={`${removeLabel} (X alterna)`}
              >
                <Icon.minus size={16} />
              </button>
            </div>
          )}
        </div>
        {s.tool === 'inspect' ? (
          <p className="tool-hint">Passe o mouse sobre o terreno. Escolha um poder para agir.</p>
        ) : s.tool === 'sun' ? (
          <p className="tool-hint">
            Clique em qualquer lugar. Sol agora: {stats.godWarming > 0 ? '+' : ''}
            {stats.godWarming.toFixed(0)} °C no planeta inteiro.
          </p>
        ) : s.tool === 'plates' ? (
          <p className="tool-hint">Arraste de uma placa para onde ela deve ir. Quanto mais longe, mais rápido.</p>
        ) : current.group === 'povos' && s.tool !== 'people' ? (
          <p className="tool-hint">Clique numa cidade. O poder vale para a cidade ou para o povo dela.</p>
        ) : s.tool === 'people' ? (
          <p className="tool-hint">Clique em terra firme, com mato e longe de outras cidades.</p>
        ) : s.tool === 'nuke' ? (
          <p className="tool-hint">Clique numa cidade (o povo dela ataca) ou em qualquer lugar (uma bomba cai ali).</p>
        ) : (
          <div className="brush-controls">
            <div className="brush-preview" aria-hidden="true">
              <span style={{ width: brushPx, height: brushPx, opacity: 0.35 + 0.15 * s.brushStrength }} />
            </div>
            <label
              className="mini-slider"
              data-tip={s.tool === 'quake' ? 'Magnitude do terremoto ( [ ] ou Shift + roda )' : 'Tamanho do pincel ( [ ] ou Shift + roda )'}
            >
              <span>{s.tool === 'quake' ? `Magnitude ${quakeMagnitude(s.brushSize, s.area).toFixed(1).replace('.', ',')}` : 'Tamanho'}</span>
              <input
                type="range"
                min={logMin}
                max={logMax}
                step={0.01}
                value={Math.log(s.brushSize)}
                onChange={(e) => engine.set({ brushSize: Math.exp(Number(e.target.value)) })}
              />
            </label>
            <label className="mini-slider" data-tip={`Intensidade ${s.brushStrength}×`}>
              <span>Força</span>
              <input
                type="range"
                min={0.25}
                max={4}
                step={0.25}
                value={s.brushStrength}
                onChange={(e) => engine.set({ brushStrength: Number(e.target.value) })}
              />
            </label>
            {s.tool === 'airmass' && (
              <div className="mode-switch air-fixed" role="group" aria-label="Massa de ar fixa">
                <button
                  type="button"
                  aria-pressed={s.airMassFixed}
                  className={s.airMassFixed ? 'active' : ''}
                  onClick={() => engine.set({ airMassFixed: !s.airMassFixed })}
                  data-tip={
                    s.airMassFixed
                      ? 'Fixa: a massa fica no lugar e o vento leva ar dela, formando frentes sem parar'
                      : 'Solta: o vento leva a massa embora de uma vez'
                  }
                >
                  {s.airMassFixed ? 'Fixa' : 'Solta'}
                </button>
                {s.airMassFixed && (
                  <button
                    type="button"
                    onClick={() => engine.clearAirSources()}
                    data-tip="Apaga todas as massas fixas do mapa (Ctrl + Z desfaz)"
                  >
                    Apagar
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="divider" />

      <button
        type="button"
        className={`icon-button ${s.paintOnClick ? 'active' : ''}`}
        aria-pressed={s.paintOnClick}
        onClick={() => engine.set({ paintOnClick: !s.paintOnClick })}
        data-tip={s.paintOnClick ? 'Clique pinta (clique para girar a câmera)' : 'Pintar com clique (ou segure Espaço)'}
      >
        <Icon.brush size={20} />
      </button>
      <button
        type="button"
        className="icon-button"
        disabled={!stats.undoDepth}
        onClick={() => engine.undo()}
        data-tip={`Desfazer (Ctrl+Z) · ${stats.undoDepth}`}
      >
        <Icon.undo size={20} />
      </button>
      <button
        type="button"
        className="icon-button"
        disabled={stats.rewindSeconds < 1}
        onPointerDown={startRewind}
        onPointerUp={stopRewind}
        onPointerLeave={stopRewind}
        onPointerCancel={stopRewind}
        data-tip={`Rebobinar: segure (ou tecla B) · até ${Math.round(stats.rewindSeconds)} s atrás`}
        aria-label="Rebobinar"
      >
        <Icon.rewind size={20} />
      </button>

      <div className="divider" />

      <div className="clock">
        <button
          type="button"
          className={`play ${s.paused ? 'paused' : ''}`}
          onClick={() => engine.set({ paused: !s.paused })}
          data-tip={s.paused ? 'Continuar (P)' : 'Pausar (P)'}
          aria-label={s.paused ? 'Continuar' : 'Pausar'}
        >
          {s.paused ? <Icon.play size={18} /> : <Icon.pause size={18} />}
        </button>
        <button
          type="button"
          className={`geo ${s.geologicTime > 1 ? 'active' : ''}`}
          onClick={() => engine.set({ geologicTime: s.geologicTime === 1 ? 10 : s.geologicTime === 10 ? 30 : 1 })}
          data-tip="Tempo geológico: erosão, intemperismo e tectônica mais rápidos (a água e o clima não)"
        >
          <Icon.uplift size={16} />
          {s.geologicTime}×
        </button>
        <div className="speeds" role="radiogroup" aria-label="Velocidade">
          {SPEEDS.map((v) => (
            <button
              key={v}
              type="button"
              role="radio"
              aria-checked={s.speed === v}
              className={s.speed === v ? 'active' : ''}
              onClick={() => engine.set({ speed: v, paused: false })}
            >
              {v}×
            </button>
          ))}
        </div>
      </div>
    </div>
    </>
  )
}
