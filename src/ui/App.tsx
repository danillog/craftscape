import { useCallback, useEffect, useRef, useState } from 'react'
import { Engine, WebGPUUnavailableError, type WebGPUFailure } from '../engine/engine'
import { Compass } from './Compass'
import { EventCards } from './EventCards'
import { PhotoBar } from './PhotoBar'
import { ProbeCard } from './ProbeCard'
import { SectionView } from './SectionView'
import { HelpOverlay } from './Shortcuts'
import { SidePanel, type PanelTab } from './SidePanel'
import { Toolbar } from './Toolbar'
import { ClockChip, StatusChip, TopBar } from './TopBar'
import { useMessage, useSettings } from './useEngine'
import { Welcome } from './Welcome'
import './App.css'

const WELCOMED_KEY = 'craftscape.welcomed'

/** Whether this browser has seen the welcome screen; storage may be unavailable. */
function seenWelcome() {
  try {
    return localStorage.getItem(WELCOMED_KEY) === '1'
  } catch {
    return false
  }
}

function rememberWelcome() {
  try {
    localStorage.setItem(WELCOMED_KEY, '1')
  } catch {
    // private mode or blocked storage: it just shows again next time
  }
}

/** Everything drawn over the view; photo mode swaps it for the photo bar. */
function Interface({ engine }: { engine: Engine }) {
  const { photoMode } = useSettings(engine)
  const [tab, setTab] = useState<PanelTab | null>(() =>
    window.matchMedia('(min-width: 1100px)').matches ? 'climate' : null,
  )
  const [welcome, setWelcome] = useState<'first' | 'again' | null>(() => (seenWelcome() ? null : 'first'))
  const [section, setSection] = useState(false)
  const closeWelcome = useCallback(() => {
    rememberWelcome()
    setWelcome(null)
  }, [])

  if (photoMode) {
    return (
      <>
        <PhotoBar engine={engine} />
        <Toast engine={engine} />
      </>
    )
  }
  return (
    <>
      <TopBar engine={engine} onNewWorld={() => setWelcome('again')} />
      <div className="top-right">
        <Compass engine={engine} />
        <ClockChip engine={engine} />
      </div>
      <SidePanel
        engine={engine}
        tab={tab}
        onTab={setTab}
        onNewWorld={() => setWelcome('again')}
        section={section}
        onSection={setSection}
      />
      {section && <SectionView engine={engine} onClose={() => setSection(false)} />}
      <Toolbar engine={engine} />
      <StatusChip engine={engine} />
      <ProbeCard engine={engine} />
      <EventCards engine={engine} />
      <Toast engine={engine} />
      <HelpOverlay engine={engine} />
      {welcome && <Welcome engine={engine} first={welcome === 'first'} onClose={closeWelcome} />}
    </>
  )
}

type Failure = { kind: 'webgpu'; reason: WebGPUFailure } | { kind: 'error'; message: string }

function Toast({ engine }: { engine: Engine }) {
  const message = useMessage(engine)
  if (!message) return null
  return (
    <div className="toast" role="alert">
      <span>{message}</span>
      <button type="button" className="icon" onClick={() => engine.dismissMessage()} aria-label="Fechar">
        ×
      </button>
    </div>
  )
}

function FailureScreen({ failure }: { failure: Failure }) {
  if (failure.kind === 'error') {
    return (
      <div className="failure">
        <h1>Algo deu errado</h1>
        <pre>{failure.message}</pre>
      </div>
    )
  }
  return (
    <div className="failure">
      <h1>WebGPU não está disponível</h1>
      <p>
        O Craftscape roda a simulação inteira na GPU via WebGPU.{' '}
        {failure.reason === 'no-api'
          ? 'Este navegador não oferece WebGPU.'
          : failure.reason === 'no-adapter'
            ? 'O navegador tem WebGPU, mas não encontrou um adaptador de GPU utilizável.'
            : 'O navegador tem WebGPU, mas o pedido de GPU não respondeu em 10 segundos — o processo de GPU do navegador provavelmente travou. Veja o status em chrome://gpu e reinicie o navegador.'}
      </p>
      <h2>Como ativar</h2>
      <ul>
        <li>
          <strong>Chrome / Edge no Windows, macOS ou ChromeOS:</strong> já vem ativado; atualize o navegador.
        </li>
        <li>
          <strong>Chrome no Linux:</strong> ative <code>chrome://flags/#enable-unsafe-webgpu</code> e{' '}
          <code>chrome://flags/#enable-vulkan</code> e reinicie o navegador.
        </li>
        <li>
          <strong>Firefox:</strong> versões recentes já trazem WebGPU em parte das plataformas; se não estiver ativo,
          ative <code>dom.webgpu.enabled</code> em <code>about:config</code>.
        </li>
        <li>
          <strong>Safari:</strong> versão 26 ou mais recente.
        </li>
      </ul>
    </div>
  )
}

function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [engine, setEngine] = useState<Engine | null>(null)
  const [failure, setFailure] = useState<Failure | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    let created: Engine | null = null
    Engine.create(canvasRef.current!, controller.signal)
      .then((e) => {
        created = e
        setEngine(e)
        // handy for poking at the simulation from the devtools console
        if (import.meta.env.DEV) Object.assign(window, { craftscape: e })
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return
        if (err instanceof WebGPUUnavailableError) setFailure({ kind: 'webgpu', reason: err.reason })
        else setFailure({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
      })
    return () => {
      controller.abort()
      created?.dispose()
      setEngine(null)
    }
  }, [])

  return (
    <div className="app">
      <canvas ref={canvasRef} className="viewport" />
      {engine && <Interface engine={engine} />}
      {!engine && !failure && <div className="loading">Iniciando WebGPU…</div>}
      {failure && <FailureScreen failure={failure} />}
    </div>
  )
}

export default App
