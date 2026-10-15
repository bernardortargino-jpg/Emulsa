// Render planning for the web app: line-by-line port of engine/reference/emulsa/host.py
// (same as RenderPlan.kt / RenderPlan.swift). Verified against the golden plans by
// web/tools/test-plan.mjs. Matrices are column-major (GL), uniforms are [type, value].

const M32 = 0xFFFFFFFF;
const GLOW_HEIGHT = 512;
const GRAIN_TEX_SIZE = 512;
const GRAIN_TEX_RADIUS = 1.25;
const FRAMES = { none: 0, instant: 1, sprocket: 2, slide: 3, super8: 4, letterbox: 5, rebate: 6 };
const STAMP_DIGITS = [63, 6, 91, 79, 102, 109, 125, 7, 127, 111];
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const GLYPHS = " 0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ:.-/'>*#";

export const SETTINGS_DEFAULTS = {
  exposure: 0, temperature: 0, tint: 0, contrast: 0, saturation: 0, vibrance: 0, fade: 0,
  highlights: 0, shadows: 0, mono: false, grain: 1, vignette: 1, halation: 1, bloom: 1,
  leak: 'auto', leakAmount: 1, dateStamp: null, date: '2026-10-15T10:30:00',
  flash: null, flashColor: [1, 1, 1], accessory: 'none', frame: true, seed: 1,
  crop: null, mirror: false, doubleMix: 0.5,
};

// ---- deterministic randomness (bit-identical to common.glsl) -------------------------------
const mul32 = (a, b) => Math.imul(a, b) >>> 0;
export function pcg(v) {
  const state = (mul32(v >>> 0, 747796405) + 2891336453) >>> 0;
  const word = mul32(((state >>> (((state >>> 28) + 4) & 31)) ^ state) >>> 0, 277803737);
  return ((word >>> 22) ^ word) >>> 0;
}
const m32 = (x) => {           // Python "& 0xFFFFFFFF" for possibly large / negative numbers
  x = Math.trunc(x) % 4294967296;
  return x < 0 ? x + 4294967296 : x;
};
const hash2u = (a, b) => pcg((a ^ pcg(b >>> 0)) >>> 0);
const u24 = (h) => (h >>> 8) * (1 / 16777216);
export const rand2 = (a, b) => u24(hash2u(m32(a), m32(b)));
export function vnoise1(t, seed) {
  const i = Math.floor(t), f = t - i, u = f * f * (3 - 2 * f);
  const a = rand2(seed, m32(i + 65536)), b = rand2(seed, m32(i + 65537));
  return a + (b - a) * u;
}

// Python round(): ties to even
function pyRound(x) {
  const r = Math.round(x);
  if (Math.abs(x % 1) === 0.5) return 2 * Math.round(x / 2);
  return r;
}
const lerp = (a, b, t) => a + (b - a) * t;

// ---- colour maths (colormath.py) --------------------------------------------------------------
const RGB2XYZ = [[0.4123907992659595, 0.3575843393838780, 0.1804807884018343],
  [0.2126390058715104, 0.7151686787677559, 0.0721923153607337],
  [0.0193308187155918, 0.1191947797946259, 0.9505321522496606]];
