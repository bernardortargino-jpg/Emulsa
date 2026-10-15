// WebGL2 executor for Emulsa render plans in the browser (same shaders as Android/tests).
// Keeps programs, LUTs, grain/font textures and render targets alive between frames.

const SHADERS = ['optics', 'down', 'up', 'smear', 'star', 'develop', 'finish', 'present'];

export class Engine {
  constructor(canvas, base = '.') {
    this.canvas = canvas;
    this.base = base;
    const gl = canvas.getContext('webgl2', { antialias: false, premultipliedAlpha: false, preserveDrawingBuffer: true, alpha: false });
    if (!gl) throw new Error('WebGL2 indisponível neste navegador');
    if (!gl.getExtension('EXT_color_buffer_float') && !gl.getExtension('EXT_color_buffer_half_float'))
      throw new Error('Este aparelho não renderiza em ponto flutuante (EXT_color_buffer_float)');
    gl.getExtension('OES_texture_float_linear');
    this.gl = gl;
    this.programs = {};
    this.targets = {};
    this.luts = new Map();
    this.grain = {};
    this.vao = gl.createVertexArray();
    this.maxTexture = gl.getParameter(gl.MAX_TEXTURE_SIZE);
  }

  async init() {
    const get = (f) => fetch(`${this.base}/shaders/${f}`).then((r) => { if (!r.ok) throw new Error(f); return r.text(); });
    const common = await get('common.glsl');
    const asm = (src) => '#version 300 es\n' + src.replace('#include "common.glsl"', common);
    this.vert = asm(await get('fullscreen.vert'));
    this.frag = {};
    await Promise.all(SHADERS.map(async (n) => { this.frag[n] = asm(await get(`${n}.frag`)); }));
    for (const n of SHADERS) this.program(n);           // compile up front: errors surface early
    this.font = await this.imageTexture(`${this.base}/assets/font/font5x7.png`, { nearest: true });
  }

