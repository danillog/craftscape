// Render shaders: terrain, water, sky, clouds, wind arrows and the distant terrain.
// Shading ported from the original display.shader / water/display.shader by
// Florian Boesch (AGPL-3.0): spherical-harmonics "beach" lighting, Rayleigh-ish
// absorption fog and a 1/1.8 gamma.

import { FAR_GRID, FAR_TEXELS_PER_WINDOW, weatheringModel } from './sim'

export const CAMERA_UNIFORM_SIZE = 368

const common = /* wgsl */ `
struct Cam {
  viewProj: mat4x4f,
  view: mat4x4f,
  invViewProj: mat4x4f,
  eye: vec4f,
  light: vec4f,     // xyz: direction towards the light casting shadows (sun by day, moon by night)
  brush: vec4f,     // uv.x, uv.y, radius, visible
  params: vec4f,    // N, flow size, overlay (0 none, 1 biome, 2 temperature, 3 rain, 4 humidity, 5 pressure, 6 erosion,
                    // 7 change, 8 rivers), time
  chunk: vec4f,     // cells per chunk, chunks per side, unused, ring inner radius
  viewport: vec4f,
  sun: vec4f,       // xyz: direction towards the sun (may be below the horizon), w: daylight
  clouds: vec4f,    // xy: cloud drift (uv), z: simulated seconds
  world: vec4f,     // xy: window origin in the world (window widths), z: infinite world on,
                    // w: simulated area, the window's width in world units
  far: vec4f,       // distant terrain: sea level, ocean on, temperature at height 0, lapse rate
  far2: vec4f,      // x: north–south temperature difference per window, y: terrain seed
}
@group(0) @binding(0) var<uniform> C: Cam;

const Kr = vec3f(0.18867780436772762, 0.4978442963618773, 0.6616065586417131);

fn absorb(dist: f32, color: vec3f, factor: f32) -> vec3f {
  return color - color * pow(Kr, vec3f(factor / dist));
}

fn finish(incident: vec3f) -> vec3f { return pow(max(incident, vec3f(0.0)), vec3f(1.0 / 1.8)); }

fn shLight(n: vec3f) -> vec3f {
  let L00 = vec3f(0.6841148, 0.6929004, 0.7069543);
  let L1m1 = vec3f(0.3173355, 0.3694407, 0.4406839);
  let L10 = vec3f(-0.1747193, -0.1737154, -0.1657420);
  let L11 = vec3f(-0.4496467, -0.4155184, -0.3416573);
  let L2m2 = vec3f(-0.1690202, -0.1703022, -0.1525870);
  let L2m1 = vec3f(-0.0837808, -0.0940454, -0.1027518);
  let L20 = vec3f(-0.0319670, -0.0214051, -0.0147691);
  let L21 = vec3f(0.1641816, 0.1377558, 0.1010403);
  let L22 = vec3f(0.3697189, 0.3097930, 0.2029923);
  let C1 = 0.429043;
  let C2 = 0.511664;
  let C3 = 0.743125;
  let C4 = 0.886227;
  let C5 = 0.247708;
  return C1 * L22 * (n.x * n.x - n.y * n.y) + C3 * L20 * n.z * n.z + C4 * L00 - C5 * L20 +
    2.0 * C1 * L2m2 * n.x * n.y + 2.0 * C1 * L21 * n.x * n.z + 2.0 * C1 * L2m1 * n.y * n.z +
    2.0 * C2 * L11 * n.x + 2.0 * C2 * L1m1 * n.y + 2.0 * C2 * L10 * n.z;
}

// Window uv → world position (the window spans C.world.w units; its origin moves through the world).
fn worldPos(uv: vec2f, h: f32) -> vec3f {
  return vec3f((uv.x - 0.5 + C.world.x) * C.world.w, h, (0.5 - uv.y - C.world.y) * C.world.w);
}

// Colour of the sky in a direction (display space, like the sky pass draws it), without the
// sun disc, moon and stars: the gradient, night and the sunrise / sunset glow.
fn skyColor(dir: vec3f) -> vec3f {
  let sunDir = C.sun.xyz;
  var dayColor = mix(vec3f(0.78, 0.84, 0.9), vec3f(0.33, 0.52, 0.8), smoothstep(0.0, 0.7, dir.y));
  dayColor = mix(dayColor, vec3f(0.62, 0.68, 0.74), smoothstep(0.0, -0.4, dir.y));
  var nightColor = mix(vec3f(0.035, 0.045, 0.09), vec3f(0.008, 0.012, 0.035), smoothstep(0.0, 0.7, dir.y));
  nightColor = mix(nightColor, vec3f(0.03, 0.035, 0.05), smoothstep(0.0, -0.4, dir.y));
  var color = mix(nightColor, dayColor, C.sun.w);
  let low = 1.0 - smoothstep(0.0, 0.35, abs(sunDir.y));
  let flatDir = normalize(vec3f(dir.x, 0.0, dir.z) + vec3f(0.00001, 0.0, 0.0));
  let flatSun = normalize(vec3f(sunDir.x, 0.0, sunDir.z) + vec3f(0.00001, 0.0, 0.0));
  let towards = max(dot(flatDir, flatSun), 0.0);
  color += vec3f(0.95, 0.42, 0.15) * low * pow(towards, 3.0) * (1.0 - smoothstep(-0.05, 0.45, dir.y)) * 0.7;
  return color;
}

// Open water seen from above: the sky mirrored at grazing angles (Schlick's Fresnel)
// over the water's own colour, in the incident (pre-gamma) space that finish() expects.
fn waterSurface(body: vec3f, eyeDir: vec3f, normal: vec3f) -> vec3f {
  let cosTheta = clamp(dot(-eyeDir, normal), 0.0, 1.0);
  let fresnel = 0.02 + 0.98 * pow(1.0 - cosTheta, 5.0);
  var r = reflect(eyeDir, normal);
  r.y = abs(r.y);
  let sky = pow(skyColor(r), vec3f(1.8));
  return mix(body, sky, clamp(fresnel, 0.0, 0.85));
}

// The air between the eye and a surface: the original absorption and blue scattering
// close by, fading into the sky colour behind the surface further away, so distant land
// blends into the horizon. Distances are in window widths, so a bigger simulated area,
// seen from proportionally further away, looks as clear as the classic one.
fn aerial(exident: vec3f, world: vec3f) -> vec3f {
  let d = distance(world, C.eye.xyz) / C.world.w;
  let near = absorb(d, exident, 2.5) + pow(Kr * min(d, 1.2) * 0.7, vec3f(2.0)) * lightColor();
  let haze = 1.0 - exp(-pow(d / 2.9, 2.0));
  let behind = pow(skyColor(normalize(world - C.eye.xyz)), vec3f(1.8));
  return mix(near, behind, haze);
}

// Colour of the light: white by day, orange low in the sky, dim blue moonlight at night.
fn lightColor() -> vec3f {
  let sunColor = mix(vec3f(1.0, 0.55, 0.3), vec3f(1.0), smoothstep(0.05, 0.35, C.sun.y));
  return mix(vec3f(0.13, 0.16, 0.28), sunColor, C.sun.w);
}
`

