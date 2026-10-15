// Pass 4 - "finish": display-domain effects and output canvas.
//   photo area: VHS signal path (luma/chroma bandwidth, line jitter, tracking band,
//   head switching, tape noise) | digital sharpening, dust & hair (white on prints from
//   negatives, black on projected/scanned reversal film), vertical scratches.
//   canvas: frame types (instant border, film strip with sprocket holes, slide mount,
//   Super 8 gate, letterbox, negative rebate), on-screen display text, TPDF dither, sRGB.
precision highp float;
precision highp int;

#include "common.glsl"

uniform sampler2D uImage;       // develop output (sRGB-encoded 8-bit)
uniform vec2 uImageSize;
uniform sampler2D uFont;        // 5x7 bitmap font, 6x8 cells in one row
uniform vec2 uCanvasSize;       // pixels
uniform vec4 uPhotoRect;        // photo area in canvas uv: x, y, w, h
uniform int uFlipY;
uniform int uEncode;            // 1 = write sRGB-encoded values
uniform int uFrameType;         // 0 none, 1 instant, 2 sprocket strip, 3 slide mount, 4 super8 gate, 5 letterbox, 6 negative rebate
uniform vec4 uFrameColor;
uniform vec4 uFrameParams;      // corner radius (canvas height units), texture amount, inner shadow, unused
uniform vec4 uSharpen;          // amount, radius (px of the develop image)
uniform vec4 uVhsA;             // enabled, chroma bleed (photo uv), luma blur (photo uv), chroma saturation
uniform vec4 uVhsB;             // line jitter (photo uv), tracking band center y, band height, band strength
uniform vec4 uVhsC;             // head switching height, head switching shift, noise amount, ringing
uniform vec4 uDust;             // specks per frame, size (photo height), polarity (+1 white / -1 black), opacity
uniform vec4 uScratch;          // count, opacity, width (photo uv), drift
uniform uint uSeed;
uniform uint uFrame;
uniform float uTime;
uniform int uOsdCount;
uniform int uOsd[48];           // glyph indices, -1 = new line
uniform vec4 uOsdRect;          // x, y (top-left, canvas uv), glyph cell w, h (canvas uv)
uniform vec4 uOsdColor;
uniform float uDither;          // applied outside the photo area (frames); the photo was dithered in develop

in vec2 vUv;
out vec4 fragColor;

vec3 img(vec2 uv) { return srgbToLinear(texture(uImage, uv).rgb); }

vec3 rgb2yiq(vec3 c) {
    return vec3(dot(c, vec3(0.299, 0.587, 0.114)), dot(c, vec3(0.596, -0.274, -0.322)), dot(c, vec3(0.211, -0.523, 0.312)));
}
vec3 yiq2rgb(vec3 y) {
    return vec3(y.x + 0.956 * y.y + 0.621 * y.z, y.x - 0.272 * y.y - 0.647 * y.z, y.x - 1.106 * y.y + 1.703 * y.z);
}

