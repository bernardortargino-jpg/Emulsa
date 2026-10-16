// Emulsa web: retro camera that develops photos on the device with the Emulsa engine
// (same GLSL shaders, LUTs and render plans as the Android and iOS apps).
import { buildPlan } from './engine/plan.js';
import { Engine } from './engine/gpu.js';
import { drawCamera } from './engine/art.js';
import * as store from './engine/store.js';

const $ = (id) => document.getElementById(id);
const PT = (navigator.language || 'pt').toLowerCase().startsWith('pt');
const t = (pt, en) => (PT ? pt : en);

// ---- icons (original, simple strokes) ---------------------------------------------------------
const I = {
  flash: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
  timer: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2M9 2h6"/>',
  date: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  leak: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  grid: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18M15 3v18M3 9h18M3 15h18"/>',
  lens: '<circle cx="12" cy="12" r="9"/><path d="m14.3 3.3-4.6 8M20.5 9.5h-9.2M18.6 17.6 14 9.7M9.7 20.7l4.6-8M3.5 14.5h9.2M5.4 6.4 10 14.3"/>',
  double: '<rect x="3" y="3" width="13" height="13" rx="2"/><rect x="8" y="8" width="13" height="13" rx="2"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>',
  flip: '<path d="M4 9a8 8 0 0 1 14-3l2 2M20 15a8 8 0 0 1-14 3l-2-2"/><path d="M20 4v4h-4M4 20v-4h4"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  share: '<path d="M12 3v12M8 7l4-4 4 4"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/>',
  edit: '<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  check: '<path d="m5 12 5 5L20 7"/>',
};
const svg = (n) => `<svg viewBox="0 0 24 24" aria-hidden="true">${I[n]}</svg>`;
for (const [id, n] of [['b-flash', 'flash'], ['b-timer', 'timer'], ['b-date', 'date'], ['b-leak', 'leak'], ['b-grid', 'grid'],
  ['b-lens', 'lens'], ['b-double', 'double'], ['b-info', 'info'], ['b-flip', 'flip'], ['sheet-close', 'close']]) $(id).innerHTML = svg(n);

// ---- preferences --------------------------------------------------------------------------------
const PREF_KEY = 'emulsa.prefs';
const prefs = Object.assign({ photo: 'sol200', video: 'super8', mode: 'photo', timer: 0, grid: false, leak: 'auto',
  dateStamp: null, flash: null, quality: 'normal', mirror: true, accessory: 'none' }, (() => { try { return JSON.parse(localStorage.getItem(PREF_KEY)) || {}; } catch { return {}; } })());
const savePrefs = () => { try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch { /* private mode */ } };

// ---- state -----------------------------------------------------------------------------------------
let engine, index = [], profile, res;
const profiles = new Map();
const newSeed = () => 1 + Math.floor(Math.random() * 0x7FFFFFFE);
let settings = { seed: newSeed(), leak: prefs.leak, dateStamp: prefs.dateStamp, flash: prefs.flash, accessory: prefs.accessory, exposure: 0 };
let facing = 'environment', stream = null, video = null, srcTex = null, src2 = null, doubleOn = false;
let view = 'camera', busy = false, lastIdx = -1, dirty = true, recorder = null, recStart = 0;
const gl = $('gl');

