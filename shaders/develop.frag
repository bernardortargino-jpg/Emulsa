// Pass 3 - "develop": everything that happens to LIGHT before and inside the emulsion.
//   scene-linear E -> clipped-source boost -> lens softness / bloom (diffusion) -> halation
//   (red glow from base reflection) -> starburst filter -> CCD smear -> exposure * white balance (uPre)
//   -> flash falloff -> optical vignette -> light leaks + LED date imprint (extra light)
//   -> grain injected in log2 exposure, sigma(E) from the profile's characteristic curve
//   -> per-channel shaper -> 3D LUT (film / sensor response, baked offline) -> user adjustments (display domain)
precision highp float;
precision highp int;
precision highp sampler3D;

#include "common.glsl"

uniform sampler2D uOptics;
uniform sampler2D uGlow;       // up-chain result: rgb = blurred light, a = highlight energy
uniform vec2 uGlowSize;
uniform sampler2D uSoft;       // first pyramid level (medium blur, sharper highlights)
uniform vec2 uSoftSize;
uniform sampler3D uLut;
uniform vec3 uLutParams;       // lo, hi (stops vs 18% grey), N
uniform sampler2D uSigma;      // M x 1: rgb = grain sigma (stops), a = 3D LUT input shaper
uniform float uSigmaSize;
uniform sampler2D uGrainTex;   // tileable, mipmapped, 8-bit standardized noise
uniform sampler2D uSmearTex;   // 1 row, a = column highlight energy
uniform sampler2D uStarTex;    // starburst streaks (low resolution), rgb
uniform vec2 uStarSize;
uniform vec2 uSource;          // clipped-source level, extra gain (see down.frag)

uniform float uAspect;
uniform mat3 uPre;             // exposure * white balance * flicker
uniform float uBloom;
uniform vec3 uHalation;        // color * amount
uniform vec4 uSoftness;        // center amount, edge amount, start radius, end radius
uniform vec4 uVignette;        // amount, radius, mechanical amount, mechanical radius
uniform vec2 uVigCenter;
uniform vec4 uFlash;           // enabled, gain, ambient, radius
uniform vec3 uFlashColor;
uniform float uStar;           // starburst amount (0 = off)
uniform float uSmear;
uniform int uLeakCount;
uniform vec4 uLeakGeo[4];      // center (photo uv), radius major, radius minor (height units)
uniform vec4 uLeakCol[4];      // rgb light (scene-linear), rotation angle
uniform uint uLeakSeed;
uniform int uStampCount;
uniform int uStampSeg[16];     // bits 0-6 = segments a..g, bit 7 = apostrophe
uniform vec4 uStampRect;       // x, y (top-left of first cell, photo uv), cell w, cell h (photo uv)
uniform vec3 uStampColor;      // linear light of the LEDs
uniform vec4 uGrainA;          // amount, chroma, lod, enabled
uniform vec4 uGrainScale;      // texture repeats per photo uv (x, y)
uniform vec4 uGrainOffset;     // layer 1 offset, layer 2 offset (texture uv)
uniform vec4 uAdjust;          // contrast, saturation, fade, vibrance   (all 0 = neutral)
uniform vec4 uAdjust2;         // highlights, shadows, mono (0/1), dither amount (LSB)
uniform uint uDitherSeed;

in vec2 vUv;
out vec4 fragColor;

// ---- light additions -------------------------------------------------------------------

vec3 lightLeaks(vec2 uv) {
    vec3 acc = vec3(0.0);
    for (int i = 0; i < 4; i++) {
        if (i >= uLeakCount) break;
        vec4 g = uLeakGeo[i];
        vec4 c = uLeakCol[i];
        vec2 d = (uv - g.xy) * vec2(uAspect, 1.0);
        float ca = cos(c.w), sa = sin(c.w);
        vec2 e = vec2(ca * d.x + sa * d.y, -sa * d.x + ca * d.y) / g.zw;
        float q = dot(e, e);
        float n = vnoise(e * 1.7 + vec2(float(i) * 7.31, 3.7), uLeakSeed);
        acc += c.rgb * exp(-q) * (0.55 + 0.9 * n);
    }
    return acc;
}

float segDist(vec2 p, vec2 a, vec2 b) {
    vec2 pa = p - a, ba = b - a;
    float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
    return length(pa - ba * h);
}

