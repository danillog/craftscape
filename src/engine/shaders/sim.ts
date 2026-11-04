// Compute shaders for the erosion / water simulation.
// Ported from the original Craftscape GLSL passes by Florian Boesch (AGPL-3.0).
//
// Buffers are array<vec4f> of size N×N, row-major (index = y*N + x):
//   ground:  x = total height (rock + soil + sand + ice), y = rock, z = soil, w = sand
//   water:   x = depth, yz = flux/velocity along +x/+y, w = coarse sediment (sand) carried, in height units; the fine buffer holds the silt and clay
//   extra:   x = vegetation density, y = soil water (share of what the soil holds), z = snowpack (water equivalent), w = ice thickness
//   air:     x = water vapour (1 = saturated at 15 °C), y = precipitation this step,
//            z = air temperature (°C), w = local humidity offset painted by the brush and
//            the fixed air-mass source painted by the brush, packed (see airSourceOf)
//   climate: x = local temperature offset painted by the brush (°C), y = relative humidity,
//            z = mean precipitation (1 = the original uniform rain), w = temperature (°C)
//   wind:    (flowSize², a quarter of the resolution) xy = wind in low-res cells per step,
//            z = solver pressure, w = weather pressure anomaly (lows < 0 < highs)
//   lava:    x = molten lava thickness, y = lava temperature (1 = fresh, solidifies near 0),
//            z = volcanic vent strength painted by the brush,
//            w = tectonic uplift from the plates (−1 sinking … 1 rising; see platesShader)
// ground.x also counts molten lava, so water and lava run over each other.
// Neighbours past the border are clamped, like CLAMP_TO_EDGE in the original.

/** Plates whose motion the user has changed, at most this many at a time. */
export const MAX_PLATE_OVERRIDES = 16
/** Storms (moving lows) the storm tool keeps alive at a time. */

export const MAX_STORMS = 4
export const MAX_DUSTS = 4
/** Fixed highs (the drought power) held at a time. */
export const MAX_HIGHS = 6
export const SIM_UNIFORM_SIZE = 272 + MAX_PLATE_OVERRIDES * 32 + 64 + MAX_STORMS * 16 + MAX_DUSTS * 16 + MAX_HIGHS * 16 + 16

const header = /* wgsl */ `
struct Sim {
  size: u32,
  flowSize: u32,
  frame: u32,
  pad0: u32,
  rain: f32,
  evaporate: f32,
  erode: f32,
  vegetation: f32,
  brushUV: vec2f,
  brushRadius: f32,
  brushActive: f32,
  rockF: f32,
  soilF: f32,
  sandF: f32,
  waterF: f32,
  time: f32,
  seed: f32,
  lightTan: f32,
  climateDt: f32,   // steps covered by one run of the air pass (it runs every climateDt steps)
  lightDir: vec4f,
  rayOrigin: vec4f,
  rayDir: vec4f,
  climate: vec4f,   // temperature at height 0 on the middle latitude (°C), anomaly (°C), sea level, ocean on
  level: vec4f,     // leveling brush: rate, target height; z: pressure brush rate (+ highs, − lows);
                    // w: mean weather pressure over the window (measured on the CPU)
  wind: vec4f,      // xy: wind in uv per step, z: humidity of the incoming air, w: rain amount
  climate2: vec4f,  // x: north-south temperature difference (°C), y: lapse rate (°C per height unit),
                    // z: heat brush rate, w: humidity brush rate
  sky: vec4f,       // x: simulated seconds, y: pressure-system strength, z: daylight (0 night, 1 day),
                    // w: volcano brush rate
  world: vec4f,     // xy: window origin in the infinite world, in cells; z: automatic climate;
                    // w: simulated area, the window's width in world units
  rect: vec4f,      // generation rectangle in window cells: x0, y0, x1, y1 (exclusive)
  shape: vec4f,     // terrain shape: x continents, y height offset, z relief multiplier, w continents per window
  geo: vec4f,       // x: rate of the geological processes in each substep (1 normally, more in
                    // geological time), y: plate time (how far a plate of unit speed has drifted,
                    // world units), z: number of plate overrides, w: air-mass brush rate
                    // (+ warm, − cold)
  // plate overrides, two entries each: (plate cell xy, velocity zw), (drift when it was
  // changed xy, plate time then, 0)
  plates: array<vec4f, ${MAX_PLATE_OVERRIDES * 2}>,
  quake: vec4f,     // earthquake this frame: epicentre uv, fault normal angle, radius (world units)
  quake2: vec4f,    // x: fault throw (signed height), y: rubble shaken loose, z: 1 while a quake runs
  source: vec4f,    // x: fixed air-mass brush rate (+ warm, − cold), y: 1 clears every fixed source,
                    // z: ocean-current brush rate (+ warm, − cold)
  impact: vec4f,    // meteor strike this frame: xy centre uv, z radius (world units, 0 none),
                    // w crater depth (height units)
  storms: array<vec4f, ${MAX_STORMS}>,  // storms (the storm tool): xy centre uv, z strength (0 none), w radius (uv)
  dusts: array<vec4f, ${MAX_DUSTS}>,    // dust clouds from strikes: xy centre uv, z °C of shade at the centre (0 none), w radius (uv)
  highs: array<vec4f, ${MAX_HIGHS}>,    // fixed highs (the drought power): xy centre uv, z strength (0 none), w radius (uv)
  vent: vec4f,      // a volcano waking or going quiet this frame: xy centre uv, z radius (uv, 0 none),
                    // w change of vent strength (+ opens, − plugs)
}
@group(0) @binding(0) var<uniform> S: Sim;

// air.w packs two painted values: the humidity offset (−1 … 1) in the fraction and the
// fixed air-mass source (−1 cold … 1 warm, in steps of 0.002) as a multiple of 4, so each
// is read back exactly (±2001 needs no more precision than a float has).
fn airSourceOf(w: f32) -> f32 { return round(w * 0.25) * 0.002; }
fn airHumidityOf(w: f32) -> f32 { return w - round(w * 0.25) * 4.0; }
fn packAirW(humidity: f32, source: f32) -> f32 {
  return clamp(humidity, -1.0, 1.0) + round(clamp(source, -1.0, 1.0) * 500.0) * 4.0;
}
// Dust thrown up by meteor strikes hangs over the region for days: how many °C it keeps
// off the ground here (the sun is dimmed under it too, see airShader).
fn dustAt(uv: vec2f) -> f32 {
  var d = 0.0;
  for (var k = 0; k < ${MAX_DUSTS}; k++) {
    let c = S.dusts[k];
    if (c.z <= 0.0) { continue; }
    d += c.z * (1.0 - smoothstep(0.4, 1.0, distance(uv, c.xy) / c.w));
  }
  return d;
}

// A fixed high (the drought power) over a place: 0–1 how much it covers it. The air
// sinks and warms under it: the vapour is kept, nothing condenses, the sky stays clear.
fn highAt(uv: vec2f) -> f32 {
  var h = 0.0;
  for (var k = 0; k < ${MAX_HIGHS}; k++) {
    let c = S.highs[k];
    if (c.z <= 0.0) { continue; }
    h = max(h, c.z * (1.0 - smoothstep(0.5, 1.0, distance(uv, c.xy) / c.w)));
  }
  return h;
}

// The window spans extent() world units, so a cell is 1 / cellsPerUnit() of a unit.
// Anything measured in the world (slopes, distances, latitude, the terrain noise) uses
// these; the water, erosion and lava work per cell and need neither.
fn extent() -> f32 { return S.world.w; }
fn cellsPerUnit() -> f32 { return f32(S.size) / S.world.w; }
// Window uv → world position (the classic square is 0–1 at the default area).
fn worldUV(uv: vec2f) -> vec2f { return (uv + S.world.xy / f32(S.size)) * S.world.w; }
// Temperature of the ground: colder up high and towards the north, plus whatever the
// climate brush painted there. v is the window's; latitude follows the world v, the
// north–south difference applying per window width, levelling off in polar and
// tropical belts (world v beyond −1 or 2).
fn groundTemp(h: f32, v: f32, offset: f32) -> f32 {
  let lat = clamp((v + S.world.y / f32(S.size)) * S.world.w, -1.0, 2.0);
  return S.climate.x - S.climate2.y * h + S.climate2.x * (0.5 - lat) + offset * (1.0 - S.world.z);
}
// How much vapour air holds before it rains (Clausius-Clapeyron-ish), 1 at 15 °C.
fn capacity(t: f32) -> f32 { return exp(0.065 * (clamp(t, -40.0, 50.0) - 15.0)); }
// 1 below freezing, 0 above, with a 1 °C transition.
fn frozen(t: f32) -> f32 { return smoothstep(0.5, -0.5, t); }
// Rain amount per unit of condensed vapour.
fn rainWater() -> f32 { return 0.00015 * S.wind.w; }

fn ixn(x: i32, y: i32, n: i32) -> u32 {
  return u32(clamp(y, 0, n - 1) * n + clamp(x, 0, n - 1));
}
fn ix(x: i32, y: i32) -> u32 { return ixn(x, y, i32(S.size)); }
fn uvOf(x: i32, y: i32) -> vec2f { return (vec2f(f32(x), f32(y)) + 0.5) / f32(S.size); }
// The air blowing in past the upwind border is not all alike: cold and warm air masses
// take turns (polar outbreaks, warm surges), a few degrees either way, each about as
// long as the map at the wind's pace and slanted along the border, so fronts come in
// and cross the map. Only in the automatic climate (they come with the planetary
// circulation; a world with the climate set by hand keeps its calibrated rain) and with
// the pressure systems on (the controlled tests have none).
const INFLOW_MASS = 3.0;
fn inflowAnomaly(uv: vec2f) -> f32 {
  // S.sky.x is simulated seconds, 60 steps each: one cycle every 1200 steps
  let phase = S.sky.x / 20.0;
  return INFLOW_MASS * S.sky.y * S.world.z * sin(6.2831853 * (phase + 0.5 * uv.y + 0.25 * uv.x));
}

// Original brush: smoothstep(1, 0, dist), dist normalised by the radius.
fn brushFactor(uv: vec2f) -> f32 {
  if (S.brushActive < 0.5) { return 0.0; }
  let d = distance(uv, S.brushUV) / S.brushRadius;
  return 1.0 - smoothstep(0.0, 1.0, d);
}
`

// Weathering rates, per step, shared with the render shader's Erosion map so the map
// shows exactly what the simulation does.
export const weatheringModel = /* wgsl */ `
// Rock strata: the bedrock is a pile of layers, gently tilted and warped, each with its
// own hardness and colour. The layer at a point depends only on where it is and how high
// the rock surface is there, so as erosion lowers the rock it cuts into the layers below
// by itself: hard caprock holds up mesas and ledges, soft layers wash out between them,
// waterfalls form where a river crosses a hard band, and cliffs show the banding.
const STRATA_PER_UNIT = 45.0;
// integer hash (PCG), so the CPU's cross-section draws exactly the same layers
fn strataHash(n: f32) -> f32 {
  var h = u32(i32(n) + 1000000) * 747796405u + 2891336453u;
  h = ((h >> ((h >> 28u) + 4u)) ^ h) * 277803737u;
  h = (h >> 22u) ^ h;
  return f32(h) / 4294967295.0;
}
fn stratumOf(world: vec2f, rockTop: f32, seed: f32) -> f32 {
  let dip = vec2f(sin(seed * 1.7), cos(seed * 2.3)) * 0.012;
  let warp = (sin(world.x * 3.1 + seed) + sin(world.y * 2.7 - seed * 0.5)) * 0.004;
  return floor((rockTop + dot(world, dip) + warp) * STRATA_PER_UNIT + fract(seed * 0.618) * 7.0);
}
// how hard a layer is: about a third are resistant bands (sandstone, basalt, limestone)
fn stratumHardness(layer: f32) -> f32 {
  let h = strataHash(layer);
  return select(0.4 + 0.7 * strataHash(layer + 17.0), 1.8 + 1.4 * strataHash(layer + 31.0), h > 0.66);
}
fn rockHardness(world: vec2f, rockTop: f32, seed: f32) -> f32 {
  return stratumHardness(stratumOf(world, rockTop, seed));
}
// a layer's colour: buff and red sandstones, grey limestone, dark shale
fn stratumColor(layer: f32) -> vec3f {
  let h = strataHash(layer + 5.0);
  var c = vec3f(0.78, 0.68, 0.52);
  if (h > 0.25) { c = vec3f(0.72, 0.42, 0.3); }
  if (h > 0.5) { c = vec3f(0.62, 0.62, 0.6); }
  if (h > 0.78) { c = vec3f(0.36, 0.33, 0.32); }
  // hard bands a little lighter, so ledges read
  return c * mix(0.92, 1.08, smoothstep(1.0, 2.0, stratumHardness(layer)));
}

// how exposed rock is: soil shields it partly, ice completely
fn rockExposure(soil: f32, ice: f32) -> f32 {
  return (0.3 + 0.7 * (1.0 - smoothstep(0.0, 0.002, soil))) * (1.0 - smoothstep(0.0, 0.002, ice));
}
// freeze–thaw: water in cracks freezing and thawing around 0 °C
fn frostRate(t: f32, rain: f32) -> f32 { return exp(-t * t / 18.0) * min(rain, 2.0) * 0.00000015; }
// chemical: warm, wet climates rot rock
fn chemicalRate(t: f32, rain: f32) -> f32 { return smoothstep(15.0, 28.0, t) * rain * 0.0000001; }
// Day–night temperature swing in °C: large under dry, clear air over bare dry ground
// (deserts, high plateaus), small where humid air, plants, water or snow buffer it.
fn dailySwing(rh: f32, plants: f32, wet: f32, cover: f32) -> f32 {
  return 28.0 * (1.0 - 0.8 * clamp(rh, 0.0, 1.0)) * (1.0 - 0.6 * plants) * (1.0 - wet) *
    (1.0 - smoothstep(0.0, 0.002, cover));
}
// thermal stress: rock expanding by day and contracting at night cracks into grit
fn thermalRate(swing: f32) -> f32 { return smoothstep(10.0, 24.0, swing) * 0.0000015; }
// surf: waves build up over deep water and break where it meets the shore
fn surfEnergy(deepest: f32, depth: f32) -> f32 {
  return smoothstep(0.004, 0.03, deepest) * (1.0 - smoothstep(0.002, 0.01, depth));
}
const SURF_RATE = 0.000002;
// rock uplift per step in a fully painted tectonic zone (height units)
const UPLIFT_RATE = 0.000002;
// rock height where uplift starts to fade, where it stops (isostasy), and how fast rock
// above it collapses back per step
const CRUST_SOFT = 0.12;
const CRUST_MAX = 0.25;
const COLLAPSE_RATE = 0.0005;
// Sediment transport (see sedimentShader): how much fast water on steep ground can carry,
// and how quickly it picks up or drops the difference.
const SED_CAPACITY = 0.0075;
const SED_ERODE = 0.04;
// sand (carried in water.w) settles fast, silt and clay (the fine buffer) ten times slower
const SED_DEPOSIT = 0.12;
const SED_DEPOSIT_FINE = 0.012;
// share of the capacity that is coarse
const COARSE_SHARE = 0.5;
// water depth at which the capacity is as given (deeper carries more, up to 3×)
const CHANNEL_DEPTH = 0.004;
// bank erosion per unit of current pushing on a unit of bank height
const BANK_RATE = 0.002;
fn streamCapacity(speed: f32, slope: f32) -> f32 {
  return SED_CAPACITY * min(speed, 1.0) * clamp(slope, 0.05, 2.0);
}
// water velocity in cells per step (flux over depth), at most a cell per step
fn waterVelocity(w: vec4f) -> vec2f {
  let v = w.yz / (w.x + 0.0005);
  let l = length(v);
  return select(v, v / l, l > 1.0);
}
`

// Tectonic plates: the world is tiled into plates, the cells of a jittered Voronoi
// diagram in world units, so they continue past the window like the strata. Each plate
// drifts its own way; what happens at a boundary depends on how the two plates on either
// side move against each other. The plates really move: each site drifts with its
// velocity as the plate time goes by, so the boundaries migrate and plates grow and
// shrink; a plate stops once it has drifted PLATE_RANGE. Shared with the render shader
// (plate map) and mirrored on the CPU in plates.ts (integer hash, so both agree exactly).
// The uniform fields holding the plate time, the number of overrides and the overrides
// differ between the shaders, hence the parameters.
export const platesModel = (time: string, count: string, overrides: string) => /* wgsl */ `
const PLATE_CELL = 0.8;
const PLATE_RANGE = 2.4;
fn plateHash(c: vec2i, salt: u32) -> f32 {
  var h = (u32(c.x + 100000) * 1597334677u) ^ (u32(c.y + 100000) * 3812015801u) ^ (salt * 2654435769u);
  h = h * 747796405u + 2891336453u;
  h = ((h >> ((h >> 28u) + 4u)) ^ h) * 277803737u;
  h = (h >> 22u) ^ h;
  return f32(h) / 4294967295.0;
}
fn plateSalt(seed: f32) -> u32 { return u32(max(seed, 0.0)) * 8u; }
// a plate's own drift, before any change by the user: up to one unit of speed
fn naturalVelocity(c: vec2i, seed: f32) -> vec2f {
  let s = plateSalt(seed);
  let angle = plateHash(c, s + 2u) * 6.2831853;
  return vec2f(cos(angle), sin(angle)) * (0.4 + 0.6 * plateHash(c, s + 3u));
}
// the override of this plate's motion, or -1
fn plateOverride(c: vec2i) -> i32 {
  for (var k = 0u; k < u32(${count}); k++) {
    let o = ${overrides}[k * 2u];
    if (i32(o.x) == c.x && i32(o.y) == c.y) { return i32(k); }
  }
  return -1;
}
fn plateVelocity(c: vec2i, seed: f32) -> vec2f {
  let k = plateOverride(c);
  if (k >= 0) { return ${overrides}[u32(k) * 2u].zw; }
  return naturalVelocity(c, seed);
}
// how far the plate has drifted from where it started: its velocity times the plate
// time; a plate whose motion was changed goes on from where it was then
fn plateDrift(c: vec2i, seed: f32) -> vec2f {
  let t = ${time};
  let k = plateOverride(c);
  var d = naturalVelocity(c, seed) * t;
  if (k >= 0) {
    let o = ${overrides}[u32(k) * 2u];
    let o2 = ${overrides}[u32(k) * 2u + 1u];
    d = o2.xy + o.zw * (t - o2.z);
  }
  let l = length(d);
  return select(d, d * (PLATE_RANGE / l), l > PLATE_RANGE);
}
// a plate's centre: it started somewhere in the middle of its grid cell and drifted since
fn plateSite(c: vec2i, seed: f32) -> vec2f {
  let s = plateSalt(seed);
  return (vec2f(c) + 0.15 + 0.7 * vec2f(plateHash(c, s), plateHash(c, s + 1u))) * PLATE_CELL + plateDrift(c, seed);
}
// how many grid cells away a site may have drifted to: the search radius
fn plateReach() -> i32 { return 1 + i32(ceil(min(max(${time}, 0.0), PLATE_RANGE) / PLATE_CELL)); }
struct PlatePair {
  own: vec2i,    // the plate this point is on
  other: vec2i,  // the nearest other plate
  a: vec2f,      // their sites
  b: vec2f,
  dist: f32,     // distance to the boundary between them (world units)
}
fn platePair(p: vec2f, seed: f32) -> PlatePair {
  let base = vec2i(floor(p / PLATE_CELL));
  var r: PlatePair;
  var d1 = 1e9;
  var d2 = 1e9;
  let reach = plateReach();
  for (var dy = -reach; dy <= reach; dy++) {
    for (var dx = -reach; dx <= reach; dx++) {
      let c = base + vec2i(dx, dy);
      let s = plateSite(c, seed);
      let d = dot(p - s, p - s);
      if (d < d1) {
        d2 = d1; r.other = r.own; r.b = r.a;
        d1 = d; r.own = c; r.a = s;
      } else if (d < d2) {
        d2 = d; r.other = c; r.b = s;
      }
    }
  }
  r.dist = (d2 - d1) / (2.0 * max(distance(r.a, r.b), 1e-6));
  return r;
}
`

