import type { Engine } from '../engine/engine'
import { BRUSH_MAX, BRUSH_MIN, type Tool } from '../engine/settings'
import { MODE_LABELS } from './constants'
import { Icon, TOOL_ICONS } from './icons'
import { useSettings, useStats } from './useEngine'

const TOOLS: { id: Tool; label: string; key: string; hint: string }[] = [
  { id: 'inspect', label: 'Inspecionar', key: '0', hint: 'O cursor mostra o que há em cada lugar (Esc volta para cá)' },
  { id: 'rock', label: 'Rocha', key: '1', hint: 'Levanta ou cava montanhas' },
  { id: 'soil', label: 'Solo', key: '2', hint: 'Terra fértil, onde a vegetação cresce' },
  { id: 'sand', label: 'Areia', key: '3', hint: 'Desliza em encostas e anda com o vento' },
  { id: 'water', label: 'Água', key: '4', hint: 'Cria lagos e rios' },
  { id: 'level', label: 'Nivelar', key: '5', hint: 'Aplaina na altura onde a pincelada começou' },
  { id: 'heat', label: 'Calor', key: '6', hint: 'Esquenta ou esfria o clima local' },
  { id: 'humidity', label: 'Umidade', key: '7', hint: 'Deixa o ar mais úmido ou mais seco' },
  { id: 'volcano', label: 'Vulcão', key: '8', hint: 'Abre uma cratera que entra em erupção' },
  { id: 'pressure', label: 'Pressão', key: '9', hint: 'Cria altas (tempo firme) ou baixas (nuvens e chuva)' },
  { id: 'uplift', label: 'Tectônica', key: 'U', hint: 'Marca zonas que sobem (ou afundam) com o tempo' },
]

const SPEEDS = [0.5, 1, 2, 4]

/** Bottom bar: tools, add/remove, brush, undo and the simulation clock. */
export function Toolbar({ engine }: { engine: Engine }) {
  const s = useSettings(engine)
  const stats = useStats(engine)
  const tools = TOOLS.filter((t) => !(s.autoClimate && (t.id === 'heat' || t.id === 'humidity')))
  const current = TOOLS.find((t) => t.id === s.tool)!
  const [addLabel, removeLabel] = MODE_LABELS[s.tool] ?? ['Adicionar', 'Remover']
  const brushPx = Math.round(((s.brushSize - BRUSH_MIN) / (BRUSH_MAX - BRUSH_MIN)) * 22 + 8)

  return (
    <div className="toolbar glass" role="toolbar" aria-label="Ferramentas">
      <div className="tool-group" role="radiogroup" aria-label="Ferramenta">
        {tools.map((t) => {
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
              <kbd>{t.key}</kbd>
            </button>
          )
        })}
      </div>

      <div className="divider" />

      <div className="tool-meta">
        <div className="tool-name">
          <strong>{current.label}</strong>
          {s.tool !== 'level' && s.tool !== 'inspect' && (
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
          <p className="tool-hint">Passe o mouse sobre o terreno. Escolha uma ferramenta para pintar.</p>
        ) : (
          <div className="brush-controls">
            <div className="brush-preview" aria-hidden="true">
              <span style={{ width: brushPx, height: brushPx, opacity: 0.35 + 0.15 * s.brushStrength }} />
            </div>
            <label className="mini-slider" data-tip="Tamanho do pincel ( [ ] ou Shift + roda )">
              <span>Tamanho</span>
              <input
                type="range"
                min={BRUSH_MIN}
                max={BRUSH_MAX}
                step={0.001}
                value={s.brushSize}
                onChange={(e) => engine.set({ brushSize: Number(e.target.value) })}
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
  )
}
