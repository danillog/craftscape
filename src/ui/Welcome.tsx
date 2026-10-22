import { useEffect } from 'react'
import type { Engine } from '../engine/engine'
import { SCENARIOS, type Scenario } from '../engine/scenarios'
import { Icon } from './icons'
import { useSettings } from './useEngine'

/** Layered ridge silhouettes, tinted per scenario by the card's gradient. */
function Landscape({ scenario }: { scenario: Scenario }) {
  const sea = scenario.settings.ocean
  return (
    <svg className="landscape" viewBox="0 0 200 90" preserveAspectRatio="none" aria-hidden="true">
      <path
        d="M0 52 L28 30 L46 42 L72 18 L98 40 L120 26 L150 44 L176 24 L200 38 V90 H0Z"
        fill="rgba(255,255,255,0.16)"
      />
      <path d="M0 64 L22 50 L50 60 L80 38 L108 58 L136 46 L164 60 L200 48 V90 H0Z" fill="rgba(0,0,0,0.18)" />
      {scenario.vents ? <path d="M78 38 L80 30 L82 38" fill="#ffb25c" opacity="0.9" /> : null}
      {sea ? (
        <rect x="0" y="70" width="200" height="20" fill="rgba(40,120,200,0.45)" />
      ) : (
        <path d="M0 76 L40 68 L90 74 L140 66 L200 72 V90 H0Z" fill="rgba(0,0,0,0.25)" />
      )}
    </svg>
  )
}

export function Welcome({ engine, onClose, first }: { engine: Engine; onClose: () => void; first: boolean }) {
  const s = useSettings(engine)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const start = (scenario: Scenario) => {
    engine.startScenario(scenario.id)
    onClose()
  }

  return (
    <div className="welcome-backdrop" onClick={onClose}>
      <div className="welcome glass" role="dialog" aria-label="Escolha um mundo" onClick={(e) => e.stopPropagation()}>
        <header className="welcome-header">
          <div>
            <h2>{first ? 'Bem-vindo ao Craftscape' : 'Novo mundo'}</h2>
            <p>
              Um mundo vivo simulado na sua GPU: água que escava rios, clima que forma desertos e florestas, vulcões e
              geleiras. Escolha por onde começar.
            </p>
          </div>
          <button type="button" className="icon ghost" onClick={onClose} aria-label="Fechar">
            <Icon.close size={20} />
          </button>
        </header>
        <div className="scenario-grid">
          {SCENARIOS.map((scenario) => (
            <button
              key={scenario.id}
              type="button"
              className={`scenario-card ${!first && s.scenario === scenario.id ? 'current' : ''}`}
              onClick={() => start(scenario)}
            >
              <div
                className="scenario-art"
                style={{ background: `linear-gradient(170deg, ${scenario.colors[0]}, ${scenario.colors[1]})` }}
              >
                <Landscape scenario={scenario} />
              </div>
              <div className="scenario-text">
                <strong>{scenario.name}</strong>
                <span className="tagline">{scenario.tagline}</span>
                <span className="description">{scenario.description}</span>
              </div>
            </button>
          ))}
        </div>
        <footer className="welcome-footer">
          <span className="muted">
            Dica: segure <kbd>Espaço</kbd> para pintar, arraste para girar, <kbd>H</kbd> mostra os atalhos.
          </span>
          <button type="button" onClick={onClose}>
            {first ? 'Explorar este mundo' : 'Continuar no mundo atual'}
          </button>
        </footer>
      </div>
    </div>
  )
}