// Terrain and water have separate bind group layouts: together they need more
// storage buffers than one fragment stage may bind.
const terrainBindings = /* wgsl */ `
@group(0) @binding(1) var<storage, read> chunks: array<u32>;
@group(0) @binding(2) var<storage, read> ground: array<vec4f>;
@group(0) @binding(3) var<storage, read> water: array<vec4f>;
@group(0) @binding(4) var<storage, read> normals: array<vec4f>;
@group(0) @binding(5) var<storage, read> extra: array<vec4f>;
@group(0) @binding(6) var<storage, read> shadow: array<vec4f>;
// x: painted temperature offset, y: relative humidity, z: mean rain, w: temperature (°C)
@group(0) @binding(7) var<storage, read> climate: array<vec4f>;
// x: molten lava thickness, y: lava temperature
@group(0) @binding(8) var<storage, read> lava: array<vec4f>;
// low resolution; w: weather pressure anomaly
@group(0) @binding(9) var<storage, read> wind: array<vec4f>;

fn sNormals(t: Taps) -> vec4f { return lerp4(normals[t.i00], normals[t.i10], normals[t.i01], normals[t.i11], t.f); }
fn sExtra(t: Taps) -> vec4f { return lerp4(extra[t.i00], extra[t.i10], extra[t.i01], extra[t.i11], t.f); }
fn sLava(t: Taps) -> vec4f { return lerp4(lava[t.i00], lava[t.i10], lava[t.i01], lava[t.i11], t.f); }
fn pressureAt(uv: vec2f) -> f32 {
  let n = i32(C.params.y);
  let t = uv * f32(n) - 0.5;
  let b = vec2i(floor(t));
  let f = fract(t);
  return mix(mix(wind[ixn(b.x, b.y, n)].w, wind[ixn(b.x + 1, b.y, n)].w, f.x),
             mix(wind[ixn(b.x, b.y + 1, n)].w, wind[ixn(b.x + 1, b.y + 1, n)].w, f.x), f.y);
}

// Erosion map: which process wears the land down here and how hard, with the
// simulation's own rates, each divided by a typical strong rate so they compare.
// Water cutting (rivers, surf) blue, sediment settling (deltas, lake beds) green, wind
// amber, ice and frost violet, heat orange.
fn erosionAt(uv: vec2f) -> vec4f {
  let t = taps(uv);
  let g = sGround(t);
  let w = sWater(t).xyz;
  let e = sExtra(t);
  let c = sClimate(t);
  let exposed = rockExposure(g.z, e.w);
  let rain = clamp(c.z, 0.0, 3.0);

  let n = i32(C.params.x);
  let p = vec2i(floor(uv * f32(n)));
  var deepest = 0.0;
  for (var dy = -2; dy <= 2; dy += 2) {
    for (var dx = -2; dx <= 2; dx += 2) {
      if (dx != 0 || dy != 0) { deepest = max(deepest, water[ixn(p.x + dx, p.y + dy, n)].x); }
    }
  }
  // running water, from the sediment model: cutting where it can carry more than it
  // does, depositing where it carries too much
  let flowing = sWater(t);
  let nrm = sNormals(t).xyz;
  let slope = length(nrm.xz) / max(nrm.y, 0.05);
  // (judged on the sand, the coarse half of the load, which settles where the water slows)
  let capacity = streamCapacity(length(waterVelocity(flowing)), slope) * smoothstep(0.00002, 0.0005, flowing.x) * COARSE_SHARE;
  let cutting = max(capacity - flowing.w, 0.0) * SED_ERODE / 0.000002;
  let depositing = max(flowing.w - capacity, 0.0) * SED_DEPOSIT / 0.00001;
  let surf = surfEnergy(deepest, w.x) * SURF_RATE / 0.000001;
  let byWater = max(cutting, surf);

  let F = i32(C.params.y);
  let wt = uv * f32(F) - 0.5;
  let wb = vec2i(floor(wt));
  let wf = fract(wt);
  let wv = mix(mix(wind[ixn(wb.x, wb.y, F)].xy, wind[ixn(wb.x + 1, wb.y, F)].xy, wf.x),
               mix(wind[ixn(wb.x, wb.y + 1, F)].xy, wind[ixn(wb.x + 1, wb.y + 1, F)].xy, wf.x), wf.y);
  let speed = min(length(wv) / f32(F) * 512.0 * C.world.w, 2.0);
  let bare = (1.0 - smoothstep(0.0, 0.001, g.z + g.w)) * (1.0 - smoothstep(0.0001, 0.0005, w.x)) *
    (1.0 - smoothstep(0.0, 0.0005, e.z + e.w));
  let arid = 1.0 - smoothstep(0.25, 0.7, c.z);
  let scour = 0.00000004 * speed * bare;
  let deflation = g.z * 0.00005 * arid * (1.0 - e.y) * (1.0 - e.x) * (0.4 + 0.6 * speed);
  let byWind = (scour + deflation) / 0.00000008;

  let byIce = smoothstep(0.0003, 0.004, e.w) + frostRate(c.w, rain) * exposed / 0.0000002;

  let swing = dailySwing(c.y, e.x, smoothstep(0.0, 0.0005, w.x), e.z + e.w);
  let byHeat = (thermalRate(swing) + chemicalRate(c.w, rain)) * exposed / 0.0000012;

  var strongest = byWater;
  var color = vec3f(0.2, 0.55, 1.0);
  if (depositing > strongest) { strongest = depositing; color = vec3f(0.45, 0.85, 0.35); }
  if (byWind > strongest) { strongest = byWind; color = vec3f(0.98, 0.72, 0.25); }
  if (byIce > strongest) { strongest = byIce; color = vec3f(0.62, 0.45, 1.0); }
  if (byHeat > strongest) { strongest = byHeat; color = vec3f(1.0, 0.42, 0.2); }
  // nothing much happening: a quiet grey
  if (strongest < 0.08) { return vec4f(vec3f(0.42), 0.55); }
  return vec4f(color * mix(0.55, 1.0, smoothstep(0.08, 1.0, strongest)), 0.8);
}
`