// Bilinear fetch from a storage buffer, mirroring LINEAR texture filtering.
const bilinear = (fn: string, buf: string, size = 'S.size') => /* wgsl */ `
fn ${fn}(uv: vec2f) -> vec4f {
  let n = i32(${size});
  let t = uv * f32(n) - 0.5;
  let f = fract(t);
  let b = vec2i(floor(t));
  let a = mix(${buf}[ixn(b.x, b.y, n)], ${buf}[ixn(b.x + 1, b.y, n)], f.x);
  let c = mix(${buf}[ixn(b.x, b.y + 1, n)], ${buf}[ixn(b.x + 1, b.y + 1, n)], f.x);
  return mix(a, c, f.y);
}
`

// Nearest-texel fetch: much cheaper than bilinear for the many-sample ray marches.
const nearest = (fn: string, buf: string) => /* wgsl */ `
fn ${fn}(uv: vec2f) -> vec4f {
  let n = i32(S.size);
  let p = vec2i(floor(uv * f32(n)));
  return ${buf}[ixn(p.x, p.y, n)];
}
`

// Like gridMain, but only processes one of SLICES horizontal bands (chosen by the
// frame counter), so expensive passes can be spread over several frames.
const slicedMain = (body: string) => /* wgsl */ `
override SLICES: u32 = 1;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let band = (S.size + SLICES - 1u) / SLICES;
  if (id.y >= band) { return; }
  let row = id.y + (S.frame % SLICES) * band;
  if (id.x >= S.size || row >= S.size) { return; }
  let x = i32(id.x);
  let y = i32(row);
  let i = ix(x, y);
  ${body}
}
`

const gridMain = (body: string) => /* wgsl */ `
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= S.size || id.y >= S.size) { return; }
  let x = i32(id.x);
  let y = i32(id.y);
  let i = ix(x, y);
  ${body}
}
`

// Ashima Arts simplex noise (MIT), as used by the original simplex/god shaders.
const simplex = /* wgsl */ `
fn mod289_3(x: vec3f) -> vec3f { return x - floor(x * (1.0 / 289.0)) * 289.0; }
fn mod289_4(x: vec4f) -> vec4f { return x - floor(x * (1.0 / 289.0)) * 289.0; }
fn permute4(x: vec4f) -> vec4f { return mod289_4(((x * 34.0) + 1.0) * x); }
fn taylorInvSqrt4(r: vec4f) -> vec4f { return 1.79284291400159 - 0.85373472095314 * r; }

fn snoise(v: vec3f) -> f32 {
  let C = vec2f(1.0 / 6.0, 1.0 / 3.0);
  let D = vec4f(0.0, 0.5, 1.0, 2.0);
  var i = floor(v + dot(v, C.yyy));
  let x0 = v - i + dot(i, C.xxx);
  let g = step(x0.yzx, x0.xyz);
  let l = 1.0 - g;
  let i1 = min(g.xyz, l.zxy);
  let i2 = max(g.xyz, l.zxy);
  let x1 = x0 - i1 + C.xxx;
  let x2 = x0 - i2 + C.yyy;
  let x3 = x0 - D.yyy;
  i = mod289_3(i);
  let p = permute4(permute4(permute4(
      i.z + vec4f(0.0, i1.z, i2.z, 1.0))
    + i.y + vec4f(0.0, i1.y, i2.y, 1.0))
    + i.x + vec4f(0.0, i1.x, i2.x, 1.0));
  let ns = 0.142857142857 * D.wyz - D.xzx;
  let j = p - 49.0 * floor(p * ns.z * ns.z);
  let x_ = floor(j * ns.z);
  let y_ = floor(j - 7.0 * x_);
  let x = x_ * ns.x + ns.yyyy;
  let y = y_ * ns.x + ns.yyyy;
  let h = 1.0 - abs(x) - abs(y);
  let b0 = vec4f(x.xy, y.xy);
  let b1 = vec4f(x.zw, y.zw);
  let s0 = floor(b0) * 2.0 + 1.0;
  let s1 = floor(b1) * 2.0 + 1.0;
  let sh = -step(h, vec4f(0.0));
  let a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  let a1 = b1.xzyw + s1.xzyw * sh.zzww;
  var p0 = vec3f(a0.xy, h.x);
  var p1 = vec3f(a0.zw, h.y);
  var p2 = vec3f(a1.xy, h.z);
  var p3 = vec3f(a1.zw, h.w);
  let norm = taylorInvSqrt4(vec4f(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x;
  p1 *= norm.y;
  p2 *= norm.z;
  p3 *= norm.w;
  var m = max(0.6 - vec4f(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), vec4f(0.0));
  m = m * m;
  return 42.0 * dot(m * m, vec4f(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}
`

// simplex3d.shader: fractal noise heightmap; the seed is the noise z offset.
// Sampled in world coordinates, so neighbouring regions continue each other.
const terrainNoise = /* wgsl */ `
fn terrainHeight(uv: vec2f, octaves: i32) -> f32 {
  var h = 0.0;
  for (var k = 0; k < octaves; k++) {
    let factor = pow(2.0, f32(k));
    h += snoise(vec3f(uv * factor, S.seed * f32(k + 1))) / (pow(factor, 0.88) * 10.0);
  }
  // scenario shape: the relief scaled, broad rises and basins (islands with the sea on), all lifted or sunk
  let broad = snoise(vec3f(uv * S.shape.w, S.seed * 0.37 + 11.0));
  return h * S.shape.z + broad * S.shape.x + S.shape.y;
}
`
// Freezing peaks start with a snowpack so glaciers exist from the start, gentle
// ground with soil and plants, and the air as humid as the incoming wind. Only
// cells inside S.rect are written (the infinite world generates strips of it).
export const generateShader = header + simplex + terrainNoise + /* wgsl */ `
@group(0) @binding(1) var<storage, read_write> ground: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> extra: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> air: array<vec4f>;
@group(0) @binding(4) var<storage, read_write> climate: array<vec4f>;
` + gridMain(/* wgsl */ `
  if (f32(x) < S.rect.x || f32(y) < S.rect.y || f32(x) >= S.rect.z || f32(y) >= S.rect.w) { return; }
  let uv = uvOf(x, y);
  let w = worldUV(uv);
  let h = terrainHeight(w, 10);
  let t = groundTemp(h, uv.y, 0.0);
  // start out lived-in, so new regions don't show up as bare rock next to old ones:
  // a thin soil on gentle slopes, and plants where it isn't too cold or hot
  // slope of the broad shape (over 8 cells), not of the fine roughness
  let d = 8.0 / cellsPerUnit();
  let h7 = terrainHeight(w, 7);
  let slope = length(vec2f(terrainHeight(w + vec2f(d, 0.0), 7) - h7, terrainHeight(w + vec2f(0.0, d), 7) - h7)) / d;
  let soil = 0.0025 * (1.0 - smoothstep(0.5, 1.2, slope)) * smoothstep(-6.0, 2.0, t);
  let plants = 0.6 * smoothstep(0.0002, 0.001, soil) * smoothstep(-2.0, 8.0, t) * (1.0 - smoothstep(30.0, 40.0, t));
  ground[i] = vec4f(h + soil, h, soil, 0.0);
  extra[i] = vec4f(plants, 0.2, 0.003 * frozen(t), 0.0);
  air[i] = vec4f(S.wind.z * capacity(t), 0.0, t, 0.0);
  climate[i] = vec4f(0.0, S.wind.z, 1.0, t);
`)

// Atmosphere: vapour and air temperature are carried by the wind (semi-Lagrangian),
// water surfaces and plants put vapour back, and air that cools below its capacity
// (mostly by being pushed up a mountain) rains it out; showers and storms come from the
// upper layer (see upperShader). Air coming down the far side
// warms up and holds its vapour, so the lee of a range stays dry (rain shadow).
// Also computes each cell's temperature and its long-run precipitation (for biomes).
// The atmosphere changes slowly, so it may run only every S.climateDt steps (multirate):
// its rates are scaled to cover that many steps, and the precipitation it leaves in
// air.y is per step, so the water cycle keeps applying it on the steps in between.
// Water vapour makes air lighter (see airAnomaly): its buoyancy as a temperature.
const virtualTemperature = /* wgsl */ `
// °C of buoyancy per unit of vapour (1 = saturated at 15 °C, q ≈ 0.011)
const VIRTUAL = 1.9;
`
export const airShader = header + /* wgsl */ `
@group(0) @binding(1) var<storage, read> ground: array<vec4f>;
@group(0) @binding(2) var<storage, read> water: array<vec4f>;
@group(0) @binding(3) var<storage, read> extra: array<vec4f>;
@group(0) @binding(4) var<storage, read> airIn: array<vec4f>;
@group(0) @binding(5) var<storage, read_write> airOut: array<vec4f>;
@group(0) @binding(6) var<storage, read_write> climate: array<vec4f>;
@group(0) @binding(7) var<storage, read> wind: array<vec4f>;
@group(0) @binding(8) var<storage, read> shadow: array<vec4f>;

// share of the rain from showers, storms and fronts that evaporates as it falls
const RAIN_EVAPORATION = 0.3;
// share of the vapour above capacity that rains out per step where the wind drives the
// air straight up a slope (on top of the 1 % anywhere)
// share of the vapour above capacity that condenses and rains out per step anywhere
// (supersaturated air does not stay that way: at 1 % it crossed a ridge still above
// capacity and rained on the lee)
const CONDENSATION = 0.15;
const OROGRAPHIC_RAIN = 0.2;
// °C of latent heat per unit of vapour (as LATENT in upperModel)
const LATENT_HEAT = 27.0;
// Share of the difference to the ground's temperature the air takes on per step. At
// night and over the sea the air hardly touches the ground: an air mass keeps its own
// temperature for days (a day is dayLength minutes, 14 400 steps at the default), so cold
// and warm air masses travel across the map and meet in fronts. By day the sun heats the
// land and the warm ground stirs the air above it (convective mixing), which takes the
// ground's temperature, plus the sun's warmth, within a few hundred steps.
const AIR_COUPLING = 0.0005;
const DAY_COUPLING = 0.006;
// °C warmer than the climate's ground temperature the air over bare land gets at noon
const SUN_WARMTH = 6.0;
// °C per step a clear night cools the air over land
const NIGHT_COOLING = 0.0006;
// share each neighbour gets of the air carried in per step (on top of what the
// interpolation smooths; applied per step covered, so the multirate changes nothing)
const AIR_DIFFUSION = 0.05;
// A fixed air-mass source (painted with the air-mass brush, fixed) keeps the air over it
// this many °C off the ground's temperature at full strength, taking this share of the
// difference per step: much more than the ground does, so the mass is there whatever the
// sun does, and the wind carries it off downwind as a lasting cold or warm air mass.
const AIR_SOURCE_TEMP = 15.0;
const SOURCE_COUPLING = 0.04;
// An ocean current (the current brush paints a temperature offset on the sea): the air
// over it takes the sea's temperature this fast, a warm current warming and wetting it,
// a cold one cooling and drying it.
const CURRENT_COUPLING = 0.01;
// The sea moves: the water under the wind drifts at this share of the wind's speed and
// carries its warmth along, so the sea off a warm coast arrives warmer further on (a warm
// current) and a cold sea cools the coast downwind; the current brush's anomaly travels
// the same way. The anomaly fades as the air takes the heat.
const CURRENT_SPEED = 0.03;
const CURRENT_FADE = 0.0002;
` + bilinear('sampleAir', 'airIn') + bilinear('sampleWind', 'wind', 'S.flowSize') + bilinear('sampleClimate', 'climate') + /* wgsl */ `
// Air temperature brought to sea level (potential temperature): air is colder up a
// mountain just for being higher, which is no front and no stability; comparing this
// leaves only the differences between air masses.
fn heightAt(uv: vec2f) -> f32 {
  let p = clamp(vec2i(uv * f32(S.size)), vec2i(0), vec2i(i32(S.size) - 1));
  let j = ix(p.x, p.y);
  return ground[j].x + water[j].x;
}
` + gridMain(/* wgsl */ `
  let uv = uvOf(x, y);
  let D = S.climateDt;
  let depth = water[i].x;
  let local = sampleWind(uv);
  let surface = ground[i].x + depth;
  var c = climate[i];
  // under a strike's dust cloud the ground sits in shade and cools
  let dust = dustAt(uv);
  let tGround = groundTemp(surface, uv.y, c.x) - dust;

  // advect from upwind, with a little diffusion so the field stays smooth
  let back = uv - local.xy * D / f32(S.flowSize);
  let d = 1.0 / f32(S.size);
  let backC = clamp(back, vec2f(0.0), vec2f(1.0));
  let spread = min(AIR_DIFFUSION * D, 0.2);
  var a = sampleAir(backC) * (1.0 - 4.0 * spread) + (
    sampleAir(clamp(back + vec2f(d, 0.0), vec2f(0.0), vec2f(1.0))) +
    sampleAir(clamp(back - vec2f(d, 0.0), vec2f(0.0), vec2f(1.0))) +
    sampleAir(clamp(back + vec2f(0.0, d), vec2f(0.0), vec2f(1.0))) +
    sampleAir(clamp(back - vec2f(0.0, d), vec2f(0.0), vec2f(1.0)))
  ) * spread;
  // what the air keeps as it moves is its potential temperature: carried up a slope it
  // cools, down one it warms
  a.z += S.climate2.y * (heightAt(backC) - surface);
  // fresh air blows in across the upwind border: the air mass of the moment
  // (with the vapour the usual air brings, so the masses change the weather, not the
  // rainfall: a cold mass is closer to saturation, a warm one drier)
  if (any(back != backC)) {
    let mass = tGround + inflowAnomaly(uv);
    a.x = min(S.wind.z * capacity(tGround), capacity(mass));
    a.z = mass;
  }
  // the painted humidity is kept, but only acts in manual climate; the fixed source acts always
  let rawW = airIn[i].w;
  let painted = airHumidityOf(rawW) * (1.0 - S.world.z);
  let source = airSourceOf(rawW);

  // the sun heats the ground by day (land much more than water, snow hardly at all,
  // slopes facing the sun most); clear nights cool it down
  let n = normalize(vec3f(
    -(ground[ix(x + 1, y)].x - ground[ix(x - 1, y)].x) * cellsPerUnit() * 0.5, 1.0,
    (ground[ix(x, y + 1)].x - ground[ix(x, y - 1)].x) * cellsPerUnit() * 0.5));
  let sea = smoothstep(0.0002, 0.002, depth);
  let e = extra[i];
  let absorbs = (1.0 - 0.8 * sea) * (1.0 - 0.6 * smoothstep(0.0, 0.001, e.z + e.w));
  // clouds (air close to saturation, as drawn) keep most of the sunshine off the ground
  let overcast = smoothstep(0.8, 1.05, c.y);
  let sun = S.sky.z * max(dot(n, S.lightDir.xyz), 0.0) * shadow[i].x * (1.0 - 0.7 * overcast) * (1.0 - 0.9 * clamp(dust / 8.0, 0.0, 1.0));
  // the air takes the ground's temperature (see AIR_COUPLING)
  let heated = sun * absorbs;
  a.z = mix(a.z, tGround + SUN_WARMTH * heated, 1.0 - pow(1.0 - AIR_COUPLING - DAY_COUPLING * heated, D));
  a.z -= NIGHT_COOLING * (1.0 - S.sky.z) * (1.0 - 0.7 * clamp(c.y, 0.0, 1.0)) * (1.0 - 0.8 * sea) * D;
  // a fixed air mass painted here: the air is held so many °C off the ground's temperature
  if (source != 0.0) {
    a.z = mix(a.z, tGround + AIR_SOURCE_TEMP * source, 1.0 - pow(1.0 - SOURCE_COUPLING, D));
  }
  // the sea surface drifts with the wind and carries its temperature anomaly along (c.x on
  // the sea): what arrives from upwind, plus how much warmer the climate was where it came
  // from, fading slowly
  if (sea > 0.5) {
    let src = clamp(uv - local.xy * CURRENT_SPEED * D / f32(S.flowSize), vec2f(0.0), vec2f(1.0));
    let fp = clamp(vec2i(src * f32(S.size)), vec2i(0), vec2i(i32(S.size) - 1));
    let fj = ix(fp.x, fp.y);
    if (water[fj].x > 0.002) {
      let carried = sampleClimate(src).x + groundTemp(ground[fj].x + water[fj].x, src.y, 0.0) - groundTemp(surface, uv.y, 0.0);
      c.x = clamp(carried * (1.0 - CURRENT_FADE * D), -20.0, 20.0);
    }
  }
  // an ocean current painted here (in automatic climate too, where the ground's
  // temperature ignores the painted offset: it is added back for the sea)
  let current = c.x * sea;
  if (current != 0.0) {
    let sst = tGround + c.x * S.world.z;
    a.z = mix(a.z, sst, 1.0 - pow(1.0 - CURRENT_COUPLING * smoothstep(0.0, 3.0, abs(current)), D));
  }
  let t = mix(tGround, a.z, 0.35);
  // air rises in lows (cools, clouds, rain) and sinks in highs (dry, clear); under a fixed
  // high (the drought power) it sinks hard: it holds much more vapour and nothing rains
  let high = highAt(uv);
  let cap = capacity(t) * clamp(1.0 + 0.25 * local.w, 0.6, 1.4) * (1.0 + 0.6 * high);
  // (the sinking air brings dry air down with it: the air under the high dries out instead
  // of carrying its vapour off to rain somewhere else)
  a.x = mix(a.x, min(a.x, 0.45 * capacity(t)), 1.0 - pow(1.0 - 0.01 * high, D));

  // sources: open water (the sea most of all) and the humidity brush; what plants
  // transpire is taken from the ground's water in the water cycle pass
  let wet = sea * (1.0 - frozen(t));
  a.x = mix(a.x, 0.95 * cap, 1.0 - pow(1.0 - 0.02 * wet, D));
  a.x = max(a.x + 0.01 * painted * cap * D, 0.0);
  // a cold source keeps no more vapour than its air can hold (fog, not rain, as the brush)
  if (source < 0.0) { a.x = min(a.x, cap); }


  // Where the wind drives the air up a mountain, the latent heat of its rain stays in it
  // and it comes down the lee warmer (foehn). Elsewhere (storms, fronts) the rain partly
  // evaporates as it falls and drags cold air down (downdraft): the air near the ground
  // cools into a cold pool of high pressure that spreads out and pushes the warm air
  // ahead of it (the gust front before a storm)
  let e2 = 2.0 / f32(S.size);
  let terrain = vec2f(
    ground[ix(x + 2, y)].x - ground[ix(x - 2, y)].x,
    ground[ix(x, y + 2)].x - ground[ix(x, y - 2)].x) / (2.0 * e2 * extent());
  // how fast the wind pushes the air up the terrain (a calm breeze lifts nothing)
  let upslope = dot(local.xy, terrain);
  let orographic = smoothstep(0.01, 0.06, upslope);
  // condensation of anything above capacity: slow in still air, but air driven up a
  // slope wrings out most of its excess on the way (OROGRAPHIC_RAIN), so a range is a
  // barrier the moisture does not cross; showers, storms and fronts come from the upper
  // layer (see upperShader), which left the rain it made over this cell in air.y
  let p = min(max(a.x - cap, 0.0) * min(CONDENSATION * D + OROGRAPHIC_RAIN * orographic * D, 1.0), a.x) * (1.0 - 0.95 * high);
  let storms = airIn[i].y * (1.0 - 0.95 * high);
  a.x -= p;
  // (evaporation can cool the air only down to its wet-bulb temperature: by about a third
  // of the way to the dew point; the water it takes goes back into the air)
  let wetBulb = log(max(a.x, 0.0001) / capacity(a.z)) / 0.065 / 3.0;
  let evaporated = clamp(-wetBulb / LATENT_HEAT, 0.0, RAIN_EVAPORATION * ((1.0 - orographic) * p + storms));
  a.z += p * orographic * 6.0 - evaporated * LATENT_HEAT;
  a.x += evaporated;
  a.y = (p + storms - evaporated) / D;
  a.w = rawW;
  airOut[i] = a;

  let rainRel = a.y * rainWater() * S.rain / 0.00000005;
  c.y = a.x / cap;
  c.z = mix(c.z, rainRel, 1.0 - pow(1.0 - 0.0005, D));
  c.w = t;
  climate[i] = c;
`)

