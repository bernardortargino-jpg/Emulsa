// CCD vertical smear: per-column mean of highlight energy, rendered into a 1-row target.
precision highp float;
precision highp int;

uniform sampler2D uTex;   // a glow pyramid level (alpha = highlight energy)
uniform int uRows;

in vec2 vUv;
out vec4 fragColor;

void main() {
    int x = int(gl_FragCoord.x);
    float acc = 0.0;
    for (int y = 0; y < 256; y++) {
        if (y >= uRows) break;
        acc += texelFetch(uTex, ivec2(x, y), 0).a;
    }
    fragColor = vec4(0.0, 0.0, 0.0, acc / float(uRows));
}