const waterBindings = /* wgsl */ `
@group(0) @binding(1) var<storage, read> chunks: array<u32>;
@group(0) @binding(2) var<storage, read> ground: array<vec4f>;
@group(0) @binding(3) var<storage, read> water: array<vec4f>;
@group(0) @binding(4) var<storage, read> shadow: array<vec4f>;
@group(0) @binding(5) var<storage, read> flows: array<vec2f>;
@group(0) @binding(6) var<storage, read> wnormals: array<vec4f>;
@group(0) @binding(7) var<storage, read> climate: array<vec4f>;
// silt and clay in suspension (the sand is in water.w)
@group(0) @binding(8) var<storage, read> fine: array<f32>;

fn sFine(t: Taps) -> f32 { return mix(mix(fine[t.i00], fine[t.i10], t.f.x), mix(fine[t.i01], fine[t.i11], t.f.x), t.f.y); }
fn sWNormals(t: Taps) -> vec4f { return lerp4(wnormals[t.i00], wnormals[t.i10], wnormals[t.i01], wnormals[t.i11], t.f); }
fn pressureAt(uv: vec2f) -> f32 { return 0.0; }
// On the water surface the Erosion map shows the streams that cut into their beds.
// Deep water hardly touches the bottom (the coast's surf shows on the land beside
// it), so open sea and lakes stay clear.
fn erosionAt(uv: vec2f) -> vec4f {
  let w = sWater(taps(uv));
  // no slope here: rivers cut where fast and shallow; where it carries more than that, it settles
  let capacity = streamCapacity(length(waterVelocity(w)), 0.3) * (1.0 - smoothstep(0.003, 0.02, w.x)) * COARSE_SHARE;
  let cutting = max(capacity - w.w, 0.0) * SED_ERODE / 0.000002;
  let depositing = max(w.w - capacity, 0.0) * SED_DEPOSIT / 0.00001;
  if (depositing > cutting) { return vec4f(vec3f(0.45, 0.85, 0.35), clamp(depositing, 0.0, 1.0) * 0.8); }
  return vec4f(vec3f(0.2, 0.55, 1.0), clamp(cutting, 0.0, 1.0) * 0.8);
}
`

