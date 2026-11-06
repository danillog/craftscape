// The first steps: a short guided card for who has just arrived. Each step says one thing
// to try and puts the right power in hand, so it can be tried at once.

import { useEffect, useState } from 'react'
import type { Tool2d } from './game'
import type { GameApi } from './host'
import { rememberTour } from './goals'

const STEPS: { title: string; text: string; tool: Tool2d }[] = [
  {
    title: 'Olhe o planeta',
    text: 'Arraste o mapa com o poder Olhar (tecla 0) ou ande com W A S D. A roda do mouse dá zoom e R enquadra o mundo inteiro.',
    tool: 'inspect',
  },
  {
    title: 'Molde a terra',
    text: 'Você está com o Terreno na mão: segure o clique sobre o mar e uma ilha sobe. X troca entre erguer e cavar; [ e ] mudam o tamanho do pincel.',
    tool: 'terrain',
  },
  {
    title: 'Mexa no clima',
    text: 'Com a Chuva, pinte o ar úmido sobre uma terra seca: as nuvens se formam e o verde avança. O vento leva o que você pinta. A tecla O troca o mapa para ver chuva, temperatura e pressão.',
    tool: 'rain',
  },
  {
    title: 'Dê vida',
    text: 'Com o Povo, clique numa terra verde perto da água: nasce um povo. Sozinho ele planta, funda cidades, navega e avança pelas eras.',
    tool: 'people',
  },
  {
    title: 'Seja um deus',
    text: 'Clique numa cidade com a Bênção para enchê-la de comida. Inspiração faz o povo avançar; Peste, Discórdia, Terremoto e Furacão fazem o contrário. O que acontece aparece nos cartões à esquerda.',
    tool: 'bless',
  },
  {
    title: 'Acompanhe o mundo',
    text: 'As abas à direita mostram os povos, os mapas, os dados do planeta e o livro da história. Em Novo mundo você escolhe um cenário e um desafio. A tecla ? mostra todos os atalhos.',
    tool: 'inspect',
  },
]

export function Tour({ game, onClose }: { game: GameApi; onClose: () => void }) {
  const [step, setStep] = useState(0)
  const current = STEPS[step]
  // the step's power goes in hand as the step opens
  useEffect(() => {
    game.set({ tool: STEPS[step].tool })
  }, [game, step])
  const close = () => {
    rememberTour()
    onClose()
  }
  const last = step === STEPS.length - 1
  return (
    <section className="tour glass" aria-label="Primeiros passos">
      <header>
        <span className="eyebrow">
          Primeiros passos · {step + 1} de {STEPS.length}
        </span>
        <button type="button" className="skip" onClick={close}>
          Pular
        </button>
      </header>
      <strong>{current.title}</strong>
      <p>{current.text}</p>
      <div className="dots" aria-hidden="true">
        {STEPS.map((s, k) => (
          <span key={s.title} className={k === step ? 'on' : k < step ? 'done' : ''} />
        ))}
      </div>
      <footer>
        <button type="button" disabled={step === 0} onClick={() => setStep(step - 1)}>
          Voltar
        </button>
        <button type="button" className="primary" onClick={() => (last ? close() : setStep(step + 1))}>
          {last ? 'Começar a jogar' : 'Próximo'}
        </button>
      </footer>
    </section>
  )
}
