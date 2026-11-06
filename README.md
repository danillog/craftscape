# Craftscape

**English** · [Português](README.pt-BR.md)

A planet in your hands, in the browser. Two versions in one project:

- **3D** (`/`): sculpt rock, soil and sand, pour water and watch rain, rivers, erosion, climate
  and vegetation reshape the landscape. The whole simulation runs on the GPU via **WebGPU**.
- **2D** (`/2d.html`): the whole planet seen from above, simulated on the CPU. Its tectonic
  plates drift, its climate has seasons, and its peoples are born, sail, wage war and reach
  the modern age. It is a god game, and it runs in any browser, no GPU needed.

Without WebGPU (or with only software WebGPU, which would freeze the computer), the 3D page
opens the 2D one by itself.

It is a rewrite of the [original Craftscape](https://github.com/pyalot/craftscape) by Florian
Boesch (2011, WebGL1 + jQuery). The 3D water and erosion physics and look are ports of the
original shaders to WGSL; everything else (engine, camera, interface, climate, peoples and the
whole 2D version) was written from scratch.

## Running

```sh
npm install
npm run dev      # http://localhost:5173 (3D) and http://localhost:5173/2d.html (2D)
npm run build    # builds dist/ (a static site, both pages)
npm run lint
```

The 3D version needs a browser with WebGPU. On **Chrome for Linux** it is off by default:
enable `chrome://flags/#enable-unsafe-webgpu` and `chrome://flags/#enable-vulkan` and restart
the browser. Without a real GPU the 3D page redirects to the 2D one; to insist on 3D anyway
(with software WebGPU, very slow), open `/?3d`.

### Deploying (Hostinger)

The site lives at `danillogomes.com/craftscape/` (Vite's `base` is `/craftscape/` for builds).
To deploy:

1. Copy `.env.deploy.example` to `.env.deploy` and fill in the SSH details from hPanel. The
   `.env.deploy` file stays out of git.
2. Run `npm run deploy`. It builds and sends `dist/` with rsync over SSH.

A guard refuses any `DEPLOY_PATH` that does not end in `/craftscape/`, because rsync deletes
whatever else is in the target.

## Craftscape 2D

The code is in `src/tiles/`. The map is the **whole planet** in an equirectangular projection:
the north pole along the top, the equator across the middle, the south pole along the bottom,
360° of longitude from edge to edge. Sizes go from 128² to 384² tiles; above 256² it gets heavy.

**Climate.** Temperature comes from latitude (about 27 °C at the equator and −23 °C at the
poles) and altitude (−6.5 °C per km). Heat from lava, fire and towns, the seasons and the
daily cycle warm the air on top of that.

- **The Earth's shadow:** the sun's height at each point follows real solar geometry
  (latitude, declination, hour). So the night is a curve that bends with the seasons, with
  the midnight sun and the polar night.
- **Winds:** the planet's belts (trade winds, westerlies, polar easterlies) plus high and
  low pressure systems. Lows turn with the Coriolis effect: anticlockwise in the north,
  clockwise in the south, hardly at all at the equator.
- **Pressure belts:** the equatorial low, the subtropical highs (the deserts), the subpolar
  lows and the polar highs. They follow the sun, and the continents have monsoons.
- **Rain:** vapour travels with the wind and rains out above saturation, up slopes, by
  convection and at the heart of lows. Rivers form by flow accumulation. Vegetation, snow,
  ice and sand follow the climate.

**Tectonic plates.** The plates are laid out from the land: each continent is a plate, and
oceanic plates fill the seas. They really move, tile by tile, carrying relief, rivers,
forests and towns along.

- **Collisions:** where two plates meet, oceanic crust dives under (a trench and a volcanic
  arc) or two continents pile up into a mountain range.
- **Rifts:** where they part, new ocean floor opens, shallow at the ridge and deeper as it
  ages. Continents split at rifts and join again, in a cycle like Pangaea's.
- **Earthquakes and volcanoes** along the boundaries, with tsunamis when they strike at sea.

**Peoples** (`src/engine/life.ts`, shared with the 3D version):

- **Growth:** towns grow, found colonies (by sea too) and advance through the ages up to the
  modern era.
- **Contact between peoples:** they trade knowledge, borrow words from their neighbours (the
  tongues form families), spread their faith and go to war, up to nuclear war.
- **On the land:** reversible marks (fields, deforestation, towns, dams, industrial smoke
  that warms the planet).
- **Routes:** roads, ships (sail, steam, cargo) and planes.

**God powers.** Terrain, water, forest, rain, heat, pressure, sun, drought, storm, hurricane
(born over a tropical sea, with a name and a category), fire, volcano, meteor, earthquake (with
aftershocks; from 8.5 up it cracks the plate) and nuclear war. On the peoples: blessing,
inspiration, plague, prophet, discord and peace. Every tool works by holding and dragging.
Three earthquakes of 9 or more in a row set off a cataclysm: the planet melts, the oceans boil
away, everything cools again with new continents and life starts over.

**Playing.**

- **Start:** six scenarios (Classic, Pangaea, Archipelago, Ice age, Hot planet, Young Earth)
  and ten challenges with progress and trophies.
- **Time:** undo, rewind in steps of 10 years, save and load worlds (a `.json.gz` file).
- **Reading the world:** a history book (each people's life and eras, and the great moments),
  a data tab (temperature, CO₂, sea level, population) and notifications of everything that
  happens.
- **View:** Satellite (true colours, towns as lights at night, a latitude/longitude grid) or
  Illustrated (trees, mountains, houses).
- **Maps:** biomes, temperature, rain, humidity, pressure, relief, rivers, terrain change,
  plates, human impact, peoples, eras, religion, languages, plague, famine and wars, with
  scientific colour maps (coolwarm, YlGnBu, viridis, PuOr) and real units (°C, mm/year, hPa,
  m, km).

The game's interface is in Portuguese.

### 2D controls

| Action | Keyboard / mouse |
| --- | --- |
| Move the map | **W A S D** or arrows (Shift: faster), drag with Look (**0**) |
| Zoom | mouse wheel |
| Tools | **0–9**, **F** fire, **V** volcano, **M** meteor, **B** pressure, **G** plates, **H** earthquake, **U** nuclear war, **Y** hurricane |
| Powers over the peoples | **7** people, **J** blessing, **K** inspiration, **L** plague, **N** prophet, **Q** discord, **E** peace |
| Add / remove | **X** |
| Brush size (or earthquake magnitude) | **[ ]** or Shift + wheel |
| Pause · undo | **P** or Space · **Ctrl + Z** |
| Next map · Satellite/Illustrated · wind arrows | **O** (Shift + O goes back) · **I** · **T** |
| Fit the world · shortcuts | **R** · **?** |

### 2D choices and simplifications

The 2D version is a toy simulation with real physics underneath. Where realism gets in the
way of the game, it gives way, and the trade-offs are noted in the code:

- **The climate keeps its own pace.** The peoples' year lasts 10 s at 1×, because history
  needs centuries. The seasons go round every 60 s and a day lasts 20 s, so there is time to
  watch the shadow bend. The calendar is not consistent (one turn of the seasons is 6 years of
  history), and that is on purpose.
- **Exaggerated scale.** The sea rises ~18 m per °C of warming, close to the long-term
  equilibrium, so coasts visibly flood. Fault steps from earthquakes reach ~120 m. Plates
  move a tile every few seconds.
- **Conservation.** Crust squeezed in a collision becomes mountain volume, and erosion
  returns sediment to the plains, so land does not vanish over time. Even so, long drift
  cycles lose some area.
- **Calibrated by simulation.** Constants such as evaporation, plant transpiration, wind
  convergence and hurricane thresholds (25 °C) were tuned by running the world in Node and
  measuring forest, bare land, snow and temperature by latitude. The resulting planet has a
  mean of ~14 °C and ~20–30% bare land.
- **The map is square.** The projection is squashed: each tile covers twice as many degrees
  east–west as north–south. The world does not wrap at the edges, so continents stop before
  them.
- **The 3D version is something else.** The peoples are the same code in both versions, but
  the 2D one has physics of its own (CPU, tiles) and does not try to reproduce the 3D one.

## Craftscape 3D

### Controls

| Action | Mouse / keyboard | Touch |
| --- | --- | --- |
| Paint | hold **Space** with the cursor over the terrain, or turn on "Pintar com clique" | **Pintar** button + drag |
| Orbit the camera | drag | 1 finger |
| Pan the camera | right button or Shift + drag, **W A S D** (Q/E up and down) | 2 fingers |
| Zoom | mouse wheel | pinch |
| Brush size | Shift + wheel, **[** and **]** | slider |
| Tool | **1** rock, **2** soil, **3** sand, **4** water | panel |
| Undo | **Ctrl + Z** | Desfazer button |
| Pause · orbit/fly camera | **P** · **C** | panel |

### What changed from the original

- **WebGPU + compute shaders** instead of WebGL1 with render-to-texture. Everything is `f32`:
  the original relied on drivers that ignored `mediump`, and on current drivers (Mesa/AMD)
  the rain and the brush rounded down to zero.
- **Fixed simulation step** (60 per second): the speed no longer depends on the monitor's
  frame rate.
- **Brush on the relief**: a ray march finds the exact point under the cursor (the original
  projected onto the zero-height plane).
- **New materials**: sand (it slides past its angle of repose and water carries it), snow,
  ice, and vegetation that grows on moist soil, holds the soil against erosion and drowns.
- **Climate**: wind that carries vapour and casts rain shadows behind mountains, high and low
  pressure systems, day and night, layered clouds, lava and volcanoes, data maps (biomes,
  temperature, rain, pressure and more).
- **Infinite world**: the simulation window slides across the world, keeping the regions
  already visited.
- **Peoples and plates**: civilizations (`life.ts`) and tectonic plates (`plates.ts`),
  challenges and ready-made scenarios.
- **Save/load** the terrain (`.craftscape`, gzip), **import a heightmap** (PNG/JPG) and
  **undo**.
- **Performance**: a chunked mesh with distance LOD, frustum culling and seams between levels;
  heightfield ray-marched shadows and occlusion spread over 4 frames; simulation resolution
  from 256² to 2048², with an automatic mode that lowers it when frames get slow.
- React interface; no jQuery or global scripts.

## Structure

```
src/main.tsx      3D entry (redirects to 2D without WebGPU)
src/engine/
  engine.ts       main loop, fixed step, brush, undo, files, resolution
  simulation.ts   simulation buffers and compute passes
  renderer.ts     terrain, water and sky; chunked LOD
  life.ts         peoples and civilizations (used by both 3D and 2D)
  plates.ts       the 3D tectonic plates
  camera.ts, input.ts, io.ts, settings.ts, ...
  shaders/sim.ts     simulation WGSL (water, erosion, sand, vegetation, climate, shadows, picking)
  shaders/render.ts  rendering WGSL
src/ui/           3D interface in React (fallback.ts: the switch to 2D)
src/tiles/        Craftscape 2D
  world.ts        the simulation: climate, seasons, pressure, water, rivers, vegetation, disasters
  tectonics.ts    drifting plates, collisions, rifts, cracks
  game.ts         loop, input, powers, undo/rewind, challenges
  render.ts       2D canvas: satellite/illustrated views, maps, the Earth's shadow, effects
  goals.ts        scenarios and challenges
  save.ts         saved worlds (gzipped JSON)
  sound.ts        sounds made with Web Audio
  App.tsx, Extras.tsx, Charts.tsx   interface
```

In the 3D version the simulation state is `N×N` buffers of `vec4f`:
`ground` = (total height, rock, soil, sand), `water` = (depth, flow x, flow y),
`extra` = (vegetation, moisture). The 2D version uses the same layout (a `Field` of 4 floats
per tile), which is why the peoples run the same in both.

## License

[GNU AGPL-3.0](LICENSE), like the original. Copyright © 2011 Florian Boesch for the original
Craftscape; simplex noise by Ashima Arts (MIT). If you publish a modified version as a
website, the AGPL requires making the source code available to its users — a link to the
repository is enough.