const buffers = weatheringModel + /* wgsl */ `
@group(1) @binding(0) var texSampler: sampler;
@group(1) @binding(1) var rockTex: texture_2d<f32>;
@group(1) @binding(2) var rockNormalTex: texture_2d<f32>;
@group(1) @binding(3) var grassTex: texture_2d<f32>;
@group(1) @binding(4) var grassNormalTex: texture_2d<f32>;

fn ixn(x: i32, y: i32, n: i32) -> u32 {
  return u32(clamp(y, 0, n - 1) * n + clamp(x, 0, n - 1));
}

struct Taps { i00: u32, i10: u32, i01: u32, i11: u32, f: vec2f }
fn taps(uv: vec2f) -> Taps {
  let n = i32(C.params.x);
  let t = uv * f32(n) - 0.5;
  let b = vec2i(floor(t));
  return Taps(ixn(b.x, b.y, n), ixn(b.x + 1, b.y, n), ixn(b.x, b.y + 1, n), ixn(b.x + 1, b.y + 1, n), fract(t));
}
fn lerp4(a: vec4f, b: vec4f, c: vec4f, d: vec4f, f: vec2f) -> vec4f {
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
fn sGround(t: Taps) -> vec4f { return lerp4(ground[t.i00], ground[t.i10], ground[t.i01], ground[t.i11], t.f); }
fn sWater(t: Taps) -> vec4f { return lerp4(water[t.i00], water[t.i10], water[t.i01], water[t.i11], t.f); }
fn sClimate(t: Taps) -> vec4f { return lerp4(climate[t.i00], climate[t.i10], climate[t.i01], climate[t.i11], t.f); }
// x: terrain shadow, y: water surface shadow, z: height change since the reference
fn sShadow(t: Taps) -> vec4f {
  return mix(mix(shadow[t.i00], shadow[t.i10], t.f.x), mix(shadow[t.i01], shadow[t.i11], t.f.x), t.f.y);
}

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
  @location(1) world: vec3f,
}

// A chunk vertex: its uv, and the uvs of the coarser neighbour's edge vertices it
// must be blended between (same point when no stitching is needed).
struct ChunkVertex { uv: vec2f, uv0: vec2f, uv1: vec2f, blend: f32 }

// Vertex ids index a (C+1)² grid per chunk. Chunk entries pack the chunk id,
// its LOD and its 4 neighbours' LODs (see Renderer.selectChunks).
fn chunkVertex(vi: u32, inst: u32) -> ChunkVertex {
  let cells = u32(C.chunk.x);
  let side = cells + 1u;
  let perRow = u32(C.chunk.y);
  let entry = chunks[inst];
  let id = entry & 0xffu;
  let lod = (entry >> 8u) & 3u;
  let a = vi % side;
  let b = vi / side;
  let origin = vec2u((id % perRow) * cells, (id / perRow) * cells);

  // on an edge shared with a coarser chunk, slide onto that chunk's edge
  var along = 0u;      // position along the edge
  var neighbour = lod;
  var horizontal = true;
  if (b == 0u) { neighbour = (entry >> 10u) & 3u; along = a; }
  else if (b == cells) { neighbour = (entry >> 12u) & 3u; along = a; }
  else if (a == 0u) { neighbour = (entry >> 14u) & 3u; along = b; horizontal = false; }
  else if (a == cells) { neighbour = (entry >> 16u) & 3u; along = b; horizontal = false; }

  let n = C.params.x;
  let uv = vec2f(origin + vec2u(a, b)) / n;
  var out = ChunkVertex(uv, uv, uv, 0.0);
  if (neighbour > lod) {
    let coarse = 1u << neighbour;
    let r = along % coarse;
    if (r != 0u) {
      let lo = along - r;
      var p0 = vec2u(lo, b);
      var p1 = vec2u(lo + coarse, b);
      if (!horizontal) {
        p0 = vec2u(a, lo);
        p1 = vec2u(a, lo + coarse);
      }
      out.uv0 = vec2f(origin + p0) / n;
      out.uv1 = vec2f(origin + p1) / n;
      out.blend = f32(r) / f32(coarse);
    }
  }
  return out;
}

fn stitchedHeight(v: ChunkVertex, water: bool) -> f32 {
  var h0 = sGround(taps(v.uv0)).x;
  var h1 = sGround(taps(v.uv1)).x;
  if (water) {
    h0 += sWater(taps(v.uv0)).x;
    h1 += sWater(taps(v.uv1)).x;
  }
  return mix(h0, h1, v.blend);
}

fn selection(world: vec3f) -> vec3f {
  if (C.brush.w < 0.5) { return vec3f(1.0); }
  let center = worldPos(C.brush.xy, 0.0).xz;
  let d = distance(world.xz, center) / (C.brush.z * C.world.w);
  if (d > C.chunk.w && d < 1.0) { return vec3f(0.12, 0.92, 0.0); }
  return vec3f(1.0);
}

fn basisFor(n: vec3f) -> mat3x3f {
  let tangent = normalize(cross(n, vec3f(0.0, 0.0, 1.0)));
  let bitangent = normalize(cross(tangent, n));
  return mat3x3f(tangent, n, bitangent);
}

// Biome from temperature and mean rain (a simplified Whittaker diagram).
// 0 ice, 1 tundra, 2 cold desert, 3 taiga, 4 steppe, 5 temperate forest,
// 6 hot desert, 7 savanna, 8 tropical forest
fn biome(t: f32, rain: f32) -> u32 {
  if (t < -2.0) { return 0u; }
  if (t < 3.0) { return select(2u, 1u, rain > 0.3); }
  if (t < 9.0) { return select(4u, 3u, rain > 0.5); }
  if (t < 20.0) {
    if (rain < 0.3) { return 6u; }
    return select(4u, 5u, rain > 0.8);
  }
  if (rain < 0.3) { return 6u; }
  return select(7u, 8u, rain > 1.0);
}

fn biomeColor(b: u32) -> vec3f {
  switch b {
    case 0u: { return vec3f(0.85, 0.93, 1.0); }
    case 1u: { return vec3f(0.55, 0.6, 0.45); }
    case 2u: { return vec3f(0.7, 0.66, 0.6); }
    case 3u: { return vec3f(0.12, 0.38, 0.3); }
    case 4u: { return vec3f(0.75, 0.72, 0.38); }
    case 5u: { return vec3f(0.2, 0.6, 0.15); }
    case 6u: { return vec3f(0.93, 0.78, 0.45); }
    case 7u: { return vec3f(0.78, 0.62, 0.2); }
    default: { return vec3f(0.0, 0.42, 0.12); }
  }
}

// Blue (cold) → white (0 °C) → red (hot).
fn temperatureColor(t: f32) -> vec3f {
  let cold = mix(vec3f(0.95), vec3f(0.1, 0.3, 0.95), smoothstep(0.0, -20.0, t));
  let warm = mix(vec3f(0.95), vec3f(0.9, 0.15, 0.05), smoothstep(0.0, 35.0, t));
  return select(warm, cold, t < 0.0);
}

// Overlay colour and opacity for the selected map; zero when off.
fn overlayColor(c: vec4f, uv: vec2f) -> vec4f {
  let mode = u32(C.params.z);
  if (mode == 5u) {
    // lows blue/violet, highs orange, with isobar-like bands
    let p = pressureAt(uv);
    let col = mix(mix(vec3f(0.35, 0.25, 0.85), vec3f(0.92), smoothstep(-0.8, 0.0, p)), vec3f(0.95, 0.55, 0.15), smoothstep(0.0, 0.8, p));
    let band = 0.85 + 0.15 * smoothstep(0.35, 0.5, abs(fract(p * 4.0) - 0.5));
    return vec4f(col * band, 0.75);
  }
  if (mode == 6u) { return erosionAt(uv); }
  if (mode == 7u) {
    // change since the reference: orange where worn down, blue where built up, log scale
    // up to about 3 cm of height (0.03 units); grey where nothing has changed
    let change = sShadow(taps(uv)).z;
    if (abs(change) < 0.0003) { return vec4f(vec3f(0.5), 0.45); }
    let k = clamp(log(1.0 + abs(change) * 4000.0) / log(1.0 + 120.0), 0.0, 1.0);
    let hue = select(vec3f(0.95, 0.42, 0.2), vec3f(0.25, 0.55, 1.0), change > 0.0);
    return vec4f(mix(vec3f(0.82), hue, k), 0.82);
  }
  if (mode == 8u) {
    // drainage network: land dimmed, water by discharge (thin streams pale, big rivers deep blue)
    let wv = sWater(taps(uv));
    if (wv.x < 0.0002) { return vec4f(vec3f(0.5, 0.5, 0.47), 0.6); }
    let flow = clamp(log(1.0 + length(wv.yz) * 2000.0) / log(1.0 + 100.0), 0.0, 1.0);
    return vec4f(mix(vec3f(0.62, 0.86, 1.0), vec3f(0.0, 0.18, 0.75), flow), 0.92);
  }
  if (mode == 1u) { return vec4f(biomeColor(biome(c.w, c.z)), 0.75); }
  if (mode == 2u) { return vec4f(temperatureColor(c.w), 0.75); }
  if (mode == 3u) {
    let r = clamp(c.z / 2.5, 0.0, 1.0);
    return vec4f(mix(vec3f(0.85, 0.65, 0.35), vec3f(0.1, 0.25, 0.9), r), 0.75);
  }
  if (mode == 4u) {
    let h = clamp(c.y, 0.0, 1.2) / 1.2;
    return vec4f(mix(vec3f(0.8, 0.55, 0.3), vec3f(0.95), h), 0.75);
  }
  return vec4f(0.0);
}

// Shade from clouds: air close to saturation is cloudy.
fn cloudShade(c: vec4f) -> f32 { return 1.0 - 0.35 * smoothstep(0.8, 1.05, c.y); }

fn luma(c: vec3f) -> f32 { return dot(c, vec3f(0.299, 0.587, 0.114)); }
`