  program(name) {
    const gl = this.gl;
    if (this.programs[name]) return this.programs[name];
    const sh = (type, src) => {
      const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`shader ${name}: ${gl.getShaderInfoLog(s)}`);
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, sh(gl.VERTEX_SHADER, this.vert));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, this.frag[name]));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`link ${name}: ${gl.getProgramInfoLog(p)}`);
    const locs = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(p, i);
      const key = info.name.replace(/\[0\]$/, '');
      locs[key] = gl.getUniformLocation(p, info.name);
    }
    this.programs[name] = { p, locs };
    return this.programs[name];
  }

  // ---- resources -----------------------------------------------------------------------------
  async imageTexture(url, { repeat = false, mipmap = false, nearest = false } = {}) {
    const blob = await (await fetch(url)).blob();
    const bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    this.unpack();
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, bmp);
    const wrap = repeat ? gl.REPEAT : gl.CLAMP_TO_EDGE;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
    if (mipmap) { gl.generateMipmap(gl.TEXTURE_2D); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR); }
    else gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, nearest ? gl.NEAREST : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, nearest ? gl.NEAREST : gl.LINEAR);
    const out = { t, target: gl.TEXTURE_2D, w: bmp.width, h: bmp.height };
    bmp.close?.();
    return out;
  }

  unpack() {
    const gl = this.gl;
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
  }

  async grainTexture(kind) {
    if (!this.grain[kind]) this.grain[kind] = await this.imageTexture(`${this.base}/assets/grain/grain_${kind}.png`, { repeat: true, mipmap: true });
    return this.grain[kind];
  }

  /** Loads assets/luts/<file> (.elut v2): 3D LUT + grain sigma / shaper curve. */
  async lut(file) {
    if (this.luts.has(file)) return this.luts.get(file);
    const buf = await (await fetch(`${this.base}/assets/luts/${file}`)).arrayBuffer();
    const dv = new DataView(buf);
    const n = dv.getUint32(8, true), m = dv.getUint32(12, true);
    const lo = dv.getFloat32(16, true), hi = dv.getFloat32(20, true);
    const gl = this.gl;
    this.unpack();
    const t3 = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_3D, t3);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA16F, n, n, n, 0, gl.RGBA, gl.HALF_FLOAT, new Uint16Array(buf, 32, n * n * n * 4));
    for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) gl.texParameteri(gl.TEXTURE_3D, p, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    const t1 = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, m, 1, 0, gl.RGBA, gl.HALF_FLOAT, new Uint16Array(buf, 32 + n * n * n * 8, m * 4));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const res = { lut: { t: t3, target: gl.TEXTURE_3D }, sigma: { t: t1, target: gl.TEXTURE_2D }, info: { lo, hi, n, m } };
    this.luts.set(file, res);
    if (this.luts.size > 4) {                     // keep a few profiles resident
      const [k, v] = this.luts.entries().next().value;
      gl.deleteTexture(v.lut.t); gl.deleteTexture(v.sigma.t); this.luts.delete(k);
    }
    return res;
  }

  /** Source texture from a video element, image, canvas or ImageBitmap (rows top-first). */
  sourceTexture(el, prev, { mipmap = false } = {}) {
    const gl = this.gl;
    const t = prev?.t || gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    this.unpack();
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, el);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (mipmap) { gl.generateMipmap(gl.TEXTURE_2D); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR); }
    else gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    const w = el.videoWidth || el.naturalWidth || el.width, h = el.videoHeight || el.naturalHeight || el.height;
    return { t, target: gl.TEXTURE_2D, w, h };
  }

  deleteTexture(x) { if (x?.t) this.gl.deleteTexture(x.t); }

  target(name, w, h, format) {
    const gl = this.gl;
    const cur = this.targets[name];
    if (cur && cur.w === w && cur.h === h && cur.format === format) return cur;
    if (cur) { gl.deleteTexture(cur.t); gl.deleteFramebuffer(cur.fb); }
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    if (format === 'rgba16f') gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error(`framebuffer ${name} ${w}x${h} ${format}`);
    const rt = { t, fb, w, h, format, target: gl.TEXTURE_2D };
    this.targets[name] = rt;
    return rt;
  }

  trim() {
    const gl = this.gl;
    for (const rt of Object.values(this.targets)) { gl.deleteTexture(rt.t); gl.deleteFramebuffer(rt.fb); }
    this.targets = {};
  }

  setUniforms(prog, uniforms) {
    const gl = this.gl;
    for (const [name, [type, v]] of Object.entries(uniforms)) {
      const loc = prog.locs[name];
      if (!loc) continue;
      switch (type) {
        case '1f': gl.uniform1f(loc, v); break;
        case '2f': gl.uniform2fv(loc, v); break;
        case '3f': gl.uniform3fv(loc, v); break;
        case '4f': case '4fv': gl.uniform4fv(loc, v); break;
        case '1i': gl.uniform1i(loc, v); break;
        case '1ui': gl.uniform1ui(loc, v >>> 0); break;
        case 'mat3': gl.uniformMatrix3fv(loc, false, v); break;
        case '1iv': gl.uniform1iv(loc, v); break;
        default: throw new Error('uniform type ' + type);
      }
    }
  }

  /** Runs every pass of [plan]; returns the finish render target. */
  run(plan, res) {
    const gl = this.gl;
    gl.bindVertexArray(this.vao);
    const produced = {};
    for (const pass of plan.passes) {
      const prog = this.program(pass.program);
      gl.useProgram(prog.p);
      const rt = this.target(pass.name, pass.w, pass.h, pass.format);
      gl.bindFramebuffer(gl.FRAMEBUFFER, rt.fb);
      gl.viewport(0, 0, pass.w, pass.h);
      let unit = 0;
      for (const [uname, tname] of Object.entries(pass.textures)) {
        const loc = prog.locs[uname];
        if (!loc) continue;
        const src = produced[tname] || res[tname];
        if (!src) throw new Error(`textura ${tname} ausente em ${pass.name}`);
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(src.target, src.t);
        gl.uniform1i(loc, unit++);
      }
      this.setUniforms(prog, pass.uniforms);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      produced[pass.name] = rt;
    }
    return produced[plan.output || 'finish'];
  }

  /** Draws [tex] to the default framebuffer (canvas) in [vp] = [x, y, w, h] (GL pixels). */
  present(tex, vp, matrix = [1, 0, 0, 0, 1, 0, 0, 0, 1], clear = [0.07, 0.067, 0.063]) {
    const gl = this.gl;
    const prog = this.program('present');
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(clear[0], clear[1], clear[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.viewport(vp[0], vp[1], vp[2], vp[3]);
    gl.useProgram(prog.p);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex.t);
    gl.uniform1i(prog.locs.uTex, 0);
    gl.uniformMatrix3fv(prog.locs.uMatrix, false, matrix);
    gl.uniform1i(prog.locs.uFlipY, 1);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /** Reads an RGBA8 render target into a 2D canvas (rows top-first, i.e. upright). */
  toCanvas(rt) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, rt.fb);
    const px = new Uint8ClampedArray(rt.w * rt.h * 4);
    gl.readPixels(0, 0, rt.w, rt.h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    for (let i = 3; i < px.length; i += 4) px[i] = 255;
    const c = document.createElement('canvas');
    c.width = rt.w; c.height = rt.h;
    c.getContext('2d').putImageData(new ImageData(px, rt.w, rt.h), 0, 0);
    return c;
  }
}