// Wind field: a tiny 2D fluid solver at a quarter of the resolution. Each step the
// wind relaxes towards the prevailing wind plus the wind circling the weather
// systems, loses the part that would run up steep slopes, and is then made
// (approximately) divergence-free with a couple of Jacobi pressure iterations,
// warm-started from the last step. The result flows around mountains, funnels and
// speeds up through gaps and calms down in their lee. Pressure is 0 outside the
// map, so air can blow in and out across the borders.
//
// Weather (wind.w): a pressure anomaly that comes out of the simulation itself.
// Air warmer than its surroundings (sunny land, lava, the latent heat of rain)
// lowers it; cooler air (the sea by day, land at night) raises it. It is carried
// by the wind, spreads out and slowly fades, so lows and highs form, drift and
// die away instead of appearing at random. The wind circles lows anticlockwise,
// as in the northern hemisphere, and leaks into them (sea and valley breezes);
// that inflow is added after the projection, which would otherwise cancel it.
//
// Prevailing wind: the slider's in manual climate; in automatic climate it comes
// from the latitude belts: trade winds blowing west in the hot south, westerlies
// in the middle latitudes, polar easterlies in the cold north.
const windMain = (body: string) => /* wgsl */ `
fn wix(x: i32, y: i32) -> u32 { return ixn(x, y, i32(S.flowSize)); }
fn inside(x: i32, y: i32) -> bool { let n = i32(S.flowSize); return x >= 0 && y >= 0 && x < n && y < n; }

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= S.flowSize || id.y >= S.flowSize) { return; }
  let x = i32(id.x);
  let y = i32(id.y);
  let i = wix(x, y);
  ${body}
}
`

// How much lighter the air over a wind cell is than it would be at its ground's own
// temperature, as a temperature (virtual temperature): warmth, and also water vapour,
// whose molecules (18) are lighter than the nitrogen and oxygen (28, 32) they replace,
// about 0.61·q·T, so humid air is buoyant too and helps lows form.
const airAnomaly = virtualTemperature + /* wgsl */ `
fn anomaly(x: i32, y: i32) -> f32 {
  let n = i32(S.flowSize);
  let cx = clamp(x, 0, n - 1) * 4 + 2;
  let cy = clamp(y, 0, n - 1) * 4 + 2;
  let j = ix(cx, cy);
  let v = (f32(cy) + 0.5) / f32(S.size);
  return air[j].z + VIRTUAL * air[j].x - groundTemp(ground[j].x + water[j].x, v, climate[j].x);
}
`

// Prevailing wind (uv per step): the slider's in manual climate; in automatic climate
// that of the latitude belts (world v: −1 tropics … 2 polar).
const planetaryWind = /* wgsl */ `
fn planetary(uv: vec2f) -> vec2f {
  let lat = clamp(worldUV(uv).y, -1.0, 2.0);
  let trades = 1.0 - smoothstep(-0.3, 0.2, lat);
  let polar = smoothstep(1.2, 1.6, lat);
  let westerlies = 1.0 - trades - polar;
  return (vec2f(-1.0, -0.3) * trades + vec2f(1.0, 0.25) * westerlies + vec2f(-1.0, -0.25) * polar) * length(S.wind.xy);
}
fn prevailing(uv: vec2f) -> vec2f { return select(S.wind.xy, planetary(uv), S.world.z > 0.5); }
`

export const windForceShader = header + /* wgsl */ `
@group(0) @binding(1) var<storage, read> ground: array<vec4f>;
@group(0) @binding(2) var<storage, read> windIn: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> windOut: array<vec4f>;
@group(0) @binding(4) var<storage, read> water: array<vec4f>;
@group(0) @binding(5) var<storage, read> air: array<vec4f>;
@group(0) @binding(6) var<storage, read> climate: array<vec4f>;
` + bilinear('sampleGround', 'ground') + bilinear('sampleWindIn', 'windIn', 'S.flowSize') + airAnomaly + planetaryWind + /* wgsl */ `
fn weatherAt(x: i32, y: i32) -> f32 { return windIn[wix(x, y)].w; }
// world units: the distance the heating is compared over (see below)
const LOW_SCALE = 0.25;
// pressure per step per °C of heating difference
const LOW_FORCING = 0.0015;
` + windMain(/* wgsl */ `
  let F = f32(S.flowSize);
  let uv = (vec2f(f32(x), f32(y)) + 0.5) / F;
  var v = windIn[i];

  let base = prevailing(uv);

  // weather: carried by the prevailing wind, spreading, fed by heating differences, fading.
  // Not by the local wind: that includes the air each low draws in and spins around
  // itself, and carrying the pressure with it filled every low from outside in seconds.
  var P = 0.0;
  if (S.sky.y > 0.0) {
    // (systems drift at about half the speed of the wind that steers them)
    let back = (vec2f(f32(x), f32(y)) + 0.5) / F - base * 0.5;
    let around = (weatherAt(x + 1, y) + weatherAt(x - 1, y) + weatherAt(x, y + 1) + weatherAt(x, y - 1)) * 0.25;
    // (gentle spreading and slow fading, so a system lives long enough to grow and drift:
    // half-life about 12 s)
    P = mix(sampleWindIn(back).w, around, 0.05);
    // heating relative to the surroundings LOW_SCALE world units away (the size of a
    // thermal low: a warm continent against the sea around it), so there are highs as well
    let r = max(8, i32(round(LOW_SCALE * F / extent())));
    let surroundings = (anomaly(x + r, y) + anomaly(x - r, y) + anomaly(x, y + r) + anomaly(x, y - r)) * 0.25;
    // Pressure is relative to the window's mean: the heating forcing is not exactly balanced
    // (the borders, the sea), and left alone it lifts the whole field until there are no
    // lows anywhere, so the measured mean is slowly taken out again.
    P = clamp(P * 0.999 - LOW_FORCING * (anomaly(x, y) - surroundings) * S.sky.y - S.level.w * 0.003, -2.0, 2.0);
  } else {
    // weather systems off: only what the pressure brush painted, slowly fading
    P = v.w * 0.995;
  }
  // Pressure brush: paints a high (fair weather) or a low (clouds, rain, wind circling it).
  // Weather systems are broad and flat, so it pulls a plateau towards a target level
  // (0.75 per unit of strength) instead of piling up a cone, which spreading would
  // flatten again within seconds.
  if (S.brushActive > 0.5 && S.level.z != 0.0) {
    let d = distance(uv, S.brushUV) / S.brushRadius;
    let cover = 1.0 - smoothstep(0.55, 1.0, d);
    P = mix(P, clamp(S.level.z * 0.75, -2.0, 2.0), cover * 0.08);
  }
  // Storms (the storm tool): deep lows held open at full depth while they live, drifting
  // with the wind; the wind circles them, the air rises in them and rains out.
  for (var k = 0; k < ${MAX_STORMS}; k++) {
    let st = S.storms[k];
    if (st.z <= 0.0) { continue; }
    let sd = distance(uv, st.xy) / st.w;
    let scover = 1.0 - smoothstep(0.5, 1.0, sd);
    P = mix(P, -2.0 * st.z, scover * 0.1);
  }
  // Fixed highs (the drought power): held at full height where they were set
  for (var k = 0; k < ${MAX_HIGHS}; k++) {
    let hg = S.highs[k];
    if (hg.z <= 0.0) { continue; }
    let hd = distance(uv, hg.xy) / hg.w;
    let hcover = 1.0 - smoothstep(0.5, 1.0, hd);
    P = mix(P, 2.0 * hg.z, hcover * 0.1);
  }

  let gradP = 0.5 * vec2f(weatherAt(x + 1, y) - weatherAt(x - 1, y), weatherAt(x, y + 1) - weatherAt(x, y - 1)) * F;
  let goal = (base + vec2f(-gradP.y, gradP.x) * 0.00015) * F;
  v = vec4f(mix(v.xy, goal, 0.02), v.z, P);
  // large-scale slope, measured two low-res cells apart (in height per terrain unit)
  let d = 2.0 / F;
  let grad = vec2f(
    sampleGround(uv + vec2f(d, 0.0)).x - sampleGround(uv - vec2f(d, 0.0)).x,
    sampleGround(uv + vec2f(0.0, d)).x - sampleGround(uv - vec2f(0.0, d)).x) / (2.0 * d * extent());
  let slope = length(grad);
  if (slope > 0.00001) {
    let n = grad / slope;
    let up = dot(v.xy, n);
    if (up > 0.0) { v = vec4f(v.xy - n * up * smoothstep(0.1, 0.6, slope), v.zw); }
  }
  windOut[i] = v;
`)

export const windPressureShader = header + /* wgsl */ `
@group(0) @binding(1) var<storage, read> windIn: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> windOut: array<vec4f>;

fn pressure(x: i32, y: i32) -> f32 { return select(0.0, windIn[wix(x, y)].z, inside(x, y)); }
` + windMain(/* wgsl */ `
  let v = windIn[i];
  let div = 0.5 * (windIn[wix(x + 1, y)].x - windIn[wix(x - 1, y)].x + windIn[wix(x, y + 1)].y - windIn[wix(x, y - 1)].y);
  let p = (pressure(x + 1, y) + pressure(x - 1, y) + pressure(x, y + 1) + pressure(x, y - 1) - div) * 0.25;
  windOut[i] = vec4f(v.xy, p, v.w);
`)

// Air masses are told apart over this scale (world units, in wind cells at least one):
// the air's temperature is patchy at the scale of single storms, and a cold air mass
// spreads out or advances as a whole, not cell by cell.
const airMassScale = /* wgsl */ `
const AIR_MASS_SCALE = 0.03;
fn airMassCells() -> i32 { return max(1, i32(round(AIR_MASS_SCALE * f32(S.flowSize) / extent()))); }
`

// The low-level wind's divergent part (wind cells per step at wind cell x, y), added
// after the projection, which would otherwise cancel it. Needs weatherAt.
// - air leaking from highs into lows (where it converges it rises, see upperShader)
const lowLevelLeak = /* wgsl */ `
fn leak(x: i32, y: i32) -> vec2f {
  let F = f32(S.flowSize);
  let gradP = 0.5 * vec2f(weatherAt(x + 1, y) - weatherAt(x - 1, y), weatherAt(x, y + 1) - weatherAt(x, y - 1));
  return -0.0001 * gradP * F * F;
}
`
// - cold air, heavier than the air around it, spreading out under it (a density current:
//   the gust front of a storm's cold pool, the leading edge of a cold air mass), from the
//   air masses the upper pass keeps in upper.w. Needs airMassScale and an upper buffer.
const densityFlow = /* wgsl */ `
// world units per step for 1 °C per world unit of difference
const DENSITY_CURRENT = 0.000001;
fn airMass(x: i32, y: i32) -> f32 { return upper[ixn(x, y, i32(S.flowSize))].w; }
fn densityCurrent(x: i32, y: i32) -> vec2f {
  let F = f32(S.flowSize);
  let r = airMassCells();
  let e = airMass(x + r, y);
  let w = airMass(x - r, y);
  let n = airMass(x, y + r);
  let s = airMass(x, y - r);
  // (none until the upper pass has measured them)
  if (e == 0.0 || w == 0.0 || n == 0.0 || s == 0.0) { return vec2f(0.0); }
  // (°C per wind cell → per world unit, world units → wind cells per step)
  return DENSITY_CURRENT * vec2f(e - w, n - s) / f32(2 * r) * F * F / (extent() * extent());
}
`

export const windProjectShader = header + /* wgsl */ `
@group(0) @binding(1) var<storage, read> windIn: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> windOut: array<vec4f>;
@group(0) @binding(3) var<storage, read> upper: array<vec4f>;

fn pressure(x: i32, y: i32) -> f32 { return select(0.0, windIn[wix(x, y)].z, inside(x, y)); }
fn weatherAt(x: i32, y: i32) -> f32 { return windIn[wix(x, y)].w; }
` + airMassScale + lowLevelLeak + densityFlow + windMain(/* wgsl */ `
  let v = windIn[i];
  let g = 0.5 * vec2f(pressure(x + 1, y) - pressure(x - 1, y), pressure(x, y + 1) - pressure(x, y - 1));
  windOut[i] = vec4f(v.xy - g + leak(x, y) + densityCurrent(x, y), v.z, v.w);
`)

