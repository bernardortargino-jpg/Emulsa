// Emulsa engine - shared GLSL ES 3.00 helpers.
// Inserted by the shader loader in place of the line  #include "common.glsl".
// Conventions: texture v = 0 is the TOP row of every image in the pipeline.

const float GREY = 0.18;
const float PI = 3.14159265358979;
const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

float luma(vec3 c) { return dot(c, LUMA); }

vec3 srgbToLinear(vec3 v) {
    vec3 lo = v / 12.92;
    vec3 hi = pow(max((v + 0.055) / 1.055, vec3(0.0)), vec3(2.4));
    return mix(hi, lo, vec3(lessThanEqual(v, vec3(0.04045))));
}

vec3 linearToSrgb(vec3 c) {
    c = max(c, vec3(0.0));
    vec3 lo = c * 12.92;
    vec3 hi = 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055;
    return mix(hi, lo, vec3(lessThanEqual(c, vec3(0.0031308))));
}

float srgbToLinear1(float v) { return v <= 0.04045 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4); }
float linearToSrgb1(float c) { c = max(c, 0.0); return c <= 0.0031308 ? c * 12.92 : 1.055 * pow(c, 1.0 / 2.4) - 0.055; }

// PCG hash (O'Neill). Identical integer arithmetic in the Python/Kotlin/Swift hosts.
uint pcg(uint v) {
    uint state = v * 747796405u + 2891336453u;
    uint word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
    return (word >> 22u) ^ word;
}
uint hash2u(uint a, uint b) { return pcg(a ^ pcg(b)); }
uint hash3u(uint a, uint b, uint c) { return pcg(a ^ pcg(b ^ pcg(c))); }
// 24-bit uniform float in [0,1): exact in float32 on every platform.
float u24(uint h) { return float(h >> 8u) * (1.0 / 16777216.0); }
float rand2(uint a, uint b) { return u24(hash2u(a, b)); }
float rand3(uint a, uint b, uint c) { return u24(hash3u(a, b, c)); }

// Smooth 2D value noise on an integer lattice, in [0,1].
float vnoise(vec2 p, uint seed) {
    vec2 i = floor(p);
    vec2 f = p - i;
    vec2 u = f * f * (3.0 - 2.0 * f);
    uint x0 = uint(int(i.x) + 32768), y0 = uint(int(i.y) + 32768);
    float a = rand3(seed, x0, y0);
    float b = rand3(seed, x0 + 1u, y0);
    float c = rand3(seed, x0, y0 + 1u);
    float d = rand3(seed, x0 + 1u, y0 + 1u);
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// Cubic B-spline texture lookup from 4 bilinear taps (smooth magnification of the
// low resolution glow / blur levels, avoids bilinear "diamond" artifacts).
vec4 textureBSpline(sampler2D tex, vec2 size, vec2 uv) {
    vec2 p = uv * size - 0.5;
    vec2 i = floor(p);
    vec2 f = p - i;
    vec2 f2 = f * f, f3 = f2 * f;
    vec2 w0 = (1.0 - 3.0 * f + 3.0 * f2 - f3) / 6.0;
    vec2 w1 = (4.0 - 6.0 * f2 + 3.0 * f3) / 6.0;
    vec2 w2 = (1.0 + 3.0 * f + 3.0 * f2 - 3.0 * f3) / 6.0;
    vec2 w3 = f3 / 6.0;
    vec2 g0 = w0 + w1, g1 = w2 + w3;
    vec2 h0 = (w1 / g0) - 1.0 + i + 0.5;
    vec2 h1 = (w3 / g1) + 1.0 + i + 0.5;
    vec4 t00 = texture(tex, vec2(h0.x, h0.y) / size);
    vec4 t10 = texture(tex, vec2(h1.x, h0.y) / size);
    vec4 t01 = texture(tex, vec2(h0.x, h1.y) / size);
    vec4 t11 = texture(tex, vec2(h1.x, h1.y) / size);
    return g0.y * (g0.x * t00 + g1.x * t10) + g1.y * (g0.x * t01 + g1.x * t11);
}