export const terrainShader = common + buffers + terrainBindings + /* wgsl */ `
@vertex
fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) inst: u32) -> VOut {
  let v = chunkVertex(vi, inst);
  let world = worldPos(v.uv, stitchedHeight(v, false));
  var out: VOut;
  out.pos = C.viewProj * vec4f(world, 1.0);
  out.uv = v.uv;
  out.world = world;
  return out;
}

@fragment
fn fs(in: VOut) -> @location(0) vec4f {
  let uv = in.uv;
  let t = taps(uv);
  let nrm = sNormals(t);
  let baseNormal = normalize(nrm.xyz);
  let basis = basisFor(baseNormal);
  let w = sWater(t).xyz;
  let g = sGround(t);
  let ex = sExtra(t);
  let veg = ex.x;
  let cl = sClimate(t);
  let temp = cl.w;
  let warm = smoothstep(12.0, 22.0, temp);
  let cool = 1.0 - smoothstep(-2.0, 8.0, temp);
  let arid = 1.0 - smoothstep(0.4, 1.0, cl.z);
  let lush = smoothstep(1.2, 2.0, cl.z);

  // textures follow the world, so they stay put when the window slides
  let wuv = (uv + C.world.xy) * C.world.w;
  // bare rock shows the stratum it is cut into: banded cliffs and canyon walls
  let layer = stratumOf((uv + C.world.xy) * C.world.w, sGround(t).y, C.far2.y);
  let rockColor = textureSample(rockTex, texSampler, wuv * 20.0).rgb * 0.8 * mix(vec3f(1.0), stratumColor(layer) * 1.35, 0.65);
  let rockNormal = basis * normalize((textureSample(rockNormalTex, texSampler, wuv * 20.0).xyz - 0.5) * vec3f(2.0, 3.0, 2.0));
  let grassColor = textureSample(grassTex, texSampler, wuv * 8.0).rgb;
  let grassNormal = basis * normalize((textureSample(grassNormalTex, texSampler, wuv * 8.0).xyz - 0.5) * vec3f(2.0, 1.0, 2.0));
  let grain = luma(textureSample(rockTex, texSampler, wuv * 70.0).rgb);

  let wetness = sqrt(clamp(w.x / 0.0003 + length(w.yz) / 0.015, 0.0, 1.0));
  let dirt = vec3f(85.0 / 255.0, 34.0 / 255.0, 0.0);
  // plants take the colour of their biome: dry grass, rainforest, conifers, tundra
  var tint = mix(vec3f(1.0), vec3f(1.35, 1.15, 0.6), arid);
  tint = mix(tint, vec3f(0.75, 1.05, 0.6), warm * lush);
  tint = mix(tint, vec3f(0.6, 0.8, 0.7), cool * (1.0 - arid));
  tint = mix(tint, vec3f(0.9, 0.82, 0.6), 1.0 - smoothstep(-4.0, 2.0, temp));
  // bare soil until plants take hold (the original always drew soil as grass); ochre in hot dry places
  let bare = mix(vec3f(0.36, 0.28, 0.19), vec3f(0.62, 0.42, 0.25), arid * warm) * (0.6 + luma(grassColor) * 1.2);
  var soil = mix(bare, grassColor * tint, veg);
  soil = mix(soil, dirt, wetness);

  let soilMix = clamp(g.z * 500.0, 0.0, 1.0);
  var color = mix(rockColor, soil, soilMix);
  var normal = mix(rockNormal, grassNormal, soilMix);

  let sandMix = clamp(g.w * 500.0, 0.0, 1.0);
  let sand = vec3f(0.83, 0.72, 0.5) * mix(0.8, 1.1, grain) * mix(1.0, 0.55, wetness);
  color = mix(color, sand, sandMix);
  normal = mix(normal, baseNormal, sandMix * 0.7);

  // glacier ice, then the snowpack on top of it; melting snow turns to slush under its meltwater
  let ice = smoothstep(0.0001, 0.001, ex.w);
  color = mix(color, vec3f(0.62, 0.8, 0.92) * mix(0.9, 1.05, grain), ice);
  normal = mix(normal, baseNormal, ice * 0.9);
  let snow = smoothstep(0.00003, 0.0004, ex.z) * smoothstep(0.55, 0.8, baseNormal.y) * (1.0 - wetness * 0.6);
  color = mix(color, vec3f(0.92, 0.95, 1.0), snow);
  normal = mix(normal, baseNormal, snow * 0.8);

  let occlusion = nrm.w;
  // fresh lava: a dark crust over glowing rock, brighter the hotter it is
  let lv = sLava(t);
  let lavaCover = smoothstep(0.0, 0.0004, lv.x);
  let crackle = smoothstep(0.35, 0.75, textureSample(rockTex, texSampler, wuv * 45.0 + vec2f(C.clouds.z * 0.002, 0.0)).r);
  color = mix(color, vec3f(0.07, 0.06, 0.06), lavaCover);
  normal = mix(normal, baseNormal, lavaCover * 0.5);
  let glow = vec3f(1.0, 0.13, 0.01) * lavaCover * lv.y * lv.y * (0.25 + 1.1 * crackle);

  let shadowed = mix(0.3, 1.0, sShadow(t).x) * cloudShade(cl);
  let light = lightColor();
  var exident = shLight(normal) * occlusion * shadowed * color * light;
  let overlay = overlayColor(cl, uv);
  exident = mix(exident, overlay.rgb * mix(0.55, 1.0, shadowed) * occlusion * mix(vec3f(0.6), light, 0.5), overlay.a);
  exident += glow * (1.0 - overlay.a);
  let incident = aerial(exident * selection(in.world), in.world);
  return vec4f(finish(incident), 1.0);
}
`

