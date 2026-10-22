import { useEffect, useRef, useState } from 'react'
import type { Engine } from '../engine/engine'
import { clockOf } from '../engine/sky'
import { Icon } from './icons'
import { useSettings } from './useEngine'

const IDLE_MS = 2500

/**
 * Photo mode: everything else is hidden; this small bar fades out while the mouse
 * rests and comes back when it moves.
 */
export function PhotoBar({ engine }: { engine: Engine }) {
  const s = useSettings(engine)
  const [awake, setAwake] = useState(true)
  const [busy, setBusy] = useState(false)
  const [recording, setRecording] = useState<{ recorder: MediaRecorder; started: number } | null>(null)
  const [, tick] = useState(0)

  // the elapsed time on the record button
  useEffect(() => {
    if (!recording) return
    const timer = window.setInterval(() => tick((n) => n + 1), 500)
    return () => window.clearInterval(timer)
  }, [recording])

  /** Records the view (only the canvas: the interface never shows) as a WebM video. */
  const toggleRecording = () => {
    if (recording) {
      recording.recorder.stop()
      setRecording(null)
      return
    }
    const canvas = document.querySelector<HTMLCanvasElement>('canvas.viewport')
    if (!canvas || typeof MediaRecorder === 'undefined') return
    const type = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((t) =>
      MediaRecorder.isTypeSupported(t),
    )
    const recorder = new MediaRecorder(canvas.captureStream(30), {
      mimeType: type,
      videoBitsPerSecond: 12_000_000,
    })
    const chunks: Blob[] = []
    recorder.ondataavailable = (e) => {
      if (e.data.size) chunks.push(e.data)
    }
    recorder.onstop = () => {
      const blob = new Blob(chunks, { type: 'video/webm' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `craftscape-timelapse-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.webm`
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    }
    recorder.start(1000)
    setRecording({ recorder, started: performance.now() })
  }
  const elapsed = recording ? Math.floor((performance.now() - recording.started) / 1000) : 0

  // leaving photo mode (Escape or K) while recording still stops and saves the video
  const active = useRef<MediaRecorder | null>(null)
  active.current = recording?.recorder ?? null
  useEffect(
    () => () => {
      if (active.current && active.current.state !== 'inactive') active.current.stop()
    },
    [],
  )

  useEffect(() => {
    let timer = window.setTimeout(() => setAwake(false), IDLE_MS)
    const wake = () => {
      setAwake(true)
      window.clearTimeout(timer)
      timer = window.setTimeout(() => setAwake(false), IDLE_MS)
    }
    window.addEventListener('pointermove', wake)
    window.addEventListener('keydown', wake)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('pointermove', wake)
      window.removeEventListener('keydown', wake)
    }
  }, [])

  const shoot = async (scale: number) => {
    setBusy(true)
    try {
      await engine.screenshot(scale)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={`photo-bar glass ${awake ? '' : 'asleep'}`} role="toolbar" aria-label="Modo foto">
      <button
        type="button"
        className={`icon-button ${s.cinematic ? 'active' : ''}`}
        aria-pressed={s.cinematic}
        onClick={() => engine.set({ cinematic: !s.cinematic })}
        data-tip="Órbita automática"
      >
        <Icon.orbit size={20} />
      </button>
      {s.cinematic && (
        <label className="mini-slider" data-tip="Velocidade da órbita">
          <span>Órbita</span>
          <input
            type="range"
            min={1}
            max={20}
            step={1}
            value={s.cinematicSpeed}
            onChange={(e) => engine.set({ cinematicSpeed: Number(e.target.value) })}
          />
        </label>
      )}
      <div className="divider" />
      <label className="mini-slider wide" data-tip="Hora do dia (a luz muda com ela)">
        <span>
          {s.timeOfDay > 0.25 && s.timeOfDay < 0.75 ? <Icon.sun size={14} /> : <Icon.moon size={14} />}{' '}
          {clockOf(s.timeOfDay)}
        </span>
        <input
          type="range"
          min={0}
          max={0.999}
          step={1 / 192}
          value={s.timeOfDay}
          onChange={(e) => engine.set({ timeOfDay: Number(e.target.value) })}
        />
      </label>
      <button
        type="button"
        className={`icon-button ${s.dayNight ? '' : 'active'}`}
        aria-pressed={!s.dayNight}
        onClick={() => engine.set({ dayNight: !s.dayNight })}
        data-tip={s.dayNight ? 'Congelar a hora' : 'Deixar o dia passar'}
      >
        {s.dayNight ? <Icon.pause size={16} /> : <Icon.play size={16} />}
      </button>
      <div className="divider" />
      <div className="shots">
        {[1, 2, 4].map((scale) => (
          <button
            key={scale}
            type="button"
            className="pill"
            disabled={busy}
            onClick={() => void shoot(scale)}
            data-tip={`Salvar PNG em ${scale}× a resolução da tela`}
          >
            <Icon.download size={16} />
            {scale}×
          </button>
        ))}
      </div>
      <button
        type="button"
        className={`pill record ${recording ? 'on' : ''}`}
        onClick={toggleRecording}
        data-tip={
          recording
            ? 'Parar e salvar o vídeo'
            : 'Gravar vídeo (timelapse: combine com o tempo geológico e a órbita automática)'
        }
      >
        <span className="rec-dot" />
        {recording ? `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}` : 'Gravar'}
      </button>
      <div className="divider" />
      <button
        type="button"
        className="icon-button"
        onClick={() => {
          recording?.recorder.stop()
          setRecording(null)
          engine.set({ photoMode: false, cinematic: false })
        }}
        data-tip="Sair (Esc ou K)"
        aria-label="Sair do modo foto"
      >
        <Icon.close size={20} />
      </button>
    </div>
  )
}
