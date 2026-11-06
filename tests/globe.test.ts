import { describe, expect, it } from 'vitest'
import { globePick, globePlace, type GlobeView } from '../src/tiles/globe'

describe('the globe', () => {
  const view: GlobeView = { lon: 0.5, lat: 0.2, zoom: 1 }
  const R = 300

  it('has the place it is seen from under the middle of the window', () => {
    const place = globePick(0, 0, R, view)
    expect(place).not.toBeNull()
    const [lon, lat] = globePlace(place![0], place![1])
    expect(lon).toBeCloseTo(view.lon, 6)
    expect(lat).toBeCloseTo(view.lat, 6)
  })

  it('has nothing under a point off its disc', () => {
    expect(globePick(R * 1.01, 0, R, view)).toBeNull()
    expect(globePick(R * 0.8, R * 0.8, R, view)).toBeNull()
    expect(globePick(R * 0.99, 0, R, view)).not.toBeNull()
  })

  it('goes east to the right and north upwards', () => {
    const middle = globePlace(...globePick(0, 0, R, view)!)
    const right = globePlace(...globePick(R * 0.3, 0, R, view)!)
    const above = globePlace(...globePick(0, -R * 0.3, R, view)!)
    expect(right[0]).toBeGreaterThan(middle[0])
    expect(above[1]).toBeGreaterThan(middle[1])
  })

  it('gives places on the map: east and south between 0 and 1, wrapping round the back of the world', () => {
    // seen from 170° E, a point to the right lies past 180°: it wraps to the map's west side
    const far: GlobeView = { lon: (170 * Math.PI) / 180, lat: 0, zoom: 1 }
    const place = globePick(R * 0.5, 0, R, far)!
    expect(place[0]).toBeGreaterThanOrEqual(0)
    expect(place[0]).toBeLessThan(0.1)
    for (const [x, y] of [[0, 0], [100, -50], [-200, 120]]) {
      const p = globePick(x, y, R, view)!
      expect(p[0]).toBeGreaterThanOrEqual(0)
      expect(p[0]).toBeLessThan(1)
      expect(p[1]).toBeGreaterThan(0)
      expect(p[1]).toBeLessThan(1)
    }
  })

  it('maps the corners of the map to the ends of the world', () => {
    expect(globePlace(0.5, 0.5)).toEqual([0, 0])
    expect(globePlace(0, 0)[0]).toBeCloseTo(-Math.PI, 9)
    expect(globePlace(0, 0)[1]).toBeCloseTo(Math.PI / 2, 9)
    expect(globePlace(1, 1)[1]).toBeCloseTo(-Math.PI / 2, 9)
  })
})
