import type { WebGPUFailure } from '../engine/engine'

/** `?3d` in the address: stay in 3D even without a real GPU (software WebGPU, slow). */
export const FORCE_3D = new URLSearchParams(window.location.search).has('3d')

/** The 2D game's page, telling it why it was opened. */
export const page2d = (reason?: WebGPUFailure) => `${import.meta.env.BASE_URL}2d.html${reason ? `?sem-webgpu=${reason}` : ''}`