// VHS works on the gamma-encoded signal like the real Y/C path.
vec3 vhs(vec2 uv) {
    float lines = 486.0;
    float line = floor(uv.y * lines);
    uint li = uint(line);
    float jitter = (rand3(uSeed, uFrame, li) - 0.5) * uVhsB.x;
    jitter += sin(uv.y * 9.0 + uTime * 1.7) * uVhsB.x * 0.35;
    float band = 1.0 - smoothstep(0.0, uVhsB.z, abs(uv.y - uVhsB.y));
    jitter += band * uVhsB.w * (rand3(uSeed + 7u, uFrame, li) - 0.3) * 0.04;
    float hs = smoothstep(1.0 - uVhsC.x, 1.0, uv.y);
    jitter += hs * uVhsC.y;
    vec2 u = vec2(uv.x + jitter, uv.y);
    // luma: short horizontal blur + ringing (edge enhancement of the deck)
    float yb = 0.0, ysh = 0.0;
    for (int i = -2; i <= 2; i++) {
        float w = 1.0 - abs(float(i)) * 0.3;
        yb += w * rgb2yiq(linearToSrgb(img(u + vec2(float(i) * uVhsA.z, 0.0)))).x;
    }
    yb /= 2.8;
    float y0 = rgb2yiq(linearToSrgb(img(u))).x;
    float ywide = 0.5 * (rgb2yiq(linearToSrgb(img(u + vec2(3.0 * uVhsA.z, 0.0)))).x
                       + rgb2yiq(linearToSrgb(img(u - vec2(3.0 * uVhsA.z, 0.0)))).x);
    float Y = yb + uVhsC.w * (yb - ywide);
    // chroma: wide low-pass, delayed to the right (color smear)
    vec2 iq = vec2(0.0);
    for (int i = 0; i < 7; i++) {
        float o = (float(i) - 2.0) / 6.0 * uVhsA.y;
        iq += rgb2yiq(linearToSrgb(img(u + vec2(-o, 0.0)))).yz;
    }
    iq = iq / 7.0 * uVhsA.w;
    // tape noise: luma snow + low-frequency chroma noise, stronger in the tracking band
    float nz = uVhsC.z * (1.0 + 4.0 * band * uVhsB.w);
    Y += (rand3(uSeed + 11u, uFrame, uint(uv.x * 720.0) + li * 1024u) - 0.5) * nz;
    iq += (vec2(vnoise(vec2(uv.x * 40.0, line), uSeed + uFrame * 3u), vnoise(vec2(uv.x * 40.0, line), uSeed + uFrame * 5u + 1u)) - 0.5) * nz * 0.6;
    float streak = step(0.985, rand3(uSeed + 13u, uFrame, li)) * band * uVhsB.w;
    Y = mix(Y, 0.9, streak * step(0.5, rand3(uSeed + 17u, uFrame, uint(uv.x * 64.0) + li * 64u)));
    return srgbToLinear(clamp(yiq2rgb(vec3(Y, iq)), 0.0, 1.0));
}

vec3 sharpen(vec2 uv, vec3 c) {
    vec2 t = uSharpen.y / uImageSize;
    vec3 e = linearToSrgb(c);
    vec3 nb = linearToSrgb(img(uv + vec2(t.x, 0.0))) + linearToSrgb(img(uv - vec2(t.x, 0.0)))
            + linearToSrgb(img(uv + vec2(0.0, t.y))) + linearToSrgb(img(uv - vec2(0.0, t.y)));
    e = e + uSharpen.x * (e - nb * 0.25);
    return srgbToLinear(clamp(e, 0.0, 1.0));
}

