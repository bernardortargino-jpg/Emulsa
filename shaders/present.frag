// Blit a texture through a 3x3 uv transform (before/after view, raw camera preview).
#ifdef EXTERNAL_OES
#extension GL_OES_EGL_image_external_essl3 : require
#endif
precision highp float;

#ifdef EXTERNAL_OES
uniform samplerExternalOES uTex;
#else
uniform sampler2D uTex;
#endif
uniform mat3 uMatrix;
uniform int uFlipY;

in vec2 vUv;
out vec4 fragColor;

void main() {
    vec2 uv = vUv;
    if (uFlipY == 1) uv.y = 1.0 - uv.y;
    vec2 st = (uMatrix * vec3(uv, 1.0)).xy;
    fragColor = vec4(texture(uTex, st).rgb, 1.0);
}
