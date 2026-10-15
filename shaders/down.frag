// Glow pyramid - downsample.
//   mode 1 (first level): box prefilter of footprint uFootprint source texels built from
//          uTaps x uTaps bilinear taps; alpha = highlight energy max(Y - threshold, 0)
//          computed per tap at the higher resolution (small light sources still count).
//          Clipped light sources get the same boost as in develop.frag.
//   mode 0: 5-tap dual-filter /2 downsample of rgba.
precision highp float;
precision highp int;

#include "common.glsl"

uniform sampler2D uTex;
uniform vec2 uTexel;       // 1 / source size
uniform int uMode;
uniform int uTaps;
uniform vec2 uFootprint;   // source texels covered by one destination pixel (x, y)
uniform float uThreshold;  // highlight threshold (scene-linear, already divided by exposure)
uniform vec2 uSource;      // clipped-source level (max recoverable value), extra gain for sources

in vec2 vUv;
out vec4 fragColor;

void main() {
    if (uMode == 1) {
        vec4 acc = vec4(0.0);
        float n = float(uTaps);
        for (int j = 0; j < 8; j++) {
            if (j >= uTaps) break;
            for (int i = 0; i < 8; i++) {
                if (i >= uTaps) break;
                vec2 o = (vec2(float(i), float(j)) + 0.5) / n - 0.5;
                vec3 c = texture(uTex, vUv + o * uFootprint * uTexel).rgb;
                // pixels at the recovery ceiling were clipped by the phone: treat them as
                // light sources several stops brighter than paper white
                float m = max(max(c.r, c.g), c.b);
                c *= 1.0 + smoothstep(uSource.x * 0.97, uSource.x, m) * uSource.y;
                acc += vec4(c, max(luma(c) - uThreshold, 0.0));
            }
        }
        fragColor = acc / (n * n);
    } else {
        vec4 s = 4.0 * texture(uTex, vUv);
        s += texture(uTex, vUv + vec2(-1.0, -1.0) * uTexel);
        s += texture(uTex, vUv + vec2(1.0, -1.0) * uTexel);
        s += texture(uTex, vUv + vec2(-1.0, 1.0) * uTexel);
        s += texture(uTex, vUv + vec2(1.0, 1.0) * uTexel);
        fragColor = s / 8.0;
    }
}
