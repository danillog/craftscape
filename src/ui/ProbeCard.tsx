import type { BoundaryKind } from '../engine/plates'
import type { Engine } from '../engine/engine'
import { METERS_PER_HEIGHT, climateOf, type Probe, type Settings } from '../engine/settings'
import { CIV_COLORS } from '../engine/life'
import { BIOMES, compass } from './constants'
import { useProbe, useSettings } from './useEngine'

const percent = (v: number) => `${Math.round(Math.max(0, Math.min(1, v)) * 100)}%`
const number = (v: number, digits = 0) =>
  v.toLocaleString('pt-BR', { minimumFractionDigits: digits, maximumFractionDigits: digits })

/** Heights are relative to the sea when there is one, otherwise to height 0. */
function altitude(p: Probe, s: Settings) {
  const sea = s.ocean ? climateOf({ temperature: s.autoClimate ? 0 : s.temperature, seaLevel: s.seaLevel }).seaLevel : 0
  const meters = Math.round(((p.height - sea) * METERS_PER_HEIGHT) / 10) * 10
  return meters < 0 && s.ocean ? `${number(meters)} m (abaixo do mar)` : `${number(meters)} m`
}

function waterLabel(p: Probe) {
  if (p.water < 0.0002) return null
  const moving = p.flow > 0.05
  if (p.water < 0.002) return moving ? 'riacho' : 'poça'
  if (p.water < 0.01) return moving ? 'rio' : 'lago raso'
  return moving ? 'rio caudaloso' : 'lago fundo'
}

function groundLabel(p: Probe) {
  if (p.ice > 0.002) return 'geleira'
  if (p.snow > 0.0005) return 'neve'
  if (p.sand > 0.001 && p.sand > p.soil) return p.sand > 0.004 ? 'areia (dunas)' : 'areia'
  if (p.soil > 0.002) return 'solo espesso'
  if (p.soil > 0.0002) return 'solo fino'
  return 'rocha exposta'
}

const BOUNDARY_LABELS: Record<BoundaryKind, string> = {
  convergent: 'borda convergente (colisão)',
  divergent: 'borda divergente (rifte)',
  transform: 'falha transformante',
}

const civCss = (k: number) => `rgb(${CIV_COLORS[k].map((v) => Math.round(v * 255)).join(', ')})`

function pressureLabel(v: number) {
  if (v < -0.6) return 'baixa forte'
  if (v < -0.15) return 'baixa'
  if (v > 0.6) return 'alta forte'
  if (v > 0.15) return 'alta'
  return 'normal'
}

/** The inspect tool's card: what is under the cursor, next to it. */
export function ProbeCard({ engine }: { engine: Engine }) {
  const p = useProbe(engine)
  const s = useSettings(engine)
  if (!p) return null
  const [biome, color] = BIOMES[p.biome] ?? ['—', 'transparent']
  const water = waterLabel(p)
  // place the card beside the cursor, flipping away from the right and bottom edges
  const x = ((p.ndc[0] + 1) / 2) * window.innerWidth
  const y = ((1 - p.ndc[1]) / 2) * window.innerHeight
  const flipX = x > window.innerWidth - 300
  const flipY = y > window.innerHeight - 320
  const style = {
    left: flipX ? undefined : x + 18,
    right: flipX ? window.innerWidth - x + 18 : undefined,
    top: flipY ? undefined : y + 18,
    bottom: flipY ? window.innerHeight - y + 18 : undefined,
  }
  return (
    <div className="probe glass" style={style} aria-live="off">
      <header>
        <span className="swatch" style={{ background: color }} />
        <strong>{p.lava > 0.0002 ? 'Lava' : water && p.water > 0.01 ? 'Água' : biome}</strong>
        <span className="muted">{altitude(p, s)}</span>
      </header>
      {p.town && (
        <div className="probe-town">
          <header>
            <span className="swatch" style={{ background: civCss(p.town.color) }} />
            <strong>Cidade de {p.town.civ}</strong>
            <span className="muted">{p.town.people} pessoas</span>
          </header>
          <dl>
            <dt>Estado</dt>
            <dd>{p.town.status}</dd>
            <dt>Comida</dt>
            <dd>
              {percent(p.town.needs.food)}
              <span className="muted"> · umidade {percent(p.town.needs.moist)}</span>
            </dd>
            <dt>Clima</dt>
            <dd>
              {p.town.needs.hardship > 0.03 ? 'duro demais' : p.town.needs.demand > 0.05 ? 'exigente, aguentam' : 'ameno'}
              <span className="muted">
                {' '}
                · tec. {percent(p.town.tech)} · adapt. {percent(p.town.adapt)}
              </span>
            </dd>
            {(p.town.works.farms || p.town.works.dam || p.town.works.terraces || p.town.works.industry) && (
              <>
                <dt>Obras</dt>
                <dd>
                  {[
                    p.town.works.farms && 'fazendas',
                    p.town.works.dam && 'represa',
                    p.town.works.terraces && 'terraplenagem',
                    p.town.works.industry && 'indústria',
                  ]
                    .filter(Boolean)
                    .join(', ')}
                </dd>
              </>
            )}
          </dl>
          <p className="muted small">Clique para acompanhar na aba Vida.</p>
        </div>
      )}
      <dl>
        <dt>Temperatura</dt>
        <dd>{number(p.temperature, 1)} °C</dd>
        <dt>Chuva</dt>
        <dd>
          {number(p.rain, 2)}× <span className="muted">· ar {percent(p.humidity)}</span>
        </dd>
        <dt>Vento</dt>
        <dd>{p.windSpeed < 0.05 ? 'calmo' : `${compass(p.windDirection)}, ${number(p.windSpeed, 1)}`}</dd>
        <dt>Pressão</dt>
        <dd>{pressureLabel(p.pressure)}</dd>
        <dt>Chão</dt>
        <dd>{groundLabel(p)}</dd>
        {p.plants > 0.02 && (
          <>
            <dt>Vegetação</dt>
            <dd>{percent(p.plants)}</dd>
          </>
        )}
        {water && (
          <>
            <dt>Água</dt>
            <dd>
              {water}
              {p.sediment > 0.0002 && <span className="muted"> · barrenta, levando sedimento</span>}
            </dd>
          </>
        )}
        <dt>Placa</dt>
        <dd>
          {compass(p.plate.direction)}
          <span className="muted"> · {number(p.plate.speed * 100)}%</span>
        </dd>
        {(p.plate.boundary || Math.abs(p.tectonic) > 0.05) && (
          <>
            <dt>Tectônica</dt>
            <dd>
              {p.plate.boundary ? BOUNDARY_LABELS[p.plate.boundary] : 'perto de uma borda'}
              {Math.abs(p.tectonic) > 0.05 && (
                <span className="muted"> · {p.tectonic > 0 ? 'soerguendo' : 'afundando'}</span>
              )}
            </dd>
          </>
        )}
        {(p.lava > 0.0002 || p.vent > 0.05) && (
          <>
            <dt>Vulcão</dt>
            <dd>{p.lava > 0.0002 ? 'lava escorrendo' : 'cratera'}</dd>
          </>
        )}
        {Math.abs(p.airSource) >= 0.05 && (
          <>
            <dt>Massa de ar</dt>
            <dd>
              fixa, {p.airSource > 0 ? 'quente' : 'fria'}
              <span className="muted"> · {number(Math.abs(p.airSource) * 100)}%</span>
            </dd>
          </>
        )}
      </dl>
    </div>
  )
}
