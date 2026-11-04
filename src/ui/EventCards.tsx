import { useEffect, useRef, useState } from 'react'
import type { Engine } from '../engine/engine'
import type { LifeEvent } from '../engine/life'
import { civCss } from './constants'
import { Icon } from './icons'
import { useSettings, useStats } from './useEngine'

/** How long a card stays, in milliseconds, and how many show at once. */
const CARD_LIFE = 12000
const MAX_CARDS = 4

interface Card {
  key: string
  event: LifeEvent
  born: number
}

/**
 * The chronicle as it happens: a small stack of cards in the corner, one per new event,
 * each with a button that flies the camera to where it happened. The "follow" switch makes
 * the camera go by itself.
 */
export function EventCards({ engine }: { engine: Engine }) {
  const stats = useStats(engine)
  const s = useSettings(engine)
  const [cards, setCards] = useState<Card[]>([])
  // the life time of the newest event already shown; -1 before the first look
  const seen = useRef(-1)
  const events = stats.life?.events

  useEffect(() => {
    if (!events) return
    const newest = events[0]?.time ?? 0
    // a new world starts the chronicle over
    if (newest < seen.current) seen.current = -1
    if (seen.current < 0) {
      // first look: the backlog is not news
      seen.current = newest
      return
    }
    const fresh = events.filter((e) => e.time > seen.current)
    if (!fresh.length) return
    seen.current = newest
    const now = Date.now()
    setCards((old) =>
      [...fresh.reverse().map((event) => ({ key: `${event.time}:${event.text}`, event, born: now })), ...old].slice(0, MAX_CARDS),
    )
  }, [events])

  useEffect(() => {
    const id = window.setInterval(() => {
      const now = Date.now()
      setCards((old) => (old.some((c) => now - c.born > CARD_LIFE) ? old.filter((c) => now - c.born <= CARD_LIFE) : old))
    }, 1000)
    return () => window.clearInterval(id)
  }, [])

  if (!s.life) return null
  return (
    <div className="event-cards" aria-live="polite">
      <button
        type="button"
        className={`follow ${s.followEvents ? 'active' : ''}`}
        onClick={() => engine.set({ followEvents: !s.followEvents })}
        data-tip="A câmera voa até cada acontecimento"
      >
        <Icon.eye size={16} /> {s.followEvents ? 'Seguindo os acontecimentos' : 'Seguir os acontecimentos'}
      </button>
      {cards.map((c) => (
        <div key={c.key} className={`event-card glass ${c.event.major ? 'major' : ''}`}>
          <span className="swatch" style={{ background: civCss(c.event.color) }} />
          <span className="text">
            <span className="muted">{c.event.year} · </span>
            {c.event.text}
          </span>
          {c.event.pos && (
            <button type="button" className="icon" onClick={() => engine.flyTo(c.event.pos!)} aria-label="Ver onde aconteceu" data-tip="Ver">
              <Icon.eye size={16} />
            </button>
          )}
        </div>
      ))}
    </div>
  )
}
