import { clamp, damp, mat4, vec3, type Vec3 } from './math'
import type { View } from './renderer'
import type { CameraMode } from './settings'

const FOV = (60 * Math.PI) / 180
const NEAR = 0.01
const FAR = 20

export interface MoveInput {
  /** right, up, forward in [-1, 1] */
  x: number
  y: number
  z: number
  /** arrow keys: turn right / tilt down, in [-1, 1] */
  turn: number
  tilt: number
  fast: boolean
}

const HOME = { yaw: -0.35, pitch: 0.4, distance: 0.95, target: [0, -0.02, 0] as Vec3 }

const rightOf = (yaw: number): Vec3 => [Math.cos(yaw), 0, -Math.sin(yaw)]

/**
 * Orbit camera (rotate around a target) plus the original free-fly camera.
 * Yaw/pitch are shared: pitch > 0 looks down, yaw 0 looks towards -z.
 */
export class Camera {
  mode: CameraMode = 'orbit'
  aspect = 1

  private yaw = HOME.yaw
  private pitch = HOME.pitch
  private distance = HOME.distance
  private target: Vec3 = HOME.target
  private position: Vec3 = [0, 0.3, 1]

  // smoothed orbit values
  private goalYaw = this.yaw
  private goalPitch = this.pitch
  private goalDistance = this.distance
  private goalTarget: Vec3 = this.target
  /** Centre of the simulated window: R comes back here, and the target stays near it unless unbounded. */
  private center: Vec3 = [0, 0, 0]
  private unbounded = false
  /** Simulated area (window width in world units): the home view and the limits scale with it. */
  private scale = 1
  /** While dragging, the orbit turns around this point (the terrain under the cursor). */
  private pivot: Vec3 | null = null

  private forward(yaw = this.yaw, pitch = this.pitch): Vec3 {
    return [-Math.cos(pitch) * Math.sin(yaw), -Math.sin(pitch), -Math.cos(pitch) * Math.cos(yaw)]
  }

  /** Where the camera looks, in radians: 0 = north (−z), π/2 = west. */
  get heading() {
    return this.yaw
  }

  get eye(): Vec3 {
    if (this.mode === 'fly') return this.position
    return vec3.sub(this.target, vec3.scale(this.forward(), this.distance))
  }

  setMode(mode: CameraMode) {
    if (mode === this.mode) return
    if (mode === 'fly') {
      this.position = this.eye
    } else {
      // orbit around the point we are looking at on the y = 0 plane (or 1 unit ahead)
      const f = this.forward()
      const t = f[1] < -0.05 ? clamp(-this.position[1] / f[1], 0.2, 3) : 1
      this.target = this.goalTarget = vec3.add(this.position, vec3.scale(f, t))
      this.distance = this.goalDistance = t
    }
    this.pivot = null
    this.goalYaw = this.yaw
    this.goalPitch = this.pitch
    this.mode = mode
  }

  /** Starts a drag rotation; in orbit mode it turns around `pivot` when given. */
  beginRotate(pivot: Vec3 | null) {
    this.pivot = this.mode === 'orbit' ? pivot : null
  }

  endRotate() {
    this.pivot = null
  }

  /** Back to the starting view (orbit) or level, facing the map (fly). */
  reset() {
    this.goalYaw = HOME.yaw
    this.goalPitch = HOME.pitch
    if (this.mode === 'orbit') {
      this.goalDistance = HOME.distance * this.scale
      this.goalTarget = vec3.add(HOME.target, this.center)
      this.pivot = null
    } else {
      this.yaw = this.goalYaw
      this.pitch = this.goalPitch
      this.position = vec3.sub(
        vec3.add(HOME.target, this.center),
        vec3.scale(this.forward(), HOME.distance * this.scale),
      )
    }
  }

  /** Glides the orbit target onto a point (fly mode: turns to look at it). */
  focus(point: Vec3) {
    if (this.mode === 'orbit') {
      this.goalTarget = this.clampTarget(point)
      this.goalDistance = clamp(this.goalDistance, 0.12, 0.6)
    } else {
      const d = vec3.normalize(vec3.sub(point, this.position))
      this.yaw = this.goalYaw = Math.atan2(-d[0], -d[2])
      this.pitch = this.goalPitch = clamp(Math.asin(-d[1]), -1.4, 1.4)
    }
  }

