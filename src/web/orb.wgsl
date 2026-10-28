struct Params {
  res: vec2f,
  center: vec2f,
  time: f32,
  radius: f32,
  energy: f32,
  hue: f32,
  sat: f32,
  pulse: f32,
  spin: f32,
  ctx: f32,
  kv: f32,
  rate: f32,
  inward: f32,
  ages: vec4f,
  strs: vec4f,
  eye: vec4f,   // open, scale, smile, strain
  gaze: vec4f,  // x, y, glow, unused
}
@group(0) @binding(0) var<uniform> params: Params;

const TAU: f32 = 6.28318;
const PI: f32 = 3.14159;
const CAM: f32 = 5.5;

fn hsl2rgb(h: f32, s: f32, l: f32) -> vec3f {
  let k = (vec3f(0.0, 8.0, 4.0) + fract(h) * 12.0) % vec3f(12.0);
  let a = s * min(l, 1.0 - l);
  return l - a * clamp(min(k - 3.0, 9.0 - k), vec3f(-1.0), vec3f(1.0));
}

fn hash21(p: vec2f) -> f32 {
  var p3 = fract(vec3f(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

fn vnoise(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let w = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash21(i), hash21(i + vec2f(1.0, 0.0)), w.x),
    mix(hash21(i + vec2f(0.0, 1.0)), hash21(i + vec2f(1.0, 1.0)), w.x),
    w.y);
}

fn fbm(p: vec2f) -> f32 {
  var v = 0.0;
  var a = 0.5;
  var q = p;
  for (var i = 0; i < 4; i++) {
    v += a * vnoise(q);
    q = q * 2.03 + vec2f(1.7, 9.2);
    a *= 0.5;
  }
  return v;
}

fn band(x: f32, width: f32) -> f32 {
  return exp(-x * x * width * width);
}

fn rotX(a: f32) -> mat3x3f {
  let c = cos(a);
  let s = sin(a);
  return mat3x3f(vec3f(1.0, 0.0, 0.0), vec3f(0.0, c, s), vec3f(0.0, -s, c));
}

fn rotZ(a: f32) -> mat3x3f {
  let c = cos(a);
  let s = sin(a);
  return mat3x3f(vec3f(c, s, 0.0), vec3f(-s, c, 0.0), vec3f(0.0, 0.0, 1.0));
}

fn rotY(a: f32) -> mat3x3f {
  let c = cos(a);
  let s = sin(a);
  return mat3x3f(vec3f(c, 0.0, -s), vec3f(0.0, 1.0, 0.0), vec3f(s, 0.0, c));
}

// One side of the dotted shell around the orb: dots on an even lat/long grid, radius displaced by noise.
// Returns (dot intensity, longitude turns, latitude 0..1, unused).
fn shellDots(ro: vec3f, rd: vec3f, rot: mat3x3f, radius: f32, t: f32, amp: f32, front: bool) -> vec4f {
  let b = dot(ro, rd);
  var rad = radius;
  var n = vec3f(0.0, 0.0, 1.0);
  for (var k = 0; k < 2; k++) {
    let h = b * b - (dot(ro, ro) - rad * rad);
    if (h < 0.0) { return vec4f(0.0); }
    let s = sqrt(h);
    n = normalize(ro + rd * select(-b + s, -b - s, front));
    let l = transpose(rot) * n;
    rad = radius * (1.0 + amp * (fbm(l.xy * 1.7 + vec2f(l.z * 2.3 + t * 0.2, -t * 0.15)) - 0.5) * 2.0);
  }
  let l = transpose(rot) * n;
  let lat = asin(clamp(l.y, -1.0, 1.0));
  let lon = atan2(l.z, l.x);
  let act = clamp((amp - 0.03) / 0.12, 0.0, 1.0);
  let bands = 112.0;
  let bi = floor((lat / PI + 0.5) * bands);
  let bl = ((bi + 0.5) / bands - 0.5) * PI;
  let cnt = max(1.0, floor(2.0 * bands * cos(bl)));
  let u = (lon / TAU + 0.5) * cnt;
  let ci = floor(u);
  let jx = hash21(vec2f(ci, bi));
  let jy = hash21(vec2f(bi, ci + 7.3));
  // activity makes each dot drift around its slot and swell a little; at rest they are very fine
  let drift = act * 0.35 * (PI / bands);
  let dlon = (fract(u) - (0.2 + 0.6 * jx)) / cnt * TAU * cos(lat) - drift * sin(t * (1.5 + 3.0 * jy) + jx * TAU);
  let dlat = (lat - bl) - (jy - 0.5) * 0.4 * (PI / bands) - drift * cos(t * (1.2 + 3.0 * jx) + jy * TAU);
  let rdot = (PI / bands) * (0.15 + 0.1 * act);
  let tw = 0.55 + 0.45 * sin(t * (1.0 + 3.0 * jx) + jy * TAU);
  let inten = smoothstep(rdot, rdot * 0.25, length(vec2f(dlon, dlat))) * tw;
  // dots read brightest at the limb, where the shell is seen edge-on
  let limb = 0.3 + 0.7 * pow(1.0 - abs(dot(n, rd)), 1.4);
  return vec4f(inten * limb, lon / TAU + 0.5, lat / PI + 0.5, 0.0);
}

fn sdRoundBox(p: vec2f, b: vec2f, r: f32) -> f32 {
  let d = abs(p) - b;
  return length(max(d, vec2f(0.0))) + min(max(d.x, d.y), 0.0) - r;
}

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let t = params.time;
  let e = params.energy;
  let spin = params.spin;
  let glow = params.gaze.z;
  let p = (uv * params.res - params.center) / params.radius;
  let r = length(p);
  let ang = atan2(p.y, p.x);

  // a sphere that breathes; activity wobbles the silhouette a little
  let wob = (sin(ang * 3.0 + t * 0.9) * 0.5 + sin(ang * 5.0 - t * 1.3) * 0.3) * (0.012 + 0.03 * e);
  let rb = 1.0 + wob;
  let d = r - rb;
  let inside = smoothstep(0.012, -0.012, d);

  let h0 = params.hue / 360.0;
  let s0 = clamp(params.sat / 100.0, 0.0, 1.0);
  let c1 = hsl2rgb(h0, s0, 0.58);
  let c2 = hsl2rgb(h0 + 0.12, s0, 0.55);
  let c3 = hsl2rgb(h0 - 0.10, s0, 0.62);
  let c4 = hsl2rgb(h0 + 0.30, s0 * 0.9, 0.70);

  let q = p / rb;
  let z = sqrt(max(0.0, 1.0 - dot(q, q)));

  // swirling colour inside the glass
  let sa = t * (0.08 + spin * 0.25);
  let rq = vec2f(q.x * cos(sa) - q.y * sin(sa), q.x * sin(sa) + q.y * cos(sa));
  let w1 = fbm(rq * 1.6 + vec2f(t * 0.12, -t * 0.09));
  let w2 = fbm(rq * 2.4 - w1 * 1.4 + vec2f(-t * 0.1 * (1.0 + spin), t * 0.07) + 5.2);
  var bodyCol = mix(c1, c2, smoothstep(0.25, 0.75, w1));
  bodyCol = mix(bodyCol, c3, smoothstep(0.35, 0.8, w2) * 0.8);
  bodyCol = mix(bodyCol, c4, smoothstep(0.55, 0.95, w1 * w2 * 2.0 + q.x * 0.3 - q.y * 0.25) * 0.65);
  bodyCol = bodyCol * (0.4 + 0.75 * glow) * (0.62 + 0.45 * z);

  // glass: bright fresnel rim, soft specular highlights
  let fres = pow(1.0 - z, 2.5);
  bodyCol += mix(c3, vec3f(1.0), 0.5) * fres * (0.45 + 0.6 * e);
  let hl = q - vec2f(-0.38, 0.46);
  bodyCol += vec3f(1.0) * exp(-dot(hl, hl) * 9.0) * 0.5 * z;
  let hl2 = q - vec2f(0.46, -0.5);
  bodyCol += c4 * exp(-dot(hl2, hl2) * 14.0) * 0.2;

  // eyes
  let eo = params.eye.x;
  let es = params.eye.y;
  let sm = params.eye.z;
  let st = params.eye.w;
  let gz = vec2f(params.gaze.x, params.gaze.y);
  var eyeM = 0.0;
  var eyeG = 0.0;
  for (var i = 0; i < 2; i++) {
    let sx = select(-1.0, 1.0, i == 1);
    var ql = q - (vec2f(sx * 0.27, 0.04) + gz * vec2f(0.20, 0.15));
    ql.y += sm * 3.5 * ql.x * ql.x;
    let hw = mix(0.075, 0.12, sm) * es;
    let hh = max(mix(0.17, 0.035, sm) * es * eo, 0.014);
    let rr = min(hw, hh);
    let dd = sdRoundBox(ql, vec2f(hw - rr, hh - rr), rr);
    eyeM = max(eyeM, smoothstep(0.008, -0.008, dd));
    eyeG += exp(-max(dd, 0.0) * 14.0);
  }
  let facing = smoothstep(0.05, 0.4, z);
  let eyeCol = mix(mix(vec3f(1.0), hsl2rgb(h0, 0.8, 0.9), 0.25), vec3f(1.0, 0.45, 0.4), clamp(st, 0.0, 1.0) * 0.5);
  // body is 6.25% see-through so the back of the dotted shell shows faintly
  let bodyAlpha = 0.9375;
  var col = bodyCol * inside * bodyAlpha;
  col += eyeCol * eyeG * 0.22 * facing * inside;
  col = mix(col, eyeCol, eyeM * facing * inside);

  // outer halo
  col += c1 * exp(-max(d, 0.0) * (3.5 - 1.8 * e)) * (0.18 + 0.4 * e) * (1.0 - inside);
  col += c3 * band(d, 7.0) * (0.25 + 0.4 * e);

  let ro = vec3f(0.0, 0.0, -CAM);
  let rd = normalize(vec3f(p, CAM));

  // dotted shell: spins with activity, shrinks while reading, wobbles with energy.
  // Context fill sweeps around it in the pressure colour; kv fill tints it from the south pole up.
  let rot = rotZ(0.35) * rotY(t * (0.1 + spin * 0.3 + params.rate * 0.0007)) * rotX(0.25);
  let shellR = (1.5 - 0.22 * params.inward) * (1.0 + params.pulse * 0.1) * (1.0 + 0.03 * sin(t * 1.3));
  var ripple = 0.0;
  for (var i = 0; i < 4; i++) {
    let age = params.ages[i];
    ripple += band(r - (1.0 + age * 1.2), 9.0) * clamp(1.0 - age / 1.4, 0.0, 1.0) * params.strs[i];
  }
  let cl = clamp(params.ctx, 0.0, 1.0);
  let ccol = hsl2rgb(mix(170.0, 0.0, cl) / 360.0, 0.85, 0.62);
  for (var side = 0; side < 2; side++) {
    let sd = shellDots(ro, rd, rot, shellR, t, 0.03 + 0.12 * clamp(e, 0.0, 1.0), side == 0);
    let vis = select(0.5, 1.0, side == 0) * (1.0 - 0.9 * inside * bodyAlpha);
    var dcol = mix(c3, c4, sd.z) * 1.1;
    dcol = mix(dcol, ccol, step(sd.y, cl) * step(0.001, cl) * 0.8);
    dcol = mix(dcol, vec3f(0.5, 0.75, 1.0), step(sd.z, params.kv) * step(0.001, params.kv) * 0.35);
    col += dcol * sd.x * vis * (1.3 + 1.2 * e + ripple * 2.5) * (0.5 + glow) * 1.6;
  }

  let bg = vec3f(0.027, 0.031, 0.051);
  return vec4f(bg + col, 1.0);
}