// Seven-segment LED digits, like the date backs of 80s/90s compacts. The imprint is light
// added to the exposure, so it is rendered by the film curve and blooms like a real LED.
vec3 dateStamp(vec2 uv) {
    if (uStampCount == 0) return vec3(0.0);
    vec2 local = (uv - uStampRect.xy) / uStampRect.zw;
    if (local.y < -0.3 || local.y > 1.3 || local.x < -0.3 || local.x > float(uStampCount) + 0.3) return vec3(0.0);
    int ci = int(floor(local.x));
    float best = 1e3;
    // check this cell and its neighbours (glow crosses cell borders)
    for (int k = -1; k <= 1; k++) {
        int idx = ci + k;
        if (idx < 0 || idx >= uStampCount) continue;
        int m = uStampSeg[idx];
        if (m == 0) continue;
        vec2 c = vec2(local.x - float(idx), local.y);
        // italic slant, cell aspect -> physical units (height = 1)
        float cellAspect = (uStampRect.z * uAspect) / uStampRect.w;
        vec2 q = vec2((c.x - 0.5) * cellAspect + (c.y - 0.5) * 0.12, c.y - 0.5);
        float w = 0.24, h = 0.38;
        vec2 A = vec2(-w, -h), B = vec2(w, -h), C = vec2(-w, 0.0), D = vec2(w, 0.0), E = vec2(-w, h), F = vec2(w, h);
        float g = 0.035;
        if ((m & 1) != 0) best = min(best, segDist(q, A + vec2(g, 0.0), B - vec2(g, 0.0)));
        if ((m & 2) != 0) best = min(best, segDist(q, B + vec2(0.0, g), D - vec2(0.0, g)));
        if ((m & 4) != 0) best = min(best, segDist(q, D + vec2(0.0, g), F - vec2(0.0, g)));
        if ((m & 8) != 0) best = min(best, segDist(q, E + vec2(g, 0.0), F - vec2(g, 0.0)));
        if ((m & 16) != 0) best = min(best, segDist(q, C + vec2(0.0, g), E - vec2(0.0, g)));
        if ((m & 32) != 0) best = min(best, segDist(q, A + vec2(0.0, g), C - vec2(0.0, g)));
        if ((m & 64) != 0) best = min(best, segDist(q, C + vec2(g, 0.0), D - vec2(g, 0.0)));
        if ((m & 128) != 0) best = min(best, segDist(q, vec2(-w - 0.2, -h), vec2(-w - 0.24, -h + 0.16)));
    }
    float core = 1.0 - smoothstep(0.035, 0.075, best);
    float halo = exp(-best * best / 0.02);
    return uStampColor * (core + 0.25 * halo);
}

// ---- grain -----------------------------------------------------------------------------

vec3 grainNoise(vec2 uv) {
    vec2 q = uv * uGrainScale.xy;
    vec3 a = textureLod(uGrainTex, q + uGrainOffset.xy, uGrainA.z).rgb;
    vec2 q2 = mat2(0.7986355, -0.6018150, 0.6018150, 0.7986355) * (q * 1.13) + uGrainOffset.zw;
    vec3 b = textureLod(uGrainTex, q2, uGrainA.z + 0.1763).rgb;
    vec3 n = ((a + b) * 255.0 - 256.0) * (0.70710678 / 32.0);
    float k = uGrainA.y;
    float m = (n.r + n.g + n.b) * 0.57735027;            // unit-variance shared component
    float norm = inversesqrt(max((1.0 - k) * (1.0 - k) + k * k + 2.0 * k * (1.0 - k) * 0.57735027, 1e-4));
    return ((1.0 - k) * vec3(m) + k * n) * norm;
}

float sigmaCoord(float x) { return x * ((uSigmaSize - 1.0) / uSigmaSize) + 0.5 / uSigmaSize; }

// ---- user adjustments (display-linear in, display-linear out) ---------------------------

vec3 sCurve(vec3 e, float k) {
    const float pv = 0.45;
    vec3 lo = pv * pow(max(e / pv, vec3(0.0)), vec3(k));
    vec3 hi = 1.0 - (1.0 - pv) * pow(max((1.0 - e) / (1.0 - pv), vec3(0.0)), vec3(k));
    return mix(hi, lo, vec3(lessThan(e, vec3(pv))));
}