const BRADFORD = [[0.8951, 0.2664, -0.1614], [-0.7502, 1.7135, 0.0367], [0.0389, -0.0685, 1.0296]];
const LUMA = [0.2126, 0.7152, 0.0722];
const D65 = [0.31270, 0.32900];
const REF_CCT = 6504.0;
function mm(a, b) {
  const o = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) { let s = 0; for (let k = 0; k < 3; k++) s += a[r][k] * b[k][c]; o[r][c] = s; }
  return o;
}
const mv = (a, v) => [0, 1, 2].map((r) => a[r][0] * v[0] + a[r][1] * v[1] + a[r][2] * v[2]);
function inv3(m) {
  const [[a, b, c], [d, e, f], [g, h, i]] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g, det = a * A + b * B + c * C;
  return [[A / det, -(b * i - c * h) / det, (b * f - c * e) / det],
    [B / det, (a * i - c * g) / det, -(a * f - c * d) / det],
    [C / det, -(a * h - b * g) / det, (a * e - b * d) / det]];
}
const XYZ2RGB = inv3(RGB2XYZ), BRADFORD_INV = inv3(BRADFORD);
const xyToXyz = (x, y) => [x / y, 1, (1 - x - y) / y];
function planckXy(t0) {
  const t = Math.min(Math.max(t0, 1667), 25000);
  const t1 = 1e3 / t, t2 = 1e6 / (t * t), t3 = 1e9 / (t * t * t);
  const x = t <= 4000 ? -0.2661239 * t3 - 0.2343589 * t2 + 0.8776956 * t1 + 0.179910
    : -3.0258469 * t3 + 2.1070379 * t2 + 0.2226347 * t1 + 0.240390;
  let y;
  if (t <= 2222) y = -1.1063814 * x ** 3 - 1.34811020 * x * x + 2.18555832 * x - 0.20219683;
  else if (t <= 4000) y = -0.9549476 * x ** 3 - 1.37418593 * x * x + 2.09137015 * x - 0.16748867;
  else y = 3.0817580 * x ** 3 - 5.87338670 * x * x + 3.75112997 * x - 0.37001483;
  return [x, y];
}
const xyToUv = (x, y) => { const d = -2 * x + 12 * y + 3; return [4 * x / d, 6 * y / d]; };
const uvToXy = (u, v) => { const d = 2 * u - 8 * v + 4; return [3 * u / d, 2 * v / d]; };
function illuminantXy(temp, tint) {
  const mired = Math.max(1e6 / REF_CCT + temp * 75, 40);
  const t = 1e6 / mired;
  const p = planckXy(t), uv = xyToUv(p[0], p[1]);
  const a = planckXy(t * 1.01), b = planckXy(t / 1.01);
  const ua = xyToUv(a[0], a[1]), ub = xyToUv(b[0], b[1]);
  const tu = ua[0] - ub[0], tv = ua[1] - ub[1];
  let n = Math.hypot(tu, tv); if (n === 0) n = 1;
  let nu = -tv / n, nv = tu / n;
  if (nv > 0) { nu = -nu; nv = -nv; }
  const xy = uvToXy(uv[0] + nu * 0.015 * tint, uv[1] + nv * 0.015 * tint);
  const ref = planckXy(REF_CCT);
  return [xy[0] + (D65[0] - ref[0]), xy[1] + (D65[1] - ref[1])];
}
export function wbMatrix(temp, tint) {
  const xy = illuminantXy(temp, tint);
  const src = mv(BRADFORD, xyToXyz(D65[0], D65[1])), dst = mv(BRADFORD, xyToXyz(xy[0], xy[1]));
  const diag = [[dst[0] / src[0], 0, 0], [0, dst[1] / src[1], 0], [0, 0, dst[2] / src[2]]];
  let m = mm(XYZ2RGB, mm(BRADFORD_INV, mm(diag, mm(BRADFORD, RGB2XYZ))));
  const w = mv(m, [1, 1, 1]);
  const k = 1 / (LUMA[0] * w[0] + LUMA[1] * w[1] + LUMA[2] * w[2]);
  return m.map((row) => row.map((v) => v * k));
}
const colMajor = (m) => [0, 1, 2].flatMap((c) => [0, 1, 2].map((r) => m[r][c]));