// Upper atmosphere: a second layer of air high above the ground (about 5 km), on the
// wind grid. The air buffer is the layer near the ground; this one has its own
// temperature and vapour, and its own wind: steered by the prevailing wind and the
// weather systems but not blocked by the terrain, plus the thermal wind (it blows along
// the temperature differences, with the cold air on its left, like the jet stream).
// The two layers trade air:
// - convection: air near the ground that, lifted, would end up warmer than the upper air
//   (warm, and above all humid: its vapour condenses on the way and gives off its latent
//   heat) rises in storms; the vapour the upper air can't hold rains out, the latent heat
//   warms the upper air until it is no longer unstable, and upper air comes down in its
//   place. Cold air arriving aloft (or warm humid air below) sets off storms; warm air
//   aloft (an inversion) caps them.
// - broad vertical motion: where the low-level wind converges into lows the air rises into
//   the upper layer and its vapour rains out; where it flows out of highs upper air sinks,
//   warming as it comes down and drying the air below (clear skies under highs).
// - fronts: an advancing cold air mass lifts the air ahead of it (see below).
// - the upper air condenses on its own when it is carried to colder places (rain ahead of
//   a warm front, from the clouds it slides up into).
// upper: x vapour (same units as the air's), y potential temperature above the
// latitude's reference (upperReference; 0 = a standard atmosphere), z vertical motion
// (share of the low-level air lifted per step, < 0 sinking), w the low-level air's
// potential temperature, to tell how fast it changes (see coolingAt).
// It also writes, in air.y of the cells under it, the rain it makes over the step; the
// air pass adds it to its own and cools the air under it (see airShader).
const upperModel = /* wgsl */ `
// °C the upper layer is colder than sea-level air of the same potential temperature
const UPPER_COOLING = 30.0;
// height units (≈ 5 km at the default lapse rate): mountain tops reach the upper layer
const UPPER_HEIGHT = 0.2;
// °C a dry parcel ends up colder than the upper air in a standard atmosphere (it cools at
// the dry rate, faster than the air around it)
const DRY_STABILITY = 16.0;
// °C of latent heat per unit of vapour that condenses (L·q/cp, 1 unit ≈ 11 g/kg)
const LATENT = 27.0;
// share of the low-level air that convection overturns per step, per √°C of instability
// (updrafts are as fast as the square root of the energy the instability frees)
const CONVECTION = 0.00045;
// share of the air converging into lows that rises into the upper layer (most of that
// broad inflow is a shallow circulation near the ground)
const LIFT = 0.3;
// °C across a front: the low-level air lifted per °C the advancing cold air cools a place
const FRONT_CONTRAST = 4.0;
// °C per step of advection below which there is no front
const FRONT_MIN = 0.01;
// warm fronts lift that much less (a gentler ramp)
const WARM_FRONT = 0.5;
// mass of the low-level air over that of the upper layer
const LOWER_MASS = 0.5;
// share of its difference to the reference the upper air loses per step (radiation)
const RADIATE = 0.0005;
// upper-wind speed (world units per step) per °C per world unit of the mean temperature
const THERMAL_WIND = 0.0001;
fn upperReference(v: f32) -> f32 { return groundTemp(0.0, v, 0.0); }
`
export const upperShader = header + upperModel + /* wgsl */ `
@group(0) @binding(1) var<storage, read> ground: array<vec4f>;
@group(0) @binding(2) var<storage, read> water: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> lowAir: array<vec4f>;
@group(0) @binding(4) var<storage, read> upperIn: array<vec4f>;
@group(0) @binding(5) var<storage, read_write> upperOut: array<vec4f>;
@group(0) @binding(6) var<storage, read> wind: array<vec4f>;
// (the last air pass's output: neighbours read from here, not from lowAir, which other
// invocations are changing)
@group(0) @binding(7) var<storage, read> air: array<vec4f>;
// w: the air-mass map for the Fronts overlay (see below); the rest is the shadow pass's
@group(0) @binding(8) var<storage, read_write> shadow: array<vec4f>;
` + bilinear('sampleUpper', 'upperIn', 'S.flowSize') + planetaryWind + airMassScale + /* wgsl */ `
fn weatherAt(x: i32, y: i32) -> f32 { return wind[ixn(x, y, i32(S.flowSize))].w; }
` + lowLevelLeak + /* wgsl */ `
// potential temperature of the low-level air over wind cell (x, y) above what the ground
// at its latitude would give it (so the air flowing across the latitudes is no front),
// and over the scale of an air mass around it
fn lowTheta(x: i32, y: i32) -> f32 {
  let n = i32(S.flowSize);
  let cx = clamp(x, 0, n - 1) * 4;
  let cy = clamp(y, 0, n - 1) * 4;
  var t = 0.0;
  for (var k = 0; k < 4; k++) {
    let j = ix(cx + 1 + 2 * (k % 2), cy + 1 + 2 * (k / 2));
    t += air[j].z + S.climate2.y * (ground[j].x + water[j].x);
  }
  return t * 0.25 - upperReference((f32(cy) + 2.0) / f32(S.size));
}
fn massTheta(x: i32, y: i32) -> f32 {
  let k = max(airMassCells() / 4, 1);
  return (lowTheta(x, y) * 2.0 + lowTheta(x + k, y) + lowTheta(x - k, y) + lowTheta(x, y + k) + lowTheta(x, y - k)) / 6.0;
}
// massTheta as of the last run: upper.w keeps it + 100 (0: not yet known)
fn lastTheta(x: i32, y: i32) -> f32 { return upperIn[ixn(x, y, i32(S.flowSize))].w; }
// how fast the low-level wind cools wind cell (x, y), bringing colder air (°C per step;
// < 0 warmer air), from the last run's air masses (a run old, much cheaper)
fn advectionAt(x: i32, y: i32) -> f32 {
  let r = airMassCells();
  let e = lastTheta(x + r, y);
  let w = lastTheta(x - r, y);
  let n = lastTheta(x, y + r);
  let s = lastTheta(x, y - r);
  if (e == 0.0 || w == 0.0 || n == 0.0 || s == 0.0) { return 0.0; }
  return dot(wind[ixn(x, y, i32(S.flowSize))].xy, vec2f(e - w, n - s) / f32(2 * r));
}
// how fast wind cell (x, y) has actually cooled since the last run (°C per step; < 0
// warmed), given its massTheta now
fn coolingAt(x: i32, y: i32, now: f32) -> f32 {
  let last = lastTheta(x, y);
  return select(0.0, (last - 100.0 - now) / S.climateDt, last != 0.0);
}
// potential temperature of the whole column (both layers) over wind cell (x, y)
fn columnTheta(x: i32, y: i32) -> f32 {
  let n = i32(S.flowSize);
  let cx = clamp(x, 0, n - 1);
  let cy = clamp(y, 0, n - 1);
  let j = ix(cx * 4 + 2, cy * 4 + 2);
  let v = (f32(cy) + 0.5) / f32(n);
  let low = air[j].z + S.climate2.y * (ground[j].x + water[j].x);
  return 0.5 * (low + upperIn[ixn(cx, cy, n)].y + upperReference(v));
}
` + windMain(/* wgsl */ `
  let F = f32(S.flowSize);
  let D = S.climateDt;
  let uv = (vec2f(f32(x), f32(y)) + 0.5) / F;
  let reference = upperReference(uv.y);

  // the upper wind (uv per step), and the air it brings
  let gradP = 0.5 * vec2f(weatherAt(x + 1, y) - weatherAt(x - 1, y), weatherAt(x, y + 1) - weatherAt(x, y - 1)) * F;
  let gradT = vec2f(columnTheta(x + 2, y) - columnTheta(x - 2, y), columnTheta(x, y + 2) - columnTheta(x, y - 2)) * F * 0.25;
  let thermal = THERMAL_WIND * vec2f(-gradT.y, gradT.x) / (extent() * extent());
  let flow = prevailing(uv) + vec2f(-gradP.y, gradP.x) * 0.00015 + thermal;
  let back = uv - flow * D;
  let backC = clamp(back, vec2f(0.0), vec2f(1.0));
  var u = sampleUpper(backC);
  // (potential temperature is what the air keeps as it moves; the field is relative to
  // the latitude's reference)
  u.y += upperReference(backC.y) - reference;
  // fresh air across the upwind border: the air mass of the moment, half saturated
  if (any(back != backC)) {
    let mass = inflowAnomaly(uv);
    u = vec4f(min(0.5 * S.wind.z * capacity(reference - UPPER_COOLING), capacity(reference + mass - UPPER_COOLING)), mass, 0.0, 0.0);
  }
  // radiation pulls it back towards the standard atmosphere
  u.y *= pow(1.0 - RADIATE, D);

  // air carried somewhere colder than it can hold its vapour at: it condenses (clouds,
  // steady rain) and gives off its latent heat
  let thetaUp0 = reference + u.y;
  let condensed = max(u.x - capacity(thetaUp0 - UPPER_COOLING), 0.0) * min(0.05 * D, 1.0);
  u.x -= condensed;
  u.y += LATENT * condensed;
  let thetaUp = reference + u.y;
  let capUp = capacity(thetaUp - UPPER_COOLING);
  // (in units of the low-level air's vapour, per cell under it)
  let steady = condensed / LOWER_MASS;

  // broad vertical motion: the convergence of the low-level wind (of its divergent part:
  // what the projection leaves is numerical, not air piling up)
  let leaking = 0.5 * (leak(x + 1, y).x - leak(x - 1, y).x + leak(x, y + 1).y - leak(x, y - 1).y);
  // Fronts: where the wind drives cold air into warmer air, the cold air digs in under the
  // warm air like a wedge and lifts it: the warm, humid air just ahead of the front (the
  // front a little upwind lifts the air here). As much of the low-level air is lifted as
  // the cold air cools the place, over the contrast across the front (when the cold air
  // has come, the warm air is all above it). Warm air advancing glides up over the cold
  // air on a gentler ramp. The air's temperature is carried by the wind, so fronts travel
  // with it.
  let speed = length(wind[i].xy);
  let behind = vec2i(round(-select(vec2f(0.0), wind[i].xy / speed, speed > 1e-6) * f32(max(airMassCells() / 2, 1))));
  // (only where the air really is changing: the wind blowing steadily across a contrast
  // that stays put, say from a snowfield onto a sunny slope, is no front)
  let here = massTheta(x, y);
  let bx = x + behind.x;
  let by = y + behind.y;
  let cold = min(advectionAt(bx, by), coolingAt(bx, by, massTheta(bx, by)));
  let warm = min(-advectionAt(x, y), -coolingAt(x, y, here));
  // (weak advection, the air drifting over gentle differences, lifts nothing)
  let frontal = (max(cold - FRONT_MIN, 0.0) + WARM_FRONT * max(warm - FRONT_MIN, 0.0)) / FRONT_CONTRAST;
  let lifted = min(frontal * D, 0.3);
  let broad = clamp(-leaking * LIFT * D, -0.2, 0.2);
  let ascent = lifted + broad;
  let rising = max(broad, 0.0);
  let sinking = max(-ascent, 0.0);

  var gainT = 0.0;
  var gainQ = 0.0;
  for (var dy = 0; dy < 4; dy++) {
    for (var dx = 0; dx < 4; dx++) {
      let j = ix(x * 4 + dx, y * 4 + dy);
      var a = lowAir[j];
      let h = ground[j].x + water[j].x;
      let thetaLow = a.z + S.climate2.y * h;
      // a parcel of this air lifted to the upper layer (mountain tops are already there)
      let rise = clamp(1.0 - h / UPPER_HEIGHT, 0.0, 1.0);
      let excess = max(a.x - capUp, 0.0);
      let parcel = thetaLow - DRY_STABILITY * rise + LATENT * excess;
      let buoyancy = parcel - thetaUp;
      let convect = min(CONVECTION * sqrt(max(buoyancy, 0.0)) * D, 0.3);
      // the broad rising air only makes it to the upper layer if, once there, it is about
      // as warm as the air around it (stable air lifted falls back as it was); a front lifts
      // the air whatever its stability
      let up = convect + lifted + rising * smoothstep(-0.5 * DRY_STABILITY, 0.0, buoyancy);
      // up: the lifted air, with what vapour the upper air can hold; the rest rains out
      gainT += up * (parcel - thetaUp);
      gainQ += up * (min(a.x, capUp) - u.x);
      // down: upper air in its place, dry. The broad sinking warms as it comes down; a
      // storm's downdrafts are cooled by the rain evaporating into them instead (see airShader)
      a.x += (convect + sinking) * (u.x - a.x);
      a.z += sinking * (thetaUp + DRY_STABILITY * rise - thetaLow);
      a.y = up * excess + steady;
      lowAir[j] = a;
      // the overlay: air-mass temperature (0.01 °C steps, ±25) in the integer part, the
      // vertical motion (±0.02 per step) in the fraction, and a fixed air-mass source
      // painted here as 10 000 (cold) or 20 000 (warm) on top
      let fixedSource = airSourceOf(a.w);
      let fixedMark = select(0.0, select(10000.0, 20000.0, fixedSource > 0.0), abs(fixedSource) >= 0.05);
      shadow[j].w = fixedMark + floor(clamp(here, -25.0, 25.0) * 100.0) + 2500.0 + 0.5 + clamp(ascent / D * 25.0, -0.49, 0.49);
    }
  }
  u.y += LOWER_MASS * gainT / 16.0;
  u.x = max(u.x + LOWER_MASS * gainQ / 16.0, 0.0);
  upperOut[i] = vec4f(u.x, u.y, ascent / D, here + 100.0);
`)

// Sparse simulation: most of a map is dry and has no lava, and there the water flow,
// the transport part of erosion and the lava flow all compute exactly nothing. Each
// step first marks the ACTIVITY_TILE² tiles that hold any water, flux or lava
// (bit 0: water, bit 1: lava), then grows the marks by one tile so every neighbour
// those passes read is covered; the passes skip their work on unmarked tiles.
// Water below WATER_EPS (far less than one step of rain) counts as dry.
export const ACTIVITY_TILE = 16
const activityTiles = /* wgsl */ `
const ACTIVITY_TILE = ${ACTIVITY_TILE}u;
fn tilesPerRow() -> u32 { return (S.size + ACTIVITY_TILE - 1u) / ACTIVITY_TILE; }
fn tileOf(x: i32, y: i32) -> u32 { return (u32(y) / ACTIVITY_TILE) * tilesPerRow() + u32(x) / ACTIVITY_TILE; }
`
export const activityShader = header + activityTiles + /* wgsl */ `
@group(0) @binding(1) var<storage, read> water: array<vec4f>;
@group(0) @binding(2) var<storage, read> lava: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> tiles: array<u32>;
@group(0) @binding(4) var<storage, read> fine: array<f32>;

const WATER_EPS = 1e-12;
var<workgroup> flags: atomic<u32>;

@compute @workgroup_size(${ACTIVITY_TILE}, ${ACTIVITY_TILE})
fn main(@builtin(global_invocation_id) id: vec3u, @builtin(workgroup_id) wg: vec3u, @builtin(local_invocation_index) li: u32) {
  if (li == 0u) { atomicStore(&flags, 0u); }
  workgroupBarrier();
  if (id.x < S.size && id.y < S.size) {
    let i = id.y * S.size + id.x;
    var f = 0u;
    // water, flux or sediment still in suspension
    if (any(abs(water[i]) > vec4f(WATER_EPS)) || fine[i] > WATER_EPS) { f |= 1u; }
    let l = lava[i];
    if (l.x > 0.0 || l.z > 0.0) { f |= 2u; }
    if (f != 0u) { atomicOr(&flags, f); }
  }
  workgroupBarrier();
  if (li == 0u) { tiles[wg.y * tilesPerRow() + wg.x] = atomicLoad(&flags); }
}
`
export const activityGrowShader = header + activityTiles + /* wgsl */ `
@group(0) @binding(1) var<storage, read> tilesIn: array<u32>;
@group(0) @binding(2) var<storage, read_write> tilesOut: array<u32>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let n = i32(tilesPerRow());
  if (i32(id.x) >= n || i32(id.y) >= n) { return; }
  var f = 0u;
  for (var dy = -1; dy <= 1; dy++) {
    for (var dx = -1; dx <= 1; dx++) {
      f |= tilesIn[ixn(i32(id.x) + dx, i32(id.y) + dy, n)];
    }
  }
  tilesOut[id.y * u32(n) + id.x] = f;
}
`

// The two water/diffuse.shader passes (y then x) and water/momentum.shader fused into
// one kernel: each 16×16 tile loads a 20×20 neighbourhood into workgroup memory once
// and computes the intermediate fields there, instead of 3 round trips through
// global memory. Out-of-map neighbours are clamped exactly like the separate passes
// (an intermediate value "at" a clamped position is the one computed there), so the
// result is bit-identical to running the three original passes separately.
// Momentum also does the original's last = copy(current), in place: each
// invocation reads and writes only its own texel of last.
const TILE = ACTIVITY_TILE
export const waterFlowShader = header + /* wgsl */ `
@group(0) @binding(1) var<storage, read> ground: array<vec4f>;
@group(0) @binding(2) var<storage, read> water: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> last: array<vec4f>;
@group(0) @binding(4) var<storage, read_write> dst: array<vec4f>;
@group(0) @binding(5) var<storage, read> tiles: array<u32>;

const T = ${TILE};
const A = T + 4;       // loaded area: tile ± 2
// split into scalar arrays: vec3f would pad to 16 bytes and exceed the 16 KiB limit
var<workgroup> sGround: array<f32, A * A>;
var<workgroup> sSrcX: array<f32, A * A>;
var<workgroup> sSrcY: array<f32, A * A>;
var<workgroup> sSrcZ: array<f32, A * A>;
var<workgroup> sDyX: array<f32, A * (T + 2)>;     // x: tile ± 2, y: tile ± 1
var<workgroup> sDyY: array<f32, A * (T + 2)>;
var<workgroup> sDyZ: array<f32, A * (T + 2)>;
var<workgroup> sDxX: array<f32, (T + 2) * (T + 2)>;  // tile ± 1
var<workgroup> sDxY: array<f32, (T + 2) * (T + 2)>;
var<workgroup> sDxZ: array<f32, (T + 2) * (T + 2)>;

fn src(k: u32) -> vec3f { return vec3f(sSrcX[k], sSrcY[k], sSrcZ[k]); }
fn diffY(k: u32) -> vec3f { return vec3f(sDyX[k], sDyY[k], sDyZ[k]); }
fn diffX(k: u32) -> vec3f { return vec3f(sDxX[k], sDxY[k], sDxZ[k]); }

var<private> origin: vec2i;

fn clampG(p: vec2i) -> vec2i { return clamp(p, vec2i(0), vec2i(i32(S.size) - 1)); }
// local indices of a (clamped) global position in each shared array
fn iA(p: vec2i) -> u32 { let q = clampG(p) - origin + 2; return u32(q.y * A + q.x); }
fn iY(p: vec2i) -> u32 { let q = clampG(p) - origin + vec2i(2, 1); return u32(q.y * A + q.x); }
fn iX(p: vec2i) -> u32 { let q = clampG(p) - origin + 1; return u32(q.y * (T + 2) + q.x); }

fn diffuseY(p: vec2i) -> vec3f {
  let c = clampG(p);
  let t1 = sGround[iA(c)];
  let h = src(iA(c));
  var r = h;
  for (var s = 1; s >= -1; s -= 2) {
    let n = c + vec2i(0, s);
    let t2 = sGround[iA(n)];
    let h2 = sSrcX[iA(n)];
    let diff = clamp(((t2 + h2) - (t1 + h.x)) * 0.5 * 0.65, -h.x * 0.5, h2 * 0.5);
    r += vec3f(diff, 0.0, -f32(s) * diff);
  }
  return r;
}

fn diffuseX(p: vec2i) -> vec3f {
  let c = clampG(p);
  let t1 = sGround[iA(c)];
  let h = diffY(iY(c));
  var r = h;
  for (var s = 1; s >= -1; s -= 2) {
    let n = c + vec2i(s, 0);
    let t2 = sGround[iA(n)];
    let h2 = sDyX[iY(n)];
    let diff = clamp(((t2 + h2) - (t1 + h.x)) * 0.5 * 0.65, -h.x * 0.5, h2 * 0.5);
    r += vec3f(diff, -f32(s) * diff, 0.0);
  }
  return r;
}

fn momentum(g1: f32, l1: vec3f, c1: vec3f, p: vec2i, o: vec2i) -> vec3f {
  let n = p + o;
  let g2 = sGround[iA(n)];
  let c2 = diffX(iX(n));
  let change = clamp((g2 + c2.x) - (g1 + l1.x), -c1.x * 0.25, c2.x * 0.25);
  return vec3f(change, -f32(o.x) * change, -f32(o.y) * change);
}

var<workgroup> sTile: u32;

@compute @workgroup_size(T, T)
fn main(@builtin(workgroup_id) wg: vec3u, @builtin(local_invocation_index) li: u32) {
  origin = vec2i(wg.xy) * T;
  let n = i32(S.size);

  // dry tile with dry surroundings: no water, nothing flows (the result is exactly zero)
  if (li == 0u) { sTile = tiles[wg.y * ((S.size + T - 1u) / T) + wg.x]; }
  if ((workgroupUniformLoad(&sTile) & 1u) == 0u) {
    let p = origin + vec2i(i32(li % T), i32(li / T));
    if (p.x < n && p.y < n) {
      let i = u32(p.y * n + p.x);
      dst[i] = vec4f(0.0);
      last[i] = vec4f(0.0, 0.0, 0.0, 1.0);
    }
    return;
  }

  for (var k = li; k < A * A; k += T * T) {
    let p = clampG(origin + vec2i(i32(k % A), i32(k / A)) - 2);
    let j = u32(p.y * n + p.x);
    let w = water[j];
    sGround[k] = ground[j].x;
    sSrcX[k] = w.x;
    sSrcY[k] = w.y;
    sSrcZ[k] = w.z;
  }
  workgroupBarrier();

  for (var k = li; k < A * (T + 2); k += T * T) {
    let d = diffuseY(origin + vec2i(i32(k % A) - 2, i32(k / A) - 1));
    sDyX[k] = d.x;
    sDyY[k] = d.y;
    sDyZ[k] = d.z;
  }
  workgroupBarrier();

  for (var k = li; k < (T + 2) * (T + 2); k += T * T) {
    let d = diffuseX(origin + vec2i(i32(k % (T + 2)) - 1, i32(k / (T + 2)) - 1));
    sDxX[k] = d.x;
    sDxY[k] = d.y;
    sDxZ[k] = d.z;
  }
  workgroupBarrier();

  let p = origin + vec2i(i32(li % T), i32(li / T));
  if (p.x >= n || p.y >= n) { return; }
  let i = u32(p.y * n + p.x);
  let g = sGround[iA(p)];
  let l = last[i].xyz;
  let c = diffX(iX(p));
  let v = (
    momentum(g, l, c, p, vec2i(1, 0)) +
    momentum(g, l, c, p, vec2i(-1, 0)) +
    momentum(g, l, c, p, vec2i(0, 1)) +
    momentum(g, l, c, p, vec2i(0, -1))
  ) * 0.25;
  // the sediment stays put here; the sediment pass carries it along
  dst[i] = vec4f(c + v, water[i].w);
  last[i] = vec4f(c, 1.0);
}
`
export const WATER_FLOW_TILE = TILE

