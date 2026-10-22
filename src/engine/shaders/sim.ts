// Compute shaders for the erosion / water simulation.
// Ported from the original Craftscape GLSL passes by Florian Boesch (AGPL-3.0).
//
// Buffers are array<vec4f> of size N×N, row-major (index = y*N + x):
//   ground:  x = total height (rock + soil + sand + ice), y = rock, z = soil, w = sand
//   water:   x = depth, yz = flux/velocity along +x/+y, w = coarse sediment (sand) carried, in height units; the fine buffer holds the silt and clay
//   extra:   x = vegetation density, y = moisture, z = snowpack (water equivalent), w = ice thickness
//   air:     x = water vapour (1 = saturated at 15 °C), y = precipitation this step,
//            z = air temperature (°C), w = local humidity offset painted by the brush
//   climate: x = local temperature offset painted by the brush (°C), y = relative humidity,
//            z = mean precipitation (1 = the original uniform rain), w = temperature (°C)
//   wind:    (flowSize², a quarter of the resolution) xy = wind in low-res cells per step,
//            z = solver pressure, w = weather pressure anomaly (lows < 0 < highs)
//   lava:    x = molten lava thickness, y = lava temperature (1 = fresh, solidifies near 0),
//            z = volcanic vent strength painted by the brush,
//            w = tectonic uplift painted by the brush (−1 sinking … 1 rising)
// ground.x also counts molten lava, so water and lava run over each other.
// Neighbours past the border are clamped, like CLAMP_TO_EDGE in the original.

export const SIM_UNIFORM_SIZE = 272

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
  geo: vec4f,       // x: geological time (multiplies erosion, weathering and uplift), y: tectonic brush rate
}
@group(0) @binding(0) var<uniform> S: Sim;

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

