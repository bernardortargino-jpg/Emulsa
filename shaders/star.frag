// Starburst (cross-screen) filter: light of the highlights diffracted into straight rays.
// Rendered at low resolution with dense sampling along each ray, then magnified smoothly
// in develop.frag.
precision highp float;
precision highp int;

#include "common.glsl"

uniform sampler2D uTex;      // glow pyramid level: a = highlight energy
uniform float uAspect;
uniform vec4 uStar;          // unused, number of rays, length (photo height units), angle

in vec2 vUv;
out vec4 fragColor;

void main() {
    int dirs = max(int(uStar.y) / 2, 1);
    float acc = 0.0;
    const int S = 32;
    for (int k = 0; k < 4; k++) {
        if (k >= dirs) break;
        float a = uStar.w + float(k) * PI / float(dirs);
        vec2 d = vec2(cos(a) / uAspect, sin(a)) * uStar.z;
        for (int s = 1; s <= S; s++) {
            float t = float(s) / float(S);
            float w = (1.0 - t) * (1.0 - t) * (1.0 - t);
            acc += w * (texture(uTex, vUv + d * t).a + texture(uTex, vUv - d * t).a);
        }
    }
    // slight spectral dispersion along the rays
    fragColor = vec4(acc / float(S) * vec3(1.0, 0.97, 0.92), 1.0);
}
