import type { Engine } from '../engine/engine'
import { useSettings } from './useEngine'

const GROUPS: { title: string; items: [string, string][] }[] = [
  {
    title: 'Pintar',
    items: [
      ['Espaço (segurar)', 'pinta onde está o cursor'],
      ['0 · Esc', 'inspecionar: o cursor mostra o lugar'],
      ['1 2 3 4 5', 'rocha, solo, areia, água, nivelar'],
      ['6 7', 'clima local: calor, umidade'],
      ['8', 'vulcão'],
      ['9', 'pressão: alta (+) ou baixa (−)'],
      ['U', 'tectônica: zona que sobe (+) ou afunda (−)'],
      ['X', 'alterna adicionar / remover'],
      ['[ ] ou - +', 'tamanho do pincel'],
      ['Shift + roda', 'tamanho do pincel'],
      ['Ctrl + Z', 'desfazer'],
    ],
  },
  {
    title: 'Câmera',
    items: [
      ['Arrastar', 'gira em volta do ponto sob o cursor'],
      ['Setas', 'giram a câmera (Shift: rápido)'],
      ['Botão direito / Shift + arrastar', 'move a câmera'],
      ['Roda do mouse', 'zoom na direção do cursor'],
      ['Duplo clique · F', 'centraliza no ponto sob o cursor'],
      ['W A S D · Q E', 'mover · descer/subir (Shift: rápido)'],
      ['R', 'volta à vista inicial'],
      ['C', 'alterna órbita / voo livre'],
    ],
  },
  {
    title: 'Geral',
    items: [
      ['P', 'pausa a simulação'],
      ['K', 'modo foto (Esc sai)'],
      ['H · ?', 'mostra / esconde os atalhos'],
      ['Toque', '1 dedo gira (ou pinta), 2 dedos movem e dão zoom'],
    ],
  },
]

export function ShortcutList() {
  return (
    <>
      {GROUPS.map((group) => (
        <div key={group.title} className="shortcut-group">
          <h3>{group.title}</h3>
          <dl className="shortcuts">
            {group.items.map(([key, action]) => (
              <div key={key + action} className="shortcut">
                <dt>{key}</dt>
                <dd>{action}</dd>
              </div>
            ))}
          </dl>
        </div>
      ))}
    </>
  )
}

/** Full-screen shortcut sheet, toggled with H or ?. */
export function HelpOverlay({ engine }: { engine: Engine }) {
  const { showHelp } = useSettings(engine)
  if (!showHelp) return null
  const close = () => engine.set({ showHelp: false })
  return (
    <div className="help-overlay" onClick={close}>
      <div className="help-sheet" role="dialog" aria-label="Atalhos" onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>Atalhos</h2>
          <button type="button" className="icon" onClick={close} aria-label="Fechar">
            ×
          </button>
        </header>
        <div className="help-columns">
          <ShortcutList />
        </div>
      </div>
    </div>
  )
}