const nowIso = (d = new Date()) => {
  const p = (v) => String(v).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

let toastTimer;
function toast(msg, ms = 2600) {
  const el = $('toast');
  el.textContent = msg; el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

// ---- profiles & resources -----------------------------------------------------------------------
async function loadProfile(id) {
  if (!profiles.has(id)) profiles.set(id, await (await fetch(`assets/profiles/${id}.json`)).json());
  return profiles.get(id);
}
async function resources(p) {
  const lut = await engine.lut(p.lut);
  const grain = await engine.grainTexture(p.grain.texture);
  return { lut: lut.lut, sigma: lut.sigma, info: lut.info, grain, font: engine.font };
}
async function selectProfile(id, announce = true) {
  const p = await loadProfile(id);
  res = await resources(p);
  profile = p;
  prefs[p.kind === 'video' ? 'video' : 'photo'] = id; savePrefs();
  if (!p.capabilities.accessories && !p.format.forceAccessory) settings.accessory = 'none';
  if (!p.capabilities.doubleExposure) cancelDouble();
  dirty = true;
  renderPicker();
  refreshTop();
  if (announce) toast(`${p.name[PT ? 'pt' : 'en']} — ${p.description[PT ? 'pt' : 'en']}`, 3200);
}

function renderPicker() {
  const kind = prefs.mode === 'video' ? 'video' : 'photo';
  const el = $('picker');
  const items = index.filter((e) => e.kind === kind);
  if (el.dataset.kind !== kind) {
    el.innerHTML = '';
    el.dataset.kind = kind;
    for (const e of items) {
      const b = document.createElement('button');
      b.className = 'cam'; b.dataset.id = e.id; b.setAttribute('role', 'option');
      b.setAttribute('aria-label', e.name[PT ? 'pt' : 'en']);
      const c = document.createElement('canvas');
      const px = Math.round(66 * (window.devicePixelRatio || 2));
      c.width = c.height = px;
      drawCamera(c.getContext('2d'), e.category, px);
      const s = document.createElement('span'); s.textContent = e.name[PT ? 'pt' : 'en'];
      b.append(c, s);
      b.onclick = () => { if (!busy && !recorder) selectProfile(e.id); };
      el.append(b);
    }
  }
  for (const b of el.children) {
    const sel = b.dataset.id === profile?.id;
    b.classList.toggle('sel', sel); b.setAttribute('aria-selected', sel);
    if (sel) b.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
  }
}

function refreshTop() {
  if (!profile) return;
  const caps = profile.capabilities;
  const flashOn = settings.flash == null ? profile.flash.default : settings.flash;
  $('b-flash').classList.toggle('on', !!flashOn && caps.flash);
  $('b-flash').classList.toggle('off', !caps.flash);
  $('b-timer').classList.toggle('on', prefs.timer > 0);
  $('b-timer').setAttribute('aria-label', t(`Temporizador: ${prefs.timer || 'desligado'}`, `Timer: ${prefs.timer || 'off'}`));
  const stamp = (settings.dateStamp ?? profile.stamp.defaultOn) && caps.dateStamp;
  $('b-date').classList.toggle('on', stamp); $('b-date').classList.toggle('off', !caps.dateStamp);
  $('b-leak').classList.toggle('on', settings.leak === 'on'); $('b-leak').classList.toggle('off', settings.leak === 'off');
  $('b-grid').classList.toggle('on', prefs.grid);
  const acc = profile.format.forceAccessory || settings.accessory;
  $('b-lens').classList.toggle('on', acc !== 'none'); $('b-lens').classList.toggle('off', !caps.accessories);
  $('b-double').classList.toggle('on', doubleOn); $('b-double').classList.toggle('off', !caps.doubleExposure || prefs.mode === 'video');
  $('b-ev').textContent = Math.abs(settings.exposure) < 0.05 ? '±0' : (settings.exposure > 0 ? '+' : '') + settings.exposure.toFixed(1);
  $('b-ev').classList.toggle('on', Math.abs(settings.exposure) >= 0.05);
  $('grid').hidden = !prefs.grid;
  $('shutter').classList.toggle('video', prefs.mode === 'video');
  $('shutter').setAttribute('aria-label', prefs.mode === 'video' ? t('Gravar', 'Record') : t('Fotografar', 'Take photo'));
  for (const b of document.querySelectorAll('#modes button')) b.classList.toggle('on', b.dataset.mode === prefs.mode);
}

// ---- camera ------------------------------------------------------------------------------------------
async function startCamera() {
  stopCamera();
  const hi = prefs.quality === 'high';
  const photo = prefs.mode === 'photo';
  const ideal = photo ? (hi ? [4032, 3024] : [1920, 1440]) : (hi ? [1920, 1080] : [1280, 720]);
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: facing, width: { ideal: ideal[0] }, height: { ideal: ideal[1] } },
    });
  } catch (e) {
    $('start-msg').textContent = e && e.name === 'NotAllowedError'
      ? t('Permita o acesso à câmera: Ajustes → Safari → Câmera (ou toque abaixo).', 'Allow camera access: Settings → Safari → Camera (or tap below).')
      : t('Não foi possível abrir a câmera. Você ainda pode importar fotos pela galeria.', 'Could not open the camera. You can still import photos from the gallery.');
    $('start').hidden = false;
    return false;
  }
  video = video || Object.assign(document.createElement('video'), { muted: true, playsInline: true, autoplay: true });
  video.setAttribute('playsinline', ''); video.setAttribute('muted', '');
  video.srcObject = stream;
  await video.play().catch(() => {});
  $('start').hidden = true;
  dirty = true;
  return true;
}
function stopCamera() {
  if (stream) for (const tr of stream.getTracks()) tr.stop();
  stream = null;
}

// ---- live preview ----------------------------------------------------------------------------------
function fitCanvas(cw, ch) {
  if (gl.width !== cw || gl.height !== ch) { gl.width = cw; gl.height = ch; }
  const st = $('stage').getBoundingClientRect();
  const k = Math.min(st.width / cw, st.height / ch);
  const w = Math.floor(cw * k), h = Math.floor(ch * k);
  gl.style.width = `${w}px`; gl.style.height = `${h}px`;
  Object.assign($('grid').style, { width: `${w}px`, height: `${h}px` });
}
const LITE = new URLSearchParams(location.search).has('lite');   // software-GPU testing
function previewLong() {
  if (LITE) return 360;
  if (prefs.mode === 'video') return prefs.quality === 'high' ? 1920 : 1280;
  const st = $('stage').getBoundingClientRect();
  return Math.min(1280, Math.max(480, Math.round(Math.max(st.width, st.height) * (window.devicePixelRatio || 2))));
}

