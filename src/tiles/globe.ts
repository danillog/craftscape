// The planet as a globe: the flat map, drawn off screen, is wrapped on a sphere and seen
// from space (an orthographic view), with plain WebGL (no WebGPU needed, and the game falls
// back to the flat map where there is none). The map is the planet unrolled, 360° across
// and 180° down, so wrapping it is all there is to it: what is drawn on the map (the
// peoples, the clouds, the night, the brush) rides along.

import { makeCanvas, type Canvas } from './canvas'

/** Where the globe is seen from: the longitude and latitude at the middle of the view (radians), and how big it is drawn (1: it fits the window). */
export interface GlobeView {
  lon: number
  lat: number
  zoom: number
}

/** The furthest the view tilts towards a pole (radians): the pole itself would spin the map under the pointer. */
export const GLOBE_TILT = 1.35

const VERTEX = `
attribute vec2 corner;
void main() {
  gl_Position = vec4(corner, 0.0, 1.0);
}
`

const FRAGMENT = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform sampler2D map;
uniform vec2 centre;
uniform float radius;
uniform float lon0;
uniform float lat0;

void main() {
  // the place on the screen, in globe radii from its centre (y up)
  vec2 p = (gl_FragCoord.xy - centre) / radius;
  float r = length(p);
  if (r > 1.0) {
    // space, with the air's thin glow round the planet
    float glow = 1.0 - smoothstep(1.0, 1.09, r);
    gl_FragColor = vec4(mix(vec3(0.02, 0.035, 0.07), vec3(0.3, 0.52, 0.95), glow * glow * 0.55), 1.0);
    return;
  }
  // the point of the sphere there (z towards the viewer), turned to the view's latitude
  float z = sqrt(1.0 - r * r);
  float up = p.y * cos(lat0) + z * sin(lat0);
  float depth = z * cos(lat0) - p.y * sin(lat0);
  float lat = asin(clamp(up, -1.0, 1.0));
  float lon = lon0 + atan(p.x, depth);
  vec2 uv = vec2(fract(lon / 6.2831853 + 0.5), 0.5 - lat / 3.14159265);
  vec3 colour = texture2D(map, uv).rgb;
  // the limb is seen through more air: a little darker, and bluer at the very edge
  colour *= 0.62 + 0.38 * z;
  colour += vec3(0.25, 0.45, 0.9) * pow(1.0 - z, 4.0) * 0.6;
  gl_FragColor = vec4(colour, 1.0);
}
`

export class Globe {
  /** The canvas the globe is drawn on (the host lays it over the map's and shows it), or null where there is none. */
  readonly canvas: Canvas | null
  /** The flat map is drawn here first, a square: the whole planet, north up. */
  readonly map: Canvas
  /** Whether this browser can draw it (it has WebGL). */
  readonly ok: boolean
  private readonly gl: WebGLRenderingContext | null
  private readonly uniforms: Record<string, WebGLUniformLocation | null> = {}
  private readonly texture: WebGLTexture | null = null

  constructor(canvas: Canvas | null) {
    this.canvas = canvas
    this.map = makeCanvas()
    const gl = canvas ? (canvas.getContext('webgl', { antialias: true, alpha: false }) as WebGLRenderingContext | null) : null
    this.gl = gl
    let ready = false
    if (gl) {
      const program = gl.createProgram()
      const shader = (type: number, source: string) => {
        const s = gl.createShader(type)!
        gl.shaderSource(s, source)
        gl.compileShader(s)
        gl.attachShader(program, s)
        return gl.getShaderParameter(s, gl.COMPILE_STATUS) as boolean
      }
      const compiled = shader(gl.VERTEX_SHADER, VERTEX) && shader(gl.FRAGMENT_SHADER, FRAGMENT)
      gl.linkProgram(program)
      if (compiled && gl.getProgramParameter(program, gl.LINK_STATUS)) {
        gl.useProgram(program)
        // two triangles over the whole canvas
        gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer())
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW)
        const corner = gl.getAttribLocation(program, 'corner')
        gl.enableVertexAttribArray(corner)
        gl.vertexAttribPointer(corner, 2, gl.FLOAT, false, 0, 0)
        for (const name of ['map', 'centre', 'radius', 'lon0', 'lat0']) this.uniforms[name] = gl.getUniformLocation(program, name)
        this.texture = gl.createTexture()
        gl.bindTexture(gl.TEXTURE_2D, this.texture)
        // (the map is not a power of two: no mipmaps, no repeat; the shader wraps the longitude itself)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
        ready = true
      }
    }
    this.ok = ready
  }

  /** Pixels across the flat map drawn for the globe, for a world of n tiles a side (a whole number of pixels per tile). */
  static mapSize(n: number): number {
    return n * (n <= 256 ? 4 : 3)
  }

  /** The globe's radius on screen (CSS pixels) in a window of this size. */
  static radius(view: GlobeView, width: number, height: number): number {
    return Math.min(width, height) * 0.45 * view.zoom
  }

  /** Draws the globe from the flat map (already drawn on `map`), in a window of this size (CSS pixels). */
  render(view: GlobeView, width: number, height: number, dpr: number) {
    const gl = this.gl
    if (!gl || !this.ok || !this.canvas) return
    const w = Math.round(width * dpr)
    const h = Math.round(height * dpr)
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w
      this.canvas.height = h
    }
    gl.viewport(0, 0, w, h)
    gl.bindTexture(gl.TEXTURE_2D, this.texture)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.map)
    gl.uniform1i(this.uniforms.map, 0)
    gl.uniform2f(this.uniforms.centre, w / 2, h / 2)
    gl.uniform1f(this.uniforms.radius, Globe.radius(view, width, height) * dpr)
    gl.uniform1f(this.uniforms.lon0, view.lon)
    gl.uniform1f(this.uniforms.lat0, view.lat)
    gl.drawArrays(gl.TRIANGLES, 0, 6)
  }
}

/**
 * The place on the map under a point of the window: east 0–1 (0 at 180° W) and south 0–1
 * (0 at the north pole), or null when the point is off the globe. x and y are CSS pixels
 * from the window's centre, y down. The same sums as the shader's.
 */
export function globePick(x: number, y: number, radius: number, view: GlobeView): [number, number] | null {
  const px = x / radius
  const py = -y / radius
  const r2 = px * px + py * py
  if (r2 > 1) return null
  const z = Math.sqrt(1 - r2)
  const up = py * Math.cos(view.lat) + z * Math.sin(view.lat)
  const out = z * Math.cos(view.lat) - py * Math.sin(view.lat)
  const lat = Math.asin(Math.max(-1, Math.min(1, up)))
  const lon = view.lon + Math.atan2(px, out)
  const u = lon / (Math.PI * 2) + 0.5
  return [u - Math.floor(u), 0.5 - lat / Math.PI]
}

/** The longitude and latitude (radians) of a place on the map (east 0–1, south 0–1). */
export const globePlace = (u: number, v: number): [number, number] => [(u - 0.5) * Math.PI * 2, (0.5 - v) * Math.PI]