vec3 dustAndScratches(vec2 uv, vec3 c, float aspect) {
    vec3 target = uDust.z > 0.0 ? vec3(0.96, 0.95, 0.93) : vec3(0.01);
    int n = int(uDust.x);
    for (int i = 0; i < 24; i++) {
        if (i >= n) break;
        uint ui = uint(i);
        vec2 ctr = vec2(rand3(uSeed, uFrame, ui * 4u), rand3(uSeed, uFrame, ui * 4u + 1u));
        float sz = uDust.y * (0.25 + 1.2 * pow(rand3(uSeed, uFrame, ui * 4u + 2u), 3.0));
        vec2 d = (uv - ctr) * vec2(aspect, 1.0);
        float cov;
        if ((i & 3) == 3) {
            // hair: a gently curved thin line
            float ang = rand3(uSeed, uFrame, ui * 4u + 3u) * PI;
            vec2 dir = vec2(cos(ang), sin(ang));
            float along = dot(d, dir);
            float across = dot(d, vec2(-dir.y, dir.x)) - along * along * 6.0;
            float len = sz * 8.0;
            cov = (1.0 - smoothstep(len * 0.8, len, abs(along))) * (1.0 - smoothstep(0.0006, 0.0014, abs(across)));
        } else {
            float wob = vnoise(d / sz * 2.5 + vec2(float(i) * 3.1), uSeed + uFrame);
            cov = 1.0 - smoothstep(0.6, 1.0, length(d) / sz + (wob - 0.5) * 0.6);
        }
        c = mix(c, target, cov * uDust.w);
    }
    int ns = int(uScratch.x);
    for (int j = 0; j < 4; j++) {
        if (j >= ns) break;
        uint uj = uint(j);
        float x0 = rand2(uSeed + 101u, uj);
        float x = x0 + uScratch.w * sin(uTime * (0.3 + rand2(uSeed + 103u, uj)) + float(j) * 2.0);
        float on = step(0.25, rand3(uSeed + 107u, uFrame / 3u, uj));
        float w = uScratch.z * (0.6 + rand2(uSeed + 109u, uj));
        float cov = (1.0 - smoothstep(w * 0.4, w, abs(uv.x - x))) * on;
        cov *= 0.6 + 0.4 * vnoise(vec2(uv.y * 30.0, float(j)), uSeed + uFrame);
        c = mix(c, target, cov * uScratch.y);
    }
    return c;
}