function frame(now) {
  requestAnimationFrame(frame);
  if (view !== 'camera' || busy || !profile || !res || !video || video.readyState < 2 || !video.videoWidth) return;
  const isVideo = profile.kind === 'video';
  let fidx = 0, time = 0;
  if (isVideo) {
    const tsec = (recorder ? now - recStart : now) / 1000;
    fidx = Math.floor(tsec * profile.video.fps);
    if (fidx === lastIdx && !dirty) return;           // hold frames: 18 / 24 fps cadence
    lastIdx = fidx;
    time = fidx / profile.video.fps;
  }
  dirty = false;
  try {
    srcTex = engine.sourceTexture(video, srcTex);
    const ctx = { srcW: srcTex.w, srcH: srcTex.h, purpose: 'preview', previewLong: previewLong(), video: isVideo, frame: fidx, time };
    if (src2) Object.assign(ctx, { src2: true, src2W: src2.w, src2H: src2.h });
    const s = { ...settings, mirror: facing === 'user' };
    if (recorder) s.date = recorder.date;
    const plan = buildPlan(profile, s, ctx, res.info);
    const out = engine.run(plan, { ...res, src: srcTex, src2: src2 || srcTex });
    fitCanvas(plan.canvas[0], plan.canvas[1]);
    engine.present(out, [0, 0, plan.canvas[0], plan.canvas[1]]);
  } catch (e) {
    console.error(e);
    toast(String(e.message || e), 5000);
    busy = true;   // stop the loop on a hard GPU error
  }
}

// ---- developing ---------------------------------------------------------------------------------------
async function develop(p, s, srcEl, src2El, maxLong) {
  const r = await resources(p);
  const t1 = engine.sourceTexture(srcEl, null, { mipmap: true });
  const t2 = src2El ? engine.sourceTexture(src2El, null, { mipmap: true }) : null;
  try {
    const ctx = { srcW: t1.w, srcH: t1.h, purpose: 'export', maxLong: Math.min(maxLong, engine.maxTexture) };
    if (t2) Object.assign(ctx, { src2: true, src2W: t2.w, src2H: t2.h });
    const plan = buildPlan(p, s, ctx, r.info);
    const rt = engine.run(plan, { ...r, src: t1, src2: t2 || t1 });
    return engine.toCanvas(rt);
  } finally {
    engine.deleteTexture(t1); engine.deleteTexture(t2);
    engine.trim();
    dirty = true;
  }
}
const toBlob = (c, q = 0.92) => new Promise((ok) => c.toBlob(ok, 'image/jpeg', q));
function scaled(c, long) {
  const k = Math.min(1, long / Math.max(c.width, c.height));
  const o = document.createElement('canvas');
  o.width = Math.max(1, Math.round(c.width * k)); o.height = Math.max(1, Math.round(c.height * k));
  o.getContext('2d').drawImage(c, 0, 0, o.width, o.height);
  return o;
}
function grabFrame() {
  const c = document.createElement('canvas');
  c.width = video.videoWidth; c.height = video.videoHeight;
  c.getContext('2d').drawImage(video, 0, 0);
  return c;
}
async function canvasFromBlob(blob, maxLong = 4096) {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();                       // <img> applies the EXIF orientation
    const k = Math.min(1, maxLong / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c;
  } finally { URL.revokeObjectURL(url); }
}
const exportLong = () => (LITE ? 800 : prefs.quality === 'high' ? 4096 : 2560);

async function saveShot(shot, developed) {
  shot.developed = await toBlob(developed);
  shot.thumb = await toBlob(scaled(developed, 360), 0.85);
  await store.put(shot);
  setThumb(shot.thumb);
}
function setThumb(blob) {
  const img = $('thumb');
  if (img.dataset.url) URL.revokeObjectURL(img.dataset.url);
  if (!blob) { img.removeAttribute('src'); return; }
  img.dataset.url = URL.createObjectURL(blob);
  img.src = img.dataset.url;
}

// ---- capture ------------------------------------------------------------------------------------------
function flashCurtain() {
  const c = $('curtain');
  c.style.transition = 'none'; c.style.opacity = '0.65';
  requestAnimationFrame(() => { c.style.transition = 'opacity .25s'; c.style.opacity = '0'; });
}

async function shutter() {
  if (busy) return;
  if (!video || !video.videoWidth) { toast(t('Câmera desligada', 'Camera is off')); return; }
  if (prefs.mode === 'video') { recorder ? stopRecording() : startRecording(); return; }
  if (prefs.timer > 0) {
    busy = true;
    const el = $('count');
    for (let n = prefs.timer; n > 0; n--) { el.hidden = false; el.textContent = n; await new Promise((r) => setTimeout(r, 1000)); }
    el.hidden = true; busy = false;
  }
  await takePhoto();
}