// Local inertial shallow water (Bates et al. 2010, with the θ weighting of de Almeida et
// al. 2012): the momentum equation without its advection term, solved on the cell faces.
// Each cell owns the flux through its +x and +y faces (waterLast.xy, depth × cells per
// step). Gravity pushes the water down the slope of its surface, bed friction (Manning)
// holds it back, and the flux carries on from the last step (inertia), so water runs
// down valleys, swings round bends and comes to rest flat in lakes and the sea. The
// depth is then updated from what flows through the faces: mass is conserved exactly.
// water.yz keep the flux at the cell centre (the mean of its faces), as before.
const waterInertialModel = /* wgsl */ `
// gravity; where the water is deep its waves are slowed to stay within a cell per step
const GRAVITY = 20.0;
const MAX_GH = 0.2;
// Manning bed friction (sets how fast water runs at a given depth and slope)
const MANNING = 0.0017;
// weight of the face's own flux against its neighbours' (damps checkerboard ripples)
const THETA = 0.8;
// share of the flow lost to turbulence each step: deep water barely feels the bed, and
// without this the sea would slosh for ever after filling
const TURBULENCE = 0.005;
fn dryTile(x: i32, y: i32) -> bool { return (tiles[tileOf(x, y)] & 1u) == 0u; }
`
// Pass 1: the new flux through this cell's +x and +y faces (before limiting), into
// waterTmp.yz; waterTmp.x keeps the depth and .w the sediment for pass 2.
export const waterFluxShader = header + activityTiles + waterInertialModel + /* wgsl */ `
@group(0) @binding(1) var<storage, read> ground: array<vec4f>;
@group(0) @binding(2) var<storage, read> water: array<vec4f>;
@group(0) @binding(3) var<storage, read> last: array<vec4f>;
@group(0) @binding(4) var<storage, read_write> dst: array<vec4f>;
@group(0) @binding(5) var<storage, read> tiles: array<u32>;

fn faceFlux(x: i32, y: i32, o: vec2i, q0: f32, qa: f32, qb: f32) -> f32 {
  let n = i32(S.size);
  let x2 = x + o.x;
  let y2 = y + o.y;
  // the border is a wall here; the water cycle drains it or holds it at sea level
  if (x2 >= n || y2 >= n) { return 0.0; }
  let i = ix(x, y);
  let j = ix(x2, y2);
  let z1 = ground[i].x;
  let z2 = ground[j].x;
  let e1 = z1 + water[i].x;
  let e2 = z2 + water[j].x;
  // depth of water that can flow between the two cells
  let hf = max(e1, e2) - max(z1, z2);
  if (hf <= 1e-7) { return 0.0; }
  let g = min(GRAVITY, MAX_GH / hf);
  let q = (THETA * q0 + (1.0 - THETA) * 0.5 * (qa + qb)) * (1.0 - TURBULENCE);
  let pushed = (q - g * hf * (e2 - e1)) / (1.0 + g * MANNING * MANNING * abs(q) / pow(hf, 7.0 / 3.0));
  // at most half a cell per step (a cell has four faces to share its water)
  return clamp(pushed, -0.5 * hf, 0.5 * hf);
}
` + gridMain(/* wgsl */ `
  let w = water[i];
  if (dryTile(x, y)) { dst[i] = vec4f(w.x, 0.0, 0.0, w.w); return; }
  let l = last[i];
  let qx = faceFlux(x, y, vec2i(1, 0), l.x, last[ix(x - 1, y)].x, last[ix(x + 1, y)].x);
  let qy = faceFlux(x, y, vec2i(0, 1), l.y, last[ix(x, y - 1)].y, last[ix(x, y + 1)].y);
  dst[i] = vec4f(w.x, qx, qy, w.w);
`)
// Pass 2: no cell may send out more water than it holds (its outflows are scaled down
// together); both cells of a face see the same scaled flux, so water is conserved. The
// new depth, the cell-centre flux and the faces for the next step.
export const waterDepthShader = header + activityTiles + waterInertialModel + /* wgsl */ `
@group(0) @binding(1) var<storage, read> src: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> dst: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> last: array<vec4f>;
@group(0) @binding(4) var<storage, read> tiles: array<u32>;

fn inside(x: i32, y: i32) -> bool { let n = i32(S.size); return x >= 0 && y >= 0 && x < n && y < n; }
// raw flux through the +x (k = 0) or +y (k = 1) face of a cell; nothing beyond the map
fn raw(x: i32, y: i32, k: i32) -> f32 {
  if (!inside(x, y)) { return 0.0; }
  let s = src[ix(x, y)];
  return select(s.z, s.y, k == 0);
}
// share of its outflow a cell can actually send
fn limit(x: i32, y: i32) -> f32 {
  if (!inside(x, y)) { return 1.0; }
  let out = max(raw(x, y, 0), 0.0) + max(-raw(x - 1, y, 0), 0.0) +
            max(raw(x, y, 1), 0.0) + max(-raw(x, y - 1, 1), 0.0);
  let h = src[ix(x, y)].x;
  return select(1.0, h / out, out > h);
}
// the flux through the face between (x, y) and its +x (k = 0) or +y neighbour, limited
// by whichever cell it leaves
fn face(x: i32, y: i32, k: i32) -> f32 {
  let q = raw(x, y, k);
  if (q >= 0.0) { return q * limit(x, y); }
  return q * select(limit(x, y + 1), limit(x + 1, y), k == 0);
}
` + gridMain(/* wgsl */ `
  let s = src[i];
  if (dryTile(x, y)) {
    dst[i] = s;
    last[i] = vec4f(0.0);
    return;
  }
  let east = face(x, y, 0);
  let west = face(x - 1, y, 0);
  let north = face(x, y, 1);
  let south = face(x, y - 1, 1);
  let h = max(s.x + west - east + south - north, 0.0);
  dst[i] = vec4f(h, 0.5 * (east + west), 0.5 * (north + south), s.w);
  last[i] = vec4f(east, north, 0.0, 0.0);
`)

// The same three passes split (as in the original shaders), for GPUs emulated on the
// CPU: there the fused kernel's 16×16 workgroups, workgroup memory and barriers cost
// far more than the arithmetic (measured ~150 ms per step at 256² on SwiftShader,
// even on a dry map). Same arithmetic, same clamping, so the same result.
// Dry tiles write zeros (the activity marks cover every neighbour these read).
const splitFlowHeader = header + activityTiles + /* wgsl */ `
@group(0) @binding(1) var<storage, read> ground: array<vec4f>;
@group(0) @binding(2) var<storage, read> tiles: array<u32>;
fn dry(x: i32, y: i32) -> bool { return (tiles[tileOf(x, y)] & 1u) == 0u; }
fn diffuse(t1: f32, h: f32, t2: f32, h2: f32) -> f32 {
  return clamp(((t2 + h2) - (t1 + h)) * 0.5 * 0.65, -h * 0.5, h2 * 0.5);
}
`
export const waterDiffuseYShader = splitFlowHeader + /* wgsl */ `
@group(0) @binding(3) var<storage, read> water: array<vec4f>;
@group(0) @binding(4) var<storage, read_write> dst: array<vec4f>;
` + gridMain(/* wgsl */ `
  if (dry(x, y)) { dst[i] = vec4f(0.0); return; }
  let t1 = ground[i].x;
  let h = water[i].xyz;
  var r = h;
  for (var s = 1; s >= -1; s -= 2) {
    let j = ix(x, y + s);
    let diff = diffuse(t1, h.x, ground[j].x, water[j].x);
    r += vec3f(diff, 0.0, -f32(s) * diff);
  }
  dst[i] = vec4f(r, water[i].w);
`)
export const waterDiffuseXShader = splitFlowHeader + /* wgsl */ `
@group(0) @binding(3) var<storage, read> src: array<vec4f>;
@group(0) @binding(4) var<storage, read_write> dst: array<vec4f>;
` + gridMain(/* wgsl */ `
  if (dry(x, y)) { dst[i] = vec4f(0.0); return; }
  let t1 = ground[i].x;
  let h = src[i].xyz;
  var r = h;
  for (var s = 1; s >= -1; s -= 2) {
    let j = ix(x + s, y);
    let diff = diffuse(t1, h.x, ground[j].x, src[j].x);
    r += vec3f(diff, -f32(s) * diff, 0.0);
  }
  dst[i] = vec4f(r, src[i].w);
`)
export const waterMomentumShader = splitFlowHeader + /* wgsl */ `
@group(0) @binding(3) var<storage, read> diffused: array<vec4f>;
@group(0) @binding(4) var<storage, read_write> last: array<vec4f>;
@group(0) @binding(5) var<storage, read_write> dst: array<vec4f>;

fn momentum(g1: f32, l1: vec3f, c1: vec3f, x: i32, y: i32, o: vec2i) -> vec3f {
  let j = ix(x + o.x, y + o.y);
  let c2 = diffused[j].xyz;
  let change = clamp((ground[j].x + c2.x) - (g1 + l1.x), -c1.x * 0.25, c2.x * 0.25);
  return vec3f(change, -f32(o.x) * change, -f32(o.y) * change);
}
` + gridMain(/* wgsl */ `
  if (dry(x, y)) {
    dst[i] = vec4f(0.0);
    last[i] = vec4f(0.0, 0.0, 0.0, 1.0);
    return;
  }
  let g = ground[i].x;
  let l = last[i].xyz;
  let c = diffused[i].xyz;
  let v = (
    momentum(g, l, c, x, y, vec2i(1, 0)) +
    momentum(g, l, c, x, y, vec2i(-1, 0)) +
    momentum(g, l, c, x, y, vec2i(0, 1)) +
    momentum(g, l, c, x, y, vec2i(0, -1))
  ) * 0.25;
  dst[i] = vec4f(c + v, diffused[i].w);
  last[i] = vec4f(c, 1.0);
`)

// water/cycle.shader: rain, evaporation and flux smoothing (brush water moved to the paint pass).
// The original smoothing kernel sampled the row below twice and skipped the row
// above (a typo); this uses the symmetric 3×3 kernel it was clearly meant to be.
// Extended with climate: precipitation comes from the air pass and falls as snow
// below freezing; snow and ice melt above it, deep snow compacts into glacier ice
// and still water freezes. Evaporation takes a layer off the surface plus a little
// more over deep water (the original took a fraction of the depth, which made the
// sea evaporate faster than the border could refill it); the sea itself does not
// evaporate, since the air pass already counts it as a vapour source. Water also
// soaks into soil and sand, and without a sea it drains off the map edges like
// rivers leaving the region, so basins fill up to a level and stop there.
// The air pass's output is copied back here so it can ping-pong.
export const waterCycleShader = header + /* wgsl */ `
@group(0) @binding(1) var<storage, read> src: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> dst: array<vec4f>;
@group(0) @binding(3) var<storage, read> ground: array<vec4f>;
@group(0) @binding(4) var<storage, read_write> extra: array<vec4f>;
@group(0) @binding(5) var<storage, read> airIn: array<vec4f>;
@group(0) @binding(6) var<storage, read_write> airOut: array<vec4f>;
@group(0) @binding(7) var<storage, read> climate: array<vec4f>;
@group(0) @binding(8) var<storage, read> lava: array<vec4f>;

// transpiration of a full canopy per step at 15 °C in dry air (water height)
const TRANSPIRE = 0.0000001;
// share of a film of rain on the ground that evaporates per step (standing water: the potential)
const FILM_EVAPORATION = 0.5;
// water a full soil holds (height), how fast rain soaks into it, share that seeps away per step
const SOIL_WATER = 0.0003;
const INFILTRATE = 0.00000005;
const SOIL_DRAIN = 0.0001;
fn flux(x: i32, y: i32) -> vec2f { return src[ix(x, y)].yz; }
` + gridMain(/* wgsl */ `
  var w = src[i].xyz;
  let h = ground[i].x;
  var e = extra[i];
  var a = airIn[i];
  let c = climate[i];
  let t = c.w;
  let cold = frozen(t);
  let thaw = max(t, 0.0) * (1.0 - cold);

  // precipitation: rain above freezing, snow below it, except on cliffs it slides
  // off and on open water it melts into. Rain on the sea joins the world ocean, whose
  // level the border holds (added here it piled the sea into a dome that ran off to
  // the borders as a current)
  let sea = S.climate.w > 0.5 && h < S.climate.z;
  let precip = a.y * rainWater() * S.rain;
  let slope = (abs(ground[ix(x + 1, y)].x - ground[ix(x - 1, y)].x) + abs(ground[ix(x, y + 1)].x - ground[ix(x, y - 1)].x)) * cellsPerUnit() * 0.5;
  let sticks = (1.0 - smoothstep(0.8, 1.5, slope)) * (1.0 - smoothstep(0.0003, 0.001, w.x));
  if (!sea) { w.x += precip * (1.0 - cold) + precip * cold * (1.0 - sticks); }
  e.z += precip * cold * 1.5 * sticks;

  // melt: degree-day style, faster the warmer it is
  let melt = min(e.z, thaw * 0.00000011 + (1.0 - cold) * 0.0000002);
  e.z -= melt;
  w.x += melt;
  // deep snow compacts into glacier ice; ice melts more slowly than snow
  let compact = max(e.z - 0.002, 0.0) * 0.002;
  e.z -= compact;
  e.w += compact;
  let iceMelt = min(e.w, thaw * 0.00000006);
  e.w -= iceMelt;
  w.x += iceMelt;
  // still, shallow water freezes; an ice sheet insulates the water under it
  let still = 1.0 - smoothstep(0.002, 0.01, length(w.yz));
  let freeze = min(w.x, max(-t, 0.0) * 0.0000001 * still * (1.0 - smoothstep(0.0, 0.003, e.w)));
  w.x -= freeze;
  e.w += freeze;

  let g = ground[i];
  if (!sea) {
    // soil water (e.y, the share of what the soil can hold): rain soaks into soil and
    // sand, more under plants (litter and roots open the ground), and slowly seeps on
    // into the groundwater
    let permeable = smoothstep(0.0, 0.002, g.z + g.w) * (1.0 - cold);
    let soaked = min(w.x, INFILTRATE * permeable * (0.4 + e.x) * max(1.0 - e.y, 0.0));
    w.x -= soaked;
    // how much the air can take up here; standing water gives all of it, but a film of
    // rain on the ground only a share of itself each step, the rest runs off
    let potential = 0.00000015 * capacity(t) * (1.0 - 0.6 * clamp(c.y, 0.0, 1.0)) * (1.0 - cold) * S.evaporate;
    let pool = smoothstep(0.00005, 0.0005, w.x);
    let film = min(potential, FILM_EVAPORATION * w.x);
    let evaporated = min(w.x, mix(film, potential, pool) + 0.00002 * w.x * (1.0 - cold) * S.evaporate);
    w.x -= evaporated;
    var stored = e.y * SOIL_WATER + soaked;
    stored *= 1.0 - SOIL_DRAIN;
    // bare ground dries out only near the surface; plants pull water from the whole
    // root zone and breathe it out (transpiration), the more the denser, warmer and drier
    // the air. A rainforest so gives much of its rain back to the air, long after the
    // rain has run off bare ground, and the wind carries it inland to rain again: the
    // "flying rivers" that water the heart of a continent
    let dried = min(stored, potential * 0.25 * e.y * (1.0 - e.x));
    stored -= dried;
    let leaves = e.x * smoothstep(5.0, 22.0, t) * (1.0 - cold);
    let transpired = min(stored, TRANSPIRE * leaves * capacity(t) * clamp(1.2 - c.y, 0.2, 1.0) * S.evaporate);
    stored -= transpired;
    e.y = clamp(stored / SOIL_WATER, 0.0, 1.0);
    // moisture recycling: what evaporates from rivers, lakes and wet ground and what
    // plants transpire goes back into the air as vapour (the same water, in the air
    // pass's units) and rains again further downwind
    a.x += (evaporated + dried + transpired) / max(rainWater(), 0.000001);
  }
  extra[i] = e;
  // molten lava boils off the water on it into steam and heats the air above
  let lv = lava[i];
  let molten = smoothstep(0.0, 0.0003, lv.x) * lv.y;
  let boil = min(w.x, molten * 0.00002);
  w.x -= boil;
  a.x += boil / max(rainWater(), 0.000001) * 0.5;
  a.z += molten * 0.5;
  airOut[i] = a;

  let edge = i32(S.size) - 1;
  if (x == 0 || y == 0 || x == edge || y == edge) {
    if (S.climate.w > 0.5) { w.x = max(S.climate.z - h, 0.0); } else { w.x *= 0.9; }
  }
  w.x = clamp(w.x, 0.0, 1.0);
  let yz = (
    flux(x - 1, y - 1) * 1.0 + flux(x, y - 1) * 1.4 + flux(x + 1, y - 1) * 1.0 +
    flux(x - 1, y) * 1.4 + w.yz * 300.0 + flux(x + 1, y) * 1.4 +
    flux(x - 1, y + 1) * 1.0 + flux(x, y + 1) * 1.4 + flux(x + 1, y + 1) * 1.0
  ) * 0.98 * (1.0 / (300.0 + 1.4 * 4.0 + 4.0));
  dst[i] = vec4f(w.x, yz, src[i].w);
`)

// flows.shader: advects the low-res offsets used to scroll water detail normals.
// Offsets wrap at 0.5 (the detail texture repeats there) so they never lose precision.
export const flowsShader = header + /* wgsl */ `
@group(0) @binding(1) var<storage, read> water: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> flows: array<vec2f>;
` + bilinear('sampleWater', 'water') + /* wgsl */ `
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let F = S.flowSize;
  if (id.x >= F || id.y >= F) { return; }
  let i = id.y * F + id.x;
  let uv = (vec2f(id.xy) + 0.5) / f32(F);
  let w = sampleWater(uv).xyz;
  let vel = (w.yz * 0.001) / (w.x * 0.1 + 0.001);
  let p = flows[i] + vel;
  flows[i] = p - floor(p * 2.0) * 0.5;
}
`

// Lava: erupts in pulses from the vents painted with the volcano brush, flows down
// the surface like a very thick liquid (runnier the hotter it is) carrying its heat,
// and cools: faster when thin and much faster under water. Once cold it turns to
// rock (in the erode pass), so eruptions build up cones and lava plains.
export const lavaShader = header + /* wgsl */ `
@group(0) @binding(1) var<storage, read> ground: array<vec4f>;
@group(0) @binding(2) var<storage, read> water: array<vec4f>;
@group(0) @binding(3) var<storage, read> lavaIn: array<vec4f>;
@group(0) @binding(4) var<storage, read_write> lavaOut: array<vec4f>;
@group(0) @binding(5) var<storage, read> tiles: array<u32>;

// (lava, heat) flowing in from a neighbour; pairwise symmetric, so lava is conserved
fn lavaFlow(h1: f32, l1: vec4f, x: i32, y: i32) -> vec2f {
  let j = ix(x, y);
  let l2 = lavaIn[j];
  let mobile = smoothstep(0.05, 0.5, max(l1.y, l2.y));
  let diff = (ground[j].x - h1) * 0.25;
  let q = clamp(diff * 0.3 * mobile, -l1.x * 0.2, l2.x * 0.2);
  return vec2f(q, q * select(l1.y, l2.y, q > 0.0));
}
` + activityTiles + gridMain(/* wgsl */ `
  var l = lavaIn[i];
  // no lava or vents anywhere near: nothing flows or erupts (exactly what the full pass gives)
  if ((tiles[tileOf(x, y)] & 2u) == 0u) {
    lavaOut[i] = vec4f(0.0, 0.0, 0.0, l.w);
    return;
  }
  let h = ground[i].x;
  let f = lavaFlow(h, l, x + 1, y) + lavaFlow(h, l, x - 1, y) + lavaFlow(h, l, x, y + 1) + lavaFlow(h, l, x, y - 1);
  var heat = l.x * l.y + f.y;
  l.x = max(l.x + f.x, 0.0);
  // vents erupt in pulses
  let pulse = 0.3 + 0.7 * max(sin(S.sky.x * 0.4 + S.seed), 0.0);
  let erupt = l.z * 0.00001 * pulse;
  l.x += erupt;
  heat += erupt;
  l.y = select(0.0, clamp(heat / max(l.x, 0.0000001), 0.0, 1.0), l.x > 0.0000001);
  let wet = smoothstep(0.0, 0.001, water[i].x);
  l.y = max(l.y - 0.0003 - 0.00000005 / (l.x + 0.0001) - 0.01 * wet, 0.0);
  lavaOut[i] = l;
`)