// ---- text overlays ------------------------------------------------------------------------------
const p2 = (v) => String(v).padStart(2, '0');
export function parseDate(s) {
  const p = s.split(/[-T:.]/).map((x) => parseInt(x, 10) || 0);
  return { y: p[0], mo: Math.max(1, p[1] || 1), d: Math.max(1, p[2] || 1), h: p[3] || 0, mi: p[4] || 0, s: p[5] || 0 };
}
function addSeconds(d, secs) {
  const t = new Date(Date.UTC(d.y, d.mo - 1, d.d, d.h, d.mi, d.s) + Math.floor(secs * 1000));
  return { y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate(), h: t.getUTCHours(), mi: t.getUTCMinutes(), s: t.getUTCSeconds() };
}
function formatStamp(fmt, d) {
  let o = fmt.replace('yyyy', String(d.y).padStart(4, '0')).replace('yy', p2(d.y % 100));
  o = o.replace('MM', p2(d.mo)).replace('dd', p2(d.d));
  o = o.replace('M', String(d.mo)).replace('d', String(d.d));
  o = o.replace('HH', p2(d.h)).replace('mm', p2(d.mi));
  return o;
}
export function stampSegments(text) {
  const masks = []; let pending = 0;
  for (const ch of text) {
    if (ch === "'") { pending = 128; continue; }
    let m = 0;
    if (ch >= '0' && ch <= '9') m = STAMP_DIGITS[ch.charCodeAt(0) - 48];
    else if (ch === '-') m = 64;
    masks.push(m | pending); pending = 0;
  }
  return masks.slice(0, 16);
}
const glyphIndex = (ch) => { if (ch === '\n') return -1; const i = GLYPHS.indexOf(ch.toUpperCase()); return i >= 0 ? i : 0; };
function osdText(kind, d, rows) {
  let top, bottom;
  if (kind === 'vhs') {
    const h12 = d.h % 12 || 12, ampm = d.h < 12 ? 'AM' : 'PM';
    top = ['PLAY >']; bottom = [`${ampm} ${h12}:${p2(d.mi)}`, `${MONTHS[d.mo - 1]}. ${d.d} ${d.y}`];
  } else if (kind === 'dv') {
    top = []; bottom = [`${p2(d.d)}.${p2(d.mo)}.${d.y}`, `${p2(d.h)}:${p2(d.mi)}:${p2(d.s)}`];
  } else return '';
  const gap = Math.max(rows - top.length - bottom.length, 0);
  return [...top, ...Array(gap).fill(''), ...bottom].join('\n');
}

// ---- geometry -------------------------------------------------------------------------------------
function photoGeometry(profile, s, srcW, srcH, ctx) {
  const fmt = profile.format;
  let cx, cy, cw, ch, aspect;
  if (s.crop) {
    [cx, cy, cw, ch] = s.crop;
    aspect = (cw * srcW) / (ch * srcH);
  } else {
    let a = fmt.aspect[0] / fmt.aspect[1];
    if (s.accessory === 'fisheye') a = 1;
    const srcAspect = srcW / srcH;
    if (a !== 1 && ((srcAspect < 1) !== (a < 1))) a = 1 / a;
    aspect = a;
    if (srcAspect > aspect) { cw = aspect / srcAspect; ch = 1; } else { cw = 1; ch = srcAspect / aspect; }
    cx = (1 - cw) / 2; cy = (1 - ch) / 2;
  }
  const cropLong = Math.max(cw * srcW, ch * srcH);
  let long;
  if ((ctx.purpose || 'export') === 'preview') long = ctx.previewLong ?? 1440;
  else {
    long = Math.min(cropLong, fmt.maxLongSide, ctx.maxLong ?? 1e9);
    const mp = fmt.sensorMegapixels || 0;
    if (mp > 0) long = Math.min(long, Math.sqrt(mp * 1e6 * Math.max(aspect, 1 / aspect)));
  }
  let pw, ph;
  if (aspect >= 1) { pw = Math.max(1, pyRound(long)); ph = Math.max(1, pyRound(long / aspect)); }
  else { ph = Math.max(1, pyRound(long)); pw = Math.max(1, pyRound(long * aspect)); }
  return [pw, ph, [cx, cy, cw, ch]];
}

function canvasGeometry(profile, s, pw, ph) {
  const fmt = profile.format;
  const frame = s.frame ? fmt.frame : 'none';
  if (frame === 'none') return [pw, ph, [0, 0, 1, 1], 'none'];
  let [l, t, r, b] = fmt.border;
  const a = fmt.aspect[0] / fmt.aspect[1];
  const flipped = a !== 1 && ((a > 1) !== (pw / ph > 1));
  let unit;
  if (flipped) { unit = pw; [l, t, r, b] = [t, r, b, l]; } else unit = ph;
  const cw = pyRound(pw + (l + r) * unit), chh = pyRound(ph + (t + b) * unit);
  return [cw, chh, [(l * unit) / cw, (t * unit) / chh, pw / cw, ph / chh], frame];
}

export function srcMatrix(c, mirror = false) {
  const [cx, cy, cw, ch] = c;
  return mirror ? [-cw, 0, 0, 0, ch, 0, cx + cw, cy, 1] : [cw, 0, 0, 0, ch, 0, cx, cy, 1];
}

