// Pass 1 - "optics": geometry of the simulated lens and conversion to scene-linear light.
//   output pixel (photo uv) -> gate weave -> lens model (distortion | fisheye, lateral CA)
//   -> crop/orientation matrix -> source texel -> sRGB decode -> highlight recovery
//   -> double exposure and prism (both are additive light) -> scene-linear RGB (RGBA16F)
#ifdef EXTERNAL_OES
#extension GL_OES_EGL_image_external_essl3 : require
#endif
precision highp float;
precision highp int;

#include "common.glsl"

#ifdef EXTERNAL_OES
uniform samplerExternalOES uSrc;
#else
uniform sampler2D uSrc;
#endif
uniform mat3 uSrcMatrix;      // photo uv -> source texture coordinates
uniform sampler2D uSrc2;      // second exposure (always a 2D texture)
uniform mat3 uSrc2Matrix;
uniform vec2 uDoubleWeights;  // (w1, w2); w2 = 0 disables the second exposure
uniform float uAspect;        // photo width / height
uniform vec4 uLens;           // k1, k2, scale, lateral CA
uniform vec4 uFisheye;        // enabled, thetaMax (rad), circle radius (x half height), edge softness
uniform vec2 uWeave;          // gate weave offset (photo uv)
uniform vec2 uRecover;        // knee, strength
uniform vec4 uPrism;          // offset.xy (photo uv), amount, dispersion
uniform vec3 uPrismMask;      // mask normal.xy, mask offset

in vec2 vUv;
out vec4 fragColor;

vec2 lensMap(vec2 uv, float chan, out float inside) {
    vec2 p = (uv - 0.5) * vec2(uAspect, 1.0);
    inside = 1.0;
    float caScale = 1.0 + chan * uLens.w;
    if (uFisheye.x > 0.5) {
        float R = 0.5 * uFisheye.z;
        float rq = length(p) / R;
        inside = 1.0 - smoothstep(1.0 - uFisheye.w, 1.0, rq);
        float th = min(rq, 1.0) * uFisheye.y;
        float rs = tan(th) / tan(uFisheye.y);
        vec2 dir = rq > 1e-6 ? p / length(p) : vec2(0.0);
        p = dir * rs * 0.5 * caScale;
    } else {
        float hd2 = 0.25 * (uAspect * uAspect + 1.0);
        float r2 = dot(p, p) / hd2;
        p *= (1.0 + uLens.x * r2 + uLens.y * r2 * r2) * uLens.z * caScale;
    }
    return clamp(p / vec2(uAspect, 1.0) + 0.5, 0.0, 1.0);
}

vec3 fetchSrc(vec2 photoUv) {
    vec2 st = (uSrcMatrix * vec3(photoUv, 1.0)).xy;
    return texture(uSrc, st).rgb;
}

vec3 fetchSrc2(vec2 photoUv) {
    vec2 st = (uSrc2Matrix * vec3(photoUv, 1.0)).xy;
    return texture(uSrc2, st).rgb;
}

vec3 recoverHighlights(vec3 c) {
    float m = max(max(c.r, c.g), c.b);
    float k = uRecover.x;
    float s = uRecover.y;
    if (m <= k || s <= 0.0) return c;
    float t = min((m - k) / (1.0 - k), 1.0);
    float m2 = k + (1.0 - k) * t / (1.0 - s * t);
    return c * (m2 / m);
}

vec3 sampleLens(vec2 uv, out float inside) {
    float i0, i1, i2;
    vec3 c;
    if (uLens.w != 0.0) {
        c.r = fetchSrc(lensMap(uv, 1.0, i0)).r;
        c.g = fetchSrc(lensMap(uv, 0.0, i1)).g;
        c.b = fetchSrc(lensMap(uv, -1.0, i2)).b;
    } else {
        c = fetchSrc(lensMap(uv, 0.0, i1));
    }
    inside = i1;
    return recoverHighlights(srgbToLinear(c));
}

void main() {
    vec2 uv = vUv + uWeave;
    float inside;
    vec3 E = sampleLens(uv, inside) * uDoubleWeights.x;
    if (uDoubleWeights.y > 0.0) {
        float i2;
        vec3 c2 = fetchSrc2(lensMap(uv, 0.0, i2));
        E += recoverHighlights(srgbToLinear(c2)) * uDoubleWeights.y;
    }
    if (uPrism.z > 0.0) {
        vec2 p = (uv - 0.5) * vec2(uAspect, 1.0);
        float m = smoothstep(-0.06, 0.06, dot(p, uPrismMask.xy) - uPrismMask.z);
        float ia, ib, ic;
        vec3 g;
        g.r = fetchSrc(lensMap(uv + uPrism.xy * (1.0 + uPrism.w), 0.0, ia)).r;
        g.g = fetchSrc(lensMap(uv + uPrism.xy, 0.0, ib)).g;
        g.b = fetchSrc(lensMap(uv + uPrism.xy * (1.0 - uPrism.w), 0.0, ic)).b;
        E += recoverHighlights(srgbToLinear(g)) * (uPrism.z * m);
    }
    fragColor = vec4(E * inside, 1.0);
}