// Sediment transport, after Mei, Decaudin & Hu, "Fast Hydraulic Erosion Simulation and
// Visualization on GPU" (2007). Running water carries sediment in suspension (water.w),
// up to a capacity that grows with its speed and the slope under it. Below capacity it
// picks up more: loose sand first, then soil (held by plant roots), then, once the soil
// is gone, the rock itself, which is how rivers cut valleys and canyons. Above capacity,
// where the water slows down (river mouths, lakes, flats), it drops the excess as fresh
// soil: deltas, filled lakes and flood plains. The sediment moves with the water by
// upwind (donor-cell) transport: each cell hands its neighbours the share of its
// sediment that its water velocity carries towards them, and every cell computes those
// shares the same way, so sediment is conserved (the paper's semi-Lagrangian advection
// copied sediment wherever flow converged, building land out of nothing). Only what
// flows off the map edges is lost. Reads ground and water, writes groundTmp and waterTmp,
// which are then copied back.
export const sedimentShader = header + activityTiles + weatheringModel + /* wgsl */ `
@group(0) @binding(1) var<storage, read> ground: array<vec4f>;
@group(0) @binding(2) var<storage, read> water: array<vec4f>;
@group(0) @binding(3) var<storage, read> extra: array<vec4f>;
@group(0) @binding(4) var<storage, read_write> groundOut: array<vec4f>;
@group(0) @binding(5) var<storage, read_write> waterOut: array<vec4f>;
@group(0) @binding(6) var<storage, read> tiles: array<u32>;
@group(0) @binding(7) var<storage, read> fine: array<f32>;
@group(0) @binding(8) var<storage, read_write> fineOut: array<f32>;

fn inside(x: i32, y: i32) -> bool { let n = i32(S.size); return x >= 0 && y >= 0 && x < n && y < n; }
fn surfaceAt(x: i32, y: i32) -> f32 { let j = ix(x, y); return ground[j].x + water[j].x; }
// Share of a cell's sediment leaving towards +x, -x, +y, -y this step (at most all of it).
fn outflow(x: i32, y: i32) -> vec4f {
  let v = waterVelocity(water[ix(x, y)]);
  let f = vec4f(max(v.x, 0.0), max(-v.x, 0.0), max(v.y, 0.0), max(-v.y, 0.0));
  let total = f.x + f.y + f.z + f.w;
  return select(f, f / total, total > 1.0);
}
// sediment a neighbour (if inside the map) sends this way, coarse and fine; k picks its outflow component
fn inflow(x: i32, y: i32, k: i32) -> vec2f {
  if (!inside(x, y)) { return vec2f(0.0); }
  let j = ix(x, y);
  return vec2f(water[j].w, fine[j]) * outflow(x, y)[k];
}
// Bank erosion: running water in cell (wx, wy) cutting into the dry bank at (bx, by), as
// much as its current pushes against it, on banks rising above its surface, less on
// hard rock. Both cells evaluate this same function (one gains, the other loses the
// amount), so material is conserved. Cutting the outer bank of a bend while the slower
// inner side gathers sediment is what lets a river wander and meander.
fn bankCut(wx: i32, wy: i32, bx: i32, by: i32) -> f32 {
  if (!inside(wx, wy) || !inside(bx, by)) { return 0.0; }
  let ww = water[ix(wx, wy)];
  if (ww.x < 0.0005 || water[ix(bx, by)].x > 0.0005) { return 0.0; }
  let push = max(dot(waterVelocity(ww), vec2f(f32(bx - wx), f32(by - wy))), 0.0);
  let gb = ground[ix(bx, by)];
  let bank = clamp(gb.x - (ground[ix(wx, wy)].x + ww.x), 0.0, 0.01);
  let loose = gb.z + gb.w > 0.0005;
  let hard = select(rockHardness(worldUV(uvOf(bx, by)), gb.y, S.seed), 0.6, loose);
  return BANK_RATE * push * bank * S.erode / hard;
}
// Where water plunges down a steep face (a waterfall, water spilling over a dam), the
// bed erodes this many times faster: the fall undercuts the lip and it retreats, and a
// dam that water tops gives way in a rush.
const PLUNGE = 8.0;
` + gridMain(/* wgsl */ `
  var g = ground[i];
  let w = water[i];
  // dry tile with dry surroundings: no water, nothing carried
  if ((tiles[tileOf(x, y)] & 1u) == 0u) {
    groundOut[i] = g;
    waterOut[i] = w;
    fineOut[i] = fine[i];
    return;
  }
  let vel = waterVelocity(w);
  let out = outflow(x, y);
  let stay = 1.0 - (out.x + out.y + out.z + out.w);
  let carried = vec2f(w.w, fine[i]) * stay +
    inflow(x - 1, y, 0) + inflow(x + 1, y, 1) + inflow(x, y - 1, 2) + inflow(x, y + 1, 3);
  var coarse = max(carried.x, 0.0);
  var silt = max(carried.y, 0.0);
  let before = g.y + g.z + g.w;

  // banks: what this water cuts from the dry cells around it, and what the water around
  // cuts from this cell if it is a bank
  let gained = bankCut(x, y, x + 1, y) + bankCut(x, y, x - 1, y) + bankCut(x, y, x, y + 1) + bankCut(x, y, x, y - 1);
  coarse += gained * 0.5;
  silt += gained * 0.5;
  var lost = bankCut(x + 1, y, x, y) + bankCut(x - 1, y, x, y) + bankCut(x, y + 1, x, y) + bankCut(x, y - 1, x, y);
  let bankSand = min(lost, g.w);
  g.w -= bankSand;
  lost -= bankSand;
  let bankSoil = min(lost, g.z);
  g.z -= bankSoil;
  g.y -= lost - bankSoil;

  let wet = smoothstep(0.00002, 0.0005, w.x);
  // the slope of the water surface, not of the bed: a lake's surface is flat, so it
  // drops its load instead of scouring its floor, and the power goes into the outlet
  // where the surface falls away, which cuts it down and lets the lake drain
  let slope = length(vec2f(surfaceAt(x + 1, y) - surfaceAt(x - 1, y),
                           surfaceAt(x, y + 1) - surfaceAt(x, y - 1))) * 0.5 * cellsPerUnit();
  // the push on the bed grows with the depth (shear stress ~ depth × slope), so the
  // deepest line of the flow scours most and a sheet of water spread over a valley floor
  // drops its load: the flow gathers into a channel that keeps itself deep, beside dry
  // flood plains, instead of flooding the whole floor
  let depth = clamp(w.x / CHANNEL_DEPTH, 0.0, 3.0);
  let capacity = streamCapacity(length(vel), slope) * wet * depth;
  let capCoarse = capacity * COARSE_SHARE;
  let capFine = capacity * (1.0 - COARSE_SHARE);
  let gone = wet < 0.01;
  // the border opens onto the rest of the world: what the water brings there flows on out
  // of the window (the water cycle drains the water there) instead of being dumped on the
  // last cell, which piled up and raised the base level of the whole map
  let edge = i32(S.size) - 1;
  if (x == 0 || y == 0 || x == edge || y == edge) {
    coarse = 0.0;
    silt = 0.0;
  }
  // too much to carry: sand settles fast and close (bars, the delta front), silt and
  // clay slowly and far (the delta's outer slope, lake beds, flood plains, as fertile soil)
  if (coarse > capCoarse) {
    let dropped = (coarse - capCoarse) * select(SED_DEPOSIT, 1.0, gone);
    coarse -= dropped;
    g.w += dropped;
  }
  if (silt > capFine) {
    let dropped = (silt - capFine) * select(SED_DEPOSIT_FINE, 1.0, gone);
    silt -= dropped;
    g.z += dropped;
  }
  // room to carry more: loose sand first, then soil (held by roots), then bare rock
  let room = max(capCoarse - coarse, 0.0) + max(capFine - silt, 0.0);
  if (room > 0.0) {
    let plunge = 1.0 + PLUNGE * smoothstep(2.0, 5.0, slope) * smoothstep(0.0003, 0.002, w.x);
    var want = min(room * SED_ERODE * S.erode * plunge, 0.0002 * max(S.geo.x, 1.0) * plunge);
    let fromSand = min(want, g.w);
    g.w -= fromSand;
    want -= fromSand;
    let roots = 1.0 - 0.8 * extra[i].x;
    let fromSoil = min(want * roots, g.z);
    g.z -= fromSoil;
    want -= fromSoil;
    // bare rock only (soil armours it), harder than loose ground and by its stratum
    let fromRock = want * 0.35 * (1.0 - smoothstep(0.0, 0.0005, g.z)) / rockHardness(worldUV(uvOf(x, y)), g.y, S.seed);
    g.y -= fromRock;
    coarse += fromSand + fromRock * 0.5;
    silt += fromSoil + fromRock * 0.5;
  }
  g.x += (g.y + g.z + g.w) - before;
  groundOut[i] = g;
  waterOut[i] = vec4f(w.xyz, coarse);
  fineOut[i] = silt;
`)

// errode.shader, now the weathering pass (running water moved to sedimentShader): the
// climate weathers rock where it is exposed: freeze-thaw cracks it near
// 0 °C, warm wet climates rot it chemically, and in dry climates bare soil blows
// away until only sand is left.
export const erodeShader = header + /* wgsl */ `
@group(0) @binding(1) var<storage, read> ground: array<vec4f>;
@group(0) @binding(2) var<storage, read> water: array<vec4f>;
@group(0) @binding(3) var<storage, read> extra: array<vec4f>;
@group(0) @binding(4) var<storage, read_write> dst: array<vec4f>;
@group(0) @binding(5) var<storage, read_write> extraOut: array<vec4f>;
@group(0) @binding(6) var<storage, read> climate: array<vec4f>;
@group(0) @binding(7) var<storage, read_write> lava: array<vec4f>;
@group(0) @binding(8) var<storage, read> tiles: array<u32>;

` + activityTiles + weatheringModel + gridMain(/* wgsl */ `
  var g = ground[i];
  let w = water[i].xyz;
  let factor = S.erode;
  // (running water erodes and carries in the sediment pass)

  var e = extra[i];
  let c = climate[i];
  let t = c.w;
  let rain = clamp(c.z, 0.0, 3.0);
  // weathering acts on rock that is not buried under soil or ice; hard layers resist it
  let exposed = rockExposure(g.z, e.w) / rockHardness(worldUV(uvOf(x, y)), g.y, S.seed);
  let weathered = min((frostRate(t, rain) + chemicalRate(t, rain)) * exposed * factor, max(g.y, 0.0));
  g.y -= weathered;
  g.z += weathered;
  // thermal stress: big day–night swings crack exposed rock into grit (sand), which is
  // how deserts end up sandy
  let swing = dailySwing(c.y, e.x, smoothstep(0.0, 0.0005, w.x), e.z + e.w);
  let cracked = min(thermalRate(swing) * exposed * factor, max(g.y, 0.0));
  g.y -= cracked;
  g.w += cracked;
  // surf: where water deep enough to build waves meets the shore, the waves undercut
  // the coast; the rock above then slumps (cliffs retreat) and the grit makes beaches
  if ((tiles[tileOf(x, y)] & 1u) != 0u) {
    var deepest = 0.0;
    for (var dy = -2; dy <= 2; dy += 2) {
      for (var dx = -2; dx <= 2; dx += 2) {
        if (dx != 0 || dy != 0) { deepest = max(deepest, water[ix(x + dx, y + dy)].x); }
      }
    }
    let undercut = min(surfEnergy(deepest, w.x) * SURF_RATE * factor / rockHardness(worldUV(uvOf(x, y)), g.y, S.seed), max(g.y, 0.0));
    g.y -= undercut;
    g.w += undercut;
  }

  // lava that has cooled down becomes rock
  var lv = lava[i];
  if (lv.x > 0.0 && (lv.y < 0.08 || lv.x < 0.000001)) {
    g.y += lv.x;
    lv.x = 0.0;
    lava[i] = lv;
  }
  // tectonics: where the plates push, the rock keeps rising (or sinking), so erosion has
  // mountains to wear down instead of only ever flattening the land; geological time
  // speeds it up. The crust cannot hold up a range of any height: the thicker it gets,
  // the more it sinks under its own weight (isostasy) and the weaker its roots, so uplift
  // fades out on the way to CRUST_MAX, and rock pushed beyond it spreads out and sinks
  // back (gravitational collapse). Trenches stop deepening the same way.
  // The load is the whole column: under thick piles of sediment the bed stops rising too.
  let column = g.y + g.z + g.w;
  let rise = lv.w * UPLIFT_RATE * S.geo.x;
  let crest = smoothstep(CRUST_SOFT, CRUST_MAX, column);
  let trench = smoothstep(CRUST_SOFT, CRUST_MAX, -column);
  g.y += rise * select(1.0 - trench, 1.0 - crest, rise > 0.0);
  g.y -= max(g.y - CRUST_MAX, 0.0) * COLLAPSE_RATE * S.geo.x;
  g.x = g.y + g.z + g.w + e.w + lv.x;
  dst[i] = g;

  // soil water (filled and used up in the water cycle pass) seeps into the neighbours,
  // and the ground under standing or flowing water is soaked
  let wet = clamp(w.x / 0.0005, 0.0, 1.0);
  let around = (extra[ix(x + 1, y)].y + extra[ix(x - 1, y)].y + extra[ix(x, y + 1)].y + extra[ix(x, y - 1)].y) * 0.25;
  e.y = max(mix(e.y, around, 0.2), wet);
  extraOut[i] = e;
`)