export const waterShader = common + buffers + waterBindings + /* wgsl */ `
@vertex
fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) inst: u32) -> VOut {
  let v = chunkVertex(vi, inst);
  let world = worldPos(v.uv, stitchedHeight(v, true));
  var out: VOut;
  out.pos = C.viewProj * vec4f(world, 1.0);
  out.uv = v.uv;
  out.world = world;
  return out;
}

fn flowAt(cell: vec2i) -> vec2f {
  let F = i32(C.params.y);
  let c = clamp(cell, vec2i(0), vec2i(F - 1));
  return flows[u32(c.y * F + c.x)];
}

fn detail(uv: vec2f, offset: vec2f, gx: vec2f, gy: vec2f) -> vec3f {
  let n = textureSampleGrad(grassNormalTex, texSampler, uv * 32.0 - offset * 2.0, gx, gy).xyz;
  return normalize(n * 2.0 - 1.0);
}

// Detail normals scrolled by the advected flow offsets of the 4 nearest flow cells.
fn flowNormal(uv: vec2f, gx: vec2f, gy: vec2f) -> vec3f {
  let cc = uv * C.params.y;
  let cell = vec2i(floor(cc));
  let off = fract(cc);
  let center = detail(uv, flowAt(cell), gx, gy);
  let right = detail(uv, flowAt(cell + vec2i(1, 0)), gx, gy);
  let top = detail(uv, flowAt(cell + vec2i(0, 1)), gx, gy);
  let topright = detail(uv, flowAt(cell + vec2i(1, 1)), gx, gy);
  let n = mix(mix(center, right, off.x), mix(top, topright, off.x), off.y);
  return normalize(n * vec3f(1.0, 0.2, 1.0));
}

@fragment
fn fs(in: VOut) -> @location(0) vec4f {
  let uv = in.uv;
  let gx = dpdx(uv * 32.0);
  let gy = dpdy(uv * 32.0);
  let t = taps(uv);
  let w = sWater(t).xyz;
  let depth = clamp(w.x / 0.001, 0.0, 1.0);
  if (depth <= 0.0) { discard; }
  let speed = clamp(length(w.yz) / 0.02, 0.0, 1.0);

  let baseNormal = normalize(sWNormals(t).xyz);
  let detailNormal = basisFor(baseNormal) * flowNormal(uv, gx, gy);
  var normal = normalize(mix(baseNormal * 0.5 + detailNormal * 0.5, detailNormal, speed));
  normal = normalize(mix(normal, baseNormal, sqrt(clamp(w.x / 0.0075, 0.0, 1.0)) * 0.75));

  // the stored normals use (u, h, v); flip z to world space for the sun highlight
  let eyeDir = normalize(in.world - C.eye.xyz);
  let worldNormal = normalize(vec3f(normal.x, normal.y * 0.35, -normal.z));
  let specNormal = reflect(eyeDir, worldNormal);
  let lambert = pow(max(0.0, dot(specNormal, C.light.xyz)), 0.5);
  let specular = pow(lambert, 20.0) * 0.9;

  // light is absorbed with depth: clear turquoise over the shallows, navy in deep water
  let shallowColor = vec3f(0.11, 0.62, 0.66);
  let deepColor = vec3f(0.0, 0.07, 0.19);
  var color = mix(deepColor, shallowColor, exp(-w.x * 160.0));
  // water carrying sediment turns muddy: rivers in flood, the plume off a delta
  let silt = clamp((sWater(t).w + sFine(t)) / max(w.x, 0.0005) * 4.0, 0.0, 1.0);
  color = mix(color, vec3f(0.42, 0.33, 0.2), silt * 0.75);
  // foam where water is shallow and fast (rapids, waterfalls, surf), never on open sea
  let shallow = 1.0 - smoothstep(0.002, 0.012, w.x);
  let foam = clamp(pow(speed * 2.0, 3.0), 0.0, 1.0) * shallow;
  color = mix(color, vec3f(0.92, 0.96, 1.0), foam);
  // still water below freezing shows a sheet of ice
  let cl = sClimate(t);
  let frozen = smoothstep(0.5, -1.5, cl.w) * (1.0 - speed);
  color = mix(color, vec3f(0.75, 0.88, 0.95), frozen * 0.85);
  let overlay = overlayColor(cl, uv);
  color = mix(color, overlay.rgb, overlay.a);
  let light = lightColor();
  let shNormal = vec3f(specNormal.x, specNormal.y, -specNormal.z);
  var exident = color * mix(shLight(shNormal), shLight(normal), 0.75) * light;
  // the sky mirrored on open water (not on foam or ice); a calmer normal than the
  // exaggerated one used for the sun glints
  let calm = normalize(vec3f(normal.x * 0.5, normal.y, -normal.z * 0.5));
  exident = mix(exident, waterSurface(exident, eyeDir, calm), (1.0 - foam) * (1.0 - frozen));

  let lit = sShadow(t).y * cloudShade(cl);
  let incident = aerial(exident * mix(0.45, 1.0, lit) * selection(in.world) + specular * lit * (1.0 - frozen * 0.7) * mix(0.3, 1.0, C.sun.w) * light, in.world);
  return vec4f(finish(incident), max(depth, frozen * clamp(w.x / 0.0002, 0.0, 1.0)));
}
`

export const skyShader = common + /* wgsl */ `
struct SkyOut {
  @builtin(position) pos: vec4f,
  @location(0) ndc: vec2f,
}

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> SkyOut {
  let p = vec2f(f32((vi << 1u) & 2u), f32(vi & 2u)) * 2.0 - 1.0;
  var out: SkyOut;
  out.pos = vec4f(p, 0.0, 1.0);
  out.ndc = p;
  return out;
}

@fragment
fn fs(in: SkyOut) -> @location(0) vec4f {
  let far = C.invViewProj * vec4f(in.ndc, 1.0, 1.0);
  let dir = normalize(far.xyz / far.w - C.eye.xyz);
  let day = C.sun.w;
  let sunDir = C.sun.xyz;
  var color = skyColor(dir);
  // sun, moon and stars
  let sun = max(dot(dir, sunDir), 0.0);
  color += vec3f(1.0, 0.85, 0.6) * (pow(sun, 600.0) * 2.0 + pow(sun, 12.0) * 0.15) * smoothstep(-0.1, 0.02, sunDir.y);
  let moonDir = normalize(vec3f(-sunDir.x, -sunDir.y, sunDir.z));
  color += vec3f(0.85, 0.9, 1.0) * smoothstep(0.9995, 0.9997, dot(dir, moonDir)) * (1.0 - day);
  let cell = floor(dir * 300.0);
  let star = fract(sin(dot(cell, vec3f(12.9898, 78.233, 37.719))) * 43758.5453);
  color += vec3f(0.9) * step(0.998, star) * (1.0 - day) * smoothstep(0.0, 0.2, dir.y);
  return vec4f(color, 1.0);
}
`