// Sediment transport (see sedimentShader): how much fast water on steep ground can carry,
// and how quickly it picks up or drops the difference.
const SED_CAPACITY = 0.0075;
const SED_ERODE = 0.04;
// sand (carried in water.w) settles fast, silt and clay (the fine buffer) ten times slower
const SED_DEPOSIT = 0.12;
const SED_DEPOSIT_FINE = 0.012;
// share of the capacity that is coarse
const COARSE_SHARE = 0.5;
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
// (mostly by being pushed up a mountain) rains it out. Air coming down the far side
// warms up and holds its vapour, so the lee of a range stays dry (rain shadow).
// Also computes each cell's temperature and its long-run precipitation (for biomes).
// The atmosphere changes slowly, so it may run only every S.climateDt steps (multirate):
// its rates are scaled to cover that many steps, and the precipitation it leaves in
// air.y is per step, so the water cycle keeps applying it on the steps in between.
export const airShader = header + /* wgsl */ `
@group(0) @binding(1) var<storage, read> ground: array<vec4f>;
@group(0) @binding(2) var<storage, read> water: array<vec4f>;
@group(0) @binding(3) var<storage, read> extra: array<vec4f>;
@group(0) @binding(4) var<storage, read> airIn: array<vec4f>;
@group(0) @binding(5) var<storage, read_write> airOut: array<vec4f>;
@group(0) @binding(6) var<storage, read_write> climate: array<vec4f>;
@group(0) @binding(7) var<storage, read> wind: array<vec4f>;
@group(0) @binding(8) var<storage, read> shadow: array<vec4f>;
` + bilinear('sampleAir', 'airIn') + bilinear('sampleWind', 'wind', 'S.flowSize') + gridMain(/* wgsl */ `
  let uv = uvOf(x, y);
  let D = S.climateDt;
  let depth = water[i].x;
  let local = sampleWind(uv);
  let surface = ground[i].x + depth;
  var c = climate[i];
  let tGround = groundTemp(surface, uv.y, c.x);

  // advect from upwind, with a little diffusion so the field stays smooth
  let back = uv - local.xy * D / f32(S.flowSize);
  let d = 1.0 / f32(S.size);
  let backC = clamp(back, vec2f(0.0), vec2f(1.0));
  var a = sampleAir(backC) * 0.8 + (
    sampleAir(clamp(back + vec2f(d, 0.0), vec2f(0.0), vec2f(1.0))) +
    sampleAir(clamp(back - vec2f(d, 0.0), vec2f(0.0), vec2f(1.0))) +
    sampleAir(clamp(back + vec2f(0.0, d), vec2f(0.0), vec2f(1.0))) +
    sampleAir(clamp(back - vec2f(0.0, d), vec2f(0.0), vec2f(1.0)))
  ) * 0.05;
  // fresh air blows in across the upwind border
  if (any(back != backC)) {
    a.x = S.wind.z * capacity(tGround);
    a.z = tGround;
  }
  // the painted humidity is kept, but only acts in manual climate
  let offset = airIn[i].w;
  let painted = offset * (1.0 - S.world.z);

  // air slowly takes the temperature of the ground under it
  a.z = mix(a.z, tGround, 1.0 - pow(0.97, D));
  // the sun heats the ground and the air over it by day (land much more than water,
  // snow hardly at all, slopes facing the sun most); clear nights cool it down
  let n = normalize(vec3f(
    -(ground[ix(x + 1, y)].x - ground[ix(x - 1, y)].x) * cellsPerUnit() * 0.5, 1.0,
    (ground[ix(x, y + 1)].x - ground[ix(x, y - 1)].x) * cellsPerUnit() * 0.5));
  let sea = smoothstep(0.0002, 0.002, depth);
  let e = extra[i];
  let absorbs = (1.0 - 0.8 * sea) * (1.0 - 0.6 * smoothstep(0.0, 0.001, e.z + e.w));
  let sun = S.sky.z * max(dot(n, S.lightDir.xyz), 0.0) * shadow[i].x;
  a.z += 0.18 * sun * absorbs * D;
  a.z -= 0.06 * (1.0 - S.sky.z) * (1.0 - 0.7 * clamp(c.y, 0.0, 1.0)) * (1.0 - 0.8 * sea) * D;
  let t = mix(tGround, a.z, 0.35);
  // air rises in lows (cools, clouds, rain) and sinks in highs (dry, clear)
  let cap = capacity(t) * clamp(1.0 + 0.25 * local.w, 0.6, 1.4);

  // sources: open water (the sea most of all), plants, and the humidity brush
  let wet = sea * (1.0 - frozen(t));
  a.x = mix(a.x, 0.95 * cap, 1.0 - pow(1.0 - 0.02 * wet, D));
  a.x += 0.0004 * extra[i].x * cap * max(1.0 - a.x / cap, 0.0) * D;
  a.x = max(a.x + 0.01 * painted * cap * D, 0.0);

  // sinks: condensation of anything above capacity, plus a light drizzle in humid air
  let rh = a.x / cap;
  let p = min((max(a.x - cap, 0.0) * 0.01 + a.x * 0.0008 * smoothstep(0.2, 1.0, rh)) * D, a.x);
  a.x -= p;
  a.z += p * 6.0;  // latent heat: air that has rained out comes down the lee warmer
  a.y = p / D;
  a.w = offset;
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

// How much warmer the air over a wind cell is than its ground's own temperature.
const airAnomaly = /* wgsl */ `
fn anomaly(x: i32, y: i32) -> f32 {
  let n = i32(S.flowSize);
  let cx = clamp(x, 0, n - 1) * 4 + 2;
  let cy = clamp(y, 0, n - 1) * 4 + 2;
  let j = ix(cx, cy);
  let v = (f32(cy) + 0.5) / f32(S.size);
  return air[j].z - groundTemp(ground[j].x + water[j].x, v, climate[j].x);
}
`

export const windForceShader = header + /* wgsl */ `
@group(0) @binding(1) var<storage, read> ground: array<vec4f>;
@group(0) @binding(2) var<storage, read> windIn: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> windOut: array<vec4f>;
@group(0) @binding(4) var<storage, read> water: array<vec4f>;
@group(0) @binding(5) var<storage, read> air: array<vec4f>;
@group(0) @binding(6) var<storage, read> climate: array<vec4f>;
` + bilinear('sampleGround', 'ground') + bilinear('sampleWindIn', 'windIn', 'S.flowSize') + airAnomaly + /* wgsl */ `
fn weatherAt(x: i32, y: i32) -> f32 { return windIn[wix(x, y)].w; }

// Prevailing wind of the latitude belts (world v: −1 tropics … 2 polar).
fn planetary(uv: vec2f) -> vec2f {
  let lat = clamp(worldUV(uv).y, -1.0, 2.0);
  let trades = 1.0 - smoothstep(-0.3, 0.2, lat);
  let polar = smoothstep(1.2, 1.6, lat);
  let westerlies = 1.0 - trades - polar;
  return (vec2f(-1.0, -0.3) * trades + vec2f(1.0, 0.25) * westerlies + vec2f(-1.0, -0.25) * polar) * length(S.wind.xy);
}
` + windMain(/* wgsl */ `
  let F = f32(S.flowSize);
  let uv = (vec2f(f32(x), f32(y)) + 0.5) / F;
  var v = windIn[i];

  let base = select(S.wind.xy, planetary(uv), S.world.z > 0.5);

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
    // heating relative to the surroundings (8 low-res cells away), so there are highs as well as lows
    let r = 8;
    let surroundings = (anomaly(x + r, y) + anomaly(x - r, y) + anomaly(x, y + r) + anomaly(x, y - r)) * 0.25;
    // Pressure is relative to the window's mean: the heating forcing is not exactly balanced
    // (the borders, the sea), and left alone it lifts the whole field until there are no
    // lows anywhere, so the measured mean is slowly taken out again.
    P = clamp(P * 0.999 - 0.0003 * (anomaly(x, y) - surroundings) * S.sky.y - S.level.w * 0.003, -2.0, 2.0);
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

export const windProjectShader = header + /* wgsl */ `
@group(0) @binding(1) var<storage, read> windIn: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> windOut: array<vec4f>;

fn pressure(x: i32, y: i32) -> f32 { return select(0.0, windIn[wix(x, y)].z, inside(x, y)); }
fn weatherAt(x: i32, y: i32) -> f32 { return windIn[wix(x, y)].w; }
` + windMain(/* wgsl */ `
  let F = f32(S.flowSize);
  let v = windIn[i];
  let g = 0.5 * vec2f(pressure(x + 1, y) - pressure(x - 1, y), pressure(x, y + 1) - pressure(x, y - 1));
  // air leaks from highs into lows
  let gradP = 0.5 * vec2f(weatherAt(x + 1, y) - weatherAt(x - 1, y), weatherAt(x, y + 1) - weatherAt(x, y - 1)) * F;
  windOut[i] = vec4f(v.xy - g - 0.0001 * gradP * F, v.z, v.w);
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
  // off and on open water it melts into
  let precip = a.y * rainWater() * S.rain;
  let slope = (abs(ground[ix(x + 1, y)].x - ground[ix(x - 1, y)].x) + abs(ground[ix(x, y + 1)].x - ground[ix(x, y - 1)].x)) * cellsPerUnit() * 0.5;
  let sticks = (1.0 - smoothstep(0.8, 1.5, slope)) * (1.0 - smoothstep(0.0003, 0.001, w.x));
  w.x += precip * (1.0 - cold) + precip * cold * (1.0 - sticks);
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
  extra[i] = e;

  let g = ground[i];
  let sea = S.climate.w > 0.5 && h < S.climate.z;
  if (!sea) {
    let surface = 0.00000015 * capacity(t) * (1.0 - 0.6 * clamp(c.y, 0.0, 1.0)) + 0.00002 * w.x;
    let evaporated = min(w.x, surface * (1.0 - cold) * S.evaporate);
    w.x -= evaporated;
    // moisture recycling: what evaporates from rivers, lakes and wet ground goes back
    // into the air as vapour (the same water, in the air pass's units) and rains again
    // further downwind, which is how humid air reaches deep into a continent
    a.x += evaporated / max(rainWater(), 0.000001);
    let permeable = smoothstep(0.0, 0.002, g.z + g.w) * (1.0 - cold);
    w.x -= min(w.x, 0.000000015 * permeable);
  }
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
  let slope = length(vec2f(ground[ix(x + 1, y)].x - ground[ix(x - 1, y)].x,
                           ground[ix(x, y + 1)].x - ground[ix(x, y - 1)].x)) * 0.5 * cellsPerUnit();
  let capacity = streamCapacity(length(vel), slope) * wet;
  let capCoarse = capacity * COARSE_SHARE;
  let capFine = capacity * (1.0 - COARSE_SHARE);
  let gone = wet < 0.01;
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
    var want = min(room * SED_ERODE * S.erode, 0.0002 * max(S.geo.x, 1.0));
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
  // tectonics: painted zones keep rising (or sinking), so erosion has mountains to wear
  // down instead of only ever flattening the land; geological time speeds it up
  g.y += lv.w * UPLIFT_RATE * S.geo.x;

  g.x = g.y + g.z + g.w + e.w + lv.x;
  dst[i] = g;

  // moisture follows standing/flowing water and seeps into neighbours; it dries
  // faster where it is hot
  let wet = clamp(w.x / 0.0005, 0.0, 1.0);
  let around = (extra[ix(x + 1, y)].y + extra[ix(x - 1, y)].y + extra[ix(x, y + 1)].y + extra[ix(x, y - 1)].y) * 0.25;
  e.y = max(mix(e.y, around, 0.2) * (1.0 - 0.0005 * capacity(t)), wet);
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
  let sdiff = clamp(diff, -g1.z / 2.0, g2.z / 2.0) * 0.08;
  // rock slumps once the step is steep enough; hard rock (judged on the higher side, so
  // both cells agree and rock is conserved) stands in steeper cliffs and gives way slower
  var hx = x1;
  var hy = y1;
  var top = g1.y;
  if (diff > 0.0) { hx = x; hy = y; top = g2.y; }
  let hard = rockHardness(worldUV(uvOf(hx, hy)), top, S.seed);
  var gdiff = 0.0;
  if (abs(diff) > 0.001 * hard) { gdiff = diff * 0.1 / hard; }
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
  let mobile = smoothstep(0.0003, 0.004, max(ice1, ice2));
  let diff = (src[j].x - g1.x) * 0.25;
  return clamp(diff * 0.05 * mobile, -ice1 * 0.2, ice2 * 0.2);
}

// Sand that the wind can lift from a cell: dry, bare, not under water, snow or ice.
fn windborne(x: i32, y: i32) -> f32 {
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
  let abraded = min(moved * 0.15 * S.erode, max(g.y + c.x, 0.0));
  e.w = max(e.w + ice, 0.0);
  // hot lava melts snow and ice and burns plants
  let lv = lava[i];
  let burning = smoothstep(0.0, 0.0003, lv.x) * smoothstep(0.1, 0.4, lv.y);
  e.z *= 1.0 - 0.1 * burning;
  e.w *= 1.0 - 0.05 * burning;

  g.y += c.x - abraded - blasted;
  g.z += c.y + abraded - blown;
  g.w = max(g.w + sand + blasted + blown, 0.0);
  g.x = g.y + g.z + g.w + e.w + lv.x;
  dst[i] = g;

  let depth = water[i].x;
  let cl = climate[i];
  let t = cl.w;

  // vegetation: grows on moist soil that is not under water, snow or ice, up to what
  // the climate supports; dies when drowned, bare, frozen or parched
  let slope = (abs(src[ix(x + 1, y)].x - src[ix(x - 1, y)].x) + abs(src[ix(x, y + 1)].x - src[ix(x, y - 1)].x)) * cellsPerUnit() * 0.5;
  let soilOk = smoothstep(0.0002, 0.001, g.z);
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

// god.shader: the brush adds or removes rock, soil or sand with a noisy profile.
// Brush water (originally in cycle.shader) is applied here too, so painting works while paused.
// The climate brush paints a local temperature offset and a local humidity offset.
export const paintShader = header + simplex + /* wgsl */ `
@group(0) @binding(1) var<storage, read_write> ground: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> extra: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> water: array<vec4f>;
@group(0) @binding(4) var<storage, read_write> climate: array<vec4f>;
@group(0) @binding(5) var<storage, read_write> air: array<vec4f>;
@group(0) @binding(6) var<storage, read_write> lava: array<vec4f>;
` + gridMain(/* wgsl */ `
  let uv = uvOf(x, y);
  let s = brushFactor(uv);
  if (s <= 0.0) { return; }
  var w = water[i];
  w.x = clamp(w.x + s * S.waterF * 0.0001, 0.0, 1.0);
  water[i] = w;
  var c = climate[i];
  c.x = clamp(c.x + s * S.climate2.z * 0.05, -20.0, 20.0);
  climate[i] = c;
  var a = air[i];
  a.w = clamp(a.w + s * S.climate2.w * 0.003, -1.0, 1.0);
  air[i] = a;
  // the volcano brush opens (or plugs) a vent in the middle of the brush
  var lv = lava[i];
  lv.z = clamp(lv.z + s * s * s * S.sky.w * 0.02, 0.0, 1.0);
  // the tectonic brush marks zones that rise (or sink) from now on
  lv.w = clamp(lv.w + s * S.geo.y * 0.02, -1.0, 1.0);
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
  shadow[i] = vec4f(min(fromGround, facing(normals[i].xyz)), min(fromWater, facing(wnormals[i].xyz)), shadow[i].z, 0.0);
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
