// Colours the maps of the peoples share between the 3D and the 2D game.

export type Rgb = [number, number, number]

/** Eight categorical hues in a fixed order (validated for colour-blind vision; the dataviz reference palette, dark mode). */
export const CATEGORICAL: Rgb[] = [
  [57, 135, 229], [217, 89, 38], [25, 158, 112], [201, 133, 0], [213, 81, 129], [0, 131, 0], [144, 133, 233], [230, 103, 103],
]
/** The eras, an ordered ramp from light (Stone Age) to dark (Modern). */
export const ERA_RAMP: Rgb[] = [
  [134, 182, 239], [109, 167, 236], [57, 135, 229], [42, 120, 214], [28, 92, 171], [24, 79, 149], [13, 54, 107],
]
/** A land with no plague, hunger or war, and the colours of each at its worst. */
export const CALM: Rgb = [214, 210, 196]
export const PLAGUE_COLOR: Rgb = [110, 160, 30]
export const FAMINE_COLOR: Rgb = [175, 85, 20]
export const WAR_COLOR: Rgb = [230, 103, 103]
export const PEACE_COLOR: Rgb = [150, 172, 196]

/** What the peoples made of the land, on the human-impact map: its name and colour, lightest touch first. */
export const HUMAN_MARKS: { name: string; color: Rgb }[] = [
  { name: 'Lavouras', color: [222, 190, 90] },
  { name: 'Terraços', color: [160, 150, 70] },
  { name: 'Irrigação', color: [60, 160, 170] },
  { name: 'Cidade grande', color: [150, 130, 175] },
  { name: 'Indústria', color: [85, 75, 78] },
]

export const mixRgb = (a: Rgb, b: Rgb, t: number): Rgb => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
export const rgbCss = (c: Rgb) => `rgb(${c.map((v) => Math.round(v)).join(' ')})`