  /** Glides the orbit onto a point from a given distance, looking down on it (orbit mode only). */
  flyTo(point: Vec3, distance: number) {
    if (this.mode !== 'orbit') return
    this.goalTarget = this.clampTarget(point)
    this.goalDistance = clamp(distance, 0.03, 2)
    this.goalPitch = clamp(this.goalPitch, 0.35, 0.9)
  }

  /** Cinematic orbit: turns the view around its target (orbit mode only). */
  spin(angle: number) {
    if (this.mode === 'orbit') this.goalYaw -= angle
  }

  /** Drag rotation, in screen pixels. */
  rotate(dx: number, dy: number) {
    if (this.mode === 'orbit') {
      this.goalYaw -= dx * 0.006
      this.goalPitch = clamp(this.goalPitch + dy * 0.006, 0.05, 1.5)
    } else {
      this.yaw = this.goalYaw = this.yaw - dx * 0.004
      this.pitch = this.goalPitch = clamp(this.pitch + dy * 0.004, -1.4, 1.4)
    }
  }

  /** Drag panning, in screen pixels (orbit) — moves the target over the ground. */
  pan(dx: number, dy: number, viewportHeight: number) {
    const scale = (2 * Math.tan(FOV / 2) * (this.mode === 'orbit' ? this.distance : 0.5)) / viewportHeight
    const right = rightOf(this.yaw)
    const ahead: Vec3 = [-Math.sin(this.yaw), 0, -Math.cos(this.yaw)]
    const delta = vec3.add(vec3.scale(right, -dx * scale), vec3.scale(ahead, dy * scale))
    if (this.mode === 'orbit') this.shiftTarget(delta)
    else this.position = vec3.add(this.position, delta)
  }

  /** factor < 1 zooms in, towards `point` when given (it stays put on screen). */
  zoom(factor: number, point: Vec3 | null = null) {
    if (this.mode === 'orbit') {
      const goal = clamp(this.goalDistance * factor, 0.12, 4 * this.scale)
      if (point) {
        const k = goal / this.goalDistance
        this.goalTarget = this.clampTarget(vec3.add(point, vec3.scale(vec3.sub(this.goalTarget, point), k)))
      }
      this.goalDistance = goal
    } else {
      const dir = point ? vec3.normalize(vec3.sub(point, this.position)) : this.forward()
      this.position = vec3.add(this.position, vec3.scale(dir, (1 - factor) * 0.6))
    }
  }

  /** Moves the orbit target right away (panning should not lag behind the hand). */
  private shiftTarget(delta: Vec3) {
    const target = this.clampTarget(vec3.add(this.target, delta))
    const applied = vec3.sub(target, this.target)
    this.target = target
    this.goalTarget = this.clampTarget(vec3.add(this.goalTarget, applied))
  }

  /** Rigidly turns a point around the pivot, the way the yaw/pitch change turns the view. */
  private turnAroundPivot(p: Vec3, pivot: Vec3, yaw0: number, pitch0: number, yaw1: number, pitch1: number): Vec3 {
    const frame = (yaw: number, pitch: number) => {
      const f = this.forward(yaw, pitch)
      const r = rightOf(yaw)
      return [r, vec3.cross(r, f), f] as const
    }
    const [r0, u0, f0] = frame(yaw0, pitch0)
    const [r1, u1, f1] = frame(yaw1, pitch1)
    const v = vec3.sub(p, pivot)
    const a = vec3.dot(v, r0)
    const b = vec3.dot(v, u0)
    const c = vec3.dot(v, f0)
    return vec3.add(pivot, vec3.add(vec3.add(vec3.scale(r1, a), vec3.scale(u1, b)), vec3.scale(f1, c)))
  }