function lightLeaks(profile, s, seed, time, video) {
  const lk = profile.leaks;
  if (s.leak === 'off') return [];
  const segment = video ? Math.floor(time / 3) : 0;
  const base = m32(seed * 7919 + segment * 104729);
  if (s.leak === 'auto' && rand2(base, 1) >= lk.chance) return [];
  const [n0, n1] = lk.count;
  let count = n0 + Math.trunc(rand2(base, 2) * (n1 - n0 + 1));
  count = Math.max(0, Math.min(count, 4));
  let envelope = 1;
  if (video) {
    const ph = time / 3 - segment;
    envelope = Math.sin(Math.PI * ph) ** 2 * (0.6 + 0.8 * vnoise1(time * 1.5, base));
  }
  const out = [];
  for (let i = 0; i < count; i++) {
    const k = 10 + i * 10;
    const edge = Math.trunc(rand2(base, k) * 4);
    const along = 0.1 + 0.8 * rand2(base, k + 1);
    const depth = -0.08 + 0.16 * rand2(base, k + 2);
    let cx, cy, ang;
    if (edge === 0) [cx, cy, ang] = [depth, along, Math.PI / 2];
    else if (edge === 1) [cx, cy, ang] = [1 - depth, along, Math.PI / 2];
    else if (edge === 2) [cx, cy, ang] = [along, depth, 0];
    else [cx, cy, ang] = [along, 1 - depth, 0];
    const major = lerp(lk.size[0], lk.size[1], rand2(base, k + 3));
    const minor = major * (0.3 + 0.35 * rand2(base, k + 4));
    const pal = lk.palette;
    const col = pal[Math.trunc(rand2(base, k + 5) * pal.length) % pal.length];
    const stops = lerp(lk.intensity[0], lk.intensity[1], rand2(base, k + 6));
    const e = 0.18 * 2 ** stops * s.leakAmount * envelope;
    if (video) cy += 0.05 * Math.sin(time * 0.7 + i);
    out.push([[cx, cy, major, minor], [col[0] * e, col[1] * e, col[2] * e, ang]]);
  }
  return out;
}