vec3 adjust(vec3 c) {
    float hl = uAdjust2.x, sh = uAdjust2.y;
    if (hl != 0.0 || sh != 0.0) {
        float Y = max(luma(c), 1e-6);
        float v = linearToSrgb1(min(Y, 1.0));
        float v2 = v + 0.5 * sh * v * (1.0 - v) * (1.0 - v) + 0.5 * hl * v * v * (1.0 - v);
        c *= srgbToLinear1(clamp(v2, 0.0, 1.0)) / Y;
    }
    if (uAdjust.x != 0.0) {
        float k = 1.0 + 0.5 * uAdjust.x;
        c = srgbToLinear(clamp(sCurve(clamp(linearToSrgb(c), 0.0, 1.0), k), 0.0, 1.0));
    }
    float Y = luma(c);
    if (uAdjust.w != 0.0) {
        float sat = (max(max(c.r, c.g), c.b) - min(min(c.r, c.g), c.b)) / max(max(max(c.r, c.g), c.b), 1e-5);
        c = mix(vec3(Y), c, 1.0 + uAdjust.w * (1.0 - sat));
    }
    c = mix(vec3(Y), c, 1.0 + uAdjust.y);
    if (uAdjust2.z > 0.5) c = vec3(luma(c));
    float f = uAdjust.z;
    c = 0.06 * f + c * (1.0 - 0.06 * f - 0.08 * f);
    return max(c, vec3(0.0));
}

void main() {
    vec2 uv = vUv;
    vec2 p = (uv - 0.5) * vec2(uAspect, 1.0);
    float hd = 0.5 * sqrt(uAspect * uAspect + 1.0);
    float r = length(p) / hd;

    vec3 E = texture(uOptics, uv).rgb;
    float m = max(max(E.r, E.g), E.b);
    E *= 1.0 + smoothstep(uSource.x * 0.97, uSource.x, m) * uSource.y;
    if (uSoftness.x + uSoftness.y > 0.0) {
        vec3 s = textureBSpline(uSoft, uSoftSize, uv).rgb;
        float w = mix(uSoftness.x, uSoftness.y, smoothstep(uSoftness.z, uSoftness.w, r));
        E = mix(E, s, clamp(w, 0.0, 1.0));
    }
    vec4 g = textureBSpline(uGlow, uGlowSize, uv);
    E = mix(E, g.rgb, uBloom);
    E += g.a * uHalation;
    if (uStar > 0.0) E += uStar * textureBSpline(uStarTex, uStarSize, uv).rgb;
    if (uSmear > 0.0) E += uSmear * texture(uSmearTex, vec2(uv.x, 0.5)).a * vec3(1.0, 0.92, 1.0);

    E = uPre * E;
    if (uFlash.x > 0.5) {
        float f = exp(-(r * r) / (uFlash.w * uFlash.w));
        E = E * (uFlash.z + uFlash.y * f * uFlashColor);
    }
    vec2 pv = p - uVigCenter;
    float rv = length(pv) / hd;
    float nat = 1.0 / pow(1.0 + (rv / uVignette.y) * (rv / uVignette.y), 2.0);
    float mech = 1.0 - smoothstep(uVignette.w * 0.7, uVignette.w, rv);
    E *= mix(1.0, nat, uVignette.x) * mix(1.0, mech, uVignette.z);
    E += lightLeaks(uv) + dateStamp(uv);
    E = max(E, vec3(0.0));

    float lo = uLutParams.x, hi = uLutParams.y, N = uLutParams.z;
    vec3 l = log2(max(E, vec3(1e-7)) / GREY);
    if (uGrainA.w > 0.5) {
        vec3 x = clamp((l - lo) / (hi - lo), 0.0, 1.0);
        vec3 sig = vec3(texture(uSigma, vec2(sigmaCoord(x.r), 0.5)).r,
                        texture(uSigma, vec2(sigmaCoord(x.g), 0.5)).g,
                        texture(uSigma, vec2(sigmaCoord(x.b), 0.5)).b);
        l += uGrainA.x * sig * grainNoise(uv);
    }
    vec3 u = clamp((l - lo) / (hi - lo), 0.0, 1.0);
    vec3 x = vec3(texture(uSigma, vec2(sigmaCoord(u.r), 0.5)).a,
                  texture(uSigma, vec2(sigmaCoord(u.g), 0.5)).a,
                  texture(uSigma, vec2(sigmaCoord(u.b), 0.5)).a);
    vec3 c = texture(uLut, x * ((N - 1.0) / N) + 0.5 / N).rgb;
    // Output is sRGB-encoded 8-bit (memory: the finish pass only does display-domain work).
    // TPDF dither before quantization keeps gradients free of banding.
    vec3 e = linearToSrgb(adjust(c));
    if (uAdjust2.w > 0.0) {
        uvec2 ip = uvec2(gl_FragCoord.xy);
        e += (rand3(uDitherSeed, ip.x, ip.y) - rand3(uDitherSeed + 1u, ip.x, ip.y)) * (uAdjust2.w / 255.0);
    }
    fragColor = vec4(clamp(e, 0.0, 1.0), 1.0);
}