async function takePhoto() {
  busy = true;
  $('shutter').classList.add('busy');
  flashCurtain();
  try {
    const frameCanvas = grabFrame();
    if (doubleOn && !src2) {
      src2 = engine.sourceTexture(frameCanvas, null, { mipmap: true });
      src2.canvas = frameCanvas;
      toast(t('1ª exposição gravada — enquadre a 2ª', 'First exposure saved — frame the second'));
      return;
    }
    const s = { ...settings, date: nowIso(), mirror: facing === 'user' && prefs.mirror };
    const second = src2 ? src2.canvas : null;
    const developed = await develop(profile, s, frameCanvas, second, exportLong());
    const shot = { id: `${Date.now()}`, created: Date.now(), kind: 'photo', profileId: profile.id, settings: s,
      original: await toBlob(frameCanvas, 0.95), original2: second ? await toBlob(second, 0.95) : null };
    await saveShot(shot, developed);
    if (second) cancelDouble();
    settings.seed = newSeed();          // fresh grain / leaks for the next frame
    toast(t('Revelada! Toque na miniatura para salvar em Fotos.', 'Developed! Tap the thumbnail to save it to Photos.'));
  } catch (e) {
    console.error(e);
    toast(t('Falha ao revelar: ', 'Developing failed: ') + (e.message || e), 5000);
  } finally {
    busy = false; dirty = true;
    $('shutter').classList.remove('busy');
  }
}

function cancelDouble() {
  doubleOn = false;
  if (src2) engine.deleteTexture(src2);
  src2 = null; dirty = true; refreshTop();
}