// diffuse_soil.shader: rock and soil slump towards lower neighbours.
// Extended: sand slides only past its angle of repose and drifts with the wind
// where the ground is dry and bare; glacier ice creeps downhill and grinds the rock
// under it into sediment; vegetation grows or dies depending on the local climate.
// Slumping looks at the solid surface (without ice) so rock is not pushed out
// from under glaciers.
export const settleShader = header + weatheringModel + /* wgsl */ `
@group(0) @binding(1) var<storage, read> src: array<vec4f>;
@group(0) @binding(2) var<storage, read> water: array<vec4f>;
@group(0) @binding(3) var<storage, read> extraIn: array<vec4f>;
@group(0) @binding(4) var<storage, read_write> dst: array<vec4f>;
@group(0) @binding(5) var<storage, read_write> extra: array<vec4f>;
@group(0) @binding(6) var<storage, read> climate: array<vec4f>;
@group(0) @binding(7) var<storage, read> wind: array<vec4f>;
@group(0) @binding(8) var<storage, read> lava: array<vec4f>;

fn solid(g: vec4f) -> f32 { return g.y + g.z + g.w; }

// returns (rock, soil) change from exchanging with one of the 4 neighbours (original)
fn exchange(g1: vec4f, x1: i32, y1: i32, x: i32, y: i32) -> vec2f {
  let g2 = src[ix(x, y)];
  let diff = (solid(g2) - solid(g1)) / 4.0;
  // soil creeps slowly on gentle slopes and slides off steep ones (the same for both
  // cells, so soil is conserved)
  let creep = 0.1 + 0.9 * smoothstep(0.4, 1.0, abs(diff) * 4.0 * cellsPerUnit());
  let sdiff = clamp(diff, -g1.z / 2.0, g2.z / 2.0) * min(0.08 * S.geo.x, 0.4) * creep;
  // rock slumps once the step is steep enough; hard rock (judged on the higher side, so
  // both cells agree and rock is conserved) stands in steeper cliffs and gives way slower
  var hx = x1;
  var hy = y1;
  var top = g1.y;
  if (diff > 0.0) { hx = x; hy = y; top = g2.y; }
  // very high ranges are weaker under their own weight and slide at gentler angles
  let hard = rockHardness(worldUV(uvOf(hx, hy)), top, S.seed) * (1.0 - 0.6 * smoothstep(CRUST_SOFT, CRUST_MAX, top));
  // the threshold is a slope (tuned at 256 cells per unit), so cliffs keep their angle at any resolution
  // Only the rock's own step can slide: sediment piled on top does not push the rock under
  // it sideways (that dug ever deeper holes under sand banks).
  var gdiff = 0.0;
  let rdiff = (g2.y - g1.y) / 4.0;
  if (abs(diff) > 0.001 * hard * 256.0 / cellsPerUnit() && diff * rdiff > 0.0) {
    gdiff = sign(diff) * min(abs(diff), abs(rdiff)) * min(0.1 * S.geo.x / hard, 0.5);
  }
  return vec2f(gdiff, sdiff);
}

// Sand slides only past its angle of repose (tan ~0.6). Uses all 8 neighbours so
// piles become round cones instead of 4-sided pyramids. Pairwise symmetric, so
// sand is conserved; each neighbour takes at most 1/8 of what a cell holds.
fn sandExchange(g1: vec4f, x: i32, y: i32, dist: f32) -> f32 {
  let g2 = src[ix(x, y)];
  let dh = solid(g2) - solid(g1);
  let excess = sign(dh) * max(abs(dh) - 0.6 * dist / cellsPerUnit(), 0.0);
  return clamp(excess / 8.0, -g1.w / 8.0, g2.w / 8.0) * 0.5 / dist;
}

// Ice flows down the slope of the ice surface; thin ice is frozen to the ground.
// Pairwise symmetric, so ice is conserved.
fn iceExchange(g1: vec4f, ice1: f32, x: i32, y: i32) -> f32 {
  let j = ix(x, y);
  let ice2 = extraIn[j].w;
  let thick = max(ice1, ice2);
  let mobile = smoothstep(0.0003, 0.004, thick);
  let diff = (src[j].x - g1.x) * 0.25;
  // thick ice creeps much faster than thin ice (roughly Glen's law), up to a fifth per step
  let rate = 0.05 + 10.0 * min(thick, 0.02);
  return clamp(diff * rate * mobile, -ice1 * 0.2, ice2 * 0.2);
}

// Sand that the wind can lift from a cell: dry, bare, not under water, snow or ice.
// No sand blows in from beyond the map (the clamped border cell would otherwise hand on
// sand and get it back from itself, an endless source).
fn windborne(x: i32, y: i32) -> f32 {
  let n = i32(S.size);
  if (x < 0 || y < 0 || x >= n || y >= n) { return 0.0; }
  let j = ix(x, y);
  let e = extraIn[j];
  let open = (1.0 - smoothstep(0.0001, 0.0005, water[j].x)) * (1.0 - smoothstep(0.0, 0.0005, e.z + e.w));
  return src[j].w * open * (1.0 - e.y) * (1.0 - e.x);
}
` + gridMain(/* wgsl */ `
  var g = src[i];
  let c = exchange(g, x, y, x + 1, y) + exchange(g, x, y, x - 1, y) + exchange(g, x, y, x, y + 1) + exchange(g, x, y, x, y - 1);
  let d = 1.41421356;
  var sand =
    sandExchange(g, x + 1, y, 1.0) + sandExchange(g, x - 1, y, 1.0) +
    sandExchange(g, x, y + 1, 1.0) + sandExchange(g, x, y - 1, 1.0) +
    sandExchange(g, x + 1, y + 1, d) + sandExchange(g, x - 1, y - 1, d) +
    sandExchange(g, x + 1, y - 1, d) + sandExchange(g, x - 1, y + 1, d);

  // wind drift: a fraction of the loose sand hops one cell downwind each step
  // (a bilinear shift, which conserves sand away from the borders)
  let local = wind[ixn(x / 4, y / 4, i32(S.flowSize))].xy / f32(S.flowSize);
  // in cells per step at 512 cells per world unit (the wind slider's units)
  let speed = length(local) * 512.0 * extent();
  var e = extraIn[i];
  // wind erosion of exposed, dry rock (sand-blasting), turning it into sand
  var blasted = 0.0;
  if (speed > 0.001) {
    let rate = min(speed, 2.0) * 0.01 * S.erode;
    let dir = local / length(local);
    let back = vec2f(f32(x), f32(y)) - dir;
    let b = vec2i(floor(back));
    let f = back - floor(back);
    let incoming = mix(
      mix(windborne(b.x, b.y), windborne(b.x + 1, b.y), f.x),
      mix(windborne(b.x, b.y + 1), windborne(b.x + 1, b.y + 1), f.x), f.y);
    sand += (incoming - windborne(x, y)) * rate;

    // Sand carried by the wind wears down the rock it hits, most on faces turned into
    // the wind; strong wind alone slowly scours bare rock too. Over time this carves
    // streamlined ridges along the wind (yardangs) and lowers exposed rock.
    let N = cellsPerUnit();
    let grad = vec2f(solid(src[ix(x + 1, y)]) - solid(src[ix(x - 1, y)]), solid(src[ix(x, y + 1)]) - solid(src[ix(x, y - 1)])) * 0.5 * N;
    let windward = 0.3 + clamp(dot(grad, dir) * 2.0, 0.0, 1.0);
    let bare = (1.0 - smoothstep(0.0, 0.001, g.z + g.w)) * (1.0 - smoothstep(0.0001, 0.0005, water[i].x)) *
      (1.0 - smoothstep(0.0, 0.0005, e.z + e.w));
    blasted = min((incoming * rate * 0.4 + 0.00000004 * min(speed, 2.0)) * windward * bare * S.erode /
      rockHardness(worldUV(uvOf(x, y)), g.y, S.seed), max(g.y, 0.0));
  }
  // deflation: the wind strips the fines from dry, bare soil in arid climates, leaving
  // sand; the stronger the wind, the faster
  let arid = 1.0 - smoothstep(0.25, 0.7, climate[i].z);
  let blown = g.z * 0.00005 * arid * (1.0 - e.y) * (1.0 - e.x) * (0.4 + 0.6 * min(speed, 2.0)) * S.erode;

  let ice =
    iceExchange(g, e.w, x + 1, y) + iceExchange(g, e.w, x - 1, y) +
    iceExchange(g, e.w, x, y + 1) + iceExchange(g, e.w, x, y - 1);
  // moving ice grinds the bed: the more ice passes, the more rock becomes sediment
  let moved =
    abs(iceExchange(g, e.w, x + 1, y)) + abs(iceExchange(g, e.w, x - 1, y)) +
    abs(iceExchange(g, e.w, x, y + 1)) + abs(iceExchange(g, e.w, x, y - 1));
  // (a thick glacier bears down harder: it quarries the bed into a U-shaped valley)
  let abraded = min(moved * (0.15 + 20.0 * min(e.w, 0.02)) * S.erode, max(g.y + c.x, 0.0));
  // the soil under moving ice is scraped off into till
  let scraped = min(moved * 0.5 * S.erode, max(g.z, 0.0));
  // the glacier carries half of what it grinds off; the ice arriving at the margin (thin
  // ice fed by thick ice flowing in) drops that debris there as ridges of till (moraines)
  let margin = 1.0 - smoothstep(0.0002, 0.001, e.w);
  let fed = max(iceExchange(g, e.w, x + 1, y), 0.0) + max(iceExchange(g, e.w, x - 1, y), 0.0) +
    max(iceExchange(g, e.w, x, y + 1), 0.0) + max(iceExchange(g, e.w, x, y - 1), 0.0);
  let till = fed * 0.3 * margin;
  e.w = max(e.w + ice, 0.0);
  // hot lava melts snow and ice and burns plants
  let lv = lava[i];
  let burning = smoothstep(0.0, 0.0003, lv.x) * smoothstep(0.1, 0.4, lv.y);
  e.z *= 1.0 - 0.1 * burning;
  e.w *= 1.0 - 0.05 * burning;

  // where it rains on sand, pioneer plants take hold and the sand slowly becomes soil
  // (organic matter builds up); so a desert greens when the climate turns wet
  let wetSand = smoothstep(0.3, 0.7, max(e.y, clamp(climate[i].z * 0.6, 0.0, 1.0))) * (1.0 - arid);
  let fixed = min(g.w, 0.00003 * (0.2 + e.x) * wetSand * S.vegetation);
  g.y += c.x - abraded - blasted;
  g.z += c.y + abraded * 0.5 - blown + fixed - scraped;
  g.w = max(g.w + sand + blasted + blown + till - fixed + scraped, 0.0);
  g.x = g.y + g.z + g.w + e.w + lv.x;
  dst[i] = g;

  let depth = water[i].x;
  let cl = climate[i];
  let t = cl.w;

  // vegetation: grows on moist soil that is not under water, snow or ice, up to what
  // the climate supports; dies when drowned, bare, frozen or parched
  let slope = (abs(src[ix(x + 1, y)].x - src[ix(x - 1, y)].x) + abs(src[ix(x, y + 1)].x - src[ix(x, y - 1)].x)) * cellsPerUnit() * 0.5;
  // plants want soil; on wet sand pioneer species still take hold, more slowly
  let soilOk = max(smoothstep(0.0002, 0.001, g.z), 0.4 * smoothstep(0.0002, 0.001, g.w) * smoothstep(0.3, 0.7, max(e.y, clamp(cl.z * 0.6, 0.0, 1.0))));
  let dry = 1.0 - smoothstep(0.001, 0.003, depth);
  let gentle = 1.0 - smoothstep(0.8, 1.6, slope);
  let snowFree = 1.0 - smoothstep(0.0001, 0.0006, e.z + e.w);
  let supply = max(e.y, clamp(cl.z * 0.6, 0.0, 1.0));
  let warmth = smoothstep(-3.0, 6.0, t) * (1.0 - smoothstep(34.0, 42.0, t));
  let carrying = warmth * smoothstep(0.1, 0.6, supply);
  let growth = 0.0015 * soilOk * dry * gentle * supply * max(carrying - e.x, 0.0) * snowFree * (0.5 + 0.5 * smoothstep(8.0, 25.0, t));
  let parched = clamp((t - 28.0) / 8.0, 0.0, 1.0) * (1.0 - e.y) + (1.0 - smoothstep(0.1, 0.35, cl.z)) * (1.0 - e.y) * 0.5;
  let freezing = smoothstep(-2.0, -8.0, t);
  let decay = e.x * (0.2 * burning + 0.004 * (1.0 - dry) + 0.01 * (1.0 - soilOk) + 0.003 * parched + 0.002 * freezing + 0.001 * max(e.x - carrying, 0.0));
  e.x = clamp(e.x + (growth - decay) * S.vegetation, 0.0, 1.0);
  extra[i] = e;
`)

// Plate tectonics: works out, for every cell, how fast the plates make the rock there
// rise or sink (lava.w, −1 … 1, applied by the erode pass). It only depends on where the
// plates are and how they move, so it runs every few frames, not every step.
// Plates moving together: two continents collide and push up a wide mountain belt
// (Himalayas); where one side is low (ocean floor) it dives under the other, leaving a
// trench in front and raising a mountain arc behind (Andes). Plates moving apart: a
// continent splits along a sinking rift with raised shoulders (East African Rift); the
// ocean floor wells up into a ridge. Plates sliding past each other only build stress.
export const platesShader = header + platesModel('S.geo.y', 'S.geo.z', 'S.plates') + /* wgsl */ `
@group(0) @binding(1) var<storage, read> ground: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> lava: array<vec4f>;

fn rockAt(uv: vec2f) -> f32 {
  let p = vec2i(floor(uv * f32(S.size)));
  return ground[ix(p.x, p.y)].y;
}
fn bump(d: f32, at: f32, width: f32) -> f32 { let t = (d - at) / width; return exp(-t * t); }
` + gridMain(/* wgsl */ `
  let uv = uvOf(x, y);
  let pp = platePair(worldUV(uv), S.seed);
  let n = normalize(pp.b - pp.a);
  // > 0: the plates close in on each other
  let closing = dot(plateVelocity(pp.own, S.seed) - plateVelocity(pp.other, S.seed), n);
  let d = pp.dist;
  // which side is oceanic (under the sea) decides who dives under: rock height a little
  // way into each plate; without a sea every plate is continental
  let toUV = 1.0 / S.world.w;
  let low = select(-1e9, S.climate.z, S.climate.w > 0.5);
  let ownLow = rockAt(uv - n * 0.1 * toUV) < low;
  let otherLow = rockAt(uv + n * (d + 0.1) * toUV) < low;
  var u = 0.0;
  if (closing > 0.0) {
    var ownDives = ownLow && !otherLow;
    var otherDives = otherLow && !ownLow;
    if (ownLow && otherLow) {
      // two ocean plates: the older, denser one (here: the one with the lower hash) dives
      let s = plateSalt(S.seed) + 4u;
      ownDives = plateHash(pp.own, s) < plateHash(pp.other, s);
      otherDives = !ownDives;
    }
    if (ownDives) {
      u = -0.8 * closing * bump(d, 0.015, 0.02);
    } else if (otherDives) {
      u = closing * (bump(d, 0.07, 0.04) + 0.3 * bump(d, 0.0, 0.03));
    } else {
      // two continents: the range rises along the suture, but its rock is crust squeezed in
      // from the plates on either side, which so sink a little all over (evenly, so no
      // basins open) and the collision does not keep adding rock to the world
      u = closing * (bump(d, 0.0, 0.09) - 0.1);
    }
  } else {
    let opening = -closing;
    if (ownLow && otherLow) {
      u = 0.5 * opening * bump(d, 0.0, 0.04);
    } else {
      u = opening * (0.3 * bump(d, 0.05, 0.025) - 0.8 * bump(d, 0.0, 0.025));
    }
  }
  var lv = lava[i];
  lv.w = clamp(u, -1.0, 1.0);
  lava[i] = lv;
`)

// Earthquake: a fault slips at once along a stretch of plate boundary. Where the
// plates collide one side jumps up (a fault scarp), where they pull apart a strip drops
// (a graben); sideways faults only shake. The shaking breaks loose rock off steep slopes
// into rubble (sand), which the settle pass then lets slide down. Reads ground, writes
// groundTmp, which is copied back.
export const quakeShader = header + /* wgsl */ `
@group(0) @binding(1) var<storage, read> ground: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> dst: array<vec4f>;
` + gridMain(/* wgsl */ `
  var g = ground[i];
  let rel = (uvOf(x, y) - S.quake.xy) * S.world.w;
  let r = length(rel) / S.quake.w;
  if (r >= 1.0 || S.quake2.z < 0.5) {
    dst[i] = g;
    return;
  }
  let fall = (1.0 - r * r) * (1.0 - r * r);
  let n = vec2f(cos(S.quake.z), sin(S.quake.z));
  let across = dot(rel, n);
  // positive throw: the far side rises at the fault; negative: a narrow strip drops
  let slip = S.quake2.x * fall * select(exp(-across * across / 0.0002), smoothstep(-0.004, 0.004, across), S.quake2.x > 0.0);
  let slope = length(vec2f(ground[ix(x + 1, y)].x - ground[ix(x - 1, y)].x,
                           ground[ix(x, y + 1)].x - ground[ix(x, y - 1)].x)) * 0.5 * cellsPerUnit();
  let rubble = S.quake2.y * fall * smoothstep(0.6, 1.5, slope);
  g.y += slip - rubble;
  g.w += rubble;
  g.x += slip;
  dst[i] = g;
`)

// A meteor strike (the meteor tool): a bowl dug out of the ground with a raised rim of
// shocked rock, a blanket of ejecta around it, a pool of melt on the floor, and the
// blast clearing water, snow, ice and plants. Like the quake, it writes a copy of the
// ground that is copied back.
export const impactShader = header + /* wgsl */ `
@group(0) @binding(1) var<storage, read> ground: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> dst: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> extra: array<vec4f>;
@group(0) @binding(4) var<storage, read_write> water: array<vec4f>;
@group(0) @binding(5) var<storage, read_write> lava: array<vec4f>;
@group(0) @binding(6) var<storage, read_write> air: array<vec4f>;
` + gridMain(/* wgsl */ `
  var g = ground[i];
  let R = S.impact.z;
  if (R <= 0.0) { dst[i] = g; return; }
  let rel = (uvOf(x, y) - S.impact.xy) * S.world.w;
  let r = length(rel) / R;
  if (r >= 3.0) { dst[i] = g; return; }
  // the fireball: the air over the strike is heated by tens of degrees out to two and a
  // half radii and takes up the vaporised water; hot humid air convects into a storm
  var a = air[i];
  let fire = max(1.0 - r / 2.5, 0.0);
  a.z += 60.0 * fire * fire * min(S.impact.w * 40.0 + 0.3, 1.0);
  a.x = min(a.x + water[i].x * 60.0 * fire, capacity(a.z));
  air[i] = a;
  let depth = S.impact.w;
  var e = extra[i];
  var w = water[i];
  var lv = lava[i];
  // the bowl: a paraboloid dug out of sand, then soil, then rock
  var dig = depth * max(1.0 - r * r, 0.0);
  let fromSand = min(dig, g.w);
  g.w -= fromSand;
  dig -= fromSand;
  let fromSoil = min(dig, g.z);
  g.z -= fromSoil;
  dig -= fromSoil;
  g.y -= dig;
  // the rim: rock thrown up around the bowl, and a blanket of rubble thinning out to three radii
  let rim = depth * 0.35 * exp(-(r - 1.1) * (r - 1.1) / 0.06);
  g.y += rim * 0.6;
  g.w += rim * 0.4 + depth * 0.12 * smoothstep(3.0, 1.0, r) * step(1.0, r);
  // the floor melts into a pool of fresh lava
  lv.x += depth * 0.3 * max(1.0 - r * r * 2.0, 0.0);
  if (r < 0.7) { lv.y = 1.0; }
  // the blast: water vaporised, snow and ice gone, plants burnt
  let blast = smoothstep(1.0, 1.4, r);
  w = vec4f(w.x * blast, w.yz * blast, w.w);
  e.z *= smoothstep(1.2, 1.8, r);
  e.w *= smoothstep(1.2, 1.8, r);
  e.x *= smoothstep(1.5, 2.6, r);
  g.x = g.y + g.z + g.w + e.w + lv.x;
  dst[i] = g;
  extra[i] = e;
  water[i] = w;
  lava[i] = lv;
`)

// A natural volcano waking up (see the engine's eruptions): a vent opens in the middle of
// the site, like the volcano brush paints one, with a first gush of lava; when the eruption
// is over the same pass plugs it again (the strength goes back down, never below zero).
export const ventShader = header + /* wgsl */ `
@group(0) @binding(1) var<storage, read_write> lava: array<vec4f>;
` + gridMain(/* wgsl */ `
  let R = S.vent.z;
  if (R <= 0.0) { return; }
  let d = distance(uvOf(x, y), S.vent.xy) / R;
  if (d >= 1.0) { return; }
  let profile = 1.0 - smoothstep(0.2, 1.0, d);
  var lv = lava[i];
  lv.z = clamp(lv.z + S.vent.w * profile, 0.0, 1.0);
  if (S.vent.w > 0.0) {
    // the first gush
    lv.x += 0.0015 * profile * S.vent.w;
    lv.y = 1.0;
  }
  lava[i] = lv;
`)

// The strike's blast on the wind grid: the air is pushed out in a ring (strongest two
// crater radii out) and piles up there as a passing high; the firestorm's low follows
// (the engine sets a storm off at the strike).
export const shockShader = header + /* wgsl */ `
@group(0) @binding(1) var<storage, read_write> wind: array<vec4f>;
` + windMain(/* wgsl */ `
  let R = S.impact.z;
  if (R <= 0.0) { return; }
  let uv = (vec2f(f32(x), f32(y)) + 0.5) / f32(S.flowSize);
  let rel = (uv - S.impact.xy) * S.world.w;
  let r = length(rel) / R;
  if (r < 0.05 || r > 6.0) { return; }
  let ring = exp(-(r - 2.0) * (r - 2.0) / 2.0);
  let push = 1.5 * ring * min(S.impact.w * 40.0 + 0.3, 1.5);
  var v = wind[i];
  wind[i] = vec4f(v.xy + normalize(rel) * push, v.z, min(v.w + 1.5 * ring, 2.0));
`)