// ---- the plan ---------------------------------------------------------------------------------------
export function buildPlan(profile, settings, ctx, lut = { lo: -9, hi: 7, n: 33, m: 1024 }) {
  const s = { ...SETTINGS_DEFAULTS, ...(settings || {}) };
  if (profile.format.forceAccessory) s.accessory = profile.format.forceAccessory;
  const video = !!ctx.video;
  const frameIdx = Math.trunc(ctx.frame || 0);
  const time = +(ctx.time || 0);
  const seed = m32(s.seed);
  const srcW = ctx.srcW, srcH = ctx.srcH;

  let [pw, ph, crop] = photoGeometry(profile, s, srcW, srcH, ctx);
  if (ctx.purpose === 'preview') {
    const [cw0, ch0] = canvasGeometry(profile, s, pw, ph);
    const k = (ctx.previewLong ?? 1440) / Math.max(cw0, ch0);
    pw = Math.max(1, pyRound(pw * k)); ph = Math.max(1, pyRound(ph * k));
  }
  const [cw, chh, rect, frame] = canvasGeometry(profile, s, pw, ph);
  const aspect = pw / ph;
  const opt = profile.optics, vid = profile.video;

  let weave = [0, 0], flickerEv = 0;
  if (video && (vid.weave > 0 || vid.flicker > 0 || vid.drift > 0)) {
    const wv = vid.weave;
    weave = [
      ((vnoise1(time * 2.0, seed + 1) - 0.5) * 1.2 + (rand2(seed + 2, frameIdx) - 0.5) * 0.4) * wv / aspect,
      ((vnoise1(time * 2.3, seed + 3) - 0.5) * 2.0 + (rand2(seed + 4, frameIdx) - 0.5) * 0.6) * wv,
    ];
    flickerEv = ((vnoise1(time * 9.0, seed + 5) - 0.5) * 2.0 + (rand2(seed + 6, frameIdx) - 0.5)) * vid.flicker;
    flickerEv += (vnoise1(time * 0.25, seed + 7) - 0.5) * 2.0 * vid.drift;
  }
  const gain = 2 ** (s.exposure + flickerEv);
  const wb = profile.capabilities.temperature ? wbMatrix(s.temperature, s.tint) : [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const pre = mm(profile.color.inputMatrix, wb.map((row) => row.map((v) => v * gain)));

  const k1 = opt.distortion.k1, k2 = opt.distortion.k2;
  const scale = (k1 + k2) > 0 ? 1 / (1 + k1 + k2) : 1;
  const fisheye = s.accessory === 'fisheye';
  const lens = [k1, k2, scale, opt.ca + (fisheye ? 0.004 : 0)];
  const fish = fisheye ? [1, 62 * Math.PI / 180, 1, 0.012] : [0, 1, 1, 0.01];
  let prism = [0, 0, 0, 0], prismMask = [1, 0, 0];
  if (s.accessory === 'prism') {
    const a = rand2(seed, 301) * 2 * Math.PI;
    prism = [0.18 * Math.cos(a) / aspect, 0.18 * Math.sin(a), 0.55, 0.06];
    prismMask = [Math.cos(a + Math.PI), Math.sin(a + Math.PI), 0.12];
  }
  const has2 = !!ctx.src2;
  const [w1, w2] = has2 ? [1.3 * (1 - s.doubleMix), 1.3 * s.doubleMix] : [1, 0];
  let src2Crop = crop;
  if (has2) {
    const a2 = (ctx.src2W ?? srcW) / (ctx.src2H ?? srcH);
    let c2w, c2h;
    if (a2 > aspect) { c2w = aspect / a2; c2h = 1; } else { c2w = 1; c2h = a2 / aspect; }
    src2Crop = [(1 - c2w) / 2, (1 - c2h) / 2, c2w, c2h];
  }
  const rk = opt.recover.knee, rs = opt.recover.strength;
  const recMax = rs > 0 ? rk + (1 - rk) / (1 - rs) : 1;
  const source = [recMax * w1, opt.sourceBoost ?? 4];

  const passes = [];
  passes.push({
    name: 'optics', program: 'optics', w: pw, h: ph, format: 'rgba16f',
    textures: { uSrc: 'src', uSrc2: has2 ? 'src2' : 'src' },
    uniforms: {
      uSrcMatrix: ['mat3', srcMatrix(crop, s.mirror)], uSrc2Matrix: ['mat3', srcMatrix(src2Crop)],
      uDoubleWeights: ['2f', [w1, w2]], uAspect: ['1f', aspect], uLens: ['4f', lens], uFisheye: ['4f', fish],
      uWeave: ['2f', weave], uRecover: ['2f', [rk, rs]], uPrism: ['4f', prism], uPrismMask: ['3f', prismMask],
    },
  });

  const G = GLOW_HEIGHT;
  const gw = Math.max(1, Math.min(2048, pyRound(G * aspect)));
  const sizes = [[gw, G]];
  for (let i = 0; i < 4; i++) { const [w, h] = sizes[sizes.length - 1]; sizes.push([Math.max(1, w >> 1), Math.max(1, h >> 1)]); }
  const hal = opt.halation;
  const thr = hal.threshold / gain;
  const foot = [pw / gw, ph / G];
  const taps = Math.max(1, Math.min(8, Math.ceil(Math.max(...foot) / 2)));
  passes.push({
    name: 'L0', program: 'down', w: sizes[0][0], h: sizes[0][1], format: 'rgba16f', textures: { uTex: 'optics' },
    uniforms: { uTexel: ['2f', [1 / pw, 1 / ph]], uMode: ['1i', 1], uTaps: ['1i', taps], uFootprint: ['2f', foot], uThreshold: ['1f', thr], uSource: ['2f', source] },
  });
  for (let i = 1; i < 5; i++) {
    const [sw, sh] = sizes[i - 1];
    passes.push({
      name: `L${i}`, program: 'down', w: sizes[i][0], h: sizes[i][1], format: 'rgba16f', textures: { uTex: `L${i - 1}` },
      uniforms: { uTexel: ['2f', [1 / sw, 1 / sh]], uMode: ['1i', 0], uTaps: ['1i', 1], uFootprint: ['2f', [2, 2]], uThreshold: ['1f', thr] },
    });
  }
  let low = 'L4';
  for (const i of [3, 2, 1, 0]) {
    const [lw, lh] = sizes[i + 1];
    passes.push({
      name: `U${i}`, program: 'up', w: sizes[i][0], h: sizes[i][1], format: 'rgba16f', textures: { uLow: low, uCur: `L${i}` },
      uniforms: { uLowTexel: ['2f', [1 / lw, 1 / lh]], uSpread: ['1f', opt.glowSpread] },
    });
    low = `U${i}`;
  }
  const smear = opt.smear;
  if (smear > 0) passes.push({ name: 'smear', program: 'smear', w: sizes[2][0], h: 1, format: 'rgba16f', textures: { uTex: 'L2' }, uniforms: { uRows: ['1i', sizes[2][1]] } });

  const g = profile.grain;
  const gamt = g.model !== 'none' ? g.amount * s.grain : 0;
  const texPerH = GRAIN_TEX_RADIUS / Math.max(g.size, 1e-6);
  const lod = Math.log2(Math.max(texPerH / ph, 1e-6));
  const gseed = m32(seed * 31 + (video ? frameIdx : 0) * 977);
  const grainOff = [rand2(gseed, 11), rand2(gseed, 12), rand2(gseed, 13), rand2(gseed, 14)];
  const leaks = lightLeaks(profile, s, seed, time, video);
  const leakGeo = Array(16).fill(0), leakCol = Array(16).fill(0);
  leaks.forEach(([geo, col], i) => { for (let j = 0; j < 4; j++) { leakGeo[i * 4 + j] = geo[j]; leakCol[i * 4 + j] = col[j]; } });

  let stampOn = s.dateStamp != null ? s.dateStamp : profile.stamp.defaultOn;
  stampOn = stampOn && profile.capabilities.dateStamp;
  let segs = [], stampRect = [0, 0, 0, 0], stampCol = [0, 0, 0];
  if (stampOn) {
    const st = profile.stamp;
    segs = stampSegments(formatStamp(st.format, parseDate(s.date)));
    const h = st.size, w = h * 0.62 / aspect;
    stampRect = [1 - st.margin[0] / aspect - segs.length * w, 1 - st.margin[1] - h, w, h];
    const e = 0.18 * 2 ** st.intensity;
    stampCol = st.color.map((c) => c * e);
  }
  const segArr = [...segs, ...Array(16).fill(0)].slice(0, 16);

  const fl = profile.flash;
  const flashOn = (s.flash == null ? fl.default : s.flash) && profile.capabilities.flash;
  const fcol = fl.color.map((c, i) => c * s.flashColor[i]);
  const starOn = s.accessory === 'starburst';
  if (starOn) passes.push({
    name: 'star', program: 'star', w: sizes[1][0], h: sizes[1][1], format: 'rgba16f', textures: { uTex: 'L1' },
    uniforms: { uAspect: ['1f', aspect], uStar: ['4f', [0, 6, 0.2, rand2(seed, 401) * Math.PI]] },
  });
  const vg = opt.vignette, sharp = profile.finish.sharpen;
  passes.push({
    name: 'develop', program: 'develop', w: pw, h: ph, format: 'rgba8',
    textures: { uOptics: 'optics', uGlow: 'U0', uSoft: 'L1', uLut: 'lut', uSigma: 'sigma', uGrainTex: 'grain',
      uSmearTex: smear > 0 ? 'smear' : 'L4', uStarTex: starOn ? 'star' : 'L4' },
    uniforms: {
      uGlowSize: ['2f', sizes[0]], uSoftSize: ['2f', sizes[1]], uLutParams: ['3f', [lut.lo, lut.hi, lut.n]],
      uSigmaSize: ['1f', lut.m], uAspect: ['1f', aspect], uPre: ['mat3', colMajor(pre)],
      uBloom: ['1f', opt.bloom * s.bloom], uHalation: ['3f', hal.color.map((c) => c * hal.amount * s.halation)],
      uSoftness: ['4f', [opt.softness.center, opt.softness.edge, opt.softness.start, opt.softness.end]],
      uVignette: ['4f', [vg.amount * s.vignette, vg.radius, vg.mechanical * s.vignette, vg.mechanicalRadius]],
      uVigCenter: ['2f', vg.center], uFlash: ['4f', [flashOn ? 1 : 0, fl.gain, fl.ambient, fl.radius]], uFlashColor: ['3f', fcol],
      uStar: ['1f', starOn ? 1.2 : 0], uStarSize: ['2f', sizes[1]], uSource: ['2f', source], uSmear: ['1f', smear],
      uLeakCount: ['1i', leaks.length], uLeakGeo: ['4fv', leakGeo], uLeakCol: ['4fv', leakCol],
      uLeakSeed: ['1ui', m32(seed * 13 + 5)], uStampCount: ['1i', segs.length], uStampSeg: ['1iv', segArr],
      uStampRect: ['4f', stampRect], uStampColor: ['3f', stampCol],
      uGrainA: ['4f', [gamt, g.chroma, lod, gamt > 0 ? 1 : 0]],
      uGrainScale: ['4f', [texPerH * aspect / GRAIN_TEX_SIZE, texPerH / GRAIN_TEX_SIZE, 0, 0]], uGrainOffset: ['4f', grainOff],
      uAdjust: ['4f', [s.contrast, s.saturation, s.fade, s.vibrance]],
      uAdjust2: ['4f', [s.highlights, s.shadows, s.mono ? 1 : 0, profile.finish.dither]],
      uDitherSeed: ['1ui', m32(seed * 17 + 3)],
    },
  });

  const fin = profile.finish;
  const vhs = (video || ctx.forceVideoLook) ? vid.vhs : null;
  let vhsA = [0, 0, 0, 1], vhsB = [0, 0.5, 0.05, 0], vhsC = [0, 0, 0, 0];
  if (vhs) {
    const bandY = (time * 0.045 + rand2(seed, 501)) % 1;
    const bandS = vhs.band * (0.4 + 0.6 * vnoise1(time * 0.4, seed + 9));
    vhsA = [1, vhs.chroma, vhs.luma, vhs.saturation];
    vhsB = [vhs.jitter, bandY, vhs.bandHeight, bandS];
    vhsC = [vhs.headSwitch, vhs.headShift, vhs.noise, vhs.ringing];
  }
  const dust = fin.dust, scr = fin.scratches;
  let osd = [], osdRect = [0, 0, 0, 0];
  if (vid.osd && (video || ctx.forceVideoLook)) {
    const d = addSeconds(parseDate(s.date), time);
    const gh = 0.045, margin = 0.06;
    const rows = Math.trunc((1 - 2 * margin) / (gh * 1.25)) + 1;
    osd = [...osdText(vid.osd, d, rows)].map(glyphIndex).slice(0, 48);
    osdRect = [margin * chh / cw, margin, gh * 0.75 * chh / cw, gh];
  }
  const f = profile.format;
  passes.push({
    name: 'finish', program: 'finish', w: cw, h: chh, format: 'rgba8', textures: { uImage: 'develop', uFont: 'font' },
    uniforms: {
      uImageSize: ['2f', [pw, ph]], uCanvasSize: ['2f', [cw, chh]], uPhotoRect: ['4f', rect],
      uFlipY: ['1i', ctx.flipY ? 1 : 0], uEncode: ['1i', ctx.encode === 0 ? 0 : 1], uFrameType: ['1i', FRAMES[frame]],
      uFrameColor: ['4f', [...f.frameColor, 1]], uFrameParams: ['4f', [f.cornerRadius, f.frameTexture, f.frameShadow, 0]],
      uSharpen: ['4f', [sharp.amount, sharp.radius, 0, 0]], uVhsA: ['4f', vhsA], uVhsB: ['4f', vhsB], uVhsC: ['4f', vhsC],
      uDust: ['4f', [dust.count, dust.size, fin.dustPolarity, dust.opacity]],
      uScratch: ['4f', [scr.count, scr.opacity, scr.width, scr.drift]],
      uSeed: ['1ui', m32(seed * 101 + 7)], uFrame: ['1ui', video ? m32(frameIdx) : 0], uTime: ['1f', time],
      uOsdCount: ['1i', osd.length], uOsd: ['1iv', [...osd, ...Array(48).fill(0)].slice(0, 48)],
      uOsdRect: ['4f', osdRect], uOsdColor: ['4f', [0.92, 0.92, 0.92, 1]], uDither: ['1f', fin.dither],
    },
  });
  return { photo: [pw, ph], canvas: [cw, chh], photoRect: rect, passes, output: 'finish' };
}
