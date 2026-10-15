// Glow pyramid - upsample: 3x3 tent of the lower level blended with the current level.
// U_k = mix(D_k, tent(U_{k+1}), spread). The chain is a convex combination of blur radii,
// so total energy is preserved and "spread" controls how wide the glow is.
precision highp float;
precision highp int;

uniform sampler2D uLow;
uniform vec2 uLowTexel;
uniform sampler2D uCur;
uniform float uSpread;

in vec2 vUv;
out vec4 fragColor;

void main() {
    vec2 t = uLowTexel;
    vec4 s = 4.0 * texture(uLow, vUv);
    s += 2.0 * (texture(uLow, vUv + vec2(t.x, 0.0)) + texture(uLow, vUv - vec2(t.x, 0.0))
              + texture(uLow, vUv + vec2(0.0, t.y)) + texture(uLow, vUv - vec2(0.0, t.y)));
    s += texture(uLow, vUv + t) + texture(uLow, vUv - t)
       + texture(uLow, vUv + vec2(t.x, -t.y)) + texture(uLow, vUv + vec2(-t.x, t.y));
    fragColor = mix(texture(uCur, vUv), s / 16.0, uSpread);
}