// ---- video ---------------------------------------------------------------------------------------------
async function startRecording() {
  if (!gl.captureStream || !window.MediaRecorder) { toast(t('Gravação de vídeo não suportada neste navegador', 'Video recording is not supported here')); return; }
  const tracks = [...gl.captureStream(30).getVideoTracks()];
  let mic = null;
  try { mic = await navigator.mediaDevices.getUserMedia({ audio: true }); tracks.push(...mic.getAudioTracks()); } catch { /* silent video */ }
  const mime = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm'].find((m) => MediaRecorder.isTypeSupported?.(m)) || '';
  const rec = new MediaRecorder(new MediaStream(tracks), mime ? { mimeType: mime, videoBitsPerSecond: 8_000_000 } : {});
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  rec.onerror = (e) => { console.error('recorder', e.error || e); toast(t('Falha na gravação', 'Recording failed')); };
  rec.onstop = async () => { try {
    mic?.getTracks().forEach((tr) => tr.stop());
    const type = rec.mimeType || mime || 'video/mp4';
    const blob = new Blob(chunks, { type });
    const thumb = await toBlob(scaled(gl, 360), 0.85).catch(() => null);
    const shot = { id: `${Date.now()}`, created: Date.now(), kind: 'video', profileId: profile.id, settings: { ...settings, date: rec.date }, video: blob, mime: type, thumb };
    await store.put(shot);
    if (thumb) setThumb(thumb);
    toast(t('Vídeo salvo na galeria do Emulsa. Abra a galeria para salvar em Fotos.', 'Video saved in the Emulsa gallery. Open it to save to Photos.'), 3500);
  } catch (e) { console.error('save video', e); toast(t('Falha ao salvar o vídeo: ', 'Could not save the video: ') + (e.message || e), 5000); } };
  rec.date = nowIso();
  recorder = rec; recStart = performance.now(); lastIdx = -1; dirty = true;
  rec.start(1000);
  $('shutter').classList.add('rec'); $('rec').hidden = false;
  const tick = () => {
    if (!recorder) return;
    const sec = Math.floor((performance.now() - recStart) / 1000);
    $('rec').querySelector('span').textContent = `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
    setTimeout(tick, 250);
  };
  tick();
}
function stopRecording() {
  const rec = recorder;
  recorder = null;
  $('shutter').classList.remove('rec'); $('rec').hidden = true;
  rec?.stop();
  settings.seed = newSeed();
}

// ---- share / save ---------------------------------------------------------------------------------------
async function shareBlob(blob, name) {
  const file = new File([blob], name, { type: blob.type });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file] }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
}

// ---- sheets: gallery, viewer, editor, about ------------------------------------------------------------
function openSheet(title, actions = []) {
  view = 'sheet';
  $('sheet').hidden = false;
  $('sheet-title').textContent = title;
  const a = $('sheet-actions'); a.innerHTML = '';
  for (const [icon, label, fn] of actions) {
    const b = document.createElement('button');
    b.innerHTML = svg(icon); b.setAttribute('aria-label', label); b.onclick = fn;
    a.append(b);
  }
  const body = $('sheet-body'); body.innerHTML = '';
  return body;
}
let sheetBack = null;
function closeSheet() {
  if (sheetBack) { const f = sheetBack; sheetBack = null; f(); return; }
  $('sheet').hidden = true; $('sheet-body').innerHTML = '';
  view = 'camera'; dirty = true;
}
$('sheet-close').onclick = closeSheet;

async function openGallery() {
  sheetBack = null;
  const body = openSheet(t('Galeria', 'Gallery'), [['plus', t('Importar foto', 'Import photo'), () => $('file').click()]]);
  const shots = await store.list();
  if (!shots.length) {
    body.innerHTML = `<p class="empty">${t('Nenhuma foto ainda. Fotografe ou importe uma imagem (+) para revelar com qualquer câmera.', 'No photos yet. Shoot, or import a picture (+) to develop it with any camera.')}</p>`;
    return;
  }
  const grid = document.createElement('div'); grid.className = 'grid';
  for (const s of shots) {
    const b = document.createElement('button');
    if (s.kind === 'video') b.classList.add('video');
    if (s.thumb) { const u = URL.createObjectURL(s.thumb); b.style.backgroundImage = `url(${u})`; }
    b.setAttribute('aria-label', s.kind === 'video' ? t('Vídeo', 'Video') : t('Foto', 'Photo'));
    b.onclick = () => openViewer(s.id);
    grid.append(b);
  }
  body.append(grid);
}

async function openViewer(id) {
  const shot = await store.get(id);
  if (!shot) return openGallery();
  const p = await loadProfile(shot.profileId).catch(() => null);
  const isVideo = shot.kind === 'video';
  const blob = isVideo ? shot.video : shot.developed;
  const ext = isVideo ? (shot.mime?.includes('webm') ? 'webm' : 'mp4') : 'jpg';
  const actions = [['share', t('Salvar em Fotos / compartilhar', 'Save to Photos / share'), () => shareBlob(blob, `emulsa-${shot.id}.${ext}`)]];
  if (!isVideo) actions.push(['edit', t('Editar', 'Edit'), () => openEditor(shot.id)]);
  actions.push(['trash', t('Apagar', 'Delete'), async () => {
    if (!confirm(t('Apagar do Emulsa? Cópias já salvas em Fotos continuam lá.', 'Delete from Emulsa? Copies saved to Photos stay there.'))) return;
    await store.del(shot.id); const l = await store.list(); setThumb(l[0]?.thumb); sheetBack = null; openGallery();
  }]);
  const body = openSheet(p ? p.name[PT ? 'pt' : 'en'] : '', actions);
  sheetBack = openGallery;
  const v = document.createElement('div'); v.className = 'view';
  const url = URL.createObjectURL(blob);
  if (isVideo) { const el = document.createElement('video'); Object.assign(el, { src: url, controls: true, playsInline: true }); el.setAttribute('playsinline', ''); v.append(el); }
  else { const img = new Image(); img.src = url; img.alt = ''; v.append(img); }
  body.append(v);
  const note = document.createElement('p'); note.className = 'note';
  note.textContent = t('Toque em ⬆ e escolha "Salvar Imagem"/"Salvar Vídeo" para guardar em Fotos.', 'Tap ⬆ and choose "Save Image"/"Save Video" to keep it in Photos.');
  body.append(note);
}

async function openEditor(id) {
  const shot = await store.get(id);
  if (!shot) return;
  let p = await loadProfile(index.some((e) => e.id === shot.profileId) ? shot.profileId : prefs.photo);
  const s = { ...shot.settings };
  const src = await canvasFromBlob(shot.original);
  const src2c = shot.original2 ? await canvasFromBlob(shot.original2) : null;
  let tab = 0, rendering = false, pending = false, saving = false;
  const body = openSheet(p.name[PT ? 'pt' : 'en'], [['check', t('Salvar', 'Save'), save]]);
  sheetBack = () => openViewer(id);
  const viewEl = document.createElement('div'); viewEl.className = 'view';
  const preview = document.createElement('canvas'); viewEl.append(preview);
  const tabs = document.createElement('div'); tabs.className = 'tabs';
  const panel = document.createElement('div'); panel.className = 'panel';
  body.append(viewEl, tabs, panel);

  async function render() {
    if (rendering) { pending = true; return; }
    rendering = true;
    try {
      const out = await develop(p, s, src, src2c, 1280);
      preview.width = out.width; preview.height = out.height;
      preview.getContext('2d').drawImage(out, 0, 0);
    } catch (e) { toast(String(e.message || e)); }
    rendering = false;
    if (pending) { pending = false; render(); }
  }
  async function save() {
    if (saving) return;
    saving = true; toast(t('Revelando…', 'Developing…'), 10000);
    try {
      const out = await develop(p, s, src, src2c, exportLong());
      shot.settings = { ...s }; shot.profileId = p.id;
      await saveShot(shot, out);
      toast(t('Salvo na galeria do Emulsa. Use ⬆ para enviar para Fotos.', 'Saved in the Emulsa gallery. Use ⬆ to send it to Photos.'));
      sheetBack = null; openViewer(id);
    } catch (e) { toast(String(e.message || e)); }
    saving = false;
  }
  const changed = () => render();
  const slider = (label, key, min, max) => {
    const w = document.createElement('label'); w.className = 'slider';
    const out = document.createElement('output');
    const inp = Object.assign(document.createElement('input'), { type: 'range', min, max, step: (max - min) / 200, value: s[key] ?? 0 });
    const show = () => { const v = +inp.value; out.textContent = (v > 0 && min < 0 ? '+' : '') + v.toFixed(2); };
    inp.oninput = () => {
      let v = +inp.value; const neutral = min < 0 ? 0 : (max > 1.5 ? 1 : 0);
      if (Math.abs(v - neutral) < (max - min) * 0.015) { v = neutral; inp.value = v; }
      s[key] = v; show(); changed();
    };
    show();
    w.append(document.createTextNode(label), out, inp);
    return w;
  };
  const choice = (label, opts, cur, pick) => {
    const w = document.createElement('div');
    const l = document.createElement('div'); l.className = 'label'; l.textContent = label;
    const r = document.createElement('div'); r.className = 'row';
    opts.forEach((o, i) => {
      const b = document.createElement('button'); b.className = 'pill' + (i === cur() ? ' sel' : ''); b.textContent = o;
      b.onclick = () => { pick(i); [...r.children].forEach((x, k) => x.classList.toggle('sel', k === cur())); changed(); };
      r.append(b);
    });
    w.append(l, r);
    return w;
  };
  const tabNames = [t('Câmeras', 'Cameras'), t('Ajustes', 'Adjust'), t('Efeitos', 'Effects')];
  function showTab(i) {
    tab = i;
    tabs.innerHTML = '';
    tabNames.forEach((n, k) => { const b = document.createElement('button'); b.className = 'pill' + (k === tab ? ' sel' : ''); b.textContent = n; b.onclick = () => showTab(k); tabs.append(b); });
    panel.innerHTML = '';
    if (tab === 0) {
      const r = document.createElement('div'); r.className = 'row';
      for (const e of index.filter((x) => x.kind === 'photo')) {
        const b = document.createElement('button'); b.className = 'cam' + (e.id === p.id ? ' sel' : '');
        const c = document.createElement('canvas'); const px = Math.round(66 * (devicePixelRatio || 2)); c.width = c.height = px;
        drawCamera(c.getContext('2d'), e.category, px);
        const sp = document.createElement('span'); sp.textContent = e.name[PT ? 'pt' : 'en'];
        b.append(c, sp);
        b.onclick = async () => { p = await loadProfile(e.id); $('sheet-title').textContent = p.name[PT ? 'pt' : 'en']; showTab(0); changed(); };
        r.append(b);
      }
      panel.append(r);
    } else if (tab === 1) {
      panel.append(
        slider(t('Exposição', 'Exposure'), 'exposure', -2, 2), slider(t('Contraste', 'Contrast'), 'contrast', -1, 1),
        slider(t('Temperatura', 'Temperature'), 'temperature', -1, 1), slider(t('Matiz', 'Tint'), 'tint', -1, 1),
        slider(t('Saturação', 'Saturation'), 'saturation', -1, 1), slider(t('Vibração', 'Vibrance'), 'vibrance', -1, 1),
        slider(t('Altas luzes', 'Highlights'), 'highlights', -1, 1), slider(t('Sombras', 'Shadows'), 'shadows', -1, 1),
        slider(t('Desbotar', 'Fade'), 'fade', 0, 1), slider(t('Grão', 'Grain'), 'grain', 0, 2),
        slider(t('Vinheta', 'Vignette'), 'vignette', 0, 2), slider('Halation', 'halation', 0, 3),
        slider(t('Difusão', 'Bloom'), 'bloom', 0, 3), slider(t('Intensidade do vazamento', 'Leak strength'), 'leakAmount', 0, 2));
    } else {
      const no = t('Não', 'Off'), yes = t('Sim', 'On');
      if (p.capabilities.dateStamp) panel.append(choice(t('Data impressa', 'Date imprint'), [no, yes], () => ((s.dateStamp ?? p.stamp.defaultOn) ? 1 : 0), (i) => { s.dateStamp = i === 1; }));
      if (p.format.frame !== 'none') panel.append(choice(t('Moldura', 'Frame'), [no, yes], () => (s.frame === false ? 0 : 1), (i) => { s.frame = i === 1; }));
      panel.append(choice(t('Vazamento de luz', 'Light leak'), [t('Aleatório', 'Random'), t('Sempre', 'Always'), t('Nunca', 'Never')],
        () => ({ auto: 0, on: 1, off: 2 }[s.leak ?? 'auto']), (i) => { s.leak = ['auto', 'on', 'off'][i]; }));
      if (p.capabilities.accessories) {
        const acc = ['none', 'fisheye', 'starburst', 'prism'];
        panel.append(choice(t('Lente', 'Lens'), [t('Nenhuma', 'None'), t('Olho de peixe', 'Fisheye'), t('Estrela', 'Starburst'), t('Prisma', 'Prism')],
          () => Math.max(0, acc.indexOf(s.accessory ?? 'none')), (i) => { s.accessory = acc[i]; }));
      }
      if (p.capabilities.flash) panel.append(choice(t('Visual de flash', 'Flash look'), [t('Padrão', 'Default'), no, yes],
        () => (s.flash == null ? 0 : s.flash ? 2 : 1), (i) => { s.flash = i === 0 ? null : i === 2; }));
      panel.append(choice(t('Preto e branco', 'Black & white'), [no, yes], () => (s.mono ? 1 : 0), (i) => { s.mono = i === 1; }));
      const b = document.createElement('button'); b.className = 'pill'; b.textContent = t('Nova variação de grão e luz', 'New grain & light variation');
      b.onclick = () => { s.seed = newSeed(); changed(); };
      panel.append(b);
    }
  }
  showTab(0);
  render();
}

async function importFiles(files) {
  if (!files.length) return;
  toast(t('Importando…', 'Importing…'), 10000);
  let last = null;
  for (const f of files) {
    try {
      const c = await canvasFromBlob(f, 4096);
      const p = await loadProfile(prefs.photo);
      const s = { seed: newSeed(), leak: 'off', date: nowIso(new Date(f.lastModified || Date.now())) };
      const shot = { id: `${Date.now()}${Math.floor(Math.random() * 1000)}`, created: Date.now(), kind: 'photo', profileId: p.id, settings: s, original: await toBlob(c, 0.95), imported: true };
      await saveShot(shot, await develop(p, s, c, null, exportLong()));
      last = shot.id;
    } catch (e) { toast(String(e.message || e)); }
  }
  toast(t('Importada. Escolha a câmera no editor.', 'Imported. Pick a camera in the editor.'));
  if (files.length === 1 && last) openEditor(last); else openGallery();
}
$('file').onchange = (e) => { const fs = [...e.target.files]; e.target.value = ''; importFiles(fs); };

function openAbout() {
  sheetBack = null;
  const body = openSheet(t('Sobre o Emulsa', 'About Emulsa'));
  const standalone = navigator.standalone || matchMedia('(display-mode: standalone)').matches;
  const wrap = document.createElement('div'); wrap.className = 'panel'; wrap.style.maxHeight = 'none';
  wrap.innerHTML = `
    ${standalone ? '' : `<div class="banner">${t('<b>Instale na tela de início:</b> no Safari, toque em Compartilhar ⬆ e depois em "Adicionar à Tela de Início". Assim o Emulsa abre como app e funciona offline.', '<b>Install on your home screen:</b> in Safari tap Share ⬆, then "Add to Home Screen". Emulsa then opens like an app and works offline.')}</div>`}
    ${/android/i.test(navigator.userAgent) ? `<div class="banner">${t('<b>Android:</b> há também um app nativo (câmera em resolução máxima, flash real e controles manuais). <a href="emulsa.apk" style="color:var(--amber)">Baixar APK</a> e permitir "instalar apps desconhecidos".', '<b>Android:</b> there is also a native app (full-resolution camera, real flash, manual controls). <a href="emulsa.apk" style="color:var(--amber)">Download APK</a> and allow "install unknown apps".')}</div>` : ''}
    <div class="label">${t('Qualidade', 'Quality')}</div>
    <div class="row" id="q-row"></div>
    <div class="label">${t('Câmera frontal', 'Front camera')}</div>
    <div class="row" id="m-row"></div>
    <p class="note">${t('Tudo é processado no seu aparelho. O Emulsa não envia fotos, não tem conta, anúncios nem rastreamento. As fotos ficam na galeria do Emulsa (neste aparelho) até você salvá-las em Fotos.', 'Everything is processed on your device. Emulsa uploads nothing and has no account, ads or tracking. Photos stay in the Emulsa gallery (on this device) until you save them to Photos.')}</p>
    <p class="note">${t('Os perfis são criações originais inspiradas em famílias de filmes e câmeras; não reproduzem marcas nem outros apps.', 'Profiles are original creations inspired by families of films and cameras; they do not reproduce brands or other apps.')}</p>`;
  body.append(wrap);
  const mk = (row, opts, cur, pick) => {
    const r = wrap.querySelector(row);
    opts.forEach((o, i) => {
      const b = document.createElement('button'); b.className = 'pill' + (i === cur() ? ' sel' : ''); b.textContent = o;
      b.onclick = () => { pick(i); savePrefs(); [...r.children].forEach((x, k) => x.classList.toggle('sel', k === cur())); };
      r.append(b);
    });
  };
  mk('#q-row', [t('Normal (mais rápido)', 'Normal (faster)'), t('Alta resolução', 'High resolution')], () => (prefs.quality === 'high' ? 1 : 0),
    (i) => { prefs.quality = i ? 'high' : 'normal'; startCamera(); });
  mk('#m-row', [t('Espelhar fotos', 'Mirror photos'), t('Não espelhar', 'Do not mirror')], () => (prefs.mirror ? 0 : 1), (i) => { prefs.mirror = i === 0; });
}

// ---- controls -----------------------------------------------------------------------------------------
$('shutter').onclick = shutter;
$('b-gallery').onclick = openGallery;
$('b-info').onclick = openAbout;
$('b-start').onclick = () => startCamera();
$('b-flip').onclick = () => { if (busy || recorder) return; facing = facing === 'user' ? 'environment' : 'user'; startCamera(); };
$('b-flash').onclick = () => {
  if (!profile.capabilities.flash) return;
  const on = !(settings.flash == null ? profile.flash.default : settings.flash);
  settings.flash = on; prefs.flash = on; savePrefs(); refreshTop(); dirty = true;
  toast(on ? t('Visual de flash ligado', 'Flash look on') : t('Visual de flash desligado', 'Flash look off'));
};
$('b-timer').onclick = () => { prefs.timer = { 0: 3, 3: 10 }[prefs.timer] ?? 0; savePrefs(); refreshTop(); toast(prefs.timer ? `${prefs.timer} s` : t('Sem temporizador', 'No timer')); };
$('b-date').onclick = () => {
  if (!profile.capabilities.dateStamp) return;
  settings.dateStamp = !(settings.dateStamp ?? profile.stamp.defaultOn); prefs.dateStamp = settings.dateStamp; savePrefs(); refreshTop(); dirty = true;
};
$('b-leak').onclick = () => {
  settings.leak = { auto: 'on', on: 'off' }[settings.leak] ?? 'auto'; prefs.leak = settings.leak; savePrefs(); refreshTop(); dirty = true;
  toast({ on: t('Vazamento de luz: sempre', 'Light leaks: always'), off: t('Vazamento de luz: nunca', 'Light leaks: never') }[settings.leak] || t('Vazamento de luz: aleatório', 'Light leaks: random'));
};
$('b-grid').onclick = () => { prefs.grid = !prefs.grid; savePrefs(); refreshTop(); };
$('b-lens').onclick = () => {
  if (!profile.capabilities.accessories || profile.format.forceAccessory) return;
  settings.accessory = { none: 'fisheye', fisheye: 'starburst', starburst: 'prism' }[settings.accessory] ?? 'none';
  prefs.accessory = settings.accessory; savePrefs(); refreshTop(); dirty = true;
  toast({ fisheye: t('Lente olho de peixe', 'Fisheye lens'), starburst: t('Filtro estrela', 'Starburst filter'), prism: t('Prisma', 'Prism') }[settings.accessory] || t('Sem acessório', 'No accessory'));
};
$('b-double').onclick = () => {
  if (!profile.capabilities.doubleExposure || prefs.mode === 'video') return;
  if (doubleOn) { cancelDouble(); return; }
  doubleOn = true; refreshTop(); toast(t('Exposição dupla: fotografe a 1ª imagem', 'Double exposure: take the first frame'));
};
$('b-ev').onclick = () => { $('ev').hidden = !$('ev').hidden; };
$('ev').oninput = (e) => { settings.exposure = +e.target.value; refreshTop(); dirty = true; };
for (const b of document.querySelectorAll('#modes button')) {
  b.onclick = async () => {
    if (recorder || busy || prefs.mode === b.dataset.mode) return;
    prefs.mode = b.dataset.mode; savePrefs();
    cancelDouble();
    await selectProfile(prefs.mode === 'video' ? prefs.video : prefs.photo, false);
    startCamera();
  };
}
window.addEventListener('resize', () => { dirty = true; });
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { if (recorder) stopRecording(); stopCamera(); }
  else startCamera();
});

// ---- boot -----------------------------------------------------------------------------------------------
async function boot() {
  try {
    engine = new Engine(gl, '.');
    await engine.init();
  } catch (e) {
    $('start-msg').textContent = t('Este navegador não tem os recursos gráficos necessários (WebGL2 com float). Atualize o iOS/Safari.', 'This browser lacks the required graphics features (WebGL2 with float). Update iOS/Safari.') + ` (${e.message || e})`;
    $('b-start').hidden = true; $('start').hidden = false;
    return;
  }
  index = (await (await fetch('assets/profiles/index.json')).json()).profiles;
  if (!index.some((e) => e.id === prefs.photo)) prefs.photo = 'sol200';
  if (!index.some((e) => e.id === prefs.video)) prefs.video = 'super8';
  await selectProfile(prefs.mode === 'video' ? prefs.video : prefs.photo, false);
  refreshTop();
  const shots = await store.list().catch(() => []);
  setThumb(shots[0]?.thumb);
  requestAnimationFrame(frame);
  await startCamera();
  if ('serviceWorker' in navigator) {
    // a new version installs in the background; reload once so it is used right away
    const had = !!navigator.serviceWorker.controller;
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (had && !reloaded && !recorder) { reloaded = true; location.reload(); } });
    navigator.serviceWorker.register('sw.js').then((r) => r.update()).catch(() => {});
  }
  if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
}
boot();
