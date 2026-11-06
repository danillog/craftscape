// Canvases that work on the page and in a worker alike: the game draws on whichever it is given.

export type Canvas = HTMLCanvasElement | OffscreenCanvas
export type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

/** A canvas to draw on off screen: an element on the page, an OffscreenCanvas in a worker. */
export function makeCanvas(width = 1, height = 1): Canvas {
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas')
    c.width = width
    c.height = height
    return c
  }
  return new OffscreenCanvas(width, height)
}

/** A canvas's 2D context (it has one: these canvases are only ever drawn on in 2D). */
export const context2d = (c: Canvas): Ctx => c.getContext('2d') as Ctx