// Wind arrows: a grid of flat arrows floating over the terrain, pointing along the
// local wind; longer and warmer-coloured where it blows harder.
export const WIND_ARROW_GRID = 24
export const windArrowShader = common + /* wgsl */ `
@group(0) @binding(1) var<storage, read> ground: array<vec4f>;
@group(0) @binding(2) var<storage, read> water: array<vec4f>;
@group(0) @binding(3) var<storage, read> wind: array<vec4f>;

fn ixn(x: i32, y: i32, n: i32) -> u32 {
  return u32(clamp(y, 0, n - 1) * n + clamp(x, 0, n - 1));
}
fn surfaceAt(uv: vec2f) -> f32 {
  let n = i32(C.params.x);
  let p = vec2i(floor(uv * f32(n)));
  let j = ixn(p.x, p.y, n);
  return ground[j].x + water[j].x;
}
fn windAt(uv: vec2f) -> vec2f {
  let n = i32(C.params.y);
  let t = uv * f32(n) - 0.5;
  let f = fract(t);
  let b = vec2i(floor(t));
  let a = mix(wind[ixn(b.x, b.y, n)].xy, wind[ixn(b.x + 1, b.y, n)].xy, f.x);
  let c = mix(wind[ixn(b.x, b.y + 1, n)].xy, wind[ixn(b.x + 1, b.y + 1, n)].xy, f.x);
  return mix(a, c, f.y) / f32(n);
}

struct ArrowOut {
  @builtin(position) pos: vec4f,
  @location(0) color: vec3f,
}

// (along, across) in arrow lengths / widths: a shaft quad and a head triangle
const SHAPE = array<vec2f, 9>(
  vec2f(0.0, -0.5), vec2f(0.62, -0.5), vec2f(0.0, 0.5),
  vec2f(0.0, 0.5), vec2f(0.62, -0.5), vec2f(0.62, 0.5),
  vec2f(0.62, -1.6), vec2f(1.0, 0.0), vec2f(0.62, 1.6),
);

@vertex
fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) inst: u32) -> ArrowOut {
  let G = ${WIND_ARROW_GRID}u;
  let center = (vec2f(f32(inst % G), f32(inst / G)) + 0.5) / f32(G);
  let v = windAt(center);
  // speed in the same units as the wind slider (cells per step at 512 cells per world unit)
  let speed = length(v) * 512.0 * C.world.w;
  let dir = select(vec2f(1.0, 0.0), v / max(length(v), 1e-9), speed > 0.001);
  let side = vec2f(-dir.y, dir.x);
  let cell = 1.0 / f32(G);
  let len = cell * 0.85 * clamp(speed / 1.2, 0.2, 1.0);
  let s = SHAPE[vi];
  let uv = center + dir * (s.x - 0.5) * len + side * s.y * cell * 0.08;
  let world = worldPos(uv, surfaceAt(clamp(uv, vec2f(0.0), vec2f(1.0))) + 0.006);
  var out: ArrowOut;
  out.pos = C.viewProj * vec4f(world, 1.0);
  let k = clamp(speed / 1.5, 0.0, 1.0);
  out.color = mix(mix(vec3f(0.75, 0.9, 1.0), vec3f(1.0, 0.85, 0.2), smoothstep(0.0, 0.5, k)), vec3f(1.0, 0.25, 0.1), smoothstep(0.5, 1.0, k));
  if (speed <= 0.001) { out.pos = vec4f(0.0, 0.0, 2.0, 1.0); }  // no wind: clip the arrow away
  return out;
}

@fragment
fn fs(in: ArrowOut) -> @location(0) vec4f {
  return vec4f(in.color, 0.9);
}
`

// 3D clouds as a stack of horizontal slices (drawn far to near, so blending works
// from above and below). Coverage comes from the simulated humidity and rain; the
// shape from drifting noise. Thicker clouds grow taller and are darker underneath.
export const CLOUD_SLICES = 20
export const cloudShader = common + /* wgsl */ `
@group(0) @binding(1) var<storage, read> climate: array<vec4f>;
@group(0) @binding(2) var<storage, read> air: array<vec4f>;

const BASE = 0.1;
const DEPTH = 0.15;

fn ixn(x: i32, y: i32, n: i32) -> u32 {
  return u32(clamp(y, 0, n - 1) * n + clamp(x, 0, n - 1));
}
fn coverage(uv: vec2f) -> f32 {
  let n = i32(C.params.x);
  let t = uv * f32(n) - 0.5;
  let b = vec2i(floor(t));
  let f = fract(t);
  let i00 = ixn(b.x, b.y, n);
  let i10 = ixn(b.x + 1, b.y, n);
  let i01 = ixn(b.x, b.y + 1, n);
  let i11 = ixn(b.x + 1, b.y + 1, n);
  let rh = mix(mix(climate[i00].y, climate[i10].y, f.x), mix(climate[i01].y, climate[i11].y, f.x), f.y);
  let rain = mix(mix(air[i00].y, air[i10].y, f.x), mix(air[i01].y, air[i11].y, f.x), f.y);
  return clamp(smoothstep(0.7, 1.05, rh) + smoothstep(0.0005, 0.004, rain) * 0.6, 0.0, 1.0);
}
` + /* wgsl */ `
fn hash3(p: vec3f) -> f32 { return fract(sin(dot(p, vec3f(127.1, 311.7, 74.7))) * 43758.5453); }
fn valueNoise(p: vec3f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(hash3(i), hash3(i + vec3f(1.0, 0.0, 0.0)), u.x), mix(hash3(i + vec3f(0.0, 1.0, 0.0)), hash3(i + vec3f(1.0, 1.0, 0.0)), u.x), u.y),
    mix(mix(hash3(i + vec3f(0.0, 0.0, 1.0)), hash3(i + vec3f(1.0, 0.0, 1.0)), u.x), mix(hash3(i + vec3f(0.0, 1.0, 1.0)), hash3(i + vec3f(1.0, 1.0, 1.0)), u.x), u.y),
    u.z);
}
fn fbm(p: vec3f) -> f32 {
  return valueNoise(p) * 0.55 + valueNoise(p * 2.03) * 0.3 + valueNoise(p * 4.1) * 0.15;
}

struct CloudOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
  @location(1) world: vec3f,
  @location(2) layer: f32,
}

@vertex
fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) inst: u32) -> CloudOut {
  let corners = array<vec2f, 6>(vec2f(0.0, 0.0), vec2f(1.0, 0.0), vec2f(0.0, 1.0), vec2f(0.0, 1.0), vec2f(1.0, 0.0), vec2f(1.0, 1.0));
  let N = ${CLOUD_SLICES}u;
  // far to near: bottom first when looking down from above the clouds
  var k = inst;
  if (C.eye.y < BASE + DEPTH * 0.5) { k = N - 1u - inst; }
  let layer = (f32(k) + 0.5) / f32(N);
  let uv = corners[vi];
  let world = worldPos(uv, BASE + layer * DEPTH);
  var out: CloudOut;
  out.pos = C.viewProj * vec4f(world, 1.0);
  out.uv = uv;
  out.world = world;
  out.layer = layer;
  return out;
}

@fragment
fn fs(in: CloudOut) -> @location(0) vec4f {
  let cov = coverage(in.uv);
  if (cov <= 0.01) { discard; }
  let top = 0.15 + 0.85 * cov;
  let profile = smoothstep(0.0, 0.12, in.layer) * (1.0 - smoothstep(top - 0.2, top, in.layer));
  let p = vec3f(((in.uv + C.world.xy) * C.world.w + C.clouds.xy) * 9.0, in.layer * 2.5 + C.clouds.z * 0.003);
  let density = clamp((fbm(p) + cov * 0.9 - 0.95) * 3.0, 0.0, 1.0) * profile;
  if (density <= 0.0) { discard; }
  let height = in.layer / max(top, 0.01);
  let shade = mix(0.45, 1.05, height) * (1.0 - 0.35 * cov * (1.0 - height));
  let color = aerial(vec3f(shade) * lightColor(), in.world);
  return vec4f(finish(color), density * 0.3);
}
`

