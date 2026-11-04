/* eslint-disable react-refresh/only-export-components -- an icon registry, not a component module */
import type { ReactNode, SVGProps } from 'react'
import type { Tool } from '../engine/settings'

type IconProps = SVGProps<SVGSVGElement> & { size?: number }

function Svg({ size = 20, children, ...rest }: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  )
}

export const Icon = {
  inspect: (p: IconProps) => (
    <Svg {...p}>
      <path d="M5 3.5 5 17l3.6-3.4 2.4 5.4 2.3-1-2.4-5.3 5-.3Z" />
      <circle cx="17.5" cy="17.5" r="3" />
      <path d="m19.7 19.7 1.8 1.8" />
    </Svg>
  ),
  rock: (p: IconProps) => (
    <Svg {...p}>
      <path d="M3 19 9.5 7l3.5 6 2-3 6 9Z" />
      <path d="m8.2 9.6 1.3 1.4 1.3-1.2" />
    </Svg>
  ),
  soil: (p: IconProps) => (
    <Svg {...p}>
      <path d="M3 8c3-2 6 2 9 0s6 2 9 0" />
      <path d="M3 13c3-2 6 2 9 0s6 2 9 0" />
      <path d="M3 18c3-2 6 2 9 0s6 2 9 0" />
    </Svg>
  ),
  sand: (p: IconProps) => (
    <Svg {...p}>
      <path d="M2 18c4-6 8-6 12-2 2-3 5-3 8 0" />
      <circle cx="7" cy="8" r="0.6" fill="currentColor" />
      <circle cx="11" cy="6" r="0.6" fill="currentColor" />
      <circle cx="15" cy="9" r="0.6" fill="currentColor" />
      <circle cx="19" cy="6.5" r="0.6" fill="currentColor" />
    </Svg>
  ),
  water: (p: IconProps) => (
    <Svg {...p}>
      <path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11Z" />
      <path d="M9.5 14.5a2.6 2.6 0 0 0 2.5 2.5" />
    </Svg>
  ),
  level: (p: IconProps) => (
    <Svg {...p}>
      <path d="M3 17h18" />
      <path d="M5 13c2-3 4-3 6 0" strokeDasharray="1.5 2.2" />
      <path d="M7 9h10l-2 4H9Z" />
    </Svg>
  ),
  heat: (p: IconProps) => (
    <Svg {...p}>
      <path d="M10 13.5V5a2 2 0 0 1 4 0v8.5a4 4 0 1 1-4 0Z" />
      <path d="M12 9v6" />
    </Svg>
  ),
  humidity: (p: IconProps) => (
    <Svg {...p}>
      <path d="M7 15a4 4 0 0 1 .5-8A5 5 0 0 1 17 8a3.5 3.5 0 0 1 0 7Z" />
      <path d="M9 18.5 8 20.5M13 18.5l-1 2M17 18.5l-1 2" />
    </Svg>
  ),
  volcano: (p: IconProps) => (
    <Svg {...p}>
      <path d="M2 20 9 10h6l7 10Z" />
      <path d="M10.5 10c.5 2-1 3-1 5M13.5 10c-.3 2 1.2 3 .6 5" />
      <path d="M12 7V3M9 5.5 7.5 3M15 5.5 16.5 3" />
    </Svg>
  ),
  pressure: (p: IconProps) => (
    <Svg {...p}>
      <path d="M4.5 16a8 8 0 1 1 15 0" />
      <path d="M12 13.5 15.5 8" />
      <circle cx="12" cy="14" r="1.6" fill="currentColor" stroke="none" />
      <path d="M7 19h10" />
    </Svg>
  ),
  airmass: (p: IconProps) => (
    <Svg {...p}>
      <path d="M3 8h9a2.5 2.5 0 1 0-2.5-2.5" />
      <path d="M3 12.5h14a3 3 0 1 1-3 3" />
      <path d="M3 17h6" />
      <path d="M18 7l3 3-3 3" />
    </Svg>
  ),
  current: (p: IconProps) => (
    <Svg {...p}>
      <path d="M3 8c2.5-2 4.5-2 7 0s4.5 2 7 0 4.5-2 4 0" />
      <path d="M3 13c2.5-2 4.5-2 7 0s4.5 2 7 0 4.5-2 4 0" />
      <path d="M3 18c2.5-2 4.5-2 7 0s4.5 2 7 0 4.5-2 4 0" />
    </Svg>
  ),
  storm: (p: IconProps) => (
    <Svg {...p}>
      <path d="M12 12a3 3 0 1 0 3-3 6 6 0 1 0 6 6 9 9 0 1 1-9-9" />
      <circle cx="12" cy="12" r="0.8" fill="currentColor" stroke="none" />
    </Svg>
  ),
  meteor: (p: IconProps) => (
    <Svg {...p}>
      <circle cx="15.5" cy="15.5" r="4.5" />
      <path d="M11 11 4 4M9 14.5 3 10M14.5 9 10 3" />
    </Svg>
  ),
  rewind: (p: IconProps) => (
    <Svg {...p}>
      <path d="M11 6v12l-8-6Z" />
      <path d="M21 6v12l-8-6Z" />
    </Svg>
  ),
  life: (p: IconProps) => (
    <Svg {...p}>
      <path d="M4 20V11l5-4 5 4v9" />
      <path d="M9 20v-5h0" />
      <circle cx="18" cy="8" r="2.5" />
      <path d="M15.5 20v-6a2.5 2.5 0 0 1 5 0v6" />
    </Svg>
  ),
  flag: (p: IconProps) => (
    <Svg {...p}>
      <path d="M5 21V4" />
      <path d="M5 4h11l-2 4 2 4H5" />
    </Svg>
  ),
  uplift: (p: IconProps) => (
    <Svg {...p}>
      <path d="M2 20 8 12l3 3 4-7 7 12Z" />
      <path d="M12 2v4M9.5 4.5 12 2l2.5 2.5" />
    </Svg>
  ),
  plus: (p: IconProps) => (
    <Svg {...p}>
      <path d="M12 5v14M5 12h14" />
    </Svg>
  ),
  minus: (p: IconProps) => (
    <Svg {...p}>
      <path d="M5 12h14" />
    </Svg>
  ),
  play: (p: IconProps) => (
    <Svg {...p}>
      <path d="M7 4.5v15l12-7.5Z" fill="currentColor" stroke="none" />
    </Svg>
  ),
  pause: (p: IconProps) => (
    <Svg {...p}>
      <path d="M8 5v14M16 5v14" strokeWidth={3} />
    </Svg>
  ),
  undo: (p: IconProps) => (
    <Svg {...p}>
      <path d="M9 14 4 9l5-5" />
      <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
    </Svg>
  ),
  brush: (p: IconProps) => (
    <Svg {...p}>
      <path d="m14 4 6 6-8.5 8.5a3 3 0 0 1-2 .9L4 20l.6-5.5a3 3 0 0 1 .9-2Z" />
      <path d="m12 6 6 6" />
    </Svg>
  ),
  camera: (p: IconProps) => (
    <Svg {...p}>
      <path d="M4 8h3l2-3h6l2 3h3v11H4Z" />
      <circle cx="12" cy="13" r="3.5" />
    </Svg>
  ),
  sparkles: (p: IconProps) => (
    <Svg {...p}>
      <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8Z" />
      <path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8Z" />
    </Svg>
  ),
  help: (p: IconProps) => (
    <Svg {...p}>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .9-1 1.7" />
      <circle cx="12" cy="17" r="0.6" fill="currentColor" />
    </Svg>
  ),
  climate: (p: IconProps) => (
    <Svg {...p}>
      <circle cx="9" cy="9" r="3.5" />
      <path d="M9 2.5v1.2M2.5 9h1.2M4.4 4.4l.9.9M13.6 4.4l-.9.9" />
      <path d="M10 20a3.5 3.5 0 0 1 .3-7 4.5 4.5 0 0 1 8.5 1.5A2.8 2.8 0 0 1 18.5 20Z" />
    </Svg>
  ),
  layers: (p: IconProps) => (
    <Svg {...p}>
      <path d="m12 3 9 5-9 5-9-5Z" />
      <path d="m3 12.5 9 5 9-5" />
      <path d="m3 16.5 9 5 9-5" />
    </Svg>
  ),
  globe: (p: IconProps) => (
    <Svg {...p}>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3Z" />
    </Svg>
  ),
  chart: (p: IconProps) => (
    <Svg {...p}>
      <path d="M4 20V4M4 20h16" />
      <path d="M8 16v-4M12 16V8M16 16v-6" />
    </Svg>
  ),
  close: (p: IconProps) => (
    <Svg {...p}>
      <path d="M6 6l12 12M18 6 6 18" />
    </Svg>
  ),
  orbit: (p: IconProps) => (
    <Svg {...p}>
      <path d="M19.5 9A8 8 0 1 0 20 13" />
      <path d="M20.5 4.5 19.5 9 15 8" />
      <circle cx="12" cy="12" r="2.4" fill="currentColor" stroke="none" />
    </Svg>
  ),
  sun: (p: IconProps) => (
    <Svg {...p}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4" />
    </Svg>
  ),
  moon: (p: IconProps) => (
    <Svg {...p}>
      <path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z" />
    </Svg>
  ),
  download: (p: IconProps) => (
    <Svg {...p}>
      <path d="M12 4v11M7 10l5 5 5-5" />
      <path d="M5 20h14" />
    </Svg>
  ),
  folder: (p: IconProps) => (
    <Svg {...p}>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
    </Svg>
  ),
  image: (p: IconProps) => (
    <Svg {...p}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="9" cy="10" r="1.8" />
      <path d="m21 16-5-5-9 9" />
    </Svg>
  ),
  refresh: (p: IconProps) => (
    <Svg {...p}>
      <path d="M20 11a8 8 0 0 0-14.5-4.5L4 8" />
      <path d="M4 4v4h4" />
      <path d="M4 13a8 8 0 0 0 14.5 4.5L20 16" />
      <path d="M20 20v-4h-4" />
    </Svg>
  ),
  drought: (p: IconProps) => (
    <Svg {...p}>
      <path d="M7 15a4 4 0 0 1-.5-8A6 6 0 0 1 18 8.5a3.5 3.5 0 0 1 .5 6.5" />
      <path d="M4 20l16-16" />
      <path d="M9 19h.01M13 19h.01M17 19h.01" />
    </Svg>
  ),
  fire: (p: IconProps) => (
    <Svg {...p}>
      <path d="M12 3c1 3 4 4.5 4 8.5a4 4 0 0 1-8 0c0-1.5.6-2.6 1.4-3.5.3 1.2 1 2 2.1 2.3C12 8 11 5.5 12 3Z" />
      <path d="M8.5 14.5a3.5 3.5 0 0 0 7 0" />
      <path d="M5 21h14" />
    </Svg>
  ),
  tree: (p: IconProps) => (
    <Svg {...p}>
      <path d="M12 3l5 7h-3l4 5h-5v6h-2v-6H6l4-5H7l5-7Z" />
    </Svg>
  ),
  map: (p: IconProps) => (
    <Svg {...p}>
      <path d="M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2V6Z" />
      <path d="M9 4v14M15 6v14" />
    </Svg>
  ),
  eye: (p: IconProps) => (
    <Svg {...p}>
      <path d="M3 12c0-2 4-7 9-7s9 5 9 7-4 7-9 7-9-5-9-7Z" />
      <circle cx="12" cy="12" r="3" />
    </Svg>
  ),
  eyeOff: (p: IconProps) => (
    <Svg {...p}>
      <path d="M3 3l18 18" />
      <path d="M10.6 5.1A10 10 0 0 1 12 5c5 0 9 5 9 7a9.6 9.6 0 0 1-2.4 3.3M6.2 6.6C4 8 3 10.5 3 12c0 2 4 7 9 7a9.4 9.4 0 0 0 4.4-1.1" />
      <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
    </Svg>
  ),
}

export const TOOL_ICONS: Record<Tool, (p: IconProps) => ReactNode> = {
  inspect: Icon.inspect,
  rock: Icon.rock,
  soil: Icon.soil,
  sand: Icon.sand,
  water: Icon.water,
  level: Icon.level,
  heat: Icon.heat,
  humidity: Icon.humidity,
  volcano: Icon.volcano,
  pressure: Icon.pressure,
  airmass: Icon.airmass,
  plates: Icon.uplift,
  current: Icon.current,
  storm: Icon.storm,
  meteor: Icon.meteor,
  sun: Icon.sun,
  drought: Icon.drought,
}
