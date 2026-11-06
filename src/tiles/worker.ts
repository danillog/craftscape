// The 2D game in a worker: the whole of it (the world, the peoples, the drawing on the
// canvases the page handed over), so the page's own thread only shows the interface and
// passes the player's input along. See start.ts for the page's side.

import { Game } from './game'
import type { FromWorker, GameHost, ToWorker } from './host'

const scope = self as unknown as {
  onmessage: ((e: MessageEvent<ToWorker>) => void) | null
  postMessage(message: FromWorker, transfer?: Transferable[]): void
  close(): void
}
const post = (message: FromWorker) => scope.postMessage(message)

let game: Game | null = null
let size = { width: 800, height: 600, dpr: 1 }
/** The state goes to the page a few times a second at most, however often the game changes it. */
let pending = false
const tell = () => {
  if (pending || !game) return
  pending = true
  setTimeout(() => {
    pending = false
    if (game) post({ type: 'state', settings: game.getSettings(), stats: game.getStats() })
  }, 50)
}

scope.onmessage = (e) => {
  const m = e.data
  switch (m.type) {
    case 'init': {
      size = m.size
      const host: GameHost = {
        size: () => size,
        globeCanvas: () => m.globe,
        showGlobe: (on) => post({ type: 'globe', on }),
        sound: (kind) => post({ type: 'sound', kind }),
        download: (blob, name) => post({ type: 'download', blob, name }),
        completed: () => m.completed,
        keepCompleted: (ids) => post({ type: 'completed', ids }),
      }
      game = new Game(m.canvas, host)
      game.subscribe(tell)
      game.start()
      post({ type: 'state', settings: game.getSettings(), stats: game.getStats() })
      break
    }
    case 'size':
      size = m.size
      break
    case 'input':
      if (game) (game[m.name] as (arg?: unknown) => void)(m.arg)
      break
    case 'call':
      if (game) (game[m.name] as (...args: unknown[]) => unknown)(...m.args)
      break
    case 'dispose':
      game?.dispose()
      game = null
      scope.close()
      break
  }
}
