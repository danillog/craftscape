import { useEffect, useRef } from 'react'
import type { Engine } from '../engine/engine'
import { useSettings } from './useEngine'

const deg = (rad: number) => (rad * 180) / Math.PI

/**
 * Compass rose that turns with the camera, so N always points at the map's north,
 * with the prevailing wind drawn as an arrow inside it. Updated every frame
 * straight on the SVG (no React re-render).
 */
export function Compass({ engine }: { engine: Engine }) {
  const { windSpeed } = useSettings(engine)
  const dial = useRef<SVGGElement>(null)
  const arrow = useRef<SVGGElement>(null)

  useEffect(() => {
    let raf = 0
    const loop = () => {
      raf = requestAnimationFrame(loop)
      dial.current?.setAttribute('transform', `rotate(${deg(engine.heading)})`)
      // wind angle is counter-clockwise from east; SVG rotation is clockwise from north
      arrow.current?.setAttribute('transform', `rotate(${90 - deg(engine.windAngle)})`)
    }
    loop()
    return () => cancelAnimationFrame(raf)
  }, [engine])

  return (
    <svg className="compass" viewBox="-50 -50 100 100" aria-label="Bússola">
      <circle r="47" className="compass-face" />
      <g ref={dial}>
        <path d="M0 -27 L5 -9 L0 -12 L-5 -9 Z" className="compass-north" />
        <text y="-37" className="compass-letter north">
          N
        </text>
        <text x="37" y="0" className="compass-letter">
          L
        </text>
        <text y="37" className="compass-letter">
          S
        </text>
        <text x="-37" y="0" className="compass-letter">
          O
        </text>
        {windSpeed > 0 && (
          <g ref={arrow}>
            <path d="M0 16 L0 -14 M-6 -6 L0 -16 L6 -6" className="compass-wind" />
          </g>
        )}
      </g>
    </svg>
  )
}