// Distant terrain: a coarse grid of noise heights (FAR_GRID² texels, 32 per window
// width, centred on the window) drawn around the simulated window, which it skips.
// Coloured from height and latitude only; the sea is drawn where the ocean is on.
export const farTerrainShader = common + /* wgsl */ `
@group(0) @binding(1) var<storage, read> far: array<f32>;
@group(0) @binding(2) var<storage, read> ground: array<vec4f>;

const G = ${FAR_GRID};
const TEXEL = 1.0 / ${FAR_TEXELS_PER_WINDOW}.0;

fn ixn(x: i32, y: i32, n: i32) -> u32 {
  return u32(clamp(y, 0, n - 1) * n + clamp(x, 0, n - 1));
}
// The window's own height at a point of its edge (bilinear), so both meshes meet there.
fn windowHeight(uv: vec2f) -> f32 {
  let n = i32(C.params.x);
  let t = clamp(uv, vec2f(0.0), vec2f(1.0)) * f32(n) - 0.5;
  let b = vec2i(floor(t));
  let f = fract(t);
  return mix(mix(ground[ixn(b.x, b.y, n)].x, ground[ixn(b.x + 1, b.y, n)].x, f.x),
             mix(ground[ixn(b.x, b.y + 1, n)].x, ground[ixn(b.x + 1, b.y + 1, n)].x, f.x), f.y);
}

struct FarOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
  @location(1) world: vec3f,
  @location(2) normal: vec3f,
  @location(3) height: f32,
}

fn heightAt(x: i32, y: i32) -> f32 { return far[u32(clamp(y, 0, G - 1) * G + clamp(x, 0, G - 1))]; }

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> FarOut {
  let x = i32(vi % u32(G));
  let y = i32(vi / u32(G));
  let uv = vec2f(f32(x), f32(y)) * TEXEL - f32(G) * TEXEL * 0.5 + 0.5;
  var h = heightAt(x, y);
  // vertices on (or inside) the window's edge take the window's height
  if (all(uv >= vec2f(-0.001)) && all(uv <= vec2f(1.001))) { h = windowHeight(uv); }
  let sea = select(-10.0, C.far.x, C.far.y > 0.5);
  let n = normalize(vec3f(-(heightAt(x + 1, y) - heightAt(x - 1, y)) / (2.0 * TEXEL * C.world.w), 1.0, (heightAt(x, y + 1) - heightAt(x, y - 1)) / (2.0 * TEXEL * C.world.w)));
  var out: FarOut;
  out.world = worldPos(uv, max(h, sea));
  out.pos = C.viewProj * vec4f(out.world, 1.0);
  out.uv = uv;
  out.normal = n;
  out.height = h;
  return out;
}

@fragment
fn fs(in: FarOut) -> @location(0) vec4f {
  // the simulated window draws itself
  if (all(in.uv > vec2f(0.0)) && all(in.uv < vec2f(1.0))) { discard; }
  let sea = C.far.y > 0.5 && in.height < C.far.x;
  let lat = clamp((in.uv.y + C.world.y) * C.world.w, -1.0, 2.0);
  let t = C.far.z - C.far.w * max(in.height, C.far.x) + C.far2.x * (0.5 - lat);
  var color: vec3f;
  var normal = in.normal;
  if (sea) {
    // same deep-water colour as the simulated sea, with its sea ice
    let depth = max(C.far.x - in.height, 0.0);
    color = mix(vec3f(0.0, 0.07, 0.19), vec3f(0.11, 0.62, 0.66), exp(-depth * 160.0));
    color = mix(color, vec3f(0.75, 0.88, 0.95), smoothstep(0.5, -1.5, t) * 0.85);
    normal = vec3f(0.0, 1.0, 0.0);
  } else {
    let steep = smoothstep(0.75, 0.55, in.normal.y);
    let green = mix(vec3f(0.24, 0.3, 0.16), vec3f(0.55, 0.48, 0.3), smoothstep(22.0, 32.0, t));
    color = mix(green, vec3f(0.36, 0.34, 0.31), steep);
    color = mix(color, vec3f(0.92, 0.95, 1.0), smoothstep(0.5, -1.5, t) * (1.0 - steep * 0.6));
  }
  var exident = shLight(normal) * color * 0.8 * lightColor();
  if (sea) {
    let iced = smoothstep(0.5, -1.5, t) * 0.85;
    exident = mix(waterSurface(exident, normalize(in.world - C.eye.xyz), vec3f(0.0, 1.0, 0.0)), exident, iced);
  }
  return vec4f(finish(aerial(exident, in.world)), 1.0);
}
`