  /**
   * Where the window is in the world; with `unbounded` (infinite world) the target
   * may roam anywhere, otherwise it stays within one window width of the centre.
   */
  setWorld(center: Vec3, unbounded: boolean, scale = 1) {
    this.center = center
    this.unbounded = unbounded
    this.scale = scale
  }

  /** The point the view is about: the orbit target, or the ground ahead in fly mode. */
  get focusPoint(): Vec3 {
    if (this.mode === 'orbit') return this.target
    const f = this.forward()
    const t = f[1] < -0.05 ? clamp(-this.position[1] / f[1], 0.2, 1.5) : 0.5
    return vec3.add(this.position, vec3.scale(f, t))
  }

  private clampTarget(t: Vec3): Vec3 {
    const [cx, , cz] = this.center
    const r = this.unbounded ? Infinity : this.scale
    return [clamp(t[0], cx - r, cx + r), clamp(t[1], -0.4, 0.6), clamp(t[2], cz - r, cz + r)]
  }

  update(dt: number, move: MoveInput) {
    if (move.turn || move.tilt) {
      const rate = (move.fast ? 2.4 : 1.2) * dt
      if (this.mode === 'orbit') {
        this.goalYaw -= move.turn * rate
        this.goalPitch = clamp(this.goalPitch + move.tilt * rate * 0.7, 0.05, 1.5)
      } else {
        this.yaw = this.goalYaw = this.yaw - move.turn * rate
        this.pitch = this.goalPitch = clamp(this.pitch + move.tilt * rate * 0.7, -1.4, 1.4)
      }
    }
    if (this.mode === 'orbit') {
      const yaw = damp(this.yaw, this.goalYaw, 14, dt)
      const pitch = damp(this.pitch, this.goalPitch, 14, dt)
      if (this.pivot) {
        const turn = (p: Vec3) => this.turnAroundPivot(p, this.pivot!, this.yaw, this.pitch, yaw, pitch)
        this.target = this.clampTarget(turn(this.target))
        this.goalTarget = this.clampTarget(turn(this.goalTarget))
      }
      this.yaw = yaw
      this.pitch = pitch
      this.distance = damp(this.distance, this.goalDistance, 10, dt)
      this.target = this.target.map((v, k) => damp(v, this.goalTarget[k], 10, dt)) as Vec3
      if (move.x || move.y || move.z) {
        const speed = this.distance * 0.8 * (move.fast ? 3 : 1) * dt
        const ahead: Vec3 = [-Math.sin(this.yaw), 0, -Math.cos(this.yaw)]
        let d = vec3.add(vec3.scale(rightOf(this.yaw), move.x), vec3.scale(ahead, move.z))
        d = vec3.add(d, [0, move.y * 0.5, 0])
        this.shiftTarget(vec3.scale(d, speed))
      }
    } else if (move.x || move.y || move.z) {
      const speed = 0.35 * (move.fast ? 3 : 1) * dt
      const f = this.forward()
      const right = vec3.normalize(vec3.cross(f, [0, 1, 0]))
      let d = vec3.add(vec3.scale(right, move.x), vec3.scale(f, move.z))
      d = vec3.add(d, [0, move.y, 0])
      this.position = vec3.add(this.position, vec3.scale(d, speed))
    }
  }

  getView(): View & { invViewProj: Float32Array } {
    const eye = this.eye
    const view = mat4.lookAt(eye, vec3.add(eye, this.forward()), [0, 1, 0])
    const proj = mat4.perspective(FOV, this.aspect, NEAR, FAR)
    const viewProj = mat4.multiply(proj, view)
    return { view, viewProj, invViewProj: mat4.invert(viewProj), eye, fovY: FOV }
  }

  /** World-space ray through a point in normalized device coordinates. */
  ray(ndcX: number, ndcY: number): { origin: Vec3; dir: Vec3 } {
    const { invViewProj, eye } = this.getView()
    const far = mat4.transformPoint(invViewProj, [ndcX, ndcY, 1])
    const p: Vec3 = [far[0] / far[3], far[1] / far[3], far[2] / far[3]]
    return { origin: eye, dir: vec3.normalize(vec3.sub(p, eye)) }
  }
}
