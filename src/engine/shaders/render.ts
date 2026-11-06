// Render shaders: terrain, water, sky, clouds, wind arrows and the distant terrain.
// Shading ported from the original display.shader / water/display.shader by
// Florian Boesch (AGPL-3.0): spherical-harmonics "beach" lighting, Rayleigh-ish
// absorption fog and a 1/1.8 gamma.

import { CIV_COLORS, DAM_HALF, DAM_HEIGHT, TERRITORY_N } from '../life'
import { FAR_GRID, FAR_TEXELS_PER_WINDOW, MAX_PLATE_OVERRIDES, platesModel, weatheringModel } from './sim'

export const CAMERA_UNIFORM_SIZE = 368 + MAX_PLATE_OVERRIDES * 32

const common = /* wgsl */ `
struct Cam {
  viewProj: mat4x4f,
  view: mat4x4f,
  invViewProj: mat4x4f,
  eye: vec4f,
  light: vec4f,     // xyz: direction towards the light casting shadows (sun by day, moon by night)
  brush: vec4f,     // uv.x, uv.y, radius, visible
  params: vec4f,    // N, flow size, overlay (0 none, 1 biome, 2 temperature, 3 rain, 4 humidity, 5 pressure, 6 erosion,
                    // 7 change, 8 rivers, 9 plates, 10 air masses, 11 peoples, 12 currents, 13 relief), time
  chunk: vec4f,     // cells per chunk, chunks per side, point of the year (0 start of spring … 1; −1 no seasons), ring inner radius
  viewport: vec4f,
  sun: vec4f,       // xyz: direction towards the sun (may be below the horizon), w: daylight
  clouds: vec4f,    // xy: cloud drift (uv), z: simulated seconds
  world: vec4f,     // xy: window origin in the world (window widths), z: infinite world on,
                    // w: simulated area, the window's width in world units
  far: vec4f,       // distant terrain: sea level, ocean on, temperature at height 0, lapse rate
  far2: vec4f,      // x: north–south temperature difference per window, y: terrain seed,
                    // z: plate time, w: number of plate overrides (see platesModel)
  plates: array<vec4f, ${MAX_PLATE_OVERRIDES * 2}>,
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

// The peoples' map (overlay 11) is drawn like an atlas, whatever the hour: parchment land
// tinted by altitude and shaded by a fixed north-west light, flat blue water, snow and ice
// white; the territories are painted over it (see territoryShader).
fn politicalLand(height: f32, snow: f32, ice: f32, normal: vec3f) -> vec3f {
  let above = clamp((height - C.far.x) / 0.1, 0.0, 1.0);
  var land = mix(vec3f(0.78, 0.74, 0.60), vec3f(0.55, 0.47, 0.38), sqrt(above));
  land = mix(land, vec3f(0.88, 0.90, 0.92), max(smoothstep(0.00003, 0.0004, snow), smoothstep(0.0001, 0.001, ice)));
  let shade = 0.5 + 0.5 * max(dot(normal, normalize(vec3f(-0.5, 0.6, 0.45))), 0.0);
  return land * shade;
}
// Distance on the atlas fades towards the paper, never towards the sky: the map reads the
// same at midnight as at noon.
fn atlasFade(color: vec3f, world: vec3f) -> vec3f {
  let d = distance(world, C.eye.xyz) / C.world.w;
  let haze = 1.0 - exp(-pow(d / 2.4, 2.0));
  return mix(color, vec3f(0.62, 0.60, 0.54), haze);
}
fn politicalWater(depth: f32) -> vec3f {
  let sea = mix(vec3f(0.44, 0.58, 0.76), vec3f(0.24, 0.36, 0.58), smoothstep(0.0, 0.025, depth));
  // a darker line along the shore
  return sea * mix(0.72, 1.0, smoothstep(0.0, 0.0012, depth));
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
fn tectonicAt(uv: vec2f) -> f32 { return sLava(taps(uv)).w; }
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
// lakes and seas show the plates but not the uplift under them
fn tectonicAt(uv: vec2f) -> f32 { return 0.0; }
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

const buffers = weatheringModel + platesModel('C.far2.z', 'C.far2.w', 'C.plates') + /* wgsl */ `
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
  if (mode == 12u) {
    // the ocean currents: the sea's temperature anomaly (what the current brush paints and
    // the wind carries along): red warm, blue cold, fading where there is none; the land
    // keeps its colours (the terrain pass skips this mode)
    let warm = smoothstep(0.0, 4.0, c.x);
    let cold = smoothstep(0.0, 4.0, -c.x);
    let col = mix(mix(vec3f(0.5), vec3f(0.95, 0.25, 0.1), warm), vec3f(0.15, 0.35, 1.0), cold);
    let band = 0.85 + 0.15 * smoothstep(0.35, 0.5, abs(fract(abs(c.x) * 0.5) - 0.5));
    return vec4f(col * band, 0.9 * smoothstep(0.15, 1.0, abs(c.x)));
  }
  if (mode == 5u) {
    // lows blue/violet, highs orange, with isobar-like bands
    let p = pressureAt(uv);
    let col = mix(mix(vec3f(0.35, 0.25, 0.85), vec3f(0.92), smoothstep(-0.8, 0.0, p)), vec3f(0.95, 0.55, 0.15), smoothstep(0.0, 0.8, p));
    let band = 0.85 + 0.15 * smoothstep(0.35, 0.5, abs(fract(p * 4.0) - 0.5));
    return vec4f(col * band, 0.75);
  }
  if (mode == 10u) {
    // air masses: blue where the air is colder than its latitude's, orange where warmer;
    // violet lines where the air is forced up (fronts, storms), dimmer where it sinks
    // (packed by upperShader into shadow.w, per 4×4 block; nearest texel, since the
    // packing does not interpolate)
    let packed = shadow[taps(uv).i00].w;
    // a fixed air-mass source painted here: 1 cold, 2 warm (see upperShader)
    let fixed = floor(packed / 10000.0);
    let w = packed - fixed * 10000.0;
    let dev = select((floor(w) - 2500.0) / 100.0, 0.0, w < 1.0);
    let rise = select((fract(w) - 0.5) / 25.0, 0.0, w < 1.0);
    var col = mix(mix(vec3f(0.15, 0.35, 0.95), vec3f(0.93), smoothstep(-5.0, 0.0, dev)), vec3f(0.95, 0.45, 0.15), smoothstep(0.0, 5.0, dev));
    col = mix(col, vec3f(0.5, 0.1, 0.75), 0.9 * smoothstep(0.0005, 0.004, rise));
    col *= 1.0 - 0.3 * smoothstep(-0.0005, -0.004, rise);
    if (fixed > 0.5) {
      // the painted sources: a checkered stipple in deep blue (cold) or deep orange (warm)
      let cell = floor(uv * C.params.x * 0.5);
      let stipple = abs(cell.x + cell.y) % 2.0;
      col = mix(col, select(vec3f(0.95, 0.3, 0.0), vec3f(0.0, 0.15, 0.85), fixed < 1.5), 0.7 * stipple);
    }
    return vec4f(col, 0.78);
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
    if (wv.x < 0.0001) { return vec4f(vec3f(0.5, 0.5, 0.47), 0.6); }
    // (the thinnest streams, a film in a cell or two wide, still show as pale lines)
    let flow = clamp(log(1.0 + length(wv.yz) * 4000.0) / log(1.0 + 200.0), 0.0, 1.0);
    return vec4f(mix(vec3f(0.62, 0.86, 1.0), vec3f(0.0, 0.18, 0.75), flow), 0.92);
  }
  if (mode == 9u) {
    // plates: each its own muted colour, boundaries drawn as dark lines; on top, red where
    // the plates push the rock up and blue where they pull it down
    let pp = platePair((uv + C.world.xy) * C.world.w, C.far2.y);
    // pale pastels, so the strong red and blue of the uplift stand out
    let hue = plateHash(pp.own, 11u) + vec3f(0.0, 0.333, 0.667);
    var col = 0.78 - 0.12 * cos(6.2831853 * hue);
    let u = tectonicAt(uv);
    col = mix(col, vec3f(0.9, 0.22, 0.1), smoothstep(0.02, 0.5, u));
    col = mix(col, vec3f(0.12, 0.3, 0.9), smoothstep(0.02, 0.5, -u));
    let line = 1.0 - smoothstep(0.004, 0.008, pp.dist);
    return vec4f(mix(col, vec3f(0.08), line * 0.8), 0.8);
  }
  if (mode == 13u) {
    // relief: the sea by its depth, the land in hypsometric tints (green lowlands, tan
    // hills, brown mountains, white peaks), with a contour line every 0.01 of height
    let tp = taps(uv);
    let depth = sWater(tp).x;
    if (depth > 0.002) {
      return vec4f(mix(vec3f(0.62, 0.82, 0.95), vec3f(0.05, 0.2, 0.55), clamp(depth / 0.06, 0.0, 1.0)), 0.92);
    }
    let h = sGround(tp).x;
    var tint = mix(vec3f(0.36, 0.6, 0.36), vec3f(0.86, 0.82, 0.52), smoothstep(-0.02, 0.04, h));
    tint = mix(tint, vec3f(0.6, 0.42, 0.28), smoothstep(0.04, 0.1, h));
    tint = mix(tint, vec3f(0.97), smoothstep(0.1, 0.18, h));
    let line = smoothstep(0.42, 0.5, abs(fract(h * 100.0) - 0.5));
    return vec4f(tint * (1.0 - 0.3 * line), 0.9);
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
  // the seasons: in the temperate biomes the leaves turn gold and red in autumn, the land
  // goes dull in winter and fresh, with a few blossoms, in spring; dry lands yellow in summer
  let phase = C.chunk.z;
  if (phase >= 0.0) {
    let temperate = (1.0 - warm * lush) * (1.0 - arid) * smoothstep(-2.0, 10.0, temp) * (1.0 - smoothstep(20.0, 28.0, temp));
    let spring = max(1.0 - smoothstep(0.04, 0.2, phase), smoothstep(0.94, 1.0, phase));
    let summer = smoothstep(0.18, 0.3, phase) * (1.0 - smoothstep(0.45, 0.55, phase));
    let autumn = smoothstep(0.5, 0.6, phase) * (1.0 - smoothstep(0.7, 0.82, phase));
    let winter = smoothstep(0.72, 0.82, phase) * (1.0 - smoothstep(0.94, 1.0, phase));
    let leaves = smoothstep(0.35, 0.75, veg);
    tint = mix(tint, vec3f(1.55, 0.9, 0.3) * mix(0.8, 1.15, grain), autumn * temperate * leaves * 0.85);
    tint = mix(tint, vec3f(1.5, 0.75, 0.2), autumn * temperate * leaves * smoothstep(0.6, 0.85, grain) * 0.5);
    tint = mix(tint, vec3f(0.85, 0.78, 0.6), winter * temperate * 0.55);
    tint = mix(tint, vec3f(1.05, 1.15, 0.7), spring * temperate * 0.35);
    tint = mix(tint, vec3f(1.35, 0.95, 1.0), spring * temperate * leaves * smoothstep(0.78, 0.86, grain) * 0.7);
    tint = mix(tint, vec3f(1.25, 1.05, 0.55), summer * (1.0 - lush) * smoothstep(0.3, 0.6, 1.0 - cl.z) * 0.5);
  }
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

  if (u32(C.params.z) == 11u) {
    let atlas = politicalLand(g.x, ex.z, ex.w, baseNormal) * mix(0.85, 1.0, occlusion);
    return vec4f(finish(atlasFade(atlas * selection(in.world), in.world)), 1.0);
  }
  let shadowed = mix(0.3, 1.0, sShadow(t).x) * cloudShade(cl);
  let light = lightColor();
  var exident = shLight(normal) * occlusion * shadowed * color * light;
  // (the currents map colours only the water)
  let overlay = select(overlayColor(cl, uv), vec4f(0.0), u32(C.params.z) == 12u);
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
  if (u32(C.params.z) == 11u) {
    return vec4f(finish(atlasFade(politicalWater(w.x) * selection(in.world), in.world)), depth);
  }
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

// Plate arrows: one big arrow on each plate's site, pointing where the plate drifts
// (worked out on the CPU, see Engine.plateArrows); the plate being dragged is highlighted.
export const MAX_PLATE_ARROWS = 32
export const plateArrowShader = common + /* wgsl */ `
@group(0) @binding(1) var<storage, read> ground: array<vec4f>;
@group(0) @binding(2) var<storage, read> water: array<vec4f>;
// per arrow: (uv, velocity in world units per unit of speed), (selected, 0, 0, 0)
@group(0) @binding(3) var<storage, read> arrows: array<vec4f>;

fn ixn(x: i32, y: i32, n: i32) -> u32 {
  return u32(clamp(y, 0, n - 1) * n + clamp(x, 0, n - 1));
}
fn surfaceAt(uv: vec2f) -> f32 {
  let n = i32(C.params.x);
  let p = vec2i(floor(uv * f32(n)));
  let j = ixn(p.x, p.y, n);
  return ground[j].x + water[j].x;
}

struct ArrowOut {
  @builtin(position) pos: vec4f,
  @location(0) color: vec3f,
}

const SHAPE = array<vec2f, 9>(
  vec2f(0.0, -0.5), vec2f(0.62, -0.5), vec2f(0.0, 0.5),
  vec2f(0.0, 0.5), vec2f(0.62, -0.5), vec2f(0.62, 0.5),
  vec2f(0.62, -1.6), vec2f(1.0, 0.0), vec2f(0.62, 1.6),
);

@vertex
fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) inst: u32) -> ArrowOut {
  let a = arrows[inst * 2u];
  let selected = arrows[inst * 2u + 1u].x;
  let speed = length(a.zw);
  let dir = select(vec2f(1.0, 0.0), a.zw / max(speed, 1e-9), speed > 1e-6);
  let side = vec2f(-dir.y, dir.x);
  // in window uv: a quarter of a world unit at full speed
  let len = (0.08 + 0.22 * speed) / C.world.w;
  let s = SHAPE[vi];
  let uv = a.xy + dir * (s.x - 0.35) * len + side * s.y * 0.018 / C.world.w;
  let world = worldPos(uv, surfaceAt(clamp(uv, vec2f(0.0), vec2f(1.0))) + 0.012);
  var out: ArrowOut;
  out.pos = C.viewProj * vec4f(world, 1.0);
  out.color = select(vec3f(0.95, 0.95, 0.92), vec3f(1.0, 0.78, 0.2), selected > 0.5);
  return out;
}

@fragment
fn fs(in: ArrowOut) -> @location(0) vec4f {
  return vec4f(in.color, 0.95);
}
`

/// Life markers: the peoples' towns and works, their travellers, the herds and the rest,
// drawn as little boxes with pyramid roofs standing on the terrain.
export const MAX_LIFE = 384
/**
 * Vertices drawn per life marker: up to LIFE_HOUSES slots of 36 vertices (4 walls, pyramid
 * roof). A town uses slot 0 for its hall, 1–7 for houses, 8–11 and 16–23 for its city wall,
 * 12–14 for its factory, chimney and smoke, and 15 for its monument.
 */
export const LIFE_HOUSES = 24
export const LIFE_VERTICES = LIFE_HOUSES * 36

const civPalette = /* wgsl */ `
const CIV_PALETTE = array<vec3f, ${CIV_COLORS.length}>(${CIV_COLORS.map(
  (c) => `vec3f(${c.map((v) => v.toFixed(2)).join(', ')})`,
).join(', ')});
`

// Life markers. Herds are a few low animals (their kind sets their size and coat). A town is
// a hall and a cluster of houses (more as it grows) whose shapes follow its era: huts of
// thatch, then wooden houses with roofs in the people's colour, stone walls and a keep, a
// palace, brick works with a smoking chimney, and glass towers; a learned, big town rings
// itself with a wall, and a monument stands beside it if it raised one (pyramid, temple or
// tower). Ruins are broken walls sinking into the land, boats a hull and a sail on the sea
// routes, parties (caravans, armies, migrants, settlers) a file of little figures walking
// their road, dams a stone wall across the river, and battles a red burst on the ground
// that fades. Every marker gets LIFE_VERTICES vertices: a slot is 36 (4 walls of 6, a
// pyramid roof of 12); unused ones collapse to a point.
export const lifeShader = common + civPalette + /* wgsl */ `
@group(0) @binding(1) var<storage, read> ground: array<vec4f>;
@group(0) @binding(2) var<storage, read> water: array<vec4f>;
// per marker: (uv, kind (0 herd, 1 town, 2 battle, 3 ruin, 4 boat, 5 party, 6 dam, 7 plane,
// 8 fire, 9 nuclear blast, 10 hurricane), size),
// (health (a boat, party or dam: its heading), civ colour index, tech,
//  flag: a herd's species, a town's or ruin's monument, a party's kind (0 caravan, 1 army, 2 migrants, 3 settlers))
@group(0) @binding(3) var<storage, read> markers: array<vec4f>;

fn ixn(x: i32, y: i32, n: i32) -> u32 {
  return u32(clamp(y, 0, n - 1) * n + clamp(x, 0, n - 1));
}
fn surfaceAt(uv: vec2f) -> f32 {
  let n = i32(C.params.x);
  let p = vec2i(floor(uv * f32(n)));
  let j = ixn(p.x, p.y, n);
  return ground[j].x + water[j].x;
}
fn hash2(a: u32, b: u32) -> f32 {
  var h = a * 374761393u + b * 668265263u;
  h = (h ^ (h >> 13u)) * 1274126177u;
  return f32(h & 0xffffu) / 65535.0;
}

struct LifeOut {
  @builtin(position) pos: vec4f,
  @location(0) color: vec3f,
  @location(1) world: vec3f,
  @location(2) alpha: f32,
  // 0 lit by the sun, 1 shining by itself (fire)
  @location(3) glow: f32,
  // a hurricane's disc of cloud: xy the place on it (the rim at 1), z its strength (0: not
  // a hurricane), w the way it turns (1 anticlockwise, −1 clockwise)
  @location(4) disc: vec4f,
}

// corners of a unit square, counter-clockwise seen from above
const CORNER = array<vec2f, 4>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, 1.0));
// the two triangles of a quad: corner indices
const QUAD = array<u32, 6>(0u, 1u, 2u, 0u, 2u, 3u);
// coats of the species (see SPECIES in life.ts): deer, bison, camels, mammoths, elephants
const COATS = array<vec3f, 5>(vec3f(0.6, 0.4, 0.22), vec3f(0.3, 0.2, 0.12), vec3f(0.78, 0.64, 0.4), vec3f(0.42, 0.32, 0.25), vec3f(0.5, 0.5, 0.53));
const STONE = vec3f(0.62, 0.6, 0.56);
const THATCH = vec3f(0.6, 0.5, 0.28);
const WOOD = vec3f(0.55, 0.42, 0.28);
const BRICK = vec3f(0.52, 0.31, 0.25);
const GLASS = vec3f(0.7, 0.77, 0.85);

// One piece of a marker: a box with a pyramid roof. Its footprint is hw across and
// hw * stretch along, turned by heading; it stands offset (world units) from the marker,
// lifted from the ground by lift.
struct Piece {
  on: bool,
  hw: f32,
  stretch: f32,
  h: f32,
  roofH: f32,
  offset: vec2f,
  heading: f32,
  lift: f32,
  noRoof: bool,
  wall: vec3f,
  roof: vec3f,
  alpha: f32,
  /** Stands at an absolute height (base) instead of on the ground. */
  absolute: bool,
  base: f32,
  /** 0 lit by the sun, 1 shining by itself. */
  glow: f32,
}

// the eras by technology (see ERAS in life.ts): stone, bronze, iron, medieval, renaissance, industrial, modern
fn eraOf(tech: f32) -> u32 {
  if (tech >= 0.92) { return 6u; }
  if (tech >= 0.8) { return 5u; }
  if (tech >= 0.6) { return 4u; }
  if (tech >= 0.45) { return 3u; }
  if (tech >= 0.3) { return 2u; }
  if (tech >= 0.15) { return 1u; }
  return 0u;
}

// an offset (world units, as the pieces take it) for a step along and across a heading
fn along(heading: f32, s: f32, across: f32) -> vec2f {
  return vec2f(cos(heading), -sin(heading)) * s + vec2f(-sin(heading), -cos(heading)) * across;
}

fn piece(kind: u32, slot: u32, m: vec4f, extra: vec4f, inst: u32) -> Piece {
  var p: Piece;
  p.on = false;
  p.hw = 0.0022;
  p.stretch = 1.0;
  p.h = 0.0028;
  p.roofH = 0.0;
  p.offset = vec2f(0.0);
  p.heading = 0.0;
  p.lift = -0.0008;
  p.noRoof = false;
  p.alpha = 1.0;
  p.wall = WOOD;
  p.roof = vec3f(0.5);
  p.absolute = false;
  p.base = 0.0;
  p.glow = 0.0;
  let size = m.w;
  let health = extra.x;
  let tint = CIV_PALETTE[u32(clamp(extra.y, 0.0, ${CIV_COLORS.length - 1}.0))];
  let tech = extra.z;
  let flag = u32(extra.w + 0.5);
  let time = C.clouds.z;
  let jitter = hash2(inst, slot);
  let jitter2 = hash2(slot, inst);

  if (kind == 0u) {
    // a herd: three animals, bigger for the big species
    if (slot >= 3u) { return p; }
    p.on = true;
    p.hw = 0.0008 + 0.0009 * size;
    p.h = 0.0008 + 0.0012 * size;
    p.roofH = p.h * 0.25;
    let spread = 0.003 + 0.002 * size;
    if (slot > 0u) {
      let a = f32(slot) * 2.399963 + jitter * 1.2;
      p.offset = vec2f(cos(a), sin(a)) * spread * (0.6 + 0.4 * jitter2);
    }
    let coat = COATS[min(flag, 4u)];
    p.wall = mix(coat * 0.7 + vec3f(0.15), coat, health);
    p.roof = p.wall * 0.75;
    return p;
  }

  if (kind == 1u) {
    let era = eraOf(tech);
    let houses = 1u + u32(round(size * 6.0));
    let spread = 0.006 + 0.006 * size;
    // the climate's strain (and the plague) shows as grey
    let grey = vec3f(0.45, 0.45, 0.47);
    let strain = 0.35 + 0.65 * health;
    if (slot == 0u) {
      // the hall: a great hut, a longhouse, a keep, a palace, a glass tower
      p.on = true;
      let grow = 1.0 + 0.3 * size;
      if (era == 0u) { p.hw = 0.0026 * grow; p.h = 0.002; p.roofH = 0.0032; p.wall = WOOD * 0.8; p.roof = THATCH; }
      else if (era <= 2u) { p.hw = 0.0022 * grow; p.stretch = 1.8; p.h = 0.0032; p.roofH = 0.0016; p.wall = WOOD; p.roof = tint; }
      else if (era == 3u) { p.hw = 0.0022 * grow; p.h = 0.009; p.roofH = 0.0025; p.wall = STONE; p.roof = tint * 0.85; }
      else if (era <= 5u) { p.hw = 0.0032 * grow; p.stretch = 1.5; p.h = 0.0045; p.roofH = 0.0028; p.wall = vec3f(0.86, 0.83, 0.75); p.roof = tint; }
      else { p.hw = 0.002 * grow; p.h = 0.018; p.roofH = 0.0003; p.wall = GLASS; p.roof = vec3f(0.45, 0.5, 0.56); }
      p.heading = jitter * 0.6;
    } else if (slot < 8u) {
      // the houses, in a loose ring, shaped by the era
      if (slot >= houses) { return p; }
      p.on = true;
      let a = f32(slot) * 2.399963 + jitter * 1.2;
      p.offset = vec2f(cos(a), sin(a)) * spread * (0.6 + 0.4 * jitter2);
      p.heading = jitter2 * 3.14159;
      let scale = 0.75 + 0.35 * hash2(inst * 7u, slot);
      if (era == 0u) { p.hw = 0.0015 * scale; p.h = 0.0015 * scale; p.roofH = p.h * 1.1; p.wall = WOOD * 0.8; p.roof = mix(THATCH, tint, 0.35); }
      else if (era <= 2u) { p.hw = 0.002 * scale; p.h = 0.0026 * scale; p.roofH = p.h * 0.5; p.wall = WOOD; p.roof = tint; }
      else if (era == 3u) { p.hw = 0.002 * scale; p.h = 0.0032 * scale; p.roofH = p.h * 0.55; p.wall = mix(WOOD, STONE, 0.6); p.roof = tint * 0.8; }
      else if (era == 4u) { p.hw = 0.0021 * scale; p.stretch = 1.3; p.h = 0.0036 * scale; p.roofH = p.h * 0.4; p.wall = vec3f(0.85, 0.82, 0.74); p.roof = tint * 0.9; }
      else if (era == 5u) { p.hw = 0.0022 * scale; p.stretch = 1.4; p.h = 0.004 * scale; p.roofH = p.h * 0.25; p.wall = BRICK; p.roof = mix(vec3f(0.3, 0.3, 0.32), tint, 0.3); }
      else { p.hw = 0.0018 * scale; p.h = (0.005 + 0.006 * jitter) * scale; p.roofH = 0.0002; p.wall = mix(GLASS, tint, 0.15); p.roof = vec3f(0.5, 0.55, 0.6); }
    } else if (slot < 12u || slot >= 16u) {
      // the city wall: three stretches a side around the houses, each on its own ground,
      // once the people works iron, until cannon make it moot
      if (era < 2u || era > 4u || size < 0.5) { return p; }
      p.on = true;
      let ring = spread * 1.15 + 0.0015;
      let piece = select(slot - 16u + 4u, slot - 8u, slot < 12u);
      let side = piece % 4u;
      let third = f32(piece / 4u) - 1.0;
      p.heading = f32(side) * 1.5707963;
      p.offset = along(p.heading, third * ring * 0.667, ring);
      p.hw = 0.0003;
      p.stretch = (ring * 0.36) / p.hw;
      p.h = 0.0013;
      p.lift = -0.0005;
      p.roofH = 0.0002;
      p.wall = STONE * 0.9;
      p.roof = STONE * 0.75;
    } else if (slot < 15u) {
      // the works: a brick factory, its chimney and the smoke over it
      if (era < 5u || size < 0.5) { return p; }
      p.on = true;
      let at = vec2f(-spread - 0.0035, -0.002);
      if (slot == 12u) { p.offset = at; p.hw = 0.0028; p.stretch = 1.6; p.h = 0.0026; p.roofH = 0.0002; p.wall = BRICK; p.roof = vec3f(0.3, 0.3, 0.32); }
      else if (slot == 13u) { p.offset = at + vec2f(0.003, 0.0014); p.hw = 0.00045; p.h = 0.0078; p.roofH = 0.0001; p.wall = vec3f(0.4, 0.38, 0.37); p.roof = p.wall; }
      else {
        let drift = fract(time * 0.25 + jitter);
        p.offset = at + vec2f(0.003 + drift * 0.004, 0.0014 + sin(time * 0.9) * 0.0008);
        p.hw = 0.0009 + 0.002 * drift;
        p.h = 0.003;
        p.lift = 0.0075 + drift * 0.004;
        p.noRoof = true;
        p.wall = vec3f(0.6, 0.6, 0.62);
        p.alpha = 0.3 * (1.0 - drift);
      }
    } else {
      // the monument stands apart, on the town's east side
      if (flag == 0u) { return p; }
      p.on = true;
      p.offset = vec2f(spread + 0.004, 0.0015);
      if (flag == 1u) { p.hw = 0.0036; p.h = 0.0005; p.roofH = 0.0042; p.wall = vec3f(0.82, 0.72, 0.52); p.roof = p.wall; }
      else if (flag == 2u) { p.hw = 0.0032; p.h = 0.003; p.roofH = 0.0012; p.wall = vec3f(0.9, 0.88, 0.8); p.roof = vec3f(0.55, 0.5, 0.45); }
      else { p.hw = 0.0013; p.h = 0.0095; p.roofH = 0.0026; p.wall = vec3f(0.86, 0.85, 0.8); p.roof = tint; }
      return p;
    }
    p.wall = mix(grey, p.wall, strain);
    p.roof = mix(grey, p.roof, strain);
    return p;
  }

  if (kind == 3u) {
    // a ruin: three broken walls, lower the older, and the stump of its monument
    let stone = mix(vec3f(0.5, 0.47, 0.42), tint, 0.12) * (0.9 + 0.2 * jitter);
    if (slot < 3u) {
      p.on = true;
      p.noRoof = true;
      p.h = 0.0028 * (0.25 + 0.45 * size);
      p.lift = -0.0008 - 0.0012 * (1.0 - size);
      if (slot > 0u) {
        let a = f32(slot) * 2.399963 + jitter * 1.2;
        p.offset = vec2f(cos(a), sin(a)) * 0.007 * (0.6 + 0.4 * jitter2);
      }
      p.hw = 0.0022 * (0.75 + 0.35 * hash2(inst * 7u, slot));
      p.wall = stone;
      return p;
    }
    if (slot == 15u && flag > 0u) {
      p.on = true;
      p.offset = vec2f(0.011, 0.0015);
      p.noRoof = flag != 1u;
      if (flag == 1u) { p.hw = 0.0036; p.h = 0.00025; p.roofH = 0.0013; }
      else if (flag == 2u) { p.hw = 0.0032; p.h = 0.0015; }
      else { p.hw = 0.0013; p.h = 0.0047; }
      p.wall = stone;
      p.roof = stone;
    }
    return p;
  }

  if (kind == 4u) {
    // a boat, bobbing: a long hull and a sail; a steamship (flag 1) has a funnel and its
    // smoke instead, a cargo ship (flag 2) a long deck of boxes and a bridge at the stern
    if (slot > 2u || (flag == 0u && slot > 0u)) { return p; }
    p.on = true;
    p.heading = health;
    let bob = 0.0001 + 0.00015 * sin(time * 3.0 + f32(inst));
    p.lift = bob;
    if (flag == 0u) {
      p.hw = 0.0009;
      p.h = 0.0005;
      p.stretch = 2.4;
      p.roofH = 0.0028;
      p.wall = vec3f(0.36, 0.25, 0.14);
      p.roof = mix(vec3f(0.95, 0.93, 0.86), tint, 0.35);
      return p;
    }
    let cargo = flag >= 2u;
    if (slot == 0u) {
      p.hw = select(0.0011, 0.0013, cargo);
      p.stretch = select(2.8, 3.6, cargo);
      p.h = select(0.0007, 0.0008, cargo);
      p.roofH = 0.00005;
      p.wall = select(vec3f(0.2, 0.18, 0.17), vec3f(0.5, 0.16, 0.12), cargo);
      p.roof = vec3f(0.55, 0.5, 0.45);
    } else if (slot == 1u) {
      if (cargo) {
        // the boxes on deck, in the people's colour
        p.offset = along(health, 0.0006, 0.0);
        p.hw = 0.001; p.stretch = 2.6; p.h = 0.0009; p.roofH = 0.00005;
        p.lift = bob + 0.0008;
        p.wall = mix(vec3f(0.7, 0.45, 0.2), tint, 0.6);
        p.roof = p.wall * 0.85;
      } else {
        // the funnel
        p.hw = 0.0003; p.h = 0.0022; p.roofH = 0.00005;
        p.lift = bob + 0.0007;
        p.wall = vec3f(0.2, 0.2, 0.22);
        p.roof = tint;
      }
    } else if (cargo) {
      // the bridge at the stern
      p.offset = along(health, -0.0034, 0.0);
      p.hw = 0.0008; p.h = 0.002; p.roofH = 0.00005;
      p.lift = bob + 0.0008;
      p.wall = vec3f(0.92, 0.92, 0.9);
      p.roof = vec3f(0.5, 0.52, 0.55);
    } else {
      // the steamship's smoke, trailing behind
      let drift = fract(time * 0.3 + jitter);
      p.offset = along(health, -drift * 0.004, 0.0);
      p.hw = 0.0005 + 0.0014 * drift;
      p.h = 0.0016;
      p.lift = bob + 0.0032 + drift * 0.003;
      p.noRoof = true;
      p.wall = vec3f(0.35, 0.35, 0.37);
      p.alpha = 0.35 * (1.0 - drift);
    }
    return p;
  }

  if (kind == 5u) {
    // a party on the road: a file of little figures walking, led by a cart or a banner
    let n = 3u + u32(round(size * 4.0));
    if (slot >= n) { return p; }
    p.on = true;
    p.heading = health;
    let step = f32(slot) - f32(n - 1u) * 0.5;
    p.offset = along(p.heading, -step * 0.0016, (jitter2 - 0.5) * 0.0012);
    p.hw = 0.00045;
    p.h = 0.0015;
    p.roofH = 0.0005;
    p.lift = 0.00015 * abs(sin(time * 9.0 + f32(slot) * 1.7 + jitter * 6.0));
    if (flag == 0u) { p.wall = vec3f(0.5, 0.38, 0.25); p.roof = vec3f(0.78, 0.65, 0.4); }
    else if (flag == 1u) { p.wall = tint * 0.8; p.roof = vec3f(0.75, 0.75, 0.78); }
    else if (flag == 2u) { p.wall = vec3f(0.45, 0.42, 0.38); p.roof = vec3f(0.33, 0.29, 0.27); p.h = 0.0009; }
    else { p.wall = vec3f(0.55, 0.45, 0.32); p.roof = tint; }
    if (slot == 0u) {
      if (flag == 1u) {
        // the banner: a pole with the people's colours flying from it
        p.hw = 0.0002; p.h = 0.0045; p.roofH = 0.0016; p.wall = vec3f(0.45, 0.35, 0.25); p.roof = tint; p.lift = 0.0;
      } else if (flag != 2u) {
        // a cart or a wagon leads the way
        p.hw = 0.0007; p.stretch = 1.7; p.h = 0.001; p.roofH = 0.0007; p.lift = 0.0001;
        p.roof = select(vec3f(0.75, 0.6, 0.35), mix(vec3f(0.9, 0.88, 0.8), tint, 0.3), flag == 3u);
      }
    }
    return p;
  }

  if (kind == 6u) {
    // a dam: a stone wall across the river in short stretches, from the bed up to its crest
    // (tech carries the crest height); the stretches buried in the banks are not drawn
    let crest = tech;
    let n = 9u;
    if (slot >= n) { return p; }
    p.heading = health;
    let cell = C.world.w / C.params.x;
    let step = (2.0 * ${DAM_HALF}) / f32(n);
    p.offset = along(p.heading, (f32(slot) - f32(n - 1u) * 0.5) * step, 0.0);
    let at = clamp(m.xy + p.offset / C.world.w, vec2f(0.0), vec2f(0.9999));
    let j = ixn(i32(at.x * C.params.x), i32(at.y * C.params.x), i32(C.params.x));
    // the bank is higher than the crest here: nothing to build
    if (ground[j].x > crest - 0.0008) { return p; }
    p.on = true;
    p.absolute = true;
    p.hw = cell * 1.4;
    p.stretch = (step * 0.5) / p.hw;
    p.base = crest - ${DAM_HEIGHT} - 0.002;
    p.h = ${DAM_HEIGHT} + 0.003;
    p.roofH = 0.00005;
    p.wall = vec3f(0.47, 0.45, 0.42);
    p.roof = vec3f(0.6, 0.58, 0.54);
    return p;
  }

  if (kind == 7u) {
    // a plane, high over the land: fuselage, wings, tail and a contrail thinning out behind
    // (size: how far it is from either end of its route, so the trail grows after take-off)
    if (slot > 6u) { return p; }
    p.on = true;
    p.heading = health;
    p.lift = 0.022;
    p.wall = vec3f(0.93, 0.93, 0.95);
    p.roof = tint;
    if (slot == 0u) { p.hw = 0.0006; p.stretch = 4.0; p.h = 0.0007; p.roofH = 0.0002; }
    else if (slot == 1u) { p.heading = health + 1.5707963; p.hw = 0.0005; p.stretch = 5.0; p.h = 0.00018; p.roofH = 0.00005; p.lift = 0.0223; }
    else if (slot == 2u) { p.offset = along(health, -0.002, 0.0); p.hw = 0.00022; p.h = 0.0011; p.roofH = 0.0001; p.lift = 0.0226; p.wall = tint; }
    else {
      let n = f32(slot - 3u);
      p.offset = along(health, -0.005 - n * 0.006, 0.0);
      p.hw = 0.00035 + 0.00012 * n;
      p.stretch = 8.0;
      p.h = 0.00015;
      p.noRoof = true;
      p.lift = 0.0224;
      p.alpha = 0.4 * (1.0 - n * 0.24) * clamp(size * 60.0, 0.0, 1.0);
    }
    return p;
  }

  if (kind == 8u) {
    // a fire: tongues of flame flickering over the burning ground and the smoke rising from
    // them (size: how hard it burns)
    if (slot > 9u) { return p; }
    p.on = true;
    let reach = 0.003 + 0.007 * size;
    let a = f32(slot) * 2.399963 + jitter * 6.2831853;
    if (slot < 6u) {
      p.offset = vec2f(cos(a), sin(a)) * reach * (0.2 + 0.8 * jitter2);
      p.hw = 0.0012 + 0.001 * jitter2;
      p.h = 0.0003;
      p.roofH = (0.0035 + 0.005 * size) * (0.55 + 0.45 * sin(time * 11.0 + jitter * 20.0));
      p.lift = 0.0;
      p.wall = vec3f(1.0, 0.25, 0.02);
      p.roof = vec3f(1.0, 0.62, 0.1);
      p.glow = 1.0;
    } else {
      let drift = fract(time * 0.22 + jitter);
      p.offset = vec2f(cos(a), sin(a)) * reach * 0.5 + vec2f(drift * 0.006, 0.0);
      p.hw = 0.0012 + 0.004 * drift;
      p.h = 0.003;
      p.lift = 0.003 + drift * 0.018;
      p.noRoof = true;
      p.wall = vec3f(0.25, 0.24, 0.24);
      p.alpha = 0.45 * (1.0 - drift) * (0.4 + 0.6 * size);
    }
    return p;
  }

  if (kind == 9u) {
    // a nuclear blast: the fireball on the ground, the stem and the cap of the mushroom
    // rising and fading (size: 1 at the flash, 0 when it is gone)
    if (slot > 2u) { return p; }
    p.on = true;
    let grown = 1.0 - size;
    let rise = 0.35 + 0.65 * smoothstep(0.0, 0.5, grown);
    let ash = mix(vec3f(1.0, 0.75, 0.3), vec3f(0.45, 0.42, 0.4), smoothstep(0.1, 0.6, grown));
    p.alpha = smoothstep(0.0, 0.25, size);
    p.glow = smoothstep(0.5, 1.0, size);
    p.wall = ash;
    p.roof = ash * 0.9;
    if (slot == 0u) { p.hw = 0.011 * rise; p.h = 0.002; p.roofH = 0.009 * rise; p.lift = 0.0; }
    else if (slot == 1u) { p.hw = 0.004; p.h = 0.05 * rise; p.noRoof = true; }
    else { p.hw = 0.017 * rise; p.h = 0.009; p.roofH = 0.01; p.lift = 0.05 * rise; }
    return p;
  }

  return p;
}

fn gone(out: ptr<function, LifeOut>) {
  (*out).pos = vec4f(0.0, 0.0, 2.0, 1.0);
}

@vertex
fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) inst: u32) -> LifeOut {
  let m = markers[inst * 2u];
  let extra = markers[inst * 2u + 1u];
  let kind = u32(m.z + 0.5);
  let slot = vi / 36u;
  let k = vi % 36u;
  var out: LifeOut;
  out.alpha = 1.0;

  if (kind == 2u) {
    // a battle: a flat eight-pointed burst, the first 24 vertices
    if (vi >= 24u) { gone(&out); return out; }
    let t = f32(vi / 3u);
    let c = vi % 3u;
    let r = (0.012 + 0.008 * (1.0 - m.w)) / C.world.w;
    let a0 = t * 0.785398;
    let a1 = a0 + 0.392699;
    var p = vec2f(0.0);
    if (c == 1u) { p = vec2f(cos(a0), sin(a0)) * r; }
    if (c == 2u) { p = vec2f(cos(a1), sin(a1)) * r * 0.45; }
    let uv = m.xy + p;
    let world = worldPos(uv, surfaceAt(clamp(uv, vec2f(0.0), vec2f(1.0))) + 0.0015);
    out.pos = C.viewProj * vec4f(world, 1.0);
    out.world = world;
    out.color = mix(vec3f(1.0, 0.25, 0.1), vec3f(1.0, 0.8, 0.3), select(0.0, 1.0, c == 0u));
    out.alpha = 0.85 * m.w;
    return out;
  }

  if (kind == 10u) {
    // a hurricane: a flat disc of cloud high over the sea (a fan of 32 triangles); the
    // spiral arms and the eye are drawn in the fragment shader (size: its radius in world
    // units; health: its strength; flag 1: it turns the other way, south of the equator)
    if (vi >= 96u) { gone(&out); return out; }
    let t = f32(vi / 3u);
    let c = vi % 3u;
    var q = vec2f(0.0);
    if (c == 1u) { q = vec2f(cos(t * 0.19634954), sin(t * 0.19634954)); }
    if (c == 2u) { q = vec2f(cos((t + 1.0) * 0.19634954), sin((t + 1.0) * 0.19634954)); }
    let uv = m.xy + q * (m.w * 1.5) / C.world.w;
    let world = worldPos(uv, surfaceAt(clamp(m.xy, vec2f(0.0), vec2f(1.0))) + 0.036);
    out.pos = C.viewProj * vec4f(world, 1.0);
    out.world = world;
    out.color = vec3f(1.0);
    out.disc = vec4f(q, max(extra.x, 0.05), select(1.0, -1.0, u32(extra.w + 0.5) == 1u));
    return out;
  }

  let p = piece(kind, slot, m, extra, inst);
  if (!p.on) { gone(&out); return out; }
  if (p.noRoof && k >= 24u) { gone(&out); return out; }

  let center = m.xy + p.offset / C.world.w;
  let base = select(surfaceAt(clamp(center, vec2f(0.0), vec2f(1.0))) + p.lift, p.base, p.absolute);
  let hw = p.hw;
  let h = p.h;

  var local = vec3f(0.0);
  var normal = vec3f(0.0, 1.0, 0.0);
  var roof = false;
  if (k < 24u) {
    // wall f between corners f and f+1
    let f = k / 6u;
    let q = QUAD[k % 6u];
    let c0 = CORNER[f];
    let c1 = CORNER[(f + 1u) % 4u];
    let at = select(c0, c1, q == 1u || q == 2u);
    let up = select(0.0, h, q == 2u || q == 3u);
    local = vec3f(at.x * hw * p.stretch, up, at.y * hw);
    let edge = c1 - c0;
    normal = normalize(vec3f(edge.y, 0.0, -edge.x));
  } else {
    roof = true;
    let t = (k - 24u) / 3u;
    let c = (k - 24u) % 3u;
    var c0 = CORNER[t] * vec2f(hw * p.stretch, hw) * 1.15;
    var c1 = CORNER[(t + 1u) % 4u] * vec2f(hw * p.stretch, hw) * 1.15;
    if (kind == 4u) {
      // the sail: a narrow pyramid amidships
      c0 = CORNER[t] * vec2f(hw * 0.9, hw * 0.25);
      c1 = CORNER[(t + 1u) % 4u] * vec2f(hw * 0.9, hw * 0.25);
    }
    if (c == 0u) { local = vec3f(c0.x, h, c0.y); }
    else if (c == 1u) { local = vec3f(c1.x, h, c1.y); }
    else { local = vec3f(0.0, h + p.roofH, 0.0); }
    let e = c1 - c0;
    // a flat roof is lit as one face, not as four
    normal = select(normalize(vec3f(e.y, length(e) * 0.8, -e.x)), vec3f(0.0, 1.0, 0.0), p.roofH < 0.00015);
  }
  if (p.heading != 0.0) {
    // turned to its heading (window v runs the other way from world z)
    let ch = cos(p.heading);
    let sh = sin(p.heading);
    local = vec3f(local.x * ch + local.z * sh, local.y, -local.x * sh + local.z * ch);
    normal = vec3f(normal.x * ch + normal.z * sh, normal.y, -normal.x * sh + normal.z * ch);
  }
  // the window's v runs the other way from world z
  let world = worldPos(center, base) + vec3f(local.x, local.y, -local.z);
  out.pos = C.viewProj * vec4f(world, 1.0);
  out.world = world;

  let color = select(p.wall, p.roof, roof) * (0.92 + 0.16 * hash2(inst * 3u, slot));
  let sunLit = max(dot(normal, normalize(C.light.xyz)), 0.0);
  let shade = 0.45 + 0.55 * sunLit;
  out.color = color * mix(shade, 1.0, p.glow);
  out.alpha = p.alpha;
  out.glow = p.glow;
  return out;
}

@fragment
fn fs(in: LifeOut) -> @location(0) vec4f {
  if (in.disc.z > 0.0) {
    // the hurricane seen from above: a clear eye, a thick wall of cloud round it and two
    // arms winding out, all turning (faster the stronger it is) and fraying at the rim
    let r = length(in.disc.xy);
    if (r >= 1.0) { discard; }
    let strength = in.disc.z;
    let turn = in.disc.w;
    let a = atan2(in.disc.y, in.disc.x);
    let spin = C.clouds.z * (0.45 + 0.9 * strength);
    let phase = 2.0 * (a - turn * spin) + turn * 5.5 * log(max(r, 0.03));
    let arms = smoothstep(0.15, 0.8, 0.5 + 0.5 * cos(phase));
    // smaller bands of cloud riding on the arms
    let ragged = 0.88 + 0.12 * sin(phase * 3.0 + r * 16.0);
    let eye = smoothstep(0.05 + 0.03 * (1.0 - strength), 0.12, r);
    let wall = 1.0 - smoothstep(0.14, 0.42, r);
    let cloud = max(wall, arms * (1.0 - smoothstep(0.45, 1.0, r))) * eye * ragged;
    // the tops catch the light, the gaps between the arms are in shade
    let tone = mix(vec3f(0.62, 0.66, 0.72), vec3f(1.0), smoothstep(0.2, 0.9, cloud));
    let shaded = aerial(tone * lightColor() * mix(0.5, 1.0, C.sun.w), in.world);
    return vec4f(finish(shaded), clamp(cloud * (0.6 + 0.35 * strength), 0.0, 0.95));
  }
  let lit = aerial(mix(in.color * lightColor() * mix(0.5, 1.0, C.sun.w), in.color, in.glow), in.world);
  return vec4f(finish(lit), in.alpha);
}
`

// Roads and routes: each segment is a thin strip of ROAD_PIECES quads laid on the terrain
// between two towns (dirt, then paved as the people learns), golden and dashed for a trade
// route between peoples, and a faint wake line for a sea route. A piece over open water is
// not drawn (the river is forded; the sea is sailed).
export const ROAD_PIECES = 16
export const ROAD_VERTICES = ROAD_PIECES * 6
export const roadShader = common + /* wgsl */ `
@group(0) @binding(1) var<storage, read> ground: array<vec4f>;
@group(0) @binding(2) var<storage, read> water: array<vec4f>;
// per segment: (a.uv, b.uv), (kind: 0 dirt road, 1 paved road, 2 trade route, 3 sea route; 0, 0, 0)
@group(0) @binding(3) var<storage, read> roads: array<vec4f>;

fn ixn(x: i32, y: i32, n: i32) -> u32 {
  return u32(clamp(y, 0, n - 1) * n + clamp(x, 0, n - 1));
}
fn cellOf(uv: vec2f) -> u32 {
  let n = i32(C.params.x);
  let p = vec2i(floor(clamp(uv, vec2f(0.0), vec2f(0.9999)) * f32(n)));
  return ixn(p.x, p.y, n);
}

struct RoadOut {
  @builtin(position) pos: vec4f,
  @location(0) color: vec3f,
  @location(1) world: vec3f,
  @location(2) alpha: f32,
  @location(3) along: f32,
  @location(4) @interpolate(flat) kind: f32,
}

@vertex
fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) inst: u32) -> RoadOut {
  let seg = roads[inst * 2u];
  let info = roads[inst * 2u + 1u];
  let kind = u32(info.x + 0.5);
  let piece = vi / 6u;
  let q = vi % 6u;
  // corners: (t0, -1), (t1, -1), (t1, 1), (t0, -1), (t1, 1), (t0, 1)
  let atEnd = q == 1u || q == 2u || q == 4u;
  let side = select(-1.0, 1.0, q == 2u || q == 4u || q == 5u);
  let t = (f32(piece) + select(0.0, 1.0, atEnd)) / ${ROAD_PIECES}.0;
  let a = seg.xy;
  let b = seg.zw;
  let d = b - a;
  let len = max(length(d), 0.00001);
  let dir = d / len;
  let nrm = vec2f(-dir.y, dir.x);
  var width = 0.0009;
  if (kind == 1u) { width = 0.0012; }
  if (kind == 3u) { width = 0.0022; }
  let uv = a + d * t + nrm * (width / C.world.w) * side;
  let j = cellOf(uv);
  let depth = water[j].x;
  var out: RoadOut;
  // roads stop at open water; sea routes show only on it
  let wet = depth > 0.0015;
  if ((kind != 3u && wet) || (kind == 3u && !wet)) {
    out.pos = vec4f(0.0, 0.0, 2.0, 1.0);
    return out;
  }
  let world = worldPos(uv, ground[j].x + depth + select(0.0005, 0.0002, kind == 3u));
  out.pos = C.viewProj * vec4f(world, 1.0);
  out.world = world;
  out.along = t * len * C.world.w;
  out.kind = f32(kind);
  if (kind == 0u) { out.color = vec3f(0.42, 0.33, 0.22); out.alpha = 0.8; }
  else if (kind == 1u) { out.color = vec3f(0.4, 0.39, 0.37); out.alpha = 0.9; }
  else if (kind == 2u) { out.color = vec3f(0.8, 0.65, 0.3); out.alpha = 0.9; }
  else { out.color = vec3f(0.85, 0.92, 1.0); out.alpha = 0.35; }
  return out;
}

@fragment
fn fs(in: RoadOut) -> @location(0) vec4f {
  var alpha = in.alpha;
  // trade and sea routes are dashed
  if (in.kind > 1.5) {
    let dash = fract(in.along * 150.0);
    alpha *= smoothstep(0.35, 0.45, dash);
  }
  let lit = aerial(in.color * lightColor() * mix(0.6, 1.0, C.sun.w), in.world);
  return vec4f(finish(lit), alpha);
}
`

// The political map: one quad per cell of a grid over the window, laid on the terrain,
// filled with the owner's colour. Edges with a different owner are drawn as a border, in
// red and pulsing where the two are at war.
export const territoryShader = common + civPalette + /* wgsl */ `
@group(0) @binding(1) var<storage, read> ground: array<vec4f>;
@group(0) @binding(2) var<storage, read> water: array<vec4f>;
// per cell: 0 nobody; else owner colour + 1 in the low 4 bits, bits 4.. one per colour at war
// with; bit 19 set: painted in a colour of its own instead of the owner's, 4 bits each of
// red (28..), green (24..) and blue (20..) (the maps of eras, faiths, tongues and the like)
@group(0) @binding(3) var<storage, read> owners: array<u32>;

const T = ${TERRITORY_N};

fn ixn(x: i32, y: i32, n: i32) -> u32 {
  return u32(clamp(y, 0, n - 1) * n + clamp(x, 0, n - 1));
}
fn surfaceAt(uv: vec2f) -> f32 {
  let n = i32(C.params.x);
  let p = vec2i(floor(uv * f32(n)));
  let j = ixn(p.x, p.y, n);
  return ground[j].x + water[j].x;
}
fn ownerAt(x: i32, y: i32) -> u32 {
  if (x < 0 || y < 0 || x >= T || y >= T) { return 0u; }
  return owners[u32(y * T + x)];
}

struct TerrOut {
  @builtin(position) pos: vec4f,
  @location(0) color: vec3f,
  @location(1) local: vec2f,
  // per edge (left, right, top, bottom): 0 inside, 1 border, 2 war front
  @location(2) @interpolate(flat) edges: vec4f,
  @location(3) world: vec3f,
}

const QUAD = array<vec2f, 6>(vec2f(0.0, 0.0), vec2f(1.0, 0.0), vec2f(1.0, 1.0), vec2f(0.0, 0.0), vec2f(1.0, 1.0), vec2f(0.0, 1.0));

fn edgeKind(mine: u32, other: u32) -> f32 {
  let me = mine & 15u;
  let it = other & 15u;
  if (it == me) { return 0.0; }
  if (it != 0u && ((mine >> (4u + it - 1u)) & 1u) == 1u) { return 2.0; }
  return 1.0;
}

@vertex
fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) inst: u32) -> TerrOut {
  var out: TerrOut;
  let cell = owners[inst];
  if ((cell & 15u) == 0u) {
    out.pos = vec4f(0.0, 0.0, 2.0, 1.0);
    return out;
  }
  let x = i32(inst % u32(T));
  let y = i32(inst / u32(T));
  let q = QUAD[vi];
  let uv = (vec2f(f32(x), f32(y)) + q) / f32(T);
  let world = worldPos(uv, surfaceAt(clamp(uv, vec2f(0.0), vec2f(0.9999))) + 0.0006);
  out.pos = C.viewProj * vec4f(world, 1.0);
  out.world = world;
  out.local = q;
  out.color = CIV_PALETTE[(cell & 15u) - 1u];
  if (((cell >> 19u) & 1u) == 1u) {
    out.color = vec3f(f32((cell >> 28u) & 15u), f32((cell >> 24u) & 15u), f32((cell >> 20u) & 15u)) / 15.0;
  }
  out.edges = vec4f(
    edgeKind(cell, ownerAt(x - 1, y)),
    edgeKind(cell, ownerAt(x + 1, y)),
    edgeKind(cell, ownerAt(x, y - 1)),
    edgeKind(cell, ownerAt(x, y + 1)),
  );
  return out;
}

@fragment
fn fs(in: TerrOut) -> @location(0) vec4f {
  // distance to the nearest edge that is a border, and that border's kind
  var d = 1.0;
  var kind = 0.0;
  let dl = in.local.x;
  let dr = 1.0 - in.local.x;
  let dt = in.local.y;
  let db = 1.0 - in.local.y;
  if (in.edges.x > 0.0 && dl < d) { d = dl; kind = in.edges.x; }
  if (in.edges.y > 0.0 && dr < d) { d = dr; kind = in.edges.y; }
  if (in.edges.z > 0.0 && dt < d) { d = dt; kind = in.edges.z; }
  if (in.edges.w > 0.0 && db < d) { d = db; kind = in.edges.w; }
  // on the peoples' map the territories are painted solid; otherwise a tint over the land
  let strong = abs(C.params.z - 11.0) < 0.5;
  var color = in.color;
  var alpha = select(0.26, 0.6, strong);
  if (kind > 0.0) {
    let width = select(select(0.22, 0.16, strong), 0.4, kind > 1.5);
    let line = 1.0 - smoothstep(width * 0.6, width, d);
    if (kind > 1.5) {
      let pulse = 0.6 + 0.4 * sin(C.params.w * 4.0);
      color = mix(color, vec3f(1.0, 0.12, 0.08), line);
      alpha = mix(alpha, 0.95 * pulse, line);
    } else {
      color = mix(color, color * select(0.45, 0.3, strong), line);
      alpha = mix(alpha, select(0.8, 1.0, strong), line);
    }
  }
  if (strong) {
    // on the atlas the colours are flat, whatever the hour
    return vec4f(finish(atlasFade(color, in.world)), alpha);
  }
  let lit = aerial(color * lightColor() * mix(0.6, 1.0, C.sun.w), in.world);
  return vec4f(finish(lit), alpha);
}
`

// 3D clouds: a slab of cloud over the window, ray-marched. The slab's box is drawn and
// each pixel on its far side marches the view ray through the slab. The simulated
// humidity and rain give the cover; drifting noise shapes it into cumulus: columns with a
// flat base and bumpy tops, taller and denser the thicker the cover. Each lit sample looks
// a few steps towards the sun to shade the undersides (Beer's law), with the sky lighting
// the rest, and a forward-scattering glow when looking towards the sun. The march starts
// at a dithered offset per pixel (interleaved gradient noise), so there are no slices from
// any angle and no visible grain.
export const CLOUD_STEPS = 24
export const cloudShader = common + /* wgsl */ `
@group(0) @binding(1) var<storage, read> climate: array<vec4f>;
@group(0) @binding(2) var<storage, read> air: array<vec4f>;
@group(0) @binding(3) var<storage, read> ground: array<vec4f>;
@group(0) @binding(4) var<storage, read> water: array<vec4f>;

const BASE = 0.1;
const DEPTH = 0.08;
// the cloud base rides over the terrain: this much above the ground where the ground is
// higher than BASE, so clouds climb a range instead of passing through it
const OVER_GROUND = 0.012;
// how far above BASE + DEPTH the slab's box reaches, for the clouds over the high ground
const RANGE = 0.16;
// optical depth of the whole slab crossed straight up through a solid cloud
const EXTINCTION = 8.0;
// steps towards the light to shade a sample, and how far apart (in slab depths)
const LIGHT_STEPS = 3;
const LIGHT_STEP = 0.3;

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
  // (thinning out towards the edge of the window, where the slab ends)
  let inset = min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y));
  return clamp(smoothstep(0.72, 1.05, rh) + smoothstep(0.0005, 0.004, rain) * 0.6, 0.0, 1.0) * smoothstep(0.0, 0.05, inset);
}
fn surfaceAt(uv: vec2f) -> f32 {
  let n = i32(C.params.x);
  let p = vec2i(floor(uv * f32(n)));
  let j = ixn(p.x, p.y, n);
  return ground[j].x + water[j].x;
}
// the terrain under a point, smoothly (bilinear), for the cloud base
fn surfaceSmooth(uv: vec2f) -> f32 {
  let n = i32(C.params.x);
  let t = clamp(uv, vec2f(0.0), vec2f(1.0)) * f32(n) - 0.5;
  let b = vec2i(floor(t));
  let f = fract(t);
  let i00 = ixn(b.x, b.y, n);
  let i10 = ixn(b.x + 1, b.y, n);
  let i01 = ixn(b.x, b.y + 1, n);
  let i11 = ixn(b.x + 1, b.y + 1, n);
  return mix(mix(ground[i00].x + water[i00].x, ground[i10].x + water[i10].x, f.x),
             mix(ground[i01].x + water[i01].x, ground[i11].x + water[i11].x, f.x), f.y);
}
// where the cloud layer starts over a place: BASE, lifted over the high ground
fn baseAt(uv: vec2f) -> f32 {
  return max(BASE, surfaceSmooth(uv) + OVER_GROUND);
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
// billowy noise: four octaves for the shape, two for the shading samples
fn fbm(p: vec3f, detail: bool) -> f32 {
  var v = valueNoise(p) * 0.5 + valueNoise(p * 2.07 + 11.0) * 0.25;
  if (detail) { v += valueNoise(p * 4.13 + 23.0) * 0.125 + valueNoise(p * 8.31 + 37.0) * 0.0625; } else { v *= 1.25; }
  return v / 0.9375;
}
// dithered start of the march (an ordered 4×4 pattern: fine and even, unlike random grain)
fn dither(p: vec2f) -> f32 {
  var m = array<f32, 16>(0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);
  let q = vec2u(p) % 4u;
  return (m[q.y * 4u + q.x] + 0.5) / 16.0;
}

struct CloudOut {
  @builtin(position) pos: vec4f,
  @location(0) world: vec3f,
}

// The slab's box: 12 triangles over the window, from BASE to BASE + DEPTH + RANGE.
@vertex
fn vs(@builtin(vertex_index) vi: u32) -> CloudOut {
  let corners = array<vec3f, 8>(
    vec3f(0.0, 0.0, 0.0), vec3f(1.0, 0.0, 0.0), vec3f(0.0, 1.0, 0.0), vec3f(1.0, 1.0, 0.0),
    vec3f(0.0, 0.0, 1.0), vec3f(1.0, 0.0, 1.0), vec3f(0.0, 1.0, 1.0), vec3f(1.0, 1.0, 1.0));
  let faces = array<u32, 36>(
    0u, 1u, 2u, 2u, 1u, 3u,  4u, 6u, 5u, 5u, 6u, 7u,
    0u, 4u, 1u, 1u, 4u, 5u,  2u, 3u, 6u, 6u, 3u, 7u,
    0u, 2u, 4u, 4u, 2u, 6u,  1u, 5u, 3u, 3u, 5u, 7u);
  let c = corners[faces[vi]];
  let world = worldPos(c.xy, BASE + c.z * (DEPTH + RANGE));
  var out: CloudOut;
  out.pos = C.viewProj * vec4f(world, 1.0);
  out.world = world;
  return out;
}

// Window uv of a world position (the inverse of worldPos).
fn uvOfWorld(p: vec3f) -> vec2f {
  return vec2f(p.x / C.world.w - C.world.x + 0.5, 0.5 - C.world.y - p.z / C.world.w);
}

// Cloud density (0 – 1) at a world point under the given cover. Cumulus: the cover
// decides how much of the noise is cloud and how tall the columns grow; each column's
// top varies with its own noise, the base is flat.
fn density(p: vec3f, cov: f32, detail: bool) -> f32 {
  let uv = uvOfWorld(p);
  let layer = (p.y - baseAt(uv)) / DEPTH;
  let drift = vec3f(C.clouds.xy * 5.0, C.clouds.z * 0.002);
  // wider than tall: the noise is stretched sideways
  let q = vec3f((uv + C.world.xy) * C.world.w * 5.0, layer * 1.2) + drift;
  let column = valueNoise(vec3f(q.xy * 0.6, 3.7));
  let top = (0.35 + 0.5 * cov) * (0.65 + 0.35 * column);
  let profile = smoothstep(0.0, 0.12, layer) * (1.0 - smoothstep(top - 0.45, top, layer));
  if (profile <= 0.0) { return 0.0; }
  let n = fbm(q, detail);
  // (even under full cover the noise keeps gaps and bumps in the blanket)
  let threshold = 0.9 - 0.45 * cov;
  return smoothstep(threshold, threshold + 0.3, n) * profile;
}

// How much of the light reaches a point: a couple of coarse samples towards the light
// (under the same cover: it changes little over that distance).
fn lit(p: vec3f, dir: vec3f, cov: f32) -> f32 {
  var depth = 0.0;
  for (var k = 1; k <= LIGHT_STEPS; k++) {
    let q = p + dir * (LIGHT_STEP * DEPTH * f32(k));
    let b = baseAt(uvOfWorld(q));
    if (q.y > b + DEPTH || q.y < b) { break; }
    depth += density(q, cov, false);
  }
  return exp(-depth * LIGHT_STEP * EXTINCTION * 0.6);
}

@fragment
fn fs(in: CloudOut) -> @location(0) vec4f {
  let eye = C.eye.xyz;
  let ray = in.world - eye;
  let far = length(ray);
  let dir = ray / far;
  // where the ray enters and leaves the slab (the box around the window)
  let lo = vec3f((C.world.x - 0.5) * C.world.w, BASE, (-0.5 - C.world.y) * C.world.w);
  let hi = vec3f((C.world.x + 0.5) * C.world.w, BASE + DEPTH + RANGE, (0.5 - C.world.y) * C.world.w);
  let inv = 1.0 / dir;
  let t0 = (lo - eye) * inv;
  let t1 = (hi - eye) * inv;
  let tn = min(t0, t1);
  let tf = max(t0, t1);
  let enter = max(max(tn.x, tn.y), max(tn.z, 0.0));
  let leave = min(min(tf.x, tf.y), tf.z);
  // only the face where the ray leaves marches (the entry face would do it again)
  if (leave <= enter || far < leave - 0.0005 * C.world.w) { discard; }
  // coarse steps through clear air (no longer than straight down through the slab takes,
  // so a ray crossing it at a low angle samples the noise as finely), four times finer
  // inside a cloud, stepping back on entering one so its edge lands where it should
  let n = clamp(i32((leave - enter) / (DEPTH / ${CLOUD_STEPS}.0)), ${CLOUD_STEPS}, ${CLOUD_STEPS * 4});
  let dt = (leave - enter) / f32(n);
  let fine = dt * 0.25;
  var t = enter + dither(in.pos.xy) * dt;
  // the light: the sun (or the moon), and its colour; a glow towards it
  let lightDir = normalize(C.light.xyz);
  let towards = max(dot(dir, lightDir), 0.0);
  let glow = 1.0 + 1.5 * pow(towards, 6.0);
  let sun = lightColor();
  // the sky lights the clouds from above, the ground a little from below
  let skyLight = pow(skyColor(vec3f(0.0, 1.0, 0.0)), vec3f(1.8));
  var color = vec3f(0.0);
  var alpha = 0.0;
  var inside = false;
  var clear = 0;
  // (the fine steps are limited; past that the march goes on coarsely)
  for (var k = 0; k < n + 64; k++) {
    if (t >= leave) { break; }
    let p = eye + dir * t;
    let uv = uvOfWorld(p);
    // into a mountain: nothing beyond it shows
    if (surfaceAt(clamp(uv, vec2f(0.0), vec2f(1.0))) > p.y) { break; }
    // above or below the cloud layer here: stride on through the clear air
    let b = baseAt(uv);
    if (!inside && (p.y < b - 0.002 || p.y > b + DEPTH + 0.002)) { t += dt * 2.0; continue; }
    let cov = coverage(uv);
    var d = 0.0;
    if (cov > 0.01) { d = density(p, cov, true); }
    let step = select(dt, fine, inside && k < n + 60);
    if (d > 0.002) {
      if (!inside) {
        inside = true;
        clear = 0;
        t -= dt * 0.75;
        continue;
      }
      clear = 0;
      let layer = (p.y - baseAt(uv)) / DEPTH;
      var shade = 1.0;
      if (d > 0.03) { shade = lit(p, lightDir, cov); }
      // ambient: brighter towards the top of the cloud, dim at the base
      let ambient = skyLight * mix(0.22, 0.55, layer);
      let direct = sun * shade * glow * 0.6;
      let sample = finish(aerial(ambient + direct, p));
      let a = 1.0 - exp(-d * EXTINCTION * step / DEPTH);
      color += (1.0 - alpha) * a * sample;
      alpha += (1.0 - alpha) * a;
      if (alpha > 0.97) { break; }
    } else if (inside) {
      clear++;
      if (clear > 4) { inside = false; }
    }
    t += step;
  }
  if (alpha <= 0.002) { discard; }
  return vec4f(color / alpha, alpha);
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
  if (u32(C.params.z) == 11u) {
    // the atlas goes on past the window
    let paper = select(politicalLand(in.height, 0.0, select(0.0, 0.002, t < -1.0), in.normal), politicalWater(C.far.x - in.height), sea);
    return vec4f(finish(atlasFade(paper, in.world)), 1.0);
  }
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