// The works of the peoples (see life.ts): every frame, around each town that has the
// technology, fields are kept green (and the forest cleared for them), irrigation draws
// on the river, the land is terraced towards level, industry and big towns heat the air
// over them (a heat island) and industry fouls its surroundings; a dam is a wall raised
// in a river until the water backs up.
export const worksShader = header + /* wgsl */ `
@group(0) @binding(1) var<storage, read> ground: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> dst: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> extra: array<vec4f>;
@group(0) @binding(4) var<storage, read_write> water: array<vec4f>;
@group(0) @binding(5) var<storage, read_write> climate: array<vec4f>;
// works[0].x: how many; then per work (uv, radius (uv), kind bits), (tech, population, 0, 0)
@group(0) @binding(6) var<storage, read> works: array<vec4f>;
@group(0) @binding(7) var<storage, read_write> air: array<vec4f>;
` + gridMain(/* wgsl */ `
  var g = ground[i];
  let count = u32(works[0].x);
  let uv = uvOf(x, y);
  var e = extra[i];
  var c = climate[i];
  var w = water[i];
  var ar = air[i];
  var touched = false;
  var wet = false;
  var warmed = false;
  for (var k = 0u; k < count; k++) {
    let a = works[1u + k * 2u];
    let b = works[2u + k * 2u];
    let kind = u32(a.w);
    if (kind == 8u) {
      // a dam: a wall across the river (b.xy its direction, a.z half its length), raised bit
      // by bit to its crest (b.z: the bed when it was begun plus DAM_HEIGHT); the water
      // backs up behind it
      let rel = uv - a.xy;
      let along = dot(rel, b.xy);
      let across = abs(rel.x * b.y - rel.y * b.x) * f32(S.size);
      if (abs(along) > a.z || across > 1.2) { continue; }
      let goal = b.z;
      if (g.x < goal) {
        let dh = min(goal - g.x, 0.00005);
        g.y += dh;
        g.x += dh;
        touched = true;
      }
      continue;
    }
    let d = distance(uv, a.xy) / a.z;
    if (d >= 1.0) { continue; }
    let cover = 1.0 - smoothstep(0.6, 1.0, d);
    let dry = w.x < 0.0005 && e.z < 0.0005 && e.w < 0.0005;
    if ((kind & 1u) != 0u && dry) {
      // fields: kept green, and greener than the wild land, as far as the people can work;
      // the forest that stood there is cleared down to the fields
      let crops = 0.55 + 0.4 * b.x;
      e.x = min(e.x + 0.002 * cover * b.x, max(e.x, crops));
      e.x = min(e.x, crops + 0.08 + (1.0 - cover));
      touched = true;
    }
    if ((kind & 16u) != 0u && w.x > 0.0003 && w.x < 0.03) {
      // irrigation: the fields drink from the river, which runs smaller downstream
      w.x -= min(w.x * 0.01 * cover, 0.00002);
      wet = true;
    }
    if ((kind & 32u) != 0u) {
      // a big town: stone and roofs hold the day's heat (a heat island)
      ar.z += 0.006 * cover;
      warmed = true;
    }
    if ((kind & 2u) != 0u && w.x < 0.001) {
      // terracing: the land is levelled towards its surroundings
      let r = 6;
      let mean = (ground[ix(x + r, y)].x + ground[ix(x - r, y)].x + ground[ix(x, y + r)].x + ground[ix(x, y - r)].x) * 0.25;
      let dh = (mean - g.x) * 0.003 * cover * b.x;
      g.y += dh;
      g.x += dh;
      touched = true;
    }
    if ((kind & 4u) != 0u) {
      // industry: heat and smog over the city (in the air itself, so it counts in every
      // climate mode); the plants around it suffer
      c.x = clamp(c.x + (3.5 * cover - max(c.x, 0.0)) * 0.002, -20.0, 20.0);
      ar.z += 0.015 * cover;
      e.x = max(e.x - 0.0006 * cover, 0.0);
      touched = true;
      warmed = true;
    }
  }
  dst[i] = g;
  if (touched) {
    extra[i] = e;
    climate[i] = c;
  }
  if (wet) { water[i] = w; }
  if (warmed) { air[i] = ar; }
`)

// god.shader: the brush adds or removes rock, soil or sand with a noisy profile.
// Brush water (originally in cycle.shader) is applied here too, so painting works while paused.
// The climate brush paints a local temperature offset and a local humidity offset.
export const paintShader = header + simplex + /* wgsl */ `
// °C off the ground's temperature per unit of the air-mass brush's strength
const AIR_MASS_BRUSH = 5.0;
@group(0) @binding(1) var<storage, read_write> ground: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> extra: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> water: array<vec4f>;
@group(0) @binding(4) var<storage, read_write> climate: array<vec4f>;
@group(0) @binding(5) var<storage, read_write> air: array<vec4f>;
@group(0) @binding(6) var<storage, read_write> lava: array<vec4f>;
` + gridMain(/* wgsl */ `
  let uv = uvOf(x, y);
  let s = brushFactor(uv);
  // clearing the fixed air masses: every cell, brush or no brush
  if (S.source.y > 0.5) {
    var a0 = air[i];
    a0.w = packAirW(airHumidityOf(a0.w), 0.0);
    air[i] = a0;
  }
  if (s <= 0.0) { return; }
  var w = water[i];
  w.x = clamp(w.x + s * S.waterF * 0.0001, 0.0, 1.0);
  water[i] = w;
  var c = climate[i];
  c.x = clamp(c.x + s * S.climate2.z * 0.05, -20.0, 20.0);
  // the current brush: the same offset, but only where there is sea to carry it
  if (S.source.z != 0.0 && w.x > 0.002) {
    c.x = clamp(c.x + s * S.source.z * 0.05, -20.0, 20.0);
  }
  climate[i] = c;
  var a = air[i];
  let humidity = airHumidityOf(a.w) + s * S.climate2.w * 0.003;
  // the fixed air-mass brush paints a source in the middle of the brush (as the volcano
  // brush does its vent); the air pass keeps the air there warm or cold from then on
  let source = airSourceOf(a.w) + s * s * s * S.source.x * 0.02;
  a.w = packAirW(humidity, source);
  // the air-mass brush: pulls the air near the ground towards a cold (or warm) mass, so
  // many °C off the ground's own temperature; the wind then carries the mass away (the
  // ground only warms it back slowly, see AIR_COUPLING). A cold mass keeps no more vapour
  // than it can hold, so painting it does not rain by itself.
  if (S.geo.w != 0.0) {
    let massT = groundTemp(ground[i].x + w.x, uv.y, c.x) + clamp(S.geo.w, -4.0, 4.0) * AIR_MASS_BRUSH;
    a.z = mix(a.z, massT, s * 0.1);
    a.x = min(a.x, capacity(a.z));
  }
  air[i] = a;
  // the volcano brush opens (or plugs) a vent in the middle of the brush
  var lv = lava[i];
  lv.z = clamp(lv.z + s * s * s * S.sky.w * 0.02, 0.0, 1.0);
  lava[i] = lv;
  var h = 0.1;
  for (var k = 2; k < 8; k++) {
    let factor = pow(2.0, f32(k));
    h += snoise(vec3f(uv * factor, 0.05 * S.time * f32(k + 1))) / (pow(factor, 0.8) * 6.0);
  }
  var g = ground[i];
  g.y += h * S.rockF * s * 0.01;
  g.z = clamp(g.z + h * S.soilF * s * 0.01, 0.0, 1.0);
  g.w = max(g.w + h * S.sandF * s * 0.01, 0.0);
  // dumping rock or sand buries plants; any digging or dumping clears snow and ice
  let buried = max(S.rockF, 0.0) + max(S.sandF, 0.0) + S.level.x;
  let cleared = 1.0 - clamp(s * (abs(S.rockF) + abs(S.soilF) + abs(S.sandF) + S.level.x) * 0.05, 0.0, 1.0);
  var e = extra[i];
  e.x *= 1.0 - clamp(s * buried * 0.05, 0.0, 1.0);
  e.z *= cleared;
  e.w *= cleared;
  extra[i] = e;
  // leveling: pull the surface towards the stroke's target height, cutting sand,
  // then soil, then rock, and filling with soil
  var change = (S.level.y - (g.y + g.z + g.w + e.w)) * clamp(S.level.x * s * 0.05, 0.0, 1.0);
  if (change > 0.0) {
    g.z += change;
  } else {
    let fromSand = max(change, -g.w);
    g.w += fromSand;
    change -= fromSand;
    let fromSoil = max(change, -g.z);
    g.z += fromSoil;
    g.y += change - fromSoil;
  }
  g.x = g.y + g.z + g.w + e.w + lv.x;
  ground[i] = g;
`)

// normal.shader: normals in the original (u, height, v) convention.
export const normalsShader = header + /* wgsl */ `
@group(0) @binding(1) var<storage, read> ground: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> normals: array<vec4f>;

fn pos(x: i32, y: i32) -> vec3f {
  let uv = uvOf(x, y);
  return vec3f(uv.x * extent(), ground[ix(x, y)].x, uv.y * extent());
}
fn getn(p: vec3f, x: i32, y: i32) -> vec3f {
  let v = pos(x, y) - p;
  let perp = cross(vec3f(0.0, 1.0, 0.0), v);
  return normalize(cross(v, perp));
}
` + gridMain(/* wgsl */ `
  let p = pos(x, y);
  let n = normalize((
    getn(p, x - 1, y + 1) + getn(p, x, y + 1) + getn(p, x + 1, y + 1) +
    getn(p, x - 1, y) + getn(p, x + 1, y) +
    getn(p, x - 1, y - 1) + getn(p, x, y - 1) + getn(p, x + 1, y - 1)
  ) / 8.0);
  normals[i] = vec4f(n, normals[i].w);
`)

// water/normals.shader: same, for the water surface (ground + water depth).
export const waterNormalsShader = header + /* wgsl */ `
@group(0) @binding(1) var<storage, read> ground: array<vec4f>;
@group(0) @binding(2) var<storage, read> water: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> wnormals: array<vec4f>;

fn pos(x: i32, y: i32) -> vec3f {
  let uv = uvOf(x, y);
  let j = ix(x, y);
  return vec3f(uv.x * extent(), ground[j].x + water[j].x, uv.y * extent());
}
fn getn(p: vec3f, x: i32, y: i32) -> vec3f {
  let v = pos(x, y) - p;
  let perp = cross(vec3f(0.0, 1.0, 0.0), v);
  return normalize(cross(v, perp));
}
` + gridMain(/* wgsl */ `
  let p = pos(x, y);
  let n = normalize((
    getn(p, x - 1, y + 1) + getn(p, x, y + 1) + getn(p, x + 1, y + 1) +
    getn(p, x - 1, y) + getn(p, x + 1, y) +
    getn(p, x - 1, y - 1) + getn(p, x, y - 1) + getn(p, x + 1, y - 1)
  ) / 8.0);
  wnormals[i] = vec4f(n, 1.0);
`)

// occlusion.shader: ambient occlusion from 32 spiral samples, stored in normals.w.
// Samples the nearest texel instead of filtering; the 32-sample average hides it.
export const occlusionShader = header + /* wgsl */ `
@group(0) @binding(1) var<storage, read> ground: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> normals: array<vec4f>;
` + nearest('sampleGround', 'ground') + slicedMain(/* wgsl */ `
  let N = f32(S.size);
  let raylength = 10.0 * cellsPerUnit() / 512.0;
  let uv = uvOf(x, y);
  let p = vec3f(uv.x * extent(), ground[i].x, uv.y * extent());
  let nv = normals[i];
  let normal = nv.xyz;
  let tangent = normalize(cross(normal, vec3f(0.0, 0.0, 1.0)));
  let bitangent = normalize(cross(tangent, normal));
  let basis = mat3x3f(tangent, normal, bitangent);
  var occlusion = 0.0;
  for (var k = 1; k < 33; k++) {
    let s = f32(k) / 32.0;
    let a = sqrt(s * 512.0);
    let b = sqrt(s);
    let o = basis * vec3f(sin(a) * b * raylength, 0.0, cos(a) * b * raylength);
    let suv = uv + o.xz / N;
    let sp = vec3f(suv.x * extent(), sampleGround(suv).x, suv.y * extent());
    let dir = normalize(sp - p);
    let lambert = clamp(dot(normal, dir), 0.0, 1.0);
    let distFactor = 0.23 / sqrt(length(sp - p));
    occlusion += distFactor * lambert;
  }
  normals[i] = vec4f(normal, 1.0 - occlusion / 32.0);
`)

// Replaces the original shadow-map + blur passes: a soft-shadow ray march through
// the heightfield towards the sun. x = terrain shadow, y = water surface shadow.
export const shadowShader = header + /* wgsl */ `
@group(0) @binding(1) var<storage, read> ground: array<vec4f>;
@group(0) @binding(2) var<storage, read> water: array<vec4f>;
@group(0) @binding(3) var<storage, read> normals: array<vec4f>;
@group(0) @binding(4) var<storage, read> wnormals: array<vec4f>;
@group(0) @binding(5) var<storage, read_write> shadow: array<vec4f>;
` + bilinear('sampleGround', 'ground') + nearest('nearestGround', 'ground') + /* wgsl */ `
fn march(uv0: vec2f, h0: f32) -> f32 {
  let N = f32(S.size);
  // world (x, z) = (u - 0.5, 0.5 - v)
  let dirUV = normalize(vec2f(S.lightDir.x, -S.lightDir.z));
  var t = 1.0 / N;
  var lit = 1.0;
  for (var k = 0; k < 96; k++) {
    let uv = uv0 + dirUV * t;
    if (any(uv < vec2f(0.0)) || any(uv > vec2f(1.0))) { break; }
    // filtered lookups near the start (where aliasing shows), nearest further out
    var occluder: f32;
    if (k < 6) { occluder = sampleGround(uv).x; } else { occluder = nearestGround(uv).x; }
    let tw = t * extent();
    let above = h0 + tw * S.lightTan + 0.0004 - occluder;
    lit = min(lit, above / (tw * 0.06 + 0.0015));
    if (lit <= 0.0) { break; }
    t += max(1.0 / N, t * 0.04);
  }
  return clamp(lit, 0.0, 1.0);
}

fn facing(n: vec3f) -> f32 {
  let world = normalize(vec3f(n.x, n.y, -n.z));
  return smoothstep(0.02, 0.15, dot(world, S.lightDir.xyz));
}
` + slicedMain(/* wgsl */ `
  let uv = uvOf(x, y);
  let g = ground[i].x;
  let depth = water[i].x;
  let fromGround = march(uv, g);
  // dry texels (most of the map) share one march for both surfaces
  var fromWater = fromGround;
  if (depth > 0.00001) { fromWater = march(uv, g + depth); }
  // (z is the accumulated height change, filled in by changeShader right after)
  shadow[i] = vec4f(min(fromGround, facing(normals[i].xyz)), min(fromWater, facing(wnormals[i].xyz)), shadow[i].zw);
`)

// How much the ground has risen (+) or been worn down (−) since the reference terrain
// (taken when it was generated, loaded or reset from the Map panel), for the Change map.
// Stored in shadow.z because the terrain's fragment stage has no storage buffer to spare.
export const changeShader = header + /* wgsl */ `
@group(0) @binding(1) var<storage, read> ground: array<vec4f>;
@group(0) @binding(2) var<storage, read> baseline: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> shadow: array<vec4f>;
` + gridMain(/* wgsl */ `
  let s = shadow[i];
  shadow[i] = vec4f(s.xy, ground[i].x - baseline[i].x, s.w);
`)

// Mouse picking: march the camera ray against the terrain + water surface.
// result = (u, v, height, hit ? 1 : -1)
export const pickShader = header + /* wgsl */ `
@group(0) @binding(1) var<storage, read> ground: array<vec4f>;
@group(0) @binding(2) var<storage, read> water: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> result: vec4f;
` + bilinear('sampleGround', 'ground') + bilinear('sampleWater', 'water') + /* wgsl */ `
fn surface(p: vec3f) -> f32 {
  let uv = vec2f(p.x / extent() + 0.5, 0.5 - p.z / extent());
  return sampleGround(uv).x + sampleWater(uv).x;
}

@compute @workgroup_size(1)
fn main() {
  let o = S.rayOrigin.xyz;
  let d = normalize(S.rayDir.xyz);
  let inv = 1.0 / select(d, vec3f(1e-6), abs(d) < vec3f(1e-6));
  let half = 0.5 * extent();
  let t0 = (vec3f(-half, -1.0, -half) - o) * inv;
  let t1 = (vec3f(half, 1.0, half) - o) * inv;
  let tmin = max(max(min(t0.x, t1.x), min(t0.y, t1.y)), max(min(t0.z, t1.z), 0.0));
  let tmax = min(min(max(t0.x, t1.x), max(t0.y, t1.y)), max(t0.z, t1.z));
  result = vec4f(0.0, 0.0, 0.0, -1.0);
  if (tmax <= tmin) { return; }
  let steps = 1024;
  let dt = (tmax - tmin) / f32(steps);
  var prev = tmin;
  for (var k = 0; k <= steps; k++) {
    let t = tmin + dt * f32(k);
    let p = o + d * t;
    if (p.y <= surface(p)) {
      var lo = prev;
      var hi = t;
      for (var r = 0; r < 12; r++) {
        let mid = 0.5 * (lo + hi);
        let q = o + d * mid;
        if (q.y <= surface(q)) { hi = mid; } else { lo = mid; }
      }
      let hit = o + d * hi;
      result = vec4f(hit.x / extent() + 0.5, 0.5 - hit.z / extent(), hit.y, 1.0);
      return;
    }
    prev = t;
  }
}
`

// Slides a buffer when the simulation window moves through the infinite world:
// cell (x, y) takes what was at (x + dx, y + dy); cells coming in from outside start
// empty and are then generated or restored.
// The same for a buffer with one float per cell (the fine sediment).
export const shiftScalarShader = /* wgsl */ `
struct Shift { size: u32, pad: u32, dx: i32, dy: i32 }
@group(0) @binding(0) var<uniform> P: Shift;
@group(0) @binding(1) var<storage, read> src: array<f32>;
@group(0) @binding(2) var<storage, read_write> dst: array<f32>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let n = i32(P.size);
  if (i32(id.x) >= n || i32(id.y) >= n) { return; }
  let sx = i32(id.x) + P.dx;
  let sy = i32(id.y) + P.dy;
  var v = 0.0;
  if (sx >= 0 && sy >= 0 && sx < n && sy < n) { v = src[u32(sy * n + sx)]; }
  dst[id.y * u32(n) + id.x] = v;
}
`

export const shiftShader = /* wgsl */ `
struct Shift { size: u32, pad: u32, dx: i32, dy: i32 }
@group(0) @binding(0) var<uniform> P: Shift;
@group(0) @binding(1) var<storage, read> src: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> dst: array<vec4f>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let n = i32(P.size);
  if (i32(id.x) >= n || i32(id.y) >= n) { return; }
  let sx = i32(id.x) + P.dx;
  let sy = i32(id.y) + P.dy;
  var v = vec4f(0.0);
  if (sx >= 0 && sy >= 0 && sx < n && sy < n) { v = src[u32(sy * n + sx)]; }
  dst[id.y * u32(n) + id.x] = v;
}
`

// Heights for the distant terrain around the window, from the same noise as the
// generator (fewer octaves: the details are far smaller than its texels).
export const FAR_GRID = 384
export const FAR_TEXELS_PER_WINDOW = 64
export const farShader = header + simplex + terrainNoise + /* wgsl */ `
@group(0) @binding(1) var<storage, read_write> far: array<f32>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let G = ${FAR_GRID}u;
  if (id.x >= G || id.y >= G) { return; }
  // the far grid is centred on the window, ${FAR_TEXELS_PER_WINDOW} texels per window width
  let texel = 1.0 / ${FAR_TEXELS_PER_WINDOW}.0;
  let uv = vec2f(f32(id.x), f32(id.y)) * texel - f32(G) * texel * 0.5 + 0.5;
  far[id.y * G + id.x] = terrainHeight(worldUV(uv), 7);
}
`