float roundedBox(vec2 p, vec2 halfSize, float r) {
    vec2 q = abs(p) - halfSize + r;
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

float glyph(int g, vec2 cell) {
    // cell in [0,1]^2 of a 6x8 glyph cell; the font texture holds 6x8 cells in one row
    if (g < 0 || cell.x < 0.0 || cell.y < 0.0 || cell.x >= 1.0 || cell.y >= 1.0) return 0.0;
    ivec2 px = ivec2(int(cell.x * 6.0) + g * 6, int(cell.y * 8.0));
    return texelFetch(uFont, px, 0).r;
}

vec3 osd(vec3 c, vec2 cuv) {
    if (uOsdCount == 0) return c;
    vec2 local = (cuv - uOsdRect.xy) / uOsdRect.zw;
    if (local.x < -0.2 || local.y < -0.2) return c;
    int row = int(floor(local.y / 1.25));
    int col = 0, r = 0;
    float fg = 0.0, sh = 0.0;
    vec2 shOff = vec2(1.0 / 6.0, 1.0 / 8.0);
    for (int i = 0; i < 48; i++) {
        if (i >= uOsdCount) break;
        int g = uOsd[i];
        if (g == -1) { r++; col = 0; continue; }
        if (r == row || r == row - 1 || r == row + 1) {
            vec2 cell = vec2(local.x - float(col), local.y - float(r) * 1.25);
            fg = max(fg, glyph(g, cell));
            sh = max(sh, glyph(g, cell - shOff));
        }
        col++;
    }
    c = mix(c, vec3(0.0), sh * 0.75 * uOsdColor.a);
    return mix(c, uOsdColor.rgb, fg * uOsdColor.a);
}

vec3 frameColor(vec2 cuv) {
    vec3 col = uFrameColor.rgb;
    if (uFrameParams.y > 0.0) {
        vec2 px = cuv * uCanvasSize;
        float fine = rand3(uSeed + 31u, uint(px.x), uint(px.y)) - 0.5;
        float coarse = vnoise(px / 40.0, uSeed + 37u) - 0.5;
        col *= 1.0 + uFrameParams.y * (fine * 0.04 + coarse * 0.06);
    }
    return col;
}

void main() {
    vec2 cuv = vUv;
    if (uFlipY == 1) cuv.y = 1.0 - cuv.y;
    vec2 puv = (cuv - uPhotoRect.xy) / uPhotoRect.zw;
    float aspect = (uPhotoRect.z * uCanvasSize.x) / (uPhotoRect.w * uCanvasSize.y);
    bool inPhoto = puv.x >= 0.0 && puv.y >= 0.0 && puv.x <= 1.0 && puv.y <= 1.0;
    vec3 c;
    if (inPhoto) {
        c = uVhsA.x > 0.5 ? vhs(puv) : img(puv);
        if (uSharpen.x > 0.0) c = sharpen(puv, c);
        if (uDust.x > 0.0 || uScratch.x > 0.0) c = dustAndScratches(puv, c, aspect);
    } else {
        c = frameColor(cuv);
    }
    float canvasAspect = uCanvasSize.x / uCanvasSize.y;
    if (uFrameType == 1 || uFrameType == 3) {
        // instant print / slide mount: rounded photo window with a soft inner shadow
        vec2 ctr = (uPhotoRect.xy + 0.5 * uPhotoRect.zw);
        vec2 p = (cuv - ctr) * vec2(canvasAspect, 1.0);
        vec2 hs = 0.5 * uPhotoRect.zw * vec2(canvasAspect, 1.0);
        float d = roundedBox(p, hs, uFrameParams.x);
        float win = 1.0 - smoothstep(-0.0015, 0.0015, d);
        float shadow = smoothstep(-0.02, 0.0, d) * uFrameParams.z;
        c = mix(frameColor(cuv), c * (1.0 - shadow), win);
    } else if (uFrameType == 2) {
        // 35mm sprocket holes over the image (they scan as black). The film runs along the
        // long side of the canvas; its 35 mm width spans the short side.
        bool vertical = canvasAspect < 1.0;
        vec2 q = vertical ? vec2(cuv.y, cuv.x) : cuv;
        float along = vertical ? 1.0 / canvasAspect : canvasAspect;
        float mm = 1.0 / 35.0;
        vec2 pmm = vec2(q.x * along, q.y) / mm;
        float pitch = 4.75;
        float xc = (floor(pmm.x / pitch) + 0.5) * pitch;
        float yTop = 2.0 + 0.99, yBot = 35.0 - 2.0 - 0.99;
        float yc = q.y < 0.5 ? yTop : yBot;
        float d = roundedBox(pmm - vec2(xc, yc), vec2(1.4, 0.99), 0.5);
        c = mix(c, vec3(0.006), 1.0 - smoothstep(-0.08, 0.08, d));
    } else if (uFrameType == 4) {
        // Super 8 gate: rounded aperture, soft and slightly irregular edges
        vec2 p = (puv - 0.5) * vec2(aspect, 1.0);
        float wob = (vnoise(vec2(puv.y * 12.0, 0.0), uSeed + 41u) - 0.5) * 0.006;
        float d = roundedBox(p, vec2(0.5 * aspect - 0.012 + wob, 0.488), uFrameParams.x);
        c = mix(c, vec3(0.004), smoothstep(-0.006, 0.004, d));
    } else if (uFrameType == 6) {
        vec2 ctr = (uPhotoRect.xy + 0.5 * uPhotoRect.zw);
        vec2 p = (cuv - ctr) * vec2(canvasAspect, 1.0);
        vec2 hs = 0.5 * uPhotoRect.zw * vec2(canvasAspect, 1.0);
        float d = roundedBox(p, hs, uFrameParams.x);
        c = mix(c, frameColor(cuv), smoothstep(-0.001, 0.002, d));
    }
    c = osd(c, cuv);
    vec3 e = uEncode == 1 ? linearToSrgb(c) : c;
    bool processed = !inPhoto || uVhsA.x > 0.5 || uSharpen.x > 0.0;
    if (uDither > 0.0 && processed) {
        uvec2 ip = uvec2(gl_FragCoord.xy);
        float d = rand3(uSeed + 53u, ip.x, ip.y + uFrame * 4099u) - rand3(uSeed + 59u, ip.x, ip.y + uFrame * 4099u);
        e += d * uDither / 255.0;
    }
    fragColor = vec4(clamp(e, 0.0, 1.0), 1.0);
}
